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

import type {
  Setting,
  SettingDescriptor,
  SettingFilter,
  SettingCategory,
} from './settings_types';
import {SettingImpl} from './setting_impl';
import {LocalStorage} from '../../core/local_storage';
import {BIGTRACE_SETTINGS_STORAGE_KEY} from './settings_storage';
import {SettingsLoader} from './settings_loader';
import m from 'mithril';

// Public interface consumed by the loader. Keeps the loader decoupled from
// the concrete store implementation.
export interface BigTraceSettingsStore {
  register<T>(setting: SettingDescriptor<T>): Setting<T>;
  get<T>(id: string): Setting<T> | undefined;
  getAllSettings(): ReadonlyArray<Setting<unknown>>;
  buildSettingFilters(opts?: {includeDisabled?: boolean}): SettingFilter[];
  clear(): void;
}

// Synchronous store for backend-provided settings. All async orchestration
// lives in SettingsLoader which calls back into this store's register().
class BigTraceSettingsStoreImpl implements BigTraceSettingsStore {
  private settings = new Map<string, Setting<unknown>>();
  private readonly storage: LocalStorage;

  // Loading is handled by the companion SettingsLoader instance.
  readonly loader: SettingsLoader;

  constructor(storage: LocalStorage) {
    this.storage = storage;
    this.loader = new SettingsLoader(this);
  }

  // ----- Delegated to loader (convenience API) -----

  async loadSettings(force?: boolean): Promise<void> {
    return this.loader.loadSettings(force);
  }

  get loadError(): string | undefined {
    return this.loader.loadError;
  }

  get isLoading(): boolean {
    return this.loader.isLoading;
  }

  get isExecConfigLoading(): boolean {
    return this.loader.loadingPhase === 'exec';
  }

  get execConfigLoadError(): string | undefined {
    return this.loader.execConfigLoadError;
  }

  // ----- Store CRUD -----

  register<T>(descriptor: SettingDescriptor<T>): Setting<T> {
    const setting = new SettingImpl(this, descriptor, disabledStateStorage);
    this.settings.set(descriptor.id, setting as unknown as Setting<unknown>);
    return setting;
  }

  get<T>(id: string): Setting<T> | undefined {
    return this.settings.get(id) as Setting<T> | undefined;
  }

  getAllSettings(): ReadonlyArray<Setting<unknown>> {
    return Array.from(this.settings.values());
  }

  getStoredValue(id: string): unknown {
    return this.storage.load()[id];
  }

  setStoredValue(id: string, value: unknown): void {
    const data = this.storage.load();
    data[id] = value;
    this.storage.save(data);
  }

  resetAll(): void {
    this.storage.save({});
    m.redraw();
  }

  // ----- Filter assembly -----

  // `includeDisabled` builds filters for every categorised setting regardless
  // of its enabled state — used by the per-tab merge, which applies the tab's
  // own disabled set on top (so a tab can enable a setting the global default
  // has off, and vice-versa).
  buildSettingFilters(opts?: {includeDisabled?: boolean}): SettingFilter[] {
    const includeDisabled = opts?.includeDisabled ?? false;
    const filters: SettingFilter[] = [];
    for (const setting of this.getAllSettings()) {
      if (
        setting.category !== undefined &&
        (includeDisabled || !setting.isDisabled())
      ) {
        let values: string[] = [];
        const val = setting.get();
        if (Array.isArray(val)) {
          values = val.map(String);
        } else {
          values = [String(val)];
        }

        if (setting.options && setting.options.length > 0) {
          const validOptionValues = new Set(
            setting.options.map((opt) =>
              typeof opt === 'string' ? opt : String(opt.value),
            ),
          );
          values = values.filter((v) => validOptionValues.has(v));
        }

        filters.push({
          settingId: setting.id,
          category: setting.category as SettingCategory,
          values,
        });
      }
    }
    return filters;
  }

  clear(): void {
    this.settings.clear();
  }
}

const SETTINGS_DISABLED_STATE_STORAGE_KEY = 'bigtraceSettingsDisabledState';
const disabledStateStorage = new LocalStorage(
  SETTINGS_DISABLED_STATE_STORAGE_KEY,
);

export const bigTraceSettingsStorage = new BigTraceSettingsStoreImpl(
  new LocalStorage(BIGTRACE_SETTINGS_STORAGE_KEY),
);
