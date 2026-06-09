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
import {linkify} from '../../widgets/anchor';
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
} from '../settings/settings_types';
import {renderSetting} from '../settings/settings_widgets';
import {
  type SettingsBindings,
  TabBoundSetting,
} from '../settings/tab_bound_setting';
import {Button, ButtonVariant} from '../../widgets/button';

import {
  endpointStorage,
  getBigtraceEndpoint,
} from '../settings/endpoint_storage';
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
import {traceFilterState as traceFiltersState} from '../settings/trace_filter_state';
import {traceOrderByState} from '../settings/trace_order_by_state';
import {traceColumnsState} from '../settings/trace_columns_state';
import {
  traceQueryColumnsState,
  effectiveQueryColumns,
} from '../settings/trace_query_columns_state';
import {linkColumnFirst} from '../settings/column_order';

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

// Build a SchemaRegistry from the backend's /trace_metadata_schema response.
// One entry per declared column; cellRenderer stays undefined so the
// DataGrid uses its default string renderer (every cell is a string
// on the wire per the always-strings contract).
function buildSchemaRegistry(
  schema: ReadonlyArray<TraceColumnDescriptor>,
): SchemaRegistry {
  const columnSchema: ColumnSchema = {};
  for (const c of schema) {
    // A column literally named `link` renders as a clickable link (same as the
    // results grid); every other column uses the default string renderer.
    columnSchema[c.name] =
      c.name === 'link'
        ? {
            cellRenderer: (value) =>
              value === null || value === undefined
                ? ''
                : linkify(String(value)),
          }
        : {cellRenderer: undefined};
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
  // bigTraceSettingsStorage / traceFiltersState / traceQueryColumnsState
  // is routed through the bindings instead. The /settings route
  // mounts SettingsPage without bindings (global state); the Query
  // page's "Bigtrace Settings" sub-tab mounts with per-tab bindings.
  readonly bindings?: SettingsBindings;
}

// AIP-132 single-field order_by helpers. The trace grid only supports
// one active sort column at a time (DataGrid limit), so a one-field
// parser is sufficient — multi-field strings are persisted verbatim
// but we only round-trip the first entry into the UI's sort state.
// Returns undefined for empty / unparseable input so the caller can
// fall back to "no sort applied".
function parseSingleFieldOrderBy(
  raw: string,
): {field: string; direction: SortDirection} | undefined {
  const token = raw.split(',', 1)[0]?.trim();
  if (!token) return undefined;
  const [field, dir] = token.split(/\s+/);
  if (!field) return undefined;
  const lower = (dir ?? 'asc').toLowerCase();
  if (lower !== 'asc' && lower !== 'desc') return undefined;
  return {field, direction: lower === 'asc' ? 'ASC' : 'DESC'};
}

function formatSingleFieldOrderBy(
  col: {field: string; sort?: SortDirection} | undefined,
): string {
  if (!col?.sort) return '';
  return `${col.field} ${col.sort.toLowerCase()}`;
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
  // `getSettings` callback also routes through bindings so /trace_metadata
  // sees the per-tab snapshot, not the global defaults.
  private traceListDataSource: BigtraceTraceListDataSource | undefined;
  private traceListEndpoint: string | undefined;
  private traceFilterss: readonly Filter[] = [];
  // Sort state for the trace grid. The DataGrid carries sort on the
  // `Column` object itself, so when we run in controlled-mode
  // `columns` we have to splice it back onto the matching column on
  // every render — otherwise the click that set it gets discarded
  // on the next redraw. Persisted to `traceOrderByState` because
  // the trace-grid sort is functionally significant (under
  // `trace_limit > 0` it controls which traces the executor picks
  // first); seeding on oninit means a reload doesn't reset the
  // chosen order under the user.
  private traceListSortField: string | undefined;
  private traceListSortDirection: SortDirection | undefined;
  // /trace_metadata_schema response. `undefined` = not yet requested;
  // 'loading' = in flight; SchemaError = the request failed; otherwise the
  // resolved response.
  private schemaState: SchemaState = undefined;
  // Keyed on endpoint + effective settings: the backend can vary the schema
  // by trace source (TRACE_ADDRESS settings), so a source change must refetch
  // — endpoint-only keying would serve a stale catalog.
  private schemaKey: string | undefined;
  // One schema fetch at a time. A key change mid-flight bails the current
  // render and is picked up on the next render once the fetch settles, so
  // rapid source edits coalesce instead of racing.
  private schemaFetching = false;
  oninit({attrs}: m.Vnode<SettingsPageAttrs>) {
    this.bindings = attrs.bindings;
    this.traceFilterss = this.readTraceFilters();
    const parsed = parseSingleFieldOrderBy(this.readTraceOrderBy());
    this.traceListSortField = parsed?.field;
    this.traceListSortDirection = parsed?.direction;
    bigTraceSettingsStorage.loadSettings();
  }

  // ----- Binding-aware accessors (fall back to globals) -----

  private readTraceFilters(): readonly Filter[] {
    return this.bindings
      ? this.bindings.getTraceFilters()
      : traceFiltersState.get();
  }

  private writeTraceFilters(filters: readonly Filter[]): void {
    if (this.bindings) this.bindings.setTraceFilters(filters);
    else traceFiltersState.set(filters);
  }

  // null = unchosen (resolved to the schema's defaultVisible columns by the
  // picker via effectiveQueryColumns); [] = explicit "attach nothing".
  private readTraceMetadataColumns(): readonly string[] | null {
    return this.bindings
      ? this.bindings.getTraceMetadataColumns()
      : traceQueryColumnsState.get();
  }

  private readTraceOrderBy(): string {
    return this.bindings
      ? this.bindings.getTraceOrderBy()
      : traceOrderByState.get();
  }

  private writeTraceOrderBy(orderBy: string): void {
    if (this.bindings) this.bindings.setTraceOrderBy(orderBy);
    else traceOrderByState.set(orderBy);
  }

  // `null` resets to the unchosen default (attach the schema's defaultVisible
  // columns); a concrete list (including []) is honored verbatim.
  private writeTraceMetadataColumns(cols: readonly string[] | null): void {
    if (this.bindings) this.bindings.setTraceMetadataColumns(cols);
    else traceQueryColumnsState.set(cols);
  }

  // Effective settings for outgoing requests (/trace_metadata, /trace_metadata_schema).
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

  // Fetch /trace_metadata_schema, keyed on endpoint + effective settings, so a
  // change to the trace source (TRACE_ADDRESS settings) refetches the catalog
  // instead of serving a stale one. The in-flight guard keeps it to one fetch
  // at a time: a key change while a fetch is running bails this render and is
  // picked up on the next render once the fetch settles — so rapid edits
  // coalesce rather than racing.
  private ensureSchemaFetched(endpoint: string): void {
    if (endpoint === '') {
      this.schemaState = undefined;
      this.schemaKey = undefined;
      return;
    }
    // Key on endpoint + only the TRACE_ADDRESS (trace-source) settings: the
    // schema varies by source, so a query-option / metadata setting edit
    // shouldn't refetch the catalog. The fetch itself still sends every
    // setting.
    const sourceSettings = this.effectiveSettings().filter(
      (s) => s.category === 'TRACE_ADDRESS',
    );
    const key = `${endpoint}|${JSON.stringify(sourceSettings)}`;
    if (this.schemaKey === key && this.schemaState !== undefined) {
      return;
    }
    if (this.schemaFetching) {
      return;
    }
    this.schemaKey = key;
    this.schemaState = 'loading';
    this.schemaFetching = true;
    const client = new BigtraceQueryClient(endpoint);
    client
      .listTraceMetadataSchema(this.effectiveSettings())
      .then((resp) => {
        this.schemaFetching = false;
        // Stale-response guard: drop if the key moved on (endpoint cleared, or
        // the source changed and a newer fetch is warranted).
        if (this.schemaKey !== key) {
          m.redraw();
          return;
        }
        this.schemaState = resp;
        m.redraw();
      })
      .catch((e: unknown) => {
        this.schemaFetching = false;
        if (this.schemaKey !== key) {
          m.redraw();
          return;
        }
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
        // Inline refresh action — forces a /trace_metadata refetch with the
        // current filter / sort / columns / settings. Lives next to
        // the section title so it's obvious which list it refreshes.
        m(Button, {
          icon: 'refresh',
          className: 'pf-bt-trace-card__refresh',
          title:
            'Refresh trace list — re-fetch /trace_metadata with the current ' +
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
            // Fixed height so the inner virtualized Grid has a
            // bounded viewport — without it, the DataGrid's
            // `height: 100%` resolves against an auto-height parent
            // and the Grid expands to render every row. For a
            // 7M-row trace directory that's catastrophic; the
            // results-page grid avoids it via its flex-bounded
            // parent layout, but the Settings page is a scrolling
            // card layout so the trace-list wrapper has to set its
            // own height. 500px is generous enough for typical
            // settings UX, capped so virtualization always engages.
            style: {height: '500px', marginTop: '16px'},
          },
          m(DataGrid, {
            schema: schemaRegistry,
            rootSchema: SCHEMA_ROOT,
            data: ds,
            // Engages the `pf-data-grid--fill-height` CSS class so
            // the inner virtualized Grid can use the wrapper's 500px
            // as its viewport (without this the grid renders every
            // row regardless of how big the result set is).
            fillHeight: true,
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
              // header click reverts on every redraw. The sort
              // also gets persisted to traceOrderByState so a
              // reload doesn't drop it, and a Run picks it up as
              // `trace_order_by` on /execute_*.
              const sorted = cols.find((c) => c.sort);
              this.traceListSortField = sorted?.field;
              this.traceListSortDirection = sorted?.sort;
              this.writeTraceOrderBy(formatSingleFieldOrderBy(sorted));
              this.updateChosenColumns(cols.map((c) => c.field));
            },
            canAddColumns: true,
            canRemoveColumns: true,
            // Controlled-mode filter: source of truth is the binding
            // (per-tab snapshot) or `traceFiltersState` (global on
            // /settings). Persist immediately so a Run picks up the
            // latest selection without a separate "apply" step.
            filters: this.traceFilterss,
            onFiltersChanged: (filters: readonly Filter[]) => {
              this.traceFilterss = filters;
              this.writeTraceFilters(filters);
            },
            emptyStateMessage:
              'No traces match your filter (or Trace Directory is empty).',
            disablePivotControls: true,
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
    const hasFilter = this.traceFilterss.length > 0;
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

  // A subtle "Restore defaults" button shown next to a column picker only when
  // its state is customized (non-default). Clicking resets to the live default
  // (re-checks defaultVisible and resumes tracking the backend's default as it
  // changes). Hidden at the default so it's never a no-op and doubles as an
  // "overridden" cue.
  private renderRestoreDefaultsButton(
    customized: boolean,
    title: string,
    onReset: () => void,
  ): m.Children {
    if (!customized) return null;
    return m(Button, {
      label: 'Restore defaults',
      icon: 'settings_backup_restore',
      title,
      onclick: () => {
        onReset();
        m.redraw();
      },
    });
  }

  // Checkboxes for the "Query Result Columns" card. Picks which
  // trace-metadata columns get stapled onto every QUERY RESULT row
  // (stored server-side in the per-query metadata sidecar, projected
  // at fetch time). Distinct state from `traceColumnsState` — these
  // checkboxes never affect the trace-list grid above. Unchosen (null)
  // attaches the schema's defaultVisible columns by default; a user who
  // wants none can uncheck every box (writes [] = "attach nothing").
  private renderQueryColumnsPicker(
    schemaCols: ReadonlyArray<TraceColumnDescriptor>,
  ): m.Children {
    // Resolve the tri-state against the live schema: an unchosen (null) state
    // shows the defaultVisible columns pre-checked, so the picker reflects what
    // a query attaches by default. The first toggle writes the resolved set ±
    // the change as a concrete list, which from then on is honored verbatim
    // (unchecking the last one writes [] = "attach nothing").
    const chosen = effectiveQueryColumns(
      this.readTraceMetadataColumns(),
      schemaCols,
    );
    const chosenSet = new Set(chosen);
    const customized = this.readTraceMetadataColumns() !== null;
    const options: MultiSelectOption[] = linkColumnFirst(
      schemaCols,
      (c) => c.name,
    ).map((col) => ({
      id: col.name,
      name: col.name,
      checked: chosenSet.has(col.name),
      details: col.description,
    }));
    return m(
      '.pf-bt-trace-query-columns',
      {
        style: {
          marginTop: '16px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        },
      },
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
      this.renderRestoreDefaultsButton(
        customized,
        "Attach the backend's default columns, and keep tracking that " +
          'default as it changes.',
        () => this.writeTraceMetadataColumns(null),
      ),
    );
  }

  // Compact popup multi-select for the trace grid's visible columns.
  // Each column = one checkable option in the popup; the button face
  // shows "Shown columns (N selected)". Scales gracefully when Phase
  // 2 introduces more metadata — no row-wrapping noise — and reuses
  // the multiselect widget's built-in search + select-all.
  //
  // `description` from /trace_metadata_schema becomes the per-option
  // tooltip (the multiselect widget surfaces `details` as the
  // hover title), so users can still discover what each column
  // means without leaving the popup.
  private renderColumnPicker(
    schemaCols: ReadonlyArray<TraceColumnDescriptor>,
    chosen: ReadonlyArray<string>,
  ): m.Children {
    const chosenSet = new Set(chosen);
    // The trace-grid shown-columns picker is backed by the global
    // traceColumnsState only (no per-tab binding), so its customized check and
    // reset both go straight to that state.
    const customized = traceColumnsState.get() !== null;
    const options: MultiSelectOption[] = linkColumnFirst(
      schemaCols,
      (c) => c.name,
    ).map((col) => ({
      id: col.name,
      name: col.name,
      checked: chosenSet.has(col.name),
      details: col.description,
    }));
    return m(
      '.pf-bt-trace-columns',
      {
        style: {
          marginTop: '20px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        },
      },
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
      this.renderRestoreDefaultsButton(
        customized,
        "Show the backend's default columns in the grid.",
        () => traceColumnsState.clear(),
      ),
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

    const body = m('.pf-settings-page', [
      bigTraceSettingsStorage.isExecConfigLoading &&
        m(EmptyState, {
          title: 'Loading settings...',
          icon: 'hourglass_empty',
          fillHeight: true,
        }),
      Array.from(categories.entries()).map(([category, catSettings]) => {
        const categoryHeader: m.Children = m(
          'h2.pf-settings-page__plugin-title',
          category,
        );

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
        // Append the trace-list grid + the result-columns picker below the
        // trace_directory / trace_limit cards. Two sibling cards: "Traces"
        // picks WHICH traces; "Query Result Columns" picks WHAT metadata is
        // attached to each row of query results. Both omitted while the user
        // is searching the settings list.
        if (category === TRACE_ADDRESS_DISPLAY && this.searchQuery === '') {
          const endpoint = getBigtraceEndpoint();
          cards.push(this.renderTraceListCard(endpoint));
          cards.push(this.renderQueryColumnsCard());
        }
        const categoryContent = m(CardStack, cards);

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
    // Enable/disable goes through the bound setting: per-tab in the embedded
    // "+ Add" modal (TabBoundSetting → the tab's own disabled set) and global
    // on the standalone /settings page. So toggling in the modal no longer
    // leaks to the global state.
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
    // Boolean settings carry their on/off in the value control itself, so a
    // second enable/disable Switch is just confusing — suppress it (disabled:
    // undefined hides the Switch, like the endpoint card). Every other type
    // gets the enable/disable Switch, on /settings and in the "+ Add" modal.
    const showToggle = setting.type !== 'boolean';
    return m(BigTraceSettingsCard, {
      id: setting.id,
      title: setting.name,
      description,
      controls: renderSetting(setting),
      disabled: showToggle ? disabled : undefined,
      fullWidthControls: fullWidth,
      onChange: showToggle
        ? (newDisabled: boolean) => {
            setting.setDisabled(newDisabled);
          }
        : undefined,
    });
  }
}
