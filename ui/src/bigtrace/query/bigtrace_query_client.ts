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
  // Full union of (result-table cols ∪ sidecar metadata cols), surfaced on
  // `:fetch_results` so the results column picker can offer sidecar columns
  // even when the current projection omits them. Undefined elsewhere.
  availableColumnNames?: string[];
}

export interface QueryResultPage {
  readonly rows: ReadonlyArray<DataGridRow>;
  readonly columns: ReadonlyArray<string>;
  readonly queryUuid?: string;
  // Post-filter count from `:fetch_results`; undefined elsewhere.
  readonly totalFilteredRows?: number;
  // Full schema returned by `:fetch_results` (result + sidecar); undefined
  // on every other endpoint.
  readonly availableColumnNames?: ReadonlyArray<string>;
}

// One column the `/trace_metadata` endpoint can return for the current trace
// source. `defaultVisible` flags the columns the grid shows on first render;
// `type` is informational (the wire is always-strings).
export interface TraceColumnDescriptor {
  readonly name: string;
  readonly type: string;
  readonly defaultVisible: boolean;
  readonly description?: string;
}

// `/trace_metadata_schema` response: the column catalog for the trace-list
// grid + the column-picker widget.
export interface TracesSchemaResponse {
  readonly columns: ReadonlyArray<TraceColumnDescriptor>;
}

// The submit-time trace-selection snapshot shipped as top-level fields on
// /execute_*. Each is omitted from the wire when empty / default, so a query
// run with no trace selection keeps the legacy request shape.
export interface ExecuteOptions {
  // Structured filter picking which traces the query runs over. Shipped as a
  // native JSON array (strict-native body contract) via coerceFiltersForWire.
  readonly traceFilters?: ReadonlyArray<Filter>;
  // Trace-metadata columns to staple onto each result row.
  readonly traceMetadataColumns?: ReadonlyArray<string>;
  // AIP-132 ordering controlling the trace processing order.
  readonly traceOrderBy?: string;
  // Non-negative cap on traces fanned out; 0 / undefined means no cap.
  readonly traceLimit?: number;
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
    options?: ExecuteOptions,
  ): Promise<QueryResultPage> {
    return this.executeAt(
      '/execute_bigtrace_query',
      query,
      limit,
      settings,
      signal,
      options,
    );
  }

  async executeAsync(
    query: string,
    limit: number,
    settings: ReadonlyArray<SettingFilter>,
    signal?: AbortSignal,
    options?: ExecuteOptions,
  ): Promise<QueryResultPage> {
    return this.executeAt(
      '/execute_bigtrace_query_async',
      query,
      limit,
      settings,
      signal,
      options,
    );
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

  // Page the materialized table. POST body carries `limit`/`offset` plus the
  // optional `order_by` (AIP-132), `filters` (native Filter[] under the
  // strict-native contract), and `columns` field-mask projecting the union of
  // (result cols ∪ sidecar metadata cols). The response echoes the full union
  // as `availableColumnNames` so the results column picker can offer sidecar
  // columns. Mid-flight calls return whatever rows have merged.
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
    // `availableColumnNames` is `:fetch_results`-only by spec — `/trace_metadata`
    // mustn't echo a column catalog (`/trace_metadata_schema` is its source of
    // truth), so the parser stays endpoint-agnostic and only this call site
    // exposes the field.
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

  // Paginated trace metadata for the current trace source — the data behind
  // the Settings-page trace-selection grid. `filter` / `order_by` / `columns`
  // mirror `:fetch_results`; `filter` ships as a native JSON array under the
  // strict-native body contract (NOT a JSON-encoded string).
  async listTraceMetadata(
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
      body.filters = coerceFiltersForWire(filter);
    }
    if (columns && columns.length > 0) {
      body.columns = [...columns];
    }
    const result = await this.requestJson<QueryResponsePayload>(
      '/trace_metadata',
      {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
        signal,
      },
    );
    return parseQueryResponse(result);
  }

  // Column catalog for `/trace_metadata`, fetched once on Settings-page load
  // to build the grid's schema + the column-picker. `settings` lets a
  // schema-varies-by-source backend tailor the response.
  async listTraceMetadataSchema(
    settings: ReadonlyArray<SettingFilter>,
    signal?: AbortSignal,
  ): Promise<TracesSchemaResponse> {
    return this.requestJson<TracesSchemaResponse>('/trace_metadata_schema', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        settings: settings.map((s) => ({
          setting_id: s.settingId,
          values: s.values,
          category: s.category,
        })),
      }),
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
    options?: ExecuteOptions,
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
    // Each trace-selection field rides only when non-default, so a query with
    // no selection keeps the legacy request shape.
    if (options?.traceFilters && options.traceFilters.length > 0) {
      body.trace_filters = coerceFiltersForWire(options.traceFilters);
    }
    if (
      options?.traceMetadataColumns &&
      options.traceMetadataColumns.length > 0
    ) {
      body.trace_metadata_columns = [...options.traceMetadataColumns];
    }
    if (options?.traceOrderBy && options.traceOrderBy.length > 0) {
      body.trace_order_by = options.traceOrderBy;
    }
    if (options?.traceLimit !== undefined && options.traceLimit > 0) {
      body.trace_limit = options.traceLimit;
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
