# Copyright (C) 2026 The Android Open Source Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""Static settings schema for the local TP backend.

The shape mirrors what the mock at tools/bigtrace_ref_backend/server.py returns
from /bigtrace_execution_config and /trace_metadata_settings, so the same UI
client can speak to both backends without modification.

The traces directory is supplied by the client on every request via the
`trace_directory` setting (set in the BigTrace UI Settings page). The
server has no startup-time fallback. `trace_limit` caps the number of
traces processed per query (applied AFTER the top-level structured
`trace_filters` field — see server._resolve_traces_for).

NOTE: `trace_directory` exposes an arbitrary filesystem path through an
HTTP setting, which is UNSAFE in any multi-tenant deployment. This
backend is local-dev-only — single developer, localhost — and must
never be ported verbatim into a real BigTrace backend.
"""

from typing import Any

EXECUTION_SETTINGS: list[dict[str, Any]] = [
    {
        # On-disk directory the backend reads trace files from. Picked
        # by the user in the BigTrace UI; sent verbatim on every
        # request. Not persisted server-side.
        'id': 'trace_directory',
        'name': 'Trace Directory',
        'description':
            ('Filesystem path the backend reads .pftrace/.pb files from. '
             'Re-resolved on every query.'),
        'disabled': False,
        'category': 'TRACE_ADDRESS',
        'plainString': {
            'defaultValue': ''
        },
    },
    {
        # Caps the number of trace files processed per query, applied AFTER
        # the structured top-level `trace_filters` field narrows the
        # candidates. With 200 matching traces and trace_limit=20, only
        # the first 20 (alphabetical by file_path) are scheduled. 0
        # disables the cap.
        'id': 'trace_limit',
        'name': 'Trace Limit',
        'description':
            ('Maximum number of traces to process. Applied after the '
             'trace grid filter; ignored if 0.'),
        'disabled': False,
        'category': 'TRACE_ADDRESS',
        'number': {
            'defaultValue': 100,
            'min': 1,
            'max': 10000
        },
    },
    {
        # A boolean BigTrace query option. When on, a trace that fails to
        # load (or whose SQL errors) is logged as a warning and skipped
        # instead of surfacing as the query error; with it off (the
        # default), a query whose every trace fails reports the first
        # error. See query_executor.RunContext.treat_errors_as_warning.
        'id': 'treat_trace_errors_as_warning',
        'name': 'Treat trace errors as warnings',
        'description':
            ('When enabled, a trace that fails to load or errors during the '
             'query is skipped with a warning instead of failing the query.'),
        'disabled': False,
        'category': 'BIGTRACE_QUERY_OPTIONS',
        'booleanOptions': {
            'defaultValue': False
        },
    },
]

# A real BigTrace deployment populates this from an indexer that pre-extracts
# device/Android metadata from each trace and exposes it as filter chips.
# This local backend has no indexer and no way to filter by trace contents,
# so the list is empty. The /trace_metadata_settings endpoint still exists
# (the UI calls it unconditionally) but returns no settings, and the UI
# collapses the "Trace Metadata" section accordingly.
TRACE_METADATA_SETTINGS: list[dict[str, Any]] = []


def _first_setting_value(
    settings: list[dict[str, Any]],
    setting_id: str,
) -> Any:
  """Look up a setting by `setting_id` and return `values[0]`.

    Returns None if missing, empty, or `values[0]` is falsy.
    Strict snake_case match — `settingId`/`id` are ignored.
    """
  for s in settings or []:
    if s.get('setting_id') == setting_id:
      values = s.get('values') or []
      if values and isinstance(values, list) and values[0]:
        return values[0]
  return None


def trace_limit(settings: list[dict[str, Any]]) -> int:
  """Pull the `trace_limit` cap out of a settings request body.

    Returns 0 when the setting is missing, malformed, or set to 0
    explicitly — both meanings collapsed to "no cap" because the UI
    has no way to express "unlimited" except sending the default or
    omitting the setting entirely. The caller should treat the
    returned value as "if > 0, truncate the trace list to this many".
    """
  v = _first_setting_value(settings, 'trace_limit')
  if v is None:
    return 0
  try:
    return max(0, int(v))
  except (TypeError, ValueError):
    return 0


def trace_directory(settings: list[dict[str, Any]]) -> str:
  """Pull the `trace_directory` path out of a settings request body.

    Returns '' when the setting is missing or empty — the caller
    (`server._resolve_trace_dir`) translates that into a 400 response.
    """
  v = _first_setting_value(settings, 'trace_directory')
  return str(v) if v is not None else ''


def treat_trace_errors_as_warning(settings: list[dict[str, Any]]) -> bool:
  """Whether per-trace load/query failures are downgraded to warnings.

    The BIGTRACE_QUERY_OPTIONS boolean of the same id. Booleans ride the
    always-strings wire as 'true'/'false'; a real bool is accepted too.
    Missing / anything else (incl. a non-list body) → False, the default:
    a failing trace surfaces as the query error when every trace fails.
    """
  if not isinstance(settings, list):
    return False
  v = _first_setting_value(settings, 'treat_trace_errors_as_warning')
  if isinstance(v, bool):
    return v
  return isinstance(v, str) and v.strip().lower() == 'true'
