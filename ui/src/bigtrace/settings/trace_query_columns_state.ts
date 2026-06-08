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

// Persisted set of trace-metadata columns to staple onto every query result
// row. Distinct from `traceColumnsState` (what the trace-list grid SHOWS):
// this controls what the executor ATTACHES to each query result.
//
// Wire: read at submit time by QueryRunner, shipped as the top-level
// `trace_metadata_columns` field on /execute_*.
//
// Default: empty list — users opt in via the picker, keeping the default
// zero-overhead (a backend with expensive per-trace metadata pays nothing
// unless asked). This differs from traceColumnsState, where null means "use
// schema defaults".
const STORAGE_KEY = 'bigtraceTraceQueryColumns';
const CHOSEN_FIELD = 'chosen';

class TraceQueryColumnsState {
  private readonly storage = new LocalStorage(STORAGE_KEY);

  // Returns the user's selection, or [] for nothing-stored / a malformed
  // value. [] is the meaningful default ("attach nothing").
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
