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

// A lightweight bar chart of a query's results: the first numeric column
// plotted against the first non-numeric (label) column. Reads rows directly
// for sync queries; pulls a page from the backend for async/materialized ones
// (and refreshes as the result grows).

import m from 'mithril';
import {EmptyState} from '../../widgets/empty_state';
import {Spinner} from '../../widgets/spinner';
import {QueryCancelledError} from '../query/bigtrace_query_client';
import {TERMINAL_STATUSES} from '../query/query_store';
import type {BigTraceEditorTab} from './query_tabs_state';

const CHART_ROWS = 200; // how many rows to pull for the chart
const CHART_BARS = 25; // how many bars to draw

type ChartRow = Record<string, unknown>;

const COMPACT = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export class ChartTab implements m.ClassComponent<{tab: BigTraceEditorTab}> {
  // This component instance is shared across all editor tabs (the Results node
  // is rendered once for the active tab), so it must reset its per-query state
  // when the active tab changes — tracked via tabId.
  private tabId?: string;
  private rows: ChartRow[] = [];
  private columns: ReadonlyArray<string> = [];
  private loading = false;
  private error?: string;
  private key = '';
  private ac?: AbortController;

  onremove() {
    this.ac?.abort();
  }

  view({attrs: {tab}}: m.Vnode<{tab: BigTraceEditorTab}>): m.Children {
    this.sync(tab);

    if (this.error !== undefined) {
      return m(EmptyState, {title: this.error, icon: 'error', fillHeight: true});
    }
    if (this.loading && this.rows.length === 0) {
      return m(
        EmptyState,
        {title: 'Loading chart…', icon: 'hourglass_empty', fillHeight: true},
        m(Spinner),
      );
    }
    return this.renderChart();
  }

  // Keep `rows`/`columns` current with the active query.
  private sync(tab: BigTraceEditorTab): void {
    // Active tab changed under this shared instance — drop the prior query's
    // rows/error/in-flight fetch so they can't leak into the new tab's chart.
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
      // Refetch once while running (partial) and once on terminal — NOT on
      // every poll tick: the grid already streams, so per-tick chart fetches
      // would just duplicate :fetch_results.
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
    // Sync query: rows are inline; clear any error carried from a prior async
    // tab so valid sync results aren't masked.
    this.error = undefined;
    this.rows = (tab.queryResult?.rows ?? []) as ChartRow[];
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
        CHART_ROWS,
        0,
        this.ac.signal,
      );
      if (k !== this.key) return; // superseded by a newer sync()
      this.rows = page.rows as ChartRow[];
      this.columns = page.columns;
    } catch (e) {
      if (e instanceof QueryCancelledError || k !== this.key) return;
      this.error = 'Could not load chart data';
    } finally {
      if (k === this.key) {
        this.loading = false;
        m.redraw();
      }
    }
  }

  private renderChart(): m.Children {
    if (this.rows.length === 0 || this.columns.length === 0) {
      return m(EmptyState, {
        title: 'No rows to chart',
        icon: 'bar_chart',
        fillHeight: true,
      });
    }
    const valueCol = this.columns.find((c) => this.isNumeric(c));
    if (valueCol === undefined) {
      return m(
        EmptyState,
        {title: 'Nothing to chart', icon: 'bar_chart', fillHeight: true},
        m('div', 'Add a numeric column to the query to see a chart.'),
      );
    }
    const labelCol = this.columns.find((c) => c !== valueCol) ?? valueCol;
    const data = this.rows.slice(0, CHART_BARS).map((r) => ({
      label: String(r[labelCol] ?? ''),
      value: Number(r[valueCol]) || 0,
    }));
    const max = Math.max(...data.map((d) => Math.abs(d.value)), 1);

    return m('.pf-bt-chart', [
      m('.pf-bt-chart__head', [
        m('span.pf-bt-chart__metric', valueCol),
        m('span.pf-bt-chart__by', ' by '),
        m('span.pf-bt-chart__dim', labelCol),
        this.rows.length > CHART_BARS &&
          m('span.pf-bt-chart__note', ` — first ${CHART_BARS} rows`),
      ]),
      m(
        '.pf-bt-chart__rows',
        data.map((d, i) =>
          m('.pf-bt-chart__row', {key: i}, [
            m('span.pf-bt-chart__label', {title: d.label}, d.label || '∅'),
            m(
              '.pf-bt-chart__track',
              m('.pf-bt-chart__bar', {
                style: {width: `${(Math.abs(d.value) / max) * 100}%`},
              }),
            ),
            m('span.pf-bt-chart__value', COMPACT.format(d.value)),
          ]),
        ),
      ),
    ]);
  }

  // A column counts as numeric if most of its sampled values parse to finite
  // numbers (the wire ships everything as strings, so we sniff the values).
  private isNumeric(col: string): boolean {
    let seen = 0;
    let numeric = 0;
    for (const r of this.rows.slice(0, 20)) {
      const v = r[col];
      if (v === null || v === undefined || v === '') continue;
      seen++;
      if (Number.isFinite(Number(v))) numeric++;
    }
    return seen > 0 && numeric / seen >= 0.8;
  }
}
