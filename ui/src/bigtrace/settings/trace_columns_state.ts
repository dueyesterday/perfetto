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

// Persisted set of columns the user has chosen to see in the
// trace-selection grid. Backs both the toggle-row widget on the
// Settings page and the DataGrid's built-in "+ Add column" header
// menu — they share one source of truth so the two affordances can't
// drift.
//
// Storage strategy: keep an explicit `chosen` array when the user has
// made a selection, and `null` (the "default") when they haven't.
// `null` means "use the schema's default-flagged columns" — that way
// a backend upgrade that adds new default-true columns surfaces them
// immediately without the user having to opt in.
//
// The wire-side defaults (server.py:_TRACE_LIST_SCHEMA) and the
// per-column `default: true` flag let this stay backend-agnostic.

const STORAGE_KEY = 'bigtraceTraceColumns';
const CHOSEN_FIELD = 'chosen';

class TraceColumnsState {
  private readonly storage = new LocalStorage(STORAGE_KEY);

  // Returns the user's explicit selection, or `null` to mean
  // "fall back to schema defaults". `null` is the initial / cleared
  // state; an empty selection (`[]`) is a degenerate state that the
  // caller should treat as a bug and recover from by resetting.
  get(): readonly string[] | null {
    const raw = this.storage.load()[CHOSEN_FIELD];
    if (raw === null || raw === undefined) return null;
    if (!Array.isArray(raw)) return null;
    // Defensive: filter out non-string entries from a malformed
    // earlier write before returning. Same shape as traceFilterState.
    const filtered = raw.filter((v): v is string => typeof v === 'string');
    if (filtered.length === 0) return null;
    return filtered;
  }

  set(columns: readonly string[]): void {
    this.storage.save({[CHOSEN_FIELD]: [...columns]});
  }

  // Revert to the schema's defaults. Useful as an "Reset columns"
  // action on the picker widget.
  clear(): void {
    this.storage.save({[CHOSEN_FIELD]: null});
  }

  // Convenience: resolves to the effective column list given a
  // schema response. When the user hasn't made a selection (`null`),
  // returns the schema's default-flagged columns in declaration
  // order. When they have, returns the persisted selection
  // intersected with the schema (so a stale localStorage entry
  // referencing a removed column doesn't blow up the grid).
  effective(
    schema: ReadonlyArray<{readonly name: string; readonly default: boolean}>,
  ): string[] {
    const chosen = this.get();
    if (chosen === null) {
      return schema.filter((c) => c.default).map((c) => c.name);
    }
    const known = new Set(schema.map((c) => c.name));
    return chosen.filter((c) => known.has(c));
  }
}

export const traceColumnsState = new TraceColumnsState();
