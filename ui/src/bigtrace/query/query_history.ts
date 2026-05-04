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

import m from 'mithril';
import {Icons} from '../../base/semantic_icons';
import {Button} from '../../widgets/button';
import {Stack} from '../../widgets/stack';
import {queryHistoryStorage} from './query_history_storage';
import {queryStore, QueryExecution} from './query_store';
import {Tabs, TabsTab} from '../../widgets/tabs';

import {formatDate} from '../../base/time';
import {Spinner} from '../../widgets/spinner';
import {EmptyState} from '../../widgets/empty_state';

interface QueryHistoryComponentAttrs {
  readonly className?: string;
  setQuery: (query: string) => void;
  openQuery: (
    query: string,
    uuid: string,
    materialize: boolean,
    forceNew?: boolean,
    limit?: number,
    startTime?: number,
  ) => void;
  readonly refreshSignal?: number;
}

// Compact format for sidebar history rows. Examples:
//   - same year: "5/4 3:47 PM"
//   - other year: "5/4/25 3:47 PM"
function formatCompactDate(d: Date): string {
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = sameYear
    ? `${d.getMonth() + 1}/${d.getDate()}`
    : `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
  let h = d.getHours();
  const m12 = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${date} ${h}:${mm} ${m12}`;
}

export class QueryHistoryComponent
  implements m.ClassComponent<QueryHistoryComponentAttrs>
{
  private history: QueryExecution[] = [];

  private lastRefreshSignal = 0;
  private refreshTimeout?: number;

  onbeforeupdate(vnode: m.CVnode<QueryHistoryComponentAttrs>) {
    if (vnode.attrs.refreshSignal !== this.lastRefreshSignal) {
      this.lastRefreshSignal =
        vnode.attrs.refreshSignal !== undefined ? vnode.attrs.refreshSignal : 0;
      if (this.refreshTimeout !== undefined) {
        window.clearTimeout(this.refreshTimeout);
      }
      this.refreshTimeout = window.setTimeout(() => {
        this.loadHistory();
        this.refreshTimeout = undefined;
      }, 1000);
    }
    return true;
  }
  private isLoading = true;
  private error: string | null = null;
  private activeTabKey = 'materialized';

  oninit(_vnode: m.CVnode<QueryHistoryComponentAttrs>) {
    this.loadHistory();
  }

  async loadHistory() {
    this.isLoading = true;
    this.error = null;
    m.redraw();
    try {
      const list = await queryHistoryStorage.getAllHistory();
      this.history = list.map((entry) =>
        queryStore.getOrCreate(entry.uuid, entry),
      );
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.isLoading = false;
      m.redraw();
    }
  }

  view({attrs}: m.CVnode<QueryHistoryComponentAttrs>) {
    const {openQuery, ...rest} = attrs;

    if (this.isLoading) {
      return m(
        EmptyState,
        {
          title: 'Loading history...',
          icon: 'hourglass_empty',
          fillHeight: true,
        },
        m(Spinner),
      );
    }

    if (this.error) {
      return m(EmptyState, {
        title: `Failed to load history: ${this.error}`,
        icon: 'error',
        fillHeight: true,
      });
    }

    const standardQueries = this.history.filter((h) => !h.materialized);
    const materializedQueries = this.history.filter((h) => h.materialized);

    const tabs: TabsTab[] = [
      {
        key: 'standard',
        title: `Ephemeral (${standardQueries.length})`,
        content: this.renderHistoryList(standardQueries, false, openQuery),
      },
      {
        key: 'materialized',
        title: `Persistent (${materializedQueries.length})`,
        content: this.renderHistoryList(materializedQueries, true, openQuery),
      },
    ];

    return m('.pf-query-history', {...rest, style: {position: 'relative'}}, [
      m(
        'div',
        {style: {position: 'absolute', top: '5px', right: '5px', zIndex: 10}},
        [
          m(Button, {
            icon: 'refresh',
            title: 'Refresh history',
            onclick: () => this.loadHistory(),
          }),
        ],
      ),
      m(Tabs, {
        tabs: tabs,
        activeTabKey: this.activeTabKey,
        onTabChange: (key) => {
          this.activeTabKey = key;
          m.redraw();
        },
      }),
    ]);
  }

  private renderHistoryList(
    queries: QueryExecution[],
    isMaterialized: boolean,
    openQuery?: (
      query: string,
      uuid: string,
      materialize: boolean,
      forceNew?: boolean,
      limit?: number,
      startTime?: number,
    ) => void,
  ): m.Children {
    if (queries.length === 0) {
      return m(
        EmptyState,
        {
          title: isMaterialized
            ? 'No persistent queries yet'
            : 'No ephemeral queries yet',
          icon: 'search',
          fillHeight: true,
        },
        m(
          'div',
          {style: {marginTop: '8px', opacity: 0.7}},
          isMaterialized
            ? 'Run a query with Materialize on to see it here.'
            : 'Run a query with Materialize off to see it here.',
        ),
      );
    }

    return queries.map((entry, index) => {
      const queryText = entry.perfettoSql || '';
      const uuid = entry.uuid;
      const startTime = entry.startTime;
      const rows = entry.processedRows;
      const link = entry.tableLink;
      const dateObj = startTime !== undefined ? new Date(startTime) : null;
      // Compact date for the narrow sidebar — full toLocaleString() like
      // "5/4/2026, 3:47:46 PM" wrapped onto 4 lines once the sidebar
      // shrunk. Drop seconds always; drop year when it matches the
      // current year. Hover reveals the full UTC timestamp.
      const localString = dateObj ? formatCompactDate(dateObj) : 'N/A';
      const utcString =
        startTime !== undefined
          ? formatDate(new Date(startTime), {printTimezone: false})
          : 'N/A';

      return m(
        '.pf-query-history__item',
        {key: `${uuid}-${index}`},
        m(
          Stack,
          {
            className: 'pf-query-history__item-buttons',
            orientation: 'horizontal',
          },
          [
            m(Button, {
              onclick: () => {
                if (openQuery && uuid) {
                  openQuery(
                    queryText,
                    uuid,
                    isMaterialized,
                    false,
                    entry.limit,
                    startTime,
                  );
                }
              },
              icon: Icons.ChangeTab,
              title: 'Open query (switches to tab if already open)',
            }),

            m(Button, {
              onclick: async () => {
                if (uuid) {
                  await queryHistoryStorage.deleteQuery(uuid);
                  this.loadHistory();
                }
              },
              icon: Icons.Delete,
              title: 'Delete query',
            }),
          ],
        ),
        m('.pf-query-history__item-meta', [
          m('div.pf-query-history__item-header', [
            // Status leads — it mirrors the colored left bar and is the
            // most scannable element. Date and rows follow.
            m(
              'span.pf-query-history__item-status',
              {
                class: `pf-status-${entry.status.toLowerCase().replace(/_/g, '-')}`,
                // The colored left bar + the colored text already make
                // it clear this is a status label; the literal "Status:"
                // prefix would be noise.
                title: `Status: ${entry.status}`,
              },
              // Display: "IN_PROGRESS" → "IN PROGRESS".
              entry.status.replace(/_/g, ' '),
            ),
            m('span', {title: `UTC: ${utcString}`}, `Started: ${localString}`),
            isMaterialized &&
              m(
                'span.pf-query-history__item-rows',
                {
                  // Dim the row count when it's zero so empty results
                  // recede; non-zero counts stay at full opacity. The
                  // colored left bar + status pill already do the
                  // "succeeded" signalling.
                  className:
                    rows === 0
                      ? 'pf-query-history__item-rows--empty'
                      : undefined,
                },
                // Split label + value so "Rows:" sits at a consistent x
                // across rows; the value right-aligns in its own slot
                // so trailing edges align too.
                m('span.pf-query-history__item-rows-label', 'Rows:'),
                m(
                  'span.pf-query-history__item-rows-value',
                  rows.toLocaleString(),
                ),
              ),
          ]),
          isMaterialized &&
            m('div.pf-query-history__item-details', [
              m('span.pf-query-history__item-table-row', [
                m('span', 'Table:'),
                m(
                  'a.pf-query-history__item-table-link',
                  {
                    class:
                      rows === 0 || link === undefined || link === ''
                        ? 'pf-query-history__item-table-link--disabled'
                        : 'pf-query-history__item-table-link--active',
                    href: link || '#',
                    target: '_blank',
                    title:
                      rows === 0
                        ? 'No table created for empty results'
                        : 'View Table',
                  },
                  entry.tableName || 'N/A',
                ),
              ]),
            ]),
        ]),
        m('pre', queryText),
      );
    });
  }
}
