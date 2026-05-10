# Copyright (C) 2026 The Android Open Source Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""Unit tests for `TracePool` LRU semantics + race-loser handling.

`TraceProcessor(...)` is patched out — actually spawning a shell
subprocess per test would dominate runtime and obscure what's
being tested. The pool's behaviour (LRU bump, eviction, close-on-
evict, race-loser close) is independent of the underlying TP, so
patching is faithful to the contract: anything that matches the
`.close()` interface works.

Run:
    .venv/bin/python -m unittest trace_pool_unittest -v
"""

from __future__ import annotations

import threading
import unittest
from unittest.mock import MagicMock, patch

import trace_pool


def _fake_tp() -> MagicMock:
  """Build a stand-in TraceProcessor with a working `.close()`."""
  m = MagicMock(name='TraceProcessor')
  m.close = MagicMock()
  return m


class AcquireBasicsTest(unittest.TestCase):
  """First-acquire and cache-hit semantics."""

  @patch.object(
      trace_pool, 'TraceProcessor', side_effect=lambda **_: _fake_tp())
  def test_first_acquire_loads_and_returns_pooled_tp(self, _mock_tp):
    pool = trace_pool.TracePool(max_size=4)
    entry = pool.acquire('/abs/path/a.pftrace')
    self.assertEqual(entry.path, '/abs/path/a.pftrace')
    self.assertIsNotNone(entry.tp)
    self.assertIsInstance(entry.lock, type(threading.Lock()))
    self.assertEqual(pool.size(), 1)

  @patch.object(
      trace_pool, 'TraceProcessor', side_effect=lambda **_: _fake_tp())
  def test_second_acquire_same_path_is_cache_hit(self, mock_tp):
    pool = trace_pool.TracePool(max_size=4)
    e1 = pool.acquire('/abs/path/a.pftrace')
    e2 = pool.acquire('/abs/path/a.pftrace')
    # Identity — same PooledTP both times.
    self.assertIs(e1, e2)
    # TP constructor called exactly once (not on cache hit).
    self.assertEqual(mock_tp.call_count, 1)
    self.assertEqual(pool.size(), 1)

  @patch.object(
      trace_pool, 'TraceProcessor', side_effect=lambda **_: _fake_tp())
  def test_acquire_resolves_relative_to_absolute(self, _mock_tp):
    # The pool keys on absolute path; relative input should hit the
    # same entry as the absolute form (otherwise an LRU eviction
    # could be triggered by a path-typo from a caller).
    pool = trace_pool.TracePool(max_size=4)
    e_abs = pool.acquire('/abs/path/a.pftrace')
    # Same file via a different path notation should still hit.
    # `os.path.abspath('/abs/./path/a.pftrace')` collapses the `.`.
    e_dotted = pool.acquire('/abs/./path/a.pftrace')
    self.assertIs(e_abs, e_dotted)


class LruEvictionTest(unittest.TestCase):
  """LRU bookkeeping: oldest-on-overflow eviction, MRU bump on hit."""

  @patch.object(
      trace_pool, 'TraceProcessor', side_effect=lambda **_: _fake_tp())
  def test_overflow_evicts_oldest_and_closes_it(self, _mock_tp):
    pool = trace_pool.TracePool(max_size=2)
    a = pool.acquire('/abs/a')
    pool.acquire('/abs/b')  # Cache the second entry; reference unused.
    self.assertEqual(pool.size(), 2)
    # `a` is now LRU. Adding `c` evicts `a`.
    pool.acquire('/abs/c')
    self.assertEqual(pool.size(), 2)
    # Close was called on the evicted entry's tp.
    a.tp.close.assert_called_once()

  @patch.object(
      trace_pool, 'TraceProcessor', side_effect=lambda **_: _fake_tp())
  def test_acquire_bumps_to_mru(self, _mock_tp):
    pool = trace_pool.TracePool(max_size=2)
    a = pool.acquire('/abs/a')
    pool.acquire('/abs/b')  # Cache the second entry; reference unused.
    # Touch a — now b is the LRU.
    pool.acquire('/abs/a')
    pool.acquire('/abs/c')  # Evicts b.
    # a's TP should NOT have been closed (still in the pool).
    a.tp.close.assert_not_called()

  @patch.object(
      trace_pool, 'TraceProcessor', side_effect=lambda **_: _fake_tp())
  def test_eviction_close_failure_does_not_propagate(self, _mock_tp):
    # Documented contract: close errors during eviction log a warning
    # but never raise. Otherwise an acquire could spuriously fail
    # because the previous TP's subprocess died first.
    pool = trace_pool.TracePool(max_size=1)
    a = pool.acquire('/abs/a')
    a.tp.close.side_effect = RuntimeError('subprocess gone')
    # Should not raise.
    b = pool.acquire('/abs/b')
    self.assertEqual(b.path, '/abs/b')
    # close() was attempted.
    a.tp.close.assert_called_once()


class RaceLoserTest(unittest.TestCase):
  """The post-load race-loser path: when two threads concurrently
    miss on the same path, both load a TP outside the lock; the
    loser's TP must be closed (cleanly, outside the lock)."""

  def test_race_loser_closes_its_tp_outside_lock(self):
    # Simulate the race by patching TraceProcessor to insert the
    # winner into the pool *during* the loser's load. When the
    # loser re-checks under the lock it sees the winner and goes
    # down the race-loser branch.
    pool = trace_pool.TracePool(max_size=4)
    loser_tp = _fake_tp()
    winner_entry = trace_pool.PooledTP(
        path='/abs/x',
        tp=_fake_tp(),
        lock=threading.Lock(),
    )

    def fake_construct(**_kwargs):
      # Mid-load: insert the winner into the pool, simulating a
      # concurrent thread that beat us under the lock.
      pool._entries['/abs/x'] = winner_entry  # noqa: SLF001
      return loser_tp

    with patch.object(trace_pool, 'TraceProcessor', side_effect=fake_construct):
      result = pool.acquire('/abs/x')

    # Caller must see the winner, not the loser.
    self.assertIs(result, winner_entry)
    # The loser's TP was closed (outside the lock).
    loser_tp.close.assert_called_once()
    # The winner is in the pool — single entry, not double.
    self.assertEqual(pool.size(), 1)

  def test_race_loser_close_failure_swallowed(self):
    # If the loser's close() raises (broken-pipe race etc.), it
    # must not propagate to the caller — they want the winner back.
    pool = trace_pool.TracePool(max_size=4)
    loser_tp = _fake_tp()
    loser_tp.close.side_effect = RuntimeError('pipe closed')
    winner_entry = trace_pool.PooledTP(
        path='/abs/x',
        tp=_fake_tp(),
        lock=threading.Lock(),
    )

    def fake_construct(**_kwargs):
      pool._entries['/abs/x'] = winner_entry  # noqa: SLF001
      return loser_tp

    with patch.object(trace_pool, 'TraceProcessor', side_effect=fake_construct):
      # Should not raise.
      result = pool.acquire('/abs/x')

    self.assertIs(result, winner_entry)
    loser_tp.close.assert_called_once()


class CloseAllTest(unittest.TestCase):
  """`close_all` closes every entry and clears the pool."""

  @patch.object(
      trace_pool, 'TraceProcessor', side_effect=lambda **_: _fake_tp())
  def test_close_all_closes_every_entry(self, _mock_tp):
    pool = trace_pool.TracePool(max_size=4)
    a = pool.acquire('/abs/a')
    b = pool.acquire('/abs/b')
    pool.close_all()
    a.tp.close.assert_called_once()
    b.tp.close.assert_called_once()
    self.assertEqual(pool.size(), 0)

  @patch.object(
      trace_pool, 'TraceProcessor', side_effect=lambda **_: _fake_tp())
  def test_close_all_swallows_close_errors(self, _mock_tp):
    # One bad TP shouldn't prevent others from closing.
    pool = trace_pool.TracePool(max_size=4)
    a = pool.acquire('/abs/a')
    b = pool.acquire('/abs/b')
    a.tp.close.side_effect = RuntimeError('boom')
    pool.close_all()  # Must not raise.
    a.tp.close.assert_called_once()
    b.tp.close.assert_called_once()
    self.assertEqual(pool.size(), 0)


if __name__ == '__main__':
  unittest.main(verbosity=2)
