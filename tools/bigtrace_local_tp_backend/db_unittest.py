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

from db import (
    ParsedFilter,
    compile_where,
    parse_filter,
    parse_order_by,
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


if __name__ == '__main__':
  unittest.main(verbosity=2)
