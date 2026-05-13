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

import {Filter} from '../../components/widgets/datagrid/model';
import {LocalStorage} from '../../core/local_storage';

// Persisted state for the trace-selection grid on the Settings page.
//
// The grid is the user's mechanism for choosing which traces a query
// will run over ("implicit selection" — the active filter on the grid
// IS the trace set the executor sees). The filter has to survive
// across navigations (Settings → Query → run), across tabs, and across
// reloads, so we mirror the persistence model of `endpointStorage` /
// `bigTraceSettingsStorage` and stash it in LocalStorage.
//
// `QueryRunner` reads this when building the execute request and ships
// it as the top-level `traceFilter` field. The Settings page reads it
// to seed the DataGrid in controlled mode and writes it back from
// `onFiltersChanged`. The `BigtraceTraceListDataSource` doesn't touch
// this module directly — it just receives the filter via the grid's
// model — but its results reflect the same filter because the Settings
// page wires both sides to the same Filter[].

const STORAGE_KEY = 'bigtraceTraceFilter';
const FILTERS_FIELD = 'filters';

class TraceFilterState {
  private readonly storage = new LocalStorage(STORAGE_KEY);

  // Returns [] when nothing is persisted, when the stored value is
  // malformed (older format, partial write, hand-edited LocalStorage),
  // or when the key was cleared. Callers don't need to defensively
  // null-check.
  get(): readonly Filter[] {
    const raw = this.storage.load()[FILTERS_FIELD];
    if (!Array.isArray(raw)) return [];
    return raw as Filter[];
  }

  set(filters: readonly Filter[]): void {
    this.storage.save({[FILTERS_FIELD]: [...filters]});
  }

  clear(): void {
    this.set([]);
  }
}

export const traceFilterState = new TraceFilterState();
