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
import type {Filter} from '../../components/widgets/datagrid/model';
import type {
  EnumOption,
  Setting as BigTraceSetting,
  SettingFilter,
} from './settings_types';

// Optional per-mount overrides. When provided, the SettingsPage reads
// and writes the per-query snapshot instead of the global LocalStorage
// modules. Used by the Query page's chip strip / +Add modal so the
// same SettingsPage visual is bound to per-tab state. `undefined`
// (the /settings route default) keeps the original global-state
// behavior — no caller regression possible.
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
  readonly getTraceFilters: () => readonly Filter[];
  readonly setTraceFilters: (filters: readonly Filter[]) => void;
  readonly getTraceMetadataColumns: () => readonly string[];
  readonly setTraceMetadataColumns: (cols: readonly string[]) => void;
  // Per-tab AIP-132 ordering string (e.g. "size_bytes desc"). Drives
  // the top-level `trace_order_by` field on the next Run. Empty
  // string defers to the backend default.
  readonly getTraceOrderBy: () => string;
  readonly setTraceOrderBy: (orderBy: string) => void;
  // Optional: called whenever the trace-list data source reports a
  // fresh `filteredTotalRows` (the count of traces the current filter
  // selects). Embedded callers can cache the value to surface it in a
  // header / chip without re-fetching. Undefined = count not yet known.
  readonly onTraceMatchCount?: (count: number | undefined) => void;
}

// Wraps a globally-registered `Setting<T>` so reads/writes route
// through per-tab bindings. Inherits the descriptor (type, schema,
// placeholder, options) so renderSetting() picks the right widget.
// Per-tab is always "enabled" — the disable Switch is hidden in the
// embedded layout, and TRACE_ADDRESS settings (the only ones surfaced
// in the snapshot) skip the Switch on /settings too.
export class TabBoundSetting<T> implements BigTraceSetting<T> {
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
export function convertFromWireValues<T>(
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
