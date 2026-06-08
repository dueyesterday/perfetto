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
import {CardStack} from '../../widgets/card';
import {EmptyState} from '../../widgets/empty_state';
import {Spinner} from '../../widgets/spinner';
import {
  PopupMultiSelect,
  type MultiSelectDiff,
  type MultiSelectOption,
} from '../../widgets/multiselect';
import type {Filter} from '../../components/widgets/datagrid/model';
import {
  BigtraceQueryClient,
  QueryCancelledError,
  type TraceColumnDescriptor,
} from '../query/bigtrace_query_client';
import {bigTraceSettingsStorage} from '../settings/bigtrace_settings_storage';
import {endpointStorage} from '../settings/endpoint_storage';
import {traceFilterState} from '../settings/trace_filter_state';
import {traceQueryColumnsState} from '../settings/trace_query_columns_state';
import type {BigTraceEditorTab, QueryTabsState} from './query_tabs_state';
import {renderBigTraceSettingCard} from './settings_card';

export interface BigtraceQuerySettingsTabAttrs {
  readonly tab: BigTraceEditorTab;
  readonly tabsState: QueryTabsState;
}

// Human-readable one-line summary of a trace filter, for the read-only views.
function summarizeFilters(filters: readonly Filter[]): string {
  if (filters.length === 0) return 'All traces';
  return filters
    .map((f) => {
      if ('value' in f) {
        const v = (f as {value: unknown}).value;
        const val = Array.isArray(v) ? `[${v.join(', ')}]` : String(v);
        return `${f.field} ${f.op} ${val}`;
      }
      return `${f.field} ${f.op}`;
    })
    .join(' AND ');
}

// The per-tab "Bigtrace Settings" sub-tab on the query page. Two jobs (per the
// wire contract): edit the settings the NEXT run will use, and show what THIS
// tab's last run used (the frozen submit-time snapshot).
export class BigtraceQuerySettingsTab
  implements m.ClassComponent<BigtraceQuerySettingsTabAttrs>
{
  private schemaColumns: TraceColumnDescriptor[] = [];
  private schemaLoading = false;
  private loadedEndpoint?: string;
  private readonly abort = new AbortController();

  onremove() {
    this.abort.abort();
  }

  private endpoint(): string {
    const setting = endpointStorage.get('bigtraceEndpoint');
    return setting ? (setting.get() as string) ?? '' : '';
  }

  // Load the trace-metadata column catalog so the "attach metadata" picker
  // knows its options. Guarded so it fires once per endpoint.
  private maybeLoadSchema(endpoint: string): void {
    if (endpoint === '' || endpoint === this.loadedEndpoint) return;
    this.loadedEndpoint = endpoint;
    this.schemaLoading = true;
    const client = new BigtraceQueryClient(endpoint);
    client
      .listTraceMetadataSchema(
        bigTraceSettingsStorage.buildSettingFilters(),
        this.abort.signal,
      )
      .then((resp) => {
        this.schemaColumns = [...resp.columns];
      })
      .catch((e) => {
        if (e instanceof QueryCancelledError) return;
        // The picker just stays empty on failure; the trace grid on the
        // Settings page surfaces the detailed error.
        this.schemaColumns = [];
      })
      .finally(() => {
        this.schemaLoading = false;
        m.redraw();
      });
  }

  view({attrs}: m.Vnode<BigtraceQuerySettingsTabAttrs>): m.Children {
    const {tab} = attrs;
    const endpoint = this.endpoint();
    if (endpoint === '') {
      return m(EmptyState, {
        title: 'Set the BigTrace Endpoint in Settings to configure a query.',
        icon: 'travel_explore',
        fillHeight: true,
      });
    }
    this.maybeLoadSchema(endpoint);

    return m('.pf-bt-query-settings', [
      this.renderNextRunSection(),
      this.renderSnapshotSection(tab),
    ]);
  }

  private renderNextRunSection(): m.Children {
    const settings = bigTraceSettingsStorage.getAllSettings();
    return m('section.pf-bt-query-settings__section', [
      m('h3.pf-bt-query-settings__title', 'Settings for the next run'),
      bigTraceSettingsStorage.isExecConfigLoading && settings.length === 0
        ? m(
            EmptyState,
            {title: 'Loading settings...', icon: 'hourglass_empty'},
            m(Spinner),
          )
        : m(
            CardStack,
            settings.map((s) => renderBigTraceSettingCard(s)),
          ),
      m('.pf-bt-query-settings__row', [
        m('span.pf-bt-query-settings__label', 'Trace selection'),
        m(
          'span.pf-bt-query-settings__value',
          summarizeFilters(traceFilterState.get()),
        ),
        m(
          'span.pf-bt-query-settings__hint',
          'Edit on the Settings page trace grid.',
        ),
      ]),
      this.renderMetadataPicker(),
    ]);
  }

  private renderMetadataPicker(): m.Children {
    if (this.schemaColumns.length === 0) {
      return this.schemaLoading
        ? m('.pf-bt-query-settings__row', m(Spinner))
        : null;
    }
    const selected = new Set(traceQueryColumnsState.get());
    const order = this.schemaColumns.map((c) => c.name);
    const options: MultiSelectOption[] = this.schemaColumns.map((c) => ({
      id: c.name,
      name: c.name,
      checked: selected.has(c.name),
      details: c.description,
    }));
    return m('.pf-bt-query-settings__row', [
      m('span.pf-bt-query-settings__label', 'Attach metadata to results'),
      m(PopupMultiSelect, {
        label: 'Columns',
        icon: 'dataset',
        showNumSelected: true,
        options,
        onChange: (diffs: MultiSelectDiff[]) => {
          const next = new Set(traceQueryColumnsState.get());
          for (const {id, checked} of diffs) {
            checked ? next.add(id) : next.delete(id);
          }
          // Persist in schema declaration order so the wire is stable.
          traceQueryColumnsState.set(order.filter((n) => next.has(n)));
        },
      }),
    ]);
  }

  private renderSnapshotSection(tab: BigTraceEditorTab): m.Children {
    // Only meaningful once the tab has run (or was reopened from history).
    if (tab.queryUuid === undefined) return null;
    const dirSetting = tab.querySettings.find(
      (s) => s.settingId === 'trace_directory',
    );
    const rows: Array<[string, string]> = [
      ['Traces', summarizeFilters(tab.traceFilters)],
      [
        'Attached metadata',
        tab.traceMetadataColumns.length > 0
          ? tab.traceMetadataColumns.join(', ')
          : 'None',
      ],
      [
        'Processing order',
        tab.traceOrderBy !== '' ? tab.traceOrderBy : 'Default',
      ],
    ];
    if (dirSetting && dirSetting.values.length > 0) {
      rows.push(['Trace directory', dirSetting.values.join(', ')]);
    }
    return m('section.pf-bt-query-settings__section', [
      m('h3.pf-bt-query-settings__title', 'This query ran with'),
      m(
        'dl.pf-bt-query-settings__snapshot',
        rows.flatMap(([label, value]) => [m('dt', label), m('dd', value)]),
      ),
    ]);
  }
}
