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
server has no startup-time fallback. `trace_filter` (regex over
filenames) and `trace_limit` are also honored by the executor.

NOTE: `trace_directory` exposes an arbitrary filesystem path through an
HTTP setting, which is UNSAFE in any multi-tenant deployment. This
backend is local-dev-only — single developer, localhost — and must
never be ported verbatim into a real BigTrace backend.
"""

from typing import Any

EXECUTION_SETTINGS: list[dict[str, Any]] = [
    {
        # Regex over filenames in the chosen `trace_directory`.
        # query_executor.list_matching_traces narrows the candidate
        # set with this before fanning out.
        'id':
            'trace_filter',
        'name':
            'Trace Filter',
        'description':
            'Filter traces by regex pattern (matched against filename)',
        'disabled':
            False,
        'category':
            'TRACE_ADDRESS',
        'plainString': {
            'defaultValue': '.*'
        },
    },
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
        # `trace_filter` narrows the candidates. With 200 matching traces
        # and trace_limit=20, only the first 20 (alphabetical order from
        # `list_matching_traces`) are scheduled. 0 disables the cap.
        'id': 'trace_limit',
        'name': 'Trace Limit',
        'description':
            ('Maximum number of traces to process. Applied after Trace '
             'Filter; ignored if 0.'),
        'disabled': False,
        'category': 'TRACE_ADDRESS',
        'number': {
            'defaultValue': 100,
            'min': 1,
            'max': 10000
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


def trace_filter_regex(settings: list[dict[str, Any]]) -> str:
  """Pull the `trace_filter` regex out of a settings request body.

    Defaults to '.*' (match everything) if not supplied or if the value
    is empty. The wire-format key is `setting_id` (snake_case) — what
    the BigTrace UI emits and what `~/Projects/CLAUDE.md` documents.
    Strict matching: any other key (e.g. `settingId`, `id`) is ignored.
    """
  for s in settings or []:
    if s.get('setting_id') == 'trace_filter':
      values = s.get('values') or []
      if values and isinstance(values, list) and values[0]:
        return str(values[0])
  return '.*'


def trace_limit(settings: list[dict[str, Any]]) -> int:
  """Pull the `trace_limit` cap out of a settings request body.

    Returns 0 when the setting is missing, malformed, or set to 0
    explicitly — both meanings collapsed to "no cap" because the UI
    has no way to express "unlimited" except sending the default or
    omitting the setting entirely. The caller should treat the
    returned value as "if > 0, truncate the trace list to this many".
    """
  for s in settings or []:
    if s.get('setting_id') == 'trace_limit':
      values = s.get('values') or []
      if values and isinstance(values, list):
        try:
          return max(0, int(values[0]))
        except (TypeError, ValueError):
          return 0
  return 0


def trace_directory(settings: list[dict[str, Any]]) -> str:
  """Pull the `trace_directory` path out of a settings request body.

    Returns '' when the setting is missing or empty — the caller
    (`server._resolve_trace_dir`) translates that into a 400 response.
    Wire-format key is `setting_id` (snake_case) — see
    `trace_filter_regex` for the rationale.
    """
  for s in settings or []:
    if s.get('setting_id') == 'trace_directory':
      values = s.get('values') or []
      if values and isinstance(values, list) and values[0]:
        return str(values[0])
  return ''
