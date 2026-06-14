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
import {Button, ButtonVariant} from '../../widgets/button';
import {Callout} from '../../widgets/callout';
import {Intent} from '../../widgets/common';
import {Editor} from '../../widgets/editor';
import {Icon} from '../../widgets/icon';
import {
  perfettoSqlCompletions,
  detectMissingIncludes,
  addIncludes,
} from '../query/sql_completion';
import {HotkeyGlyphs} from '../../widgets/hotkey_glyphs';
import {Stack, StackAuto} from '../../widgets/stack';
import {Switch} from '../../widgets/switch';
import {TextInput} from '../../widgets/text_input';
import {InMemoryDataSource} from '../../components/widgets/datagrid/in_memory_data_source';
import {getBigtraceEndpoint} from '../settings/endpoint_storage';
import {BigtraceAsyncDataSource} from '../query/bigtrace_async_data_source';
import {setHistoryActiveTab} from '../query/query_history';
import {BigtraceQueryClient} from '../query/bigtrace_query_client';
import type {QueryRunner} from '../query/query_runner';
import {
  type BigTraceEditorTab,
  type QueryTabsState,
  deriveTitleFromQuery,
  effectiveTabSettings,
} from './query_tabs_state';
import {scopeCount} from '../query/scope_count';
import type {SettingCategory, SettingFilter} from '../settings/settings_types';
import type {SettingsBindings} from '../settings/tab_bound_setting';

// The editor + results were split into separate workflow-graph nodes; the
// workspace renders renderEditorPanel() and renderResultsPanel() directly and
// calls ensureTabWired() once for the active tab. (No combined view remains.)

// ---------------------------------------------------------------------------
// Per-tab bindings shared between the chip strip and any modal it opens.
// Getters read live; setters mutate in place and mark dirty.
// getEffectiveSettings layers per-tab overrides over global defaults so
// /trace_metadata sees a complete settings array even before the user edits.
// ---------------------------------------------------------------------------

export function buildTabBindings(
  tab: BigTraceEditorTab,
  tabsState: QueryTabsState,
): SettingsBindings {
  return {
    getEffectiveSettings: () => effectiveTabSettings(tab),
    getSettingValue: (id) => {
      const entry = tab.querySettings.find((s) => s.settingId === id);
      return entry?.values;
    },
    setSettingValue: (id, values, category) => {
      const next = [...tab.querySettings];
      const idx = next.findIndex((s) => s.settingId === id);
      const entry: SettingFilter = {
        settingId: id,
        values: [...values],
        category: category as SettingCategory,
      };
      if (idx >= 0) next[idx] = entry;
      else next.push(entry);
      tab.querySettings = next;
      tabsState.markDirty();
    },
    getTraceFilters: () => tab.traceFilters,
    setTraceFilters: (filters) => {
      tab.traceFilters = [...filters];
      tabsState.markDirty();
    },
    getTraceMetadataColumns: () => tab.traceMetadataColumns,
    setTraceMetadataColumns: (cols) => {
      tab.traceMetadataColumns = cols === null ? null : [...cols];
      tabsState.markDirty();
    },
    getTraceOrderBy: () => tab.traceOrderBy,
    setTraceOrderBy: (orderBy) => {
      tab.traceOrderBy = orderBy;
      tabsState.markDirty();
    },
    isSettingDisabled: (id) => tab.disabledSettings.includes(id),
    setSettingDisabled: (id, disabled) => {
      const set = new Set(tab.disabledSettings);
      if (disabled) set.add(id);
      else set.delete(id);
      tab.disabledSettings = [...set];
      tabsState.markDirty();
    },
  };
}

// ---------------------------------------------------------------------------
// Editor panel: toolbar (Run/Cancel + limit + Persistent) and the editor.
// ---------------------------------------------------------------------------

// Wires up a tab's async data source (for tabs restored from history) and keeps
// the displayed row count in sync. Call before rendering the editor/results of
// a tab outside the combined EditorTabView (e.g. the workflow-graph nodes).
export function ensureTabWired(
  tab: BigTraceEditorTab,
  runner: QueryRunner,
): void {
  if (tab.queryUuid && !tab.dataSource) {
    attachAsyncDataSource(tab, runner);
  }
  if (tab.dataSource && tab.queryResult && tab.materialize && tab.execution) {
    tab.queryResult.totalRowCount = tab.execution.processedRows;
  }
}

export function renderEditorPanel(
  tab: BigTraceEditorTab,
  tabsState: QueryTabsState,
  runner: QueryRunner,
  useBigtraceBackend: boolean,
): m.Children {
  const missingIncludes = useBigtraceBackend
    ? detectMissingIncludes(tab.editorText)
    : [];
  return m('.pf-bt-query-page__editor-panel', [
    m(Box, {className: 'pf-bt-query-page__toolbar'}, [
      m(Stack, {orientation: 'horizontal', className: 'pf-bt-run-bar'}, [
        tab.isLoading
          ? m(Button, {
              label: 'Cancel',
              icon: 'stop',
              intent: Intent.Warning,
              variant: ButtonVariant.Filled,
              onclick: () => runner.cancel(tab),
            })
          : m(Button, {
              label: 'Run',
              icon: 'play_arrow',
              intent: Intent.Primary,
              variant: ButtonVariant.Filled,
              disabled: deriveTitleFromQuery(tab.editorText) === undefined,
              onclick: () => {
                setHistoryActiveTab(tab.materialize);
                tabsState.maybeAutoNameTab(tab.id, tab.editorText);
                runner.run(tab, tab.editorText);
              },
            }),
        // Keyboard hint as a compact keycap next to Run, not verbose prose.
        !tab.isLoading &&
          m(
            'span.pf-bt-run-bar__hint.pf-bt-query-page__hotkeys',
            m(HotkeyGlyphs, {hotkey: 'Mod+Enter'}),
          ),
        // Run contract: state the scope this run executes against.
        !tab.isLoading &&
          useBigtraceBackend &&
          scopeCount.matched !== undefined &&
          m(
            'span.pf-bt-run-bar__scope',
            {title: 'Traces this query will run over (set in Scope)'},
            `over ${scopeCount.matched.toLocaleString()} trace${
              scopeCount.matched === 1 ? '' : 's'
            }`,
          ),
        m(StackAuto),
        useBigtraceBackend && [
          // "Persistent" was opaque; this names the actual effect.
          m(Switch, {
            label: 'Save to history',
            title:
              'On: this run is saved to History and can be reopened later. ' +
              'Off: results are shown inline and discarded when the tab closes.',
            checked: tab.materialize,
            disabled: tab.isLoading,
            onchange: (e: Event) => {
              tab.materialize = (e.target as HTMLInputElement).checked;
              setHistoryActiveTab(tab.materialize);
              tabsState.markDirty();
            },
          }),
          m('span.pf-bt-toolbar-divider', {'aria-hidden': 'true'}),
          m(
            'label.pf-bt-run-bar__limit',
            m('span', 'Limit'),
            m(TextInput, {
              type: 'number',
              value: String(tab.limit),
              placeholder: 'Limit',
              disabled: tab.isLoading,
              onInput: (value: string) => {
                const newLimit = parseInt(value, 10);
                if (!isNaN(newLimit) && newLimit > 0) {
                  tab.limit = newLimit;
                }
              },
            }),
          ),
        ],
      ]),
    ]),
    missingIncludes.length > 0 &&
      m(
        '.pf-bt-include-hint',
        m(Icon, {className: 'pf-bt-include-hint__icon', icon: 'extension'}),
        m('span.pf-bt-include-hint__text', [
          `Needs ${missingIncludes.length} stdlib module`,
          missingIncludes.length > 1 ? 's' : '',
          ' not yet included: ',
          m('code', missingIncludes.join(', ')),
        ]),
        m(Button, {
          label: missingIncludes.length > 1 ? 'Add includes' : 'Add include',
          icon: 'add',
          className: 'pf-bt-include-hint__add',
          onclick: () => {
            tab.editorText = addIncludes(tab.editorText, missingIncludes);
            tabsState.markDirty();
          },
        }),
      ),
    tab.editorText.includes('"') &&
      m(
        Callout,
        {icon: 'warning', intent: Intent.None},
        `" (double quote) character observed in query; if this is being used to ` +
          `define a string, please use ' (single quote) instead. Using double quotes ` +
          `can cause subtle problems which are very hard to debug.`,
      ),
    m(Editor, {
      text: tab.editorText,
      language: 'perfetto-sql',
      autofocus: true,
      completions: perfettoSqlCompletions,
      onSave: () => {},
      onUpdate: (text: string) => {
        tab.editorText = text;
        tabsState.markDirty();
      },
      onExecute: (query: string) => {
        setHistoryActiveTab(tab.materialize);
        tabsState.maybeAutoNameTab(tab.id, query);
        runner.run(tab, query);
      },
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Lazily build the data source for tabs restored from localStorage.
// ---------------------------------------------------------------------------

function attachAsyncDataSource(
  tab: BigTraceEditorTab,
  runner: QueryRunner,
): void {
  if (!tab.queryUuid) return;
  const queryClient = new BigtraceQueryClient(getBigtraceEndpoint());
  tab.queryClient = queryClient;
  if (!tab.materialize) {
    tab.dataSource = new InMemoryDataSource([]);
    return;
  }
  tab.dataSource = new BigtraceAsyncDataSource(
    tab.queryUuid,
    queryClient,
    () => tab.execution?.processedRows ?? 0,
    tab.lifecycle.signal,
  );
  tab.isLoading = true;
  runner.startPolling(tab);

  if (tab.queryResult === undefined) {
    tab.queryResult = {
      rows: [],
      columns: [],
      error: undefined,
      totalRowCount: 0,
      durationMs: 0,
      statementWithOutputCount: 0,
      statementCount: 1,
      lastStatementSql: tab.editorText,
      query: tab.editorText,
    };
  }
}
