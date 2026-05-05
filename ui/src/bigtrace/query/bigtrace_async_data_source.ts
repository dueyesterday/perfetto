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

import {
  DataSource,
  DataSourceModel,
  DataSourceRows,
} from '../../components/widgets/datagrid/data_source';
import {Row, SqlValue} from '../../trace_processor/query_result';
import {QueryResult} from '../../base/query_slot';
import {
  BigtraceQueryClient,
  QueryCancelledError,
} from './bigtrace_query_client';
import m from 'mithril';

type ModelWithColumns = DataSourceModel & {
  columns?: Array<{field: string; alias?: string}>;
};

/**
 * `DataSource` adapter that pages a query's materialized result table
 * through `BigtraceQueryClient.fetchResults`.
 *
 * Sorting contract
 * ----------------
 * The DataGrid widget expresses single-column sort via `model.sort =
 * {alias, direction}` (alias = the column's `id`). We translate that
 * into an [AIP-132 §Ordering](https://google.aip.dev/132#ordering)
 * `order_by` string of the form `"<field> asc|desc"` and append it to
 * the next `:fetch_results` URL.
 *
 * - The widget's `alias` is resolved back to the original SELECT
 *   `field` via the `model.columns` mapping, because the backend's
 *   column whitelist is on field names (not aliases).
 * - When the sort spec changes, we refetch the user's *current page*
 *   using `getCurrentOffset()` and `getPageSize()` — these report the
 *   BigTrace tab's pagination state (driven by the toolbar Prev/Next
 *   buttons), which is what the user actually sees. We deliberately
 *   do NOT use `model.pagination`; that's the DataGrid widget's
 *   internal virtualization offset, which is independent and
 *   typically stays at 0. Sorting and pagination are orthogonal —
 *   matching the in-tree `InMemoryDataSource` and the mainstream
 *   data-grid convention. Page 3 + click `id asc` → third-page slice
 *   of the new ordering, not the first slice.
 * - Empty / absent sort → no `order_by` is sent; backend returns rows
 *   in materialization order (worker insertion order). The widget
 *   does not push down multi-column sort today; the data source's
 *   serialization layer is intentionally limited to one field to
 *   match.
 */
export class BigtraceAsyncDataSource implements DataSource {
  private loadedRows: Row[] = [];
  private isFetching = false;
  private columns: string[] = [];
  private error: string | null = null;
  private hasInitialFetchCompleted = false;
  // AIP-132 §Ordering string ("name desc, dur asc"). Empty = backend
  // returns rows in materialization order (worker insertion order).
  // Tracked here so `useRows` can detect when the widget's sort spec
  // changes and trigger a refetch from offset 0.
  private currentOrderBy = '';

  // The signal is plumbed through to every fetchResults call. Owners
  // (typically a tab) abort it on close so we don't write into a destroyed
  // data source.
  //
  // `getCurrentOffset` reports the tab's current page offset (the
  // value the BigTrace toolbar's Prev/Next buttons drive — NOT the
  // DataGrid widget's internal virtualization offset, which lives
  // separately on `model.pagination` and stays at 0 here). We need
  // it on sort changes to refetch the user's current page with the
  // new ordering instead of resetting to the top.
  constructor(
    private readonly queryUuid: string,
    private readonly queryClient: BigtraceQueryClient,
    private readonly getPageSize: () => number,
    private readonly getCurrentOffset: () => number,
    private readonly signal?: AbortSignal,
  ) {
    // Trigger initial fetch to get schema and first batch of data
    this.fetchMoreRows(0, this.getPageSize());
  }

  useRows(_model: DataSourceModel): DataSourceRows {
    const model = _model as ModelWithColumns;

    // Detect sort changes from the widget. When the user clicks a
    // column header, the DataGrid updates `model.sort` and re-renders.
    // We translate that into an AIP-132 order_by string, and if it
    // differs from what's currently loaded, refetch the user's
    // current page with the new ordering applied at the backend.
    //
    // We keep the user on the same page (rather than resetting to
    // page 1) to match the in-tree `InMemoryDataSource` convention
    // and the broader data-grid norm: sort and pagination are
    // orthogonal — clicking a header rearranges the data without
    // jumping the user away from where they were.
    const wantedOrderBy = this.formatOrderBy(model);
    if (
      wantedOrderBy !== this.currentOrderBy &&
      this.hasInitialFetchCompleted &&
      !this.isFetching
    ) {
      this.currentOrderBy = wantedOrderBy;
      // Refetch the tab's current page with the new ordering. We use
      // the tab's pagination state (driven by the BigTrace toolbar),
      // NOT `model.pagination` (the DataGrid widget's virtualization
      // offset, which is independent and typically stays at 0).
      this.fetchMoreRows(this.getCurrentOffset(), this.getPageSize());
    }

    // Map rows to aliases on the fly!
    const mappedRows = this.loadedRows.map((row) => {
      const mappedRow: Row = {};
      for (const key in row) {
        if (Object.prototype.hasOwnProperty.call(row, key)) {
          const col = model.columns?.find((c) => c.field === key);
          const alias =
            col !== undefined && col.alias !== undefined ? col.alias : key;
          mappedRow[alias] = row[key];
        }
      }
      return mappedRow;
    });

    const isPending = this.isFetching;

    return {
      rows: mappedRows,
      totalRows: this.loadedRows.length,
      rowOffset: 0,
      isPending: isPending,
    };
  }

  // The widget's sort spec is alias-based; the backend's materialized
  // table uses the original SELECT field names. Resolve alias → field
  // before serializing so the column whitelist on the backend matches.
  private formatOrderBy(model: ModelWithColumns): string {
    const sort = model.sort;
    if (!sort) return '';
    const col = model.columns?.find((c) => c.alias === sort.alias);
    const field = col?.field ?? sort.alias;
    return `${field} ${sort.direction.toLowerCase()}`;
  }

  triggerFetch(offset: number, limit: number) {
    if (offset === 0) {
      // For first page refresh, we clear the first page rows to force reload
      for (let i = 0; i < limit; i++) {
        delete this.loadedRows[i];
      }
    }
    this.fetchMoreRows(offset, limit);
  }

  private async fetchMoreRows(offset: number, limit: number) {
    if (this.signal?.aborted) return;
    this.error = null;
    this.isFetching = true;
    m.redraw();
    try {
      const result = await this.queryClient.fetchResults(
        this.queryUuid,
        limit,
        offset,
        this.signal,
        this.currentOrderBy,
      );
      this.loadedRows = [...result.rows];
      this.hasInitialFetchCompleted = true;

      if (this.columns.length === 0 && result.columns.length > 0) {
        this.columns = [...result.columns];
      }
    } catch (e) {
      // Abort is expected when the owning tab closes; don't surface it.
      if (e instanceof QueryCancelledError) return;
      console.error('Failed to fetch more rows:', e);
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.isFetching = false;
      m.redraw();
    }
  }

  async ensureResultsLoaded(tab: {pageSize: number}): Promise<void> {
    if (this.hasInitialFetchCompleted) {
      return;
    }
    await this.fetchMoreRows(0, tab.pageSize);
  }

  async refresh(tab: {pageSize: number; currentOffset: number}): Promise<void> {
    if (this.isFetching) {
      return;
    }
    await this.fetchMoreRows(tab.currentOffset, tab.pageSize);
  }

  getError(): string | null {
    return this.error;
  }

  getColumns(): string[] {
    return this.columns;
  }

  useAggregateSummaries(_model: DataSourceModel): QueryResult<Row> {
    return {data: undefined, isPending: false, isFresh: true};
  }

  useDistinctValues(
    _column: string | undefined,
  ): QueryResult<readonly SqlValue[]> {
    return {data: undefined, isPending: false, isFresh: true};
  }

  useParameterKeys(
    _prefix: string | undefined,
  ): QueryResult<readonly string[]> {
    return {data: undefined, isPending: false, isFresh: true};
  }

  async exportData(_model: DataSourceModel): Promise<readonly Row[]> {
    return this.loadedRows;
  }
}
