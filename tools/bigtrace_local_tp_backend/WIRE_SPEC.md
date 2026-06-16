# BigTrace Backend Wire Specification

**Authoritative wire contract** a BigTrace backend MUST implement to be a drop-in replacement for the local-TP reference backend (this directory) for the BigTrace UI in [`perfetto/ui/src/bigtrace`](../../../perfetto/ui/src/bigtrace).

**Branch baseline:** `bt_ui_ref_backend_exp_bigtrace_settings_on_query_page` — 4 commits ahead of `bt_ui_ref_backend`.

**Audience:** An AI assistant or human re-implementing this backend in another language / stack (Java, Go, Rust, …). The spec is **self-contained** — no need to read source code to produce a compliant backend. If a behavior is not described here, it is unspecified.

**Conformance keywords** follow [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119): **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, **MAY**. Lowercase variants are advisory.

---

## Table of contents

0.  [How to read this spec](#0-how-to-read-this-spec)
1.  [What this branch added vs the parent](#1-what-this-branch-added-vs-the-parent)
2.  [Wire conventions](#2-wire-conventions)
3.  [Always-strings response contract](#3-always-strings-response-contract)
4.  [HTTP error model](#4-http-error-model)
5.  [Query execution state machine](#5-query-execution-state-machine)
6.  [Submit-time invariants](#6-submit-time-invariants)
7.  [Cancellation invariants](#7-cancellation-invariants)
8.  [TTL, soft-delete, recovery](#8-ttl-soft-delete-recovery)
9.  [Endpoint reference](#9-endpoint-reference)
    - [9.1 POST /execute_bigtrace_query_async](#91-post-execute_bigtrace_query_async)
    - [9.2 POST /execute_bigtrace_query](#92-post-execute_bigtrace_query)
    - [9.3 GET /query_executions/{uuid}:status](#93-get-query_executionsuuidstatus)
    - [9.4 POST /query_executions/{uuid}:cancel](#94-post-query_executionsuuidcancel)
    - [9.5 POST /query_executions/{uuid}:fetch_results](#95-post-query_executionsuuidfetch_results)
    - [9.6 GET /query_executions/{uuid}](#96-get-query_executionsuuid)
    - [9.7 GET /query_executions](#97-get-query_executions)
    - [9.8 DELETE /query_executions/{uuid}](#98-delete-query_executionsuuid)
    - [9.9 POST /trace_metadata](#99-post-traces)
    - [9.10 POST /trace_metadata_schema](#910-post-traces_schema)
    - [9.11 POST /bigtrace_execution_config](#911-post-bigtrace_execution_config)
    - [9.12 POST /trace_metadata_settings](#912-post-trace_metadata_settings)
    - [9.13 POST /query_templates](#913-post-query_templates)
10. [Top-level trace-selection fields](#10-top-level-trace-selection-fields)
    - [10.1 trace_filters](#101-trace_filters)
    - [10.2 trace_metadata_columns](#102-trace_metadata_columns)
    - [10.3 trace_order_by](#103-trace_order_by)
    - [10.4 Composition pipeline](#104-composition-pipeline)
11. [Per-query metadata sidecar](#11-per-query-metadata-sidecar)
12. [Filter[] grammar](#12-filter-grammar)
13. [order_by grammar (AIP-132 §Ordering subset)](#13-order_by-grammar-aip-132-§ordering-subset)
14. [columns field-mask](#14-columns-field-mask)
15. [Per-query snapshot](#15-per-query-snapshot)
16. [Settings catalog](#16-settings-catalog)
17. [Conformance test surfaces](#17-conformance-test-surfaces)
18. [Implementation hints](#18-implementation-hints-non-normative)
19. [Glossary](#19-glossary)

---

## 0. How to read this spec

- Sections marked **non-normative** are advisory — implementers MAY ignore them.
- Each endpoint section follows the same structure: purpose · request · response · errors · invariants · examples.
- Field tables use this column order: name · type · required · default · notes.
- JSON examples use `<placeholder>` for variables and `…` for elided content.
- Wire field names use `snake_case` for REQUEST bodies and `camelCase` for RESPONSE bodies. This asymmetry is intentional and load-bearing — see [§2.1](#21-snake_case-request-camelcase-response).
- Trailing JSON commas are NOT allowed; the UI uses standard `JSON.parse` / `JSON.stringify`.
- The reference Python implementation lives in this directory; its [README.md](./README.md) explains how this contract is implemented in DuckDB + FastAPI. This file is the contract; the README is one realization of it.

---

## 1. What this branch added vs the parent

The wire-level features below are NEW in `bt_ui_ref_backend_exp_bigtrace_settings_on_query_page`. Everything else in the spec pre-exists in `bt_ui_ref_backend` and is described here for completeness.

| # | Feature | Required? | Section |
|---|---|---|---|
| 1 | `POST /trace_metadata` endpoint | MUST | [§9.9](#99-post-traces) |
| 2 | `POST /trace_metadata_schema` endpoint | MUST | [§9.10](#910-post-traces_schema) |
| 3 | Top-level `trace_filters` on `/execute_*` | MUST | [§10.1](#101-trace_filters) |
| 4 | Top-level `trace_metadata_columns` on `/execute_*` | MUST | [§10.2](#102-trace_metadata_columns) |
| 5 | Top-level `trace_order_by` on `/execute_*` | MUST | [§10.3](#103-trace_order_by) |
| 6 | Per-query metadata sidecar (or equivalent) | MUST | [§11](#11-per-query-metadata-sidecar) |
| 7 | `:fetch_results` `columns` body field-mask | MUST | [§14](#14-columns-field-mask) |
| 8 | `availableColumnNames` in `:fetch_results` response | MUST | [§9.5](#95-get-query_executionsuuidfetch_results) |
| 9 | `:fetch_results` `filters` native JSON `Filter[]` body field | MUST | [§12](#12-filter-grammar) |
| 10 | Per-query snapshot on full GET (4 fields) | MUST | [§15](#15-per-query-snapshot) |
| 11 | Strict-4-field `:status` (no UUID echo, no snapshot) | MUST | [§9.3](#93-get-query_executionsuuidstatus) |
| 12 | Snapshot omitted from list endpoint | MUST | [§9.7](#97-get-query_executions) |
| 13 | `is null` / `is not null` ops in `Filter[]` | MUST | [§12.2](#122-op-categories) |
| 14 | `glob` / `not glob` ops in `Filter[]` | MUST | [§12.2](#122-op-categories) |
| 15 | `in` / `not in` ops in `Filter[]` (multi-value) | MUST | [§12.2](#122-op-categories) |
| 16 | `POST /query_templates` endpoint (analysis templates) | optional | [§9.13](#913-post-query_templates) |

---

## 2. Wire conventions

### 2.1 snake_case request, camelCase response

Field names in REQUEST bodies are `snake_case`:
```json
{"perfetto_sql": "...", "trace_filters": [...], "trace_metadata_columns": [...], "trace_order_by": "..."}
```

Field names in RESPONSE bodies are `camelCase`:
```json
{"queryUuid": "...", "traceFilters": [...], "traceMetadataColumns": [...], "traceOrderBy": "..."}
```

This is load-bearing: the UI's TypeScript types use camelCase; the wire decoder doesn't transform names. A backend that returns `trace_filters` instead of `traceFilters` will silently fail in the UI (the field reads as `undefined`).

Some fields use the same name in both directions (`perfettoSql` → wait, actually `perfetto_sql` request → `perfettoSql` response — yes, asymmetric). Check the per-endpoint examples.

### 2.2 HTTP

| Aspect | Requirement |
|---|---|
| Methods | `GET`, `POST`, `DELETE`. No `PUT`, no `PATCH`. |
| Content-Type | Request bodies MUST be `application/json` when non-empty. Responses MUST be `application/json` (or `application/json; charset=utf-8`). |
| Encoding | UTF-8. |
| Compression | Backends MAY support gzip / brotli on responses; the UI honors `Content-Encoding`. |
| Auth | Out of scope. The reference backend is unauthenticated localhost-only. Real BigTrace deployments handle this at the LB layer. |
| Trailers | None used. |
| Keep-alive | Standard HTTP/1.1 keep-alive. |

### 2.3 CORS

The UI ships requests with `credentials: 'include'` and `mode: 'cors'`. Backends MUST respond with:
- `Access-Control-Allow-Origin: <origin>` (echoing the request `Origin`, OR `*` for unauthenticated dev backends — but `*` is incompatible with `credentials: include`, so echo the origin in production).
- `Access-Control-Allow-Credentials: true`
- `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type` (at minimum)

Preflight (`OPTIONS`) requests MUST be answered with `204 No Content` plus the headers above.

### 2.4 UUIDs

Query UUIDs MUST be RFC 4122 strings in canonical 8-4-4-4-12 form (e.g. `7720667b-1646-4527-a055-f5feace8881e`). Backends MUST treat them as opaque — never parse the contents.

### 2.5 Timestamps

All wire-level timestamps MUST be ISO-8601 strings in **UTC** with **millisecond precision**:

```
YYYY-MM-DDTHH:MM:SS.mmmZ
```

Example: `2026-05-23T16:03:47.319Z`.

Rationale: sub-second precision matters because most queries complete in well under a second. Whole-second precision (`.000Z`) makes the UI show a flat 0s duration. Microsecond precision is overkill and adds digits without UI value.

Backends MUST guarantee `start_time <= end_time`. Backends SHOULD use a monotonic clock for the duration computation but emit wall-clock UTC for both timestamps so the UI's "started at" string is meaningful.

### 2.6 Null vs absent vs empty

Throughout the wire:

| Wire form | Semantic |
|---|---|
| Field absent from JSON object | Same as `null` in nearly every case (see exceptions in per-field sections) |
| Field present, value `null` | Same as absent |
| Field present, value `[]` (for list-typed fields) | Same as absent / null |
| Field present, value `""` (for string-typed fields) | Same as absent / null |

Backends MUST treat these as equivalent on the read side, and SHOULD normalize to a canonical form (typically `[]` for lists, `""` for strings) when emitting responses. They MUST NOT return `null` for any of the snapshot fields ([§15](#15-per-query-snapshot)) — UIs would have to null-check every render path.

### 2.7 SQL identifier safety in `tableName`

`tableName` is opaque on the wire. The reference backend uses `bigtrace_<uuid_with_underscores>`, where hyphens in the UUID are replaced with underscores so the identifier is unquoted-SQL-safe. The wire contract does NOT mandate this transform; clients treat `tableName` as a string they can paste into a SQL editor.

`tableLink` (optional) is a URL the UI MAY render as "open in inspector." It's typically a Datasette / DuckDB-UI link to the table, but its exact shape is implementation-defined.

---

## 3. Always-strings response contract

**Every cell in any `rows[].values` array is either a JSON `string` or `null`.** Backends MUST serialize:

| SQL type | Wire form | Example |
|---|---|---|
| `BIGINT` / `INT64` | string (full precision past 2^53) | `"1700000000000000000"` |
| `INTEGER` / `INT32` | string | `"42"` |
| `DOUBLE` / `FLOAT` | string | `"3.14"` |
| `BOOLEAN` | lowercase string | `"true"` / `"false"` |
| `TIMESTAMP` | ISO-8601 string | `"2026-05-23T16:03:47.319Z"` |
| `VARCHAR` / `TEXT` | string | `"hello"` |
| `BLOB` | unspecified (UI doesn't surface — backends SHOULD emit a placeholder like `"<blob 17 bytes>"`) | |
| SQL `NULL` | JSON `null` | `null` |

### 3.1 Why always-strings

Two reasons:
1. **int64 precision.** Values past `Number.MAX_SAFE_INTEGER` (`2^53`) silently lose precision when parsed as JS `Number`. Stringifying preserves any magnitude. Trace IDs, timestamps in nanoseconds, slice durations all hit this.
2. **Filter round-trip.** The filter wire ([§12](#12-filter-grammar)) also uses always-strings. If the UI rendered a cell as a typed JS value and shipped it back through the filter, the round-trip would have to convert and could lose precision. Strings round-trip losslessly.

### 3.2 What the UI does NOT do

The UI does NOT:
- Coerce strings back to typed JS values at any layer.
- Inspect column types (the wire doesn't carry per-cell types).
- Distinguish between `BIGINT 0` and `VARCHAR "0"` on the wire — both become `"0"`.

If a backend wants the UI to render a value as a number, it MUST emit it as a JSON number — but NO endpoint in this spec returns JSON numbers in `rows[].values`. The only place numbers appear is in metadata fields like `processedRows`, `totalFilteredRows`, `limit`, `traceLimit`, where row counts never approach 2^53.

### 3.3 Booleans

Backends MUST emit booleans as the lowercase strings `"true"` / `"false"`. Title-case (`"True"` / `"False"`) breaks the filter round-trip because the UI ships the rendered cell value back through the filter wire — `"True"` against a `BOOLEAN` column would never match.

---

## 4. HTTP error model

Non-2xx responses MUST carry a JSON body of shape:

```json
{"detail": "<human-readable explanation>"}
```

Status codes follow gRPC/AIP semantics:

| Status | gRPC name | When |
|---|---|---|
| `400` | `INVALID_ARGUMENT` | Malformed request body. Bad JSON. Unknown column in filter / order_by / columns. Malformed Filter[]. Bad order_by grammar. Bad coercion of filter value to column type. Trace directory does not exist. |
| `400` | `FAILED_PRECONDITION` | `:fetch_results` on a query that exists but is not fetchable: sync (`materialized=false`); FAILED; CANCELLED with `processed_rows=0`; TTL-expired (`tableName=null`). |
| `404` | `NOT_FOUND` | Unknown UUID. Soft-deleted query. Materialized table dropped out-of-band. |
| `409` | `CONFLICT` | `DELETE` on IN_PROGRESS query — cancel first. |
| `200` | `OK` | Success, including idempotent no-ops (`:cancel` on terminal). |

The `detail` MUST disambiguate cases that share a status code. Example:

```json
// 400 INVALID_ARGUMENT
{"detail": "trace_order_by: unknown column 'no_such_col'"}

// 400 FAILED_PRECONDITION
{"detail": "query exists but isn't fetchable: materialized=false (sync query)"}

// 404 NOT_FOUND on :fetch_results
{"detail": "query 7720667b-... not found (unknown / soft-deleted / TTL-expired)"}
```

Clients branch on the status code first, then surface `detail` for display.

---

## 5. Query execution state machine

Every query passes through these states:

```
       submit
         │
         ▼
   IN_PROGRESS ────────────────────────────────────┐
         │                                         │
         │           ┌─────────────────────────────┘
         │           │
         │           ▼      :cancel
         │       CANCELLED ─────► rows > 0  →  tableName preserved   →  :fetch_results OK
         │                  ─────► rows == 0 →  tableName cleared    →  :fetch_results 400 FAILED_PRECONDITION
         │
         ├──────────► SUCCESS    →  tableName preserved (if materialized)
         │                       →  :fetch_results OK
         │
         └──────────► FAILED     →  tableName cleared
                                 →  errorMessage set
                                 →  :fetch_results 400 FAILED_PRECONDITION
```

### 5.1 Transition contract

Backends MUST:

1. Treat all terminal transitions (`mark_success`, `mark_failed`, `mark_cancelled`) as **conditional** on the row still being IN_PROGRESS. Implement as `UPDATE … WHERE status = 'IN_PROGRESS'`. This prevents races where a worker tries to mark SUCCESS after a cancel has already landed.
2. NOT overwrite a terminal status with another terminal status. Once SUCCESS / FAILED / CANCELLED is set, the row is frozen.
3. NOT modify the submit-time snapshot ([§15](#15-per-query-snapshot)) on any state transition.
4. NOT modify `start_time` after the initial insert.
5. Set `end_time` when transitioning to any terminal state.
6. Set `error_message` when transitioning to FAILED.
7. For CANCELLED: set `end_time`, clear `tableName` IFF `processed_rows == 0`, leave `processed_rows` as-is otherwise.

### 5.2 Sync queries

Sync queries also pass through this state machine:
- Inserted as IN_PROGRESS up front.
- Transitioned to SUCCESS / FAILED at the end of the synchronous handler.
- Never reach CANCELLED (the client can't cancel a sync query mid-call).
- Always `materialized=false` and `tableName=null`.

### 5.3 Server restart recovery

On startup, the backend MUST scan for rows still in IN_PROGRESS (left over from a crash) and mark them FAILED. The error message SHOULD indicate "recovered after restart" so debugging is straightforward. Half-materialized result tables associated with those rows MUST be dropped.

---

## 6. Submit-time invariants

For both `/execute_bigtrace_query_async` and `/execute_bigtrace_query`:

**Order of operations:**

1. **Read body.** Backend MAY fail with 400 on malformed JSON before doing anything else.
2. **Insert IN_PROGRESS row** with the submit-time snapshot ([§15](#15-per-query-snapshot)) populated from the raw request body — BEFORE any field-level validation. Rationale: even queries that fail validation must produce a history row recording what was attempted.
3. **Validate** trace_directory presence, trace_filters shape, trace_metadata_columns names, trace_order_by grammar (lexical), `perfetto_sql` non-empty if required.
4. **On validation failure:** `mark_failed` the just-inserted row with the validation message as `error_message`, return 400 with that same message in `detail`.
5. **On validation success (async):** spawn the background task, return 200 with `{queryUuid}`.
6. **On validation success (sync):** execute the query inline, transition to SUCCESS / FAILED based on the outcome, return 200 with the inline result.

Backends MAY also delay column-level validation (e.g., trace_filters referencing unknown trace-grid columns) until execute-time inside the background task. In that case the failure surfaces as a FAILED status with `error_message` set, NOT as a submit-time 400. Both behaviors are conformant.

### 6.1 Submit-time validation lexicality

Backends SHOULD perform CHEAP validation up front (parseability, shape, presence) so the user gets a 400 at submit rather than having to poll a FAILED status. EXPENSIVE validation (full directory walk, column-name lookup against an indexer, etc.) MAY be deferred to the background task.

Reference behavior:
- `trace_directory` presence + existence: SUBMIT-time (cheap).
- `trace_filters` JSON shape + Filter[] parse: SUBMIT-time (cheap).
- `trace_metadata_columns` names against `/trace_metadata_schema`: SUBMIT-time (catalog already in memory).
- `trace_order_by` grammar: SUBMIT-time (lexical parse).
- `trace_order_by` column-name validation: EXECUTE-time (needs the column-types map).
- `trace_filters[i].field` column-name validation: EXECUTE-time.

---

## 7. Cancellation invariants

`:cancel` is the single most subtle contract in this spec.

### 7.1 Atomicity guarantee

After `:cancel` returns HTTP 200 to the client:

- **No row MUST land** in the materialized result table.
- The query MUST observably be in CANCELLED state from any subsequent endpoint hit (`:status`, full GET).
- A concurrent `mark_success` from a worker that just finished MUST be a no-op (status already CANCELLED — conditional UPDATE bails).
- A concurrent `mark_failed` from a worker that just errored MUST be a no-op (same reason).

### 7.2 Lock contract

The cancel handler and the row-merge path MUST share a critical section. The simplest implementation:

```
CANCEL_HANDLER:
  acquire lock
    status = SELECT status FROM query_executions WHERE uuid = ?
    if status == 'IN_PROGRESS':
      UPDATE query_executions SET status='CANCELLED', end_time=now() WHERE uuid=?
      if processed_rows == 0: UPDATE query_executions SET table_name=NULL WHERE uuid=?
  release lock
  return 200

WORKER_MERGE:
  acquire lock
    status = SELECT status FROM query_executions WHERE uuid = ?
    if status != 'IN_PROGRESS':
      release lock; return (drop rows on the floor)
    INSERT rows INTO bigtrace_<uuid>
    UPDATE query_executions SET processed_rows = processed_rows + N
  release lock
```

Workers ALREADY INSIDE their underlying engine query (e.g. `tp.query(...)`) when cancel lands cannot be interrupted. Their results are dropped at the merge step — the lock + status-check before INSERT guarantees no row reaches the table.

### 7.3 Pre-200 races

Rows merged BEFORE the cancel handler acquired the lock are kept — they're the query's partial result. The contract is "as of when the server committed your cancel," not "as of when you clicked." The UI surfaces a partial result count to make this transparent to the user.

### 7.4 Multi-instance deployments

In a load-balanced deployment, `:cancel` arriving at instance B MUST stop work on instance A. The only authoritative cancellation signal is the persistent state (DB row). Backends MUST NOT use in-process flags for cancellation — they don't cross instances.

### 7.5 Cancel idempotency

`:cancel` on a terminal row (SUCCESS / FAILED / already CANCELLED) MUST return HTTP 200 with no body and no state change. NOT 400, NOT 409.

---

## 8. TTL, soft-delete, recovery

### 8.1 TTL

Materialized result tables MUST be dropped after a configurable TTL since the row reached a terminal state. The reference uses 1 day, with a 5-minute sweep cadence; backends SHOULD make this configurable.

After TTL expiry:

- The metadata row (history entry) STAYS — the user can still see the query in their history.
- `tableName` on the row MUST be set to NULL.
- `:fetch_results` on the UUID MUST return 400 FAILED_PRECONDITION.
- Other endpoints (`:status`, full GET) MUST still respond with the preserved metadata.

### 8.2 Soft-delete

`DELETE /query_executions/{uuid}` MUST flip a `deleted` flag (or equivalent) on the row.

After soft-delete:

- The materialized result table SHOULD be dropped (free disk).
- All per-uuid endpoints (`:status`, `:fetch_results`, full GET, `:cancel`) MUST return 404. The row is treated as "gone" for handler purposes.
- `GET /query_executions` (list) MUST filter out deleted rows.
- A second `DELETE` on the same UUID MUST return 404 (already gone).
- `DELETE` on a row that is currently `IN_PROGRESS` MUST return 409. The client cancels first.

### 8.3 Recovery on restart

On boot, the backend MUST:

1. Scan `query_executions` for rows with `status='IN_PROGRESS'`.
2. For each: transition to FAILED with an error message like "recovered after restart (server crashed mid-query)".
3. Drop the associated materialized result table if it exists.
4. Drop the associated metadata sidecar table if it exists.

This prevents zombie IN_PROGRESS rows from accumulating across crashes.

### 8.4 Snapshot survival

The submit-time snapshot ([§15](#15-per-query-snapshot)) MUST survive all four destructive events:
- Terminal state transitions (mark_success / mark_failed / mark_cancelled)
- TTL expiry (table dropped, snapshot row preserved)
- Recovery on restart (transitioned to FAILED with snapshot intact)

Only soft-delete makes the snapshot inaccessible (404 on the GET).

---

## 9. Endpoint reference

Each endpoint section follows the same structure: purpose · request · response · errors · invariants · examples.

### 9.1 POST /execute_bigtrace_query_async

**Purpose:** Submit a query for background execution. Returns immediately with a query UUID; the actual work runs in background. The client polls `:status` until terminal, then fetches results via `:fetch_results`.

**Request body (JSON):**

| Field | Type | Required? | Default | Notes |
|---|---|---|---|---|
| `perfetto_sql` | string | MUST | `""` | The user SQL to execute. Empty string is a no-op (returns success with 0 rows). |
| `limit` | number | MUST | `100` | **Global row cap** on the materialized result (NOT a trace count). With `limit=1000` over 14 traces, the result has ≤1000 rows total. |
| `settings` | array of `{setting_id, values, category}` | MUST | `[]` | Per-backend configuration. The catalog comes from [`/bigtrace_execution_config`](#911-post-bigtrace_execution_config). Required entries depend on the backend; the reference requires `trace_directory`. |
| `trace_filters` | `Filter[]` (native JSON array) | MAY | `[]` | **Strict-native-only.** See [§10.1](#101-trace_filters) and [§12](#12-filter-grammar). JSON-encoded strings MUST be rejected with `400`. |
| `trace_metadata_columns` | `string[]` | MAY | `[]` | See [§10.2](#102-trace_metadata_columns). |
| `trace_order_by` | string | MAY | `""` | See [§10.3](#103-trace_order_by) and [§13](#13-order_by-grammar-aip-132-§ordering-subset). |

**Response (200):**

```json
{"queryUuid": "<uuid>"}
```

**Errors:**

| Status | When | Detail example |
|---|---|---|
| `400 INVALID_ARGUMENT` | Bad JSON, missing trace_directory, malformed trace_filters, unknown trace_metadata_columns name, bad trace_order_by grammar | `"Trace Directory '/missing' does not exist"` |

**Invariants:**

- MUST insert an IN_PROGRESS row with the snapshot BEFORE validating (see [§6](#6-submit-time-invariants)).
- On validation failure: MUST `mark_failed` the just-inserted row, then return 400.
- MUST set `tableName` on the inserted row immediately. The materialized table itself MAY be lazily created on first row merge.
- MUST spawn the background task AFTER validation succeeds.
- MUST NOT block on the actual query — return as soon as the row is inserted and validation passes.
- For `materialized=true` rows (default for async): the result table will be created during the run; `tableName` is set from the start.

**Example request:**

```http
POST /execute_bigtrace_query_async HTTP/1.1
Content-Type: application/json

{
  "perfetto_sql": "SELECT name, dur FROM slice WHERE name IS NOT NULL LIMIT 50",
  "limit": 100,
  "settings": [
    {"setting_id": "trace_directory", "values": ["/home/user/trace_metadata"], "category": "TRACE_ADDRESS"},
    {"setting_id": "trace_limit", "values": ["20"], "category": "TRACE_ADDRESS"}
  ],
  "trace_filters": [{"field": "file_name", "op": "glob", "value": "*.pftrace"}],
  "trace_metadata_columns": ["file_name", "size_bytes"],
  "trace_order_by": "size_bytes desc"
}
```

**Example response:**

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"queryUuid": "7720667b-1646-4527-a055-f5feace8881e"}
```

**Example failure:**

```http
POST /execute_bigtrace_query_async HTTP/1.1
Content-Type: application/json

{"perfetto_sql": "SELECT 1", "limit": 10, "settings": [], "trace_order_by": "file_name sideways"}
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{"detail": "trace_order_by: invalid direction 'sideways' (expected 'asc' or 'desc')"}
```

The history row IS inserted with this attempt recorded; querying `/query_executions/{returned-uuid}` would show status=FAILED and the same `detail` as `errorMessage`.

### 9.2 POST /execute_bigtrace_query

**Purpose:** Synchronous variant. Runs the query inline and returns the assembled tabular result. Useful for short, ad-hoc queries where the user wants the result inline.

**Request body:** Same shape as [§9.1](#91-post-execute_bigtrace_query_async).

**Response (200):**

```json
{
  "queryUuid": "<uuid>",
  "columnNames": ["<col>", ...],
  "rows": [{"values": ["<str>" | null, ...]}, ...]
}
```

**Errors:** Same as async path, except validation failures don't have to be conditional on an inserted row (sync queries fail-fast cleanly).

**Invariants:**

- MUST observe lifecycle parity with the async path: insert IN_PROGRESS up front, transition to SUCCESS / FAILED via the conditional `mark_*` calls.
- MUST set `materialized=false` and `tableName=null` on the history row. `:fetch_results` on a sync UUID will return 400 FAILED_PRECONDITION.
- MUST stitch any `trace_metadata_columns` values inline into each result row (between `trace_id` and the SQL columns). There's no sidecar JOIN at fetch time because there's no fetch.
- MUST still record the submit-time snapshot ([§15](#15-per-query-snapshot)).

**Example response (success):**

```json
{
  "queryUuid": "a02df465-2b83-48a0-b555-32cdbb135ab6",
  "columnNames": ["trace_id", "file_name", "name", "dur"],
  "rows": [
    {"values": ["android_boot", "android_boot.pftrace", "binder_transaction", "1234567"]},
    {"values": ["android_boot", "android_boot.pftrace", "binder_transaction_received", "8901234"]}
  ]
}
```

Note `file_name` is the inline-stitched metadata column (from `trace_metadata_columns`), appearing between `trace_id` and the SQL columns (`name`, `dur`).

### 9.3 GET /query_executions/{uuid}:status

**Purpose:** Lean polling endpoint. The UI hits this every 3s while the query is IN_PROGRESS.

**Request body:** None.

**Response (200):**

```json
{
  "status": "IN_PROGRESS" | "SUCCESS" | "FAILED" | "CANCELLED",
  "processedRows": <number>,
  "processedTraces": <number>,
  "totalTraces": <number>
}
```

**STRICT 4 fields.** Backends MUST NOT include:

- `queryUuid` (the UUID is in the URL — echoing it in the body is redundant and wastes bytes)
- `endTime`, `startTime`, `errorMessage`, `tableName`, `tableLink`, `materialized`, `perfettoSql`, `limit` (those live on the full GET only)
- ANY snapshot field (`settings`, `traceFilters`, `traceMetadataColumns`, `traceOrderBy`)

The UI polls this URL every 3 seconds for the duration of an IN_PROGRESS query. Keeping it lean is a real performance win — the snapshot fields can be hundreds of bytes each.

**Errors:**

| Status | When |
|---|---|
| `404 NOT_FOUND` | Unknown UUID OR soft-deleted |

**Example:**

```http
GET /query_executions/7720667b-1646-4527-a055-f5feace8881e:status HTTP/1.1
```

```json
{
  "status": "IN_PROGRESS",
  "processedRows": 42,
  "processedTraces": 3,
  "totalTraces": 14
}
```

### 9.4 POST /query_executions/{uuid}:cancel

**Purpose:** Atomically transition IN_PROGRESS → CANCELLED.

**Request body:** `{}` (no fields).

**Response (200):** No body.

**Invariants:**

- MUST be atomic — see [§7](#7-cancellation-invariants) for the full lock contract.
- MUST be idempotent on terminal rows (return 200, no state change).
- For CANCELLED with `rows > 0`: KEEP `tableName` set; `:fetch_results` is allowed and returns the partial result.
- For CANCELLED with `rows == 0`: CLEAR `tableName`; `:fetch_results` returns 400 FAILED_PRECONDITION.

**Errors:**

| Status | When |
|---|---|
| `404 NOT_FOUND` | Unknown UUID OR soft-deleted |

(No 409 or 400 for "already terminal" — that case is a silent 200.)

### 9.5 POST /query_executions/{uuid}:fetch_results

**Purpose:** Paginated read of the materialized result table. The UI hits this once per terminal-state transition, then again on every page / sort / filter / column-projection change.

**Request body (JSON):**

| Field | Type | Required? | Default | Notes |
|---|---|---|---|---|
| `limit` | number | MUST | `50` | Page size |
| `offset` | number | MUST | `0` | Page offset |
| `order_by` | string | MAY | `""` | AIP-132 grammar, see [§13](#13-order_by-grammar-aip-132-§ordering-subset) |
| `filters` | `Filter[]` (native JSON array) | MAY | `[]` | **Strict-native-only.** See [§12](#12-filter-grammar). JSON-encoded strings MUST be rejected with `400`. |
| `columns` | `string[]` | MAY | (all result-table columns) | Native JSON array of column names; see [§14](#14-columns-field-mask). |

**Why POST + body (not GET + query string):** so `filters` can ride as a native JSON array — same wire shape as `/execute_*` `trace_filters` and `/trace_metadata` `filters`. All three filter sites share one parser, one composer, one contract. Migrated 2026-06-03 (along with the body-native flip on the other two endpoints).

**Response (200):**

```json
{
  "columnNames": ["<col>", ...],
  "rows": [{"values": ["<str>" | null, ...]}, ...],
  "totalFilteredRows": <number>,
  "availableColumnNames": ["<col>", ...]
}
```

| Response field | Type | Notes |
|---|---|---|
| `columnNames` | string[] | The columns in this page's projection, in order. |
| `rows` | `{values: (string | null)[]}[]` | Always-strings cells; one entry per row in the page. |
| `totalFilteredRows` | number | ALWAYS PRESENT. Total rows AFTER `filters` is applied (no `filters` → equals the materialized total). Used by the UI to size the virtual scrollbar. |
| `availableColumnNames` | string[] | FULL union of (result-table cols ∪ sidecar cols) — independent of the current `columns` argument. Used by the UI's column picker on the results page. |

**Field-mask semantics:**

- Omitted `columns` → returns ALL result-table columns, NO sidecar columns. (No implicit metadata attachment at read time.)
- `columns=<a>,<b>,<c>` → returns exactly those columns, in that order. May reference result-table columns AND/OR sidecar columns.
- `filters` / `order_by` MAY reference columns NOT in the `columns` projection — the underlying scan sees the full schema; only the response is narrowed.
- Backends MUST validate every name in `columns`, `filter[i].field`, and `order_by` field-names against the union of available columns, and return 400 INVALID_ARGUMENT (with the offending name in `detail`) on unknown columns.

**Errors:**

| Status | gRPC | When | Detail example |
|---|---|---|---|
| `404` | `NOT_FOUND` | UUID unknown / soft-deleted / materialized table dropped out-of-band | `"query <uuid> not found"` |
| `400` | `FAILED_PRECONDITION` | Sync row (`materialized=false`); FAILED row; CANCELLED with `processed_rows=0`; TTL-expired (`tableName=null`) | `"query exists but isn't fetchable: materialized=false (sync query)"` |
| `400` | `INVALID_ARGUMENT` | Malformed `filters` JSON; bad `order_by` grammar; unknown column on any axis; bind-time coercion failure | `"filter[0].field: unknown column 'no_such_col'"` |

**Pagination:**

- `limit` MUST be a positive integer. `0` or negative MUST yield 400 INVALID_ARGUMENT.
- `offset` MUST be a non-negative integer.
- Pages past the end return zero rows and `totalFilteredRows` reflecting the full count.

**Example request:**

```http
POST /query_executions/7720667b-...:fetch_results HTTP/1.1
Content-Type: application/json

{
  "limit": 10,
  "offset": 0,
  "order_by": "dur desc",
  "columns": ["trace_id", "name", "dur", "file_name"]
}
```

**Example response:**

```json
{
  "columnNames": ["trace_id", "name", "dur", "file_name"],
  "rows": [
    {"values": ["android_boot", "binder_transaction", "9876543", "android_boot.pftrace"]},
    {"values": ["android_boot", "ActivityManager", "8765432", "android_boot.pftrace"]}
  ],
  "totalFilteredRows": 247,
  "availableColumnNames": ["trace_id", "name", "dur", "file_name", "size_bytes"]
}
```

The JOIN with the sidecar is emitted because `file_name` is in the projection.

### 9.6 GET /query_executions/{uuid}

**Purpose:** Full execution details. Read once at submit (to capture serverside `startTime`) and again on terminal-state transition (to capture `endTime`, `errorMessage`, full snapshot).

**Request body:** None.

**Response (200):**

```json
{
  "queryUuid": "<uuid>",
  "status": "IN_PROGRESS" | "SUCCESS" | "FAILED" | "CANCELLED",
  "startTime": "<iso-8601>",
  "endTime": "<iso-8601>",
  "processedRows": <number>,
  "processedTraces": <number>,
  "totalTraces": <number>,
  "perfettoSql": "<string>",
  "limit": <number>,
  "materialized": <bool>,
  "tableName": "<string>",
  "tableLink": "<url>",
  "errorMessage": "<string>",
  "settings": [...],
  "traceFilters": [/* Filter[] */],
  "traceMetadataColumns": [...],
  "traceOrderBy": "<string>"
}
```

| Field | Presence |
|---|---|
| `queryUuid`, `status`, `startTime`, `processedRows`, `processedTraces`, `totalTraces`, `perfettoSql`, `limit`, `materialized` | ALWAYS |
| `endTime` | ONLY on terminal rows |
| `tableName` | ONLY when set (see [`tableName` lifecycle](#56-tablename-lifecycle-table)) |
| `tableLink` | ONLY when the backend exposes an inspector URL |
| `errorMessage` | ONLY on FAILED (MAY be present on CANCELLED with a partial-cancel note) |
| `settings`, `traceFilters`, `traceMetadataColumns`, `traceOrderBy` | ALWAYS — snapshot fields. `settings` / `traceMetadataColumns` / `traceFilters` default to `[]`; `traceOrderBy` defaults to `""` (the wire string for "no order"). The full GET echoes the submit-time value verbatim — `traceFilters` is a native `Filter[]` JSON array (strict-native body contract, see [§10.1](#101-trace_filters)). |

**Errors:**

| Status | When |
|---|---|
| `404 NOT_FOUND` | Unknown UUID OR soft-deleted |

### 9.7 GET /query_executions

**Purpose:** History list (sidebar).

**Request body:** None.

**Query parameters:** None. (Some implementations MAY add pagination later; the current contract is "return all visible rows".)

**Response (200):**

```json
{"queryExecutions": [{<RawQueryExecution>}, ...]}
```

Each entry has the same shape as the full GET ([§9.6](#96-get-query_executionsuuid)) with TWO differences:

1. The submit-time snapshot fields (`settings`, `traceFilters`, `traceMetadataColumns`, `traceOrderBy`) MUST be **OMITTED**. The history sidebar response stays lean; clients fetch the per-uuid GET to inspect snapshots.
2. `perfettoSql` and `errorMessage` MAY be truncated to ≤200 characters. The per-uuid GET is always the source of truth for full text. Backends MAY append a marker like `"…"` or simply truncate silently — the UI doesn't distinguish.

Ordering: newest-first by `startTime` is RECOMMENDED but not required.

Soft-deleted rows MUST be filtered out.

**Errors:** None expected. Backends MAY return 500 on internal errors but shouldn't crash on an empty database — emit `{"queryExecutions": []}`.

### 9.8 DELETE /query_executions/{uuid}

**Purpose:** Soft-delete a row from history.

**Request body:** None.

**Response (200):** No body.

**Errors:**

| Status | When |
|---|---|
| `404 NOT_FOUND` | Unknown UUID OR already soft-deleted |
| `409 CONFLICT` | Row is IN_PROGRESS — cancel first |

**Invariants:**

- MUST flip a `deleted` flag (or equivalent) on the row.
- MUST drop the associated materialized result table (free disk).
- MUST drop the associated metadata sidecar table.
- The metadata row (with all snapshot fields) MAY be kept for an audit trail; the UI never sees it again because the list endpoint filters deleted rows.

### 9.9 POST /trace_metadata

**Purpose:** Paginated trace metadata for the active trace source. Powers the BigTrace UI's trace-selection grid on the Settings page.

**Request body:**

| Field | Type | Required? | Default | Notes |
|---|---|---|---|---|
| `settings` | array | MUST | `[]` | Trace source config (e.g. `trace_directory`). Same shape as on `/execute_*`. |
| `filters` | `Filter[]` (native JSON array) | MAY | `[]` | **Strict-native-only.** Same inner grammar as `:fetch_results` `filters` (see [§12](#12-filter-grammar)) but shipped as a native array in the body. JSON-encoded strings MUST be rejected with `400`. |
| `order_by` | string | MAY | `""` | Same grammar as `:fetch_results` `order_by`. See [§13](#13-order_by-grammar-aip-132-§ordering-subset). |
| `limit` | number | MUST | — | Page size. |
| `offset` | number | MUST | `0` | Page offset. |
| `columns` | string[] | MAY | (every `defaultVisible:true` column from `/trace_metadata_schema`) | Field-mask projection. See [§14](#14-columns-field-mask). |

**Response (200):**

```json
{
  "columnNames": ["<col>", ...],
  "rows": [{"values": ["<str>" | null, ...]}, ...],
  "totalFilteredRows": <number>
}
```

Same always-strings wire as `:fetch_results`, but **without** `availableColumnNames`: the column catalog for `/trace_metadata` lives on `/trace_metadata_schema` ([§9.10](#910-post-traces_schema)), so echoing it here would create two sources of truth that could drift. Backends MUST NOT include `availableColumnNames` in this response; clients MUST NOT read it.

**Errors:**

| Status | When |
|---|---|
| `400 INVALID_ARGUMENT` | Bad filter / order_by / unknown column / unknown column in `columns` field-mask |
| `400 INVALID_ARGUMENT` | Trace directory does not exist (or per-backend equivalent) |

**Schema compatibility:**

Backends without a metadata indexer MUST at minimum surface the 4 filesystem columns: `file_path`, `file_name`, `size_bytes`, `mtime`. The UI doesn't hardcode names — every column comes from `/trace_metadata_schema` — but having a usable baseline schema makes the grid functional.

Backends with an indexer add `device_name`, `android_id`, `app_version`, etc. — same wire shape, more columns. The schema returned from `/trace_metadata_schema` MUST be the source of truth.

**Example:**

```http
POST /trace_metadata HTTP/1.1
Content-Type: application/json

{
  "settings": [{"setting_id": "trace_directory", "values": ["/home/user/trace_metadata"], "category": "TRACE_ADDRESS"}],
  "filter": [{"field": "file_name", "op": "glob", "value": "*.pftrace"}],
  "order_by": "size_bytes desc",
  "limit": 10,
  "offset": 0,
  "columns": ["file_name", "size_bytes"]
}
```

```json
{
  "columnNames": ["file_name", "size_bytes"],
  "rows": [
    {"values": ["large.pftrace", "10485760"]},
    {"values": ["medium.pftrace", "1048576"]}
  ],
  "totalFilteredRows": 12
}
```

### 9.10 POST /trace_metadata_schema

**Purpose:** Column catalog for `/trace_metadata`. The UI calls this once on Settings-page load to build the column-picker menu without baking in any names.

**Request body:**

```json
{"settings": [...]}
```

The schema MAY depend on the trace source (different `trace_directory` → different indexed columns), which is why this is a POST that takes settings rather than a parameterless GET.

**Response (200):**

```json
{
  "columns": [
    {
      "name": "<col>",
      "type": "<sqltype>",
      "defaultVisible": <bool>,
      "description": "<str>"
    }
  ]
}
```

| Field | Type | Required? | Notes |
|---|---|---|---|
| `name` | string | MUST | The column identifier used in `Filter[].field`, `order_by` field-names, the `columns` field-mask on `/trace_metadata`, and `trace_metadata_columns` on `/execute_*`. |
| `type` | string | MUST | Informational — the wire is always-strings. Suggested values: `BIGINT`, `INTEGER`, `DOUBLE`, `VARCHAR`, `TIMESTAMP`, `BOOLEAN`. Used by the UI for cell-renderer hints (`size_bytes` typed as `BIGINT` may be rendered as "4.5 MB"). |
| `defaultVisible` | bool | MUST | `true` → column appears in the trace-list grid on first render; `false` → addable via the picker. Renamed from `default` to avoid the JS keyword collision (destructuring `default` requires aliasing in strict mode) and to make the field self-describing. |
| `description` | string | MAY | Tooltip / help text the UI surfaces on the column-picker entry. |

**Errors:** None expected on a happy path. 400 INVALID_ARGUMENT if settings reference an unknown / invalid trace source.

**Example:**

```http
POST /trace_metadata_schema HTTP/1.1
Content-Type: application/json

{"settings": [{"setting_id": "trace_directory", "values": ["/home/user/trace_metadata"], "category": "TRACE_ADDRESS"}]}
```

```json
{
  "columns": [
    {"name": "file_path",  "type": "VARCHAR", "defaultVisible": true, "description": "Absolute path on the backend host."},
    {"name": "file_name",  "type": "VARCHAR", "defaultVisible": true, "description": "Trace basename (with extension)."},
    {"name": "size_bytes", "type": "BIGINT",  "defaultVisible": true, "description": "File size in bytes."},
    {"name": "mtime",      "type": "VARCHAR", "defaultVisible": true, "description": "Last modification time (ISO-8601 UTC)."}
  ]
}
```

### 9.11 POST /bigtrace_execution_config

**Purpose:** Static settings schema. The UI calls this on Settings-page load to auto-generate the settings form. Settings of `category: "TRACE_ADDRESS"` are treated as required and rendered without an enable/disable toggle.

**Request body:** `{}` (no fields).

**Response (200):**

```json
{"setting": [BackendSetting, ...]}
```

Each `BackendSetting` has:

| Field | Type | Required? | Notes |
|---|---|---|---|
| `id` | string | MUST | Setting identifier — used as `setting_id` on the wire when the UI ships it back in `settings`. |
| `name` | string | MUST | Display name. |
| `description` | string | MUST | Tooltip / help text. |
| `disabled` | bool | MUST | Initial enabled state. |
| `category` | string | MUST | `TRACE_ADDRESS` (required for queries), `TRACE_METADATA`, `BIGTRACE_QUERY_OPTIONS`, or `SETTING_CATEGORY_UNSPECIFIED`. |
| One of: `number`, `stringEnum`, `multiSelect`, `plainString`, `stringArray`, `booleanOptions` | object | MUST | The setting's type-specific schema. |

Type-specific schemas:

```json
{"number": {"defaultValue": 100, "min": 1, "max": 10000}}
{"plainString": {"defaultValue": ""}}
{"stringEnum": {"defaultValue": "foo", "options": ["foo", "bar", "baz"]}}
{"multiSelect": {"defaultValues": [], "options": ["x", "y", "z"]}}
{"stringArray": {"defaultValues": []}}
{"booleanOptions": {"defaultValue": false}}
```

**Settings on this branch's reference backend:**

```json
{
  "setting": [
    {
      "id": "trace_directory",
      "name": "Trace Directory",
      "description": "Filesystem path the backend reads .pftrace/.pb files from. Re-resolved on every query.",
      "disabled": false,
      "category": "TRACE_ADDRESS",
      "plainString": {"defaultValue": ""}
    },
    {
      "id": "trace_limit",
      "name": "Trace Limit",
      "description": "Maximum number of traces to process. Applied after the trace grid filter; ignored if 0.",
      "disabled": false,
      "category": "TRACE_ADDRESS",
      "number": {"defaultValue": 100, "min": 1, "max": 10000}
    }
  ]
}
```

Notes:

- `trace_filters`, `trace_metadata_columns`, `trace_order_by` are NOT in the catalog — they're top-level fields on `/execute_*`.
- `trace_limit` IS in the catalog — it's a setting (read from the `settings` array at execute time), not a top-level field. See [§16.1](#161-whats-a-setting-vs-a-top-level-field).
- Other backends (especially those with an indexer) MAY add more settings — the UI auto-generates the form from this response.

### 9.12 POST /trace_metadata_settings

**Purpose:** Filter chips surfaced by a backend with a per-trace metadata index (e.g. "filter by device_name"). The UI calls this on Settings-page load; backends without an indexer return an empty list and the UI collapses the section.

**Request body:**

```json
{"settings": [{"settingId": "<id>", "values": [...], "category": "..."}]}
```

Note: this endpoint's request body uses **`settingId`** (camelCase), NOT `setting_id`. This is a wart of the legacy mock; backends MUST accept it as-is for compatibility.

**Response (200):**

Same shape as [§9.11](#911-post-bigtrace_execution_config).

Backends without a metadata index MUST return `{"setting": []}`. The UI will collapse the "Trace Metadata" section.

### 9.13 POST /query_templates

**Purpose:** Catalog of analysis templates the UI offers as launchable cards on the home page and as a settings preset. Each template is display metadata plus a frozen execution snapshot — effectively a pre-filled `/execute_*` request the UI drops into a query tab. A backend that doesn't implement templates MUST return `{"templates": []}` (or 404 / omit the route); the UI treats absent/empty as "no templates" and hides the section.

**Request body:** `{}`. A backend MAY accept `{"settings": [{"setting_id", "values", "category"}, ...]}` to vary the catalog by trace source (like [§9.10](#910-post-traces_schema)); simple backends ignore the body.

**Response (200):**

```json
{"templates": [Template, ...]}
```

Each `Template`. The **Default** column is what the *client* applies when the field is absent (or `0` for `limit`), so a minimal backend may emit only the MUST fields:

| Field | Type | Required? | Default | Notes |
|---|---|---|---|---|
| `id` | string | MUST | — | Stable key (UI key / analytics); never branched on. |
| `category` | string | MUST | — | Groups templates into CUJ tabs (`""` → "Other"). |
| `name` | string | MUST | — | Card title. |
| `description` | string | MUST | — | One-line card subtitle. |
| `sql` | string | MUST | — | PerfettoSQL seeded into the editor. |
| `icon` | string | no | generic glyph | Material Symbols name; absent/malformed → generic. |
| `settings` | `{setting_id, values, category}[]` | no | `[]` | Option settings to apply. Same inner shape as the `/execute_*` body `settings` (snake_case `setting_id`, always-string `values`). The trace-fan-out cap rides here as the `trace_limit` setting. |
| `traceFilters` | `Filter[]` | no | `[]` | Trace-selection filter ([§12](#12-filter-grammar)). |
| `traceMetadataColumns` | `string[]` | no | `[]` | Metadata columns to attach ([§10.2](#102-trace_metadata_columns)). |
| `traceOrderBy` | string | no | `""` | AIP-132 order ([§13](#13-order_by-grammar-aip-132-§ordering-subset)). |
| `limit` | number | no | `1000` | Result row cap. `0` / absent → the client's template default (1000). |
| `materialize` | bool | no | `true` | Persistent (results to History) vs ephemeral. |

The snapshot fields (`settings`, `traceFilters`, `traceMetadataColumns`, `traceOrderBy`) plus `sql` / `limit` / `materialize` are exactly the `/execute_*` request a Run submits — see [§9.1](#91-post-execute_bigtrace_query_async) and [§15](#15-per-query-snapshot). There is **no** `traceLimit` field: the trace-fan-out cap is the `trace_limit` setting inside `settings` ([§16](#16-settings-catalog)), same as on `/execute_*`.

Casing: top-level snapshot fields are camelCase (matching `GET /query_executions/{uuid}`); the **one exception** is each `settings` entry, which keeps the `/execute_*` snake_case inner shape (`setting_id`, `values`, `category`).

Notes:

- **Trust + degrade:** the UI applies a template without per-`id` logic, but reconciles `traceMetadataColumns` / `settings` against the live `/trace_metadata_schema` / `/bigtrace_execution_config` — unknown columns / settings are dropped, so a stale template can't strand the UI.
- **Deployment-aware:** a backend that knows its schema/corpus MAY return only templates valid for it (e.g. omit "by device" recipes when it has no `device_name`). Simple backends return everything.

**Example:**

```json
{
  "templates": [
    {
      "id": "binder_txns",
      "category": "Latency",
      "name": "Slowest binder transactions",
      "description": "Binder transactions ordered by duration.",
      "icon": "swap_horiz",
      "sql": "INCLUDE PERFETTO MODULE android.binder;\nSELECT * FROM android_binder_txns ORDER BY dur DESC LIMIT 50;",
      "settings": [{"setting_id": "treat_trace_errors_as_warning", "values": ["true"], "category": "BIGTRACE_QUERY_OPTIONS"}],
      "traceFilters": [],
      "traceMetadataColumns": [],
      "traceOrderBy": "",
      "limit": 0,
      "materialize": true
    }
  ]
}
```

---

## 10. Top-level trace-selection fields

These three fields are NEW in this branch. Together with the `trace_limit` setting ([§16](#16-settings-catalog)), they form the trace-selection pipeline.

### 10.1 `trace_filters`

A `Filter[]` the user composed on the trace-selection grid, **shipped as a native JSON array** in the request body. The backend MUST apply it to its `/trace_metadata` result set to decide which traces a query runs over.

**Wire shape (strict-native-only):** The JSON-body field is a native JSON `Filter[]` array — NOT a JSON-encoded string. All three filter sites share this contract after the 2026-06-03 migration: `/execute_*` `trace_filters`, `/trace_metadata` `filters`, and `:fetch_results` `filters`. The wire stays structured end-to-end (no double-encoding, one composer, one parser). See [§12](#12-filter-grammar) for the inner grammar.

**Default behavior:** Absent / `null` / `[]` → "process every trace in the directory" subject to `trace_limit`.

**Validation:**

- A JSON-encoded string (or any non-list, non-null, non-absent value) MUST be rejected with 400 INVALID_ARGUMENT. The error MUST mention that the field expects a native JSON array and SHOULD note the strict-native migration date (2026-06-03).
- Backends MUST validate `field` names against the live `/trace_metadata_schema` (resolved with the current `settings`) and return 400 INVALID_ARGUMENT on unknown columns.
- Malformed entries MUST surface as 400 INVALID_ARGUMENT.

**Snapshot semantics:** The full GET (`/query_executions/{uuid}`) echoes the submit-time array verbatim under `traceFilters`. An omitted submit-time value reads back as `[]` (never `null`, never `""`).

**Examples:**

```json
// Process only .pftrace files
"trace_filters": [{"field": "file_name", "op": "glob", "value": "*.pftrace"}]

// Process only large traces from specific devices
"trace_filters": [
  {"field": "size_bytes", "op": ">", "value": "10485760"},
  {"field": "device_name", "op": "in", "value": ["pixel9", "pixel10"]}
]

// Process EVERY trace
"trace_filters": []
// equivalent:
"trace_filters": null
// equivalent:
// (field absent from request body)

// REJECTED — JSON-encoded strings must yield 400 INVALID_ARGUMENT
"trace_filters": "[{\"field\":\"file_name\",\"op\":\"glob\",\"value\":\"*.pftrace\"}]"
```

### 10.2 `trace_metadata_columns`

Array of column names from `/trace_metadata_schema` the client wants attached to every query result row.

**Wire shape:** `string[]`.

**Default behavior:** Absent / `null` / `[]` → no metadata attached, legacy result shape.

**Validation:**

- Backends MUST validate against the live `/trace_metadata_schema` and return 400 INVALID_ARGUMENT on:
  - Unknown column names.
  - Non-string entries.
  - Duplicate entries.

**Async path (materialized):** Backend MUST persist the chosen columns into a per-query metadata sidecar table at submit time, keyed by the per-row identifier the backend prepends to result rows (typically `trace_id`). One row per trace processed. See [§11](#11-per-query-metadata-sidecar) for the storage model.

**Sync path:** Backend MUST stitch the metadata values inline into each result row (between `trace_id` and the SQL columns) — there's no materialized table to JOIN against.

**Field-mask reachability:** Whatever the client opted into via `trace_metadata_columns` MUST be reachable via `:fetch_results` `columns`. The page SQL projects from the union (result-table cols ∪ sidecar cols); JOIN is emitted iff the projection / filter / order_by references a sidecar column.

`availableColumnNames` in the response MUST advertise BOTH result-table and sidecar columns so the UI can offer a column-picker after the query has already run.

**Examples:**

```json
// Attach file_name to every result row, accessible via :fetch_results body { columns: ["trace_id", "name", "dur", "file_name"] }
"trace_metadata_columns": ["file_name"]

// Attach multiple
"trace_metadata_columns": ["file_name", "size_bytes", "device_name"]

// No metadata (default)
"trace_metadata_columns": []
```

### 10.3 `trace_order_by`

AIP-132 wire string controlling the order in which traces are processed during fan-out.

**Wire shape:** string (single AIP-132 expression).

**Grammar:** See [§13](#13-order_by-grammar-aip-132-§ordering-subset).

**Default behavior:** Absent / `null` / `""` → fall back to a **deterministic** default order. The reference uses `file_path ASC`; backends MAY pick a different default but MUST be deterministic so a `trace_limit`-capped query produces the same trace set across runs without an explicit order.

**Validation:**

- Lexical parse failures MUST yield 400 INVALID_ARGUMENT at SUBMIT time.
- Column-name validation against the live `/trace_metadata_schema` MAY be deferred to EXECUTE time (still 400 INVALID_ARGUMENT, but surfaced as a FAILED status).

**Examples:**

```json
// Process largest traces first
"trace_order_by": "size_bytes desc"

// Stable alphabetical
"trace_order_by": "file_name asc"

// Multi-field
"trace_order_by": "device_name asc, size_bytes desc"

// Default (file_path ASC on reference)
"trace_order_by": ""
// equivalent:
"trace_order_by": null
// equivalent:
// (field absent)
```

### 10.4 Composition pipeline

When the four trace-selection levers compose, the backend pipeline is:

```
   1. enumerate every trace in the source (e.g. directory walk)
   2. apply trace_filters (Filter[] AND-join)
   3. apply trace_order_by (AIP-132)
   4. truncate to trace_limit (if > 0)
   5. fan out: schedule one SQL execution per trace in the resulting list
```

The `trace_metadata_columns` field doesn't affect WHICH traces are selected — it affects what METADATA is attached to the query's result rows. It's orthogonal to the pipeline above.

**Worked example:**

Source directory has 14 traces. Client ships:
```json
{
  "trace_filters": [{"field": "file_name", "op": "glob", "value": "*.pftrace"}],
  "trace_order_by": "size_bytes desc",
  "trace_metadata_columns": ["file_name", "size_bytes"],
  "settings": [
    {"setting_id": "trace_directory", "values": ["/trace_metadata"], "category": "TRACE_ADDRESS"},
    {"setting_id": "trace_limit", "values": ["3"], "category": "TRACE_ADDRESS"}
  ]
}
```

Backend pipeline:
1. Enumerate 14 traces.
2. Apply filter — 10 traces match `*.pftrace`.
3. Apply order — 10 traces sorted by `size_bytes` descending.
4. Truncate to `trace_limit=3` — top 3 largest traces.
5. Fan out across those 3 traces.

`trace_metadata_columns=["file_name", "size_bytes"]` creates a sidecar table with 3 rows (one per processed trace). The user's SQL output rows can be paired with those metadata values at fetch time via `:fetch_results` body `{columns: ["trace_id", ..., "file_name", "size_bytes"]}`.

---

## 11. Per-query metadata sidecar

Storage model for `trace_metadata_columns` on the async path.

### 11.1 Why a sidecar (not inline)

Inlining metadata into every result row would scale storage with `N_rows × M_metadata_cols`. For trace queries that return millions of rows, that's huge duplication (the same metadata repeated per row).

Storing in a sidecar table keyed by the per-row identifier (one row per trace) scales with `N_traces × M_metadata_cols`. Bounded, small.

The wire only REQUIRES that whatever was opted into via `trace_metadata_columns` is reachable via `:fetch_results` `columns`. Implementations are free to inline (sync path) or JOIN (async sidecar) as needed.

### 11.2 Sidecar lifecycle

The sidecar MUST share the lifecycle of the main result table. Every drop event drops BOTH:

| Event | Drop main? | Drop sidecar? |
|---|---|---|
| `mark_failed` | YES | YES |
| `mark_cancelled` (rows == 0) | YES | YES |
| `mark_cancelled` (rows > 0) | NO | NO |
| `soft_delete` | YES | YES |
| TTL expiry | YES | YES |
| Recovery on restart (stale IN_PROGRESS → FAILED) | YES | YES |
| Process shutdown (clean) | NO | NO |

Backends SHOULD share lifecycle code paths between the two tables so it's impossible for them to drift.

### 11.3 Sidecar schema

The sidecar carries (in this order):

1. The per-row identifier the backend prepends to result rows (typically `trace_id`). MUST be the PRIMARY KEY.
2. One column per name in `trace_metadata_columns`, in the order the client shipped them on `/execute_*`.

Types MAY come from `/trace_metadata_schema`; the wire is always-strings either way ([§3](#3-always-strings-response-contract)).

**Example (3 metadata columns):**

```sql
CREATE TABLE bigtrace_<uuid>_meta (
  trace_id    VARCHAR PRIMARY KEY,
  file_name   VARCHAR,
  size_bytes  BIGINT,
  device_name VARCHAR
);
```

### 11.4 Population

Backends MUST bulk-insert one row per trace included in the fan-out at SUBMIT time (NOT lazily). For 14 traces and `trace_metadata_columns=["file_name", "size_bytes"]`, the sidecar has 14 rows by the time the IN_PROGRESS row is committed to the DB.

Bulk insert paths (Arrow-based for DuckDB, prepared INSERT for SQLite, etc.) are RECOMMENDED — the metadata is small but populating row-by-row makes submit latency noticeable.

### 11.5 Fetch-time JOIN

`:fetch_results` `columns` body field emits SQL of this shape, conceptually:

```sql
SELECT <chosen cols>
FROM <result_table> result
LEFT JOIN <sidecar_table> meta
  ON result.<id_col> = meta.<id_col>
WHERE <filter>
ORDER BY <order_by>
LIMIT <limit> OFFSET <offset>
```

The `LEFT JOIN` is emitted ONLY when the projection, `filters`, or `order_by` references a sidecar column. Pure-result-table queries MUST skip the JOIN so they stay fast.

`LEFT JOIN` (not `INNER JOIN`) — a result row referring to a `trace_id` not in the sidecar would be silently dropped under INNER JOIN; LEFT preserves it with NULLs for the metadata columns.

### 11.6 Identifier choice

The per-row identifier ("`trace_id`" in the reference) is the JOIN key. The wire contract does NOT mandate that name — but it MUST be:

- The FIRST column of every result row in `:fetch_results`.
- The PRIMARY KEY of the sidecar.
- Stable across runs (same trace → same identifier).

For the local-TP backend: `trace_id` = basename of the trace file with the extension stripped (e.g. `/trace_metadata/android_boot.pftrace` → `"android_boot"`).

For a real BigTrace backend: SHOULD be a stable permalink or hash of the trace contents, NOT a filesystem path.

---

## 12. Filter[] grammar

Shared by all three filter sites — **all carry the same wire shape** as of 2026-06-03:
- `/execute_*` top-level `trace_filters` field — strict-native body field
- `:fetch_results` `filters` body field — strict-native body field (POST + JSON body since the migration)
- `/trace_metadata` body field `filters` — strict-native body field

### 12.1 Wire format

The wire shape is uniform: a native JSON array of `Filter` entries in the request body. No outer envelope variation — every filter site uses the same composer and the same parser:

| Endpoint | Wire shape | Notes |
|---|---|---|
| `:fetch_results` `filters` (body) | Native JSON array | **Strings MUST be rejected with 400.** [§9.5](#95-post-query_executionsuuidfetch_results). |
| `/execute_*` `trace_filters` (body) | Native JSON array | **Strings MUST be rejected with 400.** [§10.1](#101-trace_filters). |
| `/trace_metadata` `filters` (body) | Native JSON array | **Strings MUST be rejected with 400.** [§9.9](#99-post-traces). |

Empty / absent / `null` / empty list → no `WHERE` clause emitted. Entries within the inner array are AND-joined.

```json
// Wire shape — the array is the body-field value verbatim.
[
  {"field": "<col>", "op": "=",       "value": "<string>"},
  {"field": "<col>", "op": "in",      "value": ["<string>", ...]},
  {"field": "<col>", "op": "is null"}
]

// Shipped to /execute_* as trace_filters (or `:fetch_results` / `/trace_metadata` as filters)
"trace_filters": [{"field": "<col>", "op": "=", "value": "<string>"}]
```

### 12.2 Op categories

| Category | Ops | `value` shape |
|---|---|---|
| Comparison | `=`, `!=`, `<`, `<=`, `>`, `>=` | string |
| Pattern | `glob`, `not glob` | string |
| Set | `in`, `not in` | non-empty array of strings |
| Null | `is null`, `is not null` | absent (no `value` key) |

All 12 ops MUST be supported. The Filter[] wire is the only filter language the UI speaks.

### 12.3 Value encoding (always-strings)

`value` on the wire is ALWAYS a JSON string (or absent for null-arity ops, or an array of strings for set ops).

The UI's encoder coerces non-string primitives via `String(...)` so numbers / booleans / bigints all serialize losslessly past `Number.MAX_SAFE_INTEGER`:

```
String(123)                     === "123"
String(true)                    === "true"
String(false)                   === "false"
String(1700000000000000000n)    === "1700000000000000000"   // int64 precision preserved
```

Backends MUST coerce the string to the target column's actual type at EXECUTE time via parameter binding, NOT at parse time. If the underlying SQL layer supports column-typed parameter binding (DuckDB, SQLite, Postgres prepared statements all do), bind the value as a string and let the engine coerce.

### 12.4 Comparison semantics on typed columns

A genuinely-bad coercion (e.g. `"not-a-number"` against an `INT64` column) MUST surface as 400 INVALID_ARGUMENT with the offending value in `detail`:

```json
{"detail": "filter[0].value: cannot convert 'abc' to INT64 for column 'size_bytes'"}
```

Numeric `<`, `>`, etc. against a typed numeric column do NUMERIC comparison (not lexical) because the engine binds the string to the numeric column type.

### 12.5 JSON `null` value

JSON `null` as `value` for a scalar op is allowed and round-trips as SQL `NULL`. BUT: `col = NULL` is always false in SQL, so a `null` filter value almost never matches anything. Users SHOULD use `is null` instead. Backends MAY accept JSON `null` and emit `WHERE col = NULL`; it's not strictly an error but it's a sharp edge.

### 12.6 Validation contract (400 INVALID_ARGUMENT)

Backends MUST reject with 400 INVALID_ARGUMENT for each of:

1. Malformed JSON.
2. Top-level value not an array.
3. Entry missing `field` (non-empty string).
4. Entry missing `op` (recognized op string).
5. Comparison or pattern op with an array `value`.
6. `in` / `not in` with non-array or empty-array `value`.
7. Null op carrying any `value` key.
8. `field` not in the column list for this scan (against `:fetch_results` materialized table OR `/trace_metadata` schema OR `/execute_*` trace-grid schema — different for each endpoint).
9. Bind-time conversion failure (the engine's coercion rejects the string).

The `detail` string SHOULD name the offending entry / field for client display.

### 12.7 SQL composition rules

- **Parameterize all values.** NEVER splice user-supplied bytes into SQL strings. Use the SQL layer's binding mechanism (DuckDB / SQLite `?`, Postgres `$1`, etc.).
- **Quote identifiers.** Double-quote column names so user-column names colliding with reserved words / containing special characters work.
- **Clause ordering.** `SELECT … FROM <tbl> [JOIN …] [WHERE …] [ORDER BY …] LIMIT ? OFFSET ?` — WHERE precedes ORDER BY precedes pagination.
- **Op-to-SQL mapping:**

| Op | SQL fragment | Bind params |
|---|---|---|
| `=`, `!=`, `<`, `<=`, `>`, `>=` | `col <op> ?` | 1 |
| `glob` | `col GLOB ?` | 1 |
| `not glob` | `NOT (col GLOB ?)` | 1 (some engines reject `NOT GLOB` as a single token) |
| `in` | `col IN (?, ?, …)` | N |
| `not in` | `col NOT IN (?, ?, …)` | N |
| `is null` | `col IS NULL` | 0 |
| `is not null` | `col IS NOT NULL` | 0 |

### 12.8 Worked examples

```json
// Single equality
[{"field": "file_name", "op": "=", "value": "android_boot.pftrace"}]
// → WHERE "file_name" = ?

// Multiple ANDed
[
  {"field": "size_bytes", "op": ">", "value": "10485760"},
  {"field": "file_name", "op": "glob", "value": "*.pftrace"}
]
// → WHERE "size_bytes" > ? AND "file_name" GLOB ?

// IN with 3 values
[{"field": "device_name", "op": "in", "value": ["pixel9", "pixel10", "pixel11"]}]
// → WHERE "device_name" IN (?, ?, ?)

// Null filter
[{"field": "device_name", "op": "is null"}]
// → WHERE "device_name" IS NULL

// Combined
[
  {"field": "size_bytes", "op": ">=", "value": "1048576"},
  {"field": "device_name", "op": "not in", "value": ["emulator"]},
  {"field": "android_id", "op": "is not null"}
]
// → WHERE "size_bytes" >= ? AND "device_name" NOT IN (?) AND "android_id" IS NOT NULL
```

### 12.9 Bad-input examples

```json
// 400: top-level not an array
{"field": "foo", "op": "="}

// 400: missing op
[{"field": "foo", "value": "bar"}]

// 400: unknown op
[{"field": "foo", "op": "matches_regex", "value": "x.*"}]

// 400: comparison op with array value
[{"field": "foo", "op": "=", "value": ["a", "b"]}]

// 400: IN with empty array
[{"field": "foo", "op": "in", "value": []}]

// 400: IN with non-array
[{"field": "foo", "op": "in", "value": "a"}]

// 400: null op with value
[{"field": "foo", "op": "is null", "value": "x"}]

// 400: unknown column
[{"field": "no_such_col", "op": "=", "value": "x"}]
```

---

## 13. `order_by` grammar (AIP-132 §Ordering subset)

Shared by:
- `/execute_*` top-level `trace_order_by` field
- `:fetch_results` `order_by` query param
- `/trace_metadata?order_by=` body field

### 13.1 Grammar

```
order_by  = field [SP direction] *( "," [SP] field [SP direction] )
direction = "asc" | "desc"     ; default "asc", case-insensitive
SP        = " "                ; one or more spaces
field     = column name (validated against the live schema)
```

### 13.2 Examples

| Input | Parsed | SQL |
|---|---|---|
| `""` (empty) | `[]` | (no ORDER BY) |
| `"name"` | `[("name", "ASC")]` | `ORDER BY "name" ASC` |
| `"name asc"` | `[("name", "ASC")]` | `ORDER BY "name" ASC` |
| `"name desc"` | `[("name", "DESC")]` | `ORDER BY "name" DESC` |
| `"name DESC"` | `[("name", "DESC")]` (case-insensitive) | `ORDER BY "name" DESC` |
| `"name desc, dur asc"` | `[("name", "DESC"), ("dur", "ASC")]` | `ORDER BY "name" DESC, "dur" ASC` |
| `"name, dur desc"` | `[("name", "ASC"), ("dur", "DESC")]` | `ORDER BY "name" ASC, "dur" DESC` |

### 13.3 Validation contract (400 INVALID_ARGUMENT)

| Input | Why bad |
|---|---|
| `"name sideways"` | Unknown direction |
| `"name desc,, dur"` | Empty entry |
| `"name desc dur"` | Missing comma between fields |
| `",name"` | Leading comma / empty entry |
| `"no_such_col asc"` | Unknown column (against the live schema) |
| `"123name"` | (Reserved for future) Identifier starting with digit — backends MAY accept |

The `detail` SHOULD name the offending token / column for client display:

```json
{"detail": "trace_order_by: invalid direction 'sideways' (expected 'asc' or 'desc')"}
{"detail": "trace_order_by: unknown column 'no_such_col'"}
```

### 13.4 Stable sort

Backends MAY rely on the underlying engine's default stability behavior — the wire doesn't require a stable sort. Clients SHOULD include a deterministic tiebreaker (e.g. `name desc, id asc`) if they need reproducible ordering across queries.

---

## 14. `columns` field-mask

Shared by:
- `:fetch_results` `columns` query param
- `/trace_metadata` body field `columns`

### 14.1 Wire format

URL-encoded comma-separated list of column names:

```
columns=col1,col2,col3
```

### 14.2 Semantics

| `columns` value | Behavior on `:fetch_results` | Behavior on `/trace_metadata` |
|---|---|---|
| Absent / `null` | Return ALL result-table columns, NO sidecar columns. | Return every `/trace_metadata_schema` column flagged `default: true`. |
| `""` (empty string) | Same as absent | Same as absent |
| `"a,b,c"` | Return exactly those columns in that order | Return exactly those columns in that order |

### 14.3 Column resolution scope

- `:fetch_results`: resolution scope = union (result-table cols ∪ sidecar cols). The sidecar is included even if no sidecar column is in the projection — `filters` / `order_by` MAY still reference sidecar columns.
- `/trace_metadata`: resolution scope = every column in `/trace_metadata_schema` (regardless of `default` flag).

### 14.4 Filter / order_by independence

`filters` and `order_by` MAY reference columns NOT in the `columns` projection. The underlying scan sees the full schema; only the response shape is narrowed by `columns`.

Example: `columns=trace_id,name` with `order_by=size_bytes desc` is valid — the page is sorted by `size_bytes` (which lives in the sidecar) but the response only contains `trace_id` and `name`.

### 14.5 Validation

Backends MUST validate every column name and return 400 INVALID_ARGUMENT:

| Bad input | Reason |
|---|---|
| `columns=no_such_col` | Unknown column |
| `columns=,trace_id` | Leading empty entry |
| `columns=trace_id,trace_id` | Duplicate — backends MAY accept and dedupe, or reject (the reference rejects) |

### 14.6 availableColumnNames invariant (`:fetch_results` only)

On `:fetch_results`, the `availableColumnNames` field in the response MUST be IDENTICAL across all `columns` projections for the same query — it advertises the FULL union of (result-table cols ∪ sidecar cols), independent of the current projection. This is so the UI's column picker can offer columns not currently shown.

`/trace_metadata` MUST NOT echo `availableColumnNames` — its column catalog lives on `/trace_metadata_schema` ([§9.10](#910-post-traces_schema)). See [§9.9](#99-post-traces).

---

## 15. Per-query snapshot

The four submit-time fields below MUST be persisted per execution and surfaced on the per-uuid full GET so the UI can answer "what did this query run with?"

### 15.1 Persisted fields

| Submit-time field | Full-GET field (camelCase) | Default (omitted / null / `""` / `[]` on submit) | Persisted type |
|---|---|---|---|
| `settings` | `settings` | `[]` | JSON-encoded array (`VARCHAR`) |
| `trace_filters` | `traceFilters` | `[]` | JSON-encoded array (`VARCHAR`) — internal storage form; wire ships native array round-tripped via `json.loads` on read ([§10.1](#101-trace_filters)) |
| `trace_metadata_columns` | `traceMetadataColumns` | `[]` | JSON-encoded array (`VARCHAR`) |
| `trace_order_by` | `traceOrderBy` | `""` | Wire string verbatim (`VARCHAR`) |

### 15.2 Persistence rules

1. **Frozen at submit.** Backends MUST store the snapshot BEFORE any field-level validation runs. Even a query that 400s at submit time records what was attempted (so the user can inspect "what did I try?" from the history sidebar). State transitions (`mark_success` / `mark_failed` / `mark_cancelled`) MUST NOT modify the snapshot.

2. **Default semantics.** For list-typed fields (`settings`, `trace_metadata_columns`, `trace_filters`), absent / `null` / `[]` on the wire MUST persist identically and read back as `[]`. For string-typed fields (`trace_order_by`), absent / `null` / `""` MUST read back as `""`. Backends MUST NOT return `null` for any of these fields — UIs would have to null-check every render path.

   Note that `trace_filters` is a STRING from end to end now (no list defaults, no JSON re-wrap on either persist or response). The full GET echoes whatever bytes the client submitted, verbatim.

3. **Lean polling.** `:status` MUST NOT echo the snapshot ([§9.3](#93-get-query_executionsuuidstatus) is strict 4 fields).

4. **Lean history.** `/query_executions` list MUST omit the snapshot ([§9.7](#97-get-query_executions)). Clients fetch the per-uuid GET to inspect.

5. **Persistence storage.** Backends MAY persist these as JSON-encoded strings in nullable columns. The reference uses `VARCHAR` for `settings` and `trace_metadata_columns` (JSON-encoded), and a raw `VARCHAR` for `trace_filters` / `trace_order_by` (both already strings on the wire — no extra JSON wrap).

### 15.3 Why this matters

The submit-time snapshot powers the per-tab "Bigtrace Settings" sub-tab on `/query` in the BigTrace UI. When the user reopens a history entry, the UI hits the full GET and uses the snapshot to:

- Restore the trace-grid filter chips to what the original query used.
- Restore the trace-grid sort to what the original query used.
- Show which metadata columns are attached to the result rows.
- Show which backend settings were active at submit time.

Without the snapshot, the user can't tell "what did this query run with?" — only "what's the SQL?" — which loses important context.

### 15.4 Worked example

Client submits:

```json
POST /execute_bigtrace_query_async
{
  "perfetto_sql": "SELECT name FROM slice LIMIT 5",
  "limit": 100,
  "settings": [{"setting_id": "trace_directory", "values": ["/trace_metadata"], "category": "TRACE_ADDRESS"}],
  "trace_filters": "[{\"field\":\"file_name\",\"op\":\"glob\",\"value\":\"*.pftrace\"}]",
  "trace_metadata_columns": ["file_name"],
  "trace_order_by": "size_bytes desc"
}
```

Returns:

```json
{"queryUuid": "7720667b-..."}
```

Later, client fetches:

```json
GET /query_executions/7720667b-...

{
  "queryUuid": "7720667b-...",
  "status": "SUCCESS",
  "startTime": "2026-05-23T16:03:47.319Z",
  "endTime":   "2026-05-23T16:03:54.212Z",
  "processedRows": 5,
  "processedTraces": 14,
  "totalTraces": 14,
  "perfettoSql": "SELECT name FROM slice LIMIT 5",
  "limit": 100,
  "materialized": true,
  "tableName": "bigtrace_7720667b_1646_4527_a055_f5feace8881e",

  "settings":              [{"setting_id": "trace_directory", "values": ["/trace_metadata"], "category": "TRACE_ADDRESS"}],
  "traceFilters":           "[{\"field\":\"file_name\",\"op\":\"glob\",\"value\":\"*.pftrace\"}]",
  "traceMetadataColumns":  ["file_name"],
  "traceOrderBy":          "size_bytes desc"
}
```

A client that submitted with all four fields absent gets `[]`, `""`, `[]`, `""` echoed back — same as a client that explicitly shipped empty values.

---

## 16. Settings catalog

### 16.1 What's a setting vs a top-level field

This branch's design philosophy:

- **Settings** are backend CONFIG (e.g. "where to find traces"). Live in `/bigtrace_execution_config`. UI auto-generates a form from the catalog. Shipped to `/execute_*` inside the `settings` array.
- **Top-level fields** are per-query SELECTION knobs (`trace_filters`, `trace_order_by`, `trace_metadata_columns`). Shipped as siblings of `perfetto_sql` on `/execute_*`. NOT in the catalog.

`trace_limit` is a **setting** even though it's a per-query knob: it lives in the catalog and ships inside the `settings` array, and the backend reads the cap from there (`trace_limit(settings)`) at execute time. It is NOT a top-level field.

### 16.2 Settings categories

| Category | Meaning |
|---|---|
| `TRACE_ADDRESS` | Required for queries — the UI renders these without an enable/disable toggle and treats them as load-bearing. |
| `TRACE_METADATA` | Filter chips for per-trace metadata (only meaningful if `/trace_metadata_settings` returns non-empty). |
| `BIGTRACE_QUERY_OPTIONS` | Per-query options that aren't trace-selection (timeout, retry policy, etc.). |
| `SETTING_CATEGORY_UNSPECIFIED` | Default; UI treats as optional. |

### 16.3 Conformance

A compliant backend MUST expose at LEAST `trace_directory` as a TRACE_ADDRESS plainString setting. Other settings (including `trace_limit`) are RECOMMENDED but not strictly required.

---

## 17. Conformance test surfaces

A re-implementation can validate against the reference smoke / unit tests in this repo. The HTTP smoke is the most portable — it speaks pure HTTP and can be pointed at any backend.

### 17.1 HTTP smoke (`smoke_local.py`)

The smoke covers 26 blocks (1, 2, …, 11, 11a, 12, …, 26). The full list is in [`README.md`](./README.md) under "Smoke test". The blocks most relevant to this branch's additions:

| Block | Tests |
|---|---|
| [16] | Top-level `trace_filters` narrows the trace set (`totalTraces` reflects the filter). |
| [22] | `:fetch_results` `order_by` ASC/DESC/multi-field; bad direction + unknown column → 400. |
| [23] | `:fetch_results` `filters` end-to-end; every op variant; 3 bad-input paths. |
| [24] | `/trace_metadata` + `/trace_metadata_schema` end-to-end; happy path, filter, order_by, columns, 9 bad-request cases; schema invariants. |
| [25] | Async `trace_metadata_columns` → sidecar + `:fetch_results` `columns` JOIN transparency; sync inline-stitch; unknown columns 400. |
| [26] | Submit-time snapshot round-trip; lean `:status` + lean list. |
| [27] | Top-level `trace_order_by` re-orders the fan-out; snapshot echoes verbatim; malformed → 400. |

To run against a re-implementation, point the smoke's backend URL at the new backend and execute:

```sh
.venv/bin/python smoke_local.py --traces-dir /path/to/trace_metadata
```

A compliant backend SHOULD pass every block. Block [20] (server restart recovery) requires the backend to support SIGINT-induced exit and clean restart — backends MAY skip this if their stack doesn't support it.

### 17.2 Unit tests

The Python unit tests target this implementation's internals. They're useful as a model for what to test in a re-implementation, but not directly portable:

| File | What it covers |
|---|---|
| `db_unittest.py:ParseFilterHappyTest` / `ParseFilterErrorTest` / `CompileWhereTest` | Filter[] parser golden tests (every op variant + error path). |
| `db_unittest.py:ParseOrderByTest` | AIP-132 parser golden tests. |
| `db_state_unittest.py:SnapshotRoundTripTest` | 4-field snapshot DB round-trip + defaults + state-transition invariance. |
| `server_unittest.py:ResolveTracesForTest` | Trace-selection pipeline composition. |
| `server_unittest.py:QeToRawSnapshotTest` | Snapshot emit-on-full-GET / omit-on-list-and-status. |

---

## 18. Implementation hints (non-normative)

### 18.1 Storage layout

The reference uses a single DuckDB file with two stores:

- One `query_executions` table with one row per submitted query (history + metadata + snapshot).
- One `bigtrace_<uuid>` table per async query that produced rows (the materialized result; dynamic schema based on user SELECT).
- One `bigtrace_<uuid>_meta` table per async query that opted into `trace_metadata_columns` (the sidecar).

A re-implementation MAY use a different storage layout — Postgres + a per-query schema, in-memory only, S3+Parquet, etc. The wire contract doesn't care.

### 18.2 Concurrency

The reference holds a single DuckDB connection guarded by an in-process lock. Critical sections are short (one statement at a time). Cancellation flows entirely through this lock — see [§7](#7-cancellation-invariants).

A multi-instance deployment behind a load balancer MUST coordinate cancellation through the shared persistent store. The only authoritative cancel signal is the row's `status` column.

### 18.3 Bulk inserts

Per-trace row merges hit the DB N times during a fan-out. The reference uses Arrow-based `from_arrow(...).insert_into(...)` to merge ~1M rows in ~0.5s vs ~10min via row-by-row `executemany`. Re-implementations SHOULD use whatever bulk-insert path their engine supports.

### 18.4 Background task lifecycle

The reference uses `asyncio.create_task(...)` to schedule the background fan-out. The asyncio event loop keeps a strong reference to the task until it completes — no need for the handler to await it.

The submit handler returns IMMEDIATELY after inserting the IN_PROGRESS row + validating + spawning the task. The task does the actual work; the client polls `:status` to see progress.

### 18.5 Recovery on restart

On boot, run a single statement:

```sql
UPDATE query_executions
SET status = 'FAILED',
    end_time = NOW(),
    error_message = 'recovered after restart (server crashed mid-query)',
    table_name = NULL
WHERE status = 'IN_PROGRESS'
```

…and drop the orphaned result + sidecar tables. The reference does this in the FastAPI lifespan startup hook.

### 18.6 TTL sweep

A simple periodic task that runs:

```sql
SELECT query_uuid FROM query_executions
WHERE status != 'IN_PROGRESS'
  AND end_time < NOW() - INTERVAL '<ttl> seconds'
  AND table_name IS NOT NULL
```

…and drops the listed tables + clears `table_name`. The reference runs this every 5 minutes for a 1-day TTL.

### 18.7 Validation ordering

Cheap validations (parseability, shape) at SUBMIT time so the user gets a 400 fast. Expensive validations (column-name lookup against an indexer, directory walk) deferred to the background task — the FAILED row records the same `detail` as `error_message`.

---

## 19. Glossary

| Term | Meaning |
|---|---|
| **BigTrace UI** | The Mithril SPA at `ui/src/bigtrace/` in the perfetto repo. Talks to whatever backend `bigtraceEndpoint` setting points at. |
| **Reference backend** | This directory — the Python/FastAPI/DuckDB local-TP implementation. This spec describes its wire contract; the [README.md](./README.md) describes the implementation. |
| **Snapshot** | The four submit-time fields persisted per execution (settings / traceFilters / traceMetadataColumns / traceOrderBy) and surfaced on the per-uuid full GET. |
| **Sidecar** | The per-query metadata table holding `trace_metadata_columns` values, keyed by the per-row identifier. JOINed at fetch time when the projection references a sidecar column. |
| **Always-strings** | The wire contract that every cell in `rows[].values` is a JSON string (or null). Preserves int64 precision past `2^53`. |
| **AIP-132** | Google's API Improvement Proposal §132 for ordering. The `order_by` grammar in this spec is the §Ordering subset. |
| **trace_id** | The per-row identifier the local-TP backend prepends to result rows. Other backends MAY use a different identifier (permalink, hash, etc.); the wire only requires that whatever is chosen is the JOIN key into the sidecar. |
| **Materialized** | A query whose result is persisted to a row table the client can paginate (`fetch_results`). `materialized=true` on async by default; sync queries are `materialized=false`. |
| **Submit-time snapshot** | The frozen-at-submit copy of `settings` + `trace_filters` + `trace_metadata_columns` + `trace_order_by`. Survives all state transitions; lost only on soft-delete. |
| **TTL** | Time-to-live for materialized result tables. After TTL, the table is dropped but the metadata row stays. |
| **Soft-delete** | The `deleted=true` flag on a row. Treated as "gone" by every endpoint but kept for audit. |

---

**End of spec.**
