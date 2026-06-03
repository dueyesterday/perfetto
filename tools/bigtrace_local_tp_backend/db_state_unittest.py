# Copyright (C) 2026 The Android Open Source Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""Unit tests for `Database`'s state-machine transitions.

The conditional `mark_success` / `mark_failed` / `mark_cancelled`
calls are the load-bearing invariant for the cancel protocol: a
natural-completion path must NOT clobber a CANCELLED status that
landed concurrently. This file pins those transitions so a future
refactor of the SQL can't regress them silently.

Uses a real DuckDB file in a temp dir — no mocks. Each test gets a
fresh DB so they're fully isolated and parallel-safe.

Run:
    .venv/bin/python -m unittest db_state_unittest -v
"""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest

from db import Database


class _DbCase(unittest.TestCase):
  """Base: spin up a fresh Database in a temp dir per test."""

  def setUp(self):
    self._tmp = tempfile.mkdtemp(prefix='db_state_unittest_')
    self.db = Database(os.path.join(self._tmp, 'state.duckdb'))

  def tearDown(self):
    self.db.close()
    shutil.rmtree(self._tmp, ignore_errors=True)


class TimingTest(_DbCase):
  """Wire-level timing contract: `start_time` and `end_time` are
    captured at distinct wall-clock moments. CUJS.md §N3 — for
    non-instant queries the two must differ so the UI's history
    list shows a real duration. ms-precision pinning lives in
    db_unittest.py:TsToIsoTest; these tests exercise the live
    insert + mark_success path."""

  def test_end_time_differs_from_start_time_after_real_work(self):
    import time
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    snap_before = self.db.get_qe('u1')
    assert snap_before is not None
    # Sleep past one millisecond so the wire format (ms-precision
    # `_ts_to_iso`) shows distinct values. utcnow() resolves to
    # microseconds; mark_success calls it again on the way out.
    time.sleep(0.005)
    self.db.mark_success('u1', processed_rows=5)
    snap_after = self.db.get_qe('u1')
    assert snap_after is not None
    self.assertEqual(snap_after.start_time, snap_before.start_time)
    self.assertIsNotNone(snap_after.end_time)
    self.assertNotEqual(snap_after.start_time, snap_after.end_time)
    self.assertGreater(snap_after.end_time, snap_after.start_time)

  def test_explicit_start_time_is_preserved(self):
    # Sync handler captures wall-clock at the start of the request
    # so the recorded duration matches what the user observed.
    # That hinges on insert_qe_in_progress honoring the explicit
    # start_time arg rather than always calling utcnow() itself.
    from datetime import datetime
    explicit = datetime(2026, 5, 10, 12, 0, 0, 123_000)
    self.db.insert_qe_in_progress(
        'u1',
        'SELECT 1',
        query_limit=10,
        materialized=True,
        start_time=explicit,
    )
    snap = self.db.get_qe('u1')
    assert snap is not None
    # Wire format with ms precision matches what we asked for.
    self.assertEqual(snap.start_time, '2026-05-10T12:00:00.123Z')


class ConstructorTest(unittest.TestCase):
  """`Database(path)` constructs without auxiliary fixture setup —
    these tests don't extend _DbCase. Cover the path-handling
    edge cases so a future refactor can't regress them."""

  def test_creates_missing_parent_directory(self):
    # Common case: --db-path points at a path whose parent doesn't
    # exist yet (first run on a clean machine). Constructor must
    # mkdir -p.
    tmp = tempfile.mkdtemp(prefix='db_ctor_unittest_')
    try:
      nested = os.path.join(tmp, 'a', 'b', 'c', 'state.duckdb')
      db = Database(nested)
      try:
        self.assertTrue(os.path.exists(os.path.dirname(nested)))
        self.assertTrue(os.path.exists(nested))
      finally:
        db.close()
    finally:
      shutil.rmtree(tmp, ignore_errors=True)

  def test_relative_filename_with_no_parent_dir_works(self):
    # Edge case: --db-path is a bare filename like `state.duckdb`.
    # `os.path.dirname` returns '' and `os.makedirs('', ...)` raises
    # FileNotFoundError. Constructor guards against that so the
    # user gets a working DB rather than an unhelpful crash before
    # they can see if their path is even usable.
    tmp = tempfile.mkdtemp(prefix='db_ctor_unittest_')
    prev = os.getcwd()
    os.chdir(tmp)
    try:
      db = Database('state.duckdb')
      try:
        self.assertTrue(os.path.exists(os.path.join(tmp, 'state.duckdb')))
      finally:
        db.close()
    finally:
      os.chdir(prev)
      shutil.rmtree(tmp, ignore_errors=True)

  def test_existing_parent_is_idempotent(self):
    # mkdir -p must be a no-op when the parent already exists.
    tmp = tempfile.mkdtemp(prefix='db_ctor_unittest_')
    try:
      path = os.path.join(tmp, 'state.duckdb')
      db1 = Database(path)
      db1.close()
      # Re-open in the same dir — parent already there. Mustn't fail.
      db2 = Database(path)
      db2.close()
    finally:
      shutil.rmtree(tmp, ignore_errors=True)


class InsertAndReadTest(_DbCase):
  """`insert_qe_in_progress` + `get_qe` round-trip basics."""

  def test_inserted_row_has_in_progress_status(self):
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    snap = self.db.get_qe('u1')
    self.assertIsNotNone(snap)
    assert snap is not None  # narrow for type checker
    self.assertEqual(snap.status, 'IN_PROGRESS')
    self.assertEqual(snap.perfetto_sql, 'SELECT 1')
    self.assertEqual(snap.query_limit, 10)
    self.assertTrue(snap.materialized)
    self.assertEqual(snap.processed_rows, 0)
    self.assertEqual(snap.processed_traces, 0)

  def test_materialized_true_sets_table_name(self):
    # A materialized query gets its tableName at insert time so the
    # wire shape can carry it from the moment of submission.
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    snap = self.db.get_qe('u1')
    assert snap is not None
    self.assertIsNotNone(snap.table_name)
    self.assertTrue(snap.table_name.startswith('bigtrace_'))

  def test_materialized_false_leaves_table_name_null(self):
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=False)
    snap = self.db.get_qe('u1')
    assert snap is not None
    self.assertIsNone(snap.table_name)

  def test_get_qe_returns_none_for_missing(self):
    self.assertIsNone(self.db.get_qe('does-not-exist'))


class SnapshotRoundTripTest(_DbCase):
  """`insert_qe_in_progress` + `get_qe` round-trip the submit-time
    snapshot fields. These power the per-tab Bigtrace Settings sub-tab
    on /query — the UI rehydrates from `/query_executions/{uuid}` to
    show what each historical query ran with.

    `trace_filters` is stored as a JSON-encoded string (the DB layer
    only sees this storage form — `server.py` converts to/from the
    wire's native `Filter[]` array per the strict-native body
    contract, WIRE_SPEC.md §10.1, §12.1). Round-trips byte-for-byte
    through storage; empty / NULL reads back as `""`. `settings` and
    `trace_metadata_columns` are JSON-encoded lists; empty / NULL
    reads back as `[]`. `trace_order_by` is a raw wire string; empty
    / NULL reads back as `""`."""

  def test_full_snapshot_round_trips(self):
    settings = [{
        'setting_id': 'trace_directory',
        'values': ['/tmp/trace_metadata'],
        'category': 'TRACE_ADDRESS',
    }]
    trace_filter = ('[{"field":"file_name","op":"glob","value":"*.pftrace"}]')
    trace_metadata_columns = ['file_name', 'size_bytes']
    self.db.insert_qe_in_progress(
        'u1',
        'SELECT 1',
        query_limit=10,
        materialized=True,
        settings=settings,
        trace_filter=trace_filter,
        trace_metadata_columns=trace_metadata_columns,
        trace_order_by='size_bytes desc')
    snap = self.db.get_qe('u1')
    assert snap is not None
    self.assertEqual(snap.settings, settings)
    # Wire string round-trips byte-for-byte.
    self.assertEqual(snap.trace_filter, trace_filter)
    self.assertEqual(snap.trace_metadata_columns, trace_metadata_columns)
    self.assertEqual(snap.trace_order_by, 'size_bytes desc')

  def test_omitted_snapshot_reads_back_as_defaults(self):
    # Pre-feature row OR client that didn't opt in — list-typed
    # fields read as `[]`, string-typed fields read as `""`. The UI
    # renders this as "no filter / no extra metadata" uniformly.
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    snap = self.db.get_qe('u1')
    assert snap is not None
    self.assertEqual(snap.settings, [])
    # trace_filter is now a string — empty for omitted.
    self.assertEqual(snap.trace_filter, '')
    self.assertEqual(snap.trace_metadata_columns, [])
    self.assertEqual(snap.trace_order_by, '')

  def test_explicit_empty_lists_become_null_then_empty(self):
    # Explicit empties on submit are semantically identical to
    # "absent". The persistence layer stores NULL (avoiding a `'[]'`
    # / `'""'` literal in the column for the common case); the read
    # normalizes back.
    self.db.insert_qe_in_progress(
        'u1',
        'SELECT 1',
        query_limit=10,
        materialized=True,
        settings=[],
        trace_filter='',
        trace_metadata_columns=[],
        trace_order_by='')
    snap = self.db.get_qe('u1')
    assert snap is not None
    self.assertEqual(snap.settings, [])
    self.assertEqual(snap.trace_filter, '')
    self.assertEqual(snap.trace_metadata_columns, [])
    self.assertEqual(snap.trace_order_by, '')

  def test_snapshot_survives_state_transitions(self):
    # Snapshot is frozen at submit. mark_success / mark_failed /
    # mark_cancelled don't touch it — important so the UI can keep
    # showing the historical context after the query has terminated.
    f = '[{"field":"file_name","op":"=","value":"a.pftrace"}]'
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True, trace_filter=f)
    self.db.mark_success('u1', processed_rows=5)
    snap = self.db.get_qe('u1')
    assert snap is not None
    self.assertEqual(snap.status, 'SUCCESS')
    self.assertEqual(snap.trace_filter, f)

  def test_snapshot_persists_even_on_failure(self):
    # A query that fails at submit-validation still records what
    # was attempted — the UI surfaces "this filter is broken" with
    # the actual offending value, not an empty placeholder.
    f = '[{"field":"unknown_col","op":"=","value":"x"}]'
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True, trace_filter=f)
    self.db.mark_failed('u1', 'unknown filter column')
    snap = self.db.get_qe('u1')
    assert snap is not None
    self.assertEqual(snap.status, 'FAILED')
    self.assertEqual(snap.trace_filter, f)

  def test_migration_adds_columns_to_legacy_table(self):
    # Simulate a DB created before the snapshot columns existed:
    # hand-build the pre-snapshot schema in a fresh file, populate
    # one row, then open it via `Database` and confirm
    # `_init_schema`'s ALTER TABLE ADD COLUMN IF NOT EXISTS adds
    # the three new columns. Existing rows read back with empty
    # snapshot defaults.
    self.db.close()
    legacy_path = os.path.join(self._tmp, 'legacy.duckdb')
    import duckdb
    con = duckdb.connect(legacy_path)
    # Pre-snapshot schema: matches what `_init_schema` used to
    # write before this feature, minus settings / trace_filter /
    # trace_metadata_columns.
    con.execute("""
        CREATE TABLE query_executions (
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
        )""")
    con.execute("INSERT INTO query_executions "
                "(query_uuid, status, materialized, perfetto_sql, query_limit) "
                "VALUES ('u_legacy', 'SUCCESS', TRUE, 'SELECT 1', 10)")
    con.close()

    # Re-open via `Database` — `_init_schema` should add the three
    # snapshot columns via ALTER TABLE ADD COLUMN IF NOT EXISTS.
    self.db = Database(legacy_path)
    snap = self.db.get_qe('u_legacy')
    assert snap is not None
    self.assertEqual(snap.settings, [])
    # trace_filter is now a string — empty for legacy rows.
    self.assertEqual(snap.trace_filter, '')
    self.assertEqual(snap.trace_metadata_columns, [])
    # And new inserts can populate them normally.
    f_string = '[{"field":"file_name","op":"=","value":"x.pftrace"}]'
    self.db.insert_qe_in_progress(
        'u_new',
        'SELECT 2',
        query_limit=20,
        materialized=True,
        trace_filter=f_string)
    snap_new = self.db.get_qe('u_new')
    assert snap_new is not None
    self.assertEqual(snap_new.trace_filter, f_string)


class ConditionalTransitionTest(_DbCase):
  """The cancel protocol's load-bearing invariant: `mark_success`
    and `mark_failed` apply ONLY when status is still IN_PROGRESS.
    Without this, a natural-completion landing after a concurrent
    cancel would silently overwrite the CANCELLED status."""

  def test_mark_success_on_in_progress_applies(self):
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    applied = self.db.mark_success('u1', processed_rows=42)
    self.assertTrue(applied)
    snap = self.db.get_qe('u1')
    assert snap is not None
    self.assertEqual(snap.status, 'SUCCESS')
    self.assertEqual(snap.processed_rows, 42)

  def test_mark_failed_on_in_progress_applies(self):
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    applied = self.db.mark_failed('u1', 'no such table')
    self.assertTrue(applied)
    snap = self.db.get_qe('u1')
    assert snap is not None
    self.assertEqual(snap.status, 'FAILED')
    self.assertEqual(snap.error_message, 'no such table')
    # mark_failed clears tableName and drops the table.
    self.assertIsNone(snap.table_name)

  def test_mark_success_after_cancelled_is_noop(self):
    # Workflow: IN_PROGRESS → cancel handler flips to CANCELLED →
    # background `_run_async_query` settles and tries mark_success.
    # The conditional UPDATE must refuse so the CANCELLED status
    # survives.
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    self.db.mark_cancelled('u1', processed_rows=0, clear_table=True)
    # Now mark_success is called by the natural-completion path.
    applied = self.db.mark_success('u1', processed_rows=99)
    self.assertFalse(applied)
    snap = self.db.get_qe('u1')
    assert snap is not None
    # Status stays CANCELLED, processed_rows stays 0 (not 99).
    self.assertEqual(snap.status, 'CANCELLED')
    self.assertEqual(snap.processed_rows, 0)

  def test_mark_failed_after_cancelled_is_noop(self):
    # Same invariant from the failure-path side: a worker that hit
    # an error mustn't clobber a CANCELLED status with FAILED.
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    self.db.mark_cancelled('u1', processed_rows=0, clear_table=True)
    applied = self.db.mark_failed('u1', 'race-loser error')
    self.assertFalse(applied)
    snap = self.db.get_qe('u1')
    assert snap is not None
    self.assertEqual(snap.status, 'CANCELLED')
    # error_message must NOT have been overwritten.
    self.assertIsNone(snap.error_message)

  def test_mark_success_after_success_is_noop(self):
    # Defensive: a double-mark (rare but possible if a worker
    # retries) should be idempotent, not overwrite end_time.
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    self.db.mark_success('u1', processed_rows=42)
    snap1 = self.db.get_qe('u1')
    assert snap1 is not None
    end_time1 = snap1.end_time
    applied = self.db.mark_success('u1', processed_rows=99)
    self.assertFalse(applied)
    snap2 = self.db.get_qe('u1')
    assert snap2 is not None
    self.assertEqual(snap2.processed_rows, 42)  # not 99
    self.assertEqual(snap2.end_time, end_time1)  # not bumped

  def test_mark_returns_false_for_missing_uuid(self):
    self.assertFalse(self.db.mark_success('does-not-exist'))
    self.assertFalse(self.db.mark_failed('does-not-exist', 'err'))


class CancelTest(_DbCase):
  """`mark_cancelled` is unconditional (the cancel handler always
    wins) but has nuanced clear_table behaviour."""

  def test_cancel_with_clear_table_nulls_table_name(self):
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    self.db.mark_cancelled('u1', processed_rows=0, clear_table=True)
    snap = self.db.get_qe('u1')
    assert snap is not None
    self.assertEqual(snap.status, 'CANCELLED')
    self.assertIsNone(snap.table_name)

  def test_cancel_without_clear_table_preserves_table_name(self):
    # User cancels mid-merge after some rows landed — keep them
    # fetchable. tableName stays so :fetch_results works.
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    snap_before = self.db.get_qe('u1')
    assert snap_before is not None
    table_name_before = snap_before.table_name
    self.db.mark_cancelled('u1', processed_rows=42, clear_table=False)
    snap = self.db.get_qe('u1')
    assert snap is not None
    self.assertEqual(snap.status, 'CANCELLED')
    self.assertEqual(snap.table_name, table_name_before)
    self.assertEqual(snap.processed_rows, 42)


class SoftDeleteTest(_DbCase):
  """`soft_delete` flips `deleted=TRUE`. Reads return None so
    handlers can 404 uniformly. List queries filter the row out."""

  def test_soft_deleted_get_returns_none(self):
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    self.db.mark_success('u1', processed_rows=5)
    self.assertTrue(self.db.soft_delete('u1'))
    self.assertIsNone(self.db.get_qe('u1'))

  def test_soft_deleted_list_excludes_row(self):
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    self.db.insert_qe_in_progress(
        'u2', 'SELECT 2', query_limit=10, materialized=True)
    self.db.mark_success('u1', processed_rows=5)
    self.db.mark_success('u2', processed_rows=5)
    self.db.soft_delete('u1')
    uuids = {s.query_uuid for s in self.db.list_qes()}
    self.assertNotIn('u1', uuids)
    self.assertIn('u2', uuids)

  def test_double_soft_delete_returns_false(self):
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    self.db.mark_success('u1', processed_rows=5)
    self.assertTrue(self.db.soft_delete('u1'))
    self.assertFalse(self.db.soft_delete('u1'))

  def test_soft_delete_missing_returns_false(self):
    self.assertFalse(self.db.soft_delete('does-not-exist'))


class ListQesTest(_DbCase):
  """`list_qes` returns non-deleted rows newest-first."""

  def test_empty_db_returns_empty(self):
    self.assertEqual(self.db.list_qes(), [])

  def test_returns_in_descending_start_time(self):
    # Insert in arbitrary order, expect newest-first in output.
    # `start_time` defaults to utcnow() at insertion, so insertion
    # order = start_time order.
    for u in ('u1', 'u2', 'u3'):
      self.db.insert_qe_in_progress(
          u, 'SELECT 1', query_limit=10, materialized=True)
    snaps = self.db.list_qes()
    self.assertEqual([s.query_uuid for s in snaps], ['u3', 'u2', 'u1'])


class StatusGetTest(_DbCase):
  """`get_status` is the hot-path projection used by worker threads
    to poll for cancellation. Must respect soft-delete."""

  def test_returns_status_for_existing(self):
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    self.assertEqual(self.db.get_status('u1'), 'IN_PROGRESS')
    self.db.mark_success('u1', processed_rows=5)
    self.assertEqual(self.db.get_status('u1'), 'SUCCESS')

  def test_returns_none_for_missing(self):
    self.assertIsNone(self.db.get_status('does-not-exist'))

  def test_returns_none_for_soft_deleted(self):
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    self.db.mark_success('u1', processed_rows=5)
    self.db.soft_delete('u1')
    self.assertIsNone(self.db.get_status('u1'))


class MergeTraceAtomicTest(_DbCase):
  """`merge_trace_atomic` is the cancel-protocol cornerstone: it
    bundles status-check + lazy CREATE TABLE + bulk insert + counter
    bump under one DB-lock acquisition. The `'skipped'` outcome on
    CANCELLED is what guarantees "no rows after :cancel returns 200"."""

  def _seed(self, uuid: str = 'u1') -> str:
    self.db.insert_qe_in_progress(
        uuid, 'SELECT *', query_limit=10, materialized=True)
    return uuid

  def test_first_merge_creates_table_and_returns_merged(self):
    uuid = self._seed()
    outcome, traces, rows = self.db.merge_trace_atomic(
        uuid,
        'trace1',
        ['col_a', 'col_b'],
        [1, 'x'],  # sample row (no trace_id prefix)
        [['trace1', 1, 'x'], ['trace1', 2, 'y']],
        global_limit=0,
    )
    self.assertEqual(outcome, 'merged')
    self.assertEqual(traces, 1)
    self.assertEqual(rows, 2)
    snap = self.db.get_qe(uuid)
    assert snap is not None
    self.assertEqual(snap.processed_traces, 1)
    self.assertEqual(snap.processed_rows, 2)

  def test_merge_on_cancelled_returns_skipped(self):
    # The load-bearing invariant: after the cancel handler flips
    # status to CANCELLED, every subsequent merge must observe the
    # new status and bail before inserting.
    uuid = self._seed()
    self.db.mark_cancelled(uuid, processed_rows=0, clear_table=True)
    outcome, traces, rows = self.db.merge_trace_atomic(
        uuid, 'trace1', ['col_a'], [1], [['trace1', 1]], global_limit=0)
    self.assertEqual(outcome, 'skipped')
    self.assertEqual(traces, 0)
    self.assertEqual(rows, 0)
    snap = self.db.get_qe(uuid)
    assert snap is not None
    # Status preserved; no counter bump.
    self.assertEqual(snap.status, 'CANCELLED')
    self.assertEqual(snap.processed_traces, 0)
    self.assertEqual(snap.processed_rows, 0)

  def test_merge_on_missing_uuid_returns_not_found(self):
    outcome, traces, rows = self.db.merge_trace_atomic(
        'does-not-exist',
        'trace1', ['col_a'], [1], [['trace1', 1]],
        global_limit=0)
    self.assertEqual(outcome, 'not_found')
    self.assertEqual(traces, 0)
    self.assertEqual(rows, 0)

  def test_global_limit_truncates_inserts(self):
    # Cap=3, two merges of 2 rows each → first merges 2, second
    # merges only 1 (room=1 left). Counter bumps still reflect
    # what landed.
    uuid = self._seed()
    self.db.merge_trace_atomic(
        uuid,
        'trace1',
        ['col_a'],
        [1],
        [['trace1', 1], ['trace1', 2]],
        global_limit=3,
    )
    outcome, _traces, rows = self.db.merge_trace_atomic(
        uuid,
        'trace2',
        ['col_a'],
        [3],
        [['trace2', 3], ['trace2', 4]],
        global_limit=3,
    )
    self.assertEqual(outcome, 'merged')
    self.assertEqual(rows, 3)  # Capped at global_limit.
    snap = self.db.get_qe(uuid)
    assert snap is not None
    self.assertEqual(snap.processed_rows, 3)

  def test_global_limit_zero_means_uncapped(self):
    uuid = self._seed()
    big = [['trace1', i] for i in range(50)]
    outcome, _traces, rows = self.db.merge_trace_atomic(
        uuid, 'trace1', ['col_a'], [0], big, global_limit=0)
    self.assertEqual(outcome, 'merged')
    self.assertEqual(rows, 50)

  def test_zero_row_first_merge_creates_table_with_varchar_schema(self):
    # Edge case: first merge has zero rows. The caller (worker
    # thread in query_executor) passes a sample_row of [None]*N
    # (since there's no real row to sample), and `_infer_column_types`
    # falls back to VARCHAR for None. Result: the table is created
    # with all-VARCHAR columns — subsequent inserts of typed values
    # coerce to strings (DuckDB casts on insert). That's known and
    # documented as part of the always-strings sort caveat.
    # Pinning here so a future "tighten the schema inference" can't
    # silently change the behaviour of zero-row-first-merge runs.
    uuid = self._seed()
    outcome, traces, rows = self.db.merge_trace_atomic(
        uuid,
        'trace1',
        ['col_a', 'col_b'],
        [None, None],  # sample row when local_rows was empty
        [],  # zero rows
        global_limit=0,
    )
    self.assertEqual(outcome, 'merged')
    self.assertEqual(traces, 1)
    self.assertEqual(rows, 0)
    # Table was created (subsequent merges can use it). A later
    # merge with the same column names + actual values will cast
    # to VARCHAR on insert — the 'merged' outcome confirms the
    # table exists for this UUID.
    outcome2, traces2, rows2 = self.db.merge_trace_atomic(
        uuid,
        'trace2',
        ['col_a', 'col_b'],
        [42, 'hi'],
        [['trace2', 42, 'hi']],
        global_limit=0,
    )
    self.assertEqual(outcome2, 'merged')
    self.assertEqual(traces2, 2)
    self.assertEqual(rows2, 1)

  def test_column_mismatch_returns_col_mismatch_and_bumps_traces(self):
    # First trace establishes schema [col_a, col_b]. Second trace
    # has different columns — drop its rows, but still count it as
    # processed (so totalTraces math stays consistent).
    uuid = self._seed()
    self.db.merge_trace_atomic(
        uuid,
        'trace1', ['col_a', 'col_b'], [1, 'x'], [['trace1', 1, 'x']],
        global_limit=0)
    outcome, traces, rows = self.db.merge_trace_atomic(
        uuid,
        'trace2', ['totally', 'different'], [1, 'y'], [['trace2', 1, 'y']],
        global_limit=0)
    self.assertEqual(outcome, 'col_mismatch')
    self.assertEqual(traces, 2)  # Still bumps.
    self.assertEqual(rows, 1)  # Same as before — no new rows inserted.
    snap = self.db.get_qe(uuid)
    assert snap is not None
    self.assertEqual(snap.processed_traces, 2)
    self.assertEqual(snap.processed_rows, 1)


class RecoverStaleInProgressTest(_DbCase):
  """Startup recovery: any IN_PROGRESS row left over from a prior
    process (which crashed or was killed) is FAILED'd so it doesn't
    sit in IN_PROGRESS forever."""

  def test_no_stale_rows_returns_zero(self):
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    self.db.mark_success('u1', processed_rows=5)
    # Only terminal rows — recovery should be a no-op.
    self.assertEqual(self.db.recover_stale_in_progress(), 0)
    snap = self.db.get_qe('u1')
    assert snap is not None
    self.assertEqual(snap.status, 'SUCCESS')

  def test_in_progress_row_recovered_as_failed(self):
    # The "process died mid-query" scenario.
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    self.assertEqual(self.db.recover_stale_in_progress(), 1)
    snap = self.db.get_qe('u1')
    assert snap is not None
    self.assertEqual(snap.status, 'FAILED')
    self.assertEqual(snap.error_message,
                     'Server restarted before query completed')
    # tableName cleared (no fetchable result).
    self.assertIsNone(snap.table_name)
    # end_time is set (terminal state).
    self.assertIsNotNone(snap.end_time)

  def test_recovery_only_touches_in_progress(self):
    # Mixed: one IN_PROGRESS, one SUCCESS, one FAILED. Recovery
    # must touch only the IN_PROGRESS one.
    self.db.insert_qe_in_progress(
        'u_run', 'SELECT 1', query_limit=10, materialized=True)
    self.db.insert_qe_in_progress(
        'u_ok', 'SELECT 2', query_limit=10, materialized=True)
    self.db.mark_success('u_ok', processed_rows=5)
    self.db.insert_qe_in_progress(
        'u_err', 'SELECT 3', query_limit=10, materialized=True)
    self.db.mark_failed('u_err', 'original error')
    self.assertEqual(self.db.recover_stale_in_progress(), 1)
    # SUCCESS preserved.
    self.assertEqual(self.db.get_status('u_ok'), 'SUCCESS')
    # Original FAILED's error_message NOT overwritten by recovery.
    snap_err = self.db.get_qe('u_err')
    assert snap_err is not None
    self.assertEqual(snap_err.error_message, 'original error')
    # IN_PROGRESS recovered.
    self.assertEqual(self.db.get_status('u_run'), 'FAILED')


class ExpireTerminalTablesTest(_DbCase):
  """TTL sweep: drops materialized tables for terminal queries past
    their TTL window. Doesn't touch metadata rows — history stays
    visible; only the row buffer goes away."""

  def test_no_expired_tables_returns_zero(self):
    # Seed with one fresh SUCCESS — well within TTL.
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    self.db.mark_success('u1', processed_rows=5)
    # 1 hour TTL — definitely not expired.
    self.assertEqual(self.db.expire_terminal_tables(3600), 0)
    snap = self.db.get_qe('u1')
    assert snap is not None
    # tableName preserved (sweep didn't fire on this row).
    self.assertIsNotNone(snap.table_name)

  def test_expired_terminal_table_dropped(self):
    # Seed a SUCCESS, then immediately sweep with ttl=0 — every
    # terminal row is past its TTL by definition.
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    self.db.mark_success('u1', processed_rows=5)
    self.assertEqual(self.db.expire_terminal_tables(0), 1)
    snap = self.db.get_qe('u1')
    assert snap is not None
    # Metadata row stays so the UI history still shows the entry.
    self.assertEqual(snap.status, 'SUCCESS')
    # tableName nulled — :fetch_results will now 400 with
    # "TTL-expired" detail.
    self.assertIsNone(snap.table_name)

  def test_in_progress_rows_never_expire(self):
    # Even with ttl=0, an IN_PROGRESS row must NOT be swept —
    # its query is still running.
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    self.assertEqual(self.db.expire_terminal_tables(0), 0)
    snap = self.db.get_qe('u1')
    assert snap is not None
    # Both status and tableName preserved.
    self.assertEqual(snap.status, 'IN_PROGRESS')
    self.assertIsNotNone(snap.table_name)

  def test_already_null_table_name_skipped(self):
    # FAILED clears tableName — sweep shouldn't try to drop it
    # (idempotent: the SELECT predicate filters tableName IS NOT NULL).
    self.db.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    self.db.mark_failed('u1', 'boom')
    snap = self.db.get_qe('u1')
    assert snap is not None
    self.assertIsNone(snap.table_name)  # mark_failed cleared it
    # Sweep is a no-op — no candidates (tableName already null).
    self.assertEqual(self.db.expire_terminal_tables(0), 0)


class FetchPaginatedTest(_DbCase):
  """`fetch_paginated` is the read path for materialized result
    tables. Integrates parse_order_by + parse_filter + compile_where
    with the actual DB (column-list resolution, ORDER BY clause,
    WHERE binding, total-count under the same lock as the page).
    Smoke covers it end-to-end through HTTP; these tests localize
    each behaviour to the line of intent."""

  def _seed_table(self, uuid: str = 'u1', n_rows: int = 10) -> None:
    """Create a materialized table with `n_rows` rows.

        Schema: trace_id (VARCHAR, prepended), value (BIGINT),
        name (VARCHAR). Rows are deterministic so tests can assert
        exact orderings.
        """
    self.db.insert_qe_in_progress(
        uuid, 'SELECT *', query_limit=0, materialized=True)
    rows = [['trace1', i, f'name_{i:02d}'] for i in range(n_rows)]
    self.db.merge_trace_atomic(
        uuid,
        'trace1',
        ['value', 'name'],
        [0, 'name_00'],  # sample row
        rows,
        global_limit=0,
    )

  def test_basic_page_fetch(self):
    self._seed_table(n_rows=10)
    cols, rows, total = self.db.fetch_paginated('u1', limit=5, offset=0)
    self.assertEqual(cols, ['trace_id', 'value', 'name'])
    self.assertEqual(len(rows), 5)
    self.assertEqual(total, 10)

  def test_offset_skips_rows(self):
    self._seed_table(n_rows=10)
    _cols, page1, _ = self.db.fetch_paginated('u1', limit=5, offset=0)
    _cols, page2, _ = self.db.fetch_paginated('u1', limit=5, offset=5)
    # Pages are disjoint (no overlap).
    page1_values = {tuple(r) for r in page1}
    page2_values = {tuple(r) for r in page2}
    self.assertEqual(page1_values & page2_values, set())
    # Together they cover the whole table.
    self.assertEqual(len(page1_values | page2_values), 10)

  def test_order_by_ascending(self):
    self._seed_table(n_rows=5)
    _cols, rows, _ = self.db.fetch_paginated(
        'u1', limit=10, offset=0, order_by='value asc')
    values = [r[1] for r in rows]
    self.assertEqual(values, [0, 1, 2, 3, 4])

  def test_order_by_descending(self):
    self._seed_table(n_rows=5)
    _cols, rows, _ = self.db.fetch_paginated(
        'u1', limit=10, offset=0, order_by='value desc')
    values = [r[1] for r in rows]
    self.assertEqual(values, [4, 3, 2, 1, 0])

  def test_order_by_unknown_column_raises_value_error(self):
    self._seed_table()
    # The handler maps ValueError to 400 INVALID_ARGUMENT.
    with self.assertRaises(ValueError) as ctx:
      self.db.fetch_paginated('u1', limit=10, offset=0, order_by='bogus')
    self.assertIn('bogus', str(ctx.exception))

  def test_filter_eq_returns_matching_row(self):
    self._seed_table(n_rows=10)
    filter_str = '[{"field":"value","op":"=","value":"3"}]'
    _cols, rows, total = self.db.fetch_paginated(
        'u1', limit=10, offset=0, filter_str=filter_str)
    self.assertEqual(len(rows), 1)
    self.assertEqual(rows[0][1], 3)
    self.assertEqual(total, 1)  # totalFilteredRows = post-filter count

  def test_filter_glob_uses_pattern_match(self):
    self._seed_table(n_rows=10)
    # Match "name_0?" → name_00..name_09 (which is all 10 rows).
    filter_str = '[{"field":"name","op":"glob","value":"name_0?"}]'
    _cols, rows, total = self.db.fetch_paginated(
        'u1', limit=20, offset=0, filter_str=filter_str)
    self.assertEqual(total, 10)
    self.assertEqual(len(rows), 10)

  def test_filter_in_with_multi_value(self):
    self._seed_table(n_rows=10)
    filter_str = '[{"field":"value","op":"in","value":["1","3","5"]}]'
    _cols, rows, total = self.db.fetch_paginated(
        'u1', limit=20, offset=0, filter_str=filter_str)
    self.assertEqual(total, 3)
    values = sorted(r[1] for r in rows)
    self.assertEqual(values, [1, 3, 5])

  def test_filter_unknown_column_raises_value_error(self):
    self._seed_table()
    filter_str = '[{"field":"bogus","op":"=","value":"x"}]'
    with self.assertRaises(ValueError) as ctx:
      self.db.fetch_paginated('u1', limit=10, offset=0, filter_str=filter_str)
    self.assertIn('bogus', str(ctx.exception))

  def test_total_filtered_rows_matches_full_table_when_no_filter(self):
    self._seed_table(n_rows=7)
    _cols, _rows, total = self.db.fetch_paginated('u1', limit=2, offset=0)
    # Page is 2 rows, but totalFilteredRows is the full materialized count.
    self.assertEqual(total, 7)

  def test_filter_and_order_by_combine(self):
    self._seed_table(n_rows=10)
    # value > 6 (matches 7, 8, 9) ordered DESC → [9, 8, 7].
    filter_str = '[{"field":"value","op":">","value":"6"}]'
    _cols, rows, total = self.db.fetch_paginated(
        'u1',
        limit=10,
        offset=0,
        order_by='value desc',
        filter_str=filter_str,
    )
    self.assertEqual(total, 3)
    self.assertEqual([r[1] for r in rows], [9, 8, 7])

  def test_missing_table_raises_catalog_exception(self):
    # The handler maps CatalogException to 404 NOT_FOUND.
    import duckdb
    # Insert metadata row without ever merging — no materialized
    # table exists for this uuid.
    self.db.insert_qe_in_progress(
        'u1', 'SELECT *', query_limit=0, materialized=True)
    with self.assertRaises(duckdb.CatalogException):
      self.db.fetch_paginated('u1', limit=10, offset=0)


if __name__ == '__main__':
  unittest.main(verbosity=2)
