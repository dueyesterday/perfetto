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
import {DataGrid} from '../../components/widgets/datagrid/datagrid';
import type {Column, Filter} from '../../components/widgets/datagrid/model';
import type {
  ColumnSchema,
  ColumnType,
  SchemaRegistry,
} from '../../components/widgets/datagrid/datagrid_schema';
import {EmptyState} from '../../widgets/empty_state';
import {Spinner} from '../../widgets/spinner';
import {Callout} from '../../widgets/callout';
import {Intent} from '../../widgets/common';
import {Button, ButtonVariant} from '../../widgets/button';
import {
  BigtraceQueryClient,
  QueryCancelledError,
  type TraceColumnDescriptor,
} from '../query/bigtrace_query_client';
import {BigtraceTraceListDataSource} from '../query/bigtrace_trace_list_data_source';
import {traceFilterState} from '../settings/trace_filter_state';
import {traceColumnsState} from '../settings/trace_columns_state';
import {bigTraceSettingsStorage} from '../settings/bigtrace_settings_storage';
import {endpointStorage} from '../settings/endpoint_storage';
import type {SettingFilter} from '../settings/settings_types';

// SQL types whose column-filter menu should offer numeric comparisons. The
// schema's `type` is otherwise informational (the wire is always-strings).
function columnTypeOf(sqlType: string): ColumnType {
  return /INT|REAL|DOUBLE|FLOAT|NUM|DEC|SERIAL/i.test(sqlType)
    ? 'quantitative'
    : 'text';
}

// The trace-selection grid on the Settings page. Lets the user filter / sort /
// pick columns over the backend's trace metadata; the active filter IS the set
// of traces a query runs over (the "implicit selection" model).
//
// Self-contained: it owns the HTTP client + data source (rebuilt when the
// endpoint changes), loads the column catalog from /trace_metadata_schema, and
// drives a DataGrid in controlled mode against `traceFilterState` /
// `traceColumnsState`.
export class TraceSelectionGrid implements m.ClassComponent {
  private client?: BigtraceQueryClient;
  private dataSource?: BigtraceTraceListDataSource;
  private schemaColumns: TraceColumnDescriptor[] = [];
  private schemaLoading = false;
  private schemaError?: string;
  // endpoint + settings key the data source / schema currently bind to.
  private boundEndpoint?: string;
  private loadedKey?: string;
  private readonly abort = new AbortController();

  onremove() {
    this.abort.abort();
  }

  private endpoint(): string {
    const setting = endpointStorage.get('bigtraceEndpoint');
    return setting ? (setting.get() as string) ?? '' : '';
  }

  private settings(): SettingFilter[] {
    return bigTraceSettingsStorage.buildSettingFilters();
  }

  // The client binds to one endpoint at construction, so a new endpoint needs
  // a fresh client + data source. Cheap and idempotent per endpoint.
  private ensureDataSource(endpoint: string): void {
    if (this.boundEndpoint === endpoint && this.dataSource) return;
    this.boundEndpoint = endpoint;
    this.loadedKey = undefined;
    this.schemaColumns = [];
    this.schemaError = undefined;
    this.client = new BigtraceQueryClient(endpoint);
    this.dataSource = new BigtraceTraceListDataSource(
      this.client,
      () => this.settings(),
      this.abort.signal,
    );
  }

  // Load /trace_metadata_schema, keyed on endpoint + settings (the schema can
  // vary by source). Guarded so it fires once per key — safe to call from
  // view().
  private maybeLoadSchema(endpoint: string): void {
    const key = `${endpoint}|${JSON.stringify(this.settings())}`;
    if (key === this.loadedKey || this.schemaLoading) return;
    this.loadedKey = key;
    this.schemaLoading = true;
    this.schemaError = undefined;
    this.client!.listTraceMetadataSchema(this.settings(), this.abort.signal)
      .then((resp) => {
        this.schemaColumns = [...resp.columns];
      })
      .catch((e) => {
        if (e instanceof QueryCancelledError) return;
        this.schemaError = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        this.schemaLoading = false;
        m.redraw();
      });
  }

  private retrySchema(): void {
    this.loadedKey = undefined;
    m.redraw();
  }

  private buildSchemaRegistry(): SchemaRegistry {
    const columnSchema: ColumnSchema = {};
    for (const c of this.schemaColumns) {
      columnSchema[c.name] = {columnType: columnTypeOf(c.type)};
    }
    return {trace: columnSchema};
  }

  private gridColumns(): Column[] {
    return traceColumnsState
      .effective(this.schemaColumns)
      .map((name) => ({id: name, field: name}));
  }

  view() {
    const endpoint = this.endpoint();
    if (endpoint === '') {
      return m(EmptyState, {
        title: 'Set the BigTrace Endpoint above to choose traces.',
        icon: 'travel_explore',
      });
    }

    this.ensureDataSource(endpoint);
    this.maybeLoadSchema(endpoint);

    if (this.schemaColumns.length === 0) {
      if (this.schemaLoading) {
        return m(
          EmptyState,
          {title: 'Loading trace columns...', icon: 'hourglass_empty'},
          m(Spinner),
        );
      }
      if (this.schemaError !== undefined) {
        return m(
          Callout,
          {
            intent: Intent.Danger,
            icon: 'error',
            title: 'Failed to load trace columns',
          },
          this.schemaError,
          m(Button, {
            label: 'Retry',
            icon: 'refresh',
            intent: Intent.Primary,
            variant: ButtonVariant.Filled,
            onclick: () => this.retrySchema(),
          }),
        );
      }
      return m(EmptyState, {
        title: 'No trace columns available for this source.',
        icon: 'inbox',
      });
    }

    // Surface a row-fetch error (e.g. an unreadable trace source) above the
    // grid without tearing it down — the schema is fine, only the rows failed.
    const rowError = this.dataSource!.getError();

    return m('.pf-bt-trace-selection-grid', [
      rowError !== null &&
        rowError !== '' &&
        m(
          Callout,
          {intent: Intent.Warning, icon: 'warning', title: 'No traces loaded'},
          rowError,
        ),
      m(DataGrid, {
        schema: this.buildSchemaRegistry(),
        rootSchema: 'trace',
        data: this.dataSource!,
        disablePivotControls: true,
        fillHeight: true,
        showExportButton: true,
        emptyStateMessage: 'No traces match the current filter',
        columns: this.gridColumns(),
        onColumnsChanged: (columns) =>
          traceColumnsState.set(columns.map((c) => c.field)),
        filters: traceFilterState.get(),
        onFiltersChanged: (filters: readonly Filter[]) =>
          traceFilterState.set(filters),
      }),
    ]);
  }
}
