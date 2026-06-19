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

// Pivot / tree models don't expose `columns`; only the flat model does. Read
// it through a structural type to avoid an `any` cast.
type ModelWithColumns = DataSourceModel & {
  readonly columns?: ReadonlyArray<{readonly field: string}>;
};

// Only TRACE_ADDRESS settings change which traces exist, so the grid refetches
// on those alone — editing another setting leaves the trace set unchanged. The
// full settings array is still sent on each fetch; this only narrows change
// detection.
function traceSourceSettingsKey(
  settings: ReadonlyArray<SettingFilter>,
): string {
  return JSON.stringify(settings.filter((s) => s.category === 'TRACE_ADDRESS'));
}

// One cached /trace_metadata window: the rows, the post-filter total, and the
// column set the backend returned for that exact request.
interface CachedTraceWindow {
  readonly rows: Row[];
  readonly total: number | undefined;
  readonly cols: string[];
}

// Response cache shared across all data-source instances, keyed by the whole
// /trace_metadata request (see `requestKey`). Mithril destroys and rebuilds the
// Settings page on every navigation / modal open, resetting a data source's
// instance fields — without this, the grid would re-hit the backend on each
// visit. Trace metadata is effectively static between visits, so a remount
// serves the same window from here, synchronously, with no blink. The Refresh
// button forces past it (and refreshes the entry).
const traceMetadataResponseCache = new Map<string, CachedTraceWindow>();

// Bound the cache so a long session of source / filter / sort edits can't grow
// it without limit. Distinct request shapes are few in practice, so this is a
// safety ceiling; the oldest entry is evicted once past it.
const MAX_CACHED_WINDOWS = 32;

// Test hook: instances share the module-level cache above, so a test that left
// an entry behind would leak rows into the next. Cleared in `beforeEach`.
export function clearTraceMetadataResponseCache(): void {
  traceMetadataResponseCache.clear();
}

// DataSource adapter paging `/trace_metadata` into the DataGrid widget — the
// sibling of `BigtraceAsyncDataSource`. Same sort / filter / pagination model,
// but pointed at /trace_metadata instead of a query's results, and re-reading
// the current settings (which carry the trace source) on every fetch.
export class BigtraceTraceListDataSource implements DataSource {
  private loadedRows: Row[] = [];
  private isFetching = false;
  private columns: string[] = [];
  private error: string | null = null;
  private hasInitialFetchCompleted = false;
  // Window in `loadedRows`, for range-change detection.
  private loadedOffset = 0;
  private loadedLimit = 0;
  // AIP-132 §Ordering. Empty = backend enumeration order.
  private currentOrderBy = '';
  // `currentFilterKey` is the JSON form for cheap equality checks. No alias
  // remap: trace-list columns bind `field === alias`.
  private currentFilter: ReadonlyArray<Filter> = [];
  private currentFilterKey = '';
  private _filteredTotalRows: number | undefined;
  // Settings key at the last fetch. A change (e.g. editing the trace source)
  // invalidates the previous result.
  private lastSettingsKey = '';
  // Visible-column projection at the last fetch — both a change trigger and
  // the `columns` field-mask shipped on the next request.
  private currentColumns: readonly string[] = [];
  private currentColumnsKey = '';

  get filteredTotalRows(): number | undefined {
    return this._filteredTotalRows;
  }

  // `getSettings` is a thunk so the Settings page can pass
  // `() => bigTraceSettingsStorage.buildSettingFilters()` and have us re-read
  // it on every render — mirrors `BigtraceAsyncDataSource.getTotalRows`.
  // `onOrderByChange` fires on grid sort change, letting the owner persist the
  // processing order (the snapshot's `trace_order_by`).
  constructor(
    private readonly queryClient: BigtraceQueryClient,
    private readonly getSettings: () => ReadonlyArray<SettingFilter>,
    private readonly signal?: AbortSignal,
    private readonly onOrderByChange?: (orderBy: string) => void,
    // Distinguishes cache entries across backends; '' for tests that don't care.
    private readonly endpoint: string = '',
  ) {}

  useRows(model: DataSourceModel): DataSourceRows {
    const wantedOrderBy = this.formatOrderBy(model);
    const wantedFilter = model.filters ?? [];
    const wantedFilterKey = encodeFilters(wantedFilter);
    const wantedOffset = model.pagination?.offset ?? 0;
    const wantedLimit = model.pagination?.limit ?? 0;
    const wantedSettings = this.getSettings();
    const wantedSettingsKey = traceSourceSettingsKey(wantedSettings);
    // Flat model carries the visible-column field-mask; pivot / tree models
    // don't — those ship no projection, so the server returns defaults.
    const wantedColumns =
      (model as ModelWithColumns).columns?.map((c) => c.field) ?? [];
    const wantedColumnsKey = JSON.stringify(wantedColumns);

    const sortChanged = wantedOrderBy !== this.currentOrderBy;
    const filterChanged = wantedFilterKey !== this.currentFilterKey;
    // The grid re-requests its window on every (re)mount and as it measures its
    // viewport, so refetch only when the wanted window reaches OUTSIDE what's
    // already loaded. A narrower or equal window is served from the cached rows
    // — trace metadata is static, so there's no value in a roundtrip for data we
    // already hold (this is what stops the refetch on every settings visit).
    const loadedEnd = this.loadedOffset + this.loadedLimit;
    const wantedEnd = wantedLimit > 0 ? wantedOffset + wantedLimit : loadedEnd;
    const rangeChanged =
      this.hasInitialFetchCompleted &&
      (wantedOffset < this.loadedOffset || wantedEnd > loadedEnd);
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
      // Persist on a real sort change (not the initial fetch, where
      // wantedOrderBy is still '').
      if (sortChanged) {
        this.onOrderByChange?.(wantedOrderBy);
      }
      if (filterChanged) {
        this.currentFilter = wantedFilter;
        this.currentFilterKey = wantedFilterKey;
        // Briefly oversized scrollbar beats briefly collapsed while refetching.
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

  // Trace-list columns aren't aliased (grid binds `field === alias`), so no
  // alias→field resolution (unlike BigtraceAsyncDataSource).
  private formatOrderBy(model: DataSourceModel): string {
    const sort = model.sort;
    if (!sort) return '';
    return `${sort.alias} ${sort.direction.toLowerCase()}`;
  }

  // Re-fetch the current window with the latest settings. Called by the
  // Settings page when a setting edit doesn't change the grid model, so
  // useRows change-detection wouldn't catch it. Forces past the response cache.
  async refresh(): Promise<void> {
    if (this.isFetching) return;
    const offset = this.loadedOffset;
    const limit = this.loadedLimit > 0 ? this.loadedLimit : 100;
    await this.fetchWindow(offset, limit, this.getSettings(), true);
  }

  // Cache key for one window: every input that changes the rows the backend
  // returns — backend, trace source, order, filter, projection, and the window
  // itself. Two requests with the same key get the same rows.
  private requestKey(
    settings: ReadonlyArray<SettingFilter>,
    offset: number,
    limit: number,
  ): string {
    return JSON.stringify([
      this.endpoint,
      traceSourceSettingsKey(settings),
      this.currentOrderBy,
      this.currentFilterKey,
      this.currentColumnsKey,
      offset,
      limit,
    ]);
  }

  private async fetchWindow(
    offset: number,
    limit: number,
    settings: ReadonlyArray<SettingFilter>,
    force = false,
  ): Promise<void> {
    if (this.signal?.aborted) return;
    const key = this.requestKey(settings, offset, limit);
    // Serve a cached window synchronously. This runs in fetchWindow's sync
    // prefix (before any await), so the loadedRows assignment lands before the
    // calling useRows() returns — even on a freshly-remounted data source: no
    // network, no isFetching flip, no blink. Refresh sets `force` to bypass.
    if (!force) {
      const cached = traceMetadataResponseCache.get(key);
      if (cached !== undefined) {
        traceMetadataResponseCache.delete(key);
        traceMetadataResponseCache.set(key, cached); // mark most-recently-used
        this.error = null;
        this.loadedRows = cached.rows;
        this.loadedOffset = offset;
        this.loadedLimit = limit;
        this._filteredTotalRows = cached.total;
        if (cached.cols.length > 0) this.columns = cached.cols;
        this.lastSettingsKey = traceSourceSettingsKey(settings);
        this.hasInitialFetchCompleted = true;
        return;
      }
    }
    this.error = null;
    this.isFetching = true;
    this.lastSettingsKey = traceSourceSettingsKey(settings);
    m.redraw();
    try {
      const result = await this.queryClient.listTraceMetadata(
        settings,
        limit,
        offset,
        this.signal,
        this.currentOrderBy,
        this.currentFilter,
        // Empty projection → omit (backend returns its schema defaults).
        this.currentColumns.length > 0 ? this.currentColumns : undefined,
      );
      this.loadedRows = [...result.rows];
      this.loadedOffset = offset;
      this.loadedLimit = limit;
      this._filteredTotalRows = result.totalFilteredRows;
      if (result.columns.length > 0) {
        this.columns = [...result.columns];
      }
      // Cache the window (also on the force path, so Refresh updates it).
      traceMetadataResponseCache.delete(key);
      traceMetadataResponseCache.set(key, {
        rows: this.loadedRows,
        total: this._filteredTotalRows,
        cols: this.columns,
      });
      if (traceMetadataResponseCache.size > MAX_CACHED_WINDOWS) {
        const lru = traceMetadataResponseCache.keys().next().value;
        if (lru !== undefined) traceMetadataResponseCache.delete(lru);
      }
    } catch (e) {
      if (e instanceof QueryCancelledError) return;
      console.error('[bigtrace] trace_metadata failed:', e);
      this.error = e instanceof Error ? e.message : String(e);
      // A 400 while the trace source is unset/unreadable is the common case
      // mid-edit — drop the rows so the grid doesn't show stale matches.
      this.loadedRows = [];
      this._filteredTotalRows = 0;
    } finally {
      // Flip the flag regardless of success/failure: the first fetch often
      // 400s while the trace source is still empty. Flipping only on success
      // would re-trigger that 400 every render and gate out the
      // settings-changed branch when the user finally sets the source.
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
    // `data: []` (not undefined) keeps the column-filter "Equals" submenu from
    // sticking on "Loading…"; cell-context-menu filtering still works.
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
