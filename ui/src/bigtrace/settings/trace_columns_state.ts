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

// Persisted set of columns the user has chosen to see in the trace-selection
// grid. Backs the DataGrid's controlled `columns` prop.
//
// Storage strategy: an explicit `chosen` array once the user picks columns,
// and `null` (the default / cleared state) when they haven't. `null` means
// "use the schema's defaultVisible-flagged columns", so a backend that adds a
// new defaultVisible column surfaces it without the user opting in.

// Minimal shape of a /trace_metadata_schema column, as far as the effective
// resolution cares.
interface SchemaColumn {
  readonly name: string;
  readonly defaultVisible: boolean;
}

class TraceColumnsState extends SingleFieldStorage<readonly string[] | null> {
  constructor() {
    super('bigtraceTraceColumns', 'chosen', parseNullableStringArray, null);
  }

  // The effective visible-column list against a live schema. When the user
  // hasn't chosen (`null`), the defaultVisible columns in declaration order;
  // otherwise the persisted selection intersected with the schema, so a stale
  // entry referencing a removed column drops silently instead of breaking the
  // grid.
  effective(schema: ReadonlyArray<SchemaColumn>): string[] {
    const chosen = this.get();
    if (chosen === null) {
      return schema.filter((c) => c.defaultVisible).map((c) => c.name);
    }
    const known = new Set(schema.map((c) => c.name));
    return chosen.filter((c) => known.has(c));
  }
}

export const traceColumnsState = new TraceColumnsState();
