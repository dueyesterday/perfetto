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

// The fleet question a flat result grid can't answer: which traces dominate
// these rows? Groups the result by its trace-identifier column and shows the
// per-trace row contribution, surfacing skew (one trace producing most rows).

import m from 'mithril';
import {EmptyState} from '../../widgets/empty_state';
import {Spinner} from '../../widgets/spinner';
import {ResultRowsLoader} from './result_rows_loader';
import type {BigTraceEditorTab} from './query_tabs_state';

const TOP_N = 25;

// Likely names for the per-row trace identifier (the backend prepends one when
// fanning a query across traces; trace_metadata columns may add file_name etc.).
const TRACE_KEY_PREFERENCE = [
  'trace_id',
  'trace_uuid',
  '_trace_id',
  'file_name',
  'file_path',
  'trace',
];

function pickTraceKey(columns: ReadonlyArray<string>): string | undefined {
  for (const pref of TRACE_KEY_PREFERENCE) {
    const c = columns.find((x) => x.toLowerCase() === pref);
    if (c !== undefined) return c;
  }
  return columns.find((x) => x.toLowerCase().includes('trace'));
}

export class ByTraceTab implements m.ClassComponent<{tab: BigTraceEditorTab}> {
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
        {title: 'Grouping by trace…', icon: 'hourglass_empty', fillHeight: true},
        m(Spinner),
      );
    }
    const {rows, columns} = this.loader;
    if (rows.length === 0 || columns.length === 0) {
      return m(EmptyState, {
        title: 'No rows to group',
        icon: 'workspaces',
        fillHeight: true,
      });
    }
    const keyCol = pickTraceKey(columns);
    if (keyCol === undefined) {
      return m(
        EmptyState,
        {title: 'No trace identifier column', icon: 'workspaces', fillHeight: true},
        m(
          'div',
          'Add a trace id / file_name column (via the trace-metadata columns) ' +
            'to break results down per trace.',
        ),
      );
    }

    const counts = new Map<string, number>();
    for (const r of rows) {
      const k = String(r[keyCol] ?? '∅');
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const total = rows.length;
    const topShare = entries.length > 0 ? (entries[0][1] / total) * 100 : 0;
    const max = entries.length > 0 ? entries[0][1] : 1;
    const loaded = this.loader.partial ? ` (first ${total} rows)` : '';

    return m('.pf-bt-chart', [
      m('.pf-bt-chart__head', [
        m('span.pf-bt-chart__metric', String(entries.length)),
        ` trace${entries.length === 1 ? '' : 's'} contributed ${total.toLocaleString()} row${total === 1 ? '' : 's'}${loaded}`,
        entries.length > 1 &&
          m(
            'span.pf-bt-chart__note',
            ` — top trace = ${topShare.toFixed(topShare < 10 ? 1 : 0)}%`,
          ),
        entries.length > TOP_N &&
          m('span.pf-bt-chart__note', ` · showing top ${TOP_N}`),
      ]),
      m(
        '.pf-bt-chart__rows',
        entries.slice(0, TOP_N).map(([key, count], i) =>
          m('.pf-bt-chart__row', {key: i}, [
            m('span.pf-bt-chart__label', {title: key}, key),
            m(
              '.pf-bt-chart__track',
              m('.pf-bt-chart__bar', {style: {width: `${(count / max) * 100}%`}}),
            ),
            m('span.pf-bt-chart__value', count.toLocaleString()),
          ]),
        ),
      ),
    ]);
  }
}
