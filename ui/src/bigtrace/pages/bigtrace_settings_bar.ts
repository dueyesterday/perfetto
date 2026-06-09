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
import {Chip} from '../../widgets/chip';
import {Stack} from '../../widgets/stack';
import {showModal} from '../../widgets/modal';
import type {Filter} from '../../components/widgets/datagrid/model';
import {bigTraceSettingsStorage} from '../settings/bigtrace_settings_storage';
import type {Setting as BigTraceSetting} from '../settings/settings_types';
import type {SettingsBindings} from '../settings/tab_bound_setting';
import type {BigTraceEditorTab, QueryTabsState} from './query_tabs_state';
import {SettingsPage} from './settings_page';

export interface BigtraceSettingsBarAttrs {
  readonly tab: BigTraceEditorTab;
  readonly tabsState: QueryTabsState;
  readonly bindings: SettingsBindings;
}

// Horizontal chip strip at the top of each editor tab. Replaces the
// legacy collapsible drawer. Renders one chip per per-tab override
// (settings, trace filters) plus an "+ Add" chip that opens the
// kitchen-sink Settings modal; the × resets / removes the underlying
// state. Trace-metadata columns are intentionally NOT surfaced here —
// they're managed only in the "+ Add" modal's Query Result Columns card.
export class BigtraceSettingsBar
  implements m.ClassComponent<BigtraceSettingsBarAttrs>
{
  view({attrs}: m.Vnode<BigtraceSettingsBarAttrs>): m.Children {
    const {tab, tabsState, bindings} = attrs;
    return m(
      '.pf-bt-settings-bar',
      m(
        Stack,
        {
          orientation: 'horizontal',
          wrap: true,
          spacing: 'small',
          className: 'pf-bt-settings-bar__chips',
        },
        m(Chip, {
          label: 'Add trace filter',
          icon: 'add',
          className: 'pf-bt-settings-bar__add',
          onclick: () => openAddSettingsModal(bindings),
        }),
        renderSettingChips(tab, tabsState, bindings),
        renderFilterChips(tab, tabsState, bindings),
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
    // A per-tab-disabled setting is excluded from effectiveTabSettings (the
    // settings the tab actually runs with), so its chip must drop too — else
    // the strip claims a filter the run won't apply.
    if (bindings.isSettingDisabled(entry.settingId)) continue;
    const isTraceAddress = entry.category === 'TRACE_ADDRESS';
    const matchesDefault =
      defaultJsonById.get(entry.settingId) === JSON.stringify(entry.values);
    if (!isTraceAddress && matchesDefault) continue;
    rendered.add(entry.settingId);
    out.push(
      renderSettingChip(setting, entry.values, isTraceAddress, () => {
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

  // TRACE_ADDRESS settings the catalog declares but the per-tab snapshot
  // doesn't carry yet — render the global default value as a display chip.
  for (const def of defaults) {
    if (def.category !== 'TRACE_ADDRESS') continue;
    if (rendered.has(def.settingId)) continue;
    // Same as above: a disabled TRACE_ADDRESS setting isn't part of the run.
    if (bindings.isSettingDisabled(def.settingId)) continue;
    const setting = bigTraceSettingsStorage.get(def.settingId) as
      | BigTraceSetting<unknown>
      | undefined;
    if (setting === undefined) continue;
    out.push(renderSettingChip(setting, def.values, true, undefined));
  }

  return out;
}

function renderSettingChip(
  setting: BigTraceSetting<unknown>,
  values: ReadonlyArray<string>,
  required: boolean,
  onRevert: (() => void) | undefined,
): m.Children {
  // Read-only display chip. A × reverts non-required settings to the global
  // default; editing happens in the "+ Add" modal, so the body isn't clickable.
  return m(Chip, {
    label: `${setting.name}: ${formatSettingValue(values)}`,
    removable: !required && onRevert !== undefined,
    onRemove: onRevert,
  });
}

function renderFilterChips(
  tab: BigTraceEditorTab,
  tabsState: QueryTabsState,
  bindings: SettingsBindings,
): m.Children {
  return tab.traceFilters.map((filter, idx) =>
    m(Chip, {
      label: formatFilterChipLabel(filter),
      removable: true,
      onRemove: () => {
        const next = tab.traceFilters.filter((_, i) => i !== idx);
        bindings.setTraceFilters(next);
        tabsState.markDirty();
        m.redraw();
      },
      // Filter chips are display + remove only here (editable filter chips
      // are intentionally excluded). Add/refine filters on the trace grid in
      // the "+ Add" Settings modal.
    }),
  );
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

// ---------------------------------------------------------------------------
// Modal opener — the only clickable affordance on the bar.
// ---------------------------------------------------------------------------

// Kitchen-sink modal: hosts the SettingsPage in embedded (per-tab) mode. All
// editing — settings, trace selection on the grid, metadata columns — happens
// here; the chips are read-only display (with × to remove/revert).
function openAddSettingsModal(bindings: SettingsBindings): void {
  void showModal({
    title: 'Bigtrace settings',
    className: 'pf-bt-settings-modal',
    vAlign: 'TOP',
    content: () => m(SettingsPage, {bindings}),
    buttons: [{text: 'Done', primary: true}],
  });
}

// (Editable filter chips intentionally excluded — no per-chip filter editor.
// Filters are added / refined on the trace grid in the "+ Add" modal and
// removed via the chip's ×.)
