# Copyright (C) 2026 The Android Open Source Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""LRU pool of TraceProcessor instances.

Loading a trace into TraceProcessor is expensive (it spawns a
trace_processor_shell subprocess and parses the trace), so we cache
loaded TPs and evict the least-recently-used one when capacity is
exceeded.

Each TraceProcessor owns a single shell subprocess and a single HTTP
connection — concurrent queries against the same TP must serialize, so
we guard each entry with a `threading.Lock`. Different TPs are
independent and can be queried in parallel from the worker pool in
`query_executor.py`.

This module is now thread-only (no asyncio): callers are worker threads
running on a ThreadPoolExecutor. The asyncio coordinator never holds
these locks.
"""

from __future__ import annotations

import logging
import os
import threading
from collections import OrderedDict
from dataclasses import dataclass

from perfetto.trace_processor import TraceProcessor, TraceProcessorConfig

log = logging.getLogger('bigtrace_local.pool')


@dataclass
class PooledTP:
    path: str
    tp: TraceProcessor
    # Held by a worker thread for the duration of its `tp.query(...)` call.
    # Different traces have different locks so they run in parallel.
    lock: threading.Lock


class TracePool:
    """LRU cache of TraceProcessor instances keyed by absolute trace path.

    Thread-safe: `acquire()` is callable from any thread. The internal
    pool lock is only held briefly (dict mutations + LRU bookkeeping).
    The expensive TP load happens *outside* the pool lock so other
    workers can keep acquiring already-loaded TPs while one is loading.
    """

    def __init__(self, max_size: int = 4) -> None:
        self._max_size = max_size
        self._entries: 'OrderedDict[str, PooledTP]' = OrderedDict()
        self._mu = threading.Lock()

    def acquire(self, path: str) -> PooledTP:
        """Get (or load) the PooledTP for `path` and mark it MRU.

        The caller MUST take `entry.lock` before invoking any method on
        the underlying TraceProcessor.
        """
        path = os.path.abspath(path)

        # Fast path under the pool lock: hit + LRU bump.
        with self._mu:
            entry = self._entries.get(path)
            if entry is not None:
                self._entries.move_to_end(path)
                return entry

            # Evict if at capacity. Eviction happens BEFORE we load the new
            # TP so we don't temporarily blow the budget.
            evicted: list[PooledTP] = []
            while len(self._entries) >= self._max_size:
                evicted_path, e = self._entries.popitem(last=False)
                log.info('Evicting TP for %s', evicted_path)
                evicted.append(e)

        # Close evicted TPs OUTSIDE the pool lock — closing the shell
        # waits on the subprocess and shouldn't block other acquisitions.
        # We deliberately do NOT take e.lock here — if anyone is mid-query
        # they'll see a broken-pipe shortly; that's an accepted limitation,
        # documented in the README.
        for e in evicted:
            try:
                e.tp.close()
            except Exception as ex:  # noqa: BLE001
                log.warning('Error closing evicted TP %s: %s', e.path, ex)

        # Load outside the pool lock so we don't block other acquisitions.
        # If two workers race for the same path we'll briefly load it twice;
        # the loser's TP is closed below.
        log.info('Loading TP for %s', path)
        config = TraceProcessorConfig(load_timeout=30)
        tp = TraceProcessor(trace=path, config=config)
        new_entry = PooledTP(path=path, tp=tp, lock=threading.Lock())

        with self._mu:
            existing = self._entries.get(path)
            if existing is not None:
                # Lost the race — drop the one we just loaded.
                tp.close()
                self._entries.move_to_end(path)
                return existing
            self._entries[path] = new_entry
            self._entries.move_to_end(path)
            return new_entry

    def close_all(self) -> None:
        """Close every TP. Called on server shutdown."""
        with self._mu:
            entries = list(self._entries.values())
            self._entries.clear()
        for e in entries:
            try:
                e.tp.close()
            except Exception as ex:  # noqa: BLE001
                log.warning('Error closing TP for %s: %s', e.path, ex)

    def size(self) -> int:
        return len(self._entries)
