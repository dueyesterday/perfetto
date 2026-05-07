# BigTrace local-dev: User CUJ catalog

Every user-observable critical-user-journey (CUJ) we want exercised
against the local TP backend + the bigtrace UI. Each row links to
where it's tested.

**Legend**

- `HTTP-N` — `smoke_local.py` step N (HTTP-level, ~30s, deterministic)
- `UI-N`   — `smoke_ui.js` Playwright step N (browser, ~60s, slower / flakier)
- `TODO`   — known gap; covered by neither smoke today
- `manual` — not testable in the HTTP/UI smoke today (e.g. requires
  watching a UI animation tick, or manually killing the server)

## A. Onboarding & setup

| # | CUJ | Coverage |
|---|-----|----------|
| A1 | Open `/bigtrace.html`, home page renders | UI-1 |
| A2 | Configure backend endpoint via Settings page | UI |
| A3 | Endpoint change shows "Reload required" prompt | UI-Settings |
| A4 | Home page link "Open query editor" → query page | UI |
| A5 | Home page link "LMK example" populates editor | UI |
| A6 | Home page link "Configure backend" → Settings | UI |
| A7 | Sidebar toggle hides/shows the right panel | UI |

## B. Settings page

| # | CUJ | Coverage |
|---|-----|----------|
| B1 | Settings schema returned with `id, name, description, category, plainString/number` | HTTP-1 |
| B2 | Trace Directory card pre-populated with the CLI value | UI + HTTP-1 |
| B3 | Trace Directory custom dir takes effect on a query | HTTP-3a (via wire), UI-Settings |
| B4 | Bogus Trace Directory → HTTP 400 with "does not exist" | HTTP-3a |
| B5 | Trace Filter regex narrows the trace list | HTTP-16 |
| B6 | Trace Limit caps the trace list (renamed from Max Traces) | HTTP-11a |
| B7 | Settings sent in snake_case `setting_id` are honored | HTTP-3a |
| B8 | Settings sent in legacy `settingId` (camelCase) are ignored | TODO (HTTP) — current behavior is "fall through to default", maybe assert that |

## C. Query lifecycle — sync (`Persistent` toggle OFF)

| # | CUJ | Coverage |
|---|-----|----------|
| C1 | Run sync via Mod+Enter, see rows | UI |
| C2 | Empty query is a no-op (no backend call) | UI |
| C3 | Double-quote in SQL shows the warning callout | UI |
| C4 | Sync logged in `/query_executions` with `materialized=false` | HTTP-3 |
| C5 | `:fetch_results` on a sync UUID → 400 FAILED_PRECONDITION ("not materialized") | HTTP-3 |
| C6 | Sync history visible in the Ephemeral subtab | UI |
| C7 | Sync `start_time` and `end_time` differ (real duration in history) | HTTP-17 (async variant; sync via live probe in this session) |
| C8 | Sync honors global limit (rows ≤ N) | TODO (HTTP) — covered for async; sync probe is manual |

## D. Query lifecycle — async (`Persistent` toggle ON)

| # | CUJ | Coverage |
|---|-----|----------|
| D1 | Async submit returns a UUID immediately | HTTP-4 |
| D2 | Status transitions IN_PROGRESS → SUCCESS | HTTP-4 |
| D3 | `processedRows` advances live during the run | HTTP-5a |
| D4 | `:fetch_results` returns rows mid-flight (streaming) | HTTP-5a |
| D5 | `:status` returns exactly the 5 progress fields | HTTP-12 |
| D6 | Result rows are tagged with `trace_id` (basename minus ext) | HTTP-5 |
| D7 | UI polls `:status` every 3s; updates counters | UI |
| D8 | UI shows live-tick duration during IN_PROGRESS (Date.now() - startTime) | manual (UI live tick) |
| D9 | UI Refresh button re-fetches results | UI |
| D10 | UI Copy Query button copies the SQL | UI |

## E. Query lifecycle — failures

| # | CUJ | Coverage |
|---|-----|----------|
| E1 | Async failure (every trace errors) → status FAILED | HTTP-6 |
| E2 | FAILED query has `errorMessage` on full GET | HTTP-6 |
| E3 | FAILED `tableName` is null | HTTP-6 |
| E4 | `:fetch_results` on a FAILED UUID → 400 FAILED_PRECONDITION (tableName cleared) | HTTP-6 |
| E5 | UI shows error banner with collapsed traceback | UI |
| E6 | Submit-time validation: bogus trace dir → 400 | HTTP-3a |

## F. Query lifecycle — cancel

| # | CUJ | Coverage |
|---|-----|----------|
| F1 | Cancel returns 200 atomically | HTTP-7 |
| F2 | Cancel transitions to CANCELLED | HTTP-7 |
| F3 | Partials preserved on cancel (rows > 0) | HTTP-7a |
| F4 | Partials fetchable via `:fetch_results` | HTTP-7a |
| F5 | CANCELLED-with-rows has `tableName` set | HTTP-7a |
| F6 | CANCELLED-with-zero-rows has `tableName` cleared | TODO (HTTP) — could test by cancelling before any merge |
| F7 | Cancel on already-terminal query → 200 silent no-op | HTTP-19 |
| F8 | Cancel on unknown UUID → 404 | HTTP-14 |
| F9 | UI shows Cancel button only while IN_PROGRESS | UI |

## G. Pagination

| # | CUJ | Coverage |
|---|-----|----------|
| G1 | `:fetch_results?limit&offset` paginates correctly | HTTP-5 |
| G2 | UI Next button advances page | UI |
| G3 | UI Previous button goes back; disabled at start | UI |
| G4 | UI page-size change re-fetches with new limit | UI |
| G5 | UI sticky table headers; only body scrolls | manual |

## G'. Sorting (AIP-132 `order_by`)

| #   | CUJ | Coverage |
|-----|-----|----------|
| GS1 | `:fetch_results?order_by=field` sorts ascending | HTTP-22 |
| GS2 | `:fetch_results?order_by=field desc` sorts descending | HTTP-22 |
| GS3 | Multi-field ordering (`a asc, b desc`) returns rows | HTTP-22 |
| GS4 | Bad direction → HTTP 400 | HTTP-22 |
| GS5 | Unknown column → HTTP 400 with available-columns list in body | HTTP-22 |
| GS6 | UI column-header click emits `&order_by=…` and rows reorder | manual (verified once via /tmp/verify_sort.js Playwright probe) |
| GS7 | UI: clicking a header on a finished persistent query (re-opened from history) refetches sorted | manual |

## H. History panel

| # | CUJ | Coverage |
|---|-----|----------|
| H1 | `/query_executions` lists non-deleted entries newest first | HTTP-9 |
| H2 | `perfettoSql` truncated to 200 chars in list; full on detail GET | HTTP-8 |
| H3 | UI Persistent subtab shows materialized async runs | UI |
| H4 | UI Ephemeral subtab shows sync runs | UI |
| H5 | UI hover shows action buttons (now always-visible per memory) | UI |
| H6 | UI Open re-loads the query into the active tab | UI |
| H7 | UI Delete soft-deletes via DELETE /query_executions/{uuid} | UI + HTTP-9 |
| H8 | After Delete: list filtered, all per-uuid endpoints 404 | HTTP-9 |
| H9 | DELETE on IN_PROGRESS → 409 (cancel first) | HTTP-13 |
| H10 | Re-DELETE on already-deleted → 404 | HTTP-9 |

## I. Multi-tab

| # | CUJ | Coverage |
|---|-----|----------|
| I1 | New tab via "+" button | UI |
| I2 | Tabs are independent (typing in one doesn't leak) | UI |
| I3 | Tab close decrements count | UI |
| I4 | Reload restores all open tabs from localStorage | UI |
| I5 | Concurrent queries: cancel one tab without affecting others | UI |

## J. Materialization & inspection

| # | CUJ | Coverage |
|---|-----|----------|
| J1 | `tableName` set immediately at async submit | HTTP-21 (implied) |
| J2 | `tableName` follows the lifecycle in the table from CUJ K1 | (this catalog row K1 below) |
| J3 | `tableLink` is built from `tableName` (substring relation) | HTTP-21 |
| J4 | `tableLink` lands on a working Datasette page (HTML 200) | HTTP-21 |
| J5 | `.json` variant of `tableLink` returns rows | HTTP-21 |
| J6 | `--with-datasette` brings up SQL editor + table viewer | HTTP-21 |
| J7 | `--with-db-ui` brings up DuckDB's web UI on its port | manual |
| J8 | UI rendering of `tableLink`: clickable, opens Datasette | TODO (UI) |

## K. tableName lifecycle (server side)

| # | State | tableName | Coverage |
|---|-------|-----------|----------|
| K1 | Sync query | NULL | HTTP-3 |
| K2 | Async submit | set immediately | HTTP-21 |
| K3 | IN_PROGRESS | persists | implied by HTTP-5a |
| K4 | SUCCESS (any rowcount) | persists | HTTP-4 |
| K5 | CANCELLED with rows > 0 | persists | HTTP-7a |
| K6 | CANCELLED with 0 rows | NULL | F6 (TODO) |
| K7 | FAILED | NULL | HTTP-6 |
| K8 | Soft-deleted | NULL | HTTP-9 |
| K9 | TTL-expired | NULL | HTTP-10 |

## L. TTL & cleanup

| # | CUJ | Coverage |
|---|-----|----------|
| L1 | Materialized table dropped after `--table-ttl-seconds` | HTTP-10 |
| L2 | Metadata row (status, sql, timing, processedRows) preserved | HTTP-10 |
| L3 | `:fetch_results` on TTL-expired UUID → 400 FAILED_PRECONDITION (tableName cleared) | HTTP-10 |
| L4 | TTL skips IN_PROGRESS queries | implicit; not directly asserted | TODO (HTTP) |

## M. Server restart / persistence

| # | CUJ | Coverage |
|---|-----|----------|
| M1 | History survives restart (DuckDB-backed) | HTTP-20 (implicit: row UUID is fetched after restart) |
| M2 | Stale IN_PROGRESS rows recovered as FAILED on startup | HTTP-20 |
| M3 | UI tab persisted with stale UUID → graceful recovery | UI (`dropStaleQueryUuid`) |
| M4 | UI reload mid-query: tab restores, polling resumes | UI |
| M5 | UI reload after SUCCESS: tab restores with results | UI |
| M6 | UI reload after FAILED: tab restores with error | TODO (UI) |
| M7 | UI multi-tab reload: 3+ tabs all restore distinct SQL | UI |

## N. Timing & precision

| # | CUJ | Coverage |
|---|-----|----------|
| N1 | Wire timestamps are real UTC (not local-labeled-as-Z) | HTTP-17 |
| N2 | Wire timestamps have millisecond precision | HTTP-17 |
| N3 | Sync query: `start_time != end_time` for non-instant queries | TODO (HTTP) — async covered by HTTP-17, sync needs its own probe |
| N4 | Async query: `start_time < end_time` (delta > 0) | HTTP-17 |
| N5 | UI displays duration with sub-second precision | manual |

## O. Hotkeys & UX polish

| # | CUJ | Coverage |
|---|-----|----------|
| O1 | Mod+B toggles left sidebar | UI |
| O2 | Mod+Shift+B toggles right (history/stdlib) sidebar | TODO (UI) |
| O3 | Mod+Shift+P opens command palette | UI |
| O4 | `?` opens help modal | UI |
| O5 | Mod+Enter runs the query | UI |

## P. Stdlib browser

| # | CUJ | Coverage |
|---|-----|----------|
| P1 | Stdlib search returns matches | UI |
| P2 | Click table → opens new editor tab with `SELECT * FROM <table>` | UI |
| P3 | Chart tab placeholder visible | UI |

## Q. Edge cases

| # | CUJ | Coverage |
|---|-----|----------|
| Q1 | No matching traces (empty filter result) → SUCCESS, 0 rows | HTTP-18 |
| Q2 | 0-row SUCCESS keeps `tableName` set | HTTP-pre — see live probe in this session |
| Q3 | Unknown UUID 404 across every per-uuid endpoint | HTTP-14 |
| Q4 | `:status` on unknown UUID → 404 | HTTP-14 |
| Q5 | Race-tolerant cancel: cancel after natural completion → 200 | HTTP-19 |

---

## Summary

- **HTTP smoke** (`smoke_local.py`): **22 steps, all green** — `[1]`
  through `[14]`, `[15]`–`[20]` (the new CUJ additions), and `[21]`
  (Datasette). Run with `.venv/bin/python smoke_local.py
  --traces-dir ~/Downloads`.
- **UI smoke** (`smoke_ui.js`): ~40 steps total; **19 currently
  pass**. Most recent run hits a hard fail at `STEP 20` ("Page reload
  mid-query: kick off a slow query then reload immediately") — the
  selector logic for picking up the freshly-submitted query against
  the new tab is stale relative to current Mithril redraw timing.
  Two soft NOTEs upstream:
    - STEP 8: sync summary "Returned 70 rows in 6,506 ms" — smoke
      expected a smaller row count (artifact of the global-limit
      semantic change; default page result is `14 traces × 5 rows`).
    - STEP 11: "Ephemeral history did not register sync query" — the
      backend logs sync correctly (verified by HTTP-3); UI selector
      or refresh-timing rot.
  Run with `TRACES_DIR=~/Downloads node smoke_ui.js`. The smoke now
  spawns the backend with a unique `--db-path` so it can run
  alongside a daily backend without file-lock fights.
- **Genuinely uncovered (TODO)**: 4 HTTP-level cases left
  (sync-side timing variant; `settingId` ignored fall-through;
  cancel-with-zero-rows tableName clear; TTL skips IN_PROGRESS).
  ~5 UI/manual-only items (live-tick duration, sticky table
  headers, `--with-db-ui` smoke, M6, J8).
- **Stale UI smoke fixes pending**: STEP 20 selector chain;
  STEP 11 history-refresh wait; STEP 8 row-count expectation. Each
  is small but needs interactive Playwright debugging.

This catalog drives the next round of smoke additions. Each `TODO`
is intended to graduate to `HTTP-N` or `UI-N` as it gets covered.
