# Copyright (C) 2026 The Android Open Source Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""Unit tests for the pure helpers in query_executor.py.

`_trace_id_for` and `list_matching_traces` are filesystem-bound but
deterministic — covered here at the function level so failures
localize to the line of intent. The threaded `_process_one_trace`
worker is exercised end-to-end by smoke_local.py against a real
backend; unit-mocking the pool + DB would mostly verify mocks.

Run:
    .venv/bin/python -m unittest query_executor_unittest -v
"""

from __future__ import annotations

import os
import tempfile
import unittest

from query_executor import (
    _TRACE_EXTS,
    RunContext,
    _trace_id_for,
    list_matching_traces,
)


class TraceIdForTest(unittest.TestCase):
  """`_trace_id_for` strips one of `_TRACE_EXTS` if present, else
    falls back to `os.path.splitext`. Pinning the extension list and
    the longest-first match order so a future tweak can't regress
    `.perfetto-trace` → `.trace` ambiguity (both are recognized
    suffixes; the longer match must win)."""

  def test_strips_perfetto_trace_suffix(self):
    self.assertEqual(_trace_id_for('foo.perfetto-trace'), 'foo')

  def test_strips_pftrace_suffix(self):
    self.assertEqual(_trace_id_for('bar.pftrace'), 'bar')

  def test_strips_pb_suffix(self):
    self.assertEqual(_trace_id_for('baz.pb'), 'baz')

  def test_strips_trace_suffix(self):
    self.assertEqual(_trace_id_for('qux.trace'), 'qux')

  def test_perfetto_trace_wins_over_trace(self):
    # `.perfetto-trace` ends with `.trace` literally; the longest
    # match must win or we'd return 'foo.perfetto-' nonsense.
    # _TRACE_EXTS lists `.perfetto-trace` first by design.
    self.assertEqual(_trace_id_for('foo.perfetto-trace'), 'foo')

  def test_unknown_extension_falls_back_to_splitext(self):
    # `.json` isn't recognized; splitext strips it. (Real users
    # rarely dump traces here, but the contract is "strip whatever
    # extension is present so the trace_id is one column.")
    self.assertEqual(_trace_id_for('foo.json'), 'foo')

  def test_no_extension_returns_basename_unchanged(self):
    # Some users dump raw protos without an extension —
    # list_matching_traces accepts these. The id is the basename.
    self.assertEqual(_trace_id_for('foo'), 'foo')

  def test_directory_prefix_stripped(self):
    self.assertEqual(_trace_id_for('/abs/path/to/foo.pftrace'), 'foo')
    self.assertEqual(_trace_id_for('rel/path/foo.pb'), 'foo')

  def test_filename_with_dots_in_stem_preserved(self):
    # `android-202641-134013 (Copy 10).pftrace` → strip only `.pftrace`,
    # keeping the parenthesized suffix. Real fixtures look like this.
    self.assertEqual(
        _trace_id_for('android-202641-134013 (Copy 10).pftrace'),
        'android-202641-134013 (Copy 10)',
    )


class ListMatchingTracesTest(unittest.TestCase):
  """`list_matching_traces` walks a directory once, filters by
    extension whitelist (or no-extension), then by regex. Returns
    absolute paths in alphabetical order."""

  def setUp(self):
    self._tmp = tempfile.mkdtemp(prefix='query_executor_unittest_')
    # Variety: each recognized extension + one no-extension + one
    # unrecognized extension + a subdirectory + a regex-targetable
    # name.
    for name in (
        'a.pftrace',
        'b.perfetto-trace',
        'c.pb',
        'd.trace',
        'no_ext',
        'ignore.json',
        'matching.pftrace',
    ):
      with open(os.path.join(self._tmp, name), 'wb') as f:
        f.write(b'')
    os.mkdir(os.path.join(self._tmp, 'subdir'))

  def tearDown(self):
    import shutil
    shutil.rmtree(self._tmp, ignore_errors=True)

  def test_nonexistent_dir_returns_empty(self):
    self.assertEqual(list_matching_traces('/no/such/dir', '.*'), [])

  def test_returns_absolute_paths_alphabetically(self):
    out = list_matching_traces(self._tmp, '.*')
    # Each entry must be absolute.
    for p in out:
      self.assertTrue(os.path.isabs(p), p)
    # Order must be sorted-by-name (deterministic across runs so
    # trace_limit truncation is reproducible).
    self.assertEqual(out, sorted(out))

  def test_includes_each_recognized_extension(self):
    out = list_matching_traces(self._tmp, '.*')
    names = {os.path.basename(p) for p in out}
    for ext_name in ('a.pftrace', 'b.perfetto-trace', 'c.pb', 'd.trace'):
      self.assertIn(ext_name, names)

  def test_includes_files_with_no_extension(self):
    # The "raw proto without extension" fallback path.
    out = list_matching_traces(self._tmp, '.*')
    names = {os.path.basename(p) for p in out}
    self.assertIn('no_ext', names)

  def test_excludes_files_with_unrecognized_extension(self):
    out = list_matching_traces(self._tmp, '.*')
    names = {os.path.basename(p) for p in out}
    self.assertNotIn('ignore.json', names)

  def test_excludes_subdirectories(self):
    # subdir would match the regex but isn't a file.
    out = list_matching_traces(self._tmp, '.*')
    names = {os.path.basename(p) for p in out}
    self.assertNotIn('subdir', names)

  def test_regex_narrows_match(self):
    out = list_matching_traces(self._tmp, '^matching')
    names = [os.path.basename(p) for p in out]
    self.assertEqual(names, ['matching.pftrace'])

  def test_invalid_regex_falls_back_to_match_all(self):
    # An unparseable regex shouldn't take down the run; the parser
    # logs a warning and falls back to '.*' so the user still sees
    # their trace list.
    out = list_matching_traces(self._tmp, '[unterminated')
    self.assertGreater(len(out), 0)
    # All recognized extensions + no_ext should be present.
    names = {os.path.basename(p) for p in out}
    self.assertIn('a.pftrace', names)
    self.assertIn('no_ext', names)

  def test_empty_dir_returns_empty(self):
    empty = tempfile.mkdtemp(prefix='query_executor_unittest_empty_')
    try:
      self.assertEqual(list_matching_traces(empty, '.*'), [])
    finally:
      os.rmdir(empty)


class TraceExtsConstantTest(unittest.TestCase):
  """The extension whitelist is a tiny but load-bearing constant —
    if it changes, both `list_matching_traces` and `_trace_id_for`
    pivot on it. Pinning the contents and ordering."""

  def test_known_extensions_present(self):
    self.assertIn('.perfetto-trace', _TRACE_EXTS)
    self.assertIn('.pftrace', _TRACE_EXTS)
    self.assertIn('.pb', _TRACE_EXTS)
    self.assertIn('.trace', _TRACE_EXTS)

  def test_perfetto_trace_listed_before_trace(self):
    # Longest-first ordering matters — `_trace_id_for` iterates in
    # this order and stops at first match. If `.trace` came first
    # we'd strip the wrong suffix from `foo.perfetto-trace`.
    perfetto_idx = _TRACE_EXTS.index('.perfetto-trace')
    trace_idx = _TRACE_EXTS.index('.trace')
    self.assertLess(perfetto_idx, trace_idx)


class RunContextShouldStopTest(unittest.TestCase):
  """`RunContext.should_stop()` is the cap-and-cancel primitive
    polled by worker threads at trace boundaries. Two orthogonal
    triggers: (1) global_limit reached (cheap in-memory check),
    (2) DB status flipped to CANCELLED (async mode only). Sync
    mode has no DB, so only (1) applies — pinning each branch
    explicitly so a future "tighten the check" can't regress them."""

  def test_zero_global_limit_means_no_cap(self):
    # global_limit=0 is the documented sentinel for "no cap".
    # Even when row_count is huge, should_stop() returns False
    # in sync mode (no DB) and waits on the cancel channel in
    # async mode.
    ctx = RunContext(global_limit=0, row_count=1_000_000)
    self.assertFalse(ctx.should_stop())

  def test_below_cap_does_not_stop(self):
    ctx = RunContext(global_limit=100, row_count=99)
    self.assertFalse(ctx.should_stop())

  def test_at_cap_stops(self):
    # `>=` not `>` — the cap is exclusive of further inserts, so
    # workers must bail at exactly the limit (not just past it).
    ctx = RunContext(global_limit=100, row_count=100)
    self.assertTrue(ctx.should_stop())

  def test_above_cap_stops(self):
    # Defensive: if global_limit's upper bound were ever crossed
    # (e.g., a race), the next call still stops cleanly.
    ctx = RunContext(global_limit=100, row_count=150)
    self.assertTrue(ctx.should_stop())

  def test_sync_mode_no_db_only_checks_cap(self):
    # In sync mode (db is None, query_uuid is None), no cancel
    # channel exists — should_stop is purely cap-driven.
    ctx = RunContext(global_limit=10, row_count=5, db=None, query_uuid=None)
    self.assertFalse(ctx.should_stop())
    ctx.row_count = 10
    self.assertTrue(ctx.should_stop())

  def test_async_mode_consults_db_for_cancel(self):
    # Async mode: even if cap not reached, a CANCELLED status
    # in the DB makes should_stop() True. Use a stub DB.
    class _StubDb:

      def __init__(self, status: str):
        self._status = status

      def get_status(self, _uuid: str) -> str:
        return self._status

    cancelled_db = _StubDb('CANCELLED')
    ctx = RunContext(
        global_limit=100,
        row_count=5,
        db=cancelled_db,  # type: ignore[arg-type]
        query_uuid='u1',
    )
    self.assertTrue(ctx.should_stop())

  def test_async_mode_in_progress_does_not_stop(self):

    class _StubDb:

      def get_status(self, _uuid: str) -> str:
        return 'IN_PROGRESS'

    ctx = RunContext(
        global_limit=100,
        row_count=5,
        db=_StubDb(),  # type: ignore[arg-type]
        query_uuid='u1',
    )
    self.assertFalse(ctx.should_stop())

  def test_cap_check_short_circuits_db_call(self):
    # Cap reached → should_stop() must return True without
    # querying the DB (cheap in-memory check first). Use a
    # raise-on-call stub to confirm.
    class _RaiseOnCall:

      def get_status(self, _uuid: str) -> str:
        raise AssertionError('should not have been called')

    ctx = RunContext(
        global_limit=10,
        row_count=10,
        db=_RaiseOnCall(),  # type: ignore[arg-type]
        query_uuid='u1',
    )
    self.assertTrue(ctx.should_stop())  # Doesn't raise.


if __name__ == '__main__':
  unittest.main(verbosity=2)
