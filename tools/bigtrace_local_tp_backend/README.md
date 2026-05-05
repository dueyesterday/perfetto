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
as a safety net by 404-ing fetches when `tableName` is null.

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
  404 (treats the entry as gone).
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
- `:fetch_results` returns 404;
- The history list still shows the entry with its preserved
  status/SQL/processed counts.

### Result limit is global, not per-trace

The `limit` parameter on `/execute_bigtrace_query{,_async}` is a
**total** cap. With `limit=1000` over 14 traces the materialized table
contains at most 1000 rows. Workers short-circuit at the cancel/limit
checks once the cap is reached, so trailing traces don't waste TP
work.

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
cd ~/Projects/perfetto_2/tools/bigtrace_local_tp_backend
.venv/bin/python server.py --traces-dir ~/Downloads \
  --with-datasette --with-db-ui

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

The Python `TraceProcessor` lives in `~/Projects/perfetto/python` — we
install it editable so we always get the in-repo version, not PyPI.

```sh
./setup_venv.sh
```

This creates `.venv/`, installs `fastapi`, `uvicorn`, `numpy`,
`protobuf`, `duckdb`, `pyarrow`, `datasette`, `datasette-parquet`,
and pip-installs `~/Projects/perfetto/python` in editable mode.
Re-run any time `requirements.txt` changes.

## Run

```sh
.venv/bin/python server.py --traces-dir ~/traces \
  [--port 8002] \
  [--max-pool 4] \
  [--db-path ~/.cache/bigtrace_local/state.duckdb] \
  [--table-ttl-seconds 86400] \
  [--table-ttl-sweep-seconds 300] \
  [--with-db-ui [PORT]] \
  [--with-datasette [PORT]]
```

`--traces-dir` (alias `--default-trace-directory`) is required and
becomes the **default** value of the `Trace Directory` setting. The
user can override it per-query at runtime via the BigTrace settings UI;
the CLI value is just what the input is pre-populated with. Files
matched: `.pftrace`, `.perfetto-trace`, `.pb`, `.trace`. If the
directory is missing at startup the server logs a warning and starts
anyway — but queries then fail with HTTP 400 ("Trace Directory '…'
does not exist") until the user picks a real directory in settings.

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
| POST | `/execute_bigtrace_query_async` | Returns `{columnNames:['queryUuid'],rows:[{values:[uuid]}]}`; spawns a background task that runs the SQL across every matching trace. tableName is set immediately. |
| POST | `/execute_bigtrace_query` | Sync variant. Returns the assembled tabular result inline; logged to history with `materialized=false`. |
| GET | `/query_executions/{uuid}:status` | **Strict progress-only**: `{queryUuid, status, processedTraces, totalTraces, processedRows}`. UI polls this every 3s; static metadata isn't here. |
| GET | `/query_executions/{uuid}` | Full execution details. Read once at submit and again on terminal-state transition for the static metadata + tableName. 404 if soft-deleted. |
| GET | `/query_executions/{uuid}:fetch_results` | Paginated `?limit=&offset=` over the materialized result. **404** if `tableName` is null (sync, FAILED, CANCELLED-with-0, soft-deleted, TTL-expired). |
| POST | `/query_executions/{uuid}:cancel` | Atomically transitions to CANCELLED under the DB lock. 200. No row lands after this returns. |
| GET | `/query_executions` | Lists all non-soft-deleted executions, newest first. `perfettoSql` and `errorMessage` truncated to 200 chars; full text on the per-uuid endpoint. |
| DELETE | `/query_executions/{uuid}` | Soft-delete. 200 on terminal, 409 on IN_PROGRESS, 404 if already deleted/missing. |
| POST | `/bigtrace_execution_config` | Static settings schema (see `settings.py`). |
| POST | `/trace_metadata_settings` | Empty (no indexer). UI hides the section. |

Result rows are tagged with the trace they came from: the first column
is `trace_id` (basename of the trace file with the extension stripped),
followed by the user query's columns.

The `settings` array on `/execute_bigtrace_query{,_async}` is applied
to the run (filter regex, trace directory, trace limit) but not
persisted. The wire shape has no `receivedSettings` echo — settings
persistence is a deliberate deferred decision so this backend stays
multi-instance-correct (any in-process echo would be invisible to
other instances behind a load balancer).

## Inspecting the DuckDB store

Several options; `--with-datasette` is the most practical.

### Option 1: in-process Datasette (recommended)

```sh
.venv/bin/python server.py --traces-dir ~/Downloads --with-datasette
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
.venv/bin/python server.py --traces-dir ~/Downloads --with-db-ui
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
   `:fetch_results` returns 404 (no materialized table for sync),
4. async query, polling to SUCCESS,
5. paginated `:fetch_results`,
5a. streaming progress + mid-flight `:fetch_results` returning rows
    while IN_PROGRESS (verifies threaded merge is live, not batched),
6. async query that fails (`SELECT * FROM does_not_exist`), with
   `:fetch_results` returning 404 (FAILED clears tableName),
7. cancel mid-flight reaching a terminal state,
7a. partials-on-cancel: CANCELLED with rows > 0 keeps tableName +
    rows fetchable; soft-skip if cancel races natural completion,
8. list truncation: `perfettoSql` clipped to 200 chars in the list,
   full on the per-uuid detail,
9. soft delete: list filtered, all per-uuid endpoints 404 after
   DELETE, re-DELETE returns 404,
10. TTL sweep: smoke runs the server with a tight TTL=5s and asserts
    that fetch returns 404 + tableName=null after the wait, while
    metadata is preserved.
11. Result limit is **global**, not per-trace: `limit=7` over 14
    traces materializes ≤ 7 rows total.
12. `:status` payload is **strictly the 5 progress fields**
    (`queryUuid`, `status`, `processedTraces`, `totalTraces`,
    `processedRows`). No `endTime`, `errorMessage`, etc. — those live
    on the full GET only. Verified for both SUCCESS and FAILED.
13. `DELETE` while a query is `IN_PROGRESS` returns 409 with a
    "cancel first" message; only terminal queries can be soft-deleted.
14. Every per-uuid endpoint (`status`/`fetch_results`/full GET/cancel/
    delete) returns 404 on an unknown UUID.
15. Datasette + `tableLink`: smoke server is spawned with
    `--with-datasette PORT`; verifies the inspector comes up,
    `tableLink` from a successful query points at a Datasette URL with
    `?sql=...`, that URL renders the table HTML, and the `.json`
    variant returns rows.

If no traces are available it prints `SKIP` and returns 0.

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

- `server.py` — FastAPI app, request handlers, lifecycle (DB init,
  TTL sweep task, optional DuckDB UI bring-up).
- `db.py` — DuckDB-backed persistence: schema, all DDL/DML helpers,
  Arrow-based bulk inserts, soft-delete, TTL sweep query, recovery on
  startup.
- `query_executor.py` — `RunContext` + threaded executor that runs
  SQL across N traces in parallel and merges rows under the run lock.
- `trace_pool.py` — LRU pool of `TraceProcessor` instances, one per
  trace path. Thread-safe sync API.
- `settings.py` — static settings schema, plus the `trace_filter`
  regex extractor and the `trace_directory` extractor (the two
  settings that do real work in this backend).
- `smoke_local.py` — end-to-end smoke (HTTP-level).
- `setup_venv.sh` — one-shot venv bootstrap.
- `requirements.txt` — pip deps (perfetto installed editable separately).
