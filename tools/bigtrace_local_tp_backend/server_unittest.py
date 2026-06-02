# Copyright (C) 2026 The Android Open Source Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""Unit tests for the small pure helpers in server.py.

These pin the always-strings wire contract (`_value_to_wire`,
`_wire_rows`) and the listing-preview clipper (`_truncate`) — each
of which is small enough to test exhaustively at the function level.
The smoke test in `smoke_local.py` covers the same paths
end-to-end through HTTP; these tests localize regressions to the
line of intent.

Run:
    .venv/bin/python -m unittest server_unittest -v
or:
    .venv/bin/python server_unittest.py
"""

from __future__ import annotations

import unittest

import asyncio
import json
import os
import shutil
import tempfile
from unittest.mock import patch

from fastapi import HTTPException

from db import Database, QESnapshot
import server as server_mod
from server import (
    CONFIG,
    LIST_TEXT_MAX,
    _get_db,
    _get_snapshot_or_404,
    _qe_to_raw,
    _qe_to_status,
    _resolve_trace_dir,
    _resolve_traces_for,
    _truncate,
    _value_to_wire,
    _wire_rows,
)


def _settings_with(trace_directory: str = '',
                   trace_limit: int | None = None) -> list[dict]:
  """Build a settings list in the on-the-wire shape.

    Trace selection is no longer a setting — it lives as the
    top-level `trace_filter` field on /execute_*. Callers that want
    to exercise the filter pass it directly to _resolve_traces_for.
    """
  out: list[dict] = []
  if trace_directory:
    out.append({
        'setting_id': 'trace_directory',
        'values': [trace_directory],
        'category': 'TRACE_ADDRESS',
    })
  if trace_limit is not None:
    out.append({
        'setting_id': 'trace_limit',
        'values': [trace_limit],
        'category': 'TRACE_ADDRESS',
    })
  return out


def _make_snap(**overrides) -> QESnapshot:
  """Build a QESnapshot with sensible defaults; overrides win.

    Mirrors what `Database.get_qe` returns — a dataclass with the
    full 12-field projection. Tests that need a specific status /
    error / table state pass overrides; the rest is filler.
    """
  defaults = dict(
      query_uuid='abc-1234',
      status='IN_PROGRESS',
      perfetto_sql='SELECT 1',
      query_limit=100,
      materialized=True,
      start_time='2026-05-10T00:00:00.000Z',
      end_time=None,
      processed_rows=0,
      processed_traces=0,
      total_traces=0,
      error_message=None,
      table_name=None,
  )
  defaults.update(overrides)
  return QESnapshot(**defaults)


class TruncateTest(unittest.TestCase):
  """`_truncate` is the listing-preview clipper. The exact rules:
    short input passes through, long input clips to a whitespace
    boundary (rstripped) ending in `…`, single-token input falls
    back to a hard cut at LIST_TEXT_MAX. Pinning these so a future
    "tighten the clipper" refactor can't regress them."""

  def test_short_string_passes_through_unchanged(self):
    s = 'SELECT 1'
    self.assertEqual(_truncate(s), s)

  def test_string_at_exact_cap_passes_through(self):
    s = 'a' * LIST_TEXT_MAX
    self.assertEqual(_truncate(s), s)

  def test_long_string_with_whitespace_clips_at_word_boundary(self):
    # 'word ' repeated until well past the cap. Expect clip to land
    # on a space, then trailing whitespace stripped, then ellipsis.
    s = ('word ' * 100)
    out = _truncate(s)
    self.assertTrue(out.endswith('…'))
    self.assertLessEqual(len(out), LIST_TEXT_MAX + 1)  # +1 for '…'
    # The body before '…' must not end with whitespace (rstrip).
    body = out[:-1]
    self.assertEqual(body, body.rstrip())
    # The body must split cleanly on word boundaries — every chunk
    # is the literal "word".
    for token in body.strip().split():
      self.assertEqual(token, 'word')

  def test_single_giant_token_falls_back_to_hard_cut(self):
    # No whitespace in the first half → no usable boundary → fall
    # back to s[:LIST_TEXT_MAX] + '…' so we don't return empty.
    s = 'x' * (LIST_TEXT_MAX * 2)
    out = _truncate(s)
    self.assertEqual(out, 'x' * LIST_TEXT_MAX + '…')

  def test_clip_prefers_whitespace_boundary_over_hard_cut(self):
    # A run of x's followed by a space at LIST_TEXT_MAX-1, then more
    # x's. The clip should land on the space (last_ws), not at
    # LIST_TEXT_MAX. The body ends at the space, rstripped.
    head = 'x' * (LIST_TEXT_MAX - 1)
    s = head + ' ' + 'x' * 50
    out = _truncate(s)
    self.assertEqual(out, head + '…')


class ValueToWireTest(unittest.TestCase):
  """The always-strings wire contract: every value goes out as a
    JSON string except SQL NULL which stays as JSON null. Booleans
    canonicalize to lowercase to round-trip cleanly through the
    same-shaped filter wire."""

  def test_none_stays_none(self):
    # JSON null preserves SQL NULL; the UI doesn't have to do
    # string-to-null conversion at the cell level.
    self.assertIsNone(_value_to_wire(None))

  def test_booleans_lowercase(self):
    # Python str(True) == 'True', but the JSON convention is
    # lowercase, and the filter wire ships strings — sending
    # 'True'/'False' would mean the round-trip filter doesn't
    # match the rendered cell. Lowercasing keeps things uniform.
    self.assertEqual(_value_to_wire(True), 'true')
    self.assertEqual(_value_to_wire(False), 'false')

  def test_int_stringified_lossless_past_2_to_53(self):
    # JS Number tops out safe-integer range at 2^53. A BIGINT
    # value past that loses precision when parsed as a Number.
    # str() preserves it; the UI never widens back to Number.
    big = 1_700_000_000_000_000_000
    self.assertEqual(_value_to_wire(big), '1700000000000000000')

  def test_float_stringified(self):
    self.assertEqual(_value_to_wire(3.14), '3.14')

  def test_string_passes_through(self):
    self.assertEqual(_value_to_wire('hello'), 'hello')

  def test_zero_and_empty_string_distinct(self):
    # Edge: 0 and '' should serialize distinctly so the UI can
    # tell them apart on the wire.
    self.assertEqual(_value_to_wire(0), '0')
    self.assertEqual(_value_to_wire(''), '')


class WireRowsTest(unittest.TestCase):
  """`_wire_rows` packs row tuples into the `[{values: [...]}]`
    envelope. Shared by the paginated and inline response paths so
    they can't drift on coercion behaviour."""

  def test_empty_rows_returns_empty_list(self):
    self.assertEqual(_wire_rows([]), [])

  def test_single_row_wraps_in_values_envelope(self):
    self.assertEqual(
        _wire_rows([['a', 1, None]]),
        [{
            'values': ['a', '1', None]
        }],
    )

  def test_multiple_rows_preserve_order(self):
    rows = [['a', 1], ['b', 2], ['c', 3]]
    self.assertEqual(
        _wire_rows(rows),
        [
            {
                'values': ['a', '1']
            },
            {
                'values': ['b', '2']
            },
            {
                'values': ['c', '3']
            },
        ],
    )

  def test_each_value_goes_through_value_to_wire(self):
    # Mixed types in one row exercise the all-strings + null
    # contract end-to-end.
    self.assertEqual(
        _wire_rows([[True, False, None, 42, 3.14, 'hi']]),
        [{
            'values': ['true', 'false', None, '42', '3.14', 'hi']
        }],
    )


class QeToStatusTest(unittest.TestCase):
  """Strict 4-field contract for the `:status` endpoint. The
    polling client allocates an object of exactly this shape every
    3s — adding a field would silently grow every poll's payload;
    dropping one would break the UI's progress bar. `queryUuid` is
    deliberately absent — the client already knows it from the URL
    path. The submit-time snapshot (settings / trace_filter /
    trace_metadata_columns) is never echoed here; it lives on the
    full `/query_executions/{uuid}` endpoint."""

  EXPECTED_KEYS = frozenset({
      'status',
      'processedTraces',
      'totalTraces',
      'processedRows',
  })

  def test_exactly_four_keys_for_in_progress(self):
    snap = _make_snap(
        status='IN_PROGRESS',
        processed_rows=42,
        processed_traces=3,
        total_traces=10)
    self.assertEqual(set(_qe_to_status(snap).keys()), self.EXPECTED_KEYS)

  def test_exactly_four_keys_for_terminal_states(self):
    # SUCCESS / FAILED / CANCELLED all carry rich extra metadata
    # on the raw DB row (endTime, errorMessage, tableName, ...). The
    # status endpoint is documented to never echo those — pin it.
    for status in ('SUCCESS', 'FAILED', 'CANCELLED'):
      with self.subTest(status=status):
        snap = _make_snap(
            status=status,
            end_time='2026-05-10T00:00:01.000Z',
            error_message='boom' if status == 'FAILED' else None,
            table_name='bigtrace_abc' if status == 'SUCCESS' else None,
            settings=[{
                'setting_id': 'trace_directory',
                'values': ['/tmp']
            }],
            trace_filter='[{"field":"file_name","op":"=","value":"a.pftrace"}]',
            trace_metadata_columns=['file_name'])
        out = _qe_to_status(snap)
        self.assertEqual(set(out.keys()), self.EXPECTED_KEYS)
        # None of the submit-time-immutable fields leak through.
        for forbidden in (
            'queryUuid',
            'endTime',
            'errorMessage',
            'tableName',
            'tableLink',
            'perfettoSql',
            'limit',
            'materialized',
            'startTime',
            'settings',
            'traceFilter',
            'traceMetadataColumns',
        ):
          self.assertNotIn(forbidden, out)


class QeToRawTest(unittest.TestCase):
  """`_qe_to_raw` builds the full RawQueryExecution dict. Optional
    fields (endTime, errorMessage, tableName/tableLink) are present
    iff their source field is non-None — pin the conditional shape."""

  def test_minimal_in_progress_omits_optionals(self):
    # IN_PROGRESS row before first merge: end_time, error_message,
    # table_name all NULL. Wire response should omit them.
    snap = _make_snap(status='IN_PROGRESS')
    out = _qe_to_raw(snap)
    self.assertNotIn('endTime', out)
    self.assertNotIn('errorMessage', out)
    self.assertNotIn('tableName', out)
    self.assertNotIn('tableLink', out)

  def test_terminal_includes_end_time(self):
    snap = _make_snap(status='SUCCESS', end_time='2026-05-10T00:00:01.000Z')
    out = _qe_to_raw(snap)
    self.assertEqual(out['endTime'], '2026-05-10T00:00:01.000Z')

  def test_failed_includes_error_message(self):
    snap = _make_snap(status='FAILED', error_message='no such table')
    out = _qe_to_raw(snap)
    self.assertEqual(out['errorMessage'], 'no such table')

  def test_table_name_present_implies_table_link_present(self):
    # tableLink is derived from tableName — they must be in lockstep.
    # Whichever Datasette config is active, both keys exist together.
    snap = _make_snap(status='SUCCESS', table_name='bigtrace_xyz')
    out = _qe_to_raw(snap)
    self.assertEqual(out['tableName'], 'bigtrace_xyz')
    self.assertIn('tableLink', out)

  def test_table_link_routes_through_datasette_when_enabled(self):
    # CONFIG is module-global. Stash + restore.
    saved = CONFIG.datasette_port
    try:
      CONFIG.datasette_port = 8003
      snap = _make_snap(status='SUCCESS', table_name='bigtrace_xyz')
      out = _qe_to_raw(snap)
      self.assertIn('localhost:8003', out['tableLink'])
      self.assertIn('bigtrace_xyz', out['tableLink'])
      # SQL editor URL has the SELECT pre-filled (URL-encoded).
      self.assertIn('SELECT', out['tableLink'])
    finally:
      CONFIG.datasette_port = saved

  def test_table_link_falls_back_when_datasette_off(self):
    saved = CONFIG.datasette_port
    try:
      CONFIG.datasette_port = 0
      snap = _make_snap(status='SUCCESS', table_name='bigtrace_xyz')
      out = _qe_to_raw(snap)
      self.assertEqual(out['tableLink'], '/tables/bigtrace_xyz')
    finally:
      CONFIG.datasette_port = saved

  def test_truncate_flag_clips_long_sql_with_ellipsis(self):
    snap = _make_snap(perfetto_sql='SELECT ' + 'x, ' * 200)
    out = _qe_to_raw(snap, truncate=True)
    self.assertTrue(out['perfettoSql'].endswith('…'))

  def test_truncate_flag_off_passes_through(self):
    long_sql = 'SELECT ' + 'x, ' * 200
    snap = _make_snap(perfetto_sql=long_sql)
    out = _qe_to_raw(snap, truncate=False)
    self.assertEqual(out['perfettoSql'], long_sql)

  def test_truncate_clips_long_error_message_too(self):
    long_err = 'no such table: ' + 'x' * 1000
    snap = _make_snap(status='FAILED', error_message=long_err)
    out = _qe_to_raw(snap, truncate=True)
    self.assertTrue(out['errorMessage'].endswith('…'))


class QeToRawSnapshotTest(unittest.TestCase):
  """The submit-time snapshot (`settings`, `traceFilter`,
    `traceMetadataColumns`) appears on the per-UUID full GET only —
    never on the list endpoint, where the response stays lean. The
    UI rehydrates per-tab state from the full GET when reopening a
    historical query; the list endpoint just powers the history
    sidebar's at-a-glance preview."""

  def _snap_with_snapshot(self, **overrides):
    return _make_snap(
        settings=[{
            'setting_id': 'trace_limit',
            'values': [50],
            'category': 'TRACE_ADDRESS',
        }],
        # trace_filter is the storage form (JSON-encoded string in
        # DuckDB). The wire shape — both submit body and full-GET
        # echo — is a native `Filter[]` array (WIRE_SPEC §10.1,
        # §12.1); `_qe_to_raw` json.loads-es this before responding.
        trace_filter='[{"field":"file_name","op":"glob","value":"*.pftrace"}]',
        trace_metadata_columns=['file_name', 'size_bytes'],
        **overrides,
    )

  def test_full_get_emits_all_three_snapshot_fields(self):
    snap = self._snap_with_snapshot()
    out = _qe_to_raw(snap, truncate=False)
    self.assertEqual(out['settings'], [{
        'setting_id': 'trace_limit',
        'values': [50],
        'category': 'TRACE_ADDRESS',
    }])
    # traceFilter is emitted as the native `Filter[]` array — same
    # shape clients submit on every filter site (/execute_*
    # trace_filter, /traces filter, :fetch_results filter) under the
    # strict-native body contract.
    self.assertEqual(out['traceFilter'], [{
        'field': 'file_name',
        'op': 'glob',
        'value': '*.pftrace'
    }])
    self.assertEqual(out['traceMetadataColumns'], ['file_name', 'size_bytes'])

  def test_list_omits_all_three_snapshot_fields(self):
    snap = self._snap_with_snapshot()
    out = _qe_to_raw(snap, truncate=True)
    self.assertNotIn('settings', out)
    self.assertNotIn('traceFilter', out)
    self.assertNotIn('traceMetadataColumns', out)

  def test_full_get_emits_default_values_when_no_snapshot(self):
    # A pre-snapshot historical row (or a future client that omitted
    # the fields) reads back as documented defaults: `[]` for
    # list-typed fields (settings, trace_filter,
    # trace_metadata_columns), `""` for the only string-typed field
    # (trace_order_by) — distinct from missing, so the UI can render
    # "this query had no trace filter" the same way regardless of
    # when the row was written.
    snap = _make_snap()
    out = _qe_to_raw(snap, truncate=False)
    self.assertEqual(out['settings'], [])
    self.assertEqual(out['traceFilter'], [])
    self.assertEqual(out['traceMetadataColumns'], [])


class NormalizeTraceFilterForStorageTest(unittest.TestCase):
  """`_normalize_trace_filter_for_storage` coerces the wire body
    field into the string-or-None storage shape. The wire is
    strict-native-only (WIRE_SPEC §10.1, §12.1) — the normalizer
    JSON-encodes the native list for VARCHAR storage. Empty /
    non-list inputs persist as None; semantic validation of the
    list content is `_parse_trace_filter_or_400`'s job and surfaces
    a 400 before the row reaches a SQL query."""

  def test_none_returns_none(self):
    from server import _normalize_trace_filter_for_storage as norm
    self.assertIsNone(norm(None))

  def test_native_list_becomes_json_string(self):
    # Wire form: native Filter[] array. Storage encodes to a
    # canonical JSON string so it round-trips through VARCHAR.
    from server import _normalize_trace_filter_for_storage as norm
    f = [{'field': 'x', 'op': '=', 'value': 'y'}]
    self.assertEqual(norm(f), '[{"field": "x", "op": "=", "value": "y"}]')

  def test_empty_list_returns_none(self):
    # Wire's "no filter" sentinel; persists as SQL NULL.
    from server import _normalize_trace_filter_for_storage as norm
    self.assertIsNone(norm([]))

  def test_string_persists_as_none(self):
    # Strict-native-only contract: a JSON-encoded string is REJECTED
    # with 400 by _parse_trace_filter_or_400. This normalizer is
    # called BEFORE that validation (so even queries that 400
    # produce a history row), so a non-list input here persists as
    # None rather than corrupting the snapshot column.
    from server import _normalize_trace_filter_for_storage as norm
    self.assertIsNone(norm('[{"field":"x","op":"=","value":"y"}]'))
    self.assertIsNone(norm(''))

  def test_unrecognized_type_returns_none(self):
    from server import _normalize_trace_filter_for_storage as norm
    self.assertIsNone(norm(42))
    self.assertIsNone(norm({'not': 'a list'}))


class ResolveTraceDirTest(unittest.TestCase):
  """`_resolve_trace_dir` validates the per-request `trace_directory`
    setting. Empty / missing → 400; nonexistent dir → 400; happy
    path returns the absolute resolved path. The function also
    expands `~` and `$VAR` so users typing CLI-style paths work."""

  def setUp(self):
    self._tmp = tempfile.mkdtemp(prefix='resolve_trace_dir_unittest_')

  def tearDown(self):
    shutil.rmtree(self._tmp, ignore_errors=True)

  def test_returns_path_for_valid_existing_dir(self):
    self.assertEqual(_resolve_trace_dir(_settings_with(self._tmp)), self._tmp)

  def test_missing_setting_raises_400(self):
    with self.assertRaises(HTTPException) as ctx:
      _resolve_trace_dir([])
    self.assertEqual(ctx.exception.status_code, 400)
    self.assertIn('No traces directory', str(ctx.exception.detail))

  def test_empty_setting_raises_400(self):
    with self.assertRaises(HTTPException) as ctx:
      _resolve_trace_dir(_settings_with(''))
    self.assertEqual(ctx.exception.status_code, 400)

  def test_nonexistent_path_raises_400(self):
    with self.assertRaises(HTTPException) as ctx:
      _resolve_trace_dir(_settings_with('/no/such/path'))
    self.assertEqual(ctx.exception.status_code, 400)
    self.assertIn('does not exist', str(ctx.exception.detail))

  def test_unreadable_directory_raises_400_with_permissions_detail(self):
    # A real directory the user can't read. Without the validation
    # catch, the PermissionError would leak from `os.listdir` later
    # — sync would 500, async would mark FAILED with `[Errno 13]`.
    # Validation surfaces it cleanly as 400 instead.
    unreadable = os.path.join(self._tmp, 'no-perms')
    os.makedirs(unreadable)
    os.chmod(unreadable, 0o000)
    try:
      with self.assertRaises(HTTPException) as ctx:
        _resolve_trace_dir(_settings_with(unreadable))
      self.assertEqual(ctx.exception.status_code, 400)
      detail = str(ctx.exception.detail)
      self.assertIn('not readable', detail)
      # Distinct from the other branches' detail so the UI can
      # show the right hint to the user.
      self.assertNotIn('does not exist', detail)
      self.assertNotIn('is not a directory', detail)
    finally:
      # Restore so tearDown's rmtree can recurse into it.
      os.chmod(unreadable, 0o700)

  def test_path_is_a_file_not_a_dir_raises_400_with_distinct_detail(self):
    # User passes a file path instead of a directory. Should
    # surface as "is not a directory" — not "does not exist",
    # which would mislead the user into thinking the path was
    # wrong (it isn't; only its kind is).
    file_path = os.path.join(self._tmp, 'a-real-file.txt')
    with open(file_path, 'w') as f:
      f.write('content')
    with self.assertRaises(HTTPException) as ctx:
      _resolve_trace_dir(_settings_with(file_path))
    self.assertEqual(ctx.exception.status_code, 400)
    self.assertIn('is not a directory', str(ctx.exception.detail))
    self.assertNotIn('does not exist', str(ctx.exception.detail))

  def test_tilde_expansion(self):
    # `~` resolves via os.path.expanduser. Pass a settings dict
    # with literal `~` and verify the returned path is no longer
    # tilde-prefixed (assuming HOME is set).
    home = os.path.expanduser('~')
    if not os.path.isdir(home):
      self.skipTest('no $HOME directory')
    out = _resolve_trace_dir(_settings_with('~'))
    self.assertEqual(out, home)
    self.assertFalse(out.startswith('~'))


class ResolveTracesForTest(unittest.TestCase):
  """`_resolve_traces_for` is the orchestrator: enumerate_traces →
    structured trace_filter → trace_limit cap. Each component is
    individually tested elsewhere; this exercises the wiring.

    `trace_filter` is the top-level structured field (Filter[] JSON),
    not a setting. Passed directly as the second positional arg so
    these tests pin the wire-level contract that `/execute_*` uses.
    """

  def setUp(self):
    self._tmp = tempfile.mkdtemp(prefix='resolve_traces_unittest_')
    # Seed: 4 trace files + 1 unrelated file.
    for name in ('a.pftrace', 'b.pftrace', 'c.pftrace', 'd.pftrace',
                 'ignore.json'):
      with open(os.path.join(self._tmp, name), 'wb') as f:
        f.write(b'')

  def tearDown(self):
    shutil.rmtree(self._tmp, ignore_errors=True)

  def test_returns_all_recognized_traces_when_no_filter_or_cap(self):
    out = _resolve_traces_for(_settings_with(self._tmp), None)
    names = {os.path.basename(e['file_path']) for e in out}
    self.assertEqual(names,
                     {'a.pftrace', 'b.pftrace', 'c.pftrace', 'd.pftrace'})

  def test_filter_narrows_set(self):
    # Wire contract: trace_filter is a native `Filter[]` JSON array.
    out = _resolve_traces_for(
        _settings_with(self._tmp), [{
            'field': 'file_name',
            'op': 'glob',
            'value': 'a*'
        }])
    names = [os.path.basename(e['file_path']) for e in out]
    self.assertEqual(names, ['a.pftrace'])

  def test_limit_truncates_to_first_n_alphabetically(self):
    # Order must be alphabetical (so trace_limit cap is reproducible
    # — same files end up in the cap across runs).
    out = _resolve_traces_for(_settings_with(self._tmp, trace_limit=2), None)
    names = [os.path.basename(e['file_path']) for e in out]
    self.assertEqual(names, ['a.pftrace', 'b.pftrace'])

  def test_limit_zero_means_uncapped(self):
    out = _resolve_traces_for(_settings_with(self._tmp, trace_limit=0), None)
    self.assertEqual(len(out), 4)

  def test_filter_then_limit_compose(self):
    # Filter narrows to {a, b, c}; cap=2 keeps the first 2 alpha.
    out = _resolve_traces_for(
        _settings_with(self._tmp, trace_limit=2), [{
            'field': 'file_name',
            'op': 'in',
            'value': ['a.pftrace', 'b.pftrace', 'c.pftrace'],
        }])
    names = [os.path.basename(e['file_path']) for e in out]
    self.assertEqual(names, ['a.pftrace', 'b.pftrace'])

  def test_missing_trace_directory_raises_400(self):
    with self.assertRaises(HTTPException) as ctx:
      _resolve_traces_for(_settings_with(''), None)
    self.assertEqual(ctx.exception.status_code, 400)

  def test_json_string_trace_filter_raises_400(self):
    # Strict-native-only wire (WIRE_SPEC §10.1, §12.1). The
    # JSON-encoded string form was removed on the 2026-06-03
    # migration — clients must send the array natively. The error
    # detail tells the client what to do.
    with self.assertRaises(HTTPException) as ctx:
      _resolve_traces_for(
          _settings_with(self._tmp),
          '[{"field":"file_name","op":"=","value":"a.pftrace"}]')
    self.assertEqual(ctx.exception.status_code, 400)
    self.assertIn('native', ctx.exception.detail)

  def test_malformed_trace_filter_raises_400(self):
    # Anything that isn't a list (or None) is 400, matching the
    # shared filter-body contract on every site.
    with self.assertRaises(HTTPException) as ctx:
      _resolve_traces_for(_settings_with(self._tmp), {'not': 'an array'})
    self.assertEqual(ctx.exception.status_code, 400)

  def test_unknown_column_in_trace_filter_raises_400(self):
    # File metadata schema is fixed (file_path, file_name, size_bytes,
    # mtime). A filter referencing anything else is a user bug.
    with self.assertRaises(HTTPException) as ctx:
      _resolve_traces_for(
          _settings_with(self._tmp), [{
              'field': 'no_such_col',
              'op': '=',
              'value': 'x'
          }])
    self.assertEqual(ctx.exception.status_code, 400)

  def test_string_input_always_raises_400(self):
    # Under the strict-native contract any string — well-formed or
    # not — is a 400 INVALID_ARGUMENT because the body field expects
    # a native array.
    with self.assertRaises(HTTPException) as ctx:
      _resolve_traces_for(_settings_with(self._tmp), '{not json')
    self.assertEqual(ctx.exception.status_code, 400)

  def test_resolve_returns_full_entries_with_metadata(self):
    # The execute path stitches trace metadata onto query rows; it
    # needs the full entry shape (file_name + size_bytes + mtime),
    # not just file_path. Pin the entries-not-paths return contract.
    out = _resolve_traces_for(_settings_with(self._tmp), None)
    self.assertGreater(len(out), 0)
    for entry in out:
      self.assertEqual(
          set(entry.keys()),
          {'file_path', 'file_name', 'size_bytes', 'mtime'},
          f'entry missing schema fields: {entry}',
      )

  def test_trace_order_by_desc_reverses_processing_order(self):
    # Default order is `file_path ASC`. With a `file_name DESC`
    # trace_order_by the alphabetic walk reverses and the
    # trace_limit cap picks DIFFERENT files (d, c not a, b).
    out = _resolve_traces_for(
        _settings_with(self._tmp, trace_limit=2),
        None,
        'file_name desc',
    )
    names = [os.path.basename(e['file_path']) for e in out]
    self.assertEqual(names, ['d.pftrace', 'c.pftrace'])

  def test_trace_order_by_none_falls_back_to_file_path_asc(self):
    # Explicit None must produce the same result as omitting the arg
    # (deterministic default for legacy clients).
    out_default = _resolve_traces_for(
        _settings_with(self._tmp, trace_limit=2), None)
    out_none = _resolve_traces_for(
        _settings_with(self._tmp, trace_limit=2), None, None)
    self.assertEqual(out_default, out_none)

  def test_trace_order_by_empty_string_falls_back_to_default(self):
    # An empty `trace_order_by` (which is what `_row_to_snapshot`
    # rehydrates SQL NULL as) must NOT be parsed — falls back to the
    # default ordering, same as None.
    out_default = _resolve_traces_for(
        _settings_with(self._tmp, trace_limit=2), None)
    out_empty = _resolve_traces_for(
        _settings_with(self._tmp, trace_limit=2), None, '')
    self.assertEqual(out_default, out_empty)

  def test_trace_order_by_malformed_raises_400(self):
    # Same error contract as `:fetch_results` `order_by` — a
    # malformed AIP-132 string yields 400 INVALID_ARGUMENT with the
    # offending token surfaced in `detail`.
    with self.assertRaises(HTTPException) as ctx:
      _resolve_traces_for(_settings_with(self._tmp), None, 'file_name sideways')
    self.assertEqual(ctx.exception.status_code, 400)
    self.assertIn('trace_order_by', ctx.exception.detail)

  def test_trace_order_by_unknown_column_raises_400(self):
    with self.assertRaises(HTTPException) as ctx:
      _resolve_traces_for(_settings_with(self._tmp), None, 'no_such_col asc')
    self.assertEqual(ctx.exception.status_code, 400)


class ValidateTraceMetadataColumnsTest(unittest.TestCase):
  """`_validate_trace_metadata_columns_or_400` is the executor-side
    field-mask for the top-level `trace_metadata_columns` request
    body field. Mirrors the /traces?columns= validation contract so
    clients see one shape across both endpoints."""

  def test_none_returns_empty_list(self):
    self.assertEqual(
        server_mod._validate_trace_metadata_columns_or_400(None), [])

  def test_known_columns_pass(self):
    self.assertEqual(
        server_mod._validate_trace_metadata_columns_or_400(
            ['file_name', 'size_bytes']),
        ['file_name', 'size_bytes'],
    )

  def test_unknown_column_rejected(self):
    with self.assertRaises(HTTPException) as ctx:
      server_mod._validate_trace_metadata_columns_or_400(['no_such_col'])
    self.assertEqual(ctx.exception.status_code, 400)

  def test_duplicate_rejected(self):
    with self.assertRaises(HTTPException) as ctx:
      server_mod._validate_trace_metadata_columns_or_400(
          ['file_name', 'file_name'])
    self.assertEqual(ctx.exception.status_code, 400)

  def test_non_list_rejected(self):
    with self.assertRaises(HTTPException) as ctx:
      server_mod._validate_trace_metadata_columns_or_400('file_name')
    self.assertEqual(ctx.exception.status_code, 400)

  def test_non_string_entry_rejected(self):
    with self.assertRaises(HTTPException) as ctx:
      server_mod._validate_trace_metadata_columns_or_400(['file_name', 42])
    self.assertEqual(ctx.exception.status_code, 400)

  def test_empty_string_entry_rejected(self):
    with self.assertRaises(HTTPException) as ctx:
      server_mod._validate_trace_metadata_columns_or_400(['file_name', ''])
    self.assertEqual(ctx.exception.status_code, 400)


class GetDbTest(unittest.TestCase):
  """`_get_db` returns the global Database singleton or raises 503."""

  def test_returns_db_when_initialized(self):
    saved = server_mod.DB
    try:
      tmp = tempfile.mkdtemp(prefix='get_db_unittest_')
      server_mod.DB = Database(os.path.join(tmp, 'state.duckdb'))
      try:
        self.assertIs(_get_db(), server_mod.DB)
      finally:
        server_mod.DB.close()
        shutil.rmtree(tmp, ignore_errors=True)
    finally:
      server_mod.DB = saved

  def test_raises_503_when_db_is_none(self):
    saved = server_mod.DB
    try:
      server_mod.DB = None
      with self.assertRaises(HTTPException) as ctx:
        _get_db()
      self.assertEqual(ctx.exception.status_code, 503)
      self.assertIn('not initialized', str(ctx.exception.detail))
    finally:
      server_mod.DB = saved


class GetSnapshotOr404Test(unittest.TestCase):
  """`_get_snapshot_or_404` returns the snapshot or raises 404 with
    the documented detail format."""

  def setUp(self):
    self._tmp = tempfile.mkdtemp(prefix='get_snap_unittest_')
    self._saved_db = server_mod.DB
    server_mod.DB = Database(os.path.join(self._tmp, 'state.duckdb'))

  def tearDown(self):
    server_mod.DB.close()
    server_mod.DB = self._saved_db
    shutil.rmtree(self._tmp, ignore_errors=True)

  def test_returns_snapshot_for_existing_uuid(self):
    server_mod.DB.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    snap = _get_snapshot_or_404('u1')
    self.assertEqual(snap.query_uuid, 'u1')
    self.assertEqual(snap.status, 'IN_PROGRESS')

  def test_raises_404_for_missing(self):
    with self.assertRaises(HTTPException) as ctx:
      _get_snapshot_or_404('does-not-exist')
    self.assertEqual(ctx.exception.status_code, 404)
    # Detail format used by the UI's error-mapper. Pin the structure
    # so a future "improve the error message" tweak can't strip the
    # uuid out and leave the UI guessing which query was missing.
    self.assertIn('does-not-exist', str(ctx.exception.detail))
    self.assertIn('not found', str(ctx.exception.detail))

  def test_raises_404_for_soft_deleted(self):
    # Soft-deleted rows are treated as gone for handler purposes —
    # the underlying row stays in the DB but get_qe returns None,
    # so this helper 404s. UI doesn't see deleted entries.
    server_mod.DB.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)
    server_mod.DB.mark_success('u1', processed_rows=5)
    server_mod.DB.soft_delete('u1')
    with self.assertRaises(HTTPException) as ctx:
      _get_snapshot_or_404('u1')
    self.assertEqual(ctx.exception.status_code, 404)


class RunAsyncQueryErrorMessageTest(unittest.TestCase):
  """`_run_async_query` is the background coroutine that drives an
    async run after submit. When validation fails mid-run (e.g.,
    trace_dir disappeared between submit and execution), the wire's
    `errorMessage` should match what a sync caller would have seen
    at submit time — not the verbose `HTTPException: 400: ...`
    that the broad-except formatter would produce. Pin both
    branches: HTTPException → bare detail; other Exception → typed
    repr."""

  def setUp(self):
    self._tmp = tempfile.mkdtemp(prefix='run_async_unittest_')
    self._saved_db = server_mod.DB
    server_mod.DB = Database(os.path.join(self._tmp, 'state.duckdb'))

  def tearDown(self):
    server_mod.DB.close()
    server_mod.DB = self._saved_db
    shutil.rmtree(self._tmp, ignore_errors=True)

  def _run(self, coro):
    return asyncio.new_event_loop().run_until_complete(coro)

  def test_http_exception_records_bare_detail(self):
    server_mod.DB.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)

    # Simulate validation failure during background execution.
    def fail(*_args, **_kwargs):
      raise HTTPException(
          status_code=400, detail="Trace Directory '/missing' does not exist")

    with patch.object(server_mod, '_resolve_traces_for', side_effect=fail):
      self._run(
          server_mod._run_async_query('u1', 'SELECT 1', 10, [], None, None))
    snap = server_mod.DB.get_qe('u1')
    assert snap is not None
    self.assertEqual(snap.status, 'FAILED')
    # Bare detail — NOT "HTTPException: 400: ..."
    self.assertEqual(snap.error_message,
                     "Trace Directory '/missing' does not exist")
    self.assertNotIn('HTTPException', snap.error_message)

  def test_unexpected_exception_records_typed_repr(self):
    server_mod.DB.insert_qe_in_progress(
        'u1', 'SELECT 1', query_limit=10, materialized=True)

    def boom(*_args, **_kwargs):
      raise RuntimeError('unexpected')

    with patch.object(server_mod, '_resolve_traces_for', side_effect=boom):
      self._run(
          server_mod._run_async_query('u1', 'SELECT 1', 10, [], None, None))
    snap = server_mod.DB.get_qe('u1')
    assert snap is not None
    self.assertEqual(snap.status, 'FAILED')
    # Typed prefix preserved for non-HTTPException — helps debugging
    # since these are genuinely unexpected (the broad-except path).
    self.assertEqual(snap.error_message, 'RuntimeError: unexpected')


if __name__ == '__main__':
  unittest.main(verbosity=2)
