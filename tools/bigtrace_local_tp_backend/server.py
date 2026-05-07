#!/usr/bin/env python3
# Copyright (C) 2026 The Android Open Source Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""Local TraceProcessor-backed BigTrace server.

This is a sibling of tools/bigtrace_ref_backend (the mock). It implements
the same HTTP API surface that the BigTrace UI expects, but executes user
SQL against a directory of real trace files using the in-repo perfetto
Python `TraceProcessor` package.

This is NOT a real BigTrace — it's a single-machine approximation. Known
limitations are documented in README.md.

The traces directory is chosen by the client on every request via the
`trace_directory` setting (set in the BigTrace UI's Settings page). The
server has no startup-time knowledge of where traces live.

Usage:
    .venv/bin/python server.py [--port 8002]
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import urllib.parse
import uuid
from dataclasses import dataclass, field
from typing import Any

import duckdb
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware

# Local modules. The script is intended to run with cwd == this directory
# (or with this directory on sys.path), which is how server.py in the mock
# is run too.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from db import Database, QESnapshot, utcnow  # noqa: E402
from query_executor import (  # noqa: E402
    RunContext, list_matching_traces, run_query_across_traces,
)
from settings import (  # noqa: E402
    EXECUTION_SETTINGS, TRACE_METADATA_SETTINGS, trace_directory,
    trace_filter_regex, trace_limit,
)
from trace_pool import TracePool  # noqa: E402

log = logging.getLogger('bigtrace_local')

app = FastAPI(title='BigTrace Local TP Backend')
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

# ---------------------------------------------------------------------------
# Server-wide configuration (set in main())
# ---------------------------------------------------------------------------


@dataclass
class ServerConfig:
  max_pool: int = 4
  # Materialized tables are dropped from DuckDB this long after the
  # query reaches a terminal state. The metadata row stays so the
  # UI's history sidebar still shows the entry; only the row buffer
  # goes away.
  table_ttl_seconds: int = 86400  # 1 day
  # How often the background sweep runs. Independent of the TTL.
  table_ttl_sweep_seconds: int = 300  # 5 minutes
  db_path: str = ''
  # If non-zero, start DuckDB's web UI on this port using the same
  # connection the server uses (no file-lock contention). 0 = off.
  db_ui_port: int = 0
  # If non-zero, run Datasette in-process on this port via the
  # datasette-parquet plugin. Same process means no cross-process
  # DuckDB file-lock conflict; separate port means no FastAPI mount
  # path-prefix headaches. 0 = off.
  datasette_port: int = 0
  # Database name surfaced in Datasette URLs (`/<name>/<table>`).
  # We use "state" by default to match the file name.
  datasette_db_name: str = 'state'


CONFIG = ServerConfig()
POOL: TracePool = TracePool(max_size=4)
# Global persistence handle. Initialized in main(), used everywhere.
DB: Database | None = None

# ---------------------------------------------------------------------------
# Response helpers — matched to the mock so the UI sees the same shape.
# ---------------------------------------------------------------------------

# Max characters of perfettoSql / errorMessage returned by the list endpoint.
# Per-UUID detail responses always return the full text.
LIST_TEXT_MAX = 200


def _truncate(s: str) -> tuple[str, bool]:
  """Clip `s` to LIST_TEXT_MAX, ending on a whitespace boundary.

    A naive `s[:N]` cut leaves dangling fragments mid-token (e.g. `d…`
    from `depth,`). We back off to the last whitespace before the cut so
    the visible text ends on a complete token. If there's no whitespace
    in the first half (one giant token), we fall back to the hard cut so
    we don't return an empty preview.
    """
  if len(s) <= LIST_TEXT_MAX:
    return s, False
  cut = s[:LIST_TEXT_MAX]
  last_ws = max(cut.rfind(' '), cut.rfind('\n'), cut.rfind('\t'))
  if last_ws >= LIST_TEXT_MAX // 2:
    cut = cut[:last_ws]
  return cut.rstrip() + '…', True


def _qe_to_raw(snap: QESnapshot, truncate: bool = False) -> dict[str, Any]:
  """Build a full RawQueryExecution dict from a DB snapshot.

    `tableLink` is derived on the fly from `tableName` (we don't
    persist it). `receivedSettings` is no longer echoed — settings
    persistence is a deferred decision; the wire field is absent.
    """
  sql_text = snap.perfetto_sql
  if truncate:
    sql_text, _ = _truncate(sql_text)
  d: dict[str, Any] = {
      'queryUuid': snap.query_uuid,
      'status': snap.status,
      'startTime': snap.start_time,
      'processedRows': snap.processed_rows,
      'processedTraces': snap.processed_traces,
      'totalTraces': snap.total_traces,
      'perfettoSql': sql_text,
      'limit': snap.query_limit,
      'materialized': snap.materialized,
  }
  if snap.end_time is not None:
    d['endTime'] = snap.end_time
  if snap.error_message is not None:
    err_text = snap.error_message
    if truncate:
      err_text, _ = _truncate(err_text)
    d['errorMessage'] = err_text
  if snap.table_name is not None:
    d['tableName'] = snap.table_name
    # tableLink is built mechanically from tableName so the two
    # always agree. With Datasette up we point at the SQL editor
    # pre-filled with `SELECT * FROM <tableName>` — the user gets
    # a SQL playground over the materialized result and a
    # shareable URL. (We avoid the table-viewer path
    # /state/<table>: datasette-parquet has a bug there that emits
    # an unbound `LIMIT :n OFFSET :t` to DuckDB and 500s. The SQL
    # endpoint executes the literal query and works cleanly.)
    if CONFIG.datasette_port > 0:
      sql = f'SELECT * FROM {snap.table_name} LIMIT 100'
      d['tableLink'] = (f'http://localhost:{CONFIG.datasette_port}/'
                        f'{CONFIG.datasette_db_name}'
                        f'?sql={urllib.parse.quote(sql)}')
    else:
      d['tableLink'] = f'/tables/{snap.table_name}'
  return d


def _qe_to_status(snap: QESnapshot) -> dict[str, Any]:
  """Strict progress-only snapshot for `:status` polling.

    Exactly five fields, every time:
      queryUuid, status, processedTraces, totalTraces, processedRows.

    Everything else (endTime, errorMessage, perfettoSql, limit,
    materialized, settings, tableName/Link) is static-once-known and
    lives on the full `/query_executions/{uuid}` endpoint.
    """
  return {
      'queryUuid': snap.query_uuid,
      'status': snap.status,
      'processedTraces': snap.processed_traces,
      'totalTraces': snap.total_traces,
      'processedRows': snap.processed_rows,
  }


def _rows_response(columns: list[str], rows: list[list[Any]]) -> dict[str, Any]:
  return {
      'columnNames': columns,
      'rows': [{
          'values': r
      } for r in rows],
  }


def _get_db() -> Database:
  if DB is None:
    raise HTTPException(
        status_code=503,
        detail='Database not initialized',
    )
  return DB


def _get_snapshot_or_404(uuid_str: str) -> QESnapshot:
  """Fetch the QESnapshot from DuckDB, raising 404 if absent / deleted."""
  snap = _get_db().get_qe(uuid_str)
  if snap is None:
    raise HTTPException(
        status_code=404,
        detail=f'Query {uuid_str} not found',
    )
  return snap


def _resolve_trace_dir(settings: list[dict[str, Any]]) -> str:
  """Return a validated traces directory, or raise HTTPException(400).

    The path always comes from the per-request `trace_directory`
    setting — the server has no fallback. We validate at the point of
    use rather than at submit time so the UI can correct a typo via
    the settings page without restarting anything.

    Shell-style `~` and `$VAR` references are expanded here so paths
    like `~/Downloads` resolve as a CLI user would expect. Local-dev
    backend only — a multi-tenant deployment must not let arbitrary
    clients dereference the server's environment.
    """
  path = trace_directory(settings)
  if path:
    path = os.path.expandvars(os.path.expanduser(path))
  if not path:
    raise HTTPException(
        status_code=400,
        detail='No traces directory configured (set Trace Directory in settings)',
    )
  if not os.path.isdir(path):
    raise HTTPException(
        status_code=400,
        detail=f"Trace Directory '{path}' does not exist",
    )
  return path


def _resolve_traces_for(settings: list[dict[str, Any]]) -> list[str]:
  """Build the list of trace paths to fan out to.

    Pipeline: list everything in `trace_directory`, narrow by
    `trace_filter` regex, then truncate to `trace_limit` if > 0.
    Order from `list_matching_traces` is alphabetical so the truncation
    is deterministic across runs (same files end up in the cap).
    """
  pattern = trace_filter_regex(settings)
  traces_dir = _resolve_trace_dir(settings)
  traces = list_matching_traces(traces_dir, pattern)
  cap = trace_limit(settings)
  if cap > 0 and len(traces) > cap:
    traces = traces[:cap]
  return traces


# ---------------------------------------------------------------------------
# Background async query lifecycle
# ---------------------------------------------------------------------------


async def _run_async_query(
    query_uuid: str,
    perfetto_sql: str,
    limit: int,
    settings: list[dict[str, Any]],
) -> None:
  """Background coroutine: drive the threaded executor for one async run.

    Cancellation model
    ------------------
    Cancellation flows entirely through the shared DuckDB state. The
    cancel handler flips `qe.status = 'CANCELLED'` under the DB lock;
    worker threads check the DB status at trace boundaries and the
    `merge_trace_atomic` step bundles status-check + insert + counter-
    bump under that same lock. After the cancel handler releases the
    lock and returns 200, every subsequent merge attempt observes the
    new status and bails — guaranteeing no row lands after the 200
    reaches the client.

    We never overwrite a `CANCELLED` status with a natural-completion
    terminal state, because `mark_success` / `mark_failed` are
    conditional UPDATEs (only apply when status is still IN_PROGRESS).

    No process-memory cancel state — by design. Any backend instance
    behind a load balancer can cancel any query.
    """
  db = DB
  if db is None:
    log.error('DB unavailable; aborting async query %s', query_uuid)
    return

  ctx = RunContext(
      db=db,
      query_uuid=query_uuid,
      global_limit=limit,
  )

  try:
    traces = _resolve_traces_for(settings)
    ctx.total_traces = len(traces)
    db.update_total_traces(query_uuid, len(traces))

    if not traces:
      # Nothing to do but it's not an error — succeed with zero
      # rows. Note: the materialized table is never created (no
      # worker ran), but tableName remains set on the metadata
      # row so :fetch_results returns 200 with empty content via
      # the "table exists but no rows yet" branch.
      db.mark_success(query_uuid, 0)
      return

    await run_query_across_traces(
        POOL,
        traces,
        perfetto_sql,
        limit,
        max_concurrency=CONFIG.max_pool,
        ctx=ctx,
    )

    # asyncio.gather has returned — every worker has either merged
    # or bailed. mark_success is conditional on IN_PROGRESS, so it
    # silently no-ops if cancel landed in the meantime.
    snap = db.get_qe(query_uuid)
    if snap is None or snap.status != 'IN_PROGRESS':
      return
    if ctx.errors and snap.processed_rows == 0:
      db.mark_failed(query_uuid, ctx.errors[0])
    else:
      db.mark_success(query_uuid, snap.processed_rows)
  except Exception as e:  # noqa: BLE001
    log.exception('async query failed')
    db.mark_failed(query_uuid, f'{type(e).__name__}: {e}')


# ---------------------------------------------------------------------------
# Endpoints: query execution
# ---------------------------------------------------------------------------


@app.post('/execute_bigtrace_query_async')
async def execute_async(request: Request) -> dict[str, Any]:
  body = await request.json()
  perfetto_sql = body.get('perfetto_sql', '')
  limit = body.get('limit', 100)
  settings = body.get('settings', [])
  db = _get_db()

  new_uuid = str(uuid.uuid4())
  # Insert as IN_PROGRESS with tableName set immediately. The
  # materialized table itself is created lazily when the first
  # successful trace's worker merges its rows.
  db.insert_qe_in_progress(
      new_uuid,
      perfetto_sql,
      limit,
      materialized=True,
  )

  # Validate the trace directory up-front so the user gets a 400 at
  # submit time rather than having to poll a FAILED status. The
  # FAILED metadata still lives in DuckDB so the history list shows
  # it; tableName is cleared (mark_failed handles that).
  try:
    _resolve_trace_dir(settings)
  except HTTPException as e:
    db.mark_failed(new_uuid, str(e.detail))
    raise

  # The asyncio event loop keeps a strong reference to the task until
  # it completes; cancellation is signalled via qe.status + ctx, not
  # task.cancel().
  asyncio.create_task(
      _run_async_query(new_uuid, perfetto_sql, limit, settings),)

  # Top-level `queryUuid` instead of stuffing it into a single-cell
  # tabular response. Consistent with `RawQueryExecution.queryUuid`
  # everywhere else; clients read `result.queryUuid` directly.
  return {'queryUuid': new_uuid}


@app.post('/execute_bigtrace_query')
async def execute_sync(request: Request) -> dict[str, Any]:
  """Synchronous variant. Runs the query and returns the result inline.

    Lifecycle parity with the async path: the row is inserted as
    IN_PROGRESS up-front so it's visible in the history while the
    query runs, and transitioned to SUCCESS / FAILED / CANCELLED via
    the conditional `mark_*` UPDATEs at the end. A backend crash
    mid-sync leaves the row in IN_PROGRESS; `recover_stale_in_progress`
    sweeps it to FAILED at startup.

    Sync queries are NOT materialized (rows aren't persisted to
    DuckDB); the history row records the metadata only.
    `:fetch_results` on a sync UUID returns 404 because tableName is
    NULL.
    """
  body = await request.json()
  perfetto_sql = body.get('perfetto_sql', '')
  limit = body.get('limit', 100)
  settings = body.get('settings', [])
  db = _get_db()

  new_uuid = str(uuid.uuid4())
  start_time = utcnow()
  # Insert IN_PROGRESS upfront so the run is visible in the history
  # while it executes, and so a server crash mid-sync produces a
  # FAILED row on next startup instead of a silent loss.
  db.insert_qe_in_progress(
      new_uuid,
      perfetto_sql,
      limit,
      materialized=False,
      start_time=start_time,
  )

  # Resolve the trace list (validates trace_dir, applies filter +
  # trace_limit). Mirrors the async path so the same caps apply.
  try:
    traces = _resolve_traces_for(settings)
  except HTTPException as e:
    db.mark_failed(new_uuid, str(e.detail))
    raise

  db.update_total_traces(new_uuid, len(traces))
  if not traces:
    db.mark_success(new_uuid)
    return {
        'queryUuid': new_uuid,
        'columnNames': [],
        'rows': [],
    }

  # Run the query as a task and watch for client disconnect in
  # parallel. If the client drops, cancel the run and mark
  # CANCELLED — the in-flight asyncio.gather inside
  # run_query_across_traces propagates the cancel to its workers
  # (the worker threads themselves keep going to a clean trace
  # boundary; their results are discarded).
  ctx = RunContext(global_limit=limit, inline_rows=[])
  run_task = asyncio.create_task(
      run_query_across_traces(
          POOL,
          traces,
          perfetto_sql,
          limit,
          max_concurrency=CONFIG.max_pool,
          ctx=ctx,
      ))

  async def _watch_disconnect() -> None:
    # Poll twice a second while the run is in flight. A 500 ms
    # cancel-detection lag is well within "good enough" for
    # local-dev. Lower than this just adds wakeups.
    while not run_task.done():
      try:
        await asyncio.sleep(0.5)
      except asyncio.CancelledError:
        return
      if await request.is_disconnected():
        run_task.cancel()
        return

  watcher = asyncio.create_task(_watch_disconnect())

  try:
    cols, rows, err = await run_task
  except asyncio.CancelledError:
    # Either the disconnect watcher cancelled us, or the
    # framework did (server shutdown). Mark CANCELLED for
    # traceability and bail — the client is gone, no point
    # constructing a response body.
    db.mark_cancelled(
        new_uuid,
        processed_rows=0,
        clear_table=True,  # No-op for sync (no materialized table).
    )
    raise
  finally:
    watcher.cancel()
    try:
      await watcher
    except (asyncio.CancelledError, Exception):
      pass

  if err is not None:
    db.mark_failed(new_uuid, err)
    raise HTTPException(status_code=400, detail=err)

  # Sync queries don't persist their result rows server-side, so
  # `processed_rows` has no meaningful value to record — leaving it
  # at 0 (from `insert_qe_in_progress`) signals "no fetchable
  # rowcount" to clients. The UI's history list and re-open empty-
  # state branch on this. See TODO.md if we revisit.
  db.mark_success(new_uuid)
  return {
      'queryUuid': new_uuid,
      'columnNames': cols,
      'rows': [{
          'values': r
      } for r in rows],
  }


@app.get('/query_executions/{uuid}:status')
async def get_status(uuid: str) -> dict[str, Any]:
  # Lightweight progress channel — only fields that change during the
  # run. The UI calls /query_executions/{uuid} (full) once at submit
  # and again on terminal transition for the static metadata.
  snap = _get_snapshot_or_404(uuid)
  return _qe_to_status(snap)


@app.get('/query_executions/{uuid}:fetch_results')
async def fetch_results(
    uuid: str,
    limit: int = 50,
    offset: int = 0,
    order_by: str = '',
) -> dict[str, Any]:
  """Paginated read over the per-query materialized table.

    Status code mapping follows gRPC/AIP semantics so clients can
    branch on the kind of failure rather than parsing detail strings:

    - **404 NOT_FOUND** — entry doesn't exist (or is soft-deleted),
      OR the metadata says the table should exist but DuckDB can't
      find it (out-of-band drop / TTL race).
    - **400 FAILED_PRECONDITION** — the entry exists but isn't in a
      fetchable state: sync queries (`materialized=false`),
      `processed_rows == 0`, or `table_name is null` (FAILED,
      CANCELLED-with-zero-rows, TTL-swept).
    - **400 INVALID_ARGUMENT** — `order_by` malformed or references
      an unknown column (raised from the parser). Same status code,
      different `detail` shape from the FAILED_PRECONDITION case.

    `order_by` follows AIP-132 §Ordering: a comma-separated list of
    field names, each optionally followed by ` desc` (default `asc`).
    """
  # NOT_FOUND if missing or soft-deleted.
  snap = _get_snapshot_or_404(uuid)

  # FAILED_PRECONDITION ordering matches the spec: not-materialized,
  # then no-rows, then table_name-null. Each carries a specific
  # detail so a client surfacing the message gets a useful hint.
  if not snap.materialized:
    raise HTTPException(
        status_code=400,
        detail=(f'Query {uuid} is not materialized; sync queries '
                "don't persist results"),
    )
  if snap.processed_rows <= 0:
    raise HTTPException(
        status_code=400,
        detail=(f'Query {uuid} produced no rows (processed_rows=0); '
                'nothing to fetch'),
    )
  if not snap.table_name:
    raise HTTPException(
        status_code=400,
        detail=(f'Query {uuid} no longer has a materialized table '
                '(failed, cancelled with no rows, or TTL-expired)'),
    )

  try:
    cols, rows = _get_db().fetch_paginated(uuid, limit, offset, order_by)
  except ValueError as e:
    raise HTTPException(status_code=400, detail=str(e))
  except duckdb.CatalogException:
    # Metadata says the table should be there but it isn't — TTL
    # race, out-of-band drop, or similar. Treat as NOT_FOUND so
    # clients distinguish "the resource is gone" from "the
    # resource exists but is unfetchable".
    raise HTTPException(
        status_code=404,
        detail=(f'Materialized table for {uuid} not found in DuckDB '
                '(may have been swept between metadata read and fetch)'),
    )
  return _rows_response(cols, rows)


@app.post('/query_executions/{uuid}:cancel')
async def cancel_query(uuid: str) -> Response:
  """Request cancellation. Returns 200 once the flip is committed.

    Stateless across processes: the only signal is `qe.status` in
    DuckDB. We look up the row, and if it's still IN_PROGRESS we call
    `mark_cancelled`, which atomically (under the DB lock):

    - sets status='CANCELLED' and end_time
    - reads the current `processed_rows` count
    - clears `tableName`/`tableLink` and drops the materialized table
      iff no rows had been merged

    After this handler releases the DB lock and returns 200, every
    subsequent `merge_trace_atomic` call observes the new status and
    bails before inserting. Workers already past their (1)/(3) cancel
    checks but pre-merge will see the flip on their next merge attempt
    (which contends for the same DB lock).

    tp.query() calls already in flight finish naturally; their results
    are dropped at the merge step.
    """
  db = _get_db()
  snap = db.get_qe(uuid)
  if snap is None:
    raise HTTPException(
        status_code=404,
        detail=f'Query {uuid} not found',
    )
  if snap.status != 'IN_PROGRESS':
    # Already terminal — idempotent 200 no-op.
    return Response(status_code=200)
  db.mark_cancelled(
      uuid,
      processed_rows=snap.processed_rows,
      clear_table=(snap.processed_rows == 0),
  )
  return Response(status_code=200)


@app.get('/query_executions/{uuid}')
async def get_execution(uuid: str) -> dict[str, Any]:
  snap = _get_snapshot_or_404(uuid)
  return _qe_to_raw(snap)


@app.get('/query_executions')
async def list_executions() -> dict[str, Any]:
  db = _get_db()
  return {
      'queryExecutions': [_qe_to_raw(s, truncate=True) for s in db.list_qes()],
  }


@app.delete('/query_executions/{uuid}')
async def delete_execution(uuid: str) -> Response:
  """Soft-delete an execution from history.

    Refuses to delete an in-progress query — the caller must POST
    `/:cancel` first and wait for the status to settle. This keeps the
    delete path strictly about pruning history; running work can only
    leave the system through the explicit cancel channel.

    Soft-delete: flips `deleted = TRUE`. The metadata row stays for
    audit; the materialized table is dropped; subsequent reads of this
    UUID through any per-uuid endpoint return 404.
    """
  db = _get_db()
  snap = db.get_qe(uuid)
  if snap is None:
    raise HTTPException(status_code=404, detail=f'Query {uuid} not found')
  if snap.status == 'IN_PROGRESS':
    raise HTTPException(
        status_code=409,
        detail=f'Query {uuid} is still running; cancel it before deleting',
    )
  db.soft_delete(uuid)
  return Response(status_code=200)


# ---------------------------------------------------------------------------
# Endpoints: settings
# ---------------------------------------------------------------------------


@app.post('/bigtrace_execution_config')
async def execution_config() -> dict[str, Any]:
  return {'setting': EXECUTION_SETTINGS}


@app.post('/trace_metadata_settings')
async def trace_metadata_settings(request: Request) -> dict[str, Any]:
  # The schema is static. A real backend would refine the available
  # values based on the request body (which carries the user's currently-
  # active filters); we don't have the indexer to do that here.
  return {'setting': TRACE_METADATA_SETTINGS}


# ---------------------------------------------------------------------------
# TTL sweep + lifecycle
# ---------------------------------------------------------------------------


async def _ttl_sweep_loop() -> None:
  """Periodic background task: drop expired materialized tables.

    Runs forever until cancelled at shutdown. Crashes are logged but
    the loop continues — a single sweep failure shouldn't take the
    server down.
    """
  while True:
    try:
      await asyncio.sleep(CONFIG.table_ttl_sweep_seconds)
      if DB is None:
        continue
      cleared = DB.expire_terminal_tables(CONFIG.table_ttl_seconds)
      if cleared:
        log.info(
            'TTL sweep: dropped %d materialized table(s)',
            cleared,
        )
    except asyncio.CancelledError:
      return
    except Exception:  # noqa: BLE001
      log.exception('TTL sweep iteration failed')


_TTL_TASK: asyncio.Task[None] | None = None
_DATASETTE_TASK: asyncio.Task[None] | None = None


def _patch_duckdb_for_plugin() -> None:
  """Force same-config when datasette-parquet opens our DB file.

    DuckDB requires all in-process connections to one file to share
    the same `read_only` flag. The plugin hardcodes `read_only=True`,
    but the server's writer is `read_only=False`. Without this patch,
    the plugin's connect call raises:
      `Can't open a connection to same database file with a different
       configuration than existing connections`.

    The plugin only runs SELECTs, so granting it a writable handle is
    harmless. Patch is idempotent.
    """
  import duckdb as _duckdb
  if getattr(_duckdb, '_bigtrace_patched', False):
    return
  _orig_connect = _duckdb.connect

  def _patched_connect(database: str = ':memory:', *args, **kwargs):
    try:
      same_file = (
          database and CONFIG.db_path and
          os.path.abspath(database) == os.path.abspath(CONFIG.db_path))
    except Exception:  # noqa: BLE001
      same_file = False
    if same_file:
      kwargs.pop('read_only', None)
    return _orig_connect(database, *args, **kwargs)

  _duckdb.connect = _patched_connect  # type: ignore[assignment]
  _duckdb._bigtrace_patched = True  # type: ignore[attr-defined]


async def _run_datasette(port: int) -> None:
  """In-process Datasette on its own uvicorn listener.

    Runs as an asyncio task on the main event loop. Same process as
    the FastAPI server (so DuckDB connections coexist), separate TCP
    port (so no FastAPI-mount path-prefix issues). The plugin opens
    the DuckDB file lazily on the first request.
    """
  import uvicorn  # local import: optional dep
  from datasette.app import Datasette
  _patch_duckdb_for_plugin()
  metadata = {
      'plugins': {
          'datasette-parquet': {
              CONFIG.datasette_db_name: {
                  'file': CONFIG.db_path
              },
          },
      },
  }
  ds = Datasette(metadata=metadata)
  config = uvicorn.Config(
      ds.app(),
      host='127.0.0.1',
      port=port,
      log_level='warning',
      access_log=False,
  )
  server = uvicorn.Server(config)
  log.info(
      'Datasette starting on http://127.0.0.1:%d (db=%s, file=%s)',
      port,
      CONFIG.datasette_db_name,
      CONFIG.db_path,
  )
  await server.serve()


@app.on_event('startup')
async def _on_startup() -> None:
  global _TTL_TASK, DB, _DATASETTE_TASK
  DB = Database(CONFIG.db_path)
  recovered = DB.recover_stale_in_progress()
  if recovered:
    log.info('Recovered %d stale IN_PROGRESS rows as FAILED', recovered)
  if CONFIG.db_ui_port > 0:
    DB.start_db_ui(CONFIG.db_ui_port)
  if CONFIG.datasette_port > 0:
    _DATASETTE_TASK = asyncio.create_task(_run_datasette(CONFIG.datasette_port))
  _TTL_TASK = asyncio.create_task(_ttl_sweep_loop())
  log.info(
      'BigTrace local TP backend ready: db=%s ttl=%ds sweep=%ds',
      CONFIG.db_path,
      CONFIG.table_ttl_seconds,
      CONFIG.table_ttl_sweep_seconds,
  )


@app.on_event('shutdown')
async def _on_shutdown() -> None:
  log.info('Shutting down: closing %d TPs', POOL.size())
  if _TTL_TASK is not None and not _TTL_TASK.done():
    _TTL_TASK.cancel()
  if _DATASETTE_TASK is not None and not _DATASETTE_TASK.done():
    _DATASETTE_TASK.cancel()
  POOL.close_all()
  if DB is not None:
    DB.close()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
  parser = argparse.ArgumentParser(
      description='BigTrace local TraceProcessor backend')
  parser.add_argument('--port', type=int, default=8002)
  parser.add_argument('--host', type=str, default='127.0.0.1')
  parser.add_argument(
      '--max-pool',
      type=int,
      default=4,
      help='Maximum number of TraceProcessor instances kept warm in memory')
  parser.add_argument(
      '--db-path',
      type=str,
      default=os.path.expanduser('~/.cache/bigtrace_local/state.duckdb'),
      help='Path to the DuckDB file holding query history + materialized '
      'result tables. Created on first run.')
  parser.add_argument(
      '--table-ttl-seconds',
      type=int,
      default=86400,
      help='TTL for materialized tables (seconds since terminal state). '
      'After expiry the table is dropped and tableName is nulled; '
      'the metadata row stays in history. Default 1 day.')
  parser.add_argument(
      '--table-ttl-sweep-seconds',
      type=int,
      default=300,
      help='How often the TTL sweep runs. Default 5 minutes.')
  parser.add_argument(
      '--with-db-ui',
      dest='db_ui_port',
      type=int,
      default=0,
      nargs='?',
      const=4213,
      help='Start DuckDB\'s web UI on the given port (default 4213 if '
      'flag passed without a value). Uses the server\'s own '
      'connection so there\'s no file-lock conflict. Off by default; '
      'pass --with-db-ui or --with-db-ui=PORT to enable. Local-dev '
      'convenience only — never expose this in production.')
  parser.add_argument(
      '--with-datasette',
      dest='datasette_port',
      type=int,
      default=0,
      nargs='?',
      const=8003,
      help='Run Datasette in-process on the given port (default 8003 if '
      'flag passed without a value). Provides URL-deep-linked '
      'table viewer + SQL editor + CSV/JSON export over the '
      'materialized result tables. Off by default. When enabled, '
      'tableLink in the wire protocol derives to the Datasette URL. '
      'Local-dev only; the SQL editor is permissive.')
  parser.add_argument(
      '--log-level',
      type=str,
      default='info',
      choices=['critical', 'error', 'warning', 'info', 'debug'])
  args = parser.parse_args()

  logging.basicConfig(
      level=args.log_level.upper(),
      format='%(asctime)s %(levelname)s %(name)s: %(message)s',
  )

  CONFIG.max_pool = args.max_pool
  CONFIG.table_ttl_seconds = args.table_ttl_seconds
  CONFIG.table_ttl_sweep_seconds = args.table_ttl_sweep_seconds
  CONFIG.db_path = os.path.abspath(
      os.path.expandvars(os.path.expanduser(args.db_path)))
  CONFIG.db_ui_port = args.db_ui_port or 0
  CONFIG.datasette_port = args.datasette_port or 0
  global POOL
  POOL = TracePool(max_size=args.max_pool)

  import uvicorn
  print(
      f'BigTrace local TP backend listening on http://{args.host}:{args.port}')
  print('  Set the Trace Directory in the BigTrace UI Settings page '
        'before running a query.')
  print(f'  max-pool:   {CONFIG.max_pool}')
  print(f'  db-path:    {CONFIG.db_path}')
  print(f'  ttl:        {CONFIG.table_ttl_seconds}s '
        f'(sweep every {CONFIG.table_ttl_sweep_seconds}s)')
  if CONFIG.db_ui_port > 0:
    print(f'  db-ui:      http://localhost:{CONFIG.db_ui_port}')
  if CONFIG.datasette_port > 0:
    print(f'  datasette:  http://localhost:{CONFIG.datasette_port}/'
          f'{CONFIG.datasette_db_name}')
  uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level)


if __name__ == '__main__':
  main()
