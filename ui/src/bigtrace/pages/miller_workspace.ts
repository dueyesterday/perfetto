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

// The whole BigTrace UI as a single page: a cascading-column tree (Miller
// columns) that drills left -> right. Column 0 is the root (Scope / Queries /
// Runs / Schemas / Backend); selecting a node opens a column to its right with
// that node's children; the rightmost column holds the actual content (the
// query editor + streaming results, the trace grid, run history, a table
// schema, the backend form). Replaces the old side-nav-with-routed-pages.

import m from 'mithril';
import {Button} from '../../widgets/button';
import {Icon} from '../../widgets/icon';
import {Spinner} from '../../widgets/spinner';
import {EmptyState} from '../../widgets/empty_state';
import {TextInput} from '../../widgets/text_input';
import {showModal} from '../../widgets/modal';
import {QueryRunner} from '../query/query_runner';
import {QueryTabsState, effectiveTabSettings} from './query_tabs_state';
import type {BigTraceEditorTab} from './query_tabs_state';
import {EditorTabView, buildTabBindings} from './editor_tab_view';
import {BigtraceSettingsBar} from './bigtrace_settings_bar';
import {QueryHistoryComponent} from '../query/query_history';
import {TableList} from '../query/table_list';
import {sqlTablesLoader} from '../query/sql_tables';
import {scopeCount} from '../query/scope_count';
import {queryState} from '../query/query_state';
import {bigTraceSettingsStorage} from '../settings/bigtrace_settings_storage';
import {
  endpointStorage,
  getBigtraceEndpoint,
} from '../settings/endpoint_storage';

interface MillerWorkspaceAttrs {
  useBigtraceBackend?: boolean;
}

// Lets the topbar connection badge drill into the Backend node of the active
// workspace (single-page: there's no Settings route to navigate to anymore).
export let selectBackendNode: (() => void) | undefined;

type RootId = 'scope' | 'queries' | 'runs' | 'schemas' | 'backend';

interface RootDef {
  readonly id: RootId;
  readonly label: string;
  readonly icon: string;
  // Whether this root has an intermediate navigator column (a list of
  // children) before the content column. Scope/Backend go straight to content.
  readonly hasNavigator: boolean;
}

const ROOTS: ReadonlyArray<RootDef> = [
  {id: 'scope', label: 'Scope', icon: 'tune', hasNavigator: false},
  {id: 'queries', label: 'Queries', icon: 'code', hasNavigator: true},
  {id: 'runs', label: 'Runs', icon: 'history', hasNavigator: false},
  {id: 'schemas', label: 'Schemas', icon: 'schema', hasNavigator: false},
  {id: 'backend', label: 'Backend', icon: 'dns', hasNavigator: false},
];

export class MillerWorkspace
  implements m.ClassComponent<MillerWorkspaceAttrs>
{
  private useBigtraceBackend = false;
  private readonly tabsState = new QueryTabsState();
  private historyRefreshSignal = 0;
  private readonly runner = new QueryRunner({
    onHistoryChanged: () => {
      this.historyRefreshSignal++;
    },
    markDirty: () => this.tabsState.markDirty(),
  });

  // The drill path. selection[0] is the root; selection[1] (for 'queries')
  // is the selected query tab id.
  private selection: [RootId, string?] = ['queries'];
  // Pending endpoint edit (committed on Reload).
  private endpointDraft?: string;

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
    this.selection = ['queries', tab.id];
    this.tabsState.markDirty();
    if (startTime !== undefined && tab.execution) {
      tab.execution.startTime = startTime;
    }
    await this.runner.resumeFromHistory(tab, query);
  };

  oninit({attrs}: m.Vnode<MillerWorkspaceAttrs>) {
    this.useBigtraceBackend = attrs.useBigtraceBackend ?? false;
    if (this.useBigtraceBackend) {
      bigTraceSettingsStorage.loadSettings();
    }
    sqlTablesLoader.load();
    selectBackendNode = () => {
      this.selection = ['backend'];
      m.redraw();
    };
  }

  onremove() {
    selectBackendNode = undefined;
  }

  view(): m.Children {
    this.consumeInitialQuery();

    // Keep the active tab in sync with the selected query node so the runner,
    // polling, and "save to history" target the right tab.
    if (this.selection[0] === 'queries') {
      const tab = this.currentQueryTab();
      if (tab) {
        this.selection[1] = tab.id;
        this.tabsState.activeTabId = tab.id;
        // Keep the Scope badge live off the active tab's filter.
        scopeCount.request(effectiveTabSettings(tab), tab.traceFilters);
      }
    }

    const columns: m.Children[] = [this.renderRootColumn()];
    switch (this.selection[0]) {
      case 'queries':
        columns.push(this.renderQueriesNavigator());
        columns.push(this.renderQueryContent());
        break;
      case 'scope':
        columns.push(this.renderScopeContent());
        break;
      case 'runs':
        columns.push(this.renderRunsContent());
        break;
      case 'schemas':
        columns.push(this.renderSchemasContent());
        break;
      case 'backend':
        columns.push(this.renderBackendContent());
        break;
    }

    return m('.pf-bt-miller', columns);
  }

  // ----- Root column (column 0) -----

  private renderRootColumn(): m.Children {
    return m(
      '.pf-bt-miller__col.pf-bt-miller__col--root',
      m(
        '.pf-bt-miller__list',
        ROOTS.map((r) => this.renderRootNode(r)),
      ),
    );
  }

  private renderRootNode(r: RootDef): m.Children {
    const selected = this.selection[0] === r.id;
    return m(
      'button.pf-bt-miller__node',
      {
        className: selected ? 'pf-bt-miller__node--selected' : '',
        onclick: () => this.selectRoot(r.id),
      },
      m(Icon, {className: 'pf-bt-miller__node-icon', icon: r.icon}),
      m('span.pf-bt-miller__node-label', r.label),
      this.renderRootBadge(r.id),
      r.hasNavigator &&
        m(Icon, {className: 'pf-bt-miller__node-caret', icon: 'chevron_right'}),
    );
  }

  private renderRootBadge(id: RootId): m.Children {
    if (id === 'scope') {
      const c = scopeCount.matched;
      if (c === undefined) return undefined;
      return m('span.pf-bt-miller__badge', c.toLocaleString());
    }
    if (id === 'queries') {
      return m('span.pf-bt-miller__badge', String(this.tabsState.tabs.length));
    }
    if (id === 'schemas') {
      const modules = sqlTablesLoader.modules;
      if (!modules || sqlTablesLoader.isLoading) return undefined;
      return m('span.pf-bt-miller__badge', String(modules.listTables().length));
    }
    return undefined;
  }

  private selectRoot(id: RootId): void {
    if (id === 'queries') {
      const tab = this.currentQueryTab();
      this.selection = ['queries', tab?.id];
    } else {
      this.selection = [id];
    }
    this.tabsState.markDirty();
  }

  // ----- Queries navigator (column 1) -----

  private renderQueriesNavigator(): m.Children {
    const activeId = this.selection[1];
    return m(
      '.pf-bt-miller__col.pf-bt-miller__col--nav',
      m(
        '.pf-bt-miller__col-header',
        m('span.pf-bt-miller__col-title', 'Queries'),
        m(Button, {
          icon: 'add',
          title: 'New query',
          onclick: () => {
            const tab = this.tabsState.addNewTab();
            this.selection = ['queries', tab.id];
          },
        }),
      ),
      m(
        '.pf-bt-miller__list',
        this.tabsState.tabs.map((tab) => this.renderQueryNode(tab, activeId)),
      ),
    );
  }

  private renderQueryNode(
    tab: BigTraceEditorTab,
    activeId: string | undefined,
  ): m.Children {
    const selected = tab.id === activeId;
    return m(
      'button.pf-bt-miller__node.pf-bt-miller__node--query',
      {
        className: selected ? 'pf-bt-miller__node--selected' : '',
        onclick: () => {
          this.selection = ['queries', tab.id];
          this.tabsState.activeTabId = tab.id;
          this.tabsState.markDirty();
        },
      },
      m(Icon, {
        className: 'pf-bt-miller__node-icon',
        icon: tab.isLoading ? 'progress_activity' : 'code',
      }),
      m('span.pf-bt-miller__node-label', tab.title),
      this.tabsState.tabs.length > 1 &&
        m(Button, {
          icon: 'close',
          className: 'pf-bt-miller__node-close',
          title: 'Close query',
          onclick: (e: Event) => {
            e.stopPropagation();
            void this.closeQuery(tab);
          },
        }),
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
    this.selection = ['queries', next?.id];
    m.redraw();
  }

  // ----- Content columns (rightmost, flex-grow) -----

  private renderQueryContent(): m.Children {
    const tab = this.currentQueryTab();
    if (!tab) {
      return m(
        '.pf-bt-miller__col.pf-bt-miller__col--content',
        m(EmptyState, {title: 'No query selected', icon: 'code'}),
      );
    }
    return m(
      '.pf-bt-miller__col.pf-bt-miller__col--content',
      m(EditorTabView, {
        key: tab.id,
        tab,
        tabsState: this.tabsState,
        runner: this.runner,
        useBigtraceBackend: this.useBigtraceBackend,
      }),
    );
  }

  private renderScopeContent(): m.Children {
    const tab = this.currentQueryTab();
    return m(
      '.pf-bt-miller__col.pf-bt-miller__col--content.pf-bt-miller__col--pad',
      m('.pf-bt-miller__content-header', m('h2', 'Scope')),
      m(
        'p.pf-bt-miller__hint',
        'Which traces a query runs over. The query in the active tab will ' +
          'execute against the matched set.',
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

  private renderRunsContent(): m.Children {
    return m(
      '.pf-bt-miller__col.pf-bt-miller__col--content',
      m(QueryHistoryComponent, {
        className: 'pf-bt-miller__history',
        refreshSignal: this.historyRefreshSignal,
        openQuery: this.openQuery,
      }),
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
            this.selection = ['queries', tab.id];
          },
        });
      }
    }
    return m('.pf-bt-miller__col.pf-bt-miller__col--content', body);
  }

  private renderBackendContent(): m.Children {
    const current = getBigtraceEndpoint();
    const draft = this.endpointDraft ?? current;
    const changed = draft.trim() !== current.trim();
    return m(
      '.pf-bt-miller__col.pf-bt-miller__col--content.pf-bt-miller__col--pad',
      m('.pf-bt-miller__content-header', m('h2', 'Backend')),
      m(
        'p.pf-bt-miller__hint',
        'The BigTrace backend this UI talks to. Changing it reloads the app.',
      ),
      m(
        'label.pf-bt-miller__field',
        m('span.pf-bt-miller__field-label', 'Endpoint'),
        m(TextInput, {
          value: draft,
          placeholder: 'https://…',
          onInput: (value: string) => {
            this.endpointDraft = value;
          },
        }),
      ),
      m(
        '.pf-bt-miller__field-actions',
        m(Button, {
          label: changed ? 'Save & reload' : 'Reload',
          icon: 'refresh',
          disabled: draft.trim() === '',
          onclick: () => {
            const setting = endpointStorage.get('bigtraceEndpoint');
            if (setting && changed) setting.set(draft.trim());
            window.location.reload();
          },
        }),
      ),
    );
  }

  // ----- Helpers -----

  private currentQueryTab(): BigTraceEditorTab | undefined {
    const byId = this.tabsState.tabs.find((t) => t.id === this.selection[1]);
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
      this.selection = ['queries', activeTab.id];
    } else {
      const tab = this.tabsState.addNewTab(undefined, initialQuery);
      this.selection = ['queries', tab.id];
    }
    this.tabsState.markDirty();
  }
}
