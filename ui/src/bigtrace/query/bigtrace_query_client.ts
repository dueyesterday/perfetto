// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import type {Row as DataGridRow} from '../../trace_processor/query_result';
import type {Filter} from '../../components/widgets/datagrid/model';
import type {SettingFilter} from '../settings/settings_types';
import {coerceFiltersForWire} from './filter_encoding';
import type {RawQueryExecution} from './query_history_storage';

// Tabular wire shape. Values are always strings, 'null' denotes SQL NULL.
interface QueryResponsePayload {
  queryUuid?: string;
  columnNames?: string[];
  rows?: Array<{values: Array<string | null>}>;
  // Filtered count for scrollbar sizing.
  totalFilteredRows?: number;
  // Full union of (result table cols ∪ sidecar metadata cols),
  // surfaced on :fetch_results so the UI's column picker can offer
  // sidecar columns even when the current projection doesn't
  // include them. Undefined on every other endpoint.
  availableColumnNames?: string[];
}

export interface QueryResultPage {
  readonly rows: ReadonlyArray<DataGridRow>;
  readonly columns: ReadonlyArray<string>;
  readonly queryUuid?: string;
  // Post-filter count from `:fetch_results`; undefined elsewhere.
  readonly totalFilteredRows?: number;
  // Full schema returned by `:fetch_results`; see the wire field.
  readonly availableColumnNames?: ReadonlyArray<string>;
}

// One row of the `/traces_schema` response. Mirrors the wire shape:
// `name` and `type` are required, `defaultVisible` flags the columns
// the grid shows on first render, `description` is optional tooltip
// copy. (`defaultVisible` not `default` — `default` is awkward to
// destructure in strict mode and visually collides with the JS
// keyword.)
export interface TraceColumnDescriptor {
  readonly name: string;
  readonly type: string;
  readonly defaultVisible: boolean;
  readonly description?: string;
}

export interface TracesSchemaResponse {
  readonly columns: ReadonlyArray<TraceColumnDescriptor>;
}

// Request aborted via AbortSignal — treat as cancellation, not an error.
export class QueryCancelledError extends Error {
  constructor() {
    super('Query was cancelled.');
    this.name = 'QueryCancelledError';
  }
}

// Backend returned 404 for a UUID; distinct from generic HTTP errors so
// callers can drop the dead reference instead of polling forever.
export class QueryNotFoundError extends Error {
  constructor(uuid: string) {
    super(`Query ${uuid} not found on the backend.`);
    this.name = 'QueryNotFoundError';
  }
}

// Single funnel for the BigTrace HTTP API.
export class BigtraceQueryClient {
  constructor(private readonly endpoint: string) {}

  // ----- Query execution -----

  async executeSync(
    query: string,
    limit: number,
    settings: ReadonlyArray<SettingFilter>,
    signal?: AbortSignal,
    traceFilters?: ReadonlyArray<Filter>,
    traceMetadataColumns?: ReadonlyArray<string>,
    traceOrderBy?: string,
  ): Promise<QueryResultPage> {
    return this.executeAt(
      '/execute_bigtrace_query',
      query,
      limit,
      settings,
      signal,
      traceFilters,
      traceMetadataColumns,
      traceOrderBy,
    );
  }

  async executeAsync(
    query: string,
    limit: number,
    settings: ReadonlyArray<SettingFilter>,
    signal?: AbortSignal,
    traceFilters?: ReadonlyArray<Filter>,
    traceMetadataColumns?: ReadonlyArray<string>,
    traceOrderBy?: string,
  ): Promise<QueryResultPage> {
    return this.executeAt(
      '/execute_bigtrace_query_async',
      query,
      limit,
      settings,
      signal,
      traceFilters,
      traceMetadataColumns,
      traceOrderBy,
    );
  }

  // Trace-selection grid backing `/traces`. Mirrors `fetchResults`:
  // paged metadata with the same always-strings wire shape. The
  // Settings page embeds a DataGrid driven by
  // `BigtraceTraceListDataSource`, whose filter state then ships back
  // as `traceFilters` on the execute call — "filter on the grid is the
  // trace set the query runs over".
  //
  // `columns` is an optional field-mask: when set, only those columns
  // appear in the response (in the given order). When omitted, the
  // backend returns every column flagged `defaultVisible: true` in
  // its schema (see `listTracesSchema`). `filter` / `orderBy` may
  // reference columns outside the projection — the underlying scan
  // still sees them so the predicates apply.
  async listTraces(
    settings: ReadonlyArray<SettingFilter>,
    limit: number,
    offset: number,
    signal?: AbortSignal,
    orderBy?: string,
    filter?: ReadonlyArray<Filter>,
    columns?: ReadonlyArray<string>,
  ): Promise<QueryResultPage> {
    const body: Record<string, unknown> = {
      settings: settings.map((s) => ({
        setting_id: s.settingId,
        values: s.values,
        category: s.category,
      })),
      limit,
      offset,
    };
    if (orderBy && orderBy.length > 0) {
      body.order_by = orderBy;
    }
    if (filter && filter.length > 0) {
      // Strict-native body contract: ship the array directly with
      // always-strings value coercion (bigints / numbers / booleans
      // → String()) so the wire stays uniform across body sites.
      body.filters = coerceFiltersForWire(filter);
    }
    if (columns && columns.length > 0) {
      body.columns = [...columns];
    }
    const result = await this.requestJson<QueryResponsePayload>('/traces', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
      signal,
    });
    return parseQueryResponse(result);
  }

  // Describes the columns the `/traces` endpoint can return for the
  // current trace source. Called once on Settings-page load to build
  // the SchemaRegistry that drives the trace-list grid and the
  // column-picker widget. `settings` is passed to forward-compat
  // backends whose schema depends on the trace source.
  async listTracesSchema(
    settings: ReadonlyArray<SettingFilter>,
    signal?: AbortSignal,
  ): Promise<TracesSchemaResponse> {
    const body = JSON.stringify({
      settings: settings.map((s) => ({
        setting_id: s.settingId,
        values: s.values,
        category: s.category,
      })),
    });
    return this.requestJson<TracesSchemaResponse>('/traces_schema', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body,
      signal,
    });
  }

  async getStatus(
    uuid: string,
    signal?: AbortSignal,
  ): Promise<RawQueryExecution> {
    return this.requestJson<RawQueryExecution>(
      `/query_executions/${uuid}:status`,
      {signal},
    );
  }

  async getQueryExecution(
    uuid: string,
    signal?: AbortSignal,
  ): Promise<RawQueryExecution> {
    return this.requestJson<RawQueryExecution>(`/query_executions/${uuid}`, {
      signal,
    });
  }

  // Page the materialized table; `limit`/`offset` apply after orderBy/filter.
  // `orderBy` is AIP-132; `filter` is the DataGrid `Filter[]` shape shipped
  // natively in the POST body. Mid-flight calls return whatever rows have
  // merged. `columns` is an optional field-mask over the union of
  // (result-table cols ∪ sidecar metadata cols) — set to project a
  // subset; omitted means "every result-table column, no sidecar JOIN".
  //
  // POST + body (not GET + query string) because the strict-native body
  // contract requires `filter` to be a native JSON array — same contract as
  // `/execute_*` `trace_filters` and `/traces` `filters`. Migrated 2026-06-03.
  async fetchResults(
    uuid: string,
    limit: number,
    offset: number,
    signal?: AbortSignal,
    orderBy?: string,
    filter?: ReadonlyArray<Filter>,
    columns?: ReadonlyArray<string>,
  ): Promise<QueryResultPage> {
    const body: Record<string, unknown> = {limit, offset};
    if (orderBy && orderBy.length > 0) {
      body.order_by = orderBy;
    }
    if (filter && filter.length > 0) {
      body.filters = coerceFiltersForWire(filter);
    }
    if (columns && columns.length > 0) {
      body.columns = [...columns];
    }
    const result = await this.requestJson<QueryResponsePayload>(
      `/query_executions/${uuid}:fetch_results`,
      {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
        signal,
      },
    );
    // `availableColumnNames` is `:fetch_results`-only by spec (WIRE_SPEC §9.9
    // / §14.6): `/traces` mustn't echo a column catalog because
    // `/traces_schema` is the source of truth, so the parser stays
    // endpoint-agnostic and only this call site exposes the field.
    return {
      ...parseQueryResponse(result),
      availableColumnNames: result.availableColumnNames,
    };
  }

  async cancelQuery(uuid: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/query_executions/${uuid}:cancel`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({}),
      signal,
    });
  }

  async listQueryExecutions(
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<RawQueryExecution>> {
    const result = await this.requestJson<{
      queryExecutions?: RawQueryExecution[];
    }>('/query_executions', {signal});
    return result.queryExecutions ?? [];
  }

  async deleteQueryExecution(
    uuid: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(`/query_executions/${uuid}`, {
      method: 'DELETE',
      signal,
    });
  }

  // ----- Internals -----

  private async executeAt(
    path: string,
    query: string,
    limit: number,
    settings: ReadonlyArray<SettingFilter>,
    signal: AbortSignal | undefined,
    traceFilters?: ReadonlyArray<Filter>,
    traceMetadataColumns?: ReadonlyArray<string>,
    traceOrderBy?: string,
  ): Promise<QueryResultPage> {
    const body: Record<string, unknown> = {
      limit,
      perfetto_sql: query,
      settings: settings.map((s) => ({
        setting_id: s.settingId,
        values: s.values,
        category: s.category,
      })),
    };
    // Top-level structured field — native `Filter[]` JSON array
    // under the strict-native body contract (all three filter sites
    // now share this wire shape after the 2026-06-03 migration).
    // The backend rejects JSON-encoded strings with 400.
    if (traceFilters && traceFilters.length > 0) {
      body.trace_filters = coerceFiltersForWire(traceFilters);
    }
    // Trace-metadata columns to staple onto each result row. Omitted
    // when empty so the legacy `[trace_id, *sql_cols]` shape is
    // preserved for clients that don't opt in.
    if (traceMetadataColumns && traceMetadataColumns.length > 0) {
      body.trace_metadata_columns = [...traceMetadataColumns];
    }
    // AIP-132 ordering string controlling the trace fan-out order.
    // Matters under `trace_limit > 0` — the cap keeps the first N
    // traces in this order. Omitted when empty so the backend picks
    // its deterministic default (`file_path ASC` on the reference).
    if (traceOrderBy && traceOrderBy.length > 0) {
      body.trace_order_by = traceOrderBy;
    }
    const result = await this.requestJson<QueryResponsePayload>(path, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
      signal,
    });
    return parseQueryResponse(result);
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.endpoint}${path}`, {
        credentials: 'include',
        mode: 'cors',
        ...init,
      });
    } catch (e) {
      // AbortSignal → DOMException, surface as our typed error.
      if (e instanceof DOMException && e.name === 'AbortError') {
        throw new QueryCancelledError();
      }
      throw e;
    }
    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => 'Failed to read response body');
      // Surface backend `detail` field; fall back to raw body.
      let detail = errorText;
      try {
        const parsed = JSON.parse(errorText);
        if (typeof parsed?.detail === 'string') {
          detail = parsed.detail;
        }
      } catch {
        // Not JSON — use the body as-is.
      }
      if (response.status === 404) {
        // Extract UUID from /query_executions/{uuid}[:action]; else use path.
        const m = path.match(/\/query_executions\/([^/:?#]+)/);
        throw new QueryNotFoundError(m ? m[1] : path);
      }
      if (response.status === 403) {
        throw new Error(
          `HTTP error! status: ${response.status}, message: ${detail}. ` +
            `This might be an authentication issue. Please ensure you ` +
            `are logged in with the correct credentials.`,
        );
      }
      throw new Error(
        `HTTP error! status: ${response.status}, message: ${detail}`,
      );
    }
    return response;
  }

  private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    return (await response.json()) as T;
  }
}

// Preserves wire strings as-is (no numeric coercion — would corrupt 64-bit
// ids/timestamps). Only translates 'NULL' to JS null.
export function parseQueryResponse(
  result: QueryResponsePayload,
): QueryResultPage {
  const colNames = result.columnNames;
  if (
    colNames === undefined ||
    colNames === null ||
    result.rows === undefined ||
    result.rows === null
  ) {
    return {rows: [], columns: [], queryUuid: result.queryUuid};
  }

  const columns = colNames.filter((h): h is string => h !== null);
  const rows = result.rows.map((row) => {
    const out: DataGridRow = {};
    for (let i = 0; i < colNames.length; i++) {
      const header = colNames[i];
      if (header === null) continue;
      const value = row.values[i];
      out[header] = value === 'NULL' ? null : value;
    }
    return out;
  });
  return {
    rows,
    columns,
    queryUuid: result.queryUuid,
    totalFilteredRows: result.totalFilteredRows,
  };
}
