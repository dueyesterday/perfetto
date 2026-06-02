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

import {LocalStorage} from '../../core/local_storage';

// Per-user persisted set of columns shown on the query results
// DataGrid. Backs the grid's controlled-mode `columns` so the
// preference survives reload + applies across tabs.
//
// `null` (initial / cleared) means "show every column the backend
// surfaces in availableColumnNames". An explicit list means "show exactly
// these, in this order, intersected with what's actually available".
// We intersect rather than literally project so a stale entry from a
// previous query schema doesn't break a brand-new query whose schema
// has different columns.

const STORAGE_KEY = 'bigtraceQueryResultColumns';
const CHOSEN_FIELD = 'chosen';

class QueryResultColumnsState {
  private readonly storage = new LocalStorage(STORAGE_KEY);

  get(): readonly string[] | null {
    const raw = this.storage.load()[CHOSEN_FIELD];
    if (raw === null || raw === undefined) return null;
    if (!Array.isArray(raw)) return null;
    const filtered = raw.filter((v): v is string => typeof v === 'string');
    if (filtered.length === 0) return null;
    return filtered;
  }

  set(columns: readonly string[]): void {
    this.storage.save({[CHOSEN_FIELD]: [...columns]});
  }

  clear(): void {
    this.storage.save({[CHOSEN_FIELD]: null});
  }

  // Reconcile the persisted selection against the live
  // `availableColumnNames` from the backend. When nothing is persisted
  // we return every available column in declaration order (the
  // "show all" default). When a selection is persisted, we
  // intersect with the live set so stale entries are silently
  // dropped — that way a schema change between queries doesn't
  // result in an empty grid.
  effective(available: ReadonlyArray<string>): string[] {
    const chosen = this.get();
    if (chosen === null) {
      return [...available];
    }
    const known = new Set(available);
    const filtered = chosen.filter((c) => known.has(c));
    // If every persisted entry is stale, fall back to "show all" so
    // the user doesn't get a confusingly empty grid.
    return filtered.length === 0 ? [...available] : filtered;
  }
}

export const queryResultColumnsState = new QueryResultColumnsState();
