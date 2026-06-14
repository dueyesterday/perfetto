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

// Per-column statistics over a query's results: non-null / null / distinct
// counts for every column, plus min / max / avg for numeric ones. A fast way to
// understand the shape of a result set across a fleet of traces without eyeing
// the grid.

import m from 'mithril';
import {EmptyState} from '../../widgets/empty_state';
import {Spinner} from '../../widgets/spinner';
import {ResultRowsLoader} from './result_rows_loader';
import {computeColumnStats, type ColumnStat} from './column_stats';
import type {BigTraceEditorTab} from './query_tabs_state';

const NUM = new Intl.NumberFormat('en', {maximumFractionDigits: 2});
const COMPACT = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

// Big integers (timestamps) read better compact; small numbers exact.
function fmt(n: number | undefined): string {
  if (n === undefined) return '—';
  if (!Number.isFinite(n)) return '—';
  return Math.abs(n) >= 100000 ? COMPACT.format(n) : NUM.format(n);
}

export class SummaryTab implements m.ClassComponent<{tab: BigTraceEditorTab}> {
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
        {title: 'Summarizing…', icon: 'hourglass_empty', fillHeight: true},
        m(Spinner),
      );
    }
    const {rows, columns} = this.loader;
    if (rows.length === 0 || columns.length === 0) {
      return m(EmptyState, {
        title: 'No rows to summarize',
        icon: 'analytics',
        fillHeight: true,
      });
    }
    const stats = computeColumnStats(rows, columns);
    return this.renderTable(rows.length, stats);
  }

  private renderTable(rowCount: number, stats: ColumnStat[]): m.Children {
    return m('.pf-bt-summary', [
      m(
        '.pf-bt-summary__head',
        `${rowCount.toLocaleString()} row${rowCount === 1 ? '' : 's'} · `,
        `${stats.length} column${stats.length === 1 ? '' : 's'}`,
      ),
      m('table.pf-bt-summary__table', [
        m(
          'thead',
          m('tr', [
            m('th', 'Column'),
            m('th', 'Type'),
            m('th.pf-bt-summary__num', 'Non-null'),
            m('th.pf-bt-summary__num', 'Nulls'),
            m('th.pf-bt-summary__num', 'Distinct'),
            m('th.pf-bt-summary__num', 'Min'),
            m('th.pf-bt-summary__num', 'Max'),
            m('th.pf-bt-summary__num', 'Avg'),
          ]),
        ),
        m(
          'tbody',
          stats.map((s) =>
            m('tr', {key: s.column}, [
              m('td.pf-bt-summary__col', s.column),
              m(
                'td',
                m(
                  'span.pf-bt-summary__type',
                  {
                    className: s.numeric
                      ? 'pf-bt-summary__type--num'
                      : 'pf-bt-summary__type--text',
                  },
                  s.numeric ? 'numeric' : 'text',
                ),
              ),
              m('td.pf-bt-summary__num', s.nonNull.toLocaleString()),
              m(
                'td.pf-bt-summary__num',
                {
                  className:
                    s.nulls > 0 ? 'pf-bt-summary__nulls' : '',
                },
                s.nulls.toLocaleString(),
              ),
              m('td.pf-bt-summary__num', s.distinct.toLocaleString()),
              m('td.pf-bt-summary__num', s.numeric ? fmt(s.min) : '—'),
              m('td.pf-bt-summary__num', s.numeric ? fmt(s.max) : '—'),
              m('td.pf-bt-summary__num', s.numeric ? fmt(s.avg) : '—'),
            ]),
          ),
        ),
      ]),
    ]);
  }
}
