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

import {
  SingleFieldStorage,
  parseNullableStringArray,
} from './single_field_storage';
import {linkNameFirst} from './column_order';

// Persisted set of columns shown on the query-results DataGrid. Backs the
// grid's controlled-mode `columns` so the choice survives reload + applies
// across tabs.
//
// `null` (initial / cleared) means "show every column the backend surfaces in
// availableColumnNames". An explicit list means "show exactly these, in this
// order, intersected with what's actually available" — we intersect rather
// than literally project so a stale entry from a previous query's schema
// doesn't strand a brand-new query whose schema differs.

class QueryResultColumnsState extends SingleFieldStorage<
  readonly string[] | null
> {
  constructor() {
    super(
      'bigtraceQueryResultColumns',
      'chosen',
      parseNullableStringArray,
      null,
    );
  }

  // Reconcile the persisted selection against the live availableColumnNames.
  // Nothing persisted → every available column in declaration order ("show
  // all"). A persisted selection → intersected with the live set so stale
  // entries drop silently; if every entry is stale, fall back to "show all"
  // rather than a confusingly empty grid. Either way `link`, if present, is
  // hoisted to the front.
  effective(available: ReadonlyArray<string>): string[] {
    const chosen = this.get();
    if (chosen === null) {
      return linkNameFirst([...available]);
    }
    const known = new Set(available);
    const filtered = chosen.filter((c) => known.has(c));
    return linkNameFirst(filtered.length === 0 ? [...available] : filtered);
  }
}

export const queryResultColumnsState = new QueryResultColumnsState();
