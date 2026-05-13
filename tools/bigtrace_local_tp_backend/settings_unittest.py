# Copyright (C) 2026 The Android Open Source Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""Unit tests for the settings extraction in `settings.py`.

The two public functions (`trace_limit`, `trace_directory`) both
delegate to `_first_setting_value`. These tests pin:
  - the snake_case `setting_id` wire-format (camelCase `settingId`
    must NOT be honored — TODO.md §"Test coverage" item B8);
  - default-value fallbacks when a setting is absent / empty;
  - type coercion edge cases for `trace_limit`.

(`trace_filter` is no longer a setting — it lives as a top-level
structured field on `/execute_*` and `/list_traces`. See
server.py:_parse_trace_filter_or_400 + db.parse_filter.)

Run:
    .venv/bin/python -m unittest settings_unittest -v
"""

from __future__ import annotations

import unittest

from settings import (
    EXECUTION_SETTINGS,
    TRACE_METADATA_SETTINGS,
    _first_setting_value,
    trace_directory,
    trace_limit,
)


class FirstSettingValueTest(unittest.TestCase):
  """The shared lookup primitive. The three public extractors all
    funnel through this, so its contract is what they collectively
    pin."""

  def test_returns_first_value_for_matching_setting_id(self):
    settings = [
        {
            'setting_id': 'foo',
            'values': ['x']
        },
        {
            'setting_id': 'bar',
            'values': ['y']
        },
    ]
    self.assertEqual(_first_setting_value(settings, 'foo'), 'x')
    self.assertEqual(_first_setting_value(settings, 'bar'), 'y')

  def test_returns_none_when_setting_id_absent(self):
    self.assertIsNone(_first_setting_value([], 'foo'))
    self.assertIsNone(
        _first_setting_value([{
            'setting_id': 'bar',
            'values': ['y']
        }], 'foo'))

  def test_returns_none_for_empty_values_list(self):
    settings = [{'setting_id': 'foo', 'values': []}]
    self.assertIsNone(_first_setting_value(settings, 'foo'))

  def test_returns_none_when_values_key_missing(self):
    settings = [{'setting_id': 'foo'}]
    self.assertIsNone(_first_setting_value(settings, 'foo'))

  def test_returns_none_when_values_is_not_a_list(self):
    # Defensive against malformed input — a hand-rolled client might
    # send a single string or dict by mistake. The helper rejects.
    settings = [{'setting_id': 'foo', 'values': 'not-a-list'}]
    self.assertIsNone(_first_setting_value(settings, 'foo'))

  def test_camelcase_setting_id_is_ignored(self):
    # TODO.md §B8: legacy camelCase `settingId` was silently
    # honored by an earlier version of the backend, masking a real
    # bug where changing Trace Directory in the UI did nothing.
    # Lookup is now strictly snake_case `setting_id`.
    settings = [{'settingId': 'foo', 'values': ['x']}]
    self.assertIsNone(_first_setting_value(settings, 'foo'))

  def test_other_keys_are_ignored(self):
    settings = [{'id': 'foo', 'values': ['x']}]
    self.assertIsNone(_first_setting_value(settings, 'foo'))

  def test_falsy_first_value_returns_none(self):
    # Documented: `'', 0, None` as values[0] are interpreted as
    # absent. The caller handles "default for missing" uniformly.
    for v in ('', 0, None):
      with self.subTest(v=v):
        settings = [{'setting_id': 'foo', 'values': [v]}]
        self.assertIsNone(_first_setting_value(settings, 'foo'))

  def test_none_settings_returns_none(self):
    # The signature accepts list[dict], but defensive against
    # `body.get('settings', [])` returning None on a hand-rolled
    # client that explicitly POSTs `{"settings": null}`.
    self.assertIsNone(_first_setting_value(None,
                                           'foo'))  # type: ignore[arg-type]

  def test_first_match_wins(self):
    # Duplicates aren't expected on the wire, but if they appear,
    # the first one is used (matches dict-merge semantics).
    settings = [
        {
            'setting_id': 'foo',
            'values': ['first']
        },
        {
            'setting_id': 'foo',
            'values': ['second']
        },
    ]
    self.assertEqual(_first_setting_value(settings, 'foo'), 'first')


class TraceLimitTest(unittest.TestCase):
  """Coerces to int; 0 sentinel = uncapped; malformed = 0."""

  def test_returns_int_when_set(self):
    self.assertEqual(
        trace_limit([{
            'setting_id': 'trace_limit',
            'values': [42]
        }]), 42)

  def test_string_value_coerces_to_int(self):
    # The UI ships strings (always-strings filter wire convention);
    # int() coerces them.
    self.assertEqual(
        trace_limit([{
            'setting_id': 'trace_limit',
            'values': ['100']
        }]), 100)

  def test_zero_when_absent(self):
    # 0 is the documented "no cap" sentinel.
    self.assertEqual(trace_limit([]), 0)

  def test_negative_clamped_to_zero(self):
    # `max(0, int(v))` — negative makes no sense, treat as no-cap.
    self.assertEqual(
        trace_limit([{
            'setting_id': 'trace_limit',
            'values': [-5]
        }]), 0)

  def test_malformed_value_returns_zero(self):
    # Non-numeric string → 0 (don't crash the request).
    self.assertEqual(
        trace_limit([{
            'setting_id': 'trace_limit',
            'values': ['not-a-number']
        }]), 0)

  def test_explicit_zero_returns_zero(self):
    # Explicit 0 is the "no cap" sentinel; treat the same as absent.
    self.assertEqual(
        trace_limit([{
            'setting_id': 'trace_limit',
            'values': [0]
        }]), 0)

  def test_camelcase_setting_id_falls_through_to_zero(self):
    self.assertEqual(
        trace_limit([{
            'settingId': 'trace_limit',
            'values': [50]
        }]), 0)


class TraceDirectoryTest(unittest.TestCase):
  """Returns '' when absent — caller treats empty as 'no path
    configured' and returns 400. No server-side fallback."""

  def test_returns_path_when_set(self):
    self.assertEqual(
        trace_directory([{
            'setting_id': 'trace_directory',
            'values': ['/home/user/traces']
        }]),
        '/home/user/traces',
    )

  def test_empty_string_when_absent(self):
    self.assertEqual(trace_directory([]), '')

  def test_empty_string_when_value_is_empty(self):
    # The setting is technically present but value is empty —
    # fall through to the missing-path handling at the caller.
    self.assertEqual(
        trace_directory([{
            'setting_id': 'trace_directory',
            'values': ['']
        }]),
        '',
    )

  def test_camelcase_setting_id_falls_through_to_empty(self):
    self.assertEqual(
        trace_directory([{
            'settingId': 'trace_directory',
            'values': ['/home/user/traces']
        }]),
        '',
    )


class ExecutionSettingsSchemaTest(unittest.TestCase):
  """The static schema returned from `/bigtrace_execution_config`.
    A real backend stores this differently; the local TP backend
    hardcodes it. Pin the structural invariants the UI depends on."""

  def test_includes_two_known_settings(self):
    # `trace_filter` is deliberately absent — it was promoted to a
    # top-level structured field on /execute_* + /list_traces, not
    # a setting. The smoke + ResolveTracesForTest pin that path.
    ids = {s['id'] for s in EXECUTION_SETTINGS}
    self.assertEqual(ids, {'trace_directory', 'trace_limit'})

  def test_trace_directory_has_empty_default(self):
    # No CLI fallback — the client must supply trace_directory on
    # every request. Smoke step [1] enforces this; pinning here
    # so a future tweak can't silently introduce a default.
    td = next(s for s in EXECUTION_SETTINGS if s['id'] == 'trace_directory')
    self.assertEqual(td['plainString']['defaultValue'], '')

  def test_each_setting_has_required_metadata_fields(self):
    for s in EXECUTION_SETTINGS:
      with self.subTest(setting_id=s['id']):
        # The UI's BigTraceSettingsService relies on these fields.
        for required in ('id', 'name', 'description', 'category', 'disabled'):
          self.assertIn(required, s)

  def test_trace_metadata_settings_is_empty(self):
    # Local TP backend has no indexer; metadata settings list
    # is documented as empty. The UI collapses the section in
    # that case.
    self.assertEqual(TRACE_METADATA_SETTINGS, [])


if __name__ == '__main__':
  unittest.main(verbosity=2)
