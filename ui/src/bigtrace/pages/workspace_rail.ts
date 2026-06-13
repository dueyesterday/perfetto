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

// The workspace rail: a single collapsible left rail that holds the whole
// pre/post-run context of the query workflow — Scope (which traces + what
// settings this run executes against), Runs (history of past/active runs), and
// the stdlib Schemas reference. Replaces the old separate routed settings page
// and the right-hand history sidebar.

import m from 'mithril';
import {Icon} from '../../widgets/icon';
import {EmptyState} from '../../widgets/empty_state';
import {Spinner} from '../../widgets/spinner';
import {BigtraceSettingsBar} from './bigtrace_settings_bar';
import {buildTabBindings} from './editor_tab_view';
import {QueryHistoryComponent} from '../query/query_history';
import {TableList} from '../query/table_list';
import {sqlTablesLoader} from '../query/sql_tables';
import {scopeCount} from '../query/scope_count';
import {
  type BigTraceEditorTab,
  type QueryTabsState,
  effectiveTabSettings,
} from './query_tabs_state';

type OpenQueryFn = (
  query: string,
  uuid: string,
  materialize: boolean,
  forceNew?: boolean,
  limit?: number,
  startTime?: number,
) => Promise<void>;

export interface WorkspaceRailAttrs {
  readonly activeTab?: BigTraceEditorTab;
  readonly tabsState: QueryTabsState;
  readonly historyRefreshSignal: number;
  readonly openQuery: OpenQueryFn;
  readonly onQueryTable: (tableName: string, query: string) => void;
}

type SectionId = 'scope' | 'runs' | 'schemas';

export class WorkspaceRail implements m.ClassComponent<WorkspaceRailAttrs> {
  // Schemas starts collapsed — it's a reference, not the day-to-day focus.
  private collapsed: Record<SectionId, boolean> = {
    scope: false,
    runs: false,
    schemas: true,
  };

  view({attrs}: m.Vnode<WorkspaceRailAttrs>): m.Children {
    return m('.pf-bt-rail', [
      this.section('scope', 'Scope', 'tune', this.renderScopeBadge(attrs), [
        this.renderScope(attrs),
      ]),
      this.section('runs', 'Runs', 'history', undefined, [
        this.renderRuns(attrs),
      ]),
      this.section('schemas', 'Schemas', 'schema', this.renderSchemasBadge(), [
        this.renderSchemas(attrs),
      ]),
    ]);
  }

  private section(
    id: SectionId,
    title: string,
    icon: string,
    badge: m.Children,
    body: m.Children,
  ): m.Children {
    const open = !this.collapsed[id];
    return m(
      '.pf-bt-rail__section',
      {
        className: `pf-bt-rail__section--${id} ${
          open ? 'pf-bt-rail__section--open' : ''
        }`,
      },
      m(
        'button.pf-bt-rail__header',
        {onclick: () => (this.collapsed[id] = !this.collapsed[id])},
        m(Icon, {
          className: 'pf-bt-rail__chevron',
          icon: open ? 'expand_more' : 'chevron_right',
        }),
        m(Icon, {className: 'pf-bt-rail__header-icon', icon}),
        m('span.pf-bt-rail__title', title),
        badge && m('span.pf-bt-rail__badge', badge),
      ),
      open && m('.pf-bt-rail__body', body),
    );
  }

  private renderScopeBadge(attrs: WorkspaceRailAttrs): m.Children {
    const tab = attrs.activeTab;
    if (!tab) return undefined;
    const c = scopeCount.matched;
    if (c !== undefined) return `${c.toLocaleString()} traces`;
    const n = tab.traceFilters.length;
    return n > 0 ? `${n} filter${n === 1 ? '' : 's'}` : undefined;
  }

  private renderScope(attrs: WorkspaceRailAttrs): m.Children {
    const tab = attrs.activeTab;
    if (!tab) {
      return m(EmptyState, {title: 'No active query', icon: 'tune'});
    }
    // Live feedback: how many traces the current filter actually matches.
    scopeCount.request(effectiveTabSettings(tab), tab.traceFilters);
    return [
      this.renderScopeCount(tab),
      // The existing chip strip renders/edits the trace filter, limit & order.
      m(BigtraceSettingsBar, {
        tab,
        tabsState: attrs.tabsState,
        bindings: buildTabBindings(tab, attrs.tabsState),
      }),
    ];
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

  private renderRuns(attrs: WorkspaceRailAttrs): m.Children {
    return m(QueryHistoryComponent, {
      className: 'pf-bt-rail__history',
      refreshSignal: attrs.historyRefreshSignal,
      openQuery: attrs.openQuery,
    });
  }

  private renderSchemasBadge(): m.Children {
    const modules = sqlTablesLoader.modules;
    if (!modules || sqlTablesLoader.isLoading) return undefined;
    return String(modules.listTables().length);
  }

  private renderSchemas(attrs: WorkspaceRailAttrs): m.Children {
    if (sqlTablesLoader.loadError) {
      return m(EmptyState, {
        title: `Failed to load: ${sqlTablesLoader.loadError}`,
        icon: 'error',
      });
    }
    const modules = sqlTablesLoader.modules;
    if (sqlTablesLoader.isLoading || !modules) {
      return m(EmptyState, {title: 'Loading…', icon: 'hourglass_empty'}, m(Spinner));
    }
    return m(TableList, {sqlModules: modules, onQueryTable: attrs.onQueryTable});
  }
}
