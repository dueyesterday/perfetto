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
import {Box} from '../../widgets/box';
import {Button, ButtonVariant} from '../../widgets/button';
import {Callout} from '../../widgets/callout';
import {Intent} from '../../widgets/common';
import {Editor} from '../../widgets/editor';
import {HotkeyGlyphs} from '../../widgets/hotkey_glyphs';
import {Icon} from '../../widgets/icon';
import {SplitPanel} from '../../widgets/split_panel';
import {Stack, StackAuto} from '../../widgets/stack';
import {Switch} from '../../widgets/switch';
import {TextInput} from '../../widgets/text_input';
import {InMemoryDataSource} from '../../components/widgets/datagrid/in_memory_data_source';
import type {Filter} from '../../components/widgets/datagrid/model';
import {endpointStorage} from '../settings/endpoint_storage';
import {BigtraceAsyncDataSource} from '../query/bigtrace_async_data_source';
import {setHistoryActiveTab} from '../query/query_history';
import {BigtraceQueryClient} from '../query/bigtrace_query_client';
import type {QueryRunner} from '../query/query_runner';
import {
  type BigTraceEditorTab,
  type QueryTabsState,
  deriveTitleFromQuery,
} from './query_tabs_state';
import {renderResultsPanel} from './results_panel';
import {bigTraceSettingsStorage} from '../settings/bigtrace_settings_storage';
import type {SettingCategory, SettingFilter} from '../settings/settings_types';
import {type SettingsBindings, SettingsPage} from './settings_page';

export interface EditorTabViewAttrs {
  readonly tab: BigTraceEditorTab;
  readonly tabsState: QueryTabsState;
  readonly runner: QueryRunner;
  readonly useBigtraceBackend: boolean;
}

// Thin orchestrator: split pane with editor on top, results on bottom.
// Heavy rendering lives in results_panel.ts and status_box.ts.
export class EditorTabView implements m.ClassComponent<EditorTabViewAttrs> {
  view({attrs}: m.Vnode<EditorTabViewAttrs>): m.Children {
    const {tab, tabsState, runner, useBigtraceBackend} = attrs;

    // Tabs reopened from history wire up their dataSource on first render.
    if (tab.queryUuid && !tab.dataSource) {
      attachAsyncDataSource(tab, runner);
    }

    if (tab.dataSource && tab.queryResult && tab.materialize && tab.execution) {
      tab.queryResult.totalRowCount = tab.execution.processedRows;
    }

    // Drawer prototype: the per-tab Bigtrace Settings panel sits as
    // the FIRST pane of an outer vertical SplitPanel; the editor +
    // results inner SplitPanel is the SECOND pane. The drawer's
    // open / closed state maps to the outer split's first-pane
    // height (0px when closed, persisted pixels when open). Same
    // SplitPanel widget the editor/results split below uses — so
    // the drag handle, look, and feel are consistent.
    const open = tab.settingsDrawerOpen;
    const drawerHeight = tab.settingsDrawerHeight ?? DEFAULT_DRAWER_HEIGHT_PX;
    const editorAndResults = m(SplitPanel, {
      direction: 'vertical',
      initialSplit: {percent: 22},
      minSize: 100,
      firstPanel: renderEditorPanel(tab, tabsState, runner, useBigtraceBackend),
      secondPanel: renderResultsPanel(tab, tabsState, runner),
    });
    return m('.pf-bt-editor-tab', [
      renderDrawerHeader(tab, tabsState),
      m(SplitPanel, {
        // `pf-bt-drawer-split` carries the open/closed class so
        // CSS can hide the SplitPanel's resize handle when the
        // drawer is closed (otherwise it'd float at the top of
        // the editor pane as a draggable bar with no visible
        // first panel above it).
        className: classNames(
          'pf-bt-drawer-split',
          !open && 'pf-bt-drawer-split--closed',
        ),
        direction: 'vertical',
        controlledPanel: 'first',
        split: {pixels: open ? drawerHeight : 0},
        // Floor only enforced while open. When closed the split is
        // forced to 0 by the controlled value above.
        minSize: open ? MIN_DRAWER_HEIGHT_PX : 0,
        onResize: (size: number) => {
          // Drag-driven resize only matters while open. (When
          // closed the handle is hidden in CSS, so onResize
          // shouldn't fire — but defensively ignore it.)
          if (!tab.settingsDrawerOpen) return;
          if (size === tab.settingsDrawerHeight) return;
          tab.settingsDrawerHeight = size;
          tabsState.markDirty();
        },
        firstPanel: m(SettingsPage, {
          bindings: buildTabBindings(tab, tabsState),
        }),
        secondPanel: editorAndResults,
      }),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Collapsible settings drawer above the editor. Closed → thin header
// with a summary of the current snapshot. Open → header + embedded
// SettingsPage (Trace Address section), pushing the editor down.
// ---------------------------------------------------------------------------

// Default height of the expanded drawer in pixels. ~40% of a
// typical laptop viewport. User-resizable via the outer
// SplitPanel's drag handle; persisted as tab.settingsDrawerHeight.
const DEFAULT_DRAWER_HEIGHT_PX = 360;
// SplitPanel `minSize` while the drawer is open — keeps the
// header + at least the first card visible.
const MIN_DRAWER_HEIGHT_PX = 120;

// Drawer header: toggle button on the left + summary + (no
// refresh — that lives next to the "Traces" title inside the
// SettingsPage body). The body itself is the first pane of the
// outer SplitPanel rendered in EditorTabView.view().
function renderDrawerHeader(
  tab: BigTraceEditorTab,
  tabsState: QueryTabsState,
): m.Children {
  const open = tab.settingsDrawerOpen;
  const summary = summarizeSnapshot(tab);
  return m(
    'button.pf-bt-settings-drawer__header',
    {
      title: open ? 'Collapse Bigtrace Settings' : 'Expand Bigtrace Settings',
      onclick: () => {
        tab.settingsDrawerOpen = !tab.settingsDrawerOpen;
        tabsState.markDirty();
      },
    },
    [
      // `unfold_more` / `unfold_less` — opposing-arrow pair that
      // reads as "expand/collapse" strongly, no overlap with the
      // Run Query play_arrow below.
      m(Icon, {
        icon: open ? 'unfold_less' : 'unfold_more',
        className: 'pf-bt-settings-drawer__chevron',
      }),
      m('span.pf-bt-settings-drawer__label', 'Bigtrace Settings'),
      m('span.pf-bt-settings-drawer__summary', summary),
    ],
  );
}

// One-line summary the closed drawer header shows. Schema-driven —
// diffs the per-tab snapshot against the current global defaults
// and surfaces the IDs of settings that differ, plus the trace-
// filter chip count and the count of attached metadata columns
// (those are first-class wire fields, not per-setting overrides).
// No setting IDs are hardcoded — the catalog is whatever the
// backend declared via /bigtrace_execution_config.
function summarizeSnapshot(tab: BigTraceEditorTab): string {
  const parts: string[] = [];
  const overrides = settingOverrideIds(tab);
  if (overrides.length > 0) {
    parts.push(formatOverrideList(overrides));
  }
  if (tab.traceFilter.length > 0) {
    // Two-piece filter summary: trace-match count (cached from the
    // SettingsPage data source's last fetch, if it ever ran for
    // this tab) + a compact rendering of the first chip's predicate
    // so the user sees both "how many" AND "filtered on what".
    const matchPart =
      tab.lastFilteredTraceCount !== undefined
        ? `${tab.lastFilteredTraceCount.toLocaleString()} trace${tab.lastFilteredTraceCount === 1 ? '' : 's'}`
        : 'active';
    const predicatePart = formatFilterPredicates(tab.traceFilter);
    parts.push(`filter: ${matchPart} · ${predicatePart}`);
  }
  if (tab.traceMetadataColumns.length > 0) {
    parts.push(
      `+${tab.traceMetadataColumns.length} metadata col${tab.traceMetadataColumns.length === 1 ? '' : 's'}`,
    );
  }
  return parts.length > 0 ? parts.join(' · ') : '(defaults)';
}

// Schema-agnostic: compare `tab.querySettings` against the current
// global defaults by setting_id and return the IDs whose values
// differ (or that the tab has but the defaults don't, or vice
// versa). Equality is on the values list serialized as JSON — the
// wire stores values as `string[]`, so JSON.stringify is a stable,
// catalog-independent equality check.
function settingOverrideIds(tab: BigTraceEditorTab): string[] {
  const defaults = bigTraceSettingsStorage.buildSettingFilters();
  const defaultJsonById = new Map<string, string>();
  for (const s of defaults) {
    defaultJsonById.set(s.settingId, JSON.stringify(s.values));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of tab.querySettings) {
    seen.add(s.settingId);
    const dj = defaultJsonById.get(s.settingId);
    if (dj === undefined || dj !== JSON.stringify(s.values)) {
      out.push(s.settingId);
    }
  }
  // A default value that the tab dropped is also an override.
  for (const [id] of defaultJsonById) {
    if (!seen.has(id)) out.push(id);
  }
  return out;
}

// Compact-but-informative list of override IDs. Shows up to 2
// names verbatim; anything more collapses to "+N more" so the
// header never wraps.
function formatOverrideList(ids: ReadonlyArray<string>): string {
  if (ids.length <= 2) return ids.join(', ');
  return `${ids.slice(0, 2).join(', ')}, +${ids.length - 2} more`;
}

// One-line rendering of the first filter chip's predicate, plus a
// "+N more" suffix when there are additional chips. Keeps the
// closed-drawer header from wrapping on long filter sets and
// surfaces the most-recently-added chip (which the user most likely
// just edited). Schema-agnostic — uses the chip's own `field` /
// `op` / `value` straight off the wire.
function formatFilterPredicates(filters: ReadonlyArray<Filter>): string {
  if (filters.length === 0) return '';
  const first = filters[0];
  const value =
    'value' in first && first.value !== undefined
      ? Array.isArray(first.value)
        ? `[${first.value.join(', ')}]`
        : JSON.stringify(first.value)
      : '';
  const head = `${first.field} ${first.op}${value ? ` ${value}` : ''}`;
  return filters.length > 1 ? `${head}, +${filters.length - 1} more` : head;
}

// Per-tab bindings passed to SettingsPage's embedded mode. Each
// getter returns a snapshot of the tab's current state; each setter
// mutates the tab in place and flips the tabs-state dirty flag.
// Execution-setting helpers maintain the SettingFilter[] wire shape
// on `tab.querySettings` — same shape the runner ships at submit
// time. `getEffectiveSettings` merges global defaults under per-tab
// overrides so /traces sees a complete settings array even before
// the user has edited anything in the sub-tab.
function buildTabBindings(
  tab: BigTraceEditorTab,
  tabsState: QueryTabsState,
): SettingsBindings {
  return {
    getEffectiveSettings: () => mergeSettingFilters(tab.querySettings),
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
    getTraceFilter: () => tab.traceFilter,
    setTraceFilter: (filters) => {
      tab.traceFilter = [...filters];
      tabsState.markDirty();
    },
    getTraceMetadataColumns: () => tab.traceMetadataColumns,
    setTraceMetadataColumns: (cols) => {
      tab.traceMetadataColumns = [...cols];
      tabsState.markDirty();
    },
    onTraceMatchCount: (count) => {
      if (tab.lastFilteredTraceCount === count) return;
      tab.lastFilteredTraceCount = count;
      tabsState.markDirty();
      // The drawer header renders BEFORE SettingsPage in this same
      // pass, so the header captures the OLD count. Schedule a
      // follow-up redraw so the next frame picks up the new value.
      // queueMicrotask keeps the redraw out of the current render
      // (Mithril rejects synchronous redraws-inside-render).
      queueMicrotask(() => m.redraw());
    },
  };
}

// Per-tab overrides win, then globals fill in for any setting the
// user hasn't touched on this tab's Settings sub-tab. Same merge
// the runner applies at submit — keeping the logic in one place
// so the data source (trace-list grid) and the runner can't drift.
function mergeSettingFilters(
  overrides: ReadonlyArray<SettingFilter>,
): SettingFilter[] {
  const byId = new Map<string, SettingFilter>();
  for (const s of bigTraceSettingsStorage.buildSettingFilters()) {
    byId.set(s.settingId, s);
  }
  for (const s of overrides) byId.set(s.settingId, s);
  return Array.from(byId.values());
}

// ---------------------------------------------------------------------------
// Editor panel: toolbar (Run/Cancel + limit + Materialize) and the editor.
// ---------------------------------------------------------------------------

function renderEditorPanel(
  tab: BigTraceEditorTab,
  tabsState: QueryTabsState,
  runner: QueryRunner,
  useBigtraceBackend: boolean,
): m.Children {
  return m('.pf-bt-query-page__editor-panel', [
    m(Box, {className: 'pf-bt-query-page__toolbar'}, [
      m(Stack, {orientation: 'horizontal'}, [
        tab.isLoading
          ? m(Button, {
              label: 'Cancel',
              icon: 'stop',
              intent: Intent.Warning,
              variant: ButtonVariant.Filled,
              onclick: () => runner.cancel(tab),
            })
          : m(Button, {
              label: 'Run Query',
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
        m(
          Stack,
          {orientation: 'horizontal', className: 'pf-bt-query-page__hotkeys'},
          'or press',
          m(HotkeyGlyphs, {hotkey: 'Mod+Enter'}),
        ),
        m(StackAuto),
        useBigtraceBackend && [
          m(Switch, {
            label: 'Persistent',
            title:
              'ON: results saved to History (Persistent tab) — reopen later. ' +
              'OFF: results shown inline and discarded when the tab closes.',
            checked: tab.materialize,
            disabled: tab.isLoading,
            onchange: (e: Event) => {
              tab.materialize = (e.target as HTMLInputElement).checked;
              setHistoryActiveTab(tab.materialize);
              tabsState.markDirty();
            },
          }),
          m('span.pf-bt-toolbar-divider', {'aria-hidden': 'true'}),
          m('span', 'Limit:'),
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
        ],
      ]),
    ]),
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
// Lazily build the async data source for tabs restored from localStorage.
// ---------------------------------------------------------------------------

function attachAsyncDataSource(
  tab: BigTraceEditorTab,
  runner: QueryRunner,
): void {
  if (!tab.queryUuid) return;
  const endpointSetting = endpointStorage.get('bigtraceEndpoint');
  const endpoint = endpointSetting ? (endpointSetting.get() as string) : '';
  const queryClient = new BigtraceQueryClient(endpoint);
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
