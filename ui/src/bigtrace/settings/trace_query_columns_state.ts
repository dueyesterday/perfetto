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

// Persisted set of trace-metadata columns to staple onto every query
// result row. Distinct from `traceColumnsState` (which controls what
// the trace-list grid SHOWS): this state controls what the executor
// ATTACHES TO each query result.
//
// Wire: read at submit time by QueryRunner, shipped as the top-level
// `trace_metadata_columns` field on /execute_bigtrace_query[_async].
// Backend stitches the values into each result row between `trace_id`
// and the SQL columns.
//
// Default: empty list. Users opt in by ticking checkboxes in the
// dedicated picker below the trace grid. This keeps the default
// behaviour zero-overhead — a Phase-2 backend with expensive
// per-trace metadata won't pay anything unless the user asks for it.

const STORAGE_KEY = 'bigtraceTraceQueryColumns';
const CHOSEN_FIELD = 'chosen';

class TraceQueryColumnsState {
  private readonly storage = new LocalStorage(STORAGE_KEY);

  // Returns the user's persisted selection. `[]` is the meaningful
  // initial state ("don't staple any extra metadata"), unlike
  // traceColumnsState where null means "use schema defaults".
  get(): readonly string[] {
    const raw = this.storage.load()[CHOSEN_FIELD];
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is string => typeof v === 'string');
  }

  set(columns: readonly string[]): void {
    this.storage.save({[CHOSEN_FIELD]: [...columns]});
  }

  clear(): void {
    this.set([]);
  }
}

export const traceQueryColumnsState = new TraceQueryColumnsState();
