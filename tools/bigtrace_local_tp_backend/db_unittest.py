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


if __name__ == '__main__':
  unittest.main(verbosity=2)
