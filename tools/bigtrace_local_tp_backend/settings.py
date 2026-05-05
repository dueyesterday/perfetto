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

`trace_filter` (regex over filenames) and `trace_directory` (the on-disk dir
to read trace files from) are honored by the executor; the rest are surfaced
for parity but are otherwise no-ops in this backend. See the comments
alongside each entry for why.

NOTE: `trace_directory` is a local-dev-only convenience that lets a user pick
a different directory at runtime via the BigTrace settings UI. Exposing
arbitrary filesystem paths through an HTTP setting would be UNSAFE in any
multi-tenant deployment — never port this verbatim into a real BigTrace
backend. It's safe here because this server is intended to be run against
localhost by a single developer.
"""

from typing import Any

# Mutable holder populated by server.py at startup so the EXECUTION_SETTINGS
# defaultValue for `trace_directory` reflects the user's --traces-dir CLI
# value, and so trace_directory() can fall back to it when the request omits
# the setting or sends an empty string.
_state: dict[str, str] = {'default_trace_directory': ''}


EXECUTION_SETTINGS: list[dict[str, Any]] = [
    {
        # The only setting that actually does work in this backend.
        # query_executor.py applies it as a regex filter against filenames in
        # the configured --traces-dir.
        'id': 'trace_filter',
        'name': 'Trace Filter',
        'description': 'Filter traces by regex pattern (matched against filename)',
        'disabled': False,
        'category': 'TRACE_ADDRESS',
        'plainString': {'defaultValue': '.*'},
    },
    {
        # Local-dev-only: lets a user point the backend at a different
        # directory on the same machine without restarting the server. The
        # default value is the CLI --traces-dir; server.py overwrites it at
        # startup via set_default_trace_directory().
        'id': 'trace_directory',
        'name': 'Trace Directory',
        'description': (
            'Filesystem path the backend reads .pftrace/.pb files from. '
            'Re-resolved on every query.'
        ),
        'disabled': False,
        'category': 'TRACE_ADDRESS',
        'plainString': {'defaultValue': ''},
    },
    {
        # Caps the number of trace files processed per query, applied AFTER
        # `trace_filter` narrows the candidates. With 200 matching traces
        # and trace_limit=20, only the first 20 (alphabetical order from
        # `list_matching_traces`) are scheduled. 0 disables the cap.
        'id': 'trace_limit',
        'name': 'Trace Limit',
        'description': (
            'Maximum number of traces to process. Applied after Trace '
            'Filter; ignored if 0.'
        ),
        'disabled': False,
        'category': 'TRACE_ADDRESS',
        'number': {'defaultValue': 100, 'min': 1, 'max': 10000},
    },
]


# A real BigTrace deployment populates this from an indexer that pre-extracts
# device/Android metadata from each trace and exposes it as filter chips.
# This local backend has no indexer and no way to filter by trace contents,
# so the list is empty. The /trace_metadata_settings endpoint still exists
# (the UI calls it unconditionally) but returns no settings, and the UI
# collapses the "Trace Metadata" section accordingly.
TRACE_METADATA_SETTINGS: list[dict[str, Any]] = []


def set_default_trace_directory(path: str) -> None:
    """Record the CLI-supplied trace directory as the runtime default.

    Called by server.py once argparse is done. Also updates the
    `trace_directory` entry in EXECUTION_SETTINGS so the UI's settings page
    shows the CLI value as the pre-populated default.
    """
    _state['default_trace_directory'] = path
    for s in EXECUTION_SETTINGS:
        if s.get('id') == 'trace_directory':
            s['plainString'] = {'defaultValue': path}
            break


def get_default_trace_directory() -> str:
    return _state['default_trace_directory']


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

    Falls back to the CLI default (set via set_default_trace_directory)
    when the setting is missing or the value is empty. Wire-format key
    is `setting_id` (snake_case) — see `trace_filter_regex` for the
    rationale.
    """
    for s in settings or []:
        if s.get('setting_id') == 'trace_directory':
            values = s.get('values') or []
            if values and isinstance(values, list) and values[0]:
                return str(values[0])
    return _state['default_trace_directory']
