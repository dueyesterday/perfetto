# Copyright (C) 2026 The Android Open Source Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""Run a user SQL statement across N matching traces, in parallel threads.

Architecture
------------
Each trace is processed by its own worker function running on a
`ThreadPoolExecutor`. The thread does the entire trace cycle:

    acquire pooled TP
        ↓
    tp.query(sql) and iterate rows           ← outside any lock
        ↓
    merge step (atomic):
      async mode  → db.merge_trace_atomic  (cancel-check + insert
                                            + counter bump under DB lock)
      sync  mode  → append to ctx.inline_rows under ctx.lock

Cancellation flows entirely through the DB. The `:cancel` handler
flips `qe.status = 'CANCELLED'` under the DB lock; worker threads
observe the new status either via `should_stop()` at trace
boundaries (cheap early-bail) or as part of the atomic merge step
(authoritative — after the cancel handler releases the DB lock and
returns 200, every subsequent merge attempt sees CANCELLED and
bails before inserting). No in-process cancel flag exists.

The asyncio coordinator only awaits the futures (via
`loop.run_in_executor`); it doesn't touch the result lists itself.

Result row shape
----------------
The first column is `trace_id` (basename minus a recognized extension);
the rest are the user query's columns. `limit` is per-trace.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Optional

from perfetto.trace_processor import TraceProcessorException

from trace_pool import TracePool
from db import Database

log = logging.getLogger('bigtrace_local.executor')

# Recognized trace extensions. Files without an extension are also
# accepted. Order matters: `_trace_id_for` strips longest-first so
# `.perfetto-trace` wins over `.trace`.
_TRACE_EXTS: tuple[str, ...] = ('.perfetto-trace', '.pftrace', '.pb', '.trace')


def list_matching_traces(traces_dir: str, pattern: str) -> list[str]:
  """Return absolute paths of trace files in `traces_dir` matching `pattern`.

    Recognized extensions: see `_TRACE_EXTS`. A non-recognized
    extension is allowed if the file has no extension at all (some
    users dump raw protos without one).
    """
  if not os.path.isdir(traces_dir):
    return []
  try:
    regex = re.compile(pattern)
  except re.error as e:
    log.warning('Invalid trace_filter regex %r: %s', pattern, e)
    regex = re.compile('.*')
  out: list[str] = []
  for name in sorted(os.listdir(traces_dir)):
    full = os.path.join(traces_dir, name)
    if not os.path.isfile(full):
      continue
    if not (name.endswith(_TRACE_EXTS) or '.' not in name):
      continue
    if not regex.search(name):
      continue
    out.append(os.path.abspath(full))
  return out


def _trace_id_for(path: str) -> str:
  base = os.path.basename(path)
  for ext in _TRACE_EXTS:
    if base.endswith(ext):
      return base[:-len(ext)]
  return os.path.splitext(base)[0]


@dataclass
class RunContext:
  """Per-run worker-thread state.

    Operates in one of two modes:

    1. **Async + DB-backed**: `db` and `query_uuid` are set. Merges
       go through `db.merge_trace_atomic`, which bundles status-check
       + insert + counter-bump under one DB lock acquisition. No
       `lock` on this RunContext is needed — DB serializes worker
       threads. Cancel signal lives in `qe.status` (DuckDB), polled
       at trace boundaries via `db.get_status(uuid)`.

    2. **Sync + in-memory**: `inline_rows` is a list the caller owns
       and reads back inline. `db` is None. The merge step appends
       under `lock` (since multiple workers race for the same list),
       and there's no cancel channel (sync queries have no UUID
       exposed before the response, so they can't be cancelled).

    `global_limit` caps total rows merged across all traces. Workers
    bail at `should_stop()` once reached (per-mode logic).

    `row_count` / `processed_traces` are local mirrors of the
    canonical DB counters in async mode (kept for cheap cap-reached
    early-bail before talking to DB) and the canonical counters in
    sync mode.
    """
  columns: list[str] = field(default_factory=list)
  # Sync mode: caller owns these rows after the run. None in async.
  inline_rows: Optional[list[list[Any]]] = None
  # Sync mode only: serializes the in-memory append. Not used in
  # async (DB lock provides ordering instead).
  lock: threading.Lock = field(default_factory=threading.Lock)
  # Async mode: both set; merges go through DB. Sync: both None.
  db: Optional[Database] = None
  query_uuid: Optional[str] = None
  # Mirrors the canonical row count. Async: updated from
  # merge_trace_atomic returns. Sync: incremented under `lock`.
  row_count: int = 0
  errors: list[str] = field(default_factory=list)
  processed_traces: int = 0
  total_traces: int = 0
  global_limit: int = 0

  def should_stop(self) -> bool:
    """True iff no more rows should land — cap reached or cancelled.

        Async mode: combines the in-memory cap check (cheap) with a DB
        status read (the canonical cancel signal). Sync mode: cap-only.
        Called from worker threads at trace boundaries; cheap enough
        to invoke a few times per trace.
        """
    if (self.global_limit > 0 and self.row_count >= self.global_limit):
      return True
    if self.db is not None and self.query_uuid is not None:
      return self.db.get_status(self.query_uuid) == 'CANCELLED'
    return False


def _process_one_trace(
    pool: TracePool,
    trace_path: str,
    sql: str,
    limit: int,
    ctx: RunContext,
) -> None:
  """Worker thread body: load TP, run SQL, merge.

    Async + DB-backed mode (`ctx.db` set):
        - cancel signal lives in the DB via `qe.status`;
        - merge step is a single `db.merge_trace_atomic()` call that
          bundles status-check + create-table-if-needed + bulk-insert
          + counter-bump under the DB lock.

    Sync + in-memory mode (`ctx.inline_rows` set):
        - merges accumulate in `ctx.inline_rows` under `ctx.lock`;
        - no cancel channel (sync queries can't be cancelled).
    """
  trace_id = _trace_id_for(trace_path)

  # Pre-check (1): cap or cancel already says "no more rows"?
  if ctx.should_stop():
    return

  # Acquire the pooled TP (may load + evict; can take seconds).
  try:
    entry = pool.acquire(trace_path)
  except Exception as e:  # noqa: BLE001
    ctx.errors.append(f'[{trace_id}] Failed to load: {e}')
    return

  # Per-TP lock: queries against the same TP serialize (single shell
  # subprocess + single HTTP connection per TP). Different traces
  # have different locks so they run truly in parallel.
  cols: list[str] = []
  local_rows: list[list[Any]] = []
  err_msg: Optional[str] = None
  with entry.lock:
    # Re-check after the per-TP lock acquisition.
    if ctx.should_stop():
      return
    try:
      it = entry.tp.query(sql)
      cols = list(it.column_names)
      count = 0
      for row in it:
        if limit > 0 and count >= limit:
          break
        local_rows.append([getattr(row, c) for c in cols])
        count += 1
    except TraceProcessorException as e:
      err_msg = str(e)
    except Exception as e:  # noqa: BLE001
      err_msg = f'{type(e).__name__}: {e}'

  # Async path: merge_trace_atomic does cancel-check + insert + bumps
  # in one DB call so a CANCELLED query short-circuits before insert.
  if ctx.db is not None and ctx.query_uuid is not None:
    if err_msg is not None:
      ctx.errors.append(f'[{trace_id}] {err_msg}')
      return
    # Build prefixed rows OUTSIDE the merge lock to keep the lock
    # window microseconds-short.
    prefixed = [[trace_id] + r for r in local_rows]
    sample_no_prefix: list[Any] = (
        local_rows[0] if local_rows else [None] * len(cols))
    outcome, new_traces, new_rows = ctx.db.merge_trace_atomic(
        ctx.query_uuid,
        trace_id,
        cols,
        sample_no_prefix,
        prefixed,
        ctx.global_limit,
    )
    if outcome in ('skipped', 'not_found'):
      return
    if outcome == 'col_mismatch':
      log.warning(
          'column mismatch on %s: got %s, dropped from materialized table',
          trace_id,
          cols,
      )
    # Update local mirrors so should_stop() can short-circuit
    # subsequent workers without a DB round-trip on every check.
    ctx.processed_traces = new_traces
    ctx.row_count = new_rows
    return

  # Sync path: in-memory accumulation under ctx.lock.
  prefixed = ([[trace_id] + r for r in local_rows] if err_msg is None else [])
  with ctx.lock:
    if err_msg is not None:
      ctx.errors.append(f'[{trace_id}] {err_msg}')
    else:
      if not ctx.columns:
        ctx.columns.extend(['trace_id'] + cols)
      if cols == ctx.columns[1:]:
        if ctx.global_limit > 0:
          room = ctx.global_limit - ctx.row_count
          keep = prefixed[:room] if room > 0 else []
        else:
          keep = prefixed
        if keep and ctx.inline_rows is not None:
          ctx.inline_rows.extend(keep)
          ctx.row_count += len(keep)
      else:
        log.warning(
            'column mismatch on %s: got %s, expected %s',
            trace_id,
            cols,
            ctx.columns[1:],
        )
    ctx.processed_traces += 1


async def run_query_across_traces(
    pool: TracePool,
    trace_paths: list[str],
    sql: str,
    limit: int,
    *,
    max_concurrency: int = 4,
    ctx: Optional[RunContext] = None,
) -> tuple[list[str], list[list[Any]], Optional[str]]:
  """Run `sql` across every trace using a thread pool.

    Returns `(columns, rows, error)`. `columns` is `['trace_id', ...]`
    (seeded by the first successful trace); `rows` is the concatenated
    per-trace results. `error` is non-None only if every trace failed
    (e.g. `does_not_exist` table) — in that case it carries the first
    error text so the UI can render it.

    `ctx` lets the caller pick a mode: supply `ctx.db` and
    `ctx.query_uuid` to persist rows through `db.merge_trace_atomic`
    (and route cancel through DuckDB), or supply `ctx.inline_rows` to
    collect them in memory for sync callers.
    """
  if ctx is None:
    ctx = RunContext()
  ctx.total_traces = len(trace_paths)

  if not trace_paths:
    return ctx.columns, ctx.inline_rows or [], None

  loop = asyncio.get_running_loop()
  # Dedicated pool so worker count is independent of asyncio's default.
  with ThreadPoolExecutor(
      max_workers=max(1, max_concurrency),
      thread_name_prefix='bigtrace-worker',
  ) as ex:
    futures = [
        loop.run_in_executor(
            ex,
            _process_one_trace,
            pool,
            p,
            sql,
            limit,
            ctx,
        ) for p in trace_paths
    ]
    # Wait for all workers, even after cancellation: each thread
    # observes the CANCELLED status (via `should_stop()` between
    # traces, or atomically inside `merge_trace_atomic`) and exits
    # without inserting. In-flight tp.query() calls finish
    # naturally; their results are discarded at the merge step.
    await asyncio.gather(*futures)

  with ctx.lock:
    rows_out = ctx.inline_rows or []
    if not ctx.columns and ctx.errors:
      return ctx.columns, rows_out, ctx.errors[0]
    return ctx.columns, rows_out, None
