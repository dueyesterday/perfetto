# BigTrace Local TraceProcessor Backend

A FastAPI server that implements the BigTrace HTTP API but executes user
SQL against a **local directory of real trace files** using the in-repo
perfetto Python `TraceProcessor` package. Query history and materialized
result tables are persisted to a single DuckDB file.

This is a sibling of `tools/bigtrace_ref_backend` (the mock) and shares
the same wire shape, so the BigTrace UI in `ui/src/bigtrace/` can talk to
it without modification. Default port is `8002` so it can run alongside
the mock (which defaults to `8001`).

## What this is, and what it isn't

This is **not** a real BigTrace deployment. It's a single-machine
approximation useful for:

- developing the UI against actually-realistic data,
- iterating on PerfettoSQL queries that span a handful of traces,
- exercising the BigTrace API surface end-to-end without infra.

A real BigTrace would have an indexer, a fleet of workers, etc. None of
that is here. Specifically:

- **No real distribution.** "N traces in parallel" means N
  `TraceProcessor` shell subprocesses on this machine, capped by
  `--max-pool` (default 4). Workers run on a `ThreadPoolExecutor`; the
  asyncio event loop only orchestrates.
- **No indexer.** A real BigTrace deployment pre-extracts device /
  Android metadata from each trace and exposes filter chips. We don't —
  `/trace_metadata_settings` returns an empty list and the UI hides the
  "Trace Metadata" section.
- **In-flight `tp.query()` cannot be interrupted.** A `:cancel` returns
  HTTP 200 immediately and atomically transitions the run to CANCELLED,
  but worker threads currently inside their TP HTTP roundtrip have to
  finish. Their results are then dropped at the merge step under the
  cancellation lock — see "Cancellation guarantees" below.

## Persistence (DuckDB)

State lives in a single DuckDB file (default
`~/.cache/bigtrace_local/state.duckdb`, configurable via `--db-path`).
Two stores:

- **`query_executions`** — one row per submitted query, holding the
  metadata: status, sql, timing, processed counters, error text,
  tableName, soft-delete flag.
- **`bigtrace_<uuid>`** — one DuckDB table per async query whose
  worker successfully merged at least one row (UUID hyphens become
  underscores so the identifier is unquoted-SQL-safe). Schema is
  dynamic (driven by the user's SELECT columns); the first column is
  always `trace_id`. Created lazily on first merge; dropped on TTL
  expiry, cancel-with-zero-rows, FAILED terminal, or DELETE.

A single DuckDB connection lives in the server process, guarded by an
internal `threading.Lock`. Bulk inserts use the Arrow fast path
(`from_arrow(...).insert_into(...)`) — 1M rows in ~0.5s vs ~10 minutes
via `executemany`.

### `tableName` lifecycle

The wire-protocol field `tableName` is the source of truth for "is
there a fetchable result for this query." The UI guards every
`:fetch_results` call on `tableName != null`; the backend enforces it
as a safety net by returning **HTTP 400 FAILED_PRECONDITION** when
the entry exists but isn't fetchable. NOT_FOUND (404) is reserved
for genuinely-missing UUIDs and out-of-band table drops — see the
endpoint table below for the full mapping.

| State                              | tableName |
| ---------------------------------- | --------- |
| Sync query                         | None      |
| Async submit                       | **set**   |
| IN_PROGRESS                        | set       |
| SUCCESS (any rowcount)             | set       |
| CANCELLED with rows > 0            | set       |
| CANCELLED with 0 rows              | None      |
| FAILED                             | None      |
| Soft-deleted (DELETE)              | None      |
| Terminal + TTL elapsed             | None      |

### Cancellation guarantees

- `:cancel` is atomic **under the DuckDB connection lock**. The handler
  flips `status='CANCELLED'`, `end_time`, `processed_rows`, and clears
  `tableName` (only when no rows had merged yet) in one critical
  section, then returns 200. There is no in-process cancel flag —
  cancellation is a property of the persisted state.
- After 200 returns, **no row can land in the materialized table.**
  The merge step (`db.merge_trace_atomic`) bundles status-check +
  insert + counter-bump under that same DuckDB lock, so any worker
  that contends for the lock after the cancel handler released it
  observes the new status and bails before inserting. Workers
  already inside their `tp.query()` round-trip finish naturally;
  their rows are discarded at the merge step.
- A multi-process deployment behind a load balancer behaves the same
  way: cancel arriving at instance B can stop work on instance A
  because the only authoritative signal is the shared DuckDB row.
- Pre-200 races (between the user clicking cancel and the handler
  running on the server) are unavoidable HTTP latency; the few rows
  merged in that window are kept as the cancelled run's partial
  result and remain fetchable through `:fetch_results`. The cancel
  contract is "as of when the server committed your cancel," not
  "as of when you clicked."

### Soft-delete

`DELETE /query_executions/{uuid}` flips `deleted = TRUE` in
`query_executions` and drops the materialized table to free disk. The
metadata row stays for audit. After soft-delete:

- `GET /query_executions/{uuid}` (full), `:status`, `:fetch_results` →
  404 (treats the entry as gone — `_get_snapshot_or_404` filters
  `WHERE deleted = FALSE`).
- `GET /query_executions` (list) → filters out deleted rows.
- Re-DELETE the same UUID → 404 (already gone).

DELETE on an `IN_PROGRESS` query → 409: cancel first, then delete.

### TTL

Materialized result tables are dropped after `--table-ttl-seconds`
(default 86400, i.e. 1 day) since the run reached a terminal state. A
periodic asyncio sweep (`--table-ttl-sweep-seconds`, default 300s) runs
the cleanup. Metadata rows survive — only the row buffer goes away.
After expiry:

- `tableName` is null on the metadata row;
- `:fetch_results` returns **400 FAILED_PRECONDITION** ("no longer
  has a materialized table");
- The history list still shows the entry with its preserved
  status/SQL/processed counts.

### Result limit is global, not per-trace

The `limit` parameter on `/execute_bigtrace_query{,_async}` is a
**total** cap. With `limit=1000` over 14 traces the materialized table
contains at most 1000 rows. Workers short-circuit at the cancel/limit
checks once the cap is reached, so trailing traces don't waste TP
work.

### Sorting (`order_by` on `:fetch_results`)

`GET /query_executions/{uuid}:fetch_results` accepts an optional
`order_by` query parameter that follows
[AIP-132 §Ordering](https://google.aip.dev/132#ordering):

```
order_by  = field [direction] *( "," field [direction] )
direction = "asc" | "desc"            ; default "asc"
```

Examples:

| `order_by`              | Effect                                          |
| ----------------------- | ----------------------------------------------- |
| `` (omitted)            | Insertion order (worker merge order). Default. |
| `dur`                   | `ORDER BY "dur" ASC`                            |
| `dur desc`              | `ORDER BY "dur" DESC`                           |
| `name asc, dur desc`    | `ORDER BY "name" ASC, "dur" DESC`               |

Field names must match a column of this query's materialized table
(`trace_id` plus the user's SELECT columns, in DuckDB's
`information_schema.columns`). The backend whitelists every field
against that schema before composing the SQL — there is no SQL
injection surface and no way to leak columns from other tables. All
identifiers are double-quoted in the generated SQL so column names
that collide with DuckDB keywords or contain special characters work
correctly.

Error shape (HTTP 400, `application/json`, `{"detail": "..."}`):

- Unknown field: `unknown order_by column 'foo'; available: [...]`
  (the available-columns list is included so clients can render a
  helpful suggestion).
- Bad direction: `direction must be 'asc' or 'desc': 'foo bar'`.
- Empty / malformed token: `empty order_by entry` /
  `invalid order_by entry: '...'`.

Pagination (`limit`/`offset`) is applied **after** ordering — the
backend always orders the full result, then slices. Repeating the
same `offset` with a different `order_by` returns a different slice
of the (re-)ordered result. The UI's data source preserves the
user's current page across sort changes (page 3 + click `id asc` →
third-page slice of the new ordering), matching the in-tree
`InMemoryDataSource` and broader data-grid convention. Clients that
want "top of new sort" semantics must explicitly request
`offset=0`.

### Filtering (`filter` on `:fetch_results`)

`GET /query_executions/{uuid}:fetch_results` accepts an optional
`filter` query parameter — a URL-encoded JSON array describing
predicates to AND together. The wire shape mirrors the BigTrace UI's
DataGrid `model.ts:Filter`, so the UI can ship `model.filters`
through unchanged.

```jsonc
[
  {"field": "<col>", "op": "=",        "value": "<string>"},
  {"field": "<col>", "op": "in",       "value": ["<string>", ...]},
  {"field": "<col>", "op": "is null"}
]
```

Op categories (`parse_filter` enforces value-arity per category):

| Category   | Ops                                      | `value` shape                      |
|------------|------------------------------------------|------------------------------------|
| Comparison | `=`, `!=`, `<`, `<=`, `>`, `>=`          | string                             |
| Pattern    | `glob`, `not glob`                       | string                             |
| Set        | `in`, `not in`                           | non-empty array of strings         |
| Null       | `is null`, `is not null`                 | absent (no `value` key)            |

`value` is always a JSON string for scalar ops, an array of strings
for `in` / `not in`, or absent for `is null` / `is not null`. The
UI's encoder coerces non-string primitives via `String(...)` so
numbers, booleans, and bigints all serialize losslessly —
`(1700000000000000000n).toString() === "1700000000000000000"`
preserves int64 precision past `Number.MAX_SAFE_INTEGER`. The
backend then relies on DuckDB's parameter binding to coerce the
string to the column's actual type at execute time:
`WHERE big = ?` with bind value `"1700000000000000000"` matches
the BIGINT row exactly. Comparisons (`<`, `>`, etc.) against numeric
columns are numeric, not lexical.

The parser (`parse_filter`) is permissive about non-string `value`s
— it accepts any JSON scalar and lets DuckDB coerce. The string
contract is on the *encoder* side; a hand-rolled client that ships
a number gets the same coercion DuckDB would do for a string.

#### SQL composition

`compile_where` produces a fragment + bound-params list that
`fetch_paginated` splices into the page query as
`SELECT * FROM <tbl> [WHERE …] [ORDER BY …] LIMIT ? OFFSET ?`:

| Op                        | SQL fragment              | Bind params  |
|---------------------------|---------------------------|--------------|
| `=`, `!=`, `<=`, `>=`, `<`, `>` | `"col" OP ?`         | 1            |
| `glob`                    | `"col" GLOB ?`            | 1            |
| `not glob`                | `NOT ("col" GLOB ?)`      | 1            |
| `in`                      | `"col" IN (?, ?, …)`      | N            |
| `not in`                  | `"col" NOT IN (?, ?, …)`  | N            |
| `is null`                 | `"col" IS NULL`           | 0            |
| `is not null`             | `"col" IS NOT NULL`       | 0            |

Identifiers are double-quoted (so user column names with reserved
words / special chars work). All values bind via `?` — never
spliced into the SQL string, so there's no injection surface even
though we don't sanitize the raw JSON. `not glob` wraps as
`NOT (col GLOB ?)` because DuckDB's parser doesn't accept
`NOT GLOB` as a single token (it does for `NOT LIKE`/`NOT ILIKE`).

#### Errors (HTTP 400, `application/json`, `{"detail": "..."}`)

`parse_filter` rejects each of the following with `ValueError` →
mapped to 400 INVALID_ARGUMENT:

- Malformed JSON, or top-level value not a JSON array.
- Entry missing `field` (non-empty string) or `op` (recognized).
- Comparison / pattern op with array `value`.
- `in` / `not in` with non-array or empty-array `value`.
- Null op carrying any `value` key.

Plus, `compile_where` rejects:

- `field` not in the materialized table's column list (with
  `available: [...]` echoed in the detail so clients can render a
  helpful suggestion, mirroring the `order_by` error shape).

And, at bind time, the endpoint catches DuckDB's
`ConversionException` and returns 400 — e.g.,
`"abc"` against a BIGINT column surfaces as
`filter value type mismatch: Could not convert string 'abc' to INT64`
rather than a 5xx.

#### `totalFilteredRows` in the response

`:fetch_results` always returns `totalFilteredRows` alongside
`columnNames` / `rows`:

- No `filter` set → materialized table size (a
  `SELECT COUNT(*) FROM <tbl>`).
- `filter` set → post-filter count
  (`SELECT COUNT(*) FROM <tbl> WHERE …`).

The UI uses it to size the DataGrid's virtual scrollbar over the
visible (filtered) set rather than the materialized total. Always-
present means clients don't have to branch on its absence.

`fetch_paginated` issues the page fetch and the count under a single
`Database._lock` acquisition, so the count is consistent with the
rows even if a TTL sweep races us. Two SQL statements, one lock,
two round-trips of work but one wire round-trip.

### Response value contract (always-strings)

Every endpoint that returns a tabular result uses one uniform value
shape:

> **Row values are always JSON strings (or `null` for SQL NULL),
> regardless of the underlying column type.**

`server.py:_value_to_wire` is the funnel: every value goes through
it before serializing. INT64s, DOUBLEs, BOOLEANs, TIMESTAMPs all
become strings on the wire. Booleans canonicalize to lowercase
`"true"` / `"false"` so they round-trip through the always-strings
filter wire cleanly. Both `:fetch_results` (via `_rows_response`)
and `/execute_bigtrace_query` (the inline sync response) use it.

Why: int64 values past `Number.MAX_SAFE_INTEGER` (2^53) silently
lose precision when JS parses them as `Number`, which corrupts
both display and any subsequent filter that targets the value.
Stringifying preserves precision for any magnitude. The UI never
converts strings back to typed JS values — `parseQueryResponse`
passes them through unchanged, cell renderers display them as-is,
and the cell-filter menu naturally ships the string back through
the always-strings filter wire. End to end, no type-detection
code anywhere on the wire path.

#### Sync sort caveat

Async results are sorted server-side (the `order_by` clause sees the
typed column in DuckDB), so always-strings on the wire doesn't affect
sort correctness.

Sync results are sorted **client-side** by `InMemoryDataSource`
(a perfetto-repo shared widget). Its comparator branches on
`typeof valueA === 'number'` etc. and falls back to `localeCompare`
on strings. With the always-strings contract, every column ends up
in the lexical-sort branch — `"100" < "99"` because `'1' < '9'`.
This means **numeric-looking columns sort lexically on sync queries**,
a known regression that ships with the always-strings change.

Two ways to fix it (neither done):

1. Ship per-column type information in the response (e.g.,
   `columnTypes: ["BIGINT", "VARCHAR", ...]`) and have a /bigtrace-
   local data source pre-coerce values to the right JS type before
   handing rows to `InMemoryDataSource`.
2. Replace `InMemoryDataSource` for the sync path with a /bigtrace-
   local data source whose comparator parses each column's values
   once and picks numeric vs lexical accordingly.

The async path is the high-value path (paginates over potentially-
large materialized tables); sync is bounded by interactive ad-hoc
result sizes, so the precision benefit there outweighs the sort
regression cost.

### Recovery on restart

Any rows still `IN_PROGRESS` when the server starts (because a previous
process died mid-run) are marked `FAILED` with `error_message =
"Server restarted before query completed"`, `tableName = null`, and
their materialized tables are dropped.

## Quick start: all four services

The full local-dev setup consists of four services. Three live in this
repo (TP backend + optional Datasette inspector + optional DuckDB UI),
all spawned by one Python process. The fourth is the perfetto bigtrace
UI dev server in a sibling repo.

```sh
# One-time: bootstrap the venv (creates .venv/, installs deps).
cd ~/Projects/perfetto_2/tools/bigtrace_local_tp_backend && ./setup_venv.sh

# Terminal 1: BigTrace local TP backend (+ Datasette + DuckDB UI).
# The traces directory is set in the BigTrace UI, not on the CLI.
cd ~/Projects/perfetto_2/tools/bigtrace_local_tp_backend
.venv/bin/python server.py --with-datasette --with-db-ui

# Terminal 2: perfetto bigtrace UI dev server (lives in the perfetto repo).
cd ~/Projects/perfetto
ui/node ui/build.js --only-wasm-memory64 --serve --watch --bigtrace
```

You'll have:

| URL                                      | What                                                  |
| ---------------------------------------- | ----------------------------------------------------- |
| `http://127.0.0.1:8002/query_executions` | TP backend HTTP API                                   |
| `http://127.0.0.1:8003/state`            | Datasette (SQL editor + table viewer over DuckDB)     |
| `http://127.0.0.1:4213/`                 | DuckDB's own web UI                                   |
| `http://127.0.0.1:10000/bigtrace.html`   | Perfetto bigtrace SPA                                 |

To point the bigtrace SPA at this backend, in DevTools console once:

```js
localStorage.setItem('bigtraceSettings',
  JSON.stringify({bigtraceEndpoint: 'http://127.0.0.1:8002'}));
location.reload();
```

`--with-datasette` and `--with-db-ui` are independent — drop either if
you don't want it. Default ports are `8003` and `4213` respectively;
both accept an explicit port (`--with-datasette 8500`).

## Setup

The Python `TraceProcessor` lives in this repo's `python/` directory
— `setup_venv.sh` finds it relative to the script location and
installs it editable so you always get the in-repo version, not the
PyPI release. To point at a different checkout (e.g. a sibling
clone), set `PERFETTO_PY=/path/to/perfetto/python` before running the
script.

```sh
./setup_venv.sh
```

This creates `.venv/`, installs `fastapi`, `uvicorn`, `numpy`,
`protobuf`, `duckdb`, `pyarrow`, `datasette`, `datasette-parquet`,
and pip-installs `~/Projects/perfetto/python` in editable mode.
Re-run any time `requirements.txt` changes.

## Run

```sh
.venv/bin/python server.py \
  [--port 8002] \
  [--max-pool 4] \
  [--db-path ~/.cache/bigtrace_local/state.duckdb] \
  [--table-ttl-seconds 86400] \
  [--table-ttl-sweep-seconds 300] \
  [--with-db-ui [PORT]] \
  [--with-datasette [PORT]]
```

The traces directory is **not** a CLI flag — the BigTrace UI's
Settings page asks the user for a `Trace Directory`, and that path is
sent in the `settings` array of every query. The backend has no
server-side default; queries with no `trace_directory` set return
HTTP 400 with a descriptive error. Files matched:
`.pftrace`, `.perfetto-trace`, `.pb`, `.trace`.

This runtime override is a **local-dev-only** convenience. Never port
it verbatim into a real BigTrace deployment: letting an HTTP client
choose an arbitrary filesystem path on the server is unsafe in any
multi-tenant context. See the comment at the top of `settings.py`.

The first time a trace is queried, TP loads it (slow, ~seconds-ish for
small traces, longer for large ones). Subsequent queries against the
same trace reuse the loaded TP. The pool is LRU; once `--max-pool`
traces are loaded, the next load evicts the least-recently-used.

The DuckDB file at `--db-path` is created on first run if absent. To
start fresh: stop the server and delete the file (and its `.wal`
sibling). Read it concurrently with the server via the in-process UI
(see "Inspecting the DuckDB store" below).

## Endpoints

Same shapes as `bigtrace_ref_backend`. Read
`~/Projects/CLAUDE.md` ("BigTrace Backend API") for the contract.

| Method | Path | Notes |
|---|---|---|
| POST | `/execute_bigtrace_query_async` | Returns `{queryUuid: string}` (top-level). Spawns a background task that runs the SQL across every trace matching `trace_filter`; `tableName` is set immediately. Body accepts top-level `trace_filter: Filter[]` (structured trace-selection filter — same shape as `:fetch_results?filter=`), `trace_metadata_columns: string[]` (catalog column names from `/traces_schema` to attach to every result row via the per-query metadata sidecar), and `trace_order_by: string` (AIP-132 string controlling the order traces are processed; matters under `trace_limit`). |
| POST | `/execute_bigtrace_query` | Sync variant. Returns `{queryUuid, columnNames, rows}` — the assembled tabular result inline plus a server-assigned identifier. Logged to history with `materialized=false`. Same `trace_filter` + `trace_metadata_columns` + `trace_order_by` body fields as the async path; sync stitches metadata inline (no materialized table to JOIN against). |
| GET | `/query_executions/{uuid}:status` | **Strict progress-only**: exactly `{status, processedTraces, totalTraces, processedRows}` — four fields, no submit-time-immutable metadata. UI polls this every 3s; static metadata (and the per-query snapshot) lives on the full GET. `queryUuid` is the URL key, not echoed in the body. |
| GET | `/query_executions/{uuid}` | Full execution details. Read once at submit and again on terminal-state transition for the static metadata, `tableName`, and the **submit-time snapshot** (`settings` / `traceFilter` / `traceMetadataColumns` / `traceOrderBy`) — see the "Per-query snapshot" section below. 404 if soft-deleted. |
| GET | `/query_executions/{uuid}:fetch_results` | Paginated `?limit=&offset=` over the materialized result, with optional [AIP-132](https://google.aip.dev/132#ordering) `&order_by=field [asc\|desc][, field [asc\|desc]]*`, optional `&filter=` (URL-encoded JSON `Filter[]`), and optional `&columns=` (URL-encoded comma-separated field-mask over `result_table_cols ∪ metadata_sidecar_cols`). The page SQL emits a LEFT JOIN to the sidecar iff the projection / filter / order_by references a sidecar column. Response: `{columnNames, rows, totalFilteredRows, availableColumns}` — `availableColumns` is the full union the client could project. Errors follow gRPC/AIP semantics: **404 NOT_FOUND** if missing/soft-deleted or the table is gone in DuckDB; **400 FAILED_PRECONDITION** if the entry exists but isn't fetchable (`materialized=false`, `processed_rows=0`, or `tableName=null` from FAILED/CANCELLED-with-zero/TTL-expired); **400 INVALID_ARGUMENT** on malformed or unknown-column `order_by` / `filter` / `columns`. See "Sorting" / "Filtering" above. |
| POST | `/query_executions/{uuid}:cancel` | Atomically transitions to CANCELLED under the DB lock. 200. No row lands after this returns. |
| GET | `/query_executions` | Lists all non-soft-deleted executions, newest first. `perfettoSql` and `errorMessage` truncated to 200 chars; full text on the per-uuid endpoint. **Omits** the per-query snapshot fields (`settings` / `traceFilter` / `traceMetadataColumns` / `traceOrderBy`) so the history sidebar response stays lean — fetch the per-uuid endpoint to inspect a historical query's snapshot. |
| DELETE | `/query_executions/{uuid}` | Soft-delete. 200 on terminal, 409 on IN_PROGRESS, 404 if already deleted/missing. |
| POST | `/traces` | Paginated trace metadata for the trace source named in `settings`. Body: `{settings, filter?: Filter[], order_by?: string, limit, offset, columns?: string[]}`. Response: `{columnNames, rows, totalFilteredRows, availableColumns?}` — same always-strings wire as `:fetch_results`. `filter` / `order_by` use the same parser as `:fetch_results`. `columns` is an optional field-mask; omitted means "every column the backend flags `default: true` in `/traces_schema`". Powers the trace-selection grid on the BigTrace UI's Settings page. |
| POST | `/traces_schema` | Declares the columns `/traces` can return. Body: `{settings}` (a backend whose schema depends on the source can vary the response). Response: `{columns: [{name, type, default: boolean, description?}]}`. Local TP returns the static four-column filesystem schema (`file_path`, `file_name`, `size_bytes`, `mtime`); a real BigTrace would extend with indexer-derived per-trace metadata. |
| POST | `/bigtrace_execution_config` | Static settings schema (see `settings.py`). |
| POST | `/trace_metadata_settings` | Empty (no indexer). UI hides the section. |

Result rows on the local TP backend are tagged with the trace they
came from: the first column is `trace_id` (basename of the trace file
with the extension stripped), followed by the user query's columns.
This is a local-TP convention, not a wire requirement — the contract
just promises that whatever per-row identifier the backend chose is
the JOIN key into the metadata sidecar (a real BigTrace backend would
use a permalink instead).

The `settings` array on `/execute_bigtrace_query{,_async}` is applied
to the run (trace directory, trace limit) **and** persisted as part of
the per-query snapshot — see "Per-query snapshot" below.

### Per-query snapshot (`settings` / `traceFilter` / `traceMetadataColumns` / `traceOrderBy`)

Four optional top-level fields on `/execute_bigtrace_query[_async]`
are persisted per execution and echoed back on the full per-uuid GET
so the UI can answer "what did this query run with?" Powers the
per-tab Bigtrace Settings sub-tab on `/query`.

| Field | Request body shape | Response shape (per-uuid GET) |
|---|---|---|
| `settings` | `Array<{setting_id, values, category}>` | `settings: Array<{setting_id, values, category}>` |
| `trace_filter` | `Filter[]` (same shape as `:fetch_results?filter=`) | `traceFilter: Filter[]` |
| `trace_metadata_columns` | `string[]` (column names from `/traces_schema`) | `traceMetadataColumns: string[]` |
| `trace_order_by` | `string` (AIP-132, same grammar as `/traces?order_by=`) | `traceOrderBy: string` |

Persistence rules:

- **Frozen at submit.** Stored before any validation runs, so even a
  query that 400s at submit time records what was attempted. State
  transitions (`mark_success` / `mark_failed` / `mark_cancelled`) do
  not modify the snapshot.
- **Stored on `query_executions`** in four VARCHAR columns
  (`settings`, `trace_filter`, `trace_metadata_columns` as JSON
  strings; `trace_order_by` as the raw AIP-132 wire string — no JSON
  wrap, the value is already a string). ALTER TABLE ADD COLUMN IF
  NOT EXISTS migrates older DBs on `_init_schema`.
- **Empty semantics.** For list-typed fields, absent / `null` / `[]`
  on the wire all persist as SQL NULL and read back as `[]`. For
  `trace_order_by`, absent / `null` / `""` persist as SQL NULL and
  read back as `""`. The full-GET response always carries `[]` /
  `""` rather than `null` so the UI never null-checks these fields.
- **Lean polling + lean history.** The snapshot is **not** echoed on
  `:status` (every 3s poll) or on `/query_executions` (history
  sidebar). Clients call the per-uuid full GET to inspect a snapshot.

### Trace selection grid (`/traces` + `/traces_schema`)

The BigTrace UI Settings page embeds a paged DataGrid that calls
`/traces` for trace metadata and `/traces_schema` for the column
catalog. The grid's filter chips become the `trace_filter` field on
the next `/execute_*` call — the "implicit selection" model: the
filter on the grid IS the trace set the query runs over.

The grid's **sort** flows through the same way: whatever AIP-132
`order_by` the user picked on the column header becomes the
`trace_order_by` field on the next `/execute_*` call, and the
backend processes traces in that order. This matters under
`trace_limit > 0`: sort + limit together pick "the top N traces in
this order", so changing the grid sort changes which traces a
capped query actually runs over. When `trace_order_by` is absent,
the backend falls back to `file_path ASC` for legacy-client
determinism.

For this backend the schema is the four filesystem columns
(`file_path`, `file_name`, `size_bytes`, `mtime`); a Phase-2 backend
would add `device_name`, `android_id`, etc. once a metadata indexer
exists. The UI doesn't hardcode column names — every choice in the
shown-columns + columns-to-attach pickers is built from
`/traces_schema`.

### Trace metadata sidecar + fetch-time projection

When a client opts into `trace_metadata_columns: [...]` on
`/execute_*`, the server creates a per-query sidecar table
`bigtrace_<uuid>_meta` keyed by the executor's per-row identifier
(here, `trace_id`) at submit time and bulk-inserts one row per
trace. The main `bigtrace_<uuid>` result table stays free of
metadata — only SQL output + identifier.

At fetch time, `:fetch_results?columns=` projects from the union
of (result-table cols ∪ sidecar cols); the page SQL emits

```sql
SELECT <chosen cols> FROM bigtrace_<uuid> result
LEFT JOIN bigtrace_<uuid>_meta meta ON result.trace_id = meta.trace_id
WHERE ... ORDER BY ... LIMIT ... OFFSET ...
```

only when the projection / filter / order_by references a sidecar
column. Users can tick or untick metadata columns on the query
results page without re-executing the query; storage scales with
`N_traces × M_metadata_cols` (small), not `N_result_rows ×
M_metadata_cols` (potentially huge).

The sidecar shares lifecycle with the main result table: every drop
hook (`mark_failed`, `mark_cancelled`, `soft_delete`,
`expire_terminal_tables`, `recover_stale_in_progress`) drops both
tables together via `_drop_materialized_locked`.

Sync queries don't materialize, so they stitch any
`trace_metadata_columns` values inline into each result row (between
`trace_id` and the SQL columns). Same observable wire — `:fetch_results`
on a sync UUID is 400 FAILED_PRECONDITION anyway, so the projection
mechanism doesn't apply.

## Inspecting the DuckDB store

Several options; `--with-datasette` is the most practical.

### Option 1: in-process Datasette (recommended)

```sh
.venv/bin/python server.py --with-datasette
# Datasette on http://localhost:8003/state
```

Or with a custom port: `--with-datasette 8500`.

Datasette runs in the same process as the BigTrace server (so DuckDB
connections coexist without file-lock contention) on its own port (so
no FastAPI mount path-prefix headaches). It uses the
[datasette-parquet](https://github.com/cldellow/datasette-parquet)
plugin to read DuckDB files directly.

You get:

- `http://localhost:8003/state` — list of tables (history + every
  materialized result table),
- `http://localhost:8003/state?sql=SELECT+*+FROM+...` — SQL editor
  with the query pre-run; **arbitrary SQL via URL params**,
- `http://localhost:8003/state.json?sql=...` — JSON API,
- `http://localhost:8003/state.csv?sql=...` — CSV download,
- the page also offers facets, filtering, sorting in-browser.

When `--with-datasette` is enabled, the wire-protocol `tableLink` for
each materialized query becomes a Datasette deep-link of the form
`http://localhost:8003/state?sql=SELECT * FROM <table> LIMIT 100`,
URL-encoded. Click it in any browser → land in the SQL editor with
that query, ready to edit / filter / export.

**Known plugin caveat:** the table-viewer route
(`/state/<materialized_table>`) emits an unbound `LIMIT :n OFFSET :t`
to DuckDB and 500s. We work around this by routing `tableLink` to
`/state?sql=...` (the SQL endpoint, which works cleanly).

Local-dev only — the SQL editor is permissive (run anything against
the DB). Don't expose the port.

### Option 2: in-process DuckDB UI

Pass `--with-db-ui` and the server boots DuckDB's own web UI on its
existing connection.

```sh
.venv/bin/python server.py --with-db-ui
# DuckDB UI on http://localhost:4213
```

The UI exposes a table browser, SQL editor, and result grid. URL
deep-linking is **not** supported (MotherDuck UI only deep-links to
saved "dives," which are server-side cloud objects we can't construct
locally). For URL-driven workflows prefer Option 1.

Both `--with-datasette` and `--with-db-ui` can run simultaneously.

### Option 3: copy + open externally

DuckDB's file lock is process-exclusive even for read-only
connections. To browse without affecting the running server, copy the
file (and WAL) and open the copy:

```sh
cp ~/.cache/bigtrace_local/state.duckdb /tmp/inspect.duckdb
cp ~/.cache/bigtrace_local/state.duckdb.wal /tmp/inspect.duckdb.wal 2>/dev/null

.venv/bin/python -c "
import duckdb
con = duckdb.connect('/tmp/inspect.duckdb')
con.execute('INSTALL ui; LOAD ui')
con.execute('CALL start_ui_server()')
input('UI on http://localhost:4213 — Enter to stop')
"
```

### Option 4: stop server, inspect, restart

```sh
pkill -f 'bigtrace_local_tp_backend/server.py'
.venv/bin/python -c "
import duckdb
con = duckdb.connect('$HOME/.cache/bigtrace_local/state.duckdb')
con.execute('INSTALL ui; LOAD ui')
con.execute('CALL start_ui_server()')
input('UI on http://localhost:4213 — Enter to stop')
"
# restart server when done
```

Equivalent CLI tools that work the same way: `harlequin -r <path>`
(TUI), or the standalone DuckDB CLI (`duckdb -readonly <path>` after
installing the binary from <https://duckdb.org/docs/installation>).

## Smoke test

```sh
.venv/bin/python smoke_local.py [--traces-dir DIR]
```

Spawns its own server on port `18002` against a fresh DuckDB file in a
temp dir (so it never collides with a daily backend). The smoke
verifies:

1. settings endpoints (`trace_directory` default, schema, empty
   metadata),
2. trace_directory setting end-to-end (custom subdir works, bogus path
   returns HTTP 400),
3. sync query with materialized=false logged in history;
   `:fetch_results` returns 400 FAILED_PRECONDITION (sync queries
   aren't materialized),
4. async query, polling to SUCCESS,
5. paginated `:fetch_results`,
5a. streaming progress + mid-flight `:fetch_results` returning rows
    while IN_PROGRESS (verifies threaded merge is live, not batched),
6. async query that fails (`SELECT * FROM does_not_exist`), with
   `:fetch_results` returning 400 FAILED_PRECONDITION (FAILED
   clears tableName),
7. cancel mid-flight reaching a terminal state,
7a. partials-on-cancel: CANCELLED with rows > 0 keeps tableName +
    rows fetchable; soft-skip if cancel races natural completion,
8. list truncation: `perfettoSql` clipped to 200 chars in the list,
   full on the per-uuid detail,
9. soft delete: list filtered, all per-uuid endpoints 404 after
   DELETE, re-DELETE returns 404,
10. TTL sweep: smoke runs the server with a tight TTL=5s and asserts
    that fetch returns 400 FAILED_PRECONDITION + tableName=null
    after the wait, while
    metadata is preserved.
11. Result limit is **global**, not per-trace: `limit=7` over 14
    traces materializes ≤ 7 rows total.
11a. `trace_limit` caps the **trace** list (not just the result rows)
    — a `trace_limit=2` setting with 14 candidate traces processes
    exactly 2.
12. `:status` payload is **strictly the 4 progress fields**
    (`status`, `processedTraces`, `totalTraces`, `processedRows`).
    No `queryUuid` (URL key, not body), no `endTime`/`errorMessage`,
    no submit-time snapshot — those live on the full GET only.
    Verified for both SUCCESS and FAILED.
13. `DELETE` while a query is `IN_PROGRESS` returns 409 with a
    "cancel first" message; only terminal queries can be soft-deleted.
14. Every per-uuid endpoint (`status`/`fetch_results`/full GET/cancel/
    delete) returns 404 on an unknown UUID.
15. Datasette + `tableLink`: smoke server is spawned with
    `--with-datasette PORT`; verifies the inspector comes up,
    `tableLink` from a successful query points at a Datasette URL with
    `?sql=...`, that URL renders the table HTML, and the `.json`
    variant returns rows.
16. AIP-132 `order_by` on `:fetch_results`: ascending and descending
    on a real column return rows actually sorted; multi-field
    (`name asc, dur desc`) returns rows; bad direction (`dur sideways`)
    and unknown column both yield HTTP 400 with the offending token
    surfaced in the body.
17. Timestamps: `startTime` / `endTime` round-trip as UTC ISO-8601
    with millisecond precision and `start < end` is enforced.
18. Zero-result async: a query whose filter selects zero traces still
    reaches `SUCCESS` with `processedTraces=0` / `processedRows=0`
    (not FAILED, not stuck in IN_PROGRESS).
19. `:cancel` on a terminal query is a silent 200: the status is
    preserved (e.g. SUCCESS stays SUCCESS), no row mutation, no 4xx.
20. Server restart recovery: a query that was IN_PROGRESS at
    process exit transitions to FAILED on the next boot via
    `recover_stale_in_progress`, dropping its half-materialized
    table. Soft-skips if the query naturally raced to terminal
    before the crash point.
21. Top-level `trace_filter: Filter[]` narrows the trace list at
    submit time: `[{field: 'file_name', op: '=', value: '<one>'}]`
    over a 2-trace fixture sets `totalTraces=1`.
22. `:fetch_results?filter=...` (JSON `Filter[]`) end-to-end:
    numeric `>`, `glob`, multi-filter AND each filter to the
    expected row count; `totalFilteredRows` reflects the post-filter
    count; bad JSON, unknown column, and empty `in []` each yield
    400 INVALID_ARGUMENT with the offending entry surfaced.
23. `/traces` + `/traces_schema` end-to-end: schema response carries
    four columns flagged `default: true`; happy-path pagination,
    `filter` and `order_by` parameters match `:fetch_results`
    semantics; `columns` projection narrows the response without
    losing filter/sort over unprojected columns; 9 bad-request
    cases (malformed JSON, unknown column on each axis, etc.) all
    return 400.
24. Async `trace_metadata_columns` end-to-end: opting in creates a
    sidecar table that `:fetch_results?columns=` transparently
    LEFT-JOINs at projection / filter / order_by time;
    `availableColumns` advertises both result-table and sidecar
    columns; unknown columns at submit AND at fetch each return
    400. The sync path stitches the same metadata inline (no
    sidecar — `:fetch_results` doesn't apply to sync).
25. Submit-time snapshot round-trip: `settings` / `trace_filter` /
    `trace_metadata_columns` shipped on `/execute_*` are echoed on
    the per-uuid full GET as `settings` / `traceFilter` /
    `traceMetadataColumns`. `:status` omits all three (lean
    polling). `/query_executions` list also omits them (lean
    history sidebar). Absent / `null` / `[]` on submit all read
    back as `[]` (never `null`).
26. Top-level `trace_order_by` re-orders the trace fan-out: with
    `trace_limit=1` and the default order, the alphabetically-first
    trace is processed; with `trace_order_by='file_name desc'` the
    alphabetically-last is processed instead. The submit-time
    snapshot echoes the wire string verbatim; omitted reads back as
    `""`. A malformed AIP-132 string (e.g. `'file_name sideways'`)
    yields 400 INVALID_ARGUMENT at submit, not a deferred FAILED.

If no traces are available it prints `SKIP` and returns 0.

## Unit tests

```sh
.venv/bin/python -m unittest discover -p '*_unittest.py'
```

Six test files, ~220 tests total, runs in under 2 seconds. Each test
that needs a DB uses a fresh `tempfile.mkdtemp` + `Database(...)`
(no shared state, no pollution of `~/.cache/bigtrace_local/`):

- `db_unittest.py` — parsers (`parse_filter`, `parse_order_by`,
  `compile_where`), formatters (`_ts_to_iso`), type inference
  (`_infer_column_types`), `safe_table_id`.
- `db_state_unittest.py` — Database state-machine transitions
  (insert / mark_success / mark_failed / mark_cancelled with the
  conditional-on-IN_PROGRESS invariant), soft-delete, list_qes,
  get_status, merge_trace_atomic (including the `'skipped'` outcome
  on CANCELLED — the cancel-protocol cornerstone), TTL sweep and
  startup recovery, fetch_paginated end-to-end, sync timing.
- `server_unittest.py` — wire helpers (`_truncate`, `_value_to_wire`,
  `_wire_rows`), response shape (`_qe_to_status` strict-five-fields,
  `_qe_to_raw` conditional optionals), trace-dir resolvers
  (existence, kind, permissions), `_get_db` / `_get_snapshot_or_404`
  HTTP error contracts, async-runner error-message format.
- `query_executor_unittest.py` — `_trace_id_for`, `list_matching_traces`
  (extension whitelist, regex narrow, regex-error fallback),
  `_TRACE_EXTS` ordering invariant, `RunContext.should_stop`
  (cap + cancel branches, short-circuit ordering).
- `trace_pool_unittest.py` — LRU acquire/eviction with
  `TraceProcessor` mocked out; race-loser path closes outside the
  pool lock; close-failure swallowing.
- `settings_unittest.py` — settings extraction with strict
  snake_case `setting_id` (camelCase `settingId` ignored), default
  fallbacks, type coercion edge cases.

The smoke test (above) covers HTTP-layer behavior end-to-end against
a real backend; these unit tests localize regressions to the
function level so a failure points at the line of intent rather
than a phase number.

## Cleanup / resetting state

Everything the backend writes is local-only and safe to wipe.

### Stop everything

```sh
# Daily backend (TP, Datasette, DuckDB UI all live in this one process)
PID=$(fuser -n tcp 8002 2>/dev/null | tr -d ' ')
[ -n "$PID" ] && kill -INT "$PID"

# Perfetto UI dev server (only if you started one)
pkill -INT -f 'ui/build\.js.*--bigtrace'
```

`kill -INT` triggers a clean shutdown: the TP pool closes, DuckDB
flushes the WAL, the in-process Datasette task is cancelled.

### Wipe persistent state

```sh
# Clear query history + every materialized table.
mv -f ~/.cache/bigtrace_local/state.duckdb     ~/.cache/bigtrace_local/state.duckdb.bak
mv -f ~/.cache/bigtrace_local/state.duckdb.wal ~/.cache/bigtrace_local/state.duckdb.wal.bak 2>/dev/null
# Or, if you don't care about the backup, delete outright:
# rm ~/.cache/bigtrace_local/state.duckdb*
```

The next server start re-creates the DuckDB file with an empty
schema. Nothing else outside `~/.cache/bigtrace_local/` is persisted.

### Wipe smoke artifacts

```sh
# HTTP smoke uses a temp dir under /tmp/bigtrace_local_smoke_db_*
rm -rf /tmp/bigtrace_local_smoke_db_*

# UI smoke writes screenshots into ./shots and uses a fixed db file
rm -rf shots /tmp/bigtrace_smoke_ui.duckdb*
```

### Reset the trace fixture dir

If you've been carving up `/tmp/btraces` (the default for
`smoke_ui.js`) and want a known-good minimal set:

```sh
mkdir -p /tmp/btraces && rm -f /tmp/btraces/*.pftrace
cp <somewhere>/two-small-traces.pftrace /tmp/btraces/
ls /tmp/btraces  # should print exactly the files you want tested against
```

Two hand-picked traces is the recommended fixture — it exercises the
multi-trace fan-out path and gives you a deterministic
`totalTraces == 2` for assertions.

### UI-side state

The bigtrace SPA persists tabs + endpoint config in `localStorage`
under the key `bigtraceQueryTabs` and `bigtraceSettings`. Wipe via
DevTools console:

```js
localStorage.removeItem('bigtraceQueryTabs');
localStorage.removeItem('bigtraceSettings');
location.reload();
```

A reload after wipe takes you back to the fresh-install state with no
open tabs and the default endpoint.

## Roadmap: graduating from local-dev to multi-user

This backend is single-process by design. The architecture is already
prepared for horizontal scaling — wire protocol is stateless, cancel
flows through DuckDB, the merge step is a single atomic DB call — but
none of the multi-user infrastructure is implemented because nothing
about local-dev needs it. Saved here so the work isn't repeated when
the time comes.

### What's already multi-process-correct

- **No process-memory shared state.** The HTTP layer is stateless
  beyond `CONFIG` (read-only) and the `TracePool` (per-instance
  cache, not shared coordination).
- **Cancel via DB.** The cancel handler writes `qe.status = CANCELLED`;
  workers poll `db.get_status(uuid)` at trace boundaries; the merge
  step bundles status-check + insert under one DB lock, so the "no
  rows after `:cancel` returns 200" guarantee holds without any
  in-memory channel.
- **Conditional terminal transitions.** `mark_success` / `mark_failed`
  use `WHERE status = 'IN_PROGRESS'` so natural completion can never
  clobber a cancel that landed concurrently — same correctness across
  any number of processes.
- **Wire protocol is process-agnostic.** `:status`, `:fetch_results`,
  `:cancel`, the full GET, the list, soft-delete — none of them
  reference in-memory state.

### What changes when graduating

1. **Storage**: DuckDB → Postgres (metadata) + Postgres or ClickHouse
   (per-query materialized tables). Replace the `Database` class with
   a Postgres-backed implementation; the API surface
   (`merge_trace_atomic`, `get_status`, `mark_*`) translates 1:1.
   Connection pooling instead of single-connection + lock; row-level
   locking does the work the global lock does today.
2. **Workers**: separate fleet behind a queue. HTTP backend writes a
   PENDING row; worker process pulls from a queue, runs the threaded
   executor, writes results. The current `_run_async_query` coroutine
   is already self-contained — split it into a worker entry point.
3. **Trace files**: object storage (S3 / GCS). `list_matching_traces`
   becomes a list-objects call. `TracePool` either pre-stages locally
   or uses a TP build that streams from a URL.
4. **Cancel latency**: DB polling at trace boundaries is good enough
   for now (single seconds). For sub-second cancellation, add a pub/
   sub layer (Redis or Postgres `LISTEN/NOTIFY`); the worker subscribes
   to `cancel:<uuid>` for the runs it owns.
5. **Auth & multi-tenancy**: API-key / JWT header → FastAPI dependency
   resolves to a `Tenant`. `query_executions` gets a `tenant_id`
   column; every read filters by it; every write stamps it. Per-tenant
   quotas live in their own table.

### What stays the same

- The HTTP wire protocol (no client-side changes).
- The smoke contracts (just point them at a Postgres URL).
- TTL semantics (a SQL `DELETE` instead of an iteration in code).
- The atomicity boundary in `merge_trace_atomic`.

The current refactor got us roughly 70% of the way there. The
remaining 30% is concrete service swaps, not architecture redesigns.

### Detailed: storage atomicity and the cancel contract

The "no rows visible to the API after `:cancel` returns 200" guarantee
holds today because the worker's `merge_trace_atomic` bundles
status-check + INSERT + counter-bump under one DuckDB lock. Whether
that survives in a multi-user version depends on the storage choice.

**Unified storage (one DB for metadata + per-query result tables)**

Pattern:

```sql
BEGIN;
SELECT status FROM query_executions WHERE query_uuid = $1 FOR UPDATE;
-- if status != 'IN_PROGRESS': ROLLBACK and bail
INSERT INTO bigtrace_<uuid> VALUES (...);
UPDATE query_executions SET counters... WHERE query_uuid = $1;
COMMIT;
```

The row lock plus `WHERE status='IN_PROGRESS'` re-check inside the
transaction gives the same guarantee we have today — provided
`mark_success` / `mark_failed` are also conditional UPDATEs (so a
natural-completion path can never clobber a CANCELLED that landed
concurrently). Multi-process or multi-thread doesn't matter: the row
lock arbitrates regardless of where the worker runs.

Also: wrap merge in explicit `BEGIN/COMMIT` for crash-safety. Without
it, each statement is its own implicit transaction; a `kill -9`
between INSERT and counter-update leaves the metadata under-counting.
DuckDB supports the wrap today; in Postgres it's mandatory anyway
(the row lock is part of the transaction).

**Split storage (metadata DB + a different result store)**

This is the architecture real BigTrace probably uses (metadata in a
fast row-store; results in a columnar/blob store). You can't have a
single transaction across two systems, so the atomicity boundary has
to move.

The **outbox pattern** is the canonical fix:

```
worker:
  blob = results_store.write(rows)              # unconditional, no atomicity claim
  with metadata.transaction() as tx:
      status = tx.select_status_for_update(uuid)
      if status != 'IN_PROGRESS':
          tx.rollback()
          # blob is now an orphan — GC'd later
          return 'skipped'
      tx.insert_blob_record(uuid, blob_id)      # link
      tx.bump_counters(uuid, len(rows))
      tx.commit()
```

Cancel handler (metadata-only, fast):

```
with metadata.transaction() as tx:
    tx.update_status_to_cancelled(uuid)         # WHERE status='IN_PROGRESS'
    tx.commit()
return 200
```

Reader:

```
SELECT joined-with-query_blobs WHERE uuid = ? AND status != 'CANCELLED'
```

What the user observes:

| Property | Holds? |
|---|---|
| `:fetch_results` returns no rows after cancel committed | yes |
| `:status` / full GET reflects only pre-cancel-commit work | yes |
| `tableLink`-fetched data doesn't grow after 200 | yes |
| Direct dump of the result store has zero rows for cancelled UUIDs | **no** — orphans until GC |

The result store is best-effort; the metadata is the source of truth
for what counts. From the API consumer's perspective the result store
*appears* transactional because the API only ever surfaces what
metadata says.

Alternatives if outbox is too heavy:

- **Read-time filtering**: write rows unconditionally; readers
  filter by metadata status. Cheap, but only correct if every reader
  goes through the filter — direct result-store dumps see orphan rows.
- **Eventual consistency + GC**: accept transient leak; clean up
  orphan rows on a TTL/janitor sweep. Strict "no rows after 200" is
  briefly violated; bounded by the GC interval.

These are not mutually exclusive — production systems often layer
outbox + GC.

**TTL sweep with split storage**

Two-step instead of one:

```
expired = metadata.list_expired(ttl_seconds)
for uuid in expired:
    results_store.drop(uuid)         # may fail; retry idempotent
    metadata.clear_table_name(uuid)  # only after results-side succeeds
```

Or reverse order, accepting transient orphans. The "metadata clear
first" order keeps the contract simpler (`:fetch_results` 404s
deterministically), at the cost of brief orphan blobs in the result
store.

**Recovery on startup with split storage**

```
metadata.recover_stale_in_progress()   # IN_PROGRESS → FAILED, table_name = NULL
orphans = results.list_tables_not_referenced_in_metadata()
for tbl in orphans:
    results.drop_table(tbl)            # eventual cleanup; can be lazy
```

The metadata-side recovery is mandatory (bound on stale rows); the
results-side cleanup can be deferred to the next GC sweep.

**Summary**

- Unified storage + transaction-wrapped merge: same guarantee as
  today, for free.
- Split storage + outbox: same API-observable guarantee, with
  best-effort cleanup of orphan rows behind the scenes.
- Split storage without outbox or read-time filter: rows can leak
  past cancel into API responses. Avoid unless eventual-consistency
  is part of the explicit contract.

The choice is operational: how big the result data is, what storage
class it needs, and whether you can afford the GC machinery.

## Driving the real UI against this backend

To verify the existing UI talks to this backend:

1. Start the perfetto dev server with BigTrace:
   `cd ~/Projects/perfetto && ui/node ui/build.js --serve --watch --bigtrace`.
2. Open `http://127.0.0.1:10000/bigtrace.html`.
3. Open DevTools and run:
   ```js
   localStorage.setItem('bigtraceSettings',
     JSON.stringify({bigtraceEndpoint: 'http://127.0.0.1:8002'}));
   location.reload();
   ```
4. Run a query like `SELECT name, dur FROM slice LIMIT 50` from the
   query page.

## Files

Production code:

- `server.py` — FastAPI app, request handlers (including `/traces`,
  `/traces_schema`, the submit-time snapshot fields, and
  `:fetch_results?columns=`/`filter=`), lifecycle (DB init, TTL
  sweep task, optional DuckDB UI bring-up).
- `db.py` — DuckDB-backed persistence: schema (incl. snapshot
  columns + per-query metadata sidecar tables), all DDL/DML
  helpers, Arrow-based bulk inserts, soft-delete, TTL sweep query,
  recovery on startup, the `parse_filter` / `compile_where` pair
  shared by `:fetch_results` and `/traces`.
- `query_executor.py` — `RunContext` + threaded executor that runs
  SQL across N traces in parallel and merges rows under the run
  lock. Stitches `trace_metadata_columns` inline on the sync path.
- `trace_pool.py` — LRU pool of `TraceProcessor` instances, one per
  trace path. Thread-safe sync API.
- `settings.py` — static settings schema (`trace_directory`,
  `trace_limit`, etc.) and the `trace_directory` extractor. The
  legacy `trace_filter` regex setting was removed when the
  top-level `trace_filter: Filter[]` body field on `/execute_*`
  replaced it.

Tests:

- `db_unittest.py` — `parse_filter` / `compile_where` golden tests
  (every op variant + error path).
- `db_state_unittest.py` — DB state machine coverage (terminal
  transitions, recovery, TTL sweep).
- `query_executor_unittest.py` — executor under contention, cancel
  races, merge semantics.
- `server_unittest.py` — request-handler contract tests
  (snapshot persistence, error mapping, etc.).
- `settings_unittest.py` — settings schema + `trace_directory`
  extractor.
- `trace_pool_unittest.py` — LRU eviction + thread-safety.

Smokes:

- `smoke_local.py` — end-to-end HTTP smoke (no UI; spawns its own
  server on `:18002`).
- `smoke_ui.js` — Playwright smoke that drives the real BigTrace UI
  against a spawned backend on `:18003`.
- `smoke_focused.js` — Playwright probe for two specific
  fixes (async status pill + `~` expansion in `trace_directory`).

Setup & docs:

- `setup_venv.sh` — one-shot venv bootstrap.
- `requirements.txt` — pip deps (perfetto installed editable
  separately).
- `CUJS.md` — user-CUJ catalog mapping each journey to its smoke
  step (`HTTP-N` / `UI-N` / `TODO` / `manual`).
