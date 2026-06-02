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
import contextlib
import json
import logging
import os
import sys
import urllib.parse
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import duckdb
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware

# Local modules. The script is intended to run with cwd == this directory
# (or with this directory on sys.path), which is how server.py in the mock
# is run too.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from db import (  # noqa: E402
    Database, QESnapshot, parse_filter, parse_order_by, query_trace_list,
    utcnow,
)
from query_executor import (  # noqa: E402
    TRACE_LIST_COLUMNS, RunContext, _trace_id_for, enumerate_traces,
    run_query_across_traces,
)
from settings import (  # noqa: E402
    EXECUTION_SETTINGS, TRACE_METADATA_SETTINGS, trace_directory, trace_limit,
)
from trace_pool import TracePool  # noqa: E402

# Trace-list schema. The endpoint surfaces this through /traces_schema
# so the UI can render the column-selection menu without baking in any
# names. Order is the default projection order (used when the client
# doesn't supply a `columns` field-mask); `defaultVisible` flags the
# columns the UI shows on first render. `description` is surfaced as a
# tooltip.
#
# Phase 1 = pure filesystem metadata. A real BigTrace backend with a
# metadata index would add device_name, android_id, app_version, etc.
# — extending this list without touching the wire shape.
_TRACE_LIST_SCHEMA: list[dict[str, Any]] = [
    {
        'name': 'file_path',
        'type': 'VARCHAR',
        'defaultVisible': True,
    },
    {
        'name': 'file_name',
        'type': 'VARCHAR',
        'defaultVisible': True,
    },
    {
        'name': 'size_bytes',
        'type': 'BIGINT',
        'defaultVisible': True,
    },
    {
        'name': 'mtime',
        'type': 'VARCHAR',
        'defaultVisible': True,
    },
]

# DuckDB column types derived from _TRACE_LIST_SCHEMA. The /traces and
# execute_* (trace_filter) paths build an in-memory DuckDB table from
# these; query_trace_list uses them both as the table schema and the
# default projection. Pinning the equality to TRACE_LIST_COLUMNS so a
# future schema edit doesn't drift between server and executor.
_TRACE_LIST_COLUMN_TYPES: list[tuple[str, str]] = [
    (c['name'], c['type']) for c in _TRACE_LIST_SCHEMA
]
assert tuple(c for c, _ in _TRACE_LIST_COLUMN_TYPES) == TRACE_LIST_COLUMNS


def _trace_list_column_types_for(names: list[str],) -> list[tuple[str, str]]:
  """Project `_TRACE_LIST_COLUMN_TYPES` to a subset of column names.

    Used when building the metadata sidecar table — the client picked
    `names` out of the full schema via `trace_metadata_columns`, and
    the DDL needs exactly those columns in that order. Raises a
    KeyError on unknown names; the caller (server.py) has already
    validated against the schema so a missing name is a programmer
    error, not user input.
    """
  type_by_name = {c['name']: c['type'] for c in _TRACE_LIST_SCHEMA}
  return [(n, type_by_name[n]) for n in names]


log = logging.getLogger('bigtrace_local')


# References to CONFIG, POOL, DB and the _ttl_sweep / datasette helpers
# resolve at call time — those names are defined later in the file.
@contextlib.asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
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
  yield
  log.info('Shutting down: closing %d TPs', POOL.size())
  if _TTL_TASK is not None and not _TTL_TASK.done():
    _TTL_TASK.cancel()
  if _DATASETTE_TASK is not None and not _DATASETTE_TASK.done():
    _DATASETTE_TASK.cancel()
  POOL.close_all()
  if DB is not None:
    DB.close()


app = FastAPI(title='BigTrace Local TP Backend', lifespan=_lifespan)
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


def _truncate(s: str) -> str:
  """Clip `s` to LIST_TEXT_MAX, ending on a whitespace boundary.

    A naive `s[:N]` cut leaves dangling fragments mid-token (e.g. `d…`
    from `depth,`). We back off to the last whitespace before the cut so
    the visible text ends on a complete token. If there's no whitespace
    in the first half (one giant token), we fall back to the hard cut so
    we don't return an empty preview. Returns `s` unchanged when it's
    already within the cap — the caller doesn't need a was-truncated
    flag (every call site previously discarded it as `_`).
    """
  if len(s) <= LIST_TEXT_MAX:
    return s
  cut = s[:LIST_TEXT_MAX]
  last_ws = max(cut.rfind(' '), cut.rfind('\n'), cut.rfind('\t'))
  if last_ws >= LIST_TEXT_MAX // 2:
    cut = cut[:last_ws]
  return cut.rstrip() + '…'


def _qe_to_raw(snap: QESnapshot, truncate: bool = False) -> dict[str, Any]:
  """Build a full RawQueryExecution dict from a DB snapshot.

    `tableLink` is derived on the fly from `tableName` (we don't
    persist it). The submit-time snapshot fields (`settings`,
    `traceFilters`, `traceMetadataColumns`) appear only on the
    per-UUID full GET (`truncate=False`) — never on the list
    endpoint, which stays lean — and never on `:status`.
    """
  sql_text = snap.perfetto_sql
  if truncate:
    sql_text = _truncate(sql_text)
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
      err_text = _truncate(err_text)
    d['errorMessage'] = err_text
  if not truncate:
    # Submit-time snapshot. Only on the full per-UUID GET — list
    # responses stay lean (one row per execution, no per-row JSON
    # blobs), and `:status` doesn't carry it at all.
    d['settings'] = snap.settings
    # Storage holds the JSON-encoded `Filter[]` string; the wire ships
    # the native array (strict-native body contract, §10.1).
    d['traceFilters'] = (
        json.loads(snap.trace_filter) if snap.trace_filter else [])
    d['traceMetadataColumns'] = snap.trace_metadata_columns
    d['traceOrderBy'] = snap.trace_order_by
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

    Exactly four fields, every time:
      status, processedTraces, totalTraces, processedRows.

    `queryUuid` is dropped — the client already knows it from the URL
    path. Everything else (endTime, errorMessage, perfettoSql, limit,
    materialized, submit-time snapshot, tableName/Link) is
    static-once-known and lives on the full `/query_executions/{uuid}`
    endpoint, fetched once on terminal transition.
    """
  return {
      'status': snap.status,
      'processedTraces': snap.processed_traces,
      'totalTraces': snap.total_traces,
      'processedRows': snap.processed_rows,
  }


def _value_to_wire(v: Any) -> Any:
  """Coerce one row value to its always-strings wire representation.

    SQL `NULL` (Python `None`) is preserved as JSON `null` rather
    than the string `'None'` so the UI doesn't need a string-to-null
    conversion at the cell level. Booleans are lowercased so they
    round-trip cleanly to/from JSON convention (`True`/`False` from
    Python `str()` would surprise clients). Everything else goes
    through `str()` — int64 values past 2^53 round-trip without
    precision loss because they're never widened to a JS Number on
    the wire.
    """
  if v is None:
    return None
  if isinstance(v, bool):
    return 'true' if v else 'false'
  return str(v)


def _wire_rows(rows: list[list[Any]]) -> list[dict[str, Any]]:
  """Serialize a row list to the always-strings `[{values: [...]}]`
    wire shape. Shared by `_rows_response` (paginated path) and
    `execute_sync` (inline response) so the two paths can't drift on
    int64/bool coercion behaviour.
    """
  return [{'values': [_value_to_wire(v) for v in r]} for r in rows]


def _rows_response(
    columns: list[str],
    rows: list[list[Any]],
    total_filtered_rows: int,
) -> dict[str, Any]:
  """Pack a result page into the wire shape.

    Row values are uniformly serialized as JSON strings (or `null`
    for SQL NULL) regardless of column type, mirroring the
    always-strings contract on the filter wire. This solves
    int64 precision loss past 2^53: a BIGINT value of
    1_700_000_000_000_000_000 ships as `"1700000000000000000"`
    rather than as a JSON number that JS would round to
    1_700_000_000_000_000_256. The DataGrid renders strings as-is;
    sorting is server-side via `order_by` so lexical-vs-numeric
    string ordering doesn't bite us.
    """
  return {
      'columnNames': columns,
      'rows': _wire_rows(rows),
      # Always present so the UI never has to branch. Equals the
      # materialized table size when no filter is applied; equals the
      # post-filter row count otherwise. The DataGrid uses this to
      # size its virtual scrollbar over the filtered set. Kept as a
      # JSON number — it's metadata, not a row value, and counts
      # never exceed safe-integer range in any realistic dataset.
      'totalFilteredRows': total_filtered_rows,
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
  if not os.path.exists(path):
    raise HTTPException(
        status_code=400,
        detail=f"Trace Directory '{path}' does not exist",
    )
  if not os.path.isdir(path):
    raise HTTPException(
        status_code=400,
        detail=f"Trace Directory '{path}' is not a directory",
    )
  # Fail at validate time so listdir doesn't PermissionError mid-request.
  if not os.access(path, os.R_OK | os.X_OK):
    raise HTTPException(
        status_code=400,
        detail=f"Trace Directory '{path}' is not readable "
        '(check permissions)',
    )
  return path


def _resolve_traces_for(
    settings: list[dict[str, Any]],
    trace_filter: Any,
    trace_order_by: Optional[str] = None,
) -> list[dict[str, Any]]:
  """Build the list of trace entries to fan out to.

    Pipeline: enumerate metadata for every recognized file in
    `trace_directory`, apply the structured `trace_filters` (the
    `Filter[]` JSON the BigTrace UI's Settings page collects from
    the trace grid), order by `trace_order_by`, then truncate to
    `trace_limit` if > 0.

    `trace_order_by` is the AIP-132 wire string the client picked on
    the trace grid (same parser as `/traces?order_by=`). When the
    client doesn't ship one the order falls back to `file_path ASC`
    so the cap is deterministic across runs (same files end up
    selected if the grid wasn't sorted explicitly).

    Returns the FULL entries (one dict per trace with every column
    from `enumerate_traces`), not just paths. The execute path needs
    the entries when the client opts into `trace_metadata_columns`:
    each metadata value lives on its source entry and is stitched
    into the result row by the executor. Callers that only want the
    paths extract them with `[e['file_path'] for e in entries]`.

    `trace_filters` is whatever came off the wire — expected to be a
    JSON list-of-dicts; missing / None is treated as "no filter".
    Same shape and parser as `:fetch_results` `filters` so the wire
    contract is unified across read paths.

    Raises HTTPException(400) on a malformed filter / order_by or
    unknown column so the user gets the same 400 INVALID_ARGUMENT
    shape they'd see from `:fetch_results`.
    """
  traces_dir = _resolve_trace_dir(settings)
  traces = enumerate_traces(traces_dir)
  parsed_filter = _parse_trace_filter_or_400(trace_filter)
  try:
    parsed_order = (
        parse_order_by(trace_order_by) if trace_order_by else [('file_path',
                                                                'ASC')])
  except ValueError as e:
    raise HTTPException(status_code=400, detail=f'trace_order_by: {e}')
  try:
    cols, rows, _total = query_trace_list(
        traces,
        _TRACE_LIST_COLUMN_TYPES,
        parsed_filter,
        parsed_order=parsed_order,
        limit=None,
    )
  except ValueError as e:
    raise HTTPException(status_code=400, detail=str(e))
  except duckdb.ConversionException as e:
    raise HTTPException(
        status_code=400, detail=f'trace_filter value type mismatch: {e}')
  # Reassemble dicts from cols + rows. We can't rely on the original
  # `traces` list order here because the filter+order_by may have
  # reshuffled — taking the values straight off the SQL result is
  # the authoritative read.
  entries: list[dict[str, Any]] = []
  for r in rows:
    entries.append({c: v for c, v in zip(cols, r)})
  cap = trace_limit(settings)
  if cap > 0 and len(entries) > cap:
    entries = entries[:cap]
  return entries


def _validate_trace_metadata_columns_or_400(
    trace_metadata_columns: Any,) -> list[str]:
  """Validate the top-level `trace_metadata_columns` request field.

    Accepts: None / missing → empty list (no extra metadata stapled
    onto query results). A JSON list of column-name strings → those
    columns are appended to every result row (right after trace_id).

    400 on: non-list / non-string entries / unknown column names /
    duplicates. Same error contract as the `/traces?columns=` path
    so clients can surface the detail uniformly.
    """
  if trace_metadata_columns is None:
    return []
  if not isinstance(trace_metadata_columns, list):
    raise HTTPException(
        status_code=400,
        detail='trace_metadata_columns must be an array of column names',
    )
  allowed = {c['name'] for c in _TRACE_LIST_SCHEMA}
  seen: set[str] = set()
  out: list[str] = []
  for c in trace_metadata_columns:
    if not isinstance(c, str) or not c:
      raise HTTPException(
          status_code=400,
          detail='trace_metadata_columns entries must be non-empty strings',
      )
    if c not in allowed:
      raise HTTPException(
          status_code=400,
          detail=(f"unknown trace metadata column {c!r}; "
                  f'available: {sorted(allowed)}'),
      )
    if c in seen:
      raise HTTPException(
          status_code=400,
          detail=f"duplicate trace metadata column {c!r}",
      )
    seen.add(c)
    out.append(c)
  return out


def _normalize_trace_filter_for_storage(tf: Any) -> Optional[str]:
  """Normalize the request-body trace_filter to its persisted shape.

    Returns the storage string form (JSON-encoded `Filter[]`) or
    None. Storage is JSON-encoded text in DuckDB; the wire shape is
    a native array (round-tripped back via json.loads in
    `_qe_to_raw`). Anything that isn't a list persists as None;
    semantic validation (parse + column check) happens in
    `_parse_trace_filter_or_400` and surfaces a 400 before the row
    sees a SQL query.
    """
  if tf is None:
    return None
  if isinstance(tf, list):
    return json.dumps(tf) if tf else None
  # Non-list shapes are rejected by _parse_trace_filter_or_400 with
  # a 400; persist None here so the snapshot column doesn't carry
  # garbage. (The handler will mark_failed the just-inserted row.)
  return None


def _parse_trace_filter_or_400(raw: Any,
                               field_name: str = 'trace_filters') -> list:
  """Parse a JSON-body filter field to `list[ParsedFilter]`.

    Shared by all three filter sites — `/execute_*` `trace_filters`,
    `/traces` `filters`, and `:fetch_results` `filters` — every one of
    them takes a native JSON `Filter[]` array under the strict-native
    body contract ([§10.1, §12.1] of WIRE_SPEC.md). One parser, one
    composer, one wire shape.

    Accepts: None / missing / empty list → no filter. Native list →
    parsed via `parse_filter`. Strings (including the empty string)
    and any other shape → 400 INVALID_ARGUMENT pointing at the type
    mismatch. The historical JSON-encoded-string form was removed
    from body sites on the strict-native migration (2026-06-03);
    clients shipping it now get a clear error.
    """
  if raw is None:
    return parse_filter('')
  if isinstance(raw, list):
    try:
      return parse_filter(json.dumps(raw))
    except ValueError as e:
      raise HTTPException(status_code=400, detail=str(e))
  raise HTTPException(
      status_code=400,
      detail=(f'{field_name} must be a native JSON Filter[] array; '
              f'got {type(raw).__name__}. The JSON-encoded string '
              f'form was removed on the strict-native migration '
              f'(2026-06-03); send the array directly.'),
  )


# ---------------------------------------------------------------------------
# Background async query lifecycle
# ---------------------------------------------------------------------------


async def _run_async_query(
    query_uuid: str,
    perfetto_sql: str,
    limit: int,
    settings: list[dict[str, Any]],
    trace_filter: Any,
    trace_metadata_columns: Any,
    trace_order_by: Optional[str] = None,
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
    meta_cols = _validate_trace_metadata_columns_or_400(trace_metadata_columns)
    entries = _resolve_traces_for(settings, trace_filter, trace_order_by)
    paths = [e['file_path'] for e in entries]
    # Async path: do NOT stitch metadata into result rows. Instead,
    # write it once to a sidecar table keyed by trace_id. The
    # `:fetch_results` `columns` projection picks columns from
    # (result_table ∪ sidecar_table) and the page SQL JOINs the
    # sidecar when needed. This keeps the result table from
    # inflating with per-row metadata duplication — critical when
    # metadata is wide.
    ctx.total_traces = len(paths)
    db.update_total_traces(query_uuid, len(paths))

    if meta_cols and entries:
      meta_column_types = _trace_list_column_types_for(meta_cols)
      # Build (trace_id, *meta_values) rows. trace_id is derived the
      # same way the executor derives it from the file path, so the
      # JOIN matches up.
      meta_rows = []
      for e in entries:
        trace_id = _trace_id_for(e['file_path'])
        meta_rows.append(tuple([trace_id] + [e.get(c) for c in meta_cols]))
      db.create_metadata_sidecar(
          query_uuid,
          [('trace_id', 'VARCHAR')] + meta_column_types,
          meta_rows,
      )

    if not paths:
      # Nothing to do but it's not an error — succeed with zero
      # rows. Note: the materialized table is never created (no
      # worker ran), but tableName remains set on the metadata
      # row so :fetch_results returns 200 with empty content via
      # the "table exists but no rows yet" branch.
      db.mark_success(query_uuid, 0)
      return

    await run_query_across_traces(
        POOL,
        paths,
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
  except HTTPException as e:
    # Bare detail mirrors what sync would surface at submit time.
    log.warning('async query validation failed: %s', e.detail)
    db.mark_failed(query_uuid, str(e.detail))
  except Exception as e:  # noqa: BLE001
    log.exception('async query failed')
    db.mark_failed(query_uuid, f'{type(e).__name__}: {e}')


# ---------------------------------------------------------------------------
# Endpoints: query execution
# ---------------------------------------------------------------------------


async def _parse_query_body(
    request: Request,
) -> tuple[str, int, list[dict[str, Any]], Any, Any, Optional[str]]:
  """Pull `(perfetto_sql, limit, settings, trace_filter,
    trace_metadata_columns, trace_order_by)` from the request JSON.

    Shared by `execute_async` and `execute_sync` so the field names
    and defaults can't drift between the two endpoints. Defaults
    (`''`, `100`, `[]`, `None`, `None`, `None`) match what the UI
    sends when the user hasn't overridden a setting / has no
    trace-filter active / hasn't opted into extra metadata columns /
    didn't sort the trace grid.

    `trace_filters` is a top-level structured field (Filter[] JSON,
    same shape as `:fetch_results` `filters`). Absence here means
    "process every trace in the directory" subject to `trace_limit`.

    `trace_metadata_columns` is a top-level array of column names
    from `/traces_schema`. When set, those values are prepended to
    every result row (right after `trace_id`) so query results carry
    per-trace context without the user having to join it in SQL.
    Absence / [] means "no extra columns".

    `trace_order_by` is the AIP-132 wire string (same grammar as
    `/traces?order_by=`). When set, controls the order in which
    traces are processed (and therefore which N are kept when
    `trace_limit` truncates). Absence falls back to `file_path ASC`.
    """
  body = await request.json()
  return (
      body.get('perfetto_sql', ''),
      body.get('limit', 100),
      body.get('settings', []),
      body.get('trace_filters'),
      body.get('trace_metadata_columns'),
      body.get('trace_order_by'),
  )


@app.post('/execute_bigtrace_query_async')
async def execute_async(request: Request) -> dict[str, Any]:
  """Submit a query for background execution.

    Returns `{queryUuid}` immediately after validating the trace
    directory and inserting an IN_PROGRESS row. The actual fan-out
    across traces happens in `_run_async_query`, scheduled as an
    asyncio.create_task. The client polls `:status` until terminal,
    then fetches results via `:fetch_results`.

    Up-front validation (trace_directory) gives the user a 400 at
    submit time rather than a 200 followed by a FAILED poll. A
    failure here marks the just-inserted row FAILED in the DB so
    the history list still shows the entry — same lifecycle as the
    sync path.
    """
  (perfetto_sql, limit, settings, trace_filter, trace_metadata_columns,
   trace_order_by) = await _parse_query_body(request)
  db = _get_db()

  new_uuid = str(uuid.uuid4())
  # Insert as IN_PROGRESS with tableName set immediately. The
  # materialized table itself is created lazily when the first
  # successful trace's worker merges its rows. Snapshot fields go in
  # at submit-time (pre-validation) so even queries that fail at
  # submit record what was attempted.
  db.insert_qe_in_progress(
      new_uuid,
      perfetto_sql,
      limit,
      materialized=True,
      settings=settings if isinstance(settings, list) else None,
      trace_filter=_normalize_trace_filter_for_storage(trace_filter),
      trace_metadata_columns=(trace_metadata_columns if isinstance(
          trace_metadata_columns, list) else None),
      trace_order_by=trace_order_by
      if isinstance(trace_order_by, str) else None,
  )

  # Validate the trace directory, the trace_filter shape, the
  # trace_metadata_columns, and the trace_order_by string up-front
  # so the user gets a 400 at submit time rather than having to poll
  # a FAILED status. The FAILED metadata still lives in DuckDB so
  # the history list shows it; tableName is cleared (mark_failed
  # handles that). We only do the cheap-to-validate parts here — the
  # actual directory walk happens in the background task so a huge
  # directory doesn't block the submit response.
  try:
    _resolve_trace_dir(settings)
    _parse_trace_filter_or_400(trace_filter)
    _validate_trace_metadata_columns_or_400(trace_metadata_columns)
    # Lexical parse only — column-name validation happens at
    # execute-time inside `_resolve_traces_for` (it needs the
    # column-types map).
    if trace_order_by:
      try:
        parse_order_by(trace_order_by)
      except ValueError as e:
        raise HTTPException(status_code=400, detail=f'trace_order_by: {e}')
  except HTTPException as e:
    db.mark_failed(new_uuid, str(e.detail))
    raise

  # The asyncio event loop keeps a strong reference to the task until
  # it completes; cancellation is signalled via qe.status + ctx, not
  # task.cancel().
  asyncio.create_task(
      _run_async_query(new_uuid, perfetto_sql, limit, settings, trace_filter,
                       trace_metadata_columns, trace_order_by),)

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
  (perfetto_sql, limit, settings, trace_filter, trace_metadata_columns,
   trace_order_by) = await _parse_query_body(request)
  db = _get_db()

  new_uuid = str(uuid.uuid4())
  start_time = utcnow()
  # Insert IN_PROGRESS upfront so the run is visible in the history
  # while it executes, and so a server crash mid-sync produces a
  # FAILED row on next startup instead of a silent loss. Snapshot
  # fields persisted alongside (see execute_async for rationale).
  db.insert_qe_in_progress(
      new_uuid,
      perfetto_sql,
      limit,
      materialized=False,
      start_time=start_time,
      settings=settings if isinstance(settings, list) else None,
      trace_filter=_normalize_trace_filter_for_storage(trace_filter),
      trace_metadata_columns=(trace_metadata_columns if isinstance(
          trace_metadata_columns, list) else None),
      trace_order_by=trace_order_by
      if isinstance(trace_order_by, str) else None,
  )

  # Resolve the trace list (validates trace_dir, applies trace_filter +
  # trace_order_by + trace_limit) and the metadata-columns request.
  # Mirrors the async path so the same caps + validations apply.
  try:
    entries = _resolve_traces_for(settings, trace_filter, trace_order_by)
    meta_cols = _validate_trace_metadata_columns_or_400(trace_metadata_columns)
  except HTTPException as e:
    db.mark_failed(new_uuid, str(e.detail))
    raise

  paths = [e['file_path'] for e in entries]
  db.update_total_traces(new_uuid, len(paths))
  if not paths:
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
  ctx = RunContext(
      global_limit=limit,
      inline_rows=[],
      metadata_columns=meta_cols,
      metadata_for_trace={
          e['file_path']: [_value_to_wire(e.get(c)) for c in meta_cols]
          for e in entries
      },
  )
  run_task = asyncio.create_task(
      run_query_across_traces(
          POOL,
          paths,
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
    # CancelledError isn't an Exception in 3.8+, hence the explicit pair.
    with contextlib.suppress(asyncio.CancelledError, Exception):
      await watcher

  if err is not None:
    db.mark_failed(new_uuid, err)
    raise HTTPException(status_code=400, detail=err)

  # Sync queries don't persist their result rows server-side, so
  # `processed_rows` has no meaningful value to record — leaving it
  # at 0 (from `insert_qe_in_progress`) signals "no fetchable
  # rowcount" to clients. The UI's history list and re-open empty-
  # state branch on this. See TODO.md if we revisit.
  db.mark_success(new_uuid)
  # Sync responses follow the same always-strings wire contract as
  # `:fetch_results`: every row value is a JSON string (or null for
  # SQL NULL). Symmetric with the async path so clients see one
  # response shape regardless of which endpoint they hit. Note the
  # sort caveat in `~/Projects/CLAUDE.md` Filter parameter section
  # — sync results are sorted client-side via `InMemoryDataSource`,
  # which can't tell that `"100"` and `"99"` are numeric, so
  # numeric-looking columns sort lexically until we ship per-column
  # type info or replace the sync data source.
  return {
      'queryUuid': new_uuid,
      'columnNames': cols,
      'rows': _wire_rows(rows),
  }


@app.get('/query_executions/{uuid}:status')
async def get_status(uuid: str) -> dict[str, Any]:
  # Lightweight progress channel — only fields that change during the
  # run. The UI calls /query_executions/{uuid} (full) once at submit
  # and again on terminal transition for the static metadata.
  snap = _get_snapshot_or_404(uuid)
  return _qe_to_status(snap)


@app.post('/query_executions/{uuid}:fetch_results')
async def fetch_results(uuid: str, request: Request) -> dict[str, Any]:
  """Paginated read over the per-query materialized table.

    POST + body (not GET + query string) so `filters` can ride as a
    native JSON array under the strict-native body contract shared
    by all three filter sites (this endpoint, `/execute_*`
    `trace_filters`, and `/traces` `filters`). Migrated 2026-06-03.

    Request body:
        {
          "limit": <int>,                  // page size; default 50
          "offset": <int>,                  // page offset; default 0
          "order_by": "<aip-132 string>",  // optional; default ""
          "filter": [Filter, ...],          // optional; default []
          "columns": ["<col>", ...]         // optional field-mask
        }

    Status code mapping follows gRPC/AIP semantics so clients can
    branch on the kind of failure rather than parsing detail strings:

    - **404 NOT_FOUND** — entry doesn't exist (or is soft-deleted),
      OR the metadata says the table should exist but DuckDB can't
      find it (out-of-band drop / TTL race).
    - **400 FAILED_PRECONDITION** — the entry exists but isn't in a
      fetchable state: sync queries (`materialized=false`),
      `processed_rows == 0`, or `table_name is null` (FAILED,
      CANCELLED-with-zero-rows, TTL-swept).
    - **400 INVALID_ARGUMENT** — `order_by` or `filters` is malformed
      or references an unknown column (raised from the parsers).
      Same status code, different `detail` shape from the
      FAILED_PRECONDITION case.

    `order_by` follows AIP-132 §Ordering: a comma-separated list of
    field names, each optionally followed by ` desc` (default `asc`).

    `filters` is a native JSON `Filter[]` array. Empty / absent → no
    `WHERE`. Multi-entry arrays are AND'd. The wire shape mirrors
    the DataGrid's `model.ts:Filter`:
        [{"field": <col>, "op": <op>, "value": <string|list>}, ...]
    Recognized ops: `=`, `!=`, `<`, `<=`, `>`, `>=`, `glob`,
    `not glob`, `in`, `not in`, `is null`, `is not null`. Values
    are JSON strings on the wire (the UI's encoder coerces
    numbers/booleans/bigints losslessly via `String(...)`); DuckDB
    binds them to the column's actual type at execute time. See
    `~/Projects/CLAUDE.md` "Filter parameter" for the full spec.

    The response always carries `totalFilteredRows` — equal to the
    materialized table size when no filter is applied, and to the
    post-filter row count otherwise. The UI uses it to size its
    virtual scrollbar.
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

  body = await request.json()
  limit = int(body.get('limit', 50))
  offset = int(body.get('offset', 0))
  order_by = body.get('order_by', '') or ''
  raw_filter = body.get('filters')
  raw_columns = body.get('columns')

  # Validate the filter shape up front (rejects strings with 400
  # under the strict-native body contract). The parsed result is
  # ignored here — `fetch_paginated` re-parses from a JSON string
  # so the SQL-composition layer stays endpoint-agnostic.
  _parse_trace_filter_or_400(raw_filter, field_name='filters')
  filter_str = json.dumps(raw_filter) if raw_filter else ''

  # `columns` body field: native JSON list of column names — a
  # field-mask over the union of (result table cols ∪ sidecar
  # metadata cols). Empty / absent means "every result column, no
  # sidecar" — the back-compatible default.
  if raw_columns is None:
    projected = None
  elif isinstance(raw_columns, list):
    projected = [str(c) for c in raw_columns if c]
    if not projected:
      projected = None
  else:
    raise HTTPException(
        status_code=400,
        detail=(f'columns must be a JSON array of column names; '
                f'got {type(raw_columns).__name__}'),
    )

  try:
    # fetch_paginated returns (cols, rows, total_filtered,
    # available_column_names) under a single lock acquisition so all four
    # numbers reflect the same snapshot even if a TTL sweep races us.
    cols, rows, total_filtered, available = _get_db().fetch_paginated(
        uuid,
        limit,
        offset,
        order_by,
        filter_str=filter_str,
        projected_columns=projected,
    )
  except ValueError as e:
    raise HTTPException(status_code=400, detail=str(e))
  except duckdb.ConversionException as e:
    # Filter value couldn't be coerced to the column's type at bind
    # time — e.g., 'not-a-number' against a BIGINT column. Same
    # 400 INVALID_ARGUMENT shape as a parser-rejected filter; the
    # detail names the offending coercion so clients can surface it.
    raise HTTPException(
        status_code=400, detail=f'filter value type mismatch: {e}')
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
  resp = _rows_response(cols, rows, total_filtered)
  # availableColumnNames lets the UI's column picker offer every column
  # the user could project — including sidecar metadata that isn't in
  # the current `columns` projection. Plain JSON array (string list)
  # — every name is a quoted identifier in DuckDB.
  resp['availableColumnNames'] = available
  return resp


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
  snap = _get_snapshot_or_404(uuid)
  if snap.status != 'IN_PROGRESS':
    # Already terminal — idempotent 200 no-op.
    return Response(status_code=200)
  _get_db().mark_cancelled(
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
  snap = _get_snapshot_or_404(uuid)
  if snap.status == 'IN_PROGRESS':
    raise HTTPException(
        status_code=409,
        detail=f'Query {uuid} is still running; cancel it before deleting',
    )
  _get_db().soft_delete(uuid)
  return Response(status_code=200)


# ---------------------------------------------------------------------------
# Endpoints: trace listing
# ---------------------------------------------------------------------------


@app.post('/traces')
async def traces(request: Request) -> dict[str, Any]:
  """Paginated metadata for trace files in `trace_directory`.

    Powers the trace grid embedded in the BigTrace UI's Settings
    page. The grid drives filter/sort/page exactly as if it were
    paging a materialized query result, and the Settings page ships
    the active filter to `/execute_*` as the top-level `trace_filters`
    field — the user's "implicit selection" model (the filter
    chosen on the grid is the trace set the query runs over).

    Request body:
      {
        "settings": [{"setting_id":"trace_directory","values":["..."],...}],
        "filter":   [/* native Filter[] — same shape as :fetch_results filter */],
        "order_by": "<aip-132 string>",
        "limit":    N,
        "offset":   M,
        "columns":  ["file_name", "size_bytes"]   // optional projection
      }

    Response: `{columnNames, rows, totalFilteredRows}` — same wire
    shape and always-strings contract as `:fetch_results`. Default
    column set (when `columns` is absent): all entries from
    /traces_schema flagged `defaultVisible: true`. Otherwise the
    response projects exactly the named columns in the given order.

    `filters` / `order_by` may reference columns that aren't in the
    projection — they still apply (because the underlying scan sees
    every column), they just don't appear in the response.

    Status mapping mirrors `:fetch_results`:
      - 400 INVALID_ARGUMENT — malformed filter / order_by /
        unknown filter / order_by / columns entry / value coercion.
      - 400 INVALID_ARGUMENT — trace_directory missing/unreadable
        (existing `_resolve_trace_dir` shape).
    """
  body = await request.json()
  settings = body.get('settings', [])
  raw_filter = body.get('filters')
  order_by = body.get('order_by', '') or ''
  limit = int(body.get('limit', 100))
  offset = int(body.get('offset', 0))
  projected = body.get('columns')

  traces_dir = _resolve_trace_dir(settings)
  parsed_filter = _parse_trace_filter_or_400(raw_filter, field_name='filters')
  try:
    parsed_order = parse_order_by(order_by)
  except ValueError as e:
    raise HTTPException(status_code=400, detail=str(e))

  rows = enumerate_traces(traces_dir)
  try:
    cols, page, total = query_trace_list(
        rows,
        _TRACE_LIST_COLUMN_TYPES,
        parsed_filter,
        parsed_order,
        limit=limit,
        offset=offset,
        projected_columns=projected,
    )
  except ValueError as e:
    raise HTTPException(status_code=400, detail=str(e))
  except duckdb.ConversionException as e:
    raise HTTPException(
        status_code=400,
        detail=f'filter value type mismatch: {e}',
    )
  return _rows_response(cols, page, total)


@app.post('/traces_schema')
async def traces_schema(request: Request) -> dict[str, Any]:
  """Describe the columns the `/traces` endpoint can return.

    The UI calls this once when the Settings page mounts (or when
    `trace_directory` changes — a backend with a metadata index may
    surface different columns per directory). The response feeds the
    grid's SchemaRegistry and its "Add column" menu, so the UI never
    bakes a column list in.

    Body: `{settings: [...]}` (so a future backend can vary the
    schema by trace source).

    Response:
      {
        "columns": [
          {"name": "file_path", "type": "VARCHAR", "defaultVisible": true},
          ...
        ]
      }

    `defaultVisible: true` flags the columns the grid shows on first
    render; `defaultVisible: false` columns are addable via the
    column menu. `type` is informational — the grid renders every value as
    a string per the always-strings wire contract. `description`
    is optional (per the wire spec); the local backend omits it so
    the grid headers don't carry placeholder tooltips.

    For the local TP backend the schema is static. A real BigTrace
    backend would derive it from the indexer's catalog, possibly
    intersecting with the active filters in `settings`.
    """
  # Body is read but currently unused — pin the wire shape for
  # forward-compat with backends that vary the schema by setting.
  await request.json()
  return {'columns': _TRACE_LIST_SCHEMA}


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

  def _patched_connect(database: str = ':memory:',
                       *args: Any,
                       **kwargs: Any) -> Any:
    # Return type is duckdb.DuckDBPyConnection; `Any` avoids importing
    # a class that some DuckDB versions don't expose.
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
