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

import {EmptyState} from '../../widgets/empty_state';
import {Callout} from '../../widgets/callout';
import {Intent} from '../../widgets/common';
import m from 'mithril';
import {SettingsShell} from '../../widgets/settings_shell';
import {Switch} from '../../widgets/switch';
import {
  type MultiSelectDiff,
  type MultiSelectOption,
  PopupMultiSelect,
} from '../../widgets/multiselect';
import {PopupPosition} from '../../widgets/popup';
import {Card, CardStack} from '../../widgets/card';
import {Icon} from '../../widgets/icon';
import {classNames} from '../../base/classnames';
import {bigTraceSettingsStorage} from '../settings/bigtrace_settings_storage';
import type {
  Setting as BigTraceSetting,
  SettingFilter,
  EnumOption,
} from '../settings/settings_types';
import {renderSetting} from '../settings/settings_widgets';
import {Button, ButtonVariant} from '../../widgets/button';

import {endpointStorage} from '../settings/endpoint_storage';
import type {Setting} from '../../public/settings';

import {TextInput} from '../../widgets/text_input';
import {Stack, StackAuto} from '../../widgets/stack';

import {DataGrid} from '../../components/widgets/datagrid/datagrid';
import type {
  ColumnSchema,
  SchemaRegistry,
} from '../../components/widgets/datagrid/datagrid_schema';
import type {
  Column,
  Filter,
  SortDirection,
} from '../../components/widgets/datagrid/model';
import {
  BigtraceQueryClient,
  type TraceColumnDescriptor,
  type TracesSchemaResponse,
} from '../query/bigtrace_query_client';
import {BigtraceTraceListDataSource} from '../query/bigtrace_trace_list_data_source';
import {traceFilterState} from '../settings/trace_filter_state';
import {traceColumnsState} from '../settings/trace_columns_state';
import {traceQueryColumnsState} from '../settings/trace_query_columns_state';

// Optional per-mount overrides. When provided, the SettingsPage reads
// and writes the per-query snapshot instead of the global LocalStorage
// modules. Used by the Query page's "Bigtrace Settings" sub-tab so the
// same visual is bound to per-tab state. `undefined` (the /settings
// route default) keeps the original global-state behavior — no caller
// regression possible.
export interface SettingsBindings {
  // The full per-mount SettingFilter[] (replaces
  // bigTraceSettingsStorage.buildSettingFilters() for data source +
  // schema requests).
  readonly getEffectiveSettings: () => ReadonlyArray<SettingFilter>;
  // Read/write one setting's `values: string[]` by id. Returns
  // undefined when the per-mount snapshot has no entry for this id;
  // TabBoundSetting then falls back to defaultValue.
  readonly getSettingValue: (id: string) => readonly string[] | undefined;
  readonly setSettingValue: (
    id: string,
    values: readonly string[],
    category: string,
  ) => void;
  readonly getTraceFilter: () => readonly Filter[];
  readonly setTraceFilter: (filters: readonly Filter[]) => void;
  readonly getTraceMetadataColumns: () => readonly string[];
  readonly setTraceMetadataColumns: (cols: readonly string[]) => void;
  // Optional: called whenever the trace-list data source reports a
  // fresh `filteredTotalRows` (the count of traces the current filter
  // selects). Embedded callers cache the value so a closed drawer
  // can show "filter: N traces" without re-fetching. Undefined =
  // count not yet known.
  readonly onTraceMatchCount?: (count: number | undefined) => void;
}

// Wraps a globally-registered `Setting<T>` so reads/writes route
// through per-tab bindings. Inherits the descriptor (type, schema,
// placeholder, options) so renderSetting() picks the right widget.
// Per-tab is always "enabled" — the disable Switch is hidden in the
// embedded layout, and TRACE_ADDRESS settings (the only ones surfaced
// in the snapshot) skip the Switch on /settings too.
class TabBoundSetting<T> implements BigTraceSetting<T> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly type: BigTraceSetting<T>['type'];
  readonly schema: BigTraceSetting<T>['schema'];
  readonly defaultValue: T;
  readonly category?: string;
  readonly requiresReload?: boolean;
  readonly options?: readonly (string | EnumOption)[];
  readonly placeholder?: string;
  readonly format?: 'sql';
  readonly disabled: boolean;

  constructor(
    private readonly base: BigTraceSetting<T>,
    private readonly bindings: SettingsBindings,
  ) {
    this.id = base.id;
    this.name = base.name;
    this.description = base.description;
    this.type = base.type;
    this.schema = base.schema;
    this.defaultValue = base.defaultValue;
    this.category = base.category;
    this.requiresReload = base.requiresReload;
    this.options = base.options;
    this.placeholder = base.placeholder;
    this.format = base.format;
    this.disabled = base.disabled ?? false;
  }

  get isDefault(): boolean {
    return JSON.stringify(this.get()) === JSON.stringify(this.defaultValue);
  }

  get(): T {
    const raw = this.bindings.getSettingValue(this.id);
    if (raw === undefined) return this.base.get();
    return convertFromWireValues<T>(raw, this.base) ?? this.defaultValue;
  }

  set(value: T): void {
    const wire = Array.isArray(value) ? value.map(String) : [String(value)];
    this.bindings.setSettingValue(this.id, wire, this.category ?? '');
    m.redraw();
  }

  reset(): void {
    this.set(this.defaultValue);
  }

  isDisabled(): boolean {
    return false;
  }

  setDisabled(_disabled: boolean): void {
    // Per-tab snapshot is always "enabled". The Switch is hidden in
    // the embedded layout, so this is unreachable in practice — but
    // a defensive no-op keeps the Setting<T> contract honest.
  }

  [Symbol.dispose](): void {}
}

// Inverse of `buildSettingFilters`'s String() coercion. Reads the
// wire-side `values: string[]` back into the setting's declared type.
// Returns undefined when the wire entry doesn't match the type (e.g.
// "abc" against a number setting); callers fall back to defaultValue.
function convertFromWireValues<T>(
  raw: readonly string[],
  setting: BigTraceSetting<T>,
): T | undefined {
  switch (setting.type) {
    case 'number': {
      if (raw.length === 0) return undefined;
      const n = parseFloat(raw[0]);
      return Number.isFinite(n) ? (n as unknown as T) : undefined;
    }
    case 'boolean':
      return (raw[0] === 'true') as unknown as T;
    case 'string':
    case 'enum':
      return (raw[0] ?? '') as unknown as T;
    case 'multi-select':
    case 'string-array':
      return [...raw] as unknown as T;
  }
  return undefined;
}

interface BigTraceSettingsCardAttrs extends m.Attributes {
  id?: string;
  title: string;
  controls: m.Children;
  description?: m.Children;
  disabled?: boolean;
  onChange?: (disabled: boolean) => void;
  fullWidthControls?: boolean;
}

class BigTraceSettingsCard
  implements m.ClassComponent<BigTraceSettingsCardAttrs>
{
  view(vnode: m.Vnode<BigTraceSettingsCardAttrs>) {
    const {
      id,
      title,
      controls,
      description,
      disabled,
      onChange,
      fullWidthControls,
      ...rest
    } = vnode.attrs;

    const details = m(
      '.pf-settings-card__details',
      m('.pf-settings-card__title', [
        disabled !== undefined &&
          m(Switch, {
            className: 'pf-settings-card__toggle',
            style: {marginRight: '8px'},
            checked: !disabled,
            title:
              'Turn off to skip this filter — its value will not be ' +
              'sent to the backend with subsequent queries.',
            onchange: (e: Event) => {
              const target = e.target as HTMLInputElement;
              onChange?.(!target.checked);
            },
          }),
        title,
      ]),
      description !== undefined &&
        m('.pf-settings-card__description', description),
    );

    const controlsEl = m(
      '.pf-settings-card__controls',
      {
        className: classNames(
          disabled !== undefined &&
            disabled &&
            'pf-bt-settings-controls--disabled',
        ),
        style: fullWidthControls
          ? {gridColumn: '1 / -1', minWidth: '0'}
          : undefined,
      },
      controls,
    );

    return m(
      'div',
      {
        className: classNames(
          disabled && 'pf-bt-settings-card-wrapper--disabled',
        ),
      },
      m(
        Card,
        {
          id,
          className: classNames('pf-settings-card', disabled && 'pf-disabled'),
          ...rest,
        },
        [details, controlsEl],
      ),
    );
  }
}

// Display category name for the section that hosts the trace-selection
// grid. Must match the localised label in CATEGORY_DISPLAY_NAMES so the
// renderer can branch on it.
const TRACE_ADDRESS_DISPLAY = 'Trace Address';

const SCHEMA_ROOT = 'trace_list';

// Build a SchemaRegistry from the backend's /traces_schema response.
// One entry per declared column; cellRenderer stays undefined so the
// DataGrid uses its default string renderer (every cell is a string
// on the wire per the always-strings contract).
function buildSchemaRegistry(
  schema: ReadonlyArray<TraceColumnDescriptor>,
): SchemaRegistry {
  const columnSchema: ColumnSchema = {};
  for (const c of schema) {
    columnSchema[c.name] = {cellRenderer: undefined};
  }
  return {[SCHEMA_ROOT]: columnSchema};
}

interface SchemaError {
  readonly kind: 'error';
  readonly message: string;
}
type SchemaState = undefined | 'loading' | SchemaError | TracesSchemaResponse;

export interface SettingsPageAttrs {
  // When provided, every read/write that would normally hit
  // bigTraceSettingsStorage / traceFilterState / traceQueryColumnsState
  // is routed through the bindings instead. The /settings route
  // mounts SettingsPage without bindings (global state); the Query
  // page's "Bigtrace Settings" sub-tab mounts with per-tab bindings.
  readonly bindings?: SettingsBindings;
}

export class SettingsPage implements m.ClassComponent<SettingsPageAttrs> {
  private searchQuery = '';
  // Captured on every view() so private methods can read it without
  // threading attrs everywhere. Stale-bindings risk = zero: view runs
  // before any rendering, and bindings are owned by the caller.
  private bindings: SettingsBindings | undefined;
  // Trace-list grid state. The DataSource is rebuilt whenever the
  // backend endpoint changes (its BigtraceQueryClient binds to one
  // endpoint at construction). With bindings set, the data source's
  // `getSettings` callback also routes through bindings so /traces
  // sees the per-tab snapshot, not the global defaults.
  private traceListDataSource: BigtraceTraceListDataSource | undefined;
  private traceListEndpoint: string | undefined;
  private traceFilters: readonly Filter[] = [];
  // Per-session sort state for the trace grid. The DataGrid carries
  // sort on the `Column` object itself, so when we run in
  // controlled-mode `columns` we have to splice it back onto the
  // matching column on every render — otherwise the click that set
  // it gets discarded on the next redraw. In-memory (not
  // persisted): sort is naturally ephemeral, filter / chosen
  // columns survive reload via LocalStorage (or per-tab snapshot
  // when bindings is set).
  private traceListSortField: string | undefined;
  private traceListSortDirection: SortDirection | undefined;
  // /traces_schema response, refetched whenever the endpoint changes
  // (or trace_directory changes — a backend with a metadata index
  // could vary the schema per source). `undefined` = not yet
  // requested; 'loading' = in flight; SchemaError = the request
  // failed; otherwise the resolved response.
  private schemaState: SchemaState = undefined;
  private schemaEndpoint: string | undefined;
  oninit({attrs}: m.Vnode<SettingsPageAttrs>) {
    this.bindings = attrs.bindings;
    this.traceFilters = this.readTraceFilter();
    bigTraceSettingsStorage.loadSettings();
  }

  // ----- Binding-aware accessors (fall back to globals) -----

  private readTraceFilter(): readonly Filter[] {
    return this.bindings
      ? this.bindings.getTraceFilter()
      : traceFilterState.get();
  }

  private writeTraceFilter(filters: readonly Filter[]): void {
    if (this.bindings) this.bindings.setTraceFilter(filters);
    else traceFilterState.set(filters);
  }

  private readTraceMetadataColumns(): readonly string[] {
    return this.bindings
      ? this.bindings.getTraceMetadataColumns()
      : traceQueryColumnsState.get();
  }

  private writeTraceMetadataColumns(cols: readonly string[]): void {
    if (this.bindings) this.bindings.setTraceMetadataColumns(cols);
    else traceQueryColumnsState.set(cols);
  }

  // Effective settings for outgoing requests (/traces, /traces_schema).
  // With bindings set, the per-tab snapshot wins so the trace grid
  // reflects the same `trace_directory` / `trace_limit` the next Run
  // will use, not the user's /settings defaults.
  private effectiveSettings(): ReadonlyArray<SettingFilter> {
    return this.bindings
      ? this.bindings.getEffectiveSettings()
      : bigTraceSettingsStorage.buildSettingFilters();
  }

  // Wrap a globally-registered setting so its widget reads/writes
  // per-tab. No-op when bindings is undefined (returns the original).
  private boundSetting(
    setting: BigTraceSetting<unknown>,
  ): BigTraceSetting<unknown> {
    if (!this.bindings) return setting;
    return new TabBoundSetting(setting, this.bindings);
  }

  private static readonly CATEGORY_DISPLAY_NAMES: ReadonlyMap<string, string> =
    new Map([
      ['General', 'General'],
      ['TRACE_ADDRESS', TRACE_ADDRESS_DISPLAY],
      ['TRACE_METADATA', 'Trace Metadata'],
      ['BIGTRACE_QUERY_OPTIONS', 'Query Options'],
    ]);

  private displayCategory(raw: string): string {
    return SettingsPage.CATEGORY_DISPLAY_NAMES.get(raw) ?? raw;
  }

  // Lazily build / re-build the trace-list data source. The
  // BigtraceQueryClient binds to one endpoint at construction, so a
  // change to bigtraceEndpoint requires a fresh DataSource (and a
  // fresh grid lifecycle — the caller keys the DataGrid on the
  // endpoint so Mithril rebuilds it).
  private getTraceListDataSource(
    endpoint: string,
  ): BigtraceTraceListDataSource | undefined {
    if (endpoint === '') {
      this.traceListDataSource = undefined;
      this.traceListEndpoint = undefined;
      return undefined;
    }
    if (
      this.traceListDataSource === undefined ||
      this.traceListEndpoint !== endpoint
    ) {
      const client = new BigtraceQueryClient(endpoint);
      // `getSettings` is invoked on every fetch, so a per-tab caller
      // sees the latest snapshot edits without rebuilding the data
      // source.
      this.traceListDataSource = new BigtraceTraceListDataSource(client, () =>
        this.effectiveSettings(),
      );
      this.traceListEndpoint = endpoint;
    }
    return this.traceListDataSource;
  }

  // Resolved schema or `undefined` while loading / errored. The
  // toggle widget and the column-picker menu both go through this so
  // a single fetch backs both UIs.
  private resolvedSchema(): TracesSchemaResponse | undefined {
    const s = this.schemaState;
    if (s === undefined || s === 'loading') return undefined;
    if ('kind' in s) return undefined;
    return s;
  }

  // Kick off /traces_schema once per endpoint. Idempotent — repeated
  // calls with the same endpoint are no-ops while a fetch is in
  // flight or after one has resolved.
  private ensureSchemaFetched(endpoint: string): void {
    if (endpoint === '') {
      this.schemaState = undefined;
      this.schemaEndpoint = undefined;
      return;
    }
    if (this.schemaEndpoint === endpoint && this.schemaState !== undefined) {
      return;
    }
    this.schemaEndpoint = endpoint;
    this.schemaState = 'loading';
    const client = new BigtraceQueryClient(endpoint);
    client
      .listTracesSchema(this.effectiveSettings())
      .then((resp) => {
        // Stale-response guard: only commit if the endpoint hasn't
        // changed under us mid-fetch.
        if (this.schemaEndpoint !== endpoint) return;
        this.schemaState = resp;
        m.redraw();
      })
      .catch((e: unknown) => {
        if (this.schemaEndpoint !== endpoint) return;
        this.schemaState = {
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        };
        m.redraw();
      });
  }

  // Build the controlled-mode `columns` array for the trace grid.
  // Splices the per-session sort state onto the column it applies
  // to so the DataGrid's header sort indicator survives our redraws.
  // Without this, the controlled-mode reset wipes sort on every
  // render and the user perceives "sort doesn't work".
  private buildTraceListColumns(names: ReadonlyArray<string>): Column[] {
    return names.map((n) => {
      const base: Column = {id: n, field: n};
      if (
        this.traceListSortField === n &&
        this.traceListSortDirection !== undefined
      ) {
        return {...base, sort: this.traceListSortDirection};
      }
      return base;
    });
  }

  // Apply a column-set change coming from either UI affordance
  // (toggle row or DataGrid header menu). The two routes converge
  // here so they can't drift.
  private updateChosenColumns(names: readonly string[]): void {
    // The DataGrid emits onColumnsChanged with the new visible-set
    // (which may include an aliased column if the user renamed one).
    // We don't alias trace-list columns, so id === field for every
    // entry; we just normalise to a string list.
    if (names.length === 0) {
      // Defend against a degenerate state — at least one column has
      // to be visible. Reset to defaults instead.
      traceColumnsState.clear();
    } else {
      traceColumnsState.set(names);
    }
    m.redraw();
  }

  // Renders the embedded "Traces" card. The card has three parts:
  // (a) a caption pinning the implicit-selection contract; (b) a
  // toggle row letting the user check the columns they want; (c) a
  // DataGrid driven by the trace-list DataSource. Both the toggle
  // row and the grid's built-in "Add column" menu write through the
  // same `traceColumnsState`, so they stay in sync.
  private renderTraceListCard(endpoint: string): m.Children {
    const ds = this.getTraceListDataSource(endpoint);
    if (ds === undefined) {
      return m(
        Card,
        {className: 'pf-settings-card'},
        m('.pf-settings-card__details', [
          m('.pf-settings-card__title', 'Traces'),
          m(
            '.pf-settings-card__description',
            'Set the BigTrace Endpoint above to load traces from your ' +
              'configured directory.',
          ),
        ]),
      );
    }
    this.ensureSchemaFetched(endpoint);
    const schema = this.resolvedSchema();
    const schemaState = this.schemaState;

    const header: m.Children = [
      m('.pf-bt-trace-card__title-row', [
        m('.pf-settings-card__title', 'Traces'),
        // Inline refresh action — forces a /traces refetch with the
        // current filter / sort / columns / settings. Lives next to
        // the section title so it's obvious which list it refreshes.
        m(Button, {
          icon: 'refresh',
          className: 'pf-bt-trace-card__refresh',
          title:
            'Refresh trace list — re-fetch /traces with the current ' +
            'filter and settings.',
          onclick: () => {
            void ds.refresh();
          },
        }),
      ]),
      m(
        '.pf-settings-card__description',
        'Filter or sort to select which traces the query runs over.',
      ),
    ];

    if (schemaState === 'loading' || schemaState === undefined) {
      return m(
        Card,
        {className: 'pf-settings-card', style: {display: 'block'}},
        [
          header,
          m(EmptyState, {title: 'Loading schema…', icon: 'hourglass_empty'}),
        ],
      );
    }
    if (schemaState !== undefined && 'kind' in schemaState) {
      return m(
        Card,
        {className: 'pf-settings-card', style: {display: 'block'}},
        [
          header,
          m(
            Callout,
            {
              intent: Intent.Danger,
              icon: 'error',
              title: 'Failed to load trace schema',
            },
            schemaState.message,
          ),
        ],
      );
    }

    // schema is resolved here; build the controlled-mode column list
    // from the effective selection.
    const chosen = traceColumnsState.effective(schema!.columns);
    const schemaRegistry = buildSchemaRegistry(schema!.columns);

    return m(
      Card,
      {
        className: 'pf-settings-card pf-bt-trace-card',
        // Extra top margin separates this richer compound widget
        // from the plain key-value cards above (Trace Directory,
        // Trace Limit). Without it the grid sits flush against the
        // settings list and the visual hierarchy collapses.
        // padding-bottom keeps the grid's bottom edge clear of the
        // card border.
        style: {
          display: 'block',
          marginTop: '32px',
          paddingBottom: '16px',
        },
      },
      [
        header,
        this.renderColumnPicker(schema!.columns, chosen),
        m(
          '.pf-bt-trace-list-grid',
          {
            // Small floor so the grid still has presence on
            // single-row results, but no large fixed minHeight that
            // would leave a visible void below sparsely-populated
            // directories.
            style: {minHeight: '120px', marginTop: '16px'},
          },
          m(DataGrid, {
            schema: schemaRegistry,
            rootSchema: SCHEMA_ROOT,
            data: ds,
            // Controlled-mode columns: the grid renders exactly what
            // the user picked, in their preferred order. Its built-in
            // header menus ("Add column", "Remove column") emit
            // onColumnsChanged with the new list, which we persist
            // back to traceColumnsState — same write path as the
            // toggle widget above.
            columns: this.buildTraceListColumns(chosen),
            onColumnsChanged: (cols: ReadonlyArray<Column>) => {
              // Sort lives on the Column object — extract it before
              // we collapse cols to a string[] so the next render
              // can splice it back. Without this the user's
              // header click reverts on every redraw.
              const sorted = cols.find((c) => c.sort);
              this.traceListSortField = sorted?.field;
              this.traceListSortDirection = sorted?.sort;
              this.updateChosenColumns(cols.map((c) => c.field));
            },
            canAddColumns: true,
            canRemoveColumns: true,
            // Controlled-mode filter: source of truth is the binding
            // (per-tab snapshot) or `traceFilterState` (global on
            // /settings). Persist immediately so a Run picks up the
            // latest selection without a separate "apply" step.
            filters: this.traceFilters,
            onFiltersChanged: (filters: readonly Filter[]) => {
              this.traceFilters = filters;
              this.writeTraceFilter(filters);
            },
            emptyStateMessage:
              'No traces match your filter (or Trace Directory is empty).',
            enablePivotControls: false,
            // Inline match-count so users see at a glance how many
            // traces the current filter (or trace_directory alone)
            // selects. Backed by the data source's
            // filteredTotalRows, refreshed on every successful
            // fetch.
            toolbarItemsLeft: [this.renderTraceMatchCount(ds)],
          }),
        ),
      ],
    );
  }

  // Sibling card to the Traces card. Lives below it in the
  // TRACE_ADDRESS section. Separate visual unit — its own title +
  // description — so the "what shows up in the grid" picker and the
  // "what gets attached to query results" picker don't look like
  // duplicates of each other. Renders nothing while the schema is
  // still loading.
  private renderQueryColumnsCard(): m.Children {
    const schema = this.resolvedSchema();
    if (schema === undefined) return null;
    return m(
      Card,
      {
        className: 'pf-settings-card pf-bt-query-columns-card',
        style: {
          display: 'block',
          marginTop: '24px',
          paddingBottom: '16px',
        },
      },
      [
        m('.pf-settings-card__title', 'Query Result Columns'),
        m(
          '.pf-settings-card__description',
          'Trace metadata to attach to every query result row.',
        ),
        this.renderQueryColumnsPicker(schema.columns),
      ],
    );
  }

  // Single-line summary of how many traces currently match. Sits in
  // the grid's toolbar so it's visible alongside the filter chips
  // and the search-result feel mirrors the query-page results
  // summary. Uses `filteredTotalRows` from the data source (post-
  // filter count; equal to the trace-directory total when no filter
  // is active).
  private renderTraceMatchCount(ds: BigtraceTraceListDataSource): m.Children {
    const n = ds.filteredTotalRows;
    // Cache the count back to the embedded caller (e.g. the drawer
    // prototype) so a closed-drawer summary can show it without
    // re-fetching. No-op when the standalone /settings route is the
    // caller — that mount doesn't set onTraceMatchCount.
    this.bindings?.onTraceMatchCount?.(n);
    const hasFilter = this.traceFilters.length > 0;
    const text =
      n === undefined
        ? 'Counting traces…'
        : hasFilter
          ? `${n.toLocaleString()} trace${n === 1 ? '' : 's'} match`
          : `${n.toLocaleString()} trace${n === 1 ? '' : 's'}`;
    // Subtle filled label — small radius, low-contrast background,
    // inherits the font family. Reads as a "status" rather than as
    // a clickable chip.
    return m(
      'span.pf-bt-trace-match-count',
      {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          padding: '2px 8px',
          borderRadius: '4px',
          fontSize: '12px',
          fontWeight: '500',
          background: 'var(--pf-color-background-tertiary, #e3e9eb)',
          color: 'var(--pf-color-text-muted, #555)',
        },
      },
      text,
    );
  }

  // Checkboxes for the "Query Result Columns" card. Picks which
  // trace-metadata columns get stapled onto every QUERY RESULT row
  // (stored server-side in the per-query metadata sidecar, projected
  // at fetch time). Distinct state from `traceColumnsState` — these
  // checkboxes never affect the trace-list grid above. Default is
  // empty so a user who never touches the picker pays zero overhead
  // on backends with expensive per-trace metadata.
  private renderQueryColumnsPicker(
    schemaCols: ReadonlyArray<TraceColumnDescriptor>,
  ): m.Children {
    const chosen = this.readTraceMetadataColumns();
    const chosenSet = new Set(chosen);
    const options: MultiSelectOption[] = schemaCols.map((col) => ({
      id: col.name,
      name: col.name,
      checked: chosenSet.has(col.name),
      details: col.description,
    }));
    return m(
      '.pf-bt-trace-query-columns',
      {style: {marginTop: '16px'}},
      m(PopupMultiSelect, {
        label: 'Columns to attach',
        icon: 'label',
        showNumSelected: true,
        showSelectAllButton: true,
        position: PopupPosition.Bottom,
        options,
        onChange: (diffs: ReadonlyArray<MultiSelectDiff>) => {
          let next = [...chosen];
          for (const d of diffs) {
            if (d.checked) {
              if (!next.includes(d.id)) next.push(d.id);
            } else {
              next = next.filter((n) => n !== d.id);
            }
          }
          this.writeTraceMetadataColumns(next);
          m.redraw();
        },
      }),
    );
  }

  // Compact popup multi-select for the trace grid's visible columns.
  // Each column = one checkable option in the popup; the button face
  // shows "Shown columns (N selected)". Scales gracefully when Phase
  // 2 introduces more metadata — no row-wrapping noise — and reuses
  // the multiselect widget's built-in search + select-all.
  //
  // `description` from /traces_schema becomes the per-option
  // tooltip (the multiselect widget surfaces `details` as the
  // hover title), so users can still discover what each column
  // means without leaving the popup.
  private renderColumnPicker(
    schemaCols: ReadonlyArray<TraceColumnDescriptor>,
    chosen: ReadonlyArray<string>,
  ): m.Children {
    const chosenSet = new Set(chosen);
    const options: MultiSelectOption[] = schemaCols.map((col) => ({
      id: col.name,
      name: col.name,
      checked: chosenSet.has(col.name),
      details: col.description,
    }));
    return m(
      '.pf-bt-trace-columns',
      {style: {marginTop: '20px'}},
      m(PopupMultiSelect, {
        label: 'Shown columns',
        icon: 'view_column',
        showNumSelected: true,
        showSelectAllButton: true,
        position: PopupPosition.Bottom,
        options,
        onChange: (diffs: ReadonlyArray<MultiSelectDiff>) => {
          this.applyColumnDiffs(chosen, diffs);
        },
      }),
    );
  }

  // Apply MultiSelect diffs to the persisted shown-columns set.
  // Preserves the order users implicitly create by checking columns
  // in sequence (newly-checked ones are appended; unchecked ones
  // are removed in place).
  private applyColumnDiffs(
    chosen: ReadonlyArray<string>,
    diffs: ReadonlyArray<MultiSelectDiff>,
  ): void {
    let next = [...chosen];
    for (const d of diffs) {
      if (d.checked) {
        if (!next.includes(d.id)) next.push(d.id);
      } else {
        next = next.filter((n) => n !== d.id);
      }
    }
    this.updateChosenColumns(next);
  }

  view({attrs}: m.Vnode<SettingsPageAttrs>) {
    // Refresh bindings each render so callers can swap them out
    // without remounting. The class only holds the reference for
    // the duration of the render pass.
    this.bindings = attrs.bindings;
    const embedded = this.bindings !== undefined;
    const endpointSetting = endpointStorage.get('bigtraceEndpoint');

    const query = this.searchQuery.toLowerCase();
    const categories = new Map<string, BigTraceSetting<unknown>[]>();

    // Always show the General section so the endpoint is accessible
    // on the standalone /settings route. In embedded mode the
    // endpoint stays global (it's a connection, not a query) and
    // doesn't belong in the per-tab snapshot UI.
    if (endpointSetting && !embedded) {
      categories.set('General', []);
    }

    const settings = bigTraceSettingsStorage
      .getAllSettings()
      .filter(
        (s) =>
          s.name.toLowerCase().includes(query) ||
          s.description.toLowerCase().includes(query),
      );

    for (const setting of settings) {
      const categoryName = this.displayCategory(setting.category || 'General');
      if (!categories.has(categoryName)) {
        categories.set(categoryName, []);
      }
      categories.get(categoryName)!.push(setting);
    }

    // Show a "no matches" hint when search hides everything except
    // the always-shown General card.
    const hasOtherMatches = settings.length > 0;
    const showNoMatchesHint =
      this.searchQuery !== '' &&
      !hasOtherMatches &&
      !bigTraceSettingsStorage.execConfigLoadError;

    // Only force-create the Trace Metadata section while loading or on error;
    // an empty metadata response collapses the section entirely.
    if (
      this.searchQuery === '' &&
      !categories.has('Trace Metadata') &&
      !bigTraceSettingsStorage.execConfigLoadError &&
      (bigTraceSettingsStorage.isMetadataLoading ||
        bigTraceSettingsStorage.metadataLoadError)
    ) {
      categories.set('Trace Metadata', []);
    }

    const body = m('.pf-settings-page', [
      bigTraceSettingsStorage.isExecConfigLoading &&
        m(EmptyState, {
          title: 'Loading settings...',
          icon: 'hourglass_empty',
          fillHeight: true,
        }),
      Array.from(categories.entries()).map(([category, catSettings]) => {
        let categoryHeader: m.Children = m(
          'h2.pf-settings-page__plugin-title',
          category,
        );
        if (category === 'Trace Metadata') {
          categoryHeader = m(
            'h2.pf-settings-page__plugin-title.pf-bt-settings-category-header',
            [
              m('span', category),
              bigTraceSettingsStorage.isReloadRequired() &&
              !bigTraceSettingsStorage.isMetadataLoading
                ? m(Button, {
                    label: 'Reload',
                    icon: 'refresh',
                    intent: Intent.Primary,
                    variant: ButtonVariant.Filled,
                    onclick: () =>
                      bigTraceSettingsStorage.reloadMetadataSettings(),
                  })
                : null,
            ],
          );
        }

        let categoryContent;
        if (
          category === 'Trace Metadata' &&
          bigTraceSettingsStorage.isMetadataLoading
        ) {
          categoryContent = m(EmptyState, {
            title: 'Loading metadata...',
            icon: 'hourglass_empty',
          });
        } else if (
          category === 'Trace Metadata' &&
          bigTraceSettingsStorage.metadataLoadError
        ) {
          categoryContent = m(
            Callout,
            {
              intent: Intent.Danger,
              icon: 'error',
              title: 'Failed to Load Trace Metadata',
            },
            bigTraceSettingsStorage.metadataLoadError,
          );
        } else {
          const cards: m.Children[] = [];
          // Render the endpoint card inside "General".
          if (category === 'General' && endpointSetting) {
            cards.push(
              m(BigTraceSettingsCard, {
                id: endpointSetting.id,
                title: endpointSetting.name,
                description: endpointSetting.description,
                disabled: undefined,
                controls: this.renderEndpointControl(endpointSetting),
              }),
            );
          }
          for (const setting of catSettings) {
            cards.push(this.renderBigTraceSettingCard(setting));
          }
          // Append the trace-list grid + the result-columns
          // picker below the trace_directory / trace_limit cards.
          // Two sibling cards: "Traces" picks WHICH traces; "Query
          // Result Columns" picks WHAT metadata is attached to
          // each row of query results. Both omitted while the
          // user is searching the settings list (the grid + grid-
          // schema would noise up a search-results view).
          if (category === TRACE_ADDRESS_DISPLAY && this.searchQuery === '') {
            const endpoint = endpointSetting
              ? (endpointSetting.get() as string) ?? ''
              : '';
            cards.push(this.renderTraceListCard(endpoint));
            cards.push(this.renderQueryColumnsCard());
          }
          categoryContent = m(CardStack, cards);
        }

        return m(
          '.pf-settings-page__plugin-section',
          categoryHeader,
          categoryContent,
        );
      }),
      // After the General card, so the callout's "Set the
      // Endpoint above" copy points at a field above it.
      bigTraceSettingsStorage.execConfigLoadError &&
        m(
          Callout,
          {
            intent: Intent.Danger,
            icon: 'error',
            title: 'Failed to Load Execution Configuration',
          },
          bigTraceSettingsStorage.execConfigLoadError,
        ),
      showNoMatchesHint &&
        m(EmptyState, {
          title: `No settings match "${this.searchQuery}"`,
          icon: 'search_off',
        }),
    ]);

    // Embedded inside the Query page's "Bigtrace Settings" sub-tab:
    // skip the SettingsShell chrome (page title + sticky search
    // input). The pill row above already labels the surface, and a
    // second "Settings" header in the page body would just be noise.
    if (embedded) {
      return m('.pf-bt-settings-embedded', body);
    }
    return m(
      SettingsShell,
      {
        title: 'Settings',
        className: 'page',
        // Reload-required affordance lives next to the endpoint
        // input (renderEndpointControl), not in the header.
        stickyHeaderContent: m(
          Stack,
          {orientation: 'horizontal'},
          m(StackAuto),
          m(TextInput, {
            placeholder: 'Search...',
            value: this.searchQuery,
            leftIcon: 'search',
            oninput: (e: Event) => {
              this.searchQuery = (e.target as HTMLInputElement).value;
            },
          }),
        ),
      },
      body,
    );
  }

  private renderEndpointControl(setting: Setting<unknown>) {
    const currentValue = setting.get() as string;
    return m(
      Stack,
      {
        orientation: 'horizontal',
        gap: '8px',
        alignItems: 'center',
        style: {flexWrap: 'wrap', justifyContent: 'flex-end'},
      },
      m(TextInput, {
        value: currentValue,
        placeholder: 'https://your-bigtrace-backend/v1',
        style: {width: 'min(300px, 30vw)'},
        oninput: (e: Event) => {
          const target = e.target as HTMLInputElement;
          setting.set(target.value);
        },
      }),
      // Endpoint is cached at module init; force a reload to apply
      // changes.
      endpointStorage.isReloadRequired() &&
        m(Button, {
          label: 'Reload to apply',
          icon: 'refresh',
          intent: Intent.Primary,
          variant: ButtonVariant.Filled,
          onclick: () => window.location.reload(),
        }),
    );
  }

  private renderBigTraceSettingCard(rawSetting: BigTraceSetting<unknown>) {
    const setting = this.boundSetting(rawSetting);
    const disabled = setting.isDisabled();
    const fullWidth =
      setting.type === 'string-array' ||
      (setting.type === 'string' && setting.format === 'sql');
    // Flag enabled-but-empty filters upfront. Numeric settings are
    // excluded because 0 is legit (= unlimited).
    const needsValue =
      !disabled &&
      (setting.type === 'string' || setting.type === 'string-array');
    let warning: string | undefined;
    if (needsValue) {
      const value = setting.get();
      if (setting.type === 'string') {
        if (typeof value === 'string' && value.trim() === '') {
          warning = 'Required when this filter is enabled.';
        }
      } else if (setting.type === 'string-array') {
        if (
          !Array.isArray(value) ||
          value.length === 0 ||
          value.every((v) => typeof v === 'string' && v.trim() === '')
        ) {
          warning = 'Required when this filter is enabled.';
        }
      }
    }
    // "(unlimited)" hint on numeric settings whose description says
    // "ignored if 0" — works for any setting following the convention.
    let hint: string | undefined;
    if (
      !disabled &&
      setting.type === 'number' &&
      setting.get() === 0 &&
      /ignored if 0/i.test(setting.description)
    ) {
      hint = '(unlimited)';
    }
    const description: m.Children = warning
      ? [
          setting.description,
          m(
            '.pf-settings-card__warning',
            {
              style: {
                color: 'var(--pf-color-danger, #b00020)',
                marginTop: '4px',
              },
            },
            m(Icon, {
              icon: 'warning',
              style: {fontSize: '14px', verticalAlign: 'middle'},
            }),
            ' ',
            warning,
          ),
        ]
      : hint
        ? [
            setting.description,
            ' ',
            m(
              'span.pf-settings-card__hint',
              {style: {opacity: 0.7, fontStyle: 'italic'}},
              hint,
            ),
          ]
        : setting.description;
    // Hide the enable/disable Switch on TRACE_ADDRESS settings —
    // those are required for any query to run, so the toggle is
    // visual noise without a meaningful affordance (disabling
    // trace_directory silently breaks the trace list with no
    // recovery cue). Compound cards in this section don't have a
    // Switch either, so dropping it here unifies the layout
    // template across the section.
    //
    // `disabled: undefined` tells BigTraceSettingsCard to omit the
    // Switch element entirely; non-TRACE_ADDRESS settings keep the
    // existing toggle behaviour unchanged.
    const isRequired = setting.category === 'TRACE_ADDRESS';
    return m(BigTraceSettingsCard, {
      id: setting.id,
      title: setting.name,
      description,
      controls: renderSetting(setting),
      disabled: isRequired ? undefined : disabled,
      fullWidthControls: fullWidth,
      onChange: isRequired
        ? undefined
        : (newDisabled: boolean) => {
            setting.setDisabled(newDisabled);
          },
    });
  }
}
