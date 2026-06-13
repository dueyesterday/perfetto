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
import {classNames} from '../../base/classnames';
import {Icons} from '../../base/semantic_icons';
import {Button} from '../../widgets/button';
import {Icon} from '../../widgets/icon';
import {Intent} from '../../widgets/common';
import {Stack} from '../../widgets/stack';
import {queryHistoryStorage} from './query_history_storage';
import {
  formatCompact,
  queryStore,
  type QueryExecution,
  statusDisplayLabel,
} from './query_store';
import {formatDate} from '../../base/time';
import {showModal} from '../../widgets/modal';
import {historyStore, formatCompactDate} from './history_store';

// Reopens an existing history entry.
export type OpenQueryFn = (
  query: string,
  uuid: string,
  materialize: boolean,
  forceNew?: boolean,
  limit?: number,
  startTime?: number,
) => void;

// SQL block clamped to ~4 lines with a fade-out mask; click to expand.
// Used by the sidebar history row and the delete-confirm modal (the latter
// passes `standalone: true`). Expand state lives on the instance so it
// survives redraws.
interface ClampedQueryAttrs {
  readonly queryText: string;
  readonly standalone?: boolean;
  readonly onExpand?: () => void;
}

class ClampedQuery implements m.ClassComponent<ClampedQueryAttrs> {
  private expanded = false;

  view({attrs}: m.Vnode<ClampedQueryAttrs>): m.Children {
    const {queryText, standalone, onExpand} = attrs;
    if (queryText === '') {
      return m(
        'span.pf-bt-history-item-query.pf-bt-history-item-query--empty',
        '(no query text)',
      );
    }
    const toggle = () => {
      this.expanded = !this.expanded;
      if (this.expanded) {
        onExpand?.();
      }
    };
    return m(
      'pre.pf-bt-history-item-query',
      {
        className: classNames(
          this.expanded && 'pf-bt-history-item-query--expanded',
          standalone && 'pf-bt-history-item-query--standalone',
        ),
        tabindex: 0,
        role: 'button',
        'aria-expanded': this.expanded ? 'true' : 'false',
        'aria-label': 'Toggle full query text',
        onclick: toggle,
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        },
      },
      queryText,
    );
  }
}

// UUIDs whose full SQL has already been fetched. Capped to bound growth.
const FETCHED_SQL_MAX = 500;
const fetchedFullSql = new Set<string>();

// onExpand callback that fetches the full SQL on first expand, or undefined
// if already fetched / no uuid.
function makeFullSqlExpander(
  uuid: string | undefined,
  currentText: string,
): (() => void) | undefined {
  if (!uuid || fetchedFullSql.has(uuid)) return undefined;
  return () => {
    if (fetchedFullSql.size >= FETCHED_SQL_MAX) {
      // Evict oldest (Set iteration order = insertion order).
      const first = fetchedFullSql.values().next().value;
      if (first !== undefined) fetchedFullSql.delete(first);
    }
    fetchedFullSql.add(uuid);
    void queryHistoryStorage
      .fetchFullSql(uuid)
      .then((full) => {
        if (full && full !== currentText) {
          queryStore.update(uuid, {perfettoSql: full});
          m.redraw();
        }
      })
      .catch((e) => {
        fetchedFullSql.delete(uuid);
        console.error('Failed to fetch full SQL:', e);
      });
  };
}

export function renderHistoryItem(
  entry: QueryExecution,
  index: number,
  isMaterialized: boolean,
  openQuery?: OpenQueryFn,
): m.Children {
  const queryText = entry.perfettoSql || '';
  const uuid = entry.uuid;
  const startTime = entry.startTime;
  const rows = entry.processedRows;
  const link = entry.tableLink;
  const dateObj = startTime !== undefined ? new Date(startTime) : null;
  // Compact for the narrow sidebar; hover reveals the full UTC timestamp.
  const localString = dateObj ? formatCompactDate(dateObj) : 'N/A';
  const utcString =
    startTime !== undefined
      ? formatDate(new Date(startTime), {printTimezone: false})
      : 'N/A';

  const buttonsRow = m(
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
        title: 'Open',
      }),

      m(Button, {
        onclick: async () => {
          if (!uuid) return;
          let confirmed = false;
          await showModal({
            title: 'Delete query from history?',
            content: () =>
              m('div', [
                startTime !== undefined &&
                  m(
                    'div.pf-bt-history-delete-date',
                    {title: `UTC: ${utcString}`},
                    localString,
                  ),
                m(ClampedQuery, {
                  queryText: entry.perfettoSql || '',
                  standalone: true,
                  onExpand: makeFullSqlExpander(uuid, entry.perfettoSql || ''),
                }),
              ]),
            buttons: [
              {text: 'Cancel'},
              {
                text: 'Delete',
                primary: true,
                action: () => {
                  confirmed = true;
                },
              },
            ],
          });
          if (!confirmed) return;
          await queryHistoryStorage.deleteQuery(uuid);
          historyStore.refreshNow();
        },
        icon: Icons.Delete,
        // Red hover so destructive intent reads before click.
        intent: Intent.Danger,
        title: 'Delete query',
      }),
    ],
  );

  return m(
    '.pf-query-history__item',
    {key: `${uuid}-${index}`},
    m('.pf-bt-history-item-meta', [
      buttonsRow,
      m('div.pf-bt-history-item-header', [
        m(
          'span.pf-bt-history-item-status',
          {
            class: `pf-bt-status-${entry.status.toLowerCase().replace(/_/g, '-')}`,
          },
          statusDisplayLabel(entry.status),
        ),
        m(
          'span.pf-bt-history-item-date',
          {title: `UTC: ${utcString}`},
          localString,
        ),
      ]),
    ]),
    // Materialized only: a banded strip between the header and the SQL pre.
    isMaterialized &&
      m(
        'div.pf-bt-history-item-details',
        {
          className:
            rows === 0 ? 'pf-bt-history-item-details--empty' : undefined,
        },
        m(
          'a.pf-bt-history-item-table-link',
          {
            class:
              rows === 0 || link === undefined || link === ''
                ? 'pf-bt-history-item-table-link--disabled'
                : 'pf-bt-history-item-table-link--active',
            href: link || '#',
            target: '_blank',
            title:
              rows === 0
                ? 'No table created for empty results'
                : entry.tableName || 'View Table',
          },
          entry.tableName || '—',
        ),
        m(
          'span.pf-bt-history-item-rows-value',
          `${formatCompact(rows)} ${rows === 1 ? 'row' : 'rows'}`,
        ),
      ),
    // /query_executions clips perfettoSql; first expand fetches the full text.
    m(ClampedQuery, {
      queryText,
      onExpand: makeFullSqlExpander(uuid, queryText),
    }),
  );
}

// ---------------------------------------------------------------------------
// Run card — the modern unified history entry. One card per run: status pill,
// quick/saved tag, time, a single-line SQL summary, row count + table chip.
// The whole card reopens the run; the delete affordance stops propagation.
// ---------------------------------------------------------------------------

export function renderRunCard(
  entry: QueryExecution,
  openQuery?: OpenQueryFn,
  activeUuid?: string,
): m.Children {
  const uuid = entry.uuid;
  const queryText = (entry.perfettoSql || '').replace(/\s+/g, ' ').trim();
  const rows = entry.processedRows;
  const saved = Boolean(entry.materialized);
  const startTime = entry.startTime;
  const timeAgo =
    startTime !== undefined ? formatCompactDate(new Date(startTime)) : '';
  const utcString =
    startTime !== undefined
      ? formatDate(new Date(startTime), {printTimezone: false})
      : 'N/A';
  const statusClass = `pf-bt-status-${entry.status
    .toLowerCase()
    .replace(/_/g, '-')}`;

  const isActive = uuid !== undefined && uuid === activeUuid;
  const reopen = () => {
    if (openQuery && uuid) {
      openQuery(queryText, uuid, saved, false, entry.limit, startTime);
    }
  };

  return m(
    '.pf-bt-run-card',
    {
      key: uuid,
      className: isActive ? 'pf-bt-run-card--active' : '',
      tabindex: 0,
      role: 'button',
      'aria-label': `Reopen run: ${queryText.slice(0, 80) || '(no query)'}`,
      title: isActive ? 'Loaded in the editor' : 'Reopen this run',
      onclick: reopen,
      onkeydown: (e: KeyboardEvent) => {
        // Don't hijack Enter/Space when focus is on a nested control (delete).
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          reopen();
        }
      },
    },
    m('.pf-bt-run-card__head', [
      m(
        'span.pf-bt-run-card__status',
        {className: statusClass},
        statusDisplayLabel(entry.status),
      ),
      m(
        'span.pf-bt-run-card__tag',
        {
          className: saved
            ? 'pf-bt-run-card__tag--saved'
            : 'pf-bt-run-card__tag--quick',
        },
        saved ? 'saved' : 'quick',
      ),
      m('span.pf-bt-run-card__time', {title: `UTC: ${utcString}`}, timeAgo),
      m(
        'button.pf-bt-run-card__delete',
        {
          title: 'Delete run',
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            void confirmDeleteRun(entry, queryText);
          },
        },
        m(Icon, {icon: 'delete'}),
      ),
    ]),
    m(
      'div.pf-bt-run-card__sql',
      queryText !== '' ? queryText : '(no query text)',
    ),
    m('.pf-bt-run-card__meta', [
      m('span', `${formatCompact(rows)} ${rows === 1 ? 'row' : 'rows'}`),
      saved &&
        entry.tableName &&
        m('span.pf-bt-run-card__chip', {title: 'Result table'}, entry.tableName),
    ]),
  );
}

async function confirmDeleteRun(
  entry: QueryExecution,
  queryText: string,
): Promise<void> {
  const uuid = entry.uuid;
  if (!uuid) return;
  let confirmed = false;
  await showModal({
    title: 'Delete run from history?',
    content: () =>
      m(
        'div',
        m(ClampedQuery, {
          queryText,
          standalone: true,
          onExpand: makeFullSqlExpander(uuid, queryText),
        }),
      ),
    buttons: [
      {text: 'Cancel'},
      {
        text: 'Delete',
        primary: true,
        action: () => {
          confirmed = true;
        },
      },
    ],
  });
  if (!confirmed) return;
  await queryHistoryStorage.deleteQuery(uuid);
  historyStore.refreshNow();
}
