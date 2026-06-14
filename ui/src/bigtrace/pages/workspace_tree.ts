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

// The whole BigTrace UI as a single page: the query WORKFLOW drawn as a
// left-to-right flow of connected nodes, each node a stage that holds its own
// content —
//
//   History ──▶ Trace selection ──▶ SQL editor ──▶ Results
//
// History (left) is the log of past runs; clicking one reloads the pipeline.
// Trace selection scopes which traces the query runs over. SQL editor holds the
// query tabs + editor. Results streams the rows. History + Trace selection can
// collapse to a slim node; editor + results stay open. General / default-trace
// settings live on the topbar button + commands, not in the graph.

import m from 'mithril';
import {Button} from '../../widgets/button';
import {Icon} from '../../widgets/icon';
import {Spinner} from '../../widgets/spinner';
import {Tabs, type TabsTab} from '../../widgets/tabs';
import {showModal} from '../../widgets/modal';
import {QueryRunner} from '../query/query_runner';
import {QueryTabsState, effectiveTabSettings} from './query_tabs_state';
import type {BigTraceEditorTab} from './query_tabs_state';
import {
  buildTabBindings,
  ensureTabWired,
  renderEditorPanel,
} from './editor_tab_view';
import {renderResultsPanel} from './results_panel';
import {BigtraceSettingsBar} from './bigtrace_settings_bar';
import {TraceSetPicker} from './trace_set_picker';
import {QueryHistoryComponent} from '../query/query_history';
import {scopeCount} from '../query/scope_count';
import {queryState} from '../query/query_state';
import {bigTraceSettingsStorage} from '../settings/bigtrace_settings_storage';
import {SettingsPage} from './settings_page';
import {historyStore} from '../query/history_store';
import {sqlTablesLoader} from '../query/sql_tables';
import {formatCompact, TERMINAL_STATUSES} from '../query/query_store';

interface WorkspaceAttrs {
  useBigtraceBackend?: boolean;
}

// Opens the settings as a modal. The topbar gear opens the full page; the Scope
// node's "Default trace settings" deep-links to just the trace sections (focus
// = 'trace'). `focus` undefined shows every section.
export function openBigtraceSettings(focus?: 'trace'): void {
  const title =
    focus === 'trace' ? 'Default trace settings' : 'BigTrace settings';
  showModal({
    title,
    content: () => m('.pf-bt-settings-modal', m(SettingsPage, {scope: focus})),
    buttons: [{text: 'Done'}],
  });
}

// Glanceable compact count for edge labels — drop the precision "~" prefix
// (the node already shows the exact value).
function compact(n: number): string {
  return formatCompact(n).replace('~', '');
}

type CollapsibleId = 'history' | 'scope';

export class BigtraceWorkspace implements m.ClassComponent<WorkspaceAttrs> {
  private useBigtraceBackend = false;
  private readonly tabsState = new QueryTabsState();
  private historyRefreshSignal = 0;
  private readonly runner = new QueryRunner({
    onHistoryChanged: () => {
      this.historyRefreshSignal++;
      historyStore.requestRefresh(this.historyRefreshSignal);
    },
    markDirty: () => this.tabsState.markDirty(),
  });

  // History starts slim (browse on demand); Trace selection starts open since
  // its scope summary is useful at a glance.
  private collapsed: Record<CollapsibleId, boolean> = {
    history: true,
    scope: false,
  };

  private readonly openQuery = async (
    query: string,
    uuid: string,
    materialize: boolean,
    forceNew?: boolean,
    limit?: number,
    startTime?: number,
  ): Promise<void> => {
    const tab = this.tabsState.addNewTab(
      undefined,
      query,
      limit,
      uuid,
      materialize,
      forceNew,
    );
    this.tabsState.activeTabId = tab.id;
    this.tabsState.markDirty();
    if (startTime !== undefined && tab.execution) {
      tab.execution.startTime = startTime;
    }
    await this.runner.resumeFromHistory(tab, query);
  };

  oninit({attrs}: m.Vnode<WorkspaceAttrs>) {
    this.useBigtraceBackend = attrs.useBigtraceBackend ?? false;
    if (this.useBigtraceBackend) {
      bigTraceSettingsStorage.loadSettings();
    }
    historyStore.requestRefresh(this.historyRefreshSignal);
    // Load the stdlib schema so the editor's SQL autocomplete has tables/columns.
    sqlTablesLoader.load();
  }

  view(): m.Children {
    this.consumeInitialQuery();
    const tab = this.tabsState.getActiveTab();
    if (tab) {
      ensureTabWired(tab, this.runner);
      scopeCount.request(effectiveTabSettings(tab), tab.traceFilters);
    }

    // Data-flow telemetry that rides on the connector edges: how many traces
    // feed the query, and how many rows it has produced.
    const streaming = Boolean(tab?.isLoading);
    const terminal =
      tab?.execution?.status !== undefined &&
      TERMINAL_STATUSES.has(tab.execution.status);
    const matched = scopeCount.matched;
    const rowCount =
      tab?.execution?.processedRows ?? tab?.queryResult?.rows.length ?? 0;
    const hasRun = Boolean(tab?.queryUuid) || rowCount > 0;

    return m('.pf-bt-flow', [
      this.renderHistoryNode(),
      // History → pipeline: a control link (you load a past run), not data flow.
      this.edge({control: true}),
      this.renderScopeNode(tab),
      // Trace selection → SQL editor: the matched trace set feeds the query.
      this.edge({
        label:
          matched !== undefined
            ? `${compact(matched)} trace${matched === 1 ? '' : 's'}`
            : undefined,
        flow: true,
      }),
      this.renderEditorNode(),
      // SQL editor → Results: rows the query produces; flows while streaming.
      this.edge({
        label:
          hasRun && (rowCount > 0 || terminal)
            ? `${compact(rowCount)} row${rowCount === 1 ? '' : 's'}`
            : undefined,
        flow: hasRun,
        live: streaming,
      }),
      this.renderResultsNode(tab),
    ]);
  }

  // ----- Flow scaffolding -----

  // A connector between two stage nodes: input/output ports + a curved line and
  // arrowhead, with an optional data-volume label above it. `flow` animates a
  // directional marching-dash (data moving rightward); `live` brightens it
  // while a query streams; `control` renders a dimmer dashed link (navigation,
  // not data flow).
  private edge(
    opts: {label?: string; flow?: boolean; live?: boolean; control?: boolean} = {},
  ): m.Children {
    const {label, flow, live, control} = opts;
    const cls = [
      flow && 'pf-bt-flow__edge--flow',
      live && 'pf-bt-flow__edge--live',
      control && 'pf-bt-flow__edge--control',
    ]
      .filter(Boolean)
      .join(' ');
    return m(
      '.pf-bt-flow__edge',
      {className: cls, 'aria-hidden': 'true'},
      m(
        'svg',
        {width: 76, height: 46, viewBox: '0 0 76 46', focusable: 'false'},
        label !== undefined &&
          m(
            'text.pf-bt-flow__edge-label',
            {x: 38, y: 13, 'text-anchor': 'middle'},
            label,
          ),
        // Output port (left node) and input port (right node).
        m('circle.pf-bt-flow__edge-port', {cx: 4, cy: 30, r: 3}),
        m('circle.pf-bt-flow__edge-port', {cx: 72, cy: 30, r: 3}),
        m('path.pf-bt-flow__edge-line', {d: 'M4,30 C28,30 48,30 68,30'}),
        m('path.pf-bt-flow__edge-arrow', {d: 'M63,25 L70,30 L63,35'}),
      ),
    );
  }

  private node(opts: {
    id: CollapsibleId | 'editor' | 'results';
    icon: string;
    title: string;
    badge?: m.Children;
    collapsible?: boolean;
    className?: string;
    body: m.Children;
  }): m.Children {
    const collapsible = opts.collapsible ?? false;
    const collapsed =
      collapsible && this.collapsed[opts.id as CollapsibleId];
    if (collapsed) {
      return m(
        'button.pf-bt-flownode.pf-bt-flownode--collapsed',
        {
          className: opts.className,
          title: `Expand ${opts.title}`,
          'aria-label': `Expand ${opts.title}`,
          'aria-expanded': 'false',
          onclick: () => (this.collapsed[opts.id as CollapsibleId] = false),
        },
        m(Icon, {className: 'pf-bt-flownode__cicon', icon: opts.icon}),
        m('span.pf-bt-flownode__vtitle', opts.title),
        opts.badge !== undefined &&
          m('span.pf-bt-flownode__cbadge', opts.badge),
      );
    }
    return m(
      '.pf-bt-flownode',
      {className: opts.className},
      m(
        '.pf-bt-flownode__header',
        m(Icon, {className: 'pf-bt-flownode__hicon', icon: opts.icon}),
        m('span.pf-bt-flownode__title', opts.title),
        opts.badge !== undefined &&
          m('span.pf-bt-flownode__badge', opts.badge),
        collapsible &&
          m(Button, {
            icon: 'left_panel_close',
            className: 'pf-bt-flownode__collapse',
            title: `Collapse ${opts.title}`,
            'aria-label': `Collapse ${opts.title}`,
            onclick: () => (this.collapsed[opts.id as CollapsibleId] = true),
          }),
      ),
      m('.pf-bt-flownode__body', opts.body),
    );
  }

  // ----- Stage nodes -----

  private renderHistoryNode(): m.Children {
    return this.node({
      id: 'history',
      icon: 'history',
      title: 'History',
      collapsible: true,
      className: 'pf-bt-flownode--history',
      body: m(QueryHistoryComponent, {
        className: 'pf-bt-flow__history',
        refreshSignal: this.historyRefreshSignal,
        openQuery: this.openQuery,
        activeUuid: this.tabsState.getActiveTab()?.queryUuid,
      }),
    });
  }

  private renderScopeNode(tab: BigTraceEditorTab | undefined): m.Children {
    const badge = scopeCount.matched?.toLocaleString();
    return this.node({
      id: 'scope',
      icon: 'tune',
      title: 'Trace selection',
      badge,
      collapsible: true,
      className: 'pf-bt-flownode--scope',
      body: tab
        ? this.renderScopeBody(tab)
        : m('.pf-bt-flow__empty', 'No active query'),
    });
  }

  private renderScopeBody(tab: BigTraceEditorTab): m.Children {
    const bindings = buildTabBindings(tab, this.tabsState);
    return m('.pf-bt-flow__scope', [
      this.renderScopeCount(tab),
      m(BigtraceSettingsBar, {tab, tabsState: this.tabsState, bindings}),
      this.renderTracePreview(),
      m('.pf-bt-flow__scope-actions', [
        m(TraceSetPicker, {bindings}),
        m(Button, {
          icon: 'open_in_full',
          label: 'Default settings',
          onclick: () => openBigtraceSettings('trace'),
        }),
      ]),
    ]);
  }

  // A live preview of the traces currently in scope (from the scope-count
  // probe's sample page) so the node shows *what* it runs over, not just a
  // count.
  private renderTracePreview(): m.Children {
    const sample = scopeCount.sample;
    const cols = scopeCount.sampleColumns;
    if (!sample || sample.length === 0) return undefined;
    const nameCol =
      cols?.find((c) => c === 'file_name') ??
      cols?.find((c) => c === 'file_path') ??
      cols?.[0];
    if (nameCol === undefined) return undefined;
    const matched = scopeCount.matched ?? sample.length;
    const shown = Math.min(sample.length, matched);
    return m('.pf-bt-trace-preview', [
      m(
        '.pf-bt-trace-preview__title',
        matched > shown
          ? `Matching traces · showing ${shown} of ${matched.toLocaleString()}`
          : 'Matching traces',
      ),
      m(
        '.pf-bt-trace-preview__list',
        sample.map((row, i) => {
          const full = String(row[nameCol] ?? '');
          const name = full.split('/').pop() || full;
          return m(
            '.pf-bt-trace-preview__item',
            {key: i, title: full},
            m(Icon, {
              className: 'pf-bt-trace-preview__icon',
              icon: 'description',
            }),
            m('span.pf-bt-trace-preview__name', name),
          );
        }),
      ),
    ]);
  }

  private renderScopeCount(tab: BigTraceEditorTab): m.Children {
    const {matched, total, error} = scopeCount;
    const hasFilter = tab.traceFilters.length > 0;
    let num: m.Children;
    let label: string;
    if (error) {
      num = '—';
      label = 'count unavailable';
    } else if (matched === undefined) {
      num = m(Spinner);
      label = 'counting traces…';
    } else {
      num = matched.toLocaleString();
      label =
        hasFilter && total !== undefined && total !== matched
          ? `of ${total.toLocaleString()} traces`
          : matched === 1
            ? 'trace'
            : 'traces';
    }
    return m(
      '.pf-bt-scope-count',
      {className: scopeCount.loading ? 'pf-bt-scope-count--loading' : ''},
      m('span.pf-bt-scope-count__num', num),
      m('span.pf-bt-scope-count__label', label),
    );
  }

  private renderEditorNode(): m.Children {
    const editorTabs: TabsTab[] = this.tabsState.tabs.map((tab) => ({
      key: tab.id,
      title: tab.title,
      leftIcon: tab.isLoading ? 'progress_activity' : 'code',
      closeButton: this.tabsState.tabs.length > 1,
      content: renderEditorPanel(
        tab,
        this.tabsState,
        this.runner,
        this.useBigtraceBackend,
      ),
    }));

    return this.node({
      id: 'editor',
      icon: 'code',
      title: 'SQL editor',
      className: 'pf-bt-flownode--editor',
      body: m(Tabs, {
        className: 'pf-bt-flow__editor-tabs',
        tabs: editorTabs,
        activeTabKey: this.tabsState.activeTabId,
        reorderable: true,
        onTabChange: (key) => {
          this.tabsState.activeTabId = key;
          this.tabsState.markDirty();
        },
        onTabRename: (key, title) => this.tabsState.renameTab(key, title),
        onTabClose: async (key) => this.closeTab(key),
        onTabReorder: (dragged, before) =>
          this.tabsState.reorderTab(dragged, before),
        newTabContent: m(Button, {
          icon: 'add',
          className: 'pf-tabs__new-tab-btn',
          title: 'New query',
          onclick: () => this.tabsState.addNewTab(),
        }),
      }),
    });
  }

  private renderResultsNode(tab: BigTraceEditorTab | undefined): m.Children {
    return this.node({
      id: 'results',
      icon: 'table_chart',
      title: 'Results',
      className: 'pf-bt-flownode--results',
      body: tab
        ? renderResultsPanel(tab, this.tabsState)
        : m('.pf-bt-flow__empty', 'Run a query to see results'),
    });
  }

  // ----- helpers -----

  private async closeTab(key: string): Promise<void> {
    if (this.tabsState.tabs.length <= 1) return;
    const tab = this.tabsState.tabs.find((t) => t.id === key);
    if (tab?.isLoading && !tab.materialize) {
      let confirmed = false;
      await showModal({
        title: 'Close query?',
        content: m(
          'div',
          'A query is still running. Closing this tab will lose the results.',
        ),
        buttons: [
          {text: 'Keep open'},
          {text: 'Close', primary: true, action: () => (confirmed = true)},
        ],
      });
      if (!confirmed) return;
    }
    this.tabsState.closeTab(key);
    m.redraw();
  }

  private consumeInitialQuery(): void {
    const initialQuery = queryState.initialQuery;
    if (initialQuery === undefined) return;
    queryState.initialQuery = undefined;
    const activeTab = this.tabsState.getActiveTab();
    if (activeTab && activeTab.editorText.trim() === '') {
      activeTab.editorText = initialQuery;
      this.tabsState.maybeAutoNameTab(activeTab.id, initialQuery);
    } else {
      this.tabsState.addNewTab(undefined, initialQuery);
    }
    this.tabsState.markDirty();
  }
}
