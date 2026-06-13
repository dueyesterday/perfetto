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
import {Box} from '../../widgets/box';
import {PopupPosition} from '../../widgets/popup';
import {Tooltip} from '../../widgets/tooltip';
import {Duration} from '../../base/time';
import {
  formatCompact,
  statusDisplayLabel,
  TERMINAL_STATUSES,
} from '../query/query_store';
import type {BigTraceEditorTab} from './query_tabs_state';

// "<1s" for sub-500ms runs so the user sees the query actually ran.
export function formatDurationS(ms: number): string {
  if (ms < 500) return '<1s';
  return Duration.format(Duration.fromMillis(Math.round(ms / 1000) * 1000));
}

export function renderStatusBox(tab: BigTraceEditorTab): m.Children {
  if (!tab.materialize || !tab.queryUuid) return false;

  const isTerminal =
    tab.execution?.status !== undefined &&
    TERMINAL_STATUSES.has(tab.execution.status);
  const processedRows = tab.execution?.processedRows ?? 0;

  let durationMs = 0;
  if (
    isTerminal &&
    tab.execution?.endTime !== undefined &&
    tab.execution?.startTime !== undefined
  ) {
    durationMs = tab.execution.endTime - tab.execution.startTime;
  } else if (!isTerminal) {
    const start =
      tab.execution?.startTime !== undefined
        ? tab.execution.startTime
        : tab.clientStartTime;
    if (start !== undefined) {
      durationMs = Date.now() - start;
    }
  }

  const status = tab.execution?.status ?? 'UNKNOWN';
  const processedTraces = tab.execution?.processedTraces ?? 0;
  const totalTraces = tab.execution?.totalTraces ?? 0;
  const durationStr = formatDurationS(durationMs);

  const leftGroup = m(
    '.pf-bt-status-bar-group',
    m(
      'span.pf-bt-status-bar-pill',
      {className: `pf-bt-status-${status.toLowerCase().replace(/_/g, '-')}`},
      statusDisplayLabel(status),
    ),
    // Results stream into the grid automatically as the backend produces them:
    // the poll loop refreshes the data source on every progress tick (see
    // PollingController.maybeAutoFetchProgress). This passive indicator replaces
    // the old click-to-refresh button + "new data" dot — there is nothing for
    // the user to pull; rows just appear.
    !isTerminal &&
      m(
        'span.pf-bt-status-bar-live',
        {title: 'Rows stream into the grid automatically as they are produced'},
        m('span.pf-bt-status-bar-live-dot', {'aria-hidden': 'true'}),
        'Streaming results',
      ),
    m(
      'span.pf-bt-status-bar-duration',
      m('span.pf-bt-status-bar-duration-value', durationStr),
    ),
  );

  const rowsStatClasses = [
    'pf-bt-status-bar-stat',
    'pf-bt-status-bar-stat--rows',
    processedRows === 0 && 'pf-bt-status-bar-stat--empty',
  ]
    .filter(Boolean)
    .join(' ');
  const rightGroupContent = m(
    '.pf-bt-status-bar-group',
    m(
      'span.pf-bt-status-bar-stat.pf-bt-status-bar-stat--traces',
      m('span.pf-bt-status-bar-stat-label', 'Traces:'),
      m(
        'span.pf-bt-status-bar-stat-value',
        {
          title:
            `${processedTraces.toLocaleString()} of ` +
            `${totalTraces.toLocaleString()}` +
            (!isTerminal
              ? ' — numerator lags the poll (≤3s); denominator is exact.'
              : ''),
        },
        formatCompact(processedTraces),
      ),
      renderInlineProgressBar(processedTraces, totalTraces, !isTerminal),
    ),
    m(
      'span',
      {className: rowsStatClasses},
      m('span.pf-bt-status-bar-stat-label', 'Rows:'),
      m(
        'span.pf-bt-status-bar-stat-value',
        {
          title: `${processedRows.toLocaleString()} of result limit ${tab.limit.toLocaleString()}`,
        },
        formatCompact(processedRows),
      ),
      renderInlineProgressBar(processedRows, tab.limit, !isTerminal),
    ),
  );

  const rightGroup = !isTerminal
    ? m(
        Tooltip,
        {
          trigger: rightGroupContent,
          position: PopupPosition.Top,
        },
        m(
          '.pf-bt-status-bar-progress-tooltip',
          m('div', `Traces: ${formatCompact(processedTraces)}`),
          m('div', `Rows: ${formatCompact(processedRows)}`),
        ),
      )
    : rightGroupContent;

  return m(
    Box,
    {
      className: isTerminal
        ? 'pf-bt-status-bar'
        : 'pf-bt-status-bar pf-bt-status-bar--running',
    },
    leftGroup,
    rightGroup,
  );
}

function renderInlineProgressBar(
  done: number,
  total: number,
  live: boolean,
): m.Children {
  if (!live) return null;
  if (total <= 0) return null;
  const pct = Math.max(0, Math.min(100, (done / total) * 100));
  return m(
    'span.pf-bt-inline-progress',
    m('span.pf-bt-inline-progress-fill', {
      style: {width: `${pct}%`},
    }),
  );
}
