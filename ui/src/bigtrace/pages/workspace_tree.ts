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

// The whole BigTrace UI as a single page: a persistent expandable tree on the
// left + a stable content pane on the right. The tree (Queries / History /
// Scope / Schemas / Settings) is always visible and branches with connector
// lines, so history and run-config stay reachable while you work on a query.
// Selecting a leaf loads it into the content pane; expanding a branch reveals
// its children inline (it does NOT swap the content).

import m from 'mithril';
import {Button} from '../../widgets/button';
import {Icon} from '../../widgets/icon';
import {Spinner} from '../../widgets/spinner';
import {EmptyState} from '../../widgets/empty_state';
import {TextInput} from '../../widgets/text_input';
import {SplitPanel} from '../../widgets/split_panel';
import {showModal} from '../../widgets/modal';
import {QueryRunner} from '../query/query_runner';
import {QueryTabsState, effectiveTabSettings} from './query_tabs_state';
import type {BigTraceEditorTab} from './query_tabs_state';
import {EditorTabView, buildTabBindings} from './editor_tab_view';
import {BigtraceSettingsBar} from './bigtrace_settings_bar';
import {TableList} from '../query/table_list';
import {sqlTablesLoader} from '../query/sql_tables';
import {scopeCount} from '../query/scope_count';
import {queryState} from '../query/query_state';
import {bigTraceSettingsStorage} from '../settings/bigtrace_settings_storage';
import {SettingsPage} from './settings_page';
import {historyStore} from '../query/history_store';
import {formatCompact, statusDisplayLabel} from '../query/query_store';
import type {QueryExecution} from '../query/query_store';

interface WorkspaceAttrs {
  useBigtraceBackend?: boolean;
}

// The content pane shows exactly one of these at a time.
type ContentKind = 'query' | 'scope' | 'schemas' | 'settings';

// Lets the topbar connection badge open the global Settings in the content
// pane (single-page: there's no Settings route to navigate to anymore).
export let openBigtraceSettings: (() => void) | undefined;

// How many recent runs to surface inline under the History branch.
const HISTORY_PREVIEW = 12;

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

  // Which branches are expanded in the tree.
  private expanded: Record<'queries' | 'history', boolean> = {
    queries: true,
    history: true,
  };
  // What the content pane shows.
  private content: {kind: ContentKind; queryId?: string} = {kind: 'query'};
  private historySearch = '';

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
    this.content = {kind: 'query', queryId: tab.id};
    this.expanded.queries = true;
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
    sqlTablesLoader.load();
    historyStore.requestRefresh(this.historyRefreshSignal);
    openBigtraceSettings = () => {
      this.content = {kind: 'settings'};
      m.redraw();
    };
  }

  onremove() {
    openBigtraceSettings = undefined;
  }

  view(): m.Children {
    this.consumeInitialQuery();
    // Keep the Scope badge / panel live off the active query's filter.
    const activeTab = this.currentQueryTab();
    if (activeTab) {
      scopeCount.request(effectiveTabSettings(activeTab), activeTab.traceFilters);
    }

    return m(
      '.pf-bt-workspace',
      m(SplitPanel, {
        direction: 'horizontal',
        initialSplit: {percent: 23},
        controlledPanel: 'first',
        minSize: 260,
        firstPanel: this.renderTree(),
        secondPanel: this.renderContent(),
      }),
    );
  }

  // ----- Tree (left) -----

  private renderTree(): m.Children {
    return m('.pf-bt-tree', [
      this.renderBranch(
        'queries',
        'Queries',
        'code',
        String(this.tabsState.tabs.length),
        () => this.renderQueryChildren(),
      ),
      this.renderBranch('history', 'History', 'history', undefined, () =>
        this.renderHistoryChildren(),
      ),
      this.renderLeaf('scope', 'Scope', 'tune', this.scopeBadge()),
      this.renderLeaf('schemas', 'Schemas', 'schema', this.schemasBadge()),
      this.renderLeaf('settings', 'Settings', 'settings', undefined),
    ]);
  }

  private renderBranch(
    key: 'queries' | 'history',
    label: string,
    icon: string,
    badge: m.Children,
    children: () => m.Children,
  ): m.Children {
    const open = this.expanded[key];
    return m('.pf-bt-tree__branch', [
      m(
        'button.pf-bt-tree__node.pf-bt-tree__node--branch',
        {
          className: open ? 'pf-bt-tree__node--open' : '',
          onclick: () => {
            this.expanded[key] = !this.expanded[key];
          },
        },
        m(Icon, {
          className: 'pf-bt-tree__twisty',
          icon: open ? 'expand_more' : 'chevron_right',
        }),
        m(Icon, {className: 'pf-bt-tree__node-icon', icon}),
        m('span.pf-bt-tree__node-label', label),
        badge !== undefined && m('span.pf-bt-tree__badge', badge),
      ),
      open && m('.pf-bt-tree__children', children()),
    ]);
  }

  private renderLeaf(
    kind: ContentKind,
    label: string,
    icon: string,
    badge: m.Children,
  ): m.Children {
    const selected = this.content.kind === kind;
    return m(
      'button.pf-bt-tree__node.pf-bt-tree__node--leaf',
      {
        className: selected ? 'pf-bt-tree__node--selected' : '',
        onclick: () => {
          this.content = {kind};
        },
      },
      m('span.pf-bt-tree__twisty-spacer'),
      m(Icon, {className: 'pf-bt-tree__node-icon', icon}),
      m('span.pf-bt-tree__node-label', label),
      badge !== undefined && m('span.pf-bt-tree__badge', badge),
    );
  }

  private renderQueryChildren(): m.Children {
    const activeId =
      this.content.kind === 'query' ? this.currentQueryTab()?.id : undefined;
    return [
      ...this.tabsState.tabs.map((tab) =>
        this.renderQueryNode(tab, activeId),
      ),
      m(
        'button.pf-bt-tree__node.pf-bt-tree__node--child.pf-bt-tree__node--action',
        {
          onclick: () => {
            const tab = this.tabsState.addNewTab();
            this.content = {kind: 'query', queryId: tab.id};
            this.tabsState.activeTabId = tab.id;
          },
        },
        m(Icon, {className: 'pf-bt-tree__node-icon', icon: 'add'}),
        m('span.pf-bt-tree__node-label', 'New query'),
      ),
    ];
  }

  private renderQueryNode(
    tab: BigTraceEditorTab,
    activeId: string | undefined,
  ): m.Children {
    const selected = tab.id === activeId;
    return m(
      'button.pf-bt-tree__node.pf-bt-tree__node--child',
      {
        className: selected ? 'pf-bt-tree__node--selected' : '',
        onclick: () => {
          this.content = {kind: 'query', queryId: tab.id};
          this.tabsState.activeTabId = tab.id;
          this.tabsState.markDirty();
        },
      },
      m(Icon, {
        className: 'pf-bt-tree__node-icon',
        icon: tab.isLoading ? 'progress_activity' : 'code',
      }),
      m('span.pf-bt-tree__node-label', tab.title),
      this.tabsState.tabs.length > 1 &&
        m(Button, {
          icon: 'close',
          className: 'pf-bt-tree__node-close',
          title: 'Close query',
          onclick: (e: Event) => {
            e.stopPropagation();
            void this.closeQuery(tab);
          },
        }),
    );
  }

  private renderHistoryChildren(): m.Children {
    if (historyStore.isLoading && historyStore.history.length === 0) {
      return m('.pf-bt-tree__note', m(Spinner), ' Loading runs…');
    }
    if (historyStore.error) {
      return m('.pf-bt-tree__note', 'Failed to load runs');
    }
    const all = historyStore.history;
    const q = this.historySearch.trim().toLowerCase();
    const filtered = q
      ? all.filter((h) => (h.perfettoSql || '').toLowerCase().includes(q))
      : all;
    if (all.length === 0) {
      return m('.pf-bt-tree__note', 'No runs yet');
    }
    return [
      m(
        '.pf-bt-tree__search',
        m(TextInput, {
          leftIcon: 'search',
          placeholder: 'Search runs…',
          value: this.historySearch,
          onInput: (v: string) => {
            this.historySearch = v;
          },
        }),
      ),
      ...filtered.slice(0, HISTORY_PREVIEW).map((e) => this.renderRunNode(e)),
      filtered.length > HISTORY_PREVIEW &&
        m(
          '.pf-bt-tree__note',
          `+${filtered.length - HISTORY_PREVIEW} more — refine the search`,
        ),
    ];
  }

  private renderRunNode(entry: QueryExecution): m.Children {
    const status = (entry.status ?? 'UNKNOWN').toLowerCase().replace(/_/g, '-');
    const sql = (entry.perfettoSql || '(empty)').replace(/\s+/g, ' ').trim();
    return m(
      'button.pf-bt-tree__node.pf-bt-tree__node--child.pf-bt-tree__node--run',
      {
        title: `${statusDisplayLabel(entry.status ?? 'UNKNOWN')} · ${sql}`,
        onclick: () => {
          if (!entry.uuid) return;
          void this.openQuery(
            entry.perfettoSql || '',
            entry.uuid,
            Boolean(entry.materialized),
            false,
            entry.limit,
            entry.startTime,
          );
        },
      },
      m('span.pf-bt-tree__run-dot', {
        className: `pf-bt-status-${status}`,
      }),
      m('span.pf-bt-tree__node-label', sql),
      m(
        'span.pf-bt-tree__run-rows',
        formatCompact(entry.processedRows ?? 0),
      ),
    );
  }

  private async closeQuery(tab: BigTraceEditorTab): Promise<void> {
    if (this.tabsState.tabs.length <= 1) return;
    if (tab.isLoading && !tab.materialize) {
      let confirmed = false;
      await showModal({
        title: 'Close query?',
        content: m(
          'div',
          'A query is still running. Closing it will lose the results.',
        ),
        buttons: [
          {text: 'Keep open'},
          {
            text: 'Close',
            primary: true,
            action: () => {
              confirmed = true;
            },
          },
        ],
      });
      if (!confirmed) return;
    }
    this.tabsState.closeTab(tab.id);
    const next = this.currentQueryTab();
    this.content = {kind: 'query', queryId: next?.id};
    m.redraw();
  }

  // ----- Content pane (right) -----

  private renderContent(): m.Children {
    switch (this.content.kind) {
      case 'query':
        return this.renderQueryContent();
      case 'scope':
        return this.renderScopeContent();
      case 'schemas':
        return this.renderSchemasContent();
      case 'settings':
        return m('.pf-bt-workspace__content.pf-bt-workspace__content--settings', [
          m('.pf-bt-content-header', m('h2', 'Settings'), m(
            'span.pf-bt-content-sub',
            'Defaults applied to new queries.',
          )),
          m('.pf-bt-settings-embedded', m(SettingsPage)),
        ]);
    }
  }

  private renderQueryContent(): m.Children {
    const tab = this.currentQueryTab();
    if (!tab) {
      return m(
        '.pf-bt-workspace__content',
        m(EmptyState, {title: 'No query selected', icon: 'code'}),
      );
    }
    return m(
      '.pf-bt-workspace__content',
      m(EditorTabView, {
        key: tab.id,
        tab,
        tabsState: this.tabsState,
        runner: this.runner,
        useBigtraceBackend: this.useBigtraceBackend,
        onOpenScope: () => {
          this.content = {kind: 'scope'};
        },
      }),
    );
  }

  private renderScopeContent(): m.Children {
    const tab = this.currentQueryTab();
    return m(
      '.pf-bt-workspace__content.pf-bt-workspace__content--pad',
      m(
        '.pf-bt-content-header',
        m('h2', 'Scope'),
        m(
          'span.pf-bt-content-sub',
          'Which traces the active query runs over.',
        ),
      ),
      tab
        ? [
            this.renderScopeCount(tab),
            m(BigtraceSettingsBar, {
              tab,
              tabsState: this.tabsState,
              bindings: buildTabBindings(tab, this.tabsState),
            }),
          ]
        : m(EmptyState, {title: 'No active query', icon: 'tune'}),
    );
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

  private renderSchemasContent(): m.Children {
    let body: m.Children;
    if (sqlTablesLoader.loadError) {
      body = m(EmptyState, {
        title: `Failed to load: ${sqlTablesLoader.loadError}`,
        icon: 'error',
      });
    } else {
      const modules = sqlTablesLoader.modules;
      if (sqlTablesLoader.isLoading || !modules) {
        body = m(
          EmptyState,
          {title: 'Loading…', icon: 'hourglass_empty'},
          m(Spinner),
        );
      } else {
        body = m(TableList, {
          sqlModules: modules,
          onQueryTable: (tableName: string, query: string) => {
            const tab = this.tabsState.addNewTab(tableName, query);
            this.content = {kind: 'query', queryId: tab.id};
            this.tabsState.activeTabId = tab.id;
          },
        });
      }
    }
    return m('.pf-bt-workspace__content', body);
  }

  // ----- Badges / helpers -----

  private scopeBadge(): m.Children {
    const c = scopeCount.matched;
    return c === undefined ? undefined : c.toLocaleString();
  }

  private schemasBadge(): m.Children {
    const modules = sqlTablesLoader.modules;
    if (!modules || sqlTablesLoader.isLoading) return undefined;
    return String(modules.listTables().length);
  }

  private currentQueryTab(): BigTraceEditorTab | undefined {
    const byId =
      this.content.kind === 'query'
        ? this.tabsState.tabs.find((t) => t.id === this.content.queryId)
        : undefined;
    return byId ?? this.tabsState.getActiveTab();
  }

  private consumeInitialQuery(): void {
    const initialQuery = queryState.initialQuery;
    if (initialQuery === undefined) return;
    queryState.initialQuery = undefined;
    const activeTab = this.tabsState.getActiveTab();
    if (activeTab && activeTab.editorText.trim() === '') {
      activeTab.editorText = initialQuery;
      this.tabsState.maybeAutoNameTab(activeTab.id, initialQuery);
      this.content = {kind: 'query', queryId: activeTab.id};
    } else {
      const tab = this.tabsState.addNewTab(undefined, initialQuery);
      this.content = {kind: 'query', queryId: tab.id};
    }
    this.tabsState.markDirty();
  }
}
