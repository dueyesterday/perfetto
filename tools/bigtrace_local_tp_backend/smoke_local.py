#!/usr/bin/env python3
# Copyright (C) 2026 The Android Open Source Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
"""Smoke test for the local TP backend.

Boots the server against a directory of trace files, exercises every
endpoint, and asserts the basics work. Skips with a clear message if no
trace files are available.

Run:
    .venv/bin/python smoke_local.py [--traces-dir DIR]

If --traces-dir isn't given, the script tries
~/Projects/perfetto/test/data which has plenty of small traces in this
checkout.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PERFETTO_DATA = os.path.expanduser('~/Projects/perfetto/test/data')

PORT = 18002
DATASETTE_PORT = 18103
BASE = f'http://127.0.0.1:{PORT}'
DS_BASE = f'http://127.0.0.1:{DATASETTE_PORT}'


def http(method: str, path: str, body=None, timeout: float = 30.0):
  data = None
  headers = {'content-type': 'application/json'}
  if body is not None:
    data = json.dumps(body).encode('utf-8')
  req = urllib.request.Request(
      BASE + path, data=data, headers=headers, method=method)
  with urllib.request.urlopen(req, timeout=timeout) as resp:
    raw = resp.read()
    return resp.status, json.loads(raw) if raw else None


def http_status(method: str, path: str, body=None) -> int:
  """Like http() but returns the status code even for non-2xx."""
  data = None
  headers = {'content-type': 'application/json'}
  if body is not None:
    data = json.dumps(body).encode('utf-8')
  req = urllib.request.Request(
      BASE + path, data=data, headers=headers, method=method)
  try:
    with urllib.request.urlopen(req, timeout=30) as resp:
      return resp.status
  except urllib.error.HTTPError as e:
    return e.code


def http_status_and_body(method: str, path: str, body=None) -> tuple[int, str]:
  """Like http_status() but also returns the response body as text."""
  data = None
  headers = {'content-type': 'application/json'}
  if body is not None:
    data = json.dumps(body).encode('utf-8')
  req = urllib.request.Request(
      BASE + path, data=data, headers=headers, method=method)
  try:
    with urllib.request.urlopen(req, timeout=30) as resp:
      return resp.status, resp.read().decode('utf-8', 'replace')
  except urllib.error.HTTPError as e:
    return e.code, e.read().decode('utf-8', 'replace')


def pick_trace_files(src_dir: str, dst_dir: str, n: int = 2) -> list[str]:
  """Copy up to n smallish trace files from src_dir to dst_dir."""
  candidates = []
  if not os.path.isdir(src_dir):
    return []
  for name in os.listdir(src_dir):
    full = os.path.join(src_dir, name)
    if not os.path.isfile(full):
      continue
    if not (name.endswith(('.pftrace', '.perfetto-trace', '.pb'))):
      continue
    size = os.path.getsize(full)
    # Avoid huge traces — they slow the smoke down a lot.
    if size > 20 * 1024 * 1024:
      continue
    candidates.append((size, full))
  candidates.sort()
  picked = []
  for _size, full in candidates[:n]:
    dst = os.path.join(dst_dir, os.path.basename(full))
    shutil.copy(full, dst)
    picked.append(dst)
  return picked


def wait_until(predicate, timeout: float, label: str):
  deadline = time.time() + timeout
  last_err = None
  while time.time() < deadline:
    try:
      if predicate():
        return
    except Exception as e:  # noqa: BLE001
      last_err = e
    time.sleep(0.5)
  raise TimeoutError(f'timed out waiting for {label}: {last_err}')


def main() -> int:
  p = argparse.ArgumentParser()
  p.add_argument('--traces-dir', default=None)
  p.add_argument(
      '--keep-traces',
      action='store_true',
      help='Do not delete the temp dir on exit')
  args = p.parse_args()

  venv_python = os.path.join(HERE, '.venv/bin/python')
  if not os.path.exists(venv_python):
    print(f'SKIP: no venv at {venv_python}. Run setup_venv.sh first.')
    return 0

  if args.traces_dir:
    traces_dir = args.traces_dir
    cleanup_dir = None
  else:
    tmp = tempfile.mkdtemp(prefix='bigtrace_local_smoke_')
    cleanup_dir = tmp
    files = pick_trace_files(DEFAULT_PERFETTO_DATA, tmp, n=2)
    if not files:
      print(f'SKIP: no trace files found under {DEFAULT_PERFETTO_DATA}.')
      print('Pass --traces-dir to point at a directory containing real traces.')
      shutil.rmtree(tmp, ignore_errors=True)
      return 0
    traces_dir = tmp
    print(f'Using temp traces dir: {tmp}')
    for f in files:
      print(f'  {os.path.basename(f)}  ({os.path.getsize(f):,} bytes)')

  # Smoke runs with a fresh DuckDB file in a temp dir so it never
  # collides with a daily backend's state. Tight TTL (5s) + 1s sweep
  # so the TTL test is fast.
  db_dir = tempfile.mkdtemp(prefix='bigtrace_local_smoke_db_')
  db_path = os.path.join(db_dir, 'state.duckdb')
  server = subprocess.Popen(
      [
          venv_python,
          os.path.join(HERE, 'server.py'), '--port',
          str(PORT), '--db-path', db_path, '--table-ttl-seconds', '5',
          '--table-ttl-sweep-seconds', '1', '--with-datasette',
          str(DATASETTE_PORT), '--log-level', 'warning'
      ],
      stdout=subprocess.PIPE,
      stderr=subprocess.STDOUT,
  )

  # Real UI clients send `trace_directory` in every request's
  # settings array (the BigTrace Settings page persists it in
  # localStorage and re-sends it on every submit). The smoke does
  # the same — no server-side default exists.
  def with_traces(extra=None):
    out = [{
        'setting_id': 'trace_directory',
        'values': [traces_dir],
        'category': 'TRACE_ADDRESS'
    }]
    if extra:
      out.extend(extra)
    return out

  failed = False
  try:
    # Wait for server to come up.
    try:
      wait_until(
          lambda: http('GET', '/query_executions')[0] == 200,
          timeout=15.0,
          label='server up')
    except TimeoutError as e:
      print(f'FAIL: {e}')
      print('--- server output ---')
      try:
        print(server.stdout.read().decode('utf-8', 'replace'))
      except Exception:
        pass
      return 1

    # 1. Settings endpoints.
    print('\n[1] /bigtrace_execution_config')
    _, cfg = http('POST', '/bigtrace_execution_config', body={})
    assert cfg and cfg.get('setting'), f'unexpected: {cfg}'
    ids = sorted(s['id'] for s in cfg['setting'])
    print(f'    settings: {ids}')
    assert 'trace_filter' in ids
    assert 'trace_directory' in ids, (
        f'trace_directory setting missing from /bigtrace_execution_config: {ids}'
    )
    td_setting = next(s for s in cfg['setting'] if s['id'] == 'trace_directory')
    assert 'plainString' in td_setting, (
        f'trace_directory setting must be a plainString, got: {td_setting}')
    td_default = td_setting['plainString'].get('defaultValue')
    assert td_default == '', (
        f'trace_directory defaultValue should be empty (no CLI '
        f'fallback by design), got {td_default!r}')
    print('    trace_directory default: <empty> (client supplies path)')

    print('[2] /trace_metadata_settings')
    _, md = http('POST', '/trace_metadata_settings', body={'settings': []})
    # The local TP backend has no indexer; the endpoint returns an empty
    # list. The contract is "valid {setting: [...]} shape", not "non-empty".
    assert isinstance(md, dict) and isinstance(md.get('setting'), list), (
        f'malformed /trace_metadata_settings response: {md!r}')

    # 2. Sync query.
    print('[3] /execute_bigtrace_query (sync)')
    _, sync = http(
        'POST',
        '/execute_bigtrace_query',
        body={
            'limit': 5,
            'perfetto_sql': 'SELECT 1 AS one',
            'settings': with_traces()
        })
    print(
        f'    columns={sync.get("columnNames")} rows={len(sync.get("rows", []))}'
    )
    assert sync.get('rows'), 'sync query returned no rows'

    # 2a. Sync queries must be logged in the execution list with
    # materialized=false, even though their result rows aren't
    # persisted. The UI's Ephemeral history tab reads from this list.
    _, lst_sync = http('GET', '/query_executions')
    sync_entries = [
        q for q in lst_sync.get('queryExecutions', [])
        if q.get('materialized') is False and q.get('status') == 'SUCCESS'
    ]
    assert sync_entries, (
        'sync query was not logged with materialized=false in '
        '/query_executions — UI Ephemeral tab will be empty')
    sync_uuid = sync_entries[-1]['queryUuid']
    # :fetch_results on a sync UUID must return 404 — sync queries
    # are not materialized so there's no fetchable table. The
    # entry exists, just isn't in a fetchable state — that's
    # FAILED_PRECONDITION (HTTP 400), not NOT_FOUND.
    sync_code, sync_body = http_status_and_body(
        'GET',
        f'/query_executions/{sync_uuid}:fetch_results?limit=10&offset=0',
    )
    assert sync_code == 400, (
        f'sync :fetch_results expected 400 FAILED_PRECONDITION, '
        f'got {sync_code}: {sync_body}')
    assert 'not materialized' in sync_body, (
        f'expected detail to mention "not materialized"; got: {sync_body}')
    print(
        f'    sync logged as {sync_uuid[:8]}... fetch_results=400 (not materialized)'
    )

    # 3a. trace_directory setting end-to-end.
    # (a) missing setting -> 400 (no server-side fallback);
    # (b) setting points at a different sub-dir -> rows from there;
    # (c) setting points at a non-existent dir -> 400.
    # Wire format (per ~/Projects/CLAUDE.md and what the BigTrace UI
    # actually emits): each settings entry is
    # `{setting_id, values, category}` (snake_case). Earlier versions
    # of the backend silently accepted `settingId` too, which masked
    # a real bug where changing Trace Directory in the UI did
    # nothing. Lookup is now strict on `setting_id`.
    print('[3a] trace_directory setting')
    # (a) Missing trace_directory in settings -> 400. The backend has
    # no server-side default for this; clients always supply it.
    code_missing, body_missing = http_status_and_body(
        'POST',
        '/execute_bigtrace_query',
        body={
            'limit': 1,
            'perfetto_sql': 'SELECT 1',
            'settings': []
        },
    )
    assert code_missing == 400, (
        f'expected 400 when trace_directory absent, got {code_missing}: '
        f'{body_missing}')
    assert 'No traces directory' in body_missing or \
           'Trace Directory' in body_missing, (
        f'expected error to mention Trace Directory; got: {body_missing}'
    )
    print(f'    missing trace_directory -> {code_missing}')
    # (b) Build an alternate sub-dir holding one trace and query it.
    alt_dir = os.path.join(traces_dir, 'alt_subdir')
    os.makedirs(alt_dir, exist_ok=True)
    # Copy one trace file from the primary dir into the alt dir.
    src_trace = next(
        (os.path.join(traces_dir, n)
         for n in os.listdir(traces_dir)
         if n.endswith(('.pftrace', '.perfetto-trace', '.pb'))),
        None,
    )
    assert src_trace is not None, (
        f'no trace files in {traces_dir} to copy for trace_directory test')
    alt_trace = os.path.join(alt_dir, os.path.basename(src_trace))
    if not os.path.exists(alt_trace):
      shutil.copy(src_trace, alt_trace)
    _, sync_alt = http(
        'POST',
        '/execute_bigtrace_query',
        body={
            'limit':
                5,
            'perfetto_sql':
                'SELECT name FROM slice LIMIT 3',
            'settings': [{
                'setting_id': 'trace_directory',
                'values': [alt_dir],
                'category': 'TRACE_ADDRESS'
            },],
        },
    )
    rows_alt = sync_alt.get('rows') or []
    assert rows_alt, (
        f'sync query against custom trace_directory returned no rows: {sync_alt}'
    )
    # The first column is trace_id; verify it's the trace we copied.
    cols_alt = sync_alt.get('columnNames') or []
    assert cols_alt and cols_alt[0] == 'trace_id', (
        f'unexpected columns: {cols_alt}')
    expected_tid = os.path.splitext(os.path.basename(alt_trace))[0]
    # Strip multi-extension cases the backend handles.
    for ext in ('.perfetto-trace', '.pftrace', '.pb'):
      if os.path.basename(alt_trace).endswith(ext):
        expected_tid = os.path.basename(alt_trace)[:-len(ext)]
        break
    seen_tids = {r['values'][0] for r in rows_alt}
    assert expected_tid in seen_tids, (
        f'expected trace_id {expected_tid!r} from alt dir, saw {seen_tids}')
    print(
        f'    custom trace_directory={alt_dir!r} -> {len(rows_alt)} rows from {seen_tids}'
    )

    # (c) Non-existent directory must produce a 400 with a useful message.
    bogus = '/does/not/exist'
    code, body_text = http_status_and_body(
        'POST',
        '/execute_bigtrace_query',
        body={
            'limit':
                5,
            'perfetto_sql':
                'SELECT 1',
            'settings': [{
                'setting_id': 'trace_directory',
                'values': [bogus],
                'category': 'TRACE_ADDRESS'
            },],
        },
    )
    assert code == 400, f'expected HTTP 400 for bogus dir, got {code}: {body_text}'
    assert bogus in body_text and 'does not exist' in body_text, (
        f'expected error to mention {bogus!r} and "does not exist"; got: {body_text}'
    )
    print(f'    bogus trace_directory -> {code} {body_text!r}')

    # 3. Async query that should succeed.
    print('[4] /execute_bigtrace_query_async (slice query)')
    _, sub = http(
        'POST',
        '/execute_bigtrace_query_async',
        body={
            'limit':
                10,
            'perfetto_sql':
                'SELECT name, dur FROM slice LIMIT 10',
            'settings':
                with_traces([
                    {
                        'setting_id': 'trace_filter',
                        'values': ['.*'],
                        'category': 'TRACE_ADDRESS'
                    },
                ])
        })
    async_uuid = sub['queryUuid']
    print(f'    uuid={async_uuid}')

    # Poll status.
    def is_terminal():
      _, s = http('GET', f'/query_executions/{async_uuid}:status')
      return s.get('status') in ('SUCCESS', 'FAILED', 'CANCELLED')

    wait_until(is_terminal, timeout=120.0, label='async query terminal state')
    _, st = http('GET', f'/query_executions/{async_uuid}')
    print(
        f'    status={st["status"]} processedTraces={st["processedTraces"]}/{st["totalTraces"]} '
        f'rows={st["processedRows"]}')
    assert st['status'] == 'SUCCESS', f'expected SUCCESS, got {st}'
    assert st['processedRows'] > 0, 'expected some rows'

    # Fetch results.
    print('[5] :fetch_results')
    _, page = http(
        'GET', f'/query_executions/{async_uuid}:fetch_results?limit=5&offset=0')
    assert page.get('rows'), f'no rows in fetch_results: {page}'
    print(f'    columns={page["columnNames"]} rows={len(page["rows"])}')
    assert 'trace_id' in page['columnNames'], 'trace_id column missing'

    # 5a. Streaming guarantees: while an async query is running,
    # `processedTraces` should tick up as worker threads merge their
    # results, and `:fetch_results` should return non-empty rows
    # before the query reaches a terminal state. This is the
    # observable contract of the threaded executor + per-trace
    # atomic merge — a regression here means the merge has been
    # deferred to "after gather" again.
    print('[5a] streaming progress + mid-flight fetch_results')
    _, ssub = http(
        'POST',
        '/execute_bigtrace_query_async',
        body={
            'limit': 200,
            'perfetto_sql': 'SELECT name, dur FROM slice LIMIT 200',
            'settings': with_traces(),
        },
    )
    stream_uuid = ssub['queryUuid']
    observed_inflight_progress = False
    observed_inflight_rows = -1
    # Tight-poll. With ~50ms tp.query() per small trace and pool
    # concurrency 4, total run time is well under a second; sleep
    # 20ms between polls so we capture intermediate states.
    stream_deadline = time.time() + 60
    sst_status: str | None = None
    while time.time() < stream_deadline:
      _, sst_intermediate = http(
          'GET',
          f'/query_executions/{stream_uuid}:status',
      )
      sst_status = sst_intermediate['status']
      if (sst_status == 'IN_PROGRESS' and
          sst_intermediate.get('processedTraces', 0) > 0):
        observed_inflight_progress = True
        if observed_inflight_rows < 0:
          # Fire one mid-flight fetch the first time we see any
          # trace done. Don't keep refetching — racing the
          # worker thread makes the row count nondeterministic.
          _, midpage = http(
              'GET',
              f'/query_executions/{stream_uuid}:fetch_results'
              '?limit=10&offset=0',
          )
          observed_inflight_rows = len(midpage.get('rows') or [])
      if sst_status in ('SUCCESS', 'FAILED', 'CANCELLED'):
        break
      time.sleep(0.02)
    else:
      raise TimeoutError('streaming query never reached terminal')
    _, sst_final = http('GET', f'/query_executions/{stream_uuid}')
    assert sst_final['status'] == 'SUCCESS', (
        f'streaming query expected SUCCESS, got {sst_final}')
    print(f'    final status={sst_final["status"]} processedTraces='
          f'{sst_final["processedTraces"]}/{sst_final["totalTraces"]}')
    if not observed_inflight_progress:
      # Heuristic: if all traces fan-out and complete faster than
      # the 20ms poll window, we never catch an intermediate. That
      # doesn't prove streaming is broken — the test is timing-
      # sensitive — so treat as a soft note rather than a fail.
      print('    NOTE: no intermediate progress snapshot captured '
            '(traces faster than poll cadence) — streaming not asserted')
    else:
      print(f'    observed mid-flight progress; mid-flight '
            f'fetch_results rows={observed_inflight_rows}')
      assert observed_inflight_rows > 0, (
          'mid-flight :fetch_results returned 0 rows while '
          'processedTraces > 0; streaming partial reads are broken')

    # 4. Failing query.
    print('[6] async query that fails (does_not_exist table)')
    _, fail_sub = http(
        'POST',
        '/execute_bigtrace_query_async',
        body={
            'limit': 10,
            'perfetto_sql': 'SELECT * FROM does_not_exist',
            'settings': with_traces()
        })
    fail_uuid = fail_sub['queryUuid']
    wait_until(
        lambda: http('GET', f'/query_executions/{fail_uuid}:status')[1][
            'status'] in ('FAILED', 'SUCCESS', 'CANCELLED'),
        timeout=60.0,
        label='failed query terminal',
    )
    _, fst = http('GET', f'/query_executions/{fail_uuid}')
    print(f'    status={fst["status"]} errorMessage={fst.get("errorMessage")}')
    assert fst['status'] == 'FAILED', f'expected FAILED, got {fst["status"]}'
    assert fst.get('errorMessage'), 'no error message on failed query'
    # FAILED queries clear tableName, so :fetch_results returns
    # 400 FAILED_PRECONDITION ("no longer has a materialized
    # table"). Belt-and-braces with the UI's tableName guard.
    assert fst.get('tableName') is None, (
        f'FAILED query must have tableName=None, got {fst.get("tableName")}')
    fcode, fbody = http_status_and_body(
        'GET',
        f'/query_executions/{fail_uuid}:fetch_results?limit=10&offset=0',
    )
    assert fcode == 400, (
        f'FAILED :fetch_results expected 400 FAILED_PRECONDITION, '
        f'got {fcode}: {fbody}')
    print(f'    FAILED fetch_results=400 (tableName cleared on failure)')

    # 5. Cancellation.
    print('[7] cancel mid-flight')
    # Use a query that takes some time; a heavy join across all slices
    # is usually slow enough to cancel. If the trace is tiny, this may
    # complete before we cancel; we handle either outcome.
    _, csub = http(
        'POST',
        '/execute_bigtrace_query_async',
        body={
            'limit': 1_000_000,
            'perfetto_sql': 'SELECT s1.name, s2.name FROM slice s1, slice s2 '
                            'LIMIT 1000000',
            'settings': with_traces()
        })
    cancel_uuid = csub['queryUuid']
    # Give it just a moment to start.
    time.sleep(0.2)
    code = http_status('POST', f'/query_executions/{cancel_uuid}:cancel')
    print(f'    cancel returned {code}')
    wait_until(
        lambda: http('GET', f'/query_executions/{cancel_uuid}:status')[1][
            'status'] in ('CANCELLED', 'SUCCESS', 'FAILED'),
        timeout=120.0,
        label='cancelled query terminal',
    )
    _, cst = http('GET', f'/query_executions/{cancel_uuid}')
    print(f'    final status={cst["status"]}')
    # We accept SUCCESS too — the trace might be too small to cancel
    # in time. The guarantee is "cancel doesn't wedge the server".
    assert cst['status'] in ('CANCELLED', 'SUCCESS', 'FAILED')

    # 7a. Partials-on-cancel: a CANCELLED query keeps the rows from
    # traces that fully merged before cancel landed, and exposes them
    # as a materialized table just like SUCCESS would. The contract:
    #   status == CANCELLED, processedRows > 0, tableName/Link set,
    #   :fetch_results returns the partial rows.
    # Race note: if the run finishes naturally before we cancel, we
    # silently skip the partials assertion — the lock-based "rows
    # frozen by handler return" guarantee isn't testable in that case.
    print('[7a] partials preserved on cancel')
    _, psub = http(
        'POST',
        '/execute_bigtrace_query_async',
        body={
            'limit': 100_000,
            'perfetto_sql': 'SELECT s1.name, s2.dur FROM slice s1, '
                            'slice s2 LIMIT 100000',
            'settings': with_traces()
        })
    partial_uuid = psub['queryUuid']
    # Wait for at least one trace to finish merging before cancelling
    # so we have non-trivial partials. Bound the wait so a fast/empty
    # corner case doesn't wedge the smoke.
    partials_deadline = time.time() + 60
    saw_progress = False
    ps_status = 'IN_PROGRESS'
    while time.time() < partials_deadline:
      _, ps = http(
          'GET',
          f'/query_executions/{partial_uuid}:status',
      )
      ps_status = ps['status']
      if ps_status != 'IN_PROGRESS':
        break
      if ps.get('processedTraces', 0) > 0:
        saw_progress = True
        break
      time.sleep(0.05)
    if not saw_progress:
      print(f'    NOTE: no partials before terminal '
            f'({ps_status}) — partials assertion skipped')
    else:
      code = http_status('POST', f'/query_executions/{partial_uuid}:cancel')
      assert code == 200, f'cancel returned {code}'
      wait_until(
          lambda: http('GET', f'/query_executions/{partial_uuid}:status')[1][
              'status'] in ('CANCELLED', 'SUCCESS', 'FAILED'),
          timeout=120.0,
          label='partials cancel terminal',
      )
      _, pst = http('GET', f'/query_executions/{partial_uuid}')
      print(f'    final status={pst["status"]} '
            f'processedRows={pst["processedRows"]} '
            f'tableName={pst.get("tableName")}')
      if pst['status'] == 'SUCCESS':
        # Cancel raced the natural completion. Rare; the run
        # finished in the cancel-handler-queueing window. The
        # partials guarantee isn't testable here.
        print('    NOTE: cancel raced natural completion; '
              'partials guarantee not exercised this run')
      else:
        assert pst['status'] == 'CANCELLED', (
            f'expected CANCELLED, got {pst["status"]}')
        assert pst['processedRows'] > 0, (
            'CANCELLED with 0 rows; partials guarantee broken')
        assert pst.get('tableName'), (
            'CANCELLED partials must set tableName (materialized)')
        assert pst.get('tableLink'), (
            'CANCELLED partials must set tableLink (materialized)')
        _, ppage = http(
            'GET',
            f'/query_executions/{partial_uuid}:fetch_results'
            '?limit=10&offset=0',
        )
        assert ppage.get('rows'), (
            'CANCELLED partials :fetch_results returned no rows')
        print(f'    fetched {len(ppage["rows"])} partial rows OK')

    # 6. List response truncates long SQL but per-UUID detail returns full.
    # The sync endpoint logs the query as a non-materialized execution we
    # can fetch by UUID — we use async here just because it returns the
    # UUID directly in the response body.
    print('[8] list truncation: long SQL clipped, detail returns full')
    long_sql = 'SELECT name FROM slice WHERE name = "' + 'x' * 400 + '"'
    _, lsub = http(
        'POST',
        '/execute_bigtrace_query_async',
        body={
            'limit': 1,
            'perfetto_sql': long_sql,
            'settings': with_traces()
        })
    long_uuid = lsub['queryUuid']
    wait_until(
        lambda: http('GET', f'/query_executions/{long_uuid}:status')[1][
            'status'] in ('SUCCESS', 'FAILED', 'CANCELLED'),
        timeout=60.0,
        label='long-sql query terminal',
    )
    _, lst3 = http('GET', '/query_executions')
    listed = next(
        q for q in lst3['queryExecutions'] if q['queryUuid'] == long_uuid)
    assert listed['perfettoSql'].endswith('…'), \
        f'expected ellipsis, got {listed["perfettoSql"][-5:]!r}'
    assert len(listed['perfettoSql']) <= 210, \
        f'truncated text too long: {len(listed["perfettoSql"])}'
    _, det = http('GET', f'/query_executions/{long_uuid}')
    assert det['perfettoSql'] == long_sql, \
        'detail endpoint returned non-full SQL'
    print(f'    list len={len(listed["perfettoSql"])}, '
          f'detail len={len(det["perfettoSql"])}, OK')

    # 7. List + soft delete.
    # DELETE flips `deleted=true` in DuckDB; the metadata row stays
    # for audit but the entry is hidden from the list and every
    # per-uuid endpoint 404s. Re-DELETE on the same uuid returns
    # 404 too (already gone).
    print('[9] /query_executions list + soft delete')
    _, lst = http('GET', '/query_executions')
    n_before = len(lst.get('queryExecutions', []))
    assert n_before >= 3, f'expected >=3, got {n_before}'
    code = http_status('DELETE', f'/query_executions/{fail_uuid}')
    assert code == 200, f'delete returned {code}'
    _, lst2 = http('GET', '/query_executions')
    assert len(lst2.get(
        'queryExecutions',
        [])) == n_before - 1, ('soft-deleted row still visible in list')
    # Per-uuid endpoints all 404 after soft-delete.
    for path in (
        f'/query_executions/{fail_uuid}',
        f'/query_executions/{fail_uuid}:status',
        f'/query_executions/{fail_uuid}:fetch_results?limit=10&offset=0',
    ):
      sd_code, _ = http_status_and_body('GET', path)
      assert sd_code == 404, (
          f'expected 404 on {path} after soft-delete, got {sd_code}')
    # Re-DELETE same uuid → 404 (already gone).
    re_code = http_status('DELETE', f'/query_executions/{fail_uuid}')
    assert re_code == 404, f'expected 404 on re-DELETE, got {re_code}'
    print('    soft-delete: list filtered, per-uuid endpoints 404, '
          're-DELETE returns 404')

    # 8. TTL: a successfully-terminated materialized query has its
    # row buffer cleared and tableName/Link nulled out after the
    # configured --table-ttl-seconds. The QueryExecution itself
    # stays in /query_executions (history is preserved); only the
    # fetchable table goes away. Smoke server runs with TTL=5s
    # sweep=1s so this completes quickly.
    print('[10] TTL sweep clears materialized tables after expiry')
    _, tsub = http(
        'POST',
        '/execute_bigtrace_query_async',
        body={
            'limit': 5,
            'perfetto_sql': 'SELECT name FROM slice LIMIT 5',
            'settings': with_traces(),
        },
    )
    ttl_uuid = tsub['queryUuid']
    wait_until(
        lambda: http('GET', f'/query_executions/{ttl_uuid}:status')[1]['status']
        in ('SUCCESS', 'FAILED'),
        timeout=30.0,
        label='TTL test query terminal',
    )
    # Pre-TTL fetch must succeed.
    _, page_pre = http(
        'GET',
        f'/query_executions/{ttl_uuid}:fetch_results?limit=5&offset=0',
    )
    assert page_pre.get('rows'), (f'pre-TTL fetch returned no rows: {page_pre}')
    _, det_pre = http('GET', f'/query_executions/{ttl_uuid}')
    assert det_pre.get('tableName') is not None, (
        f'pre-TTL tableName must be set, got {det_pre}')
    # Wait past TTL + sweep cadence (5s + 1s + jitter).
    time.sleep(7)
    # Post-TTL: tableName cleared → :fetch_results returns 400
    # FAILED_PRECONDITION ("no longer has a materialized table").
    # Status / metadata preserved on the row itself.
    ttl_code, ttl_body = http_status_and_body(
        'GET',
        f'/query_executions/{ttl_uuid}:fetch_results?limit=5&offset=0',
    )
    assert ttl_code == 400, (
        f'post-TTL fetch expected 400 FAILED_PRECONDITION, '
        f'got {ttl_code}: {ttl_body}')
    _, det_post = http('GET', f'/query_executions/{ttl_uuid}')
    assert det_post.get('tableName') is None, (
        f'post-TTL tableName should be None, got {det_post}')
    assert det_post.get('tableLink') is None, (
        f'post-TTL tableLink should be None, got {det_post}')
    assert det_post.get('status') == 'SUCCESS', (
        f'TTL must preserve terminal status, got {det_post}')
    assert det_post.get('processedRows') == det_pre.get('processedRows'), (
        'TTL must not touch processedRows metadata')
    print(
        f'    TTL cleared {ttl_uuid[:8]}... fetch=400, tableName=None, status preserved'
    )

    # 11. Global result limit: `limit=N` is a TOTAL cap across all
    # traces, not per-trace. With 14 traces and limit=7, we should
    # get at most 7 rows materialized (not 14*7=98). The other
    # traces short-circuit at the cancel/limit check.
    print('[11] result limit is global, not per-trace')
    N = 7
    _, glsub = http(
        'POST',
        '/execute_bigtrace_query_async',
        body={
            'limit': N,
            'perfetto_sql': 'SELECT name FROM slice',
            'settings': with_traces(),
        },
    )
    gl_uuid = glsub['queryUuid']
    wait_until(
        lambda: http('GET', f'/query_executions/{gl_uuid}:status')[1]['status']
        in ('SUCCESS', 'FAILED'),
        timeout=60.0,
        label='global-limit query terminal',
    )
    _, gl = http('GET', f'/query_executions/{gl_uuid}')
    assert gl['status'] == 'SUCCESS', (
        f'global-limit query expected SUCCESS, got {gl}')
    assert gl['processedRows'] <= N, (
        f'global limit broken: limit={N} but processedRows={gl["processedRows"]} '
        '(per-trace cap leaked)')
    # Also verify via :fetch_results — same cap.
    _, gl_page = http(
        'GET',
        f'/query_executions/{gl_uuid}:fetch_results?limit=100&offset=0',
    )
    assert len(gl_page.get('rows') or []) <= N, (
        f'fetch_results returned {len(gl_page.get("rows") or [])} rows; '
        f'global limit was {N}')
    print(f'    limit={N} -> processedRows={gl["processedRows"]} '
          f'(<= {N}; global cap honored)')

    # 11a. trace_limit caps the number of traces processed before
    # any rows are merged. With trace_limit=2 and a directory of
    # 14 traces, processedTraces <= 2 (and totalTraces matches the
    # capped list, since we truncate before fan-out).
    print('[11a] trace_limit caps the trace list')
    TL = 2
    _, tlsub = http(
        'POST',
        '/execute_bigtrace_query_async',
        body={
            # `limit` here is the row cap, not the trace cap. Use
            # something high so the trace_limit is the only thing
            # that bounds processedTraces.
            'limit':
                10_000,
            'perfetto_sql':
                'SELECT name FROM slice LIMIT 5',
            'settings':
                with_traces([
                    {
                        'setting_id': 'trace_limit',
                        'values': [str(TL)],
                        'category': 'TRACE_ADDRESS'
                    },
                ]),
        },
    )
    tl_uuid = tlsub['queryUuid']
    wait_until(
        lambda: http('GET', f'/query_executions/{tl_uuid}:status')[1]['status']
        in ('SUCCESS', 'FAILED'),
        timeout=60.0,
        label='trace_limit query terminal',
    )
    _, tl = http('GET', f'/query_executions/{tl_uuid}')
    assert tl['status'] == 'SUCCESS', (
        f'trace_limit query expected SUCCESS, got {tl}')
    assert tl['processedTraces'] <= TL, (
        f'trace_limit broken: trace_limit={TL} but processedTraces='
        f'{tl["processedTraces"]}')
    assert tl['totalTraces'] <= TL, (
        f'trace_limit must also cap totalTraces (truncation happens '
        f'before fan-out): got {tl["totalTraces"]} > {TL}')
    print(f'    trace_limit={TL} -> processedTraces='
          f'{tl["processedTraces"]}/{tl["totalTraces"]} (<= {TL}; cap honored)')

    # 12. :status payload is strictly the 5 progress fields.
    # No endTime, errorMessage, perfettoSql, etc. — those live on
    # the full GET only. The UI relies on this to keep the 3s poll
    # cheap. Critically, errorMessage must NOT be on :status even
    # for FAILED queries.
    print('[12] :status returns exactly 5 fields')
    EXPECTED_STATUS_KEYS = {
        'queryUuid',
        'status',
        'processedTraces',
        'totalTraces',
        'processedRows',
    }
    # Re-use the global-limit query (terminal SUCCESS).
    _, st_succ = http('GET', f'/query_executions/{gl_uuid}:status')
    assert set(st_succ.keys()) == EXPECTED_STATUS_KEYS, (
        f'SUCCESS :status has unexpected keys: '
        f'got {sorted(st_succ.keys())}, expected {sorted(EXPECTED_STATUS_KEYS)}'
    )
    # Submit a fresh FAILED query (the one from step [6] was
    # soft-deleted in step [9], and :status would 404 on it).
    _, ssub = http(
        'POST',
        '/execute_bigtrace_query_async',
        body={
            'limit': 1,
            'perfetto_sql': 'SELECT * FROM does_not_exist_either',
            'settings': with_traces(),
        },
    )
    ss_uuid = ssub['queryUuid']
    wait_until(
        lambda: http('GET', f'/query_executions/{ss_uuid}:status')[1]['status']
        in ('SUCCESS', 'FAILED'),
        timeout=30.0,
        label=':status-shape FAILED query terminal',
    )
    _, st_fail = http('GET', f'/query_executions/{ss_uuid}:status')
    assert set(st_fail.keys()) == EXPECTED_STATUS_KEYS, (
        f'FAILED :status has unexpected keys (errorMessage should be on '
        f'full GET, not :status): got {sorted(st_fail.keys())}')
    print('    SUCCESS + FAILED :status payloads each have exactly the 5 '
          'progress fields')

    # 13. DELETE on an IN_PROGRESS query returns 409.
    # Caller must POST :cancel first; DELETE is strictly for pruning
    # terminal entries from history.
    print('[13] DELETE while IN_PROGRESS returns 409')
    _, dlsub = http(
        'POST',
        '/execute_bigtrace_query_async',
        body={
            'limit': 1_000_000,
            'perfetto_sql': 'SELECT s1.name FROM slice s1, slice s2 '
                            'LIMIT 1000000',
            'settings': with_traces(),
        },
    )
    dl_uuid = dlsub['queryUuid']
    # Race-tolerance: verify the query is actually still IN_PROGRESS
    # before testing DELETE. If the query somehow finished already,
    # log and skip the assertion (the heavy join is normally slow
    # enough that this branch never fires).
    _, dl_st = http('GET', f'/query_executions/{dl_uuid}:status')
    if dl_st['status'] == 'IN_PROGRESS':
      dl_code, dl_body = http_status_and_body(
          'DELETE',
          f'/query_executions/{dl_uuid}',
      )
      assert dl_code == 409, (
          f'DELETE on IN_PROGRESS expected 409, got {dl_code}: {dl_body}')
      assert 'cancel' in dl_body.lower(), (
          f'409 body should hint at cancelling first; got {dl_body!r}')
      print(f'    DELETE returned 409: {dl_body!r}')
    else:
      print(f'    NOTE: query terminated before DELETE could race '
            f'({dl_st["status"]}) — 409 path not exercised')
    # Clean up so the smoke server can shut down cleanly.
    http_status('POST', f'/query_executions/{dl_uuid}:cancel')

    # 14. 404 on unknown UUID across every per-uuid endpoint.
    # Belt-and-braces with the soft-delete checks; this version
    # exercises a UUID that was never registered at all.
    print('[14] unknown UUID 404 across all per-uuid endpoints')
    UNKNOWN = '00000000-0000-0000-0000-000000000000'
    endpoints = [
        ('GET', f'/query_executions/{UNKNOWN}'),
        ('GET', f'/query_executions/{UNKNOWN}:status'),
        ('GET', f'/query_executions/{UNKNOWN}:fetch_results?limit=10&offset=0'),
        ('POST', f'/query_executions/{UNKNOWN}:cancel'),
        ('DELETE', f'/query_executions/{UNKNOWN}'),
    ]
    for method, path in endpoints:
      uk_code, uk_body = http_status_and_body(method, path)
      assert uk_code == 404, (
          f'{method} {path} expected 404, got {uk_code}: {uk_body}')
    print(f'    all {len(endpoints)} endpoints 404 cleanly on unknown uuid')

    # 16. Trace Filter regex narrows the candidate trace list.
    # Use a regex that matches only one trace by basename. Verify
    # totalTraces and processedTraces both reflect the narrowing.
    # The directory has 14 traces matching `android-*.pftrace`;
    # filter for "Copy 11" only.
    print('[16] trace_filter regex narrows the trace list')
    _, tfsub = http(
        'POST',
        '/execute_bigtrace_query_async',
        body={
            'limit':
                5,
            'perfetto_sql':
                'SELECT name FROM slice LIMIT 1',
            'settings':
                with_traces([
                    {
                        'setting_id': 'trace_filter',
                        'values': [r'Copy 11\)\.pftrace$'],
                        'category': 'TRACE_ADDRESS'
                    },
                ]),
        },
    )
    tf_uuid = tfsub['queryUuid']
    wait_until(
        lambda: http('GET', f'/query_executions/{tf_uuid}:status')[1]['status']
        in ('SUCCESS', 'FAILED'),
        timeout=60.0,
        label='trace_filter query terminal',
    )
    _, tf = http('GET', f'/query_executions/{tf_uuid}')
    # Race-tolerant: if the smoke is run against a different
    # traces dir, the regex may match nothing, in which case
    # totalTraces=0 and SUCCESS. Either way, totalTraces must
    # be at most 1 (the "Copy 11" trace, if present).
    assert tf['totalTraces'] <= 1, (
        f'trace_filter should narrow to <=1, got totalTraces='
        f'{tf["totalTraces"]}')
    print(f'    trace_filter regex -> totalTraces='
          f'{tf["totalTraces"]} (<=1)')

    # 17. Timestamp precision + UTC + non-zero duration.
    # Recent regression: DuckDB CURRENT_TIMESTAMP wrote local time
    # mislabeled as UTC, AND the wire format hardcoded `.000Z`
    # millisecond field. Both fixed. Assert here:
    #   (a) startTime is recent UTC (delta from time.time() < 60s).
    #   (b) startTime contains a non-zero millisecond field for at
    #       least one query (proves ms precision is wired through).
    #   (c) end_time > start_time (proves they're not snapshotted
    #       from the same CURRENT_TIMESTAMP for sync queries).
    print('[17] timestamps: UTC + millisecond + start<end')
    _, tssub = http(
        'POST',
        '/execute_bigtrace_query_async',
        body={
            'limit': 5,
            'perfetto_sql': 'SELECT name FROM slice LIMIT 5',
            'settings': with_traces(),
        },
    )
    ts_uuid = tssub['queryUuid']
    wait_until(
        lambda: http('GET', f'/query_executions/{ts_uuid}:status')[1]['status']
        in ('SUCCESS', 'FAILED'),
        timeout=30.0,
        label='timestamps query terminal',
    )
    _, ts = http('GET', f'/query_executions/{ts_uuid}')
    # (a) UTC: parse the wire ISO and compare with the smoke's clock.
    from datetime import datetime, timezone
    wire_start = datetime.strptime(
        ts['startTime'].replace('Z', ''),
        '%Y-%m-%dT%H:%M:%S.%f',
    ).replace(tzinfo=timezone.utc)
    now_utc = datetime.now(timezone.utc)
    delta_seconds = abs((now_utc - wire_start).total_seconds())
    assert delta_seconds < 60, (
        f'wire startTime {ts["startTime"]!r} is {delta_seconds:.0f}s '
        f'off from machine UTC; backend is probably labelling local '
        f'time as UTC')
    # (b) Millisecond precision: the format ends in .fffZ. Assert
    # at least the field exists and matches the regex; we accept
    # .000Z (a query that genuinely landed on the millisecond
    # boundary) but the format itself must be parseable as
    # millisecond ISO-8601.
    import re
    assert re.match(
        r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$',
        ts['startTime'],
    ), (f'startTime missing millisecond field: {ts["startTime"]!r}')
    # (c) end_time > start_time. Async query went through the
    # threaded executor; even a fast run is microseconds apart.
    wire_end = datetime.strptime(
        ts['endTime'].replace('Z', ''),
        '%Y-%m-%dT%H:%M:%S.%f',
    ).replace(tzinfo=timezone.utc)
    run_ms = (wire_end - wire_start).total_seconds() * 1000
    assert run_ms > 0, (
        f'endTime <= startTime ({ts["startTime"]} -> {ts["endTime"]}); '
        'either both columns came from the same CURRENT_TIMESTAMP '
        'or the precision was truncated')
    print(f'    UTC delta={delta_seconds:.0f}s, format=ms-precision, '
          f'run={run_ms:.0f}ms (>0)')

    # 18. No matching traces is a clean SUCCESS with 0 rows, not
    # an error. The empty-trace path is its own branch in
    # _run_async_query and should still set tableName (the table
    # exists conceptually; it just has 0 rows).
    print('[18] no matching traces -> SUCCESS with 0 rows')
    _, nmsub = http(
        'POST',
        '/execute_bigtrace_query_async',
        body={
            'limit':
                5,
            'perfetto_sql':
                'SELECT 1',
            'settings':
                with_traces([
                    {
                        'setting_id': 'trace_filter',
                        'values': ['^definitely-no-match-anywhere$'],
                        'category': 'TRACE_ADDRESS'
                    },
                ]),
        },
    )
    nm_uuid = nmsub['queryUuid']
    wait_until(
        lambda: http('GET', f'/query_executions/{nm_uuid}:status')[1]['status']
        in ('SUCCESS', 'FAILED'),
        timeout=30.0,
        label='no-match query terminal',
    )
    _, nm = http('GET', f'/query_executions/{nm_uuid}')
    assert nm['status'] == 'SUCCESS', (
        f'no-match query should SUCCEED with 0 rows, got {nm}')
    assert nm['totalTraces'] == 0, (
        f'expected totalTraces=0, got {nm["totalTraces"]}')
    assert nm['processedRows'] == 0, (
        f'expected processedRows=0, got {nm["processedRows"]}')
    print(f'    SUCCESS, totalTraces=0, processedRows=0')

    # 19. Cancel idempotency on already-terminal queries.
    # Per the contract: cancel on a SUCCESS/FAILED/CANCELLED query
    # is a silent 200 no-op (not 404, not 409). The UI may double-
    # cancel under unusual races and we shouldn't error out.
    print('[19] cancel on terminal query is a silent 200')
    # Re-use the just-completed no-match query (it's terminal).
    ic_code = http_status('POST', f'/query_executions/{nm_uuid}:cancel')
    assert ic_code == 200, (
        f'cancel on terminal expected 200 (silent no-op), got {ic_code}')
    # Status should still be SUCCESS, not flipped.
    _, after = http('GET', f'/query_executions/{nm_uuid}')
    assert after['status'] == 'SUCCESS', (
        f'cancel on terminal must not flip status; got {after["status"]}')
    print(f'    cancel on terminal: 200, status preserved as '
          f'{after["status"]}')

    # 20. Server restart recovery: a query that's IN_PROGRESS when
    # the server crashes is recovered as FAILED on the next boot,
    # with errorMessage pointing at the recovery and tableName
    # cleared. The metadata row + perfetto_sql persists.
    print('[20] server restart recovery')
    # Submit a slow query that'll still be IN_PROGRESS when we
    # kill the server.
    _, srsub = http(
        'POST',
        '/execute_bigtrace_query_async',
        body={
            'limit': 1_000_000,
            'perfetto_sql': 'SELECT s1.name FROM slice s1, slice s2 '
                            'LIMIT 1000000',
            'settings': with_traces(),
        },
    )
    sr_uuid = srsub['queryUuid']
    sr_sql = 'SELECT s1.name FROM slice s1, slice s2 LIMIT 1000000'
    # Verify it's actually IN_PROGRESS before we crash the server.
    time.sleep(0.3)
    _, mid = http('GET', f'/query_executions/{sr_uuid}:status')
    if mid['status'] != 'IN_PROGRESS':
      print(f'    NOTE: query reached {mid["status"]} before crash '
            'point — recovery path not exercised this run')
    else:
      # SIGKILL: simulate a hard crash. SIGINT would let the
      # server transition the row to a terminal state cleanly,
      # which isn't what we want to test.
      server.kill()
      server.wait(timeout=10)
      # Restart on the SAME port + db_path. Same CLI as before.
      server = subprocess.Popen(
          [
              venv_python,
              os.path.join(HERE, 'server.py'), '--port',
              str(PORT), '--db-path', db_path, '--table-ttl-seconds', '5',
              '--table-ttl-sweep-seconds', '1', '--with-datasette',
              str(DATASETTE_PORT), '--log-level', 'warning'
          ],
          stdout=subprocess.PIPE,
          stderr=subprocess.STDOUT,
      )
      wait_until(
          lambda: http('GET', '/query_executions')[0] == 200,
          timeout=15.0,
          label='restarted server up',
      )
      # The recovered row.
      _, recov = http('GET', f'/query_executions/{sr_uuid}')
      assert recov['status'] == 'FAILED', (
          f'stale IN_PROGRESS should recover as FAILED, got '
          f'{recov["status"]}')
      assert 'restart' in (recov.get('errorMessage') or '').lower(), (
          f'errorMessage should mention restart; got '
          f'{recov.get("errorMessage")!r}')
      assert recov.get('tableName') is None, (
          f'tableName should be cleared on recovery, got '
          f'{recov.get("tableName")}')
      assert recov.get('perfettoSql') == sr_sql, (
          f'perfettoSql metadata should persist; got '
          f'{recov.get("perfettoSql")!r}')
      print(f'    {sr_uuid[:8]}... recovered as FAILED with '
            f'errorMessage={recov.get("errorMessage")!r}')

    # 21. Datasette + tableLink end-to-end. The smoke server is
    # spawned with --with-datasette N so the inspector is up on a
    # known port. We submit a query, follow its tableLink, and
    # verify it lands on a working SQL editor page (HTML) and that
    # the .json variant returns rows.
    print('[21] Datasette + tableLink end-to-end')
    # Datasette's startup is async; wait for the index to respond.
    ds_deadline = time.time() + 30
    while time.time() < ds_deadline:
      try:
        req = urllib.request.Request(f'{DS_BASE}/state')
        with urllib.request.urlopen(req, timeout=2) as resp:
          if resp.status == 200:
            break
      except Exception:  # noqa: BLE001
        pass
      time.sleep(0.5)
    else:
      raise TimeoutError('Datasette never came up on the smoke port')
    # Submit a small query and verify tableLink resolves.
    _, dssub = http(
        'POST',
        '/execute_bigtrace_query_async',
        body={
            'limit': 5,
            'perfetto_sql': 'SELECT name FROM slice LIMIT 5',
            'settings': with_traces(),
        },
    )
    ds_uuid = dssub['queryUuid']
    wait_until(
        lambda: http('GET', f'/query_executions/{ds_uuid}:status')[1]['status']
        in ('SUCCESS', 'FAILED'),
        timeout=30.0,
        label='datasette test query terminal',
    )
    _, ds_det = http('GET', f'/query_executions/{ds_uuid}')
    link = ds_det.get('tableLink')
    # Server emits `http://localhost:<port>/...`, smoke probes
    # 127.0.0.1; verify by port + Datasette path-shape rather than
    # the host literal.
    assert link and f':{DATASETTE_PORT}/state' in link, (
        f'tableLink should point at Datasette port {DATASETTE_PORT}; '
        f'got {link!r}')
    assert '?sql=' in link, (
        f'tableLink should encode a SQL query; got {link!r}')
    # Follow the HTML page.
    with urllib.request.urlopen(link, timeout=5) as resp:
      ds_code = resp.status
      ds_html = resp.read().decode('utf-8', 'replace')
    assert ds_code == 200, f'tableLink GET expected 200, got {ds_code}'
    assert 'rows-and-columns' in ds_html, (
        'Datasette table HTML should contain rows-and-columns class')
    # And the .json variant — turns `/state?sql=...` into
    # `/state.json?sql=...`. Datasette mirrors this convention.
    json_link = link.replace('/state?sql=', '/state.json?sql=', 1)
    with urllib.request.urlopen(json_link, timeout=5) as resp:
      ds_json = json.loads(resp.read())
    assert ds_json.get('ok') is True, (
        f'Datasette JSON response expected ok=True, got {ds_json}')
    assert ds_json.get('rows'), (
        f'Datasette JSON response had no rows: {ds_json}')
    print(
        f'    tableLink HTML rendered; JSON returned {len(ds_json["rows"])} rows'
    )

    # 22. AIP-132 order_by on :fetch_results.
    #   Submit a query, then re-fetch sorted asc/desc and assert
    #   the rows are actually in that order. Also assert that
    #   malformed / unknown-column inputs return HTTP 400.
    print('[22] order_by (AIP-132) end-to-end')
    _, obsub = http(
        'POST',
        '/execute_bigtrace_query_async',
        body={
            'limit': 50,
            # `dur` is monotonic-ish across slices; comparing it
            # gives a deterministic ordering test that doesn't
            # depend on the trace contents.
            'perfetto_sql': 'SELECT name, dur FROM slice LIMIT 50',
            'settings': with_traces(),
        },
    )
    ob_uuid = obsub['queryUuid']
    wait_until(
        lambda: http('GET', f'/query_executions/{ob_uuid}:status')[1]['status']
        == 'SUCCESS',
        timeout=30.0,
        label='order_by test query SUCCESS',
    )
    # Ascending dur.
    _, asc = http(
        'GET',
        f'/query_executions/{ob_uuid}:fetch_results'
        f'?limit=50&offset=0&order_by=dur%20asc',
    )
    # Row values come over as strings (always-strings contract);
    # convert to ints for numeric ordering.
    asc_durs = [
        int(r['values'][2])
        for r in asc.get('rows', [])
        if r['values'][2] is not None
    ]
    assert asc_durs == sorted(asc_durs), (
        f'order_by=dur asc rows not ascending: {asc_durs[:10]}…')
    # Descending dur.
    _, desc_resp = http(
        'GET',
        f'/query_executions/{ob_uuid}:fetch_results'
        f'?limit=50&offset=0&order_by=dur%20desc',
    )
    desc_durs = [
        int(r['values'][2])
        for r in desc_resp.get('rows', [])
        if r['values'][2] is not None
    ]
    assert desc_durs == sorted(
        desc_durs, reverse=True), (
            f'order_by=dur desc rows not descending: {desc_durs[:10]}…')
    # Multi-field ordering.
    _, multi = http(
        'GET',
        f'/query_executions/{ob_uuid}:fetch_results'
        f'?limit=50&offset=0&order_by=name%20asc%2C%20dur%20desc',
    )
    assert multi.get('rows'), (
        'multi-field order_by returned no rows; smoke is broken')
    # Bad direction → 400.
    bad_dir_code, bad_dir_body = http_status_and_body(
        'GET',
        f'/query_executions/{ob_uuid}:fetch_results'
        f'?order_by=dur%20sideways',
    )
    assert bad_dir_code == 400, (
        f'bad direction expected 400, got {bad_dir_code}: {bad_dir_body}')
    # Unknown column → 400.
    bad_col_code, bad_col_body = http_status_and_body(
        'GET',
        f'/query_executions/{ob_uuid}:fetch_results'
        f'?order_by=does_not_exist',
    )
    assert bad_col_code == 400, (
        f'unknown column expected 400, got {bad_col_code}: {bad_col_body}')
    assert 'does_not_exist' in bad_col_body, (
        f'expected error to mention the offending column; got: '
        f'{bad_col_body}')
    print(f'    asc/desc/multi all sort correctly; bad direction + '
          f'unknown column both return 400')

    # 23. filter end-to-end on :fetch_results.
    #   Submit a query that yields rows we can predicate against,
    #   then exercise: numeric `>`, string `glob`, `in (...)`,
    #   `is null`, multi-filter AND, and the `totalFilteredRows`
    #   response field. Also assert that malformed JSON,
    #   unknown-column, and empty `in` lists each return HTTP 400.
    print('[23] filter (JSON Filter[]) end-to-end')
    _, fsub = http(
        'POST',
        '/execute_bigtrace_query_async',
        body={
            'limit': 200,
            'perfetto_sql': ('SELECT name, dur, category FROM slice LIMIT 200'),
            'settings': with_traces(),
        },
    )
    f_uuid = fsub['queryUuid']
    wait_until(
        lambda: http('GET', f'/query_executions/{f_uuid}:status')[1]['status']
        == 'SUCCESS',
        timeout=30.0,
        label='filter test query SUCCESS',
    )
    # Baseline (no filter) so we know the materialized total.
    _, base = http(
        'GET',
        f'/query_executions/{f_uuid}:fetch_results?limit=200&offset=0',
    )
    assert 'totalFilteredRows' in base, (
        f'totalFilteredRows missing from no-filter response: {base}')
    base_total = int(base['totalFilteredRows'])
    base_rows = base.get('rows', [])
    # Lock the always-strings response contract: every non-null
    # value in every row is a JSON string, regardless of column
    # type. The smoke is the only place we end-to-end-verify this
    # — the backend's `_value_to_wire` is what enforces it.
    for r in base_rows:
      for v in r['values']:
        assert v is None or isinstance(
            v, str), (f'always-strings response violated: value {v!r} '
                      f'(type {type(v).__name__}) in row {r}')
    # Pick a `dur` threshold that splits the rowset roughly in half so
    # both branches of `>` and `<=` have rows. row['values'] is
    # [trace_id, name, dur, category]; grab non-null dur values.
    # Row values arrive as strings; convert for numeric reasoning.
    durs = sorted(
        int(r['values'][2]) for r in base_rows if r['values'][2] is not None)
    assert durs, 'no non-null dur values to filter on; smoke is broken'
    threshold = durs[len(durs) // 2]
    # Numeric `>` filter; verify totalFilteredRows is consistent and
    # every returned row matches the predicate.
    f_gt = json.dumps([{'field': 'dur', 'op': '>', 'value': threshold}])
    _, gt = http(
        'GET',
        f'/query_executions/{f_uuid}:fetch_results'
        f'?limit=200&offset=0&filter={urllib.parse.quote(f_gt)}',
    )
    gt_rows = gt.get('rows', [])
    gt_total = int(gt['totalFilteredRows'])
    assert gt_total <= base_total, (
        f'filter total ({gt_total}) > base total ({base_total})')
    assert all(
        r['values'][2] is not None and int(r['values'][2]) > threshold
        for r in gt_rows), f'rows violate dur > {threshold}: {gt_rows[:3]}'
    # `glob` on `name`. Pick a prefix that exists in the sampled
    # rows so we know the filter has matches.
    sample_name = next((r['values'][1] for r in base_rows if r['values'][1]),
                       None)
    assert sample_name, 'no non-null name in baseline; cannot test glob'
    prefix = sample_name[:1]  # first character
    f_glob = json.dumps([{
        'field': 'name',
        'op': 'glob',
        'value': f'{prefix}*'
    }])
    _, glob_resp = http(
        'GET',
        f'/query_executions/{f_uuid}:fetch_results'
        f'?limit=200&offset=0&filter={urllib.parse.quote(f_glob)}',
    )
    glob_rows = glob_resp.get('rows', [])
    assert glob_rows, f'glob {prefix}* returned 0 rows; smoke is broken'
    assert all(r['values'][1] is not None and r['values'][1].startswith(prefix)
               for r in glob_rows), f'glob match violated: {glob_rows[:3]}'
    # Multi-filter AND: glob on name AND dur > threshold.
    f_and = json.dumps([
        {
            'field': 'name',
            'op': 'glob',
            'value': f'{prefix}*'
        },
        {
            'field': 'dur',
            'op': '>',
            'value': threshold
        },
    ])
    _, and_resp = http(
        'GET',
        f'/query_executions/{f_uuid}:fetch_results'
        f'?limit=200&offset=0&filter={urllib.parse.quote(f_and)}',
    )
    and_total = int(and_resp['totalFilteredRows'])
    assert and_total <= gt_total, (
        f'AND ({and_total}) widened beyond > alone ({gt_total})')
    # Bad JSON → 400.
    bad_json_code, bad_json_body = http_status_and_body(
        'GET',
        f'/query_executions/{f_uuid}:fetch_results?filter=not-json',
    )
    assert bad_json_code == 400, (
        f'malformed filter expected 400, got {bad_json_code}: {bad_json_body}')
    # Unknown column → 400.
    f_unknown = json.dumps([{'field': 'does_not_exist', 'op': '=', 'value': 1}])
    bad_col_code, bad_col_body = http_status_and_body(
        'GET',
        f'/query_executions/{f_uuid}:fetch_results'
        f'?filter={urllib.parse.quote(f_unknown)}',
    )
    assert bad_col_code == 400, (
        f'unknown filter column expected 400, got {bad_col_code}: '
        f'{bad_col_body}')
    assert 'does_not_exist' in bad_col_body, (
        f'expected error to mention the offending column; got: '
        f'{bad_col_body}')
    # Empty `in` list → 400 (the widget shouldn't generate this; a
    # clear error catches client bugs).
    f_empty_in = json.dumps([{'field': 'name', 'op': 'in', 'value': []}])
    empty_code, empty_body = http_status_and_body(
        'GET',
        f'/query_executions/{f_uuid}:fetch_results'
        f'?filter={urllib.parse.quote(f_empty_in)}',
    )
    assert empty_code == 400, (
        f'empty in[] expected 400, got {empty_code}: {empty_body}')
    # Wire-coverage sweep for the remaining op variants. Predicate
    # correctness is locked down in db_unittest.py — here we only
    # need to confirm each op survives the HTTP round-trip and the
    # totalFilteredRows result is in [0, base_total]. Tiny test
    # traces mean some predicates may match zero rows; that's fine,
    # the contract is "HTTP 200 with consistent total".
    op_variants = [
        # (label, filter-array)
        ('<=', [{
            'field': 'dur',
            'op': '<=',
            'value': threshold
        }]),
        ('>=', [{
            'field': 'dur',
            'op': '>=',
            'value': threshold
        }]),
        ('!=', [{
            'field': 'name',
            'op': '!=',
            'value': sample_name
        }]),
        ('not glob', [{
            'field': 'name',
            'op': 'not glob',
            'value': f'{prefix}*'
        }]),
        ('not in', [{
            'field': 'name',
            'op': 'not in',
            'value': [sample_name]
        }]),
        ('is null', [{
            'field': 'name',
            'op': 'is null'
        }]),
        ('is not null', [{
            'field': 'name',
            'op': 'is not null'
        }]),
    ]
    for label, body in op_variants:
      payload = urllib.parse.quote(json.dumps(body))
      _, resp = http(
          'GET',
          f'/query_executions/{f_uuid}:fetch_results'
          f'?limit=200&offset=0&filter={payload}',
      )
      total = int(resp['totalFilteredRows'])
      assert 0 <= total <= base_total, (
          f'op {label!r}: totalFilteredRows={total} '
          f'outside [0, {base_total}]: {resp}')
      assert len(resp.get('rows', [])) <= total, (
          f'op {label!r}: returned more rows than totalFilteredRows '
          f'({len(resp.get("rows", []))} vs {total})')
    print(f'    >, glob, AND all match; bad JSON / unknown column / '
          f'empty in[] all return 400; '
          f'totalFilteredRows={base_total}/{gt_total}/{and_total}; '
          f'{len(op_variants)} other op variants survive the wire')

    print('\nALL CHECKS PASSED')
  except AssertionError as e:
    print(f'\nFAIL: {e}')
    failed = True
  except Exception as e:  # noqa: BLE001
    print(f'\nERROR: {type(e).__name__}: {e}')
    failed = True
  finally:
    try:
      server.send_signal(signal.SIGINT)
      server.wait(timeout=10)
    except Exception:
      server.kill()
    if cleanup_dir and not args.keep_traces:
      shutil.rmtree(cleanup_dir, ignore_errors=True)
    # Always clean up the DuckDB temp dir, regardless of --keep-traces.
    shutil.rmtree(db_dir, ignore_errors=True)

  return 1 if failed else 0


if __name__ == '__main__':
  sys.exit(main())
