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
import {QueryHistoryComponent} from '../query/query_history';
import {scopeCount} from '../query/scope_count';
import {queryState} from '../query/query_state';
import {bigTraceSettingsStorage} from '../settings/bigtrace_settings_storage';
import {SettingsPage} from './settings_page';
import {historyStore} from '../query/history_store';

interface WorkspaceAttrs {
  useBigtraceBackend?: boolean;
}

// Opens the global settings (general + default trace settings) as a modal —
// invoked from the topbar button and the ⌘K commands. `focus` only retitles;
// the page shows every section.
export function openBigtraceSettings(focus?: 'general' | 'trace'): void {
  const title =
    focus === 'trace'
      ? 'Default trace settings'
      : focus === 'general'
        ? 'General settings'
        : 'BigTrace settings';
  showModal({
    title,
    content: () => m('.pf-bt-settings-modal', m(SettingsPage)),
    buttons: [{text: 'Done'}],
  });
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
  }

  view(): m.Children {
    this.consumeInitialQuery();
    const tab = this.tabsState.getActiveTab();
    if (tab) {
      ensureTabWired(tab, this.runner);
      scopeCount.request(effectiveTabSettings(tab), tab.traceFilters);
    }

    return m('.pf-bt-flow', [
      this.renderHistoryNode(),
      this.edge(),
      this.renderScopeNode(tab),
      this.edge(),
      this.renderEditorNode(),
      this.edge(true),
      this.renderResultsNode(tab),
    ]);
  }

  // ----- Flow scaffolding -----

  // A connector between two stage nodes: a curved accent line + arrowhead,
  // vertically centred. `live` adds the streaming pulse on the edge feeding
  // Results.
  private edge(live = false): m.Children {
    return m(
      '.pf-bt-flow__edge',
      {className: live ? 'pf-bt-flow__edge--live' : ''},
      m(
        'svg',
        {width: 34, height: 22, viewBox: '0 0 34 22'},
        m('path.pf-bt-flow__edge-line', {
          d: 'M0,11 C12,11 20,11 31,11',
        }),
        m('path.pf-bt-flow__edge-arrow', {d: 'M26,6 L33,11 L26,16'}),
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
        ? m('.pf-bt-flow__scope', [
            this.renderScopeCount(tab),
            m(BigtraceSettingsBar, {
              tab,
              tabsState: this.tabsState,
              bindings: buildTabBindings(tab, this.tabsState),
            }),
            this.renderTracePreview(),
            m(Button, {
              icon: 'open_in_full',
              label: 'Default trace settings',
              className: 'pf-bt-flow__scope-more',
              onclick: () => openBigtraceSettings('trace'),
            }),
          ])
        : m('.pf-bt-flow__empty', 'No active query'),
    });
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
