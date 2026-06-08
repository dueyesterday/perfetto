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

import type {Filter} from '../../components/widgets/datagrid/model';
import {LocalStorage} from '../../core/local_storage';

// Persisted filter chips for the Settings-page trace-selection grid.
//
// The grid is how the user picks which traces a query runs over — the
// "implicit selection" model, where the active filter IS the trace set. That
// choice has to survive navigation (Settings -> Query -> run), reloads, and
// apply across tabs, so it lives in LocalStorage alongside `endpointStorage`.
//
// The grid binds to this in controlled mode: `get()` seeds the `filters` prop,
// `onFiltersChanged` calls `set()`. (A later change ships it as the
// `trace_filters` field on /execute_*.)
const STORAGE_KEY = 'bigtraceTraceFilters';
const FILTERS_FIELD = 'filters';

class TraceFilterState {
  private readonly storage = new LocalStorage(STORAGE_KEY);

  // Returns [] for nothing-stored, a malformed value (older format, partial
  // write, hand-edited LocalStorage), or a cleared key — so callers never
  // need a defensive null check.
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
