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
// plotted against the first non-numeric (label) column.

import m from 'mithril';
import {EmptyState} from '../../widgets/empty_state';
import {Spinner} from '../../widgets/spinner';
import {ResultRowsLoader, type ResultRow} from './result_rows_loader';
import {isNumericColumn} from './column_stats';
import type {BigTraceEditorTab} from './query_tabs_state';

const CHART_BARS = 25; // how many bars to draw

const COMPACT = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export class ChartTab implements m.ClassComponent<{tab: BigTraceEditorTab}> {
  private readonly loader = new ResultRowsLoader();

  onremove() {
    this.loader.destroy();
  }

  view({attrs: {tab}}: m.Vnode<{tab: BigTraceEditorTab}>): m.Children {
    this.loader.sync(tab);
    if (this.loader.error !== undefined) {
      return m(EmptyState, {
        title: this.loader.error,
        icon: 'error',
        fillHeight: true,
      });
    }
    if (this.loader.loading && this.loader.rows.length === 0) {
      return m(
        EmptyState,
        {title: 'Loading chart…', icon: 'hourglass_empty', fillHeight: true},
        m(Spinner),
      );
    }
    return this.renderChart(this.loader.rows, this.loader.columns);
  }

  private renderChart(
    rows: ResultRow[],
    columns: ReadonlyArray<string>,
  ): m.Children {
    if (rows.length === 0 || columns.length === 0) {
      return m(EmptyState, {
        title: 'No rows to chart',
        icon: 'bar_chart',
        fillHeight: true,
      });
    }
    const valueCol = columns.find((c) => isNumericColumn(rows, c));
    if (valueCol === undefined) {
      return m(
        EmptyState,
        {title: 'Nothing to chart', icon: 'bar_chart', fillHeight: true},
        m('div', 'Add a numeric column to the query to see a chart.'),
      );
    }
    const labelCol = columns.find((c) => c !== valueCol) ?? valueCol;
    const data = rows.slice(0, CHART_BARS).map((r) => ({
      label: String(r[labelCol] ?? ''),
      value: Number(r[valueCol]) || 0,
    }));
    const max = Math.max(...data.map((d) => Math.abs(d.value)), 1);

    return m('.pf-bt-chart', [
      m('.pf-bt-chart__head', [
        m('span.pf-bt-chart__metric', valueCol),
        m('span.pf-bt-chart__by', ' by '),
        m('span.pf-bt-chart__dim', labelCol),
        rows.length > CHART_BARS &&
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
}
