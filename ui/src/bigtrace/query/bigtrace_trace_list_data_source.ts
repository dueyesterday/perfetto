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

import type {
  DataSource,
  DataSourceModel,
  DataSourceRows,
} from '../../components/widgets/datagrid/data_source';
import type {Filter} from '../../components/widgets/datagrid/model';
import type {Row, SqlValue} from '../../trace_processor/query_result';
import type {QueryResult} from '../../base/query_slot';
import type {SettingFilter} from '../settings/settings_types';
import {
  type BigtraceQueryClient,
  QueryCancelledError,
} from './bigtrace_query_client';
import {encodeFilters} from './filter_encoding';
import m from 'mithril';

// Pivot/tree models don't expose `columns`; only FlatModel does. Use
// a structural type so we can read it without `any` casts.
type ModelWithColumns = DataSourceModel & {
  readonly columns?: ReadonlyArray<{readonly field: string}>;
};

// DataSource adapter paging `/trace_metadata` into the DataGrid widget.
// Sibling of `BigtraceAsyncDataSource`: same fetch / sort / filter /
// pagination interaction model, but pointed at the trace-metadata
// endpoint instead of a query's materialized result table. Embedded
// in the BigTrace UI's Settings page below the TRACE_ADDRESS section
// so the user can choose which traces a query will run over by
// filtering this grid.
export class BigtraceTraceListDataSource implements DataSource {
  private loadedRows: Row[] = [];
  private isFetching = false;
  private columns: string[] = [];
  private error: string | null = null;
  private hasInitialFetchCompleted = false;
  // Window in `loadedRows`, for range-change detection.
  private loadedOffset = 0;
  private loadedLimit = 0;
  // AIP-132 §Ordering. Empty = enumeration order (file_path ASC from
  // the backend).
  private currentOrderBy = '';
  // Filter state mirrors `BigtraceAsyncDataSource`: `currentFilter` is
  // the resolved Filter[] (no alias remap needed — we don't alias
  // trace-list columns); `currentFilterKey` is the JSON form for cheap
  // equality checks.
  private currentFilter: ReadonlyArray<Filter> = [];
  private currentFilterKey = '';
  // The same scrollbar-sizing trick as the async data source.
  private _filteredTotalRows: number | undefined;
  // Settings serialization at the time of the last fetch. A change
  // (e.g. user retypes trace_directory) invalidates the previous
  // result and triggers a refetch on the next render.
  private lastSettingsKey = '';
  // Visible-columns projection at the time of the last fetch. Used
  // both for change detection (toggling a column re-fetches with a
  // narrower body) and to ship `columns: [...]` on the next request.
  private currentColumns: readonly string[] = [];
  private currentColumnsKey = '';

  get filteredTotalRows(): number | undefined {
    return this._filteredTotalRows;
  }

  // `getSettings` is a function rather than a value so the Settings
  // page can pass `() => bigTraceSettingsStorage.buildSettingFilters()`
  // and have us re-read on every render — same pattern as
  // `BigtraceAsyncDataSource.getTotalRows`.
  constructor(
    private readonly queryClient: BigtraceQueryClient,
    private readonly getSettings: () => ReadonlyArray<SettingFilter>,
    private readonly signal?: AbortSignal,
  ) {}

  useRows(model: DataSourceModel): DataSourceRows {
    const wantedOrderBy = this.formatOrderBy(model);
    const wantedFilter = model.filters ?? [];
    const wantedFilterKey = encodeFilters(wantedFilter);
    const wantedOffset = model.pagination?.offset ?? 0;
    const wantedLimit = model.pagination?.limit ?? 0;
    const wantedSettings = this.getSettings();
    const wantedSettingsKey = JSON.stringify(wantedSettings);
    // FlatModel exposes `columns` (the field-mask the grid currently
    // displays). Pivot / tree models don't carry one — in those modes
    // we just don't ship a projection (server returns all defaults).
    const wantedColumns =
      (model as ModelWithColumns).columns?.map((c) => c.field) ?? [];
    const wantedColumnsKey = JSON.stringify(wantedColumns);

    const sortChanged = wantedOrderBy !== this.currentOrderBy;
    const filterChanged = wantedFilterKey !== this.currentFilterKey;
    const rangeChanged =
      this.hasInitialFetchCompleted &&
      (wantedOffset !== this.loadedOffset ||
        (wantedLimit > 0 && wantedLimit !== this.loadedLimit));
    const settingsChanged =
      this.hasInitialFetchCompleted &&
      wantedSettingsKey !== this.lastSettingsKey;
    const columnsChanged =
      this.hasInitialFetchCompleted &&
      wantedColumnsKey !== this.currentColumnsKey;
    const needsInitial = !this.hasInitialFetchCompleted && wantedLimit > 0;
    if (
      (sortChanged ||
        filterChanged ||
        rangeChanged ||
        settingsChanged ||
        columnsChanged ||
        needsInitial) &&
      !this.isFetching
    ) {
      this.currentOrderBy = wantedOrderBy;
      if (filterChanged) {
        this.currentFilter = wantedFilter;
        this.currentFilterKey = wantedFilterKey;
        this._filteredTotalRows = undefined;
      }
      this.currentColumns = wantedColumns;
      this.currentColumnsKey = wantedColumnsKey;
      const fetchLimit = wantedLimit > 0 ? wantedLimit : 100;
      this.fetchWindow(wantedOffset, fetchLimit, wantedSettings);
    }

    return {
      rows: this.loadedRows,
      totalRows: this._filteredTotalRows,
      rowOffset: this.loadedOffset,
      isPending: this.isFetching,
    };
  }

  private formatOrderBy(model: DataSourceModel): string {
    const sort = model.sort;
    if (!sort) return '';
    // Trace-list columns aren't aliased — the grid binds `field === alias`
    // so we don't need the alias→field resolution that
    // BigtraceAsyncDataSource does.
    return `${sort.alias} ${sort.direction.toLowerCase()}`;
  }

  // Re-fetch the currently-loaded window with the latest settings.
  // Called by the Settings page when the user edits a setting (e.g.
  // trace_directory) without changing the grid model, so the
  // useRows-based change detection alone wouldn't catch it.
  async refresh(): Promise<void> {
    if (this.isFetching) return;
    const offset = this.loadedOffset;
    const limit = this.loadedLimit > 0 ? this.loadedLimit : 100;
    await this.fetchWindow(offset, limit, this.getSettings());
  }

  private async fetchWindow(
    offset: number,
    limit: number,
    settings: ReadonlyArray<SettingFilter>,
  ): Promise<void> {
    if (this.signal?.aborted) return;
    this.error = null;
    this.isFetching = true;
    this.lastSettingsKey = JSON.stringify(settings);
    const filterLog =
      this.currentFilterKey.length > 80
        ? this.currentFilterKey.slice(0, 77) + '...'
        : this.currentFilterKey;
    console.log(
      `[bigtrace] list_traces offset=${offset} limit=${limit} ` +
        `order_by=${JSON.stringify(this.currentOrderBy)} filter=${filterLog}`,
    );
    m.redraw();
    try {
      const result = await this.queryClient.listTraceMetadata(
        settings,
        limit,
        offset,
        this.signal,
        this.currentOrderBy,
        this.currentFilter,
        // Empty projection → omit from wire (backend returns its
        // schema defaults). Non-empty → ship verbatim.
        this.currentColumns.length > 0 ? this.currentColumns : undefined,
      );
      this.loadedRows = [...result.rows];
      this.loadedOffset = offset;
      this.loadedLimit = limit;
      this._filteredTotalRows = result.totalFilteredRows;
      if (result.columns.length > 0) {
        this.columns = [...result.columns];
      }
    } catch (e) {
      if (e instanceof QueryCancelledError) return;
      console.error('[bigtrace] list_traces failed:', e);
      this.error = e instanceof Error ? e.message : String(e);
      // A 400 from trace_directory missing/unreadable is the common
      // case while the user is typing — null out the rows so the
      // grid doesn't keep showing stale matches for a stale dir.
      this.loadedRows = [];
      this._filteredTotalRows = 0;
    } finally {
      // Flip the "first shot was taken" flag regardless of
      // success/failure. Reason: the BigTrace UI's first /trace_metadata
      // call typically lands while trace_directory is still empty
      // (settings page just loaded), so it 400s. If we only flipped
      // this on success we'd both (a) re-trigger an identical 400
      // every render until the user types a path, and (b) never run
      // the settings-changed branch when they finally do — because
      // settingsChanged is gated on this flag. Setting it here means
      // subsequent renders with a new trace_directory hit
      // settingsChanged and refetch correctly.
      this.hasInitialFetchCompleted = true;
      this.isFetching = false;
      m.redraw();
    }
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
    // Same rationale as BigtraceAsyncDataSource: an empty data
    // (rather than undefined) keeps the column-filter "Equals" submenu
    // from sticking on "Loading…" forever. Cell-context-menu
    // filtering still works.
    return {data: [], isPending: false, isFresh: true};
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
