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

import {DataSource} from '../../components/widgets/datagrid/data_source';
import {Row as DataGridRow} from '../../trace_processor/query_result';
import {debounce} from '../../base/rate_limiters';
import {shortUuid} from '../../base/uuid';
import {BigtraceQueryClient} from '../query/bigtrace_query_client';
import {queryStore, QueryExecution} from '../query/query_store';
import {SettingFilter} from '../settings/settings_types';

const QUERY_TABS_STORAGE_KEY = 'bigtraceQueryTabs';
const DEFAULT_SQL = '';
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_LIMIT = 100;

// Result of a single query execution as the editor tab understands it.
// `rows` and `columns` are populated for sync queries; for async queries
// they remain empty and the data is read from `tab.dataSource` on demand.
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

// All state for one editor tab. Declared mutable for ergonomic in-place
// updates from the runner; the QueryTabsState class is the only thing that
// creates and destroys these objects.
export interface BigTraceEditorTab {
  readonly id: string;
  title: string;
  editorText: string;
  limit: number;
  queryResult?: QueryResponse;
  isLoading: boolean;
  dataSource?: DataSource;
  querySettings: SettingFilter[];
  // Tab-lifetime AbortController. Aborted on tab close. Every backend
  // request that touches this tab plumbs `lifecycle.signal` so closing the
  // tab cancels in-flight requests instead of letting them write into a
  // dead `tab.execution`.
  readonly lifecycle: AbortController;
  // AbortController for the in-flight execute_* request specifically. Tied
  // to the tab lifecycle but separately abortable from a Cancel click
  // (which shouldn't tear down the rest of the tab's state).
  activeRequest?: AbortController;
  queryClient?: BigtraceQueryClient;
  materialize: boolean;
  queryUuid?: string;
  pollInterval?: number;
  currentOffset: number;
  lastProcessedRows: number;
  pageSize: number;
  clientStartTime?: number;
  execution?: QueryExecution;
  // Incremented each time startPolling() is called. Stale poll loops
  // compare against this to self-terminate when superseded.
  pollGeneration: number;
}

// Persisted shape of a tab in localStorage. Subset of BigTraceEditorTab —
// transient runtime state (lifecycle, dataSource, polling, etc.) is
// recreated on load.
interface StoredTab {
  readonly id: string;
  readonly title: string;
  readonly editorText: string;
  readonly limit: number;
  readonly materialize: boolean;
  readonly queryUuid?: string;
  readonly error?: string;
}

interface StoredState {
  readonly tabs: ReadonlyArray<StoredTab>;
  readonly activeTabId?: string;
  readonly globalPageSize?: number;
}

// Manages the collection of editor tabs. Survives QueryPage re-mounts so
// the user's tab layout is preserved across navigation.
export class QueryTabsState {
  tabs: BigTraceEditorTab[] = [];
  activeTabId = '';
  globalPageSize = DEFAULT_PAGE_SIZE;

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

  // Create a tab and make it active. If `forceNew` is false (the default)
  // and a tab already matches by `queryUuid` (preferred) or `initialQuery`,
  // the existing tab is reactivated instead of creating a duplicate.
  addNewTab(
    title?: string,
    initialQuery?: string,
    limit?: number,
    queryUuid?: string,
    materialize?: boolean,
    forceNew?: boolean,
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

    const tab: BigTraceEditorTab = {
      id: shortUuid(),
      title: title ?? this.nextTabName(),
      editorText: initialQuery ?? '',
      limit: limit ?? DEFAULT_LIMIT,
      queryResult: undefined,
      isLoading: false,
      dataSource: undefined,
      querySettings: [],
      lifecycle: new AbortController(),
      activeRequest: undefined,
      materialize: materialize ?? (queryUuid ? true : false),
      currentOffset: 0,
      lastProcessedRows: 0,
      pageSize: this.globalPageSize,
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
    // Abort everything tied to this tab's lifecycle: the active execute_*
    // request, plus any one-off getStatus / getQueryExecution / fetchResults
    // that received the lifecycle signal.
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
      })),
      activeTabId: this.activeTabId,
      globalPageSize: this.globalPageSize,
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

    if (parsed.globalPageSize !== undefined) {
      this.globalPageSize = parsed.globalPageSize;
    }
    for (const t of parsed.tabs) {
      const tab = this.addNewTab(
        t.title,
        t.editorText,
        t.limit,
        t.queryUuid,
        t.materialize,
      );
      if (t.error !== undefined && t.error !== '') {
        tab.queryResult = {
          rows: [],
          columns: [],
          error: t.error,
          totalRowCount: 0,
          durationMs: 0,
          statementWithOutputCount: 0,
          statementCount: 1,
          lastStatementSql: tab.editorText,
          query: tab.editorText,
        };
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
