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

import {SingleFieldStorage} from './single_field_storage';

// Minimal shape of a /trace_metadata_schema column, as far as the default
// resolution cares.
interface SchemaColumn {
  readonly name: string;
  readonly defaultVisible: boolean;
}

// Resolve a chosen query-columns value against a live schema.
//
//   null  → unchosen: attach the schema's defaultVisible columns (in
//           declaration order). This is the DEFAULT — symmetric with the
//           trace-list grid, which SHOWS its defaultVisible columns by default
//           (see traceColumnsState.effective). So a query attaches those
//           columns even on a tab whose picker was never opened.
//   [...] → exactly these columns, intersected with the live schema so a stale
//           entry referencing a removed column drops silently.
//   []    → explicit "attach nothing" (the user unchecked every column);
//           intersection of an empty list is empty, so it stays empty.
//
// Used by the picker (display + resolution of the chosen set) and by
// QueryRunner (resolving the per-tab snapshot at submit time, where the live
// schema is fetched to expand the null default).
export function effectiveQueryColumns(
  chosen: readonly string[] | null,
  schema: ReadonlyArray<SchemaColumn>,
): string[] {
  if (chosen === null) {
    return schema.filter((c) => c.defaultVisible).map((c) => c.name);
  }
  const known = new Set(schema.map((c) => c.name));
  return chosen.filter((c) => known.has(c));
}

// Persisted set of trace-metadata columns to staple onto every query result
// row. Distinct from `traceColumnsState` (what the trace-list grid SHOWS):
// this controls what the executor ATTACHES to each query result.
//
// Wire: read at submit time by QueryRunner, resolved via effectiveQueryColumns
// against the live schema, and shipped as the top-level `trace_metadata_columns`
// field on /execute_*.
//
// Tri-state (see effectiveQueryColumns):
//   null  → unchosen, attach the schema's defaultVisible columns (the default).
//   []    → explicit "attach nothing".
//   [...] → exactly these columns.
// `null` (not `[]`) is the unchosen sentinel — unlike traceColumnsState we must
// NOT collapse `[]` to the default, or the user could never express "attach
// nothing" after unchecking everything. `get()` returns null for
// nothing-stored / a non-array (malformed); a stored array is filtered to
// strings and kept verbatim (the empty list included).
export const traceQueryColumnsState = new SingleFieldStorage<
  readonly string[] | null
>(
  'bigtraceTraceQueryColumns',
  'chosen',
  (raw) =>
    Array.isArray(raw)
      ? raw.filter((v): v is string => typeof v === 'string')
      : null,
  null,
);
