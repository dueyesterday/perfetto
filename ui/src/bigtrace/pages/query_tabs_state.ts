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

import type {DataSource} from '../../components/widgets/datagrid/data_source';
import type {Filter} from '../../components/widgets/datagrid/model';
import type {Row as DataGridRow} from '../../trace_processor/query_result';
import {debounce} from '../../base/rate_limiters';
import {shortUuid} from '../../base/uuid';
import type {BigtraceQueryClient} from '../query/bigtrace_query_client';
import {queryStore, type QueryExecution} from '../query/query_store';
import {bigTraceSettingsStorage} from '../settings/bigtrace_settings_storage';
import {traceFilterState} from '../settings/trace_filter_state';
import {traceQueryColumnsState} from '../settings/trace_query_columns_state';
import type {SettingFilter} from '../settings/settings_types';

const QUERY_TABS_STORAGE_KEY = 'bigtraceQueryTabs';
const DEFAULT_SQL = '';
const DEFAULT_LIMIT = 100;
const TAB_TITLE_MAX_CHARS = 32;

// First non-empty `--`-stripped line, clipped. `/* */` blocks not handled.
export function deriveTitleFromQuery(sql: string): string | undefined {
  const stripped = sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (stripped.length === 0) return undefined;
  const firstLine = stripped[0];
  if (firstLine.length <= TAB_TITLE_MAX_CHARS) return firstLine;
  return firstLine.slice(0, TAB_TITLE_MAX_CHARS - 1) + '…';
}

// Sync populates rows/columns; async leaves them empty (reads via `tab.dataSource`).
export interface QueryResponse {
  query: string;
  error?: string;
  totalRowCount: number;
  durationMs: number;
  columns: string[];
  rows: DataGridRow[];
  statementCount: number;
  statementWithOutputCount: number;
  lastStatementSql: string;
}

// QueryResponse with sensible defaults; callers spread real values via `partial`.
export function makeQueryResponse(
  query: string,
  partial: Partial<Omit<QueryResponse, 'query' | 'lastStatementSql'>> = {},
): QueryResponse {
  return {
    query,
    lastStatementSql: query,
    statementCount: 1,
    statementWithOutputCount: 0,
    totalRowCount: 0,
    durationMs: 0,
    columns: [],
    rows: [],
    error: undefined,
    ...partial,
  };
}

// Mutated in-place by the runner; only QueryTabsState creates/destroys.
export interface BigTraceEditorTab {
  readonly id: string;
  title: string;
  editorText: string;
  limit: number;
  queryResult?: QueryResponse;
  isLoading: boolean;
  dataSource?: DataSource;
  // Per-tab snapshot — what THIS tab's next Run will ship. Seeded
  // from the global /settings defaults at tab creation; the
  // Settings sub-tab on the Query page mutates these directly.
  // The runner reads them at Run time (no longer pulls from
  // globals), so two tabs can run different snapshots side-by-side.
  // Read back from the backend on history-tab open via the new
  // `/query_executions/{uuid}` snapshot fields.
  querySettings: SettingFilter[];
  traceFilter: Filter[];
  traceMetadataColumns: string[];
  // Which sub-tab the Query page renders for this tab. Defaults
  // to 'query' for both new and historical tabs; the user can flip
  // to 'settings' to inspect / edit the per-tab snapshot.
  activeSubTab: QuerySubTab;
  // Tab-lifetime: every backend request plumbs `signal`; aborts on close.
  readonly lifecycle: AbortController;
  // Per-execute request: Cancel aborts this without tearing down the tab.
  activeRequest?: AbortController;
  queryClient?: BigtraceQueryClient;
  materialize: boolean;
  queryUuid?: string;
  pollInterval?: number;
  lastProcessedRows: number;
  clientStartTime?: number;
  execution?: QueryExecution;
  // Stale-poll guard: bumped on each startPolling() call.
  pollGeneration: number;
  // Active results tab (Table / Error / Chart) — set once the user
  // clicks one, so the choice sticks across redraws. Undefined =
  // auto-select per results_panel.ts.
  resultsTabKey?: string;
}

// Two sub-tabs on the Query page, navigated via the pill row between
// the editor-tabs strip and the Run toolbar.
export type QuerySubTab = 'settings' | 'query';

// Persisted subset of BigTraceEditorTab. Transient state is rebuilt on load.
interface StoredTab {
  readonly id: string;
  readonly title: string;
  readonly editorText: string;
  readonly limit: number;
  readonly materialize: boolean;
  readonly queryUuid?: string;
  readonly error?: string;
  readonly querySettings?: ReadonlyArray<SettingFilter>;
  readonly traceFilter?: ReadonlyArray<Filter>;
  readonly traceMetadataColumns?: ReadonlyArray<string>;
  readonly activeSubTab?: QuerySubTab;
}

interface StoredState {
  readonly tabs: ReadonlyArray<StoredTab>;
  readonly activeTabId?: string;
}

// Survives QueryPage re-mounts so tab layout persists across navigation.
export class QueryTabsState {
  tabs: BigTraceEditorTab[] = [];
  activeTabId = '';

  private tabCounter = 0;
  private readonly debouncedSave = debounce(() => this.saveToStorage(), 1000);

  constructor() {
    if (!this.loadFromStorage()) {
      this.addNewTab(undefined, DEFAULT_SQL);
    }
  }

  markDirty(): void {
    this.debouncedSave();
  }

  getActiveTab(): BigTraceEditorTab | undefined {
    return this.tabs.find((t) => t.id === this.activeTabId);
  }

  // Create and activate. Without `forceNew`, reactivates an existing tab
  // matching by `queryUuid` (preferred) or `initialQuery`.
  addNewTab(
    title?: string,
    initialQuery?: string,
    limit?: number,
    queryUuid?: string,
    materialize?: boolean,
    forceNew?: boolean,
    stored?: Partial<StoredTab>,
  ): BigTraceEditorTab {
    if (!forceNew) {
      const existingTab = this.tabs.find((t) => {
        if (queryUuid && t.queryUuid === queryUuid) return true;
        if (!queryUuid && initialQuery && t.editorText === initialQuery) {
          return true;
        }
        return false;
      });

      if (existingTab) {
        this.activeTabId = existingTab.id;
        this.markDirty();
        return existingTab;
      }
    }

    // Caller title wins; else derive from SQL so History opens have meaningful
    // labels instead of "Query N". maybeAutoNameTab refines on first run.
    const derivedTitle =
      title ?? (initialQuery && deriveTitleFromQuery(initialQuery));
    // Seed per-tab snapshot. For fresh tabs (no `stored`), copy
    // from /settings defaults so the user sees their current
    // defaults reflected in the Settings sub-tab. For
    // restored-from-storage tabs, prefer the persisted snapshot.
    // Historical-tab opens leave the snapshot empty here; the
    // runner's resumeFromHistory rehydrates from the backend.
    const isFromStorage = stored !== undefined;
    const isFromHistory = queryUuid !== undefined && !isFromStorage;
    const querySettings: SettingFilter[] = isFromStorage
      ? [...(stored?.querySettings ?? [])]
      : isFromHistory
        ? []
        : [...bigTraceSettingsStorage.buildSettingFilters()];
    const traceFilter: Filter[] = isFromStorage
      ? [...(stored?.traceFilter ?? [])]
      : isFromHistory
        ? []
        : [...traceFilterState.get()];
    const traceMetadataColumns: string[] = isFromStorage
      ? [...(stored?.traceMetadataColumns ?? [])]
      : isFromHistory
        ? []
        : [...traceQueryColumnsState.get()];
    const tab: BigTraceEditorTab = {
      id: shortUuid(),
      title: derivedTitle || this.nextTabName(),
      editorText: initialQuery ?? '',
      limit: limit ?? DEFAULT_LIMIT,
      queryResult: undefined,
      isLoading: false,
      dataSource: undefined,
      querySettings,
      traceFilter,
      traceMetadataColumns,
      // Both new and historical tabs default to the Query sub-tab —
      // simpler one-rule model (per design choice Q3). Users open
      // the Settings sub-tab on demand to inspect / edit.
      activeSubTab: stored?.activeSubTab ?? 'query',
      lifecycle: new AbortController(),
      activeRequest: undefined,
      // History-reopen → Persistent; new tab → sync; caller overrides.
      materialize: materialize ?? Boolean(queryUuid),
      lastProcessedRows: 0,
      queryUuid,
      pollGeneration: 0,
    };
    tab.execution = queryStore.getOrCreate(queryUuid || tab.id, {
      materialized: tab.materialize,
    });
    this.tabs.push(tab);
    this.activeTabId = tab.id;
    this.markDirty();
    return tab;
  }

  closeTab(tabId: string): void {
    if (this.tabs.length <= 1) return;
    const index = this.tabs.findIndex((t) => t.id === tabId);
    if (index === -1) return;
    const tabToClose = this.tabs[index];
    if (tabToClose.pollInterval !== undefined) {
      window.clearTimeout(tabToClose.pollInterval);
      tabToClose.pollInterval = undefined;
    }
    // Aborts execute_* and any one-off request holding `lifecycle.signal`.
    tabToClose.activeRequest?.abort();
    tabToClose.lifecycle.abort();
    this.tabs.splice(index, 1);
    if (this.activeTabId === tabId) {
      const newIndex = Math.min(index, this.tabs.length - 1);
      this.activeTabId = this.tabs[newIndex].id;
    }
    this.markDirty();
  }

  renameTab(tabId: string, newTitle: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (tab) {
      tab.title = newTitle;
      this.markDirty();
    }
  }

  // Replace "Query N" with a SQL-derived title before submit;
  // user-renamed tabs are skipped.
  maybeAutoNameTab(tabId: string, queryText: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (!/^Query \d+$/.test(tab.title)) return;
    const derived = deriveTitleFromQuery(queryText);
    if (derived === undefined) return;
    tab.title = derived;
    this.markDirty();
  }

  reorderTab(draggedId: string, beforeId: string | undefined): void {
    const draggedIndex = this.tabs.findIndex((t) => t.id === draggedId);
    if (draggedIndex === -1) return;
    const [dragged] = this.tabs.splice(draggedIndex, 1);
    if (beforeId === undefined) {
      this.tabs.push(dragged);
      return;
    }
    const beforeIndex = this.tabs.findIndex((t) => t.id === beforeId);
    if (beforeIndex === -1) {
      this.tabs.push(dragged);
    } else {
      this.tabs.splice(beforeIndex, 0, dragged);
    }
  }

  // ----- Persistence -----

  private saveToStorage(): void {
    const state: StoredState = {
      tabs: this.tabs.map((t) => ({
        id: t.id,
        title: t.title,
        editorText: t.editorText,
        limit: t.limit,
        materialize: t.materialize,
        queryUuid: t.queryUuid,
        error: t.queryResult?.error,
        // Persist the per-tab snapshot so user edits to the
        // Settings sub-tab survive reloads. Restored on the next
        // session via the `stored` arg on addNewTab.
        querySettings: t.querySettings,
        traceFilter: t.traceFilter,
        traceMetadataColumns: t.traceMetadataColumns,
        activeSubTab: t.activeSubTab,
      })),
      activeTabId: this.activeTabId,
    };
    localStorage.setItem(QUERY_TABS_STORAGE_KEY, JSON.stringify(state));
  }

  private loadFromStorage(): boolean {
    const stored = localStorage.getItem(QUERY_TABS_STORAGE_KEY);
    if (!stored) return false;
    let parsed: StoredState;
    try {
      parsed = JSON.parse(stored) as StoredState;
    } catch {
      return false;
    }
    if (!Array.isArray(parsed.tabs) || parsed.tabs.length === 0) return false;

    for (const t of parsed.tabs) {
      const tab = this.addNewTab(
        t.title,
        t.editorText,
        t.limit,
        t.queryUuid,
        t.materialize,
        /* forceNew */ false,
        t,
      );
      if (t.error !== undefined && t.error !== '') {
        tab.queryResult = makeQueryResponse(tab.editorText, {error: t.error});
      }
    }
    if (typeof parsed.activeTabId === 'string') {
      const found = this.tabs.find((t) => t.id === parsed.activeTabId);
      if (!found) {
        // Restored tabs get new IDs, so activate by index instead.
        const idx = parsed.tabs.findIndex((t) => t.id === parsed.activeTabId);
        if (idx >= 0 && idx < this.tabs.length) {
          this.activeTabId = this.tabs[idx].id;
        }
      }
    }
    return true;
  }

  private nextTabName(): string {
    const existingNames = new Set(this.tabs.map((t) => t.title));
    let count = ++this.tabCounter;
    while (existingNames.has(`Query ${count}`)) {
      count = ++this.tabCounter;
    }
    return `Query ${count}`;
  }
}
