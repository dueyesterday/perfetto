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
import {Checkbox} from '../../widgets/checkbox';
import {Chip} from '../../widgets/chip';
import {EmptyState} from '../../widgets/empty_state';
import {Select} from '../../widgets/select';
import {Stack} from '../../widgets/stack';
import {TextInput} from '../../widgets/text_input';
import {closeModal, redrawModal, showModal} from '../../widgets/modal';
import type {
  Filter,
  FilterOpAndValue,
} from '../../components/widgets/datagrid/model';
import {bigTraceSettingsStorage} from '../settings/bigtrace_settings_storage';
import {endpointStorage} from '../settings/endpoint_storage';
import type {Setting as BigTraceSetting} from '../settings/settings_types';
import {renderSetting} from '../settings/settings_widgets';
import {
  type SettingsBindings,
  TabBoundSetting,
} from '../settings/tab_bound_setting';
import {
  BigtraceQueryClient,
  type TraceColumnDescriptor,
} from '../query/bigtrace_query_client';
import type {BigTraceEditorTab, QueryTabsState} from './query_tabs_state';
import {SettingsPage} from './settings_page';

export interface BigtraceSettingsBarAttrs {
  readonly tab: BigTraceEditorTab;
  readonly tabsState: QueryTabsState;
  readonly bindings: SettingsBindings;
}

// Horizontal chip strip at the top of each editor tab. Replaces the
// legacy collapsible drawer. Renders one chip per per-tab override
// (settings, trace filters, metadata columns) plus an "+ Add" chip
// that opens the kitchen-sink Settings modal. Body click on a chip
// opens a focused per-chip editor modal; the × resets / removes the
// underlying state.
export class BigtraceSettingsBar
  implements m.ClassComponent<BigtraceSettingsBarAttrs>
{
  view({attrs}: m.Vnode<BigtraceSettingsBarAttrs>): m.Children {
    const {tab, tabsState, bindings} = attrs;
    const metadataChip = renderMetadataColumnsChip(tab, tabsState, bindings);
    return m(
      '.pf-bt-settings-bar',
      m('span.pf-bt-settings-bar__label', 'Bigtrace settings:'),
      m(
        Stack,
        {
          orientation: 'horizontal',
          wrap: true,
          spacing: 'small',
          className: 'pf-bt-settings-bar__chips',
        },
        m(Chip, {
          label: 'Add',
          icon: 'add',
          className: 'pf-bt-settings-bar__add',
          onclick: () => openAddSettingsModal(bindings),
        }),
        renderSettingChips(tab, tabsState, bindings),
        renderFilterChips(tab, tabsState, bindings),
        // Divider + output-side chip pushed to the right edge of
        // the strip. Divider carries the auto-margin so it absorbs
        // remaining space; the chip flows next to it on the right.
        metadataChip !== null && [
          m('span.pf-bt-settings-bar__divider', {'aria-hidden': 'true'}),
          metadataChip,
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Chip rendering
// ---------------------------------------------------------------------------

// TRACE_ADDRESS settings always render (they're required for the
// backend to know what to run over). Non-TRACE_ADDRESS settings only
// render when this tab's value differs from the current global
// default — removing reverts to that default.
function renderSettingChips(
  tab: BigTraceEditorTab,
  tabsState: QueryTabsState,
  bindings: SettingsBindings,
): m.Children {
  const defaults = bigTraceSettingsStorage.buildSettingFilters();
  const defaultJsonById = new Map(
    defaults.map((d) => [d.settingId, JSON.stringify(d.values)] as const),
  );
  const defaultById = new Map(defaults.map((d) => [d.settingId, d] as const));
  const out: m.Children[] = [];
  const rendered = new Set<string>();

  for (const entry of tab.querySettings) {
    const setting = bigTraceSettingsStorage.get(entry.settingId) as
      | BigTraceSetting<unknown>
      | undefined;
    if (setting === undefined) continue;
    const isTraceAddress = entry.category === 'TRACE_ADDRESS';
    const matchesDefault =
      defaultJsonById.get(entry.settingId) === JSON.stringify(entry.values);
    if (!isTraceAddress && matchesDefault) continue;
    rendered.add(entry.settingId);
    out.push(
      renderSettingChip(setting, entry.values, bindings, isTraceAddress, () => {
        const def = defaultById.get(entry.settingId);
        bindings.setSettingValue(
          entry.settingId,
          def?.values ?? [],
          entry.category,
        );
        tabsState.markDirty();
        m.redraw();
      }),
    );
  }

  // TRACE_ADDRESS settings the catalog declares but the per-tab
  // snapshot doesn't carry yet — render the global default value so
  // the user can still click through to edit per-tab.
  for (const def of defaults) {
    if (def.category !== 'TRACE_ADDRESS') continue;
    if (rendered.has(def.settingId)) continue;
    const setting = bigTraceSettingsStorage.get(def.settingId) as
      | BigTraceSetting<unknown>
      | undefined;
    if (setting === undefined) continue;
    out.push(renderSettingChip(setting, def.values, bindings, true, undefined));
  }

  return out;
}

function renderSettingChip(
  setting: BigTraceSetting<unknown>,
  values: ReadonlyArray<string>,
  bindings: SettingsBindings,
  required: boolean,
  onRevert: (() => void) | undefined,
): m.Children {
  return m(Chip, {
    label: `${setting.name}: ${formatSettingValue(values)}`,
    removable: !required && onRevert !== undefined,
    onRemove: onRevert,
    onclick: (e: MouseEvent) => {
      if (eventFromCloseButton(e)) return;
      openSettingChipModal(setting, bindings);
    },
  });
}

function renderFilterChips(
  tab: BigTraceEditorTab,
  tabsState: QueryTabsState,
  bindings: SettingsBindings,
): m.Children {
  return tab.traceFilter.map((filter, idx) =>
    m(Chip, {
      label: formatFilterChipLabel(filter),
      removable: true,
      onRemove: () => {
        const next = tab.traceFilter.filter((_, i) => i !== idx);
        bindings.setTraceFilter(next);
        tabsState.markDirty();
        m.redraw();
      },
      onclick: (e: MouseEvent) => {
        if (eventFromCloseButton(e)) return;
        openFilterChipModal(idx, tab, bindings);
      },
    }),
  );
}

// Single combined chip listing the per-tab trace-metadata columns
// the executor will staple onto every query result row. Click opens
// the +Add modal (the picker lives there); × clears the list. Label
// uses plain English ("Show with results: …") instead of the wire
// term "metadata columns".
function renderMetadataColumnsChip(
  tab: BigTraceEditorTab,
  tabsState: QueryTabsState,
  bindings: SettingsBindings,
): m.Children {
  const cols = tab.traceMetadataColumns;
  if (cols.length === 0) return null;
  const head =
    cols.length <= 3 ? cols.join(', ') : `${cols.slice(0, 2).join(', ')}`;
  const tail = cols.length > 3 ? `, +${cols.length - 2} more` : '';
  const label = `Show with results: ${head}${tail}`;
  return m(Chip, {
    label,
    removable: true,
    onRemove: () => {
      bindings.setTraceMetadataColumns([]);
      tabsState.markDirty();
      m.redraw();
    },
    onclick: (e: MouseEvent) => {
      if (eventFromCloseButton(e)) return;
      openMetadataColumnsModal(bindings);
    },
  });
}

// ---------------------------------------------------------------------------
// Label formatting
// ---------------------------------------------------------------------------

function formatSettingValue(values: ReadonlyArray<string>): string {
  if (values.length === 0) return '(empty)';
  if (values.length === 1) return values[0] === '' ? '(empty)' : values[0];
  if (values.length <= 3) return values.join(', ');
  return `${values.slice(0, 2).join(', ')}, +${values.length - 2} more`;
}

function formatFilterChipLabel(f: Filter): string {
  if (f.op === 'is null' || f.op === 'is not null') {
    return `${f.field} ${f.op}`;
  }
  if (f.op === 'in' || f.op === 'not in') {
    const vals = f.value.map(String);
    if (vals.length <= 3) return `${f.field} ${f.op} ${vals.join(', ')}`;
    return `${f.field} ${f.op} ${vals.slice(0, 2).join(', ')}, +${vals.length - 2} more`;
  }
  // Remaining ops are scalar comparisons / patterns — OpFilter shape
  // with a single SqlValue. TS doesn't always narrow the discriminant
  // via prior early returns, so use `'value' in f` defensively.
  if ('value' in f) return `${f.field} ${f.op} ${String(f.value)}`;
  return `${f.field} ${f.op}`;
}

// The Chip widget renders the × as a Button inside the chip body,
// and that Button doesn't stopPropagation — so a × click bubbles up
// to the chip's onclick. Guard the per-chip click handlers by
// checking whether the originating element is (or sits inside) a
// .pf-button; if so, the × did its job and we shouldn't also open
// the edit modal.
function eventFromCloseButton(e: MouseEvent): boolean {
  const t = e.target;
  if (!(t instanceof Element)) return false;
  return t.closest('.pf-button') !== null;
}

// ---------------------------------------------------------------------------
// Modal openers
// ---------------------------------------------------------------------------

// Kitchen-sink modal: hosts the SettingsPage in embedded mode, bound
// to per-tab state. Initial port of the legacy drawer body into a
// modal shell. Restructure / polish happens in follow-up iterations.
function openAddSettingsModal(bindings: SettingsBindings): void {
  void showModal({
    title: 'Bigtrace settings',
    className: 'pf-bt-settings-modal',
    vAlign: 'TOP',
    content: () => m(SettingsPage, {bindings}),
    buttons: [{text: 'Done', primary: true}],
  });
}

// Focused modal for editing one setting's value. Reuses the same
// renderSetting widget the SettingsPage uses, so the input matches
// the setting's declared type.
function openSettingChipModal(
  setting: BigTraceSetting<unknown>,
  bindings: SettingsBindings,
): void {
  const bound = new TabBoundSetting(setting, bindings);
  void showModal({
    title: setting.name,
    className: 'pf-bt-settings-chip-modal',
    content: () =>
      m(
        '.pf-bt-settings-chip-modal__body',
        setting.description !== '' &&
          m('.pf-bt-settings-chip-modal__description', setting.description),
        m('.pf-bt-settings-chip-modal__control', renderSetting(bound)),
      ),
    buttons: [{text: 'Done', primary: true}],
  });
}

// Focused modal for the per-tab trace-metadata-columns picker.
// Fetches /traces_schema with the tab's effective settings on open,
// then renders a flat checkbox list. Toggles commit live through
// bindings (parity with the setting chip modal); Done closes.
function openMetadataColumnsModal(bindings: SettingsBindings): void {
  type SchemaState =
    | {readonly kind: 'loading'}
    | {readonly kind: 'error'; readonly message: string}
    | {
        readonly kind: 'loaded';
        readonly cols: ReadonlyArray<TraceColumnDescriptor>;
      };
  let schemaState: SchemaState = {kind: 'loading'};

  const endpointSetting = endpointStorage.get('bigtraceEndpoint');
  const endpoint = endpointSetting ? (endpointSetting.get() as string) : '';
  if (endpoint.trim() === '') {
    schemaState = {
      kind: 'error',
      message: 'Set the BigTrace Endpoint in Settings to load trace columns.',
    };
  } else {
    const client = new BigtraceQueryClient(endpoint);
    void client.listTracesSchema(bindings.getEffectiveSettings()).then(
      (resp) => {
        schemaState = {kind: 'loaded', cols: resp.columns};
        redrawModal();
      },
      (err: unknown) => {
        schemaState = {
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        };
        redrawModal();
      },
    );
  }

  void showModal({
    title: 'Show with results',
    className: 'pf-bt-settings-chip-modal',
    content: () => {
      if (schemaState.kind === 'loading') {
        return m(EmptyState, {
          title: 'Loading available columns…',
          icon: 'hourglass_empty',
        });
      }
      if (schemaState.kind === 'error') {
        return m(
          '.pf-bt-settings-chip-modal__body',
          m('.pf-bt-settings-chip-modal__description', schemaState.message),
        );
      }
      const chosen = new Set(bindings.getTraceMetadataColumns());
      return m(
        '.pf-bt-settings-chip-modal__body',
        m(
          '.pf-bt-settings-chip-modal__description',
          'Pick trace details to show alongside every query result row.',
        ),
        m(
          '.pf-bt-settings-chip-modal__checklist',
          schemaState.cols.map((col) =>
            m(Checkbox, {
              checked: chosen.has(col.name),
              label: col.name,
              onchange: (e: Event) => {
                const target = e.currentTarget;
                const input =
                  target instanceof HTMLLabelElement
                    ? target.querySelector('input')
                    : null;
                if (!(input instanceof HTMLInputElement)) return;
                const next = input.checked
                  ? [...bindings.getTraceMetadataColumns(), col.name]
                  : bindings
                      .getTraceMetadataColumns()
                      .filter((c) => c !== col.name);
                bindings.setTraceMetadataColumns(next);
                m.redraw();
              },
            }),
          ),
        ),
      );
    },
    buttons: [{text: 'Done', primary: true}],
  });
}

// Focused modal for editing one trace_filter entry. Field is shown
// read-only (to swap fields, the user removes + re-adds the filter
// via +Add). Op picker switches the value editor flavor: text input
// for scalar comparisons / patterns, comma-separated text for in /
// not in, no value for null ops.
function openFilterChipModal(
  filterIndex: number,
  tab: BigTraceEditorTab,
  bindings: SettingsBindings,
): void {
  const initial = tab.traceFilter[filterIndex];
  if (initial === undefined) return;
  // Draft state local to the modal. Committed on Save (writes through
  // bindings.setTraceFilter). Cancel / Esc / close → discard.
  let op: FilterOpAndValue['op'] = initial.op;
  let valueStr = filterValueToEditString(initial);
  const field = initial.field;

  void showModal({
    title: `Edit filter — ${field}`,
    className: 'pf-bt-settings-chip-modal',
    content: () =>
      m(
        '.pf-bt-settings-chip-modal__body',
        m('.pf-bt-settings-chip-modal__field-row', [
          m('label.pf-bt-settings-chip-modal__field-label', 'Field'),
          m('span.pf-bt-settings-chip-modal__field-value', field),
        ]),
        m('.pf-bt-settings-chip-modal__field-row', [
          m('label.pf-bt-settings-chip-modal__field-label', 'Operator'),
          m(
            Select,
            {
              value: op,
              onchange: (e: Event) => {
                const next = (e.target as HTMLSelectElement)
                  .value as FilterOpAndValue['op'];
                // Switching to / from a multi-value op may invalidate
                // the value string; reset to keep the editor sensible.
                const wasMulti = op === 'in' || op === 'not in';
                const nowMulti = next === 'in' || next === 'not in';
                if (wasMulti !== nowMulti) valueStr = '';
                op = next;
              },
            },
            FILTER_OP_OPTIONS.map((o) =>
              m('option', {value: o, selected: o === op}, o),
            ),
          ),
        ]),
        op !== 'is null' &&
          op !== 'is not null' &&
          m('.pf-bt-settings-chip-modal__field-row', [
            m('label.pf-bt-settings-chip-modal__field-label', 'Value'),
            m(TextInput, {
              value: valueStr,
              placeholder:
                op === 'in' || op === 'not in'
                  ? 'comma-separated values'
                  : 'value',
              onInput: (v: string) => {
                valueStr = v;
              },
              onChange: (v: string) => {
                valueStr = v;
              },
            }),
          ]),
      ),
    buttons: [
      {text: 'Cancel'},
      {
        text: 'Save',
        primary: true,
        action: () => {
          const built = buildFilterEntry(field, op, valueStr);
          if (built === undefined) return;
          const next = [...tab.traceFilter];
          next[filterIndex] = built;
          bindings.setTraceFilter(next);
          m.redraw();
          // Close the modal manually since `action` doesn't auto-close.
          closeModal();
        },
      },
    ],
  });
}

// Op enumeration order matches `~/Projects/CLAUDE.md` Filter parameter
// op-categories table.
const FILTER_OP_OPTIONS: ReadonlyArray<FilterOpAndValue['op']> = [
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'glob',
  'not glob',
  'in',
  'not in',
  'is null',
  'is not null',
];

// Pre-fill the value editor from an existing filter. `in` / `not in`
// arrays render as comma-joined strings; null ops have no value.
function filterValueToEditString(f: Filter): string {
  if (f.op === 'is null' || f.op === 'is not null') return '';
  if (f.op === 'in' || f.op === 'not in') {
    return f.value.map(String).join(', ');
  }
  if ('value' in f) return String(f.value);
  return '';
}

// Inverse of filterValueToEditString. For `in` / `not in`, splits on
// commas and trims empties out. Returns undefined when the value is
// empty for an op that requires a value (caller can keep the modal
// open).
function buildFilterEntry(
  field: string,
  op: FilterOpAndValue['op'],
  valueStr: string,
): Filter | undefined {
  if (op === 'is null' || op === 'is not null') {
    return {field, op};
  }
  if (op === 'in' || op === 'not in') {
    const arr = valueStr
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    if (arr.length === 0) return undefined;
    return {field, op, value: arr};
  }
  if (valueStr.trim() === '') return undefined;
  return {field, op, value: valueStr};
}
