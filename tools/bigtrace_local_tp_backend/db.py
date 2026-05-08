# Copyright (C) 2026 The Android Open Source Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""DuckDB-backed persistence for BigTrace local backend.

Two stores in one DuckDB file:
- `query_executions`: one row per submitted async query (history + current
  state). Soft-deleted via the `deleted` flag.
- `bigtrace_<uuid>`: one table per async query that produced rows.
  Schema is dynamic — driven by the first successful trace's column
  shape. The `trace_id` column is prepended.

Concurrency
-----------
A single DuckDB connection is held by `Database` and serialized through
`self._lock`. Critical sections are short (one statement at a time), so
the lock is held only for microseconds in the common case.

Cancellation is coordinated entirely through this same lock: the
`:cancel` handler flips `qe.status = 'CANCELLED'` under it, and
`merge_trace_atomic` bundles status-check + insert + counter-bump
under it too — so once cancel returns 200, every subsequent merge
attempt observes the new status and bails before inserting. There is
no separate in-process cancel flag.

Soft delete
-----------
DELETE flips `deleted = TRUE`. Reads of a deleted row return `None` from
`get_qe` so handlers can 404 uniformly. List queries filter
`WHERE deleted = FALSE`. The materialized table is dropped immediately
on soft-delete (the data is gone; the audit row stays).

Names
-----
DuckDB identifiers can't contain hyphens, so a query UUID
`abc-1234-...` becomes table `bigtrace_abc_1234_...`. The wire
protocol's `tableName` is the same string — clients can paste it
straight into a SQL editor (Datasette, DuckDB CLI, the in-process
DuckDB UI) and it will resolve. `tableLink` is built mechanically
from `tableName`.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import duckdb
import pyarrow as pa

log = logging.getLogger('bigtrace_local.db')

# ---------------------------------------------------------------------------
# Wire-protocol-friendly snapshot of one query_executions row.
# ---------------------------------------------------------------------------


@dataclass
class QESnapshot:
  """In-memory view of a query_executions row.

    Built by `Database` from a SELECT result. Handlers serialize this
    into the JSON wire shape via `to_raw_dict` / `to_status_dict` (in
    server.py). All times are ISO-8601 strings (UTC) to match the wire
    protocol — the DuckDB columns are TIMESTAMP, converted on read.
    """
  query_uuid: str
  status: str
  perfetto_sql: str
  query_limit: int
  materialized: bool
  start_time: str  # ISO-8601
  end_time: Optional[str]
  processed_rows: int
  processed_traces: int
  total_traces: int
  error_message: Optional[str]
  table_name: Optional[str]


def _ts_to_iso(ts: Any) -> Optional[str]:
  """Format a DuckDB TIMESTAMP back to ISO-8601 with **millisecond**
    precision.

    Sub-second precision matters because most queries complete in well
    under a second; truncating to whole seconds (the previous format
    `.000Z`) made the UI show a flat 0s duration. DuckDB's TIMESTAMP
    is microsecond-precise; we keep ms in the wire and pad/truncate.
    """
  if ts is None:
    return None
  return ts.strftime('%Y-%m-%dT%H:%M:%S') + f'.{ts.microsecond // 1000:03d}Z'


def utcnow() -> datetime:
  """Naive UTC datetime suitable for binding to a DuckDB TIMESTAMP.

    Use this instead of DuckDB's `CURRENT_TIMESTAMP`: the latter
    resolves to **local time** when it lands in a TIMESTAMP column,
    which we then mislabel as `Z` on the wire. Going through Python
    guarantees UTC end-to-end and lets the caller capture distinct
    start_time / end_time around the actual work.
    """
  return datetime.now(timezone.utc).replace(tzinfo=None)


# DuckDB-compatible identifier from a UUID. Hyphens aren't allowed in
# unquoted identifiers; quoting works but makes the SQL noisier and
# less portable to other tools the user might point at the file. The
# wire-protocol `tableName` is exactly this string — `tableLink` is
# derived mechanically from `tableName`, so clients can paste either
# directly into a SQL editor.
def safe_table_id(query_uuid: str) -> str:
  return 'bigtrace_' + query_uuid.replace('-', '_')


def parse_order_by(s: str) -> list[tuple[str, str]]:
  """Parse an AIP-132 `order_by` string into (field, direction) pairs.

    Grammar (AIP-132 §Ordering):
        order_by  = field [direction] *( "," field [direction] )
        direction = "asc" | "desc"            ; default "asc"

    Examples:
        ""                       -> []
        "name"                   -> [("name", "ASC")]
        "name desc"              -> [("name", "DESC")]
        "name desc, dur asc"     -> [("name", "DESC"), ("dur", "ASC")]

    Returns a list with directions normalized to upper-case `ASC`/`DESC`
    so the caller can splice them straight into SQL. Raises `ValueError`
    on syntax errors. Column-name validation against the live schema is
    the caller's responsibility — this function is purely lexical.
    """
  out: list[tuple[str, str]] = []
  if not s.strip():
    return out
  for raw in s.split(','):
    token = raw.strip()
    if not token:
      raise ValueError('empty order_by entry')
    parts = token.split()
    if len(parts) > 2:
      raise ValueError(f'invalid order_by entry: {token!r}')
    field = parts[0]
    direction = 'ASC'
    if len(parts) == 2:
      d = parts[1].lower()
      if d not in ('asc', 'desc'):
        raise ValueError(f"direction must be 'asc' or 'desc': {token!r}")
      direction = d.upper()
    out.append((field, direction))
  return out


# Recognized filter operators. Mirrors the FilterOpAndValue union in
# `ui/src/components/widgets/datagrid/model.ts` exactly. Partitioned by
# value-arity so `parse_filter` can validate the value shape per op.
_FILTER_NULL_OPS = frozenset({'is null', 'is not null'})
_FILTER_OP_OPS = frozenset(
    {'=', '!=', '<', '<=', '>', '>=', 'glob', 'not glob'})
_FILTER_IN_OPS = frozenset({'in', 'not in'})
_FILTER_ALL_OPS = _FILTER_NULL_OPS | _FILTER_OP_OPS | _FILTER_IN_OPS


@dataclass
class ParsedFilter:
  """One entry from a parsed `filter` query param.

    `values` carries 0 entries for null-arity ops (`is null`,
    `is not null`), 1 entry for scalar ops (`=`, `glob`, `<`, ...),
    or N entries for list ops (`in`, `not in`). `compile_where` uses
    that arity to pick the right SQL fragment.
    """
  field: str
  op: str
  values: list[Any]


def parse_filter(s: str) -> list[ParsedFilter]:
  """Parse a JSON-encoded `Filter[]` from the `filter` query param.

    Wire shape (matches `ui/src/components/widgets/datagrid/model.ts`):

        [
          {"field": "<col>", "op": "=", "value": <scalar>},
          {"field": "<col>", "op": "in", "value": [<scalar>, ...]},
          {"field": "<col>", "op": "is null"},
          ...
        ]

    Multi-entry arrays are AND'd together by the caller (the same
    semantics as `SqlDataSource.filterToSql` on the UI side, which
    composes `WHERE a AND b AND ...`).

    Op-arity rules:
        - null-arity ops omit the `value` key entirely. A present
          `value` is rejected.
        - scalar ops require a non-array `value`.
        - list ops require a non-empty array `value`. Empty arrays
          are rejected (the widget shouldn't generate them; a clear
          error catches client bugs).

    The wire spec says `value` is always a string (the UI's encoder
    coerces numbers/booleans/bigints via `String(...)` so int64
    values round-trip losslessly). The parser is permissive about
    that — any JSON scalar (`str`, `int`, `float`, `bool`, `None`)
    passes through and DuckDB does its own coercion at bind time.
    A genuinely-bad coercion (e.g., `"not-a-number"` against a
    BIGINT column) surfaces at execute time as a
    `duckdb.ConversionException` and the endpoint maps that to
    `400 INVALID_ARGUMENT`.

    Empty / whitespace `s` -> []. Raises `ValueError` on any
    structural problem. Column-name validation against the live
    schema is the caller's responsibility — same contract as
    `parse_order_by`.
    """
  if not s.strip():
    return []
  try:
    raw = json.loads(s)
  except json.JSONDecodeError as e:
    raise ValueError(f'filter is not valid JSON: {e.msg}')
  if not isinstance(raw, list):
    raise ValueError(f'filter must be a JSON array, got {type(raw).__name__}')
  out: list[ParsedFilter] = []
  for i, entry in enumerate(raw):
    if not isinstance(entry, dict):
      raise ValueError(
          f'filter[{i}] must be an object, got {type(entry).__name__}')
    field = entry.get('field')
    op = entry.get('op')
    if not isinstance(field, str) or not field:
      raise ValueError(f'filter[{i}].field must be a non-empty string')
    if not isinstance(op, str) or op not in _FILTER_ALL_OPS:
      raise ValueError(f'filter[{i}].op {op!r} is not a recognized operator')
    if op in _FILTER_NULL_OPS:
      if 'value' in entry:
        raise ValueError(f'filter[{i}].op {op!r} must not carry a value')
      out.append(ParsedFilter(field=field, op=op, values=[]))
    elif op in _FILTER_OP_OPS:
      if 'value' not in entry:
        raise ValueError(f'filter[{i}].op {op!r} requires a value')
      v = entry['value']
      if isinstance(v, list):
        raise ValueError(
            f'filter[{i}].op {op!r} requires a scalar value, got array')
      out.append(ParsedFilter(field=field, op=op, values=[v]))
    else:  # in / not in
      if 'value' not in entry:
        raise ValueError(f'filter[{i}].op {op!r} requires a value array')
      v = entry['value']
      if not isinstance(v, list):
        raise ValueError(f'filter[{i}].op {op!r} requires an array value')
      if len(v) == 0:
        raise ValueError(f'filter[{i}].op {op!r} requires a non-empty array')
      out.append(ParsedFilter(field=field, op=op, values=list(v)))
  return out


# Translation table for scalar (single-value) ops. Most map to
# themselves; `glob` needs uppercasing for DuckDB. `not glob` is
# emitted by `compile_where` as `NOT (... GLOB ?)` because DuckDB's
# parser doesn't accept `NOT GLOB` as a single token (it does for
# `NOT LIKE`/`NOT ILIKE`, but GLOB is the odd one out).
_FILTER_SQL_SCALAR = {
    '=': '=',
    '!=': '!=',
    '<': '<',
    '<=': '<=',
    '>': '>',
    '>=': '>=',
    'glob': 'GLOB',
}


def compile_where(
    parsed: list[ParsedFilter],
    allowed: set[str],
) -> tuple[str, list[Any]]:
  """Compile parsed filters into a SQL WHERE fragment + bound params.

    Returns `('', [])` when `parsed` is empty so the caller can skip
    the `WHERE` keyword entirely. Otherwise returns a fragment like
    `'"a" = ? AND "b" IN (?, ?)'` paired with the value list to bind.
    Identifiers are double-quoted so user column names colliding with
    DuckDB keywords or containing special characters work; values are
    parameterized via DuckDB's `?` binding so no user-supplied bytes
    ever land in the SQL string.

    Each filter's `field` is validated against `allowed` (typically
    the materialized table's live column list, resolved by the
    caller from `information_schema.columns`). Unknown columns raise
    `ValueError` with the same shape as the order_by validator so
    the endpoint maps both to 400 INVALID_ARGUMENT.
    """
  if not parsed:
    return '', []
  fragments: list[str] = []
  params: list[Any] = []
  for pf in parsed:
    if pf.field not in allowed:
      raise ValueError(f'unknown filter column {pf.field!r}; '
                       f'available: {sorted(allowed)}')
    col = f'"{pf.field}"'
    if pf.op in _FILTER_NULL_OPS:
      sql_op = 'IS NULL' if pf.op == 'is null' else 'IS NOT NULL'
      fragments.append(f'{col} {sql_op}')
    elif pf.op in _FILTER_IN_OPS:
      placeholders = ', '.join(['?'] * len(pf.values))
      sql_op = 'IN' if pf.op == 'in' else 'NOT IN'
      fragments.append(f'{col} {sql_op} ({placeholders})')
      params.extend(pf.values)
    elif pf.op == 'not glob':
      # DuckDB's parser rejects `NOT GLOB` as a single token, so
      # wrap as `NOT (col GLOB ?)`. Same observable semantics.
      fragments.append(f'NOT ({col} GLOB ?)')
      params.append(pf.values[0])
    else:
      fragments.append(f'{col} {_FILTER_SQL_SCALAR[pf.op]} ?')
      params.append(pf.values[0])
  return ' AND '.join(fragments), params


# Map Python types from the first sample row → DuckDB column types.
_TYPE_MAP = {
    bool: 'BOOLEAN',
    int: 'BIGINT',
    float: 'DOUBLE',
    str: 'VARCHAR',
    bytes: 'BLOB',
}


def _infer_column_types(sample_row: list[Any]) -> list[str]:
  """Map one row's Python values to DuckDB column type names.

    `None` columns fall through to VARCHAR — DuckDB will accept any
    castable value going forward.
    """
  out: list[str] = []
  for v in sample_row:
    if v is None:
      out.append('VARCHAR')
    else:
      out.append(_TYPE_MAP.get(type(v), 'VARCHAR'))
  return out


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------


class Database:
  """Thin wrapper around a DuckDB connection. Thread-safe.

    All public methods take `self._lock` for the duration of the SQL
    call so multiple worker threads can call into here concurrently.
    """

  def __init__(self, path: str) -> None:
    self.path = path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    self._lock = threading.Lock()
    # Single connection. DuckDB's Python connection isn't safe to
    # share across threads without external sync, but our `_lock`
    # provides exactly that.
    self._conn = duckdb.connect(path)
    self._init_schema()

  # ------------------------------------------------------------------
  # Schema setup (idempotent).
  # ------------------------------------------------------------------

  def _init_schema(self) -> None:
    with self._lock:
      self._conn.execute("""
                CREATE TABLE IF NOT EXISTS query_executions (
                  query_uuid       VARCHAR PRIMARY KEY,
                  status           VARCHAR NOT NULL,
                  start_time       TIMESTAMP,
                  end_time         TIMESTAMP,
                  perfetto_sql     VARCHAR,
                  query_limit      INTEGER,
                  materialized     BOOLEAN NOT NULL,
                  table_name       VARCHAR,
                  processed_traces INTEGER NOT NULL DEFAULT 0,
                  total_traces     INTEGER NOT NULL DEFAULT 0,
                  processed_rows   BIGINT  NOT NULL DEFAULT 0,
                  error_message    VARCHAR,
                  deleted          BOOLEAN NOT NULL DEFAULT FALSE
                )
                """)
      self._conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_qe_visible
                  ON query_executions (deleted, end_time)
                """)

  # ------------------------------------------------------------------
  # query_executions: writes
  # ------------------------------------------------------------------

  def insert_qe_in_progress(
      self,
      query_uuid: str,
      perfetto_sql: str,
      query_limit: int,
      materialized: bool,
      start_time: Optional[datetime] = None,
  ) -> None:
    """Initial insert for any query (sync or async) that's about
        to start running.

        Status starts at IN_PROGRESS; transition via
        `mark_success` / `mark_failed` / `mark_cancelled` (each
        conditional on IN_PROGRESS so concurrent state changes can't
        race). For `materialized=True`, `table_name` is set so the
        wire shape can expose it from the moment of submission. For
        `materialized=False` (sync), `table_name` stays NULL — sync
        queries don't have a fetchable result.

        `start_time` defaults to utcnow() if not provided. Callers
        that captured a precise wall-clock at the start of the
        request should pass it explicitly so the recorded duration
        matches reality.
        """
    if start_time is None:
      start_time = utcnow()
    table_name = safe_table_id(query_uuid) if materialized else None
    with self._lock:
      self._conn.execute(
          """
                INSERT INTO query_executions
                  (query_uuid, status, start_time, perfetto_sql, query_limit,
                   materialized, table_name, processed_traces, total_traces,
                   processed_rows)
                VALUES (?, 'IN_PROGRESS', ?, ?, ?, ?, ?, 0, 0, 0)
                """,
          [
              query_uuid, start_time, perfetto_sql, query_limit, materialized,
              table_name
          ],
      )

  def update_progress(
      self,
      query_uuid: str,
      processed_traces: int,
      processed_rows: int,
  ) -> None:
    """Hot path: called from worker threads after every merge.

        Kept narrow so the lock is held for microseconds.
        """
    with self._lock:
      self._conn.execute(
          """
                UPDATE query_executions
                   SET processed_traces = ?, processed_rows = ?
                 WHERE query_uuid = ?
                """,
          [processed_traces, processed_rows, query_uuid],
      )

  def update_total_traces(self, query_uuid: str, total: int) -> None:
    with self._lock:
      self._conn.execute(
          'UPDATE query_executions SET total_traces = ? '
          'WHERE query_uuid = ?',
          [total, query_uuid],
      )

  def mark_success(
      self,
      query_uuid: str,
      processed_rows: Optional[int] = None,
  ) -> bool:
    """Terminal SUCCESS, **only if currently IN_PROGRESS**.

        Returns True if the transition applied. The conditional WHERE
        prevents the natural-completion path from clobbering a CANCELLED
        that landed concurrently (e.g. cancel handler ran while
        `_run_async_query` was settling its terminal state).

        `processed_rows` is optional: when omitted, the column is left
        as-is. Sync queries finish without per-row backend tracking
        (results aren't materialized, so processed_rows stays at 0
        from the initial insert) and pass `None`. Async queries pass
        the count from the live snapshot so the terminal row reflects
        the final state.
        """
    with self._lock:
      if processed_rows is None:
        return self._update_if_in_progress_locked(
            query_uuid,
            """
                    UPDATE query_executions
                       SET status = 'SUCCESS',
                           end_time = ?
                     WHERE query_uuid = ? AND status = 'IN_PROGRESS'
                    """,
            [utcnow(), query_uuid],
        )
      return self._update_if_in_progress_locked(
          query_uuid,
          """
                UPDATE query_executions
                   SET status = 'SUCCESS',
                       end_time = ?,
                       processed_rows = ?
                 WHERE query_uuid = ? AND status = 'IN_PROGRESS'
                """,
          [utcnow(), processed_rows, query_uuid],
      )

  def mark_failed(self, query_uuid: str, error_message: str) -> bool:
    """Terminal FAILED, **only if currently IN_PROGRESS**.

        Returns True if the transition applied. Clears `table_name`
        (no fetchable result) and drops any partial table that the
        worker thread may have created before the failure.
        """
    with self._lock:
      applied = self._update_if_in_progress_locked(
          query_uuid,
          """
                UPDATE query_executions
                   SET status = 'FAILED',
                       end_time = ?,
                       error_message = ?,
                       table_name = NULL
                 WHERE query_uuid = ? AND status = 'IN_PROGRESS'
                """,
          [utcnow(), error_message, query_uuid],
      )
      if applied:
        self._drop_materialized_locked(query_uuid)
      return applied

  def _update_if_in_progress_locked(
      self,
      query_uuid: str,
      sql: str,
      params: list[Any],
  ) -> bool:
    """Caller must hold `self._lock`.

        Runs `sql` (which must include `WHERE status = 'IN_PROGRESS'`)
        and returns True if it actually applied. DuckDB's Python API
        doesn't expose `rowcount`, so we re-read the status after the
        UPDATE: if it changed away from IN_PROGRESS, the update applied
        (or was raced and we're irrelevant either way).
        """
    before = self._conn.execute(
        'SELECT status FROM query_executions WHERE query_uuid = ?',
        [query_uuid],
    ).fetchone()
    if before is None or before[0] != 'IN_PROGRESS':
      return False
    self._conn.execute(sql, params)
    return True

  def mark_cancelled(
      self,
      query_uuid: str,
      processed_rows: int,
      clear_table: bool,
  ) -> None:
    """Terminal CANCELLED.

        If `clear_table` (no rows merged), drops the materialized table
        and nulls table_name. Otherwise the table stays and the user can
        fetch the partials.
        """
    with self._lock:
      if clear_table:
        self._conn.execute(
            """
                    UPDATE query_executions
                       SET status = 'CANCELLED',
                           end_time = ?,
                           processed_rows = ?,
                           table_name = NULL
                     WHERE query_uuid = ?
                    """,
            [utcnow(), processed_rows, query_uuid],
        )
        self._drop_materialized_locked(query_uuid)
      else:
        self._conn.execute(
            """
                    UPDATE query_executions
                       SET status = 'CANCELLED',
                           end_time = ?,
                           processed_rows = ?
                     WHERE query_uuid = ?
                    """,
            [utcnow(), processed_rows, query_uuid],
        )

  def soft_delete(self, query_uuid: str) -> bool:
    """Flip deleted=TRUE. Returns True if a row was changed.

        Drops the materialized table immediately to save disk; the
        metadata row remains for audit. Re-deleting an already-deleted
        row is a no-op and returns False (the WHERE clause filters it
        out, RETURNING yields no rows, the caller can 404).
        """
    with self._lock:
      row = self._conn.execute(
          """
                UPDATE query_executions
                   SET deleted = TRUE, table_name = NULL
                 WHERE query_uuid = ? AND deleted = FALSE
                 RETURNING 1
                """,
          [query_uuid],
      ).fetchone()
      if row is None:
        return False
      self._drop_materialized_locked(query_uuid)
      return True

  def _drop_materialized_locked(self, query_uuid: str) -> None:
    # Must be called with self._lock already held.
    try:
      self._conn.execute(f'DROP TABLE IF EXISTS {safe_table_id(query_uuid)}')
    except duckdb.Error as e:
      log.warning(
          'failed to drop materialized table for %s: %s',
          query_uuid,
          e,
      )

  # ------------------------------------------------------------------
  # query_executions: reads
  # ------------------------------------------------------------------

  def get_status(self, query_uuid: str) -> Optional[str]:
    """Return just the current status string (or None if missing).

        Hot path for worker threads polling for cancellation: cheaper
        than `get_qe` because we only project one column. Soft-deleted
        rows return None — callers treat them as gone, same as missing.
        """
    with self._lock:
      row = self._conn.execute(
          """
                SELECT status FROM query_executions
                 WHERE query_uuid = ? AND deleted = FALSE
                """,
          [query_uuid],
      ).fetchone()
    return row[0] if row else None

  def get_qe(self, query_uuid: str) -> Optional[QESnapshot]:
    """Return a snapshot. None if not found OR soft-deleted.

        Soft-deleted rows are treated as gone for handler purposes —
        callers 404. The internal hard state of the row stays in the DB.
        """
    with self._lock:
      row = self._conn.execute(
          """
                SELECT query_uuid, status, start_time, end_time,
                       perfetto_sql, query_limit, materialized, table_name,
                       processed_traces, total_traces, processed_rows,
                       error_message
                  FROM query_executions
                 WHERE query_uuid = ? AND deleted = FALSE
                """,
          [query_uuid],
      ).fetchone()
    if row is None:
      return None
    return QESnapshot(
        query_uuid=row[0],
        status=row[1],
        start_time=_ts_to_iso(row[2]) or '',
        end_time=_ts_to_iso(row[3]),
        perfetto_sql=row[4] or '',
        query_limit=row[5] or 0,
        materialized=bool(row[6]),
        table_name=row[7],
        processed_traces=row[8],
        total_traces=row[9],
        processed_rows=row[10],
        error_message=row[11],
    )

  def list_qes(self) -> list[QESnapshot]:
    """All non-deleted executions, newest first."""
    with self._lock:
      rows = self._conn.execute(
          """
                SELECT query_uuid, status, start_time, end_time,
                       perfetto_sql, query_limit, materialized, table_name,
                       processed_traces, total_traces, processed_rows,
                       error_message
                  FROM query_executions
                 WHERE deleted = FALSE
                 ORDER BY start_time DESC
                """,).fetchall()
    return [
        QESnapshot(
            query_uuid=r[0],
            status=r[1],
            start_time=_ts_to_iso(r[2]) or '',
            end_time=_ts_to_iso(r[3]),
            perfetto_sql=r[4] or '',
            query_limit=r[5] or 0,
            materialized=bool(r[6]),
            table_name=r[7],
            processed_traces=r[8],
            total_traces=r[9],
            processed_rows=r[10],
            error_message=r[11],
        ) for r in rows
    ]

  # ------------------------------------------------------------------
  # Materialized tables: writes
  # ------------------------------------------------------------------

  def merge_trace_atomic(
      self,
      query_uuid: str,
      trace_id: str,
      user_columns: list[str],
      sample_row: list[Any],
      prefixed_rows: list[list[Any]],
      global_limit: int,
  ) -> tuple[str, int, int]:
    """Atomically merge one trace's rows into the materialized table.

        This is the worker thread's single hot-path call — it bundles
        the cancel-check, table creation (lazy on first merge), bulk
        insert, global-cap truncation, and the `processed_traces` /
        `processed_rows` bumps under a single `_DB_LOCK` acquisition.
        That makes the "no rows after :cancel returns 200" guarantee
        process-correct without any in-memory cancellation flag: a
        subsequent worker that takes the lock after the cancel
        handler released it observes the new status and bails.

        Inputs:
        - `prefixed_rows`: each row already has `trace_id` as element 0.
          The caller built these outside the lock for speed.
        - `user_columns`: SQL column names without the `trace_id` prefix,
          used for table creation and column-mismatch detection.
        - `sample_row`: one user row (no `trace_id`) used purely to
          infer column types when creating the table.
        - `global_limit`: 0 = no cap; otherwise truncates inserts so
          total rows never exceed this value.

        Returns `(outcome, new_processed_traces, new_processed_rows)`:
        - `'merged'` — rows inserted (possibly truncated to fit cap).
        - `'col_mismatch'` — table exists with different columns;
          rows dropped, traces counter still bumped.
        - `'skipped'` — query is no longer IN_PROGRESS (cancelled,
          completed, or soft-deleted). Caller should bail without
          retrying.
        - `'not_found'` — query_uuid not in the table at all.

        For `'skipped'` and `'not_found'` the returned counts are 0;
        the row-count is informational only at that point.
        """
    tbl = safe_table_id(query_uuid)
    col_types = _infer_column_types(sample_row)
    with self._lock:
      row = self._conn.execute(
          """
                SELECT status, processed_traces, processed_rows
                  FROM query_executions
                 WHERE query_uuid = ? AND deleted = FALSE
                """,
          [query_uuid],
      ).fetchone()
      if row is None:
        return 'not_found', 0, 0
      if row[0] != 'IN_PROGRESS':
        return 'skipped', 0, 0
      cur_traces, cur_rows = row[1], row[2]

      # Lazy table creation. Subsequent merges check column
      # compatibility against the existing table schema.
      existing_table = self._conn.execute(
          """
                SELECT 1 FROM information_schema.tables
                 WHERE table_name = ? LIMIT 1
                """,
          [tbl],
      ).fetchone() is not None
      if not existing_table:
        col_decls = ', '.join(
            f'"{n}" {t}' for n, t in zip(user_columns, col_types))
        self._conn.execute(
            f'CREATE TABLE {tbl} (trace_id VARCHAR, {col_decls})')
      else:
        # Compare existing schema (skip trace_id at position 0).
        existing_cols = [
            r[0] for r in self._conn.execute(
                """
                        SELECT column_name FROM information_schema.columns
                         WHERE table_name = ?
                         ORDER BY ordinal_position
                        """,
                [tbl],
            ).fetchall()
        ]
        if existing_cols[1:] != list(user_columns):
          new_traces = cur_traces + 1
          self._conn.execute(
              'UPDATE query_executions SET processed_traces = ? '
              'WHERE query_uuid = ?',
              [new_traces, query_uuid],
          )
          return 'col_mismatch', new_traces, cur_rows

      # Apply the global cap. With cap=L and row-count R, accept
      # at most (L - R) more rows from this trace.
      if global_limit > 0:
        room = global_limit - cur_rows
        rows_to_insert = (prefixed_rows[:room] if room > 0 else [])
      else:
        rows_to_insert = prefixed_rows

      if rows_to_insert:
        # Arrow fast-path bulk insert: 1M rows in ~0.5s vs
        # ~10min via executemany(). DuckDB casts each Arrow
        # column to the destination column type. Names are
        # placeholders — insert_into binds positionally.
        n_cols = len(rows_to_insert[0])
        cols_data = list(zip(*rows_to_insert))
        arr = pa.table({f'c{i}': list(cols_data[i]) for i in range(n_cols)})
        self._conn.from_arrow(arr).insert_into(tbl)

      new_traces = cur_traces + 1
      new_rows = cur_rows + len(rows_to_insert)
      self._conn.execute(
          """
                UPDATE query_executions
                   SET processed_traces = ?, processed_rows = ?
                 WHERE query_uuid = ?
                """,
          [new_traces, new_rows, query_uuid],
      )
      return 'merged', new_traces, new_rows

  # ------------------------------------------------------------------
  # Materialized tables: reads
  # ------------------------------------------------------------------

  def fetch_paginated(
      self,
      query_uuid: str,
      limit: int,
      offset: int,
      order_by: str = '',
      filter_str: str = '',
  ) -> tuple[list[str], list[list[Any]], int]:
    """Return (column_names, rows[offset:offset+limit], total_filtered).

        Caller is responsible for the precondition checks (entry
        exists, materialized=true, etc.) — this method only reads
        rows. If the materialized table genuinely doesn't exist in
        DuckDB (e.g., a TTL race or out-of-band drop),
        `duckdb.CatalogException` propagates so the handler can map
        it to NOT_FOUND.

        `order_by` is an AIP-132 ordering string ("name desc, dur asc").
        Empty / absent → no ORDER BY (insertion order).

        `filter_str` is a JSON-encoded `Filter[]`. Empty / absent →
        no `WHERE`. Multi-entry arrays are AND'd. See `parse_filter`
        for the wire shape and `compile_where` for the SQL rules.

        Both `order_by` fields and `filter_str` fields are validated
        against the live table schema; unknown columns raise
        `ValueError`. Identifiers are double-quoted in the generated
        SQL so user column names that collide with DuckDB keywords
        or contain special characters work correctly. Filter values
        are bound via DuckDB's `?` parameter so user-supplied bytes
        never land in the SQL string.

        The third return value is the total count of rows matching
        `filter_str` (or the full materialized table when no filter
        is set). Computed under the same lock acquisition as the
        page fetch so the count and the rows always reflect the same
        snapshot — important because TTL sweeps can drop the table
        out from under us between independent calls. The UI uses
        this value to size the DataGrid's virtual scrollbar over the
        filtered set; cheap on DuckDB's column store, so we always
        emit it (no caller has to opt in or branch on its absence).
        """
    # Lexical parse first — fails fast on bad syntax without
    # touching the DB or holding the lock.
    parsed_order = parse_order_by(order_by)
    parsed_filter = parse_filter(filter_str)
    tbl = safe_table_id(query_uuid)
    with self._lock:
      # Resolve the table's columns up-front. Empty result =
      # table doesn't exist — surface that as a CatalogException
      # rather than a misleading "unknown column" from the
      # order_by/filter validators below.
      cols_res = self._conn.execute(
          """
                SELECT column_name FROM information_schema.columns
                 WHERE table_name = ?
                """,
          [tbl],
      ).fetchall()
      if not cols_res:
        raise duckdb.CatalogException(
            f'materialized table {tbl} does not exist')
      allowed = {r[0] for r in cols_res}
      if parsed_order:
        for field, _ in parsed_order:
          if field not in allowed:
            raise ValueError(f'unknown order_by column {field!r}; '
                             f'available: {sorted(allowed)}')
        order_clause = ', '.join(f'"{f}" {d}' for f, d in parsed_order)
      else:
        order_clause = ''
      where_frag, where_params = compile_where(parsed_filter, allowed)
      # Page fetch: SELECT * [WHERE] [ORDER BY] LIMIT ? OFFSET ?
      page_parts = [f'SELECT * FROM {tbl}']
      if where_frag:
        page_parts.append(f'WHERE {where_frag}')
      if order_clause:
        page_parts.append(f'ORDER BY {order_clause}')
      page_parts.append('LIMIT ? OFFSET ?')
      page_sql = ' '.join(page_parts)
      cur = self._conn.execute(page_sql, where_params + [limit, offset])
      cols = [d[0] for d in cur.description]
      rows = cur.fetchall()
      # Total count under the same lock: SELECT COUNT(*) [WHERE].
      # Sharing the lock keeps the count consistent with the rows
      # we just returned — without it, a TTL sweep between two
      # independent calls could yield rows-but-no-count or vice versa.
      count_sql = f'SELECT COUNT(*) FROM {tbl}'
      if where_frag:
        count_sql += f' WHERE {where_frag}'
      count_row = self._conn.execute(count_sql, where_params).fetchone()
      total_filtered = int(count_row[0]) if count_row else 0
    return cols, [list(r) for r in rows], total_filtered

  # ------------------------------------------------------------------
  # Startup recovery + TTL sweep
  # ------------------------------------------------------------------

  def recover_stale_in_progress(self) -> int:
    """At startup, mark any IN_PROGRESS rows as FAILED.

        Their workers are gone (process died); we don't want them stuck
        in the IN_PROGRESS state forever. Returns the count.
        """
    with self._lock:
      uuids = [
          r[0] for r in self._conn.execute(
              "SELECT query_uuid FROM query_executions "
              "WHERE status = 'IN_PROGRESS'",).fetchall()
      ]
      if not uuids:
        return 0
      self._conn.execute(
          """
                UPDATE query_executions
                   SET status = 'FAILED',
                       end_time = ?,
                       error_message = 'Server restarted before query completed',
                       table_name = NULL
                 WHERE status = 'IN_PROGRESS'
                """,
          [utcnow()],
      )
      for u in uuids:
        self._drop_materialized_locked(u)
    return len(uuids)

  def expire_terminal_tables(self, ttl_seconds: int) -> int:
    """Drop materialized tables for terminal queries past their TTL.

        Doesn't touch the metadata rows — only clears the row-buffer
        side. Returns how many were swept.
        """
    with self._lock:
      # Compare end_time against UTC-now using the same Python
      # helper that writes the column, so TZ stays consistent
      # (DuckDB's CURRENT_TIMESTAMP would compare against local).
      cutoff = utcnow() - timedelta(seconds=ttl_seconds)
      uuids = [
          r[0] for r in self._conn.execute(
              """
                    SELECT query_uuid
                      FROM query_executions
                     WHERE table_name IS NOT NULL
                       AND status != 'IN_PROGRESS'
                       AND end_time IS NOT NULL
                       AND end_time < ?
                    """,
              [cutoff],
          ).fetchall()
      ]
      if not uuids:
        return 0
      for u in uuids:
        self._conn.execute(
            'UPDATE query_executions SET table_name = NULL '
            'WHERE query_uuid = ?',
            [u],
        )
        self._drop_materialized_locked(u)
    return len(uuids)

  # ------------------------------------------------------------------
  # Optional in-process DuckDB web UI
  # ------------------------------------------------------------------

  def start_db_ui(self, port: int) -> None:
    """Install + load the `ui` extension and start it on `port`.

        Runs on the server's own connection so there's no file-lock
        contention with external `duckdb -ui` processes. The UI's
        internal HTTP server lives for the lifetime of the connection;
        we don't have to manage it explicitly.

        First call may download the extension (~few MB). Subsequent
        calls reuse the cached extension. Errors are logged but do not
        abort server startup — the UI is a debug convenience.
        """
    with self._lock:
      try:
        self._conn.execute('INSTALL ui')
        self._conn.execute('LOAD ui')
        self._conn.execute('SET ui_local_port = ?', [port])
        self._conn.execute('CALL start_ui_server()')
        log.info(
            'DuckDB UI started: http://localhost:%d',
            port,
        )
      except duckdb.Error as e:
        log.warning('Failed to start DuckDB UI: %s', e)

  # ------------------------------------------------------------------
  # Lifecycle
  # ------------------------------------------------------------------

  def close(self) -> None:
    with self._lock:
      self._conn.close()
