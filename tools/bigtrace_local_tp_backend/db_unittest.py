# Copyright (C) 2026 The Android Open Source Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""Unit tests for the structural parsers in `db.py`.

Covers `parse_filter` and `compile_where` exhaustively — every op
variant, every documented error path, multi-filter AND composition,
and identifier-quoting for column names that collide with DuckDB
keywords. Smoke tests in `smoke_local.py` cover the HTTP integration
path; these tests pin the parser behavior at the function level so
failures localize to the line of intent.

Run:
    .venv/bin/python -m unittest db_unittest -v
or:
    .venv/bin/python db_unittest.py
"""

from __future__ import annotations

import json
import unittest
from datetime import datetime

from db import (
    ParsedFilter,
    _infer_column_types,
    _ts_to_iso,
    compile_where,
    parse_filter,
    parse_order_by,
    safe_table_id,
)

# ---------------------------------------------------------------------------
# parse_filter — happy paths
# ---------------------------------------------------------------------------


class ParseFilterHappyTest(unittest.TestCase):
  """Each op variant must produce the expected ParsedFilter."""

  def test_empty_input_returns_empty_list(self):
    self.assertEqual(parse_filter(''), [])
    self.assertEqual(parse_filter('   '), [])
    self.assertEqual(parse_filter('[]'), [])

  def test_comparison_ops_each_produce_one_value(self):
    for op in ('=', '!=', '<', '<=', '>', '>='):
      with self.subTest(op=op):
        s = json.dumps([{'field': 'a', 'op': op, 'value': 42}])
        result = parse_filter(s)
        self.assertEqual(result, [ParsedFilter(field='a', op=op, values=[42])])

  def test_glob_and_not_glob_pass_through_string_value(self):
    for op in ('glob', 'not glob'):
      with self.subTest(op=op):
        s = json.dumps([{'field': 'name', 'op': op, 'value': 'x*'}])
        self.assertEqual(
            parse_filter(s), [ParsedFilter(field='name', op=op, values=['x*'])])

  def test_glob_with_non_string_value_passes_through(self):
    # The wire spec says values are strings (UI encoder coerces),
    # but the parser is permissive: a hand-rolled client sending a
    # number is accepted at parse time. DuckDB will error at bind
    # time if the resulting GLOB pattern doesn't make sense; the
    # endpoint catches that and returns 400.
    s = json.dumps([{'field': 'a', 'op': 'glob', 'value': 42}])
    self.assertEqual(
        parse_filter(s), [ParsedFilter(field='a', op='glob', values=[42])])

  def test_in_and_not_in_carry_array_values(self):
    for op in ('in', 'not in'):
      with self.subTest(op=op):
        s = json.dumps([{'field': 'k', 'op': op, 'value': [1, 2, 3]}])
        self.assertEqual(
            parse_filter(s), [ParsedFilter(field='k', op=op, values=[1, 2, 3])])

  def test_null_arity_ops_have_empty_values(self):
    for op in ('is null', 'is not null'):
      with self.subTest(op=op):
        s = json.dumps([{'field': 'parent_id', 'op': op}])
        self.assertEqual(
            parse_filter(s),
            [ParsedFilter(field='parent_id', op=op, values=[])])

  def test_multi_filter_array_preserves_order(self):
    s = json.dumps([
        {
            'field': 'a',
            'op': '=',
            'value': 1
        },
        {
            'field': 'b',
            'op': 'in',
            'value': ['x', 'y']
        },
        {
            'field': 'c',
            'op': 'is null'
        },
    ])
    self.assertEqual(
        parse_filter(s), [
            ParsedFilter(field='a', op='=', values=[1]),
            ParsedFilter(field='b', op='in', values=['x', 'y']),
            ParsedFilter(field='c', op='is null', values=[]),
        ])

  def test_scalar_value_types_pass_through(self):
    # Each kind of JSON scalar should pass through unchanged for the
    # SQL layer to bind. Boolean is included because DuckDB BOOLEAN
    # columns accept it natively.
    for v in (1, 1.5, 'str', True, False, None):
      with self.subTest(value=v):
        s = json.dumps([{'field': 'a', 'op': '=', 'value': v}])
        self.assertEqual(parse_filter(s)[0].values, [v])


# ---------------------------------------------------------------------------
# parse_filter — error paths
# ---------------------------------------------------------------------------


class ParseFilterErrorTest(unittest.TestCase):
  """Each documented MUST-reject case raises ValueError with a useful message."""

  def test_malformed_json(self):
    with self.assertRaisesRegex(ValueError, 'not valid JSON'):
      parse_filter('not-json')

  def test_top_level_not_an_array(self):
    with self.assertRaisesRegex(ValueError, 'must be a JSON array'):
      parse_filter('{"field": "a"}')

  def test_entry_not_an_object(self):
    with self.assertRaisesRegex(ValueError, r'filter\[0\] must be an object'):
      parse_filter('[1, 2, 3]')

  def test_missing_field(self):
    s = json.dumps([{'op': '=', 'value': 1}])
    with self.assertRaisesRegex(ValueError, 'field must be a non-empty string'):
      parse_filter(s)

  def test_empty_field(self):
    s = json.dumps([{'field': '', 'op': '=', 'value': 1}])
    with self.assertRaisesRegex(ValueError, 'field must be a non-empty string'):
      parse_filter(s)

  def test_non_string_field(self):
    s = json.dumps([{'field': 42, 'op': '=', 'value': 1}])
    with self.assertRaisesRegex(ValueError, 'field must be a non-empty string'):
      parse_filter(s)

  def test_unknown_op(self):
    s = json.dumps([{'field': 'a', 'op': 'BETWEEN', 'value': 1}])
    with self.assertRaisesRegex(ValueError, 'not a recognized operator'):
      parse_filter(s)

  def test_null_op_with_value_rejected(self):
    s = json.dumps([{'field': 'a', 'op': 'is null', 'value': 1}])
    with self.assertRaisesRegex(ValueError, 'must not carry a value'):
      parse_filter(s)

  def test_scalar_op_with_array_value_rejected(self):
    s = json.dumps([{'field': 'a', 'op': '=', 'value': [1, 2]}])
    with self.assertRaisesRegex(ValueError, 'requires a scalar value'):
      parse_filter(s)

  def test_in_op_with_non_array_value_rejected(self):
    s = json.dumps([{'field': 'a', 'op': 'in', 'value': 'x'}])
    with self.assertRaisesRegex(ValueError, 'requires an array value'):
      parse_filter(s)

  def test_in_op_with_empty_array_rejected(self):
    s = json.dumps([{'field': 'a', 'op': 'in', 'value': []}])
    with self.assertRaisesRegex(ValueError, 'non-empty array'):
      parse_filter(s)

  def test_scalar_op_missing_value_rejected(self):
    s = json.dumps([{'field': 'a', 'op': '='}])
    with self.assertRaisesRegex(ValueError, 'requires a value'):
      parse_filter(s)


# ---------------------------------------------------------------------------
# compile_where — SQL composition
# ---------------------------------------------------------------------------


class CompileWhereTest(unittest.TestCase):
  """Each parsed filter compiles to the expected SQL fragment + params."""

  ALLOWED = {'a', 'b', 'col with space', 'select'}  # last two test quoting

  def test_empty_parsed_returns_empty(self):
    self.assertEqual(compile_where([], self.ALLOWED), ('', []))

  def test_comparison_op_single_param(self):
    pf = ParsedFilter(field='a', op='>', values=[10])
    frag, params = compile_where([pf], self.ALLOWED)
    self.assertEqual(frag, '"a" > ?')
    self.assertEqual(params, [10])

  def test_each_comparison_op_emits_correct_sql(self):
    for op, expected in (('=', '='), ('!=', '!='), ('<', '<'), ('<=', '<='),
                         ('>', '>'), ('>=', '>=')):
      with self.subTest(op=op):
        pf = ParsedFilter(field='a', op=op, values=[1])
        frag, _ = compile_where([pf], self.ALLOWED)
        self.assertEqual(frag, f'"a" {expected} ?')

  def test_glob_uppercases(self):
    pf = ParsedFilter(field='a', op='glob', values=['x*'])
    frag, params = compile_where([pf], self.ALLOWED)
    self.assertEqual(frag, '"a" GLOB ?')
    self.assertEqual(params, ['x*'])

  def test_not_glob_wraps_in_not_paren(self):
    # DuckDB's parser doesn't accept `NOT GLOB` as a single token,
    # so the emitted SQL is `NOT (col GLOB ?)`. Same semantics.
    pf = ParsedFilter(field='a', op='not glob', values=['x*'])
    frag, params = compile_where([pf], self.ALLOWED)
    self.assertEqual(frag, 'NOT ("a" GLOB ?)')
    self.assertEqual(params, ['x*'])

  def test_in_emits_n_placeholders(self):
    pf = ParsedFilter(field='a', op='in', values=[1, 2, 3])
    frag, params = compile_where([pf], self.ALLOWED)
    self.assertEqual(frag, '"a" IN (?, ?, ?)')
    self.assertEqual(params, [1, 2, 3])

  def test_not_in_emits_n_placeholders(self):
    pf = ParsedFilter(field='a', op='not in', values=[1, 2])
    frag, _ = compile_where([pf], self.ALLOWED)
    self.assertEqual(frag, '"a" NOT IN (?, ?)')

  def test_is_null_no_params(self):
    pf = ParsedFilter(field='a', op='is null', values=[])
    frag, params = compile_where([pf], self.ALLOWED)
    self.assertEqual(frag, '"a" IS NULL')
    self.assertEqual(params, [])

  def test_is_not_null_no_params(self):
    pf = ParsedFilter(field='a', op='is not null', values=[])
    frag, params = compile_where([pf], self.ALLOWED)
    self.assertEqual(frag, '"a" IS NOT NULL')
    self.assertEqual(params, [])

  def test_multi_filter_AND_joins_in_input_order(self):
    parsed = [
        ParsedFilter(field='a', op='>', values=[1]),
        ParsedFilter(field='b', op='in', values=['x', 'y']),
        ParsedFilter(field='a', op='is null', values=[]),
    ]
    frag, params = compile_where(parsed, self.ALLOWED)
    self.assertEqual(frag, '"a" > ? AND "b" IN (?, ?) AND "a" IS NULL')
    self.assertEqual(params, [1, 'x', 'y'])

  def test_unknown_column_raises(self):
    pf = ParsedFilter(field='not_a_column', op='=', values=[1])
    with self.assertRaisesRegex(ValueError, 'unknown filter column'):
      compile_where([pf], self.ALLOWED)

  def test_columns_with_special_chars_are_quoted(self):
    # Both `col with space` and the reserved-word `select` should
    # round-trip as double-quoted identifiers.
    parsed = [
        ParsedFilter(field='col with space', op='=', values=['v']),
        ParsedFilter(field='select', op='is null', values=[]),
    ]
    frag, _ = compile_where(parsed, self.ALLOWED)
    self.assertIn('"col with space" = ?', frag)
    self.assertIn('"select" IS NULL', frag)


# ---------------------------------------------------------------------------
# parse_order_by — basic regression coverage
# ---------------------------------------------------------------------------


class ParseOrderByTest(unittest.TestCase):
  """Light regression coverage so the existing AIP-132 parser stays
    pinned alongside parse_filter — it shares the same caller-validates-
    columns contract."""

  def test_empty_returns_empty(self):
    self.assertEqual(parse_order_by(''), [])
    self.assertEqual(parse_order_by('   '), [])

  def test_default_direction_is_asc(self):
    self.assertEqual(parse_order_by('name'), [('name', 'ASC')])

  def test_explicit_directions(self):
    self.assertEqual(
        parse_order_by('name desc, dur asc'), [('name', 'DESC'),
                                               ('dur', 'ASC')])

  def test_invalid_direction_raises(self):
    with self.assertRaises(ValueError):
      parse_order_by('name sideways')

  def test_direction_is_case_insensitive(self):
    # Wire spec mirrors AIP-132 §Ordering: "asc"/"desc" canonical,
    # but accepting any case is friendlier for hand-rolled callers
    # and matches how DuckDB itself accepts "ASC"/"asc"/"Asc".
    for d in ('ASC', 'Asc', 'aSc', 'DESC', 'Desc', 'dEsC'):
      with self.subTest(direction=d):
        result = parse_order_by(f'name {d}')
        self.assertEqual(result, [('name', d.upper())])

  def test_more_than_two_tokens_raises(self):
    # "a b c" → field/direction/?? — third token is meaningless,
    # reject rather than silently dropping it.
    with self.assertRaises(ValueError):
      parse_order_by('name asc extra')

  def test_empty_entry_between_commas_raises(self):
    # ",name" / "a,,b" / "name," — each empty slot is a client bug.
    # The parser refuses to silently swallow them.
    for s in (',name', 'a,,b', 'name,', ' , '):
      with self.subTest(input=s):
        with self.assertRaises(ValueError):
          parse_order_by(s)

  def test_extra_whitespace_is_tolerated(self):
    # Real callers may stuff in leading/trailing/inter-token
    # whitespace — split() collapses runs, strip() handles edges.
    # Pinning this so a future "tighten the parser" refactor can't
    # regress it.
    self.assertEqual(
        parse_order_by('  name   desc  ,  dur   asc  '), [('name', 'DESC'),
                                                          ('dur', 'ASC')])


class TsToIsoTest(unittest.TestCase):
  """`_ts_to_iso` formats DuckDB TIMESTAMP back to ISO-8601 with
    *millisecond* precision. The previous `.000Z` (whole-second)
    format made the UI render a flat 0s duration for every query
    that completed in under a second; pinning the ms-precision
    contract guards against regression."""

  def test_none_passes_through(self):
    self.assertIsNone(_ts_to_iso(None))

  def test_zero_microseconds_renders_as_000(self):
    ts = datetime(2026, 5, 10, 12, 34, 56, 0)
    self.assertEqual(_ts_to_iso(ts), '2026-05-10T12:34:56.000Z')

  def test_millisecond_aligned_microseconds_round_trip(self):
    # 123_000 µs = 123 ms exactly. Should land as `.123Z`.
    ts = datetime(2026, 5, 10, 12, 34, 56, 123_000)
    self.assertEqual(_ts_to_iso(ts), '2026-05-10T12:34:56.123Z')

  def test_sub_millisecond_microseconds_truncate_not_round(self):
    # 999 µs is below 1 ms. Truncation (// 1000) → 0 ms, so `.000Z`.
    # If we ever switch to round-to-nearest, the contract changes.
    ts = datetime(2026, 5, 10, 12, 34, 56, 999)
    self.assertEqual(_ts_to_iso(ts), '2026-05-10T12:34:56.000Z')

  def test_microsecond_precision_truncates_to_milliseconds(self):
    # 123_456 µs → 123 ms (the 456 sub-ms is dropped).
    ts = datetime(2026, 5, 10, 12, 34, 56, 123_456)
    self.assertEqual(_ts_to_iso(ts), '2026-05-10T12:34:56.123Z')

  def test_low_millisecond_values_zero_pad(self):
    # 5_000 µs = 5 ms. Must format as `.005Z`, not `.5Z`.
    ts = datetime(2026, 5, 10, 12, 34, 56, 5_000)
    self.assertEqual(_ts_to_iso(ts), '2026-05-10T12:34:56.005Z')


class InferColumnTypesTest(unittest.TestCase):
  """`_infer_column_types` picks the DuckDB column type for each
    Python value in the first sample row. Drives lazy CREATE TABLE
    in `merge_trace_atomic`; getting it wrong means the table is
    created with the wrong type and subsequent inserts may fail."""

  def test_empty_row_returns_empty(self):
    self.assertEqual(_infer_column_types([]), [])

  def test_each_python_type_maps_to_expected_duckdb_type(self):
    row = [True, 1, 1.5, 'hi', b'\x00']
    self.assertEqual(
        _infer_column_types(row),
        ['BOOLEAN', 'BIGINT', 'DOUBLE', 'VARCHAR', 'BLOB'])

  def test_none_falls_back_to_varchar(self):
    # NULL columns can't be type-inferred; VARCHAR accepts any
    # castable value going forward (DuckDB coerces on insert).
    self.assertEqual(_infer_column_types([None]), ['VARCHAR'])

  def test_unknown_type_falls_back_to_varchar(self):
    # A type not in _TYPE_MAP (e.g., a custom object) lands as
    # VARCHAR rather than crashing the merge step.
    self.assertEqual(_infer_column_types([object()]), ['VARCHAR'])

  def test_bool_check_precedes_int(self):
    # Python `bool` is a subclass of `int`. Without an explicit
    # bool entry in _TYPE_MAP, `True` would land as BIGINT —
    # confusing for the user and wrong for booleans-with-NULL.
    self.assertEqual(_infer_column_types([True, False]), ['BOOLEAN', 'BOOLEAN'])

  def test_mixed_row_per_position(self):
    row = [None, 42, 'x', None, 3.14]
    self.assertEqual(
        _infer_column_types(row),
        ['VARCHAR', 'BIGINT', 'VARCHAR', 'VARCHAR', 'DOUBLE'])


class SafeTableIdTest(unittest.TestCase):
  """`safe_table_id` builds a DuckDB-compatible identifier from a
    UUID. Hyphens aren't legal in unquoted identifiers; the wire
    `tableName` is exactly this string and clients paste it into
    SQL editors."""

  def test_simple_uuid(self):
    self.assertEqual(safe_table_id('abc-1234-5678'), 'bigtrace_abc_1234_5678')

  def test_all_hyphens_replaced(self):
    self.assertEqual(safe_table_id('a-b-c-d-e'), 'bigtrace_a_b_c_d_e')

  def test_no_hyphens_passes_through(self):
    self.assertEqual(safe_table_id('plain'), 'bigtrace_plain')

  def test_real_uuid_format(self):
    # The actual UUIDv4 shape we ship.
    self.assertEqual(
        safe_table_id('e44b41f0-a0ea-4960-8411-4bad75ea97a9'),
        'bigtrace_e44b41f0_a0ea_4960_8411_4bad75ea97a9')


# ---------------------------------------------------------------------------
# query_trace_list — the in-memory filter/order/page helper used by
# /list_traces and by execute_*'s top-level trace_filter.
# ---------------------------------------------------------------------------


class QueryTraceListTest(unittest.TestCase):
  """Drives the in-memory DuckDB pivot. The columns mirror what the
    /list_traces endpoint surfaces in Phase 1 (file_path, file_name,
    size_bytes, mtime). The Filter[] semantics are pinned by
    parse_filter+compile_where tests above; here we verify that
    query_trace_list wires them up correctly over an in-memory list
    of dicts and returns the always-strings-friendly tuple."""

  _COLS = [
      ('file_path', 'VARCHAR'),
      ('file_name', 'VARCHAR'),
      ('size_bytes', 'BIGINT'),
      ('mtime', 'VARCHAR'),
  ]
  _ROWS = [
      {
          'file_path': '/t/a.pftrace',
          'file_name': 'a.pftrace',
          'size_bytes': 100,
          'mtime': '2026-01-01T00:00:00.000Z',
      },
      {
          'file_path': '/t/b.pftrace',
          'file_name': 'b.pftrace',
          'size_bytes': 2000,
          'mtime': '2026-02-01T00:00:00.000Z',
      },
      {
          'file_path': '/t/c.pftrace',
          'file_name': 'c.pftrace',
          'size_bytes': 30000,
          'mtime': '2026-03-01T00:00:00.000Z',
      },
  ]

  def _call(self, parsed_filter=None, parsed_order=None, limit=None, offset=0):
    from db import query_trace_list
    return query_trace_list(
        self._ROWS,
        self._COLS,
        parsed_filter or [],
        parsed_order or [],
        limit=limit,
        offset=offset,
    )

  def test_empty_filter_returns_all_rows(self):
    cols, rows, total = self._call()
    self.assertEqual(cols, ['file_path', 'file_name', 'size_bytes', 'mtime'])
    self.assertEqual(len(rows), 3)
    self.assertEqual(total, 3)

  def test_glob_filter_on_file_name(self):
    pf = parse_filter('[{"field":"file_name","op":"glob","value":"a*"}]')
    cols, rows, total = self._call(parsed_filter=pf)
    self.assertEqual(total, 1)
    self.assertEqual(len(rows), 1)
    # Column order: file_path[0], file_name[1].
    self.assertEqual(rows[0][1], 'a.pftrace')

  def test_numeric_comparison_against_string_value_coerces(self):
    # The wire ships every value as a string (the UI's encoder uses
    # `String(...)`), but DuckDB coerces it to the column's BIGINT
    # type at bind time. This is the headline property of the
    # always-strings filter wire.
    pf = parse_filter('[{"field":"size_bytes","op":">","value":"1000"}]')
    cols, rows, total = self._call(parsed_filter=pf)
    self.assertEqual(total, 2)
    names = sorted(r[1] for r in rows)
    self.assertEqual(names, ['b.pftrace', 'c.pftrace'])

  def test_in_filter_with_multiple_values(self):
    pf = parse_filter('[{"field":"file_name","op":"in",'
                      '"value":["a.pftrace","c.pftrace"]}]')
    cols, rows, total = self._call(parsed_filter=pf)
    self.assertEqual(total, 2)
    self.assertEqual(sorted(r[1] for r in rows), ['a.pftrace', 'c.pftrace'])

  def test_order_by_descending(self):
    cols, rows, _ = self._call(parsed_order=[('size_bytes', 'DESC')])
    sizes = [r[2] for r in rows]
    self.assertEqual(sizes, [30000, 2000, 100])

  def test_order_by_unknown_column_raises_value_error(self):
    with self.assertRaises(ValueError):
      self._call(parsed_order=[('no_such_col', 'ASC')])

  def test_filter_on_unknown_column_raises_value_error(self):
    pf = parse_filter('[{"field":"no_such_col","op":"=","value":"x"}]')
    with self.assertRaises(ValueError):
      self._call(parsed_filter=pf)

  def test_pagination_limit_offset(self):
    # Sort by name ASC and page through.
    _, page1, total = self._call(
        parsed_order=[('file_name', 'ASC')], limit=2, offset=0)
    _, page2, total2 = self._call(
        parsed_order=[('file_name', 'ASC')], limit=2, offset=2)
    self.assertEqual(total, 3)
    self.assertEqual(total2, 3)
    self.assertEqual([r[1] for r in page1], ['a.pftrace', 'b.pftrace'])
    self.assertEqual([r[1] for r in page2], ['c.pftrace'])

  def test_limit_none_returns_all_rows(self):
    # The execute path uses limit=None — it wants every matching
    # trace, not a page.
    _, rows, total = self._call(limit=None)
    self.assertEqual(len(rows), 3)
    self.assertEqual(total, 3)

  def test_total_filtered_reflects_filter_not_full_table(self):
    pf = parse_filter('[{"field":"file_name","op":"=","value":"a.pftrace"}]')
    _, rows, total = self._call(parsed_filter=pf)
    self.assertEqual(total, 1)
    # Page limit truncates the rows, but the total is the filter
    # match count — the UI uses it to size the scrollbar over the
    # filtered set.
    _, rows, total = self._call(parsed_filter=pf, limit=0)
    self.assertEqual(total, 1)
    self.assertEqual(len(rows), 0)

  def test_empty_traces_yields_empty_result(self):
    from db import query_trace_list
    cols, rows, total = query_trace_list([], self._COLS, [], [], limit=10)
    self.assertEqual(rows, [])
    self.assertEqual(total, 0)
    # Column names still come from the schema, not the data.
    self.assertEqual(cols, ['file_path', 'file_name', 'size_bytes', 'mtime'])

  def test_projection_subset_returns_only_named_columns(self):
    from db import query_trace_list
    cols, rows, total = query_trace_list(
        self._ROWS,
        self._COLS,
        [],
        [],
        limit=10,
        projected_columns=['file_name', 'size_bytes'],
    )
    self.assertEqual(cols, ['file_name', 'size_bytes'])
    for r in rows:
      self.assertEqual(len(r), 2)
    self.assertEqual(total, 3)

  def test_projection_can_filter_on_unprojected_column(self):
    # Filter references a column that isn't in the projection — the
    # underlying table still has every column, so the filter applies.
    # This is the property the /traces endpoint relies on: the UI
    # can collapse the visible columns without losing query power.
    from db import query_trace_list
    pf = parse_filter('[{"field":"size_bytes","op":">","value":"1000"}]')
    cols, rows, total = query_trace_list(
        self._ROWS,
        self._COLS,
        pf,
        [],
        limit=10,
        projected_columns=['file_name'],
    )
    self.assertEqual(cols, ['file_name'])
    self.assertEqual(total, 2)
    self.assertEqual(sorted(r[0] for r in rows), ['b.pftrace', 'c.pftrace'])

  def test_projection_can_order_by_unprojected_column(self):
    # Same property for order_by — the sort still applies.
    from db import query_trace_list
    cols, rows, _ = query_trace_list(
        self._ROWS,
        self._COLS,
        [],
        [('size_bytes', 'DESC')],
        limit=10,
        projected_columns=['file_name'],
    )
    self.assertEqual(cols, ['file_name'])
    self.assertEqual([r[0] for r in rows],
                     ['c.pftrace', 'b.pftrace', 'a.pftrace'])

  def test_projection_preserves_caller_column_order(self):
    # The response surface mirrors `projected_columns` exactly — not
    # the schema's declaration order. Lets the UI reorder columns
    # without a separate "column_order" field on the wire.
    from db import query_trace_list
    cols, _, _ = query_trace_list(
        self._ROWS,
        self._COLS,
        [],
        [],
        limit=10,
        projected_columns=['mtime', 'file_name'],
    )
    self.assertEqual(cols, ['mtime', 'file_name'])

  def test_projection_unknown_column_raises(self):
    from db import query_trace_list
    with self.assertRaises(ValueError):
      query_trace_list(
          self._ROWS,
          self._COLS,
          [],
          [],
          limit=10,
          projected_columns=['no_such_col'],
      )

  def test_projection_empty_list_raises(self):
    # An explicit empty mask is almost always a client bug — better
    # to 400 than silently return an empty row shape.
    from db import query_trace_list
    with self.assertRaises(ValueError):
      query_trace_list(
          self._ROWS, self._COLS, [], [], limit=10, projected_columns=[])

  def test_projection_duplicates_raise(self):
    from db import query_trace_list
    with self.assertRaises(ValueError):
      query_trace_list(
          self._ROWS,
          self._COLS,
          [],
          [],
          limit=10,
          projected_columns=['file_name', 'file_name'],
      )

  def test_projection_non_list_raises(self):
    from db import query_trace_list
    with self.assertRaises(ValueError):
      query_trace_list(
          self._ROWS,
          self._COLS,
          [],
          [],
          limit=10,
          projected_columns='file_name',  # type: ignore[arg-type]
      )


# ---------------------------------------------------------------------------
# Metadata sidecar + fetch_paginated projection / JOIN
# ---------------------------------------------------------------------------


class MetadataSidecarTest(unittest.TestCase):
  """End-to-end through the Database class: create a fake result
    table, populate the sidecar, then read back via fetch_paginated
    with various column projections (including filter / order_by /
    pagination interactions across the JOIN)."""

  def setUp(self):
    from db import Database
    import tempfile
    self._tmp = tempfile.mkdtemp(prefix='db_meta_sidecar_unittest_')
    import os
    self._db = Database(os.path.join(self._tmp, 'state.duckdb'))
    self._uuid = 'abc-1234'
    # Materialize a tiny result table with 3 rows for 2 traces, then
    # seed the metadata sidecar so trace_id 'a' has file_name='a.pftrace',
    # size_bytes=100; and 'b' has file_name='b.pftrace', size_bytes=2000.
    self._db.insert_qe_in_progress(
        self._uuid,
        'SELECT name, dur FROM slice LIMIT 100',
        query_limit=100,
        materialized=True,
    )
    self._db.merge_trace_atomic(
        self._uuid,
        trace_id='a',
        user_columns=['name', 'dur'],
        sample_row=['evt', 10],
        prefixed_rows=[['a', 'evt1', 10], ['a', 'evt2', 20]],
        global_limit=0,
    )
    self._db.merge_trace_atomic(
        self._uuid,
        trace_id='b',
        user_columns=['name', 'dur'],
        sample_row=['evt', 10],
        prefixed_rows=[['b', 'evt3', 30]],
        global_limit=0,
    )
    self._db.create_metadata_sidecar(
        self._uuid,
        column_types=[
            ('trace_id', 'VARCHAR'),
            ('file_name', 'VARCHAR'),
            ('size_bytes', 'BIGINT'),
        ],
        rows=[
            ('a', 'a.pftrace', 100),
            ('b', 'b.pftrace', 2000),
        ],
    )

  def tearDown(self):
    self._db.close()
    import shutil
    shutil.rmtree(self._tmp, ignore_errors=True)

  def test_no_projection_returns_only_result_columns(self):
    # The legacy / default path: no `columns` param, no sidecar JOIN.
    # Response columns = result table columns only.
    cols, rows, total, available = self._db.fetch_paginated(
        self._uuid, limit=100, offset=0)
    self.assertEqual(cols, ['trace_id', 'name', 'dur'])
    self.assertEqual(total, 3)
    self.assertEqual(len(rows), 3)
    # availableColumns lists the union — result + sidecar — so the
    # UI can offer sidecar cols even when the current projection
    # doesn't include them.
    self.assertEqual(
        set(available), {'trace_id', 'name', 'dur', 'file_name', 'size_bytes'})

  def test_projection_to_result_columns_only(self):
    cols, rows, _, _ = self._db.fetch_paginated(
        self._uuid,
        limit=100,
        offset=0,
        projected_columns=['name'],
    )
    self.assertEqual(cols, ['name'])
    for r in rows:
      self.assertEqual(len(r), 1)

  def test_projection_includes_sidecar_columns(self):
    # Asking for a sidecar column joins it in.
    cols, rows, _, _ = self._db.fetch_paginated(
        self._uuid,
        limit=100,
        offset=0,
        projected_columns=['trace_id', 'name', 'file_name', 'size_bytes'],
    )
    self.assertEqual(cols, ['trace_id', 'name', 'file_name', 'size_bytes'])
    by_trace = {r[0]: r for r in rows}
    # Two distinct traces, three rows total. Every row in trace `a`
    # carries file_name='a.pftrace', size_bytes=100.
    self.assertEqual(by_trace['a'][2], 'a.pftrace')
    self.assertEqual(by_trace['a'][3], 100)
    self.assertEqual(by_trace['b'][2], 'b.pftrace')
    self.assertEqual(by_trace['b'][3], 2000)

  def test_filter_on_sidecar_column_applies_via_join(self):
    # Filter references a sidecar column; the JOIN must be emitted
    # even though the projection asks only for result-table columns.
    cols, rows, total, _ = self._db.fetch_paginated(
        self._uuid,
        limit=100,
        offset=0,
        filter_str='[{"field":"size_bytes","op":">","value":"500"}]',
        projected_columns=['name'],
    )
    self.assertEqual(cols, ['name'])
    # Only trace 'b' has size_bytes > 500; that's one row.
    self.assertEqual(total, 1)
    self.assertEqual(len(rows), 1)
    self.assertEqual(rows[0][0], 'evt3')

  def test_order_by_sidecar_column_applies_via_join(self):
    # ORDER BY references a sidecar column; the JOIN must be in play
    # so the sort can read it.
    cols, rows, _, _ = self._db.fetch_paginated(
        self._uuid,
        limit=100,
        offset=0,
        order_by='size_bytes desc',
        projected_columns=['name'],
    )
    # Trace 'b' rows (size_bytes=2000) come first; trace 'a' rows
    # (size_bytes=100) follow.
    names = [r[0] for r in rows]
    self.assertEqual(names[0], 'evt3')

  def test_unknown_projected_column_raises(self):
    with self.assertRaises(ValueError):
      self._db.fetch_paginated(
          self._uuid,
          limit=10,
          offset=0,
          projected_columns=['no_such_col'],
      )

  def test_empty_projection_raises(self):
    with self.assertRaises(ValueError):
      self._db.fetch_paginated(
          self._uuid, limit=10, offset=0, projected_columns=[])

  def test_duplicate_projection_raises(self):
    with self.assertRaises(ValueError):
      self._db.fetch_paginated(
          self._uuid,
          limit=10,
          offset=0,
          projected_columns=['name', 'name'],
      )

  def test_drop_lifecycle_drops_sidecar(self):
    # _drop_materialized_locked drops both tables. Verify via
    # information_schema that the sidecar disappears alongside the
    # result table when we soft-delete the row.
    import duckdb as _duckdb
    self._db.mark_success(self._uuid, processed_rows=3)
    self._db.soft_delete(self._uuid)
    # Both tables should be gone.
    self.assertRaises(
        (_duckdb.CatalogException, ValueError),
        self._db.fetch_paginated,
        self._uuid,
        10,
        0,
    )


if __name__ == '__main__':
  unittest.main(verbosity=2)
