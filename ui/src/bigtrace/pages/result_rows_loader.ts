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

// Loads a page of a query's result rows for the analysis tabs (Chart, Summary).
// Reads inline rows for sync queries; fetches a page for async/materialized
// ones and refreshes as the result grows. One instance is shared across editor
// tabs (the Results node is rendered once for the active tab), so it resets its
// state when the active tab changes and key-guards in-flight fetches so a stale
// page can never commit into the wrong tab.

import m from 'mithril';
import {QueryCancelledError} from '../query/bigtrace_query_client';
import {TERMINAL_STATUSES} from '../query/query_store';
import type {BigTraceEditorTab} from './query_tabs_state';

export type ResultRow = Record<string, unknown>;

// How many rows to pull for analysis (chart/summary). A page, not the whole
// result, for materialized queries that can be huge.
const ANALYSIS_ROWS = 500;

export class ResultRowsLoader {
  rows: ResultRow[] = [];
  columns: ReadonlyArray<string> = [];
  loading = false;
  error?: string;

  private tabId?: string;
  private key = '';
  private ac?: AbortController;

  destroy(): void {
    this.ac?.abort();
  }

  // Keep rows/columns current with the active query. Call from view().
  sync(tab: BigTraceEditorTab): void {
    if (tab.id !== this.tabId) {
      this.ac?.abort();
      this.tabId = tab.id;
      this.rows = [];
      this.columns = [];
      this.error = undefined;
      this.key = '';
      this.loading = false;
    }

    if (tab.materialize && tab.queryUuid) {
      // Refetch once while running (partial) + once on terminal — not every
      // poll tick (the grid already streams).
      const terminal =
        tab.execution?.status !== undefined &&
        TERMINAL_STATUSES.has(tab.execution.status);
      const k = `${tab.queryUuid}:${terminal ? 'final' : 'live'}`;
      if (k !== this.key) {
        this.key = k;
        void this.fetch(tab, k);
      }
      return;
    }
    // Sync query: rows are inline; clear any error from a prior async tab.
    this.error = undefined;
    this.rows = (tab.queryResult?.rows ?? []) as ResultRow[];
    this.columns = tab.queryResult?.columns ?? [];
  }

  private async fetch(tab: BigTraceEditorTab, k: string): Promise<void> {
    if (!tab.queryUuid || !tab.queryClient) return;
    this.ac?.abort();
    this.ac = new AbortController();
    this.loading = true;
    this.error = undefined;
    try {
      const page = await tab.queryClient.fetchResults(
        tab.queryUuid,
        ANALYSIS_ROWS,
        0,
        this.ac.signal,
      );
      if (k !== this.key) return;
      this.rows = page.rows as ResultRow[];
      this.columns = page.columns;
    } catch (e) {
      if (e instanceof QueryCancelledError || k !== this.key) return;
      this.error = 'Could not load result data';
    } finally {
      if (k === this.key) {
        this.loading = false;
        m.redraw();
      }
    }
  }
}
