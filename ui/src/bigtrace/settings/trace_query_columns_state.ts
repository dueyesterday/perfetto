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
import {linkNameFirst} from './column_order';

// Minimal shape of a /trace_metadata_schema column, as far as the default
// resolution cares.
interface SchemaColumn {
  readonly name: string;
  readonly defaultVisible: boolean;
}

// Resolve a chosen value against the live schema; `link` hoisted first.
//   null  → defaultVisible columns (the default; attached even if the picker
//           was never opened, mirroring the trace-list grid).
//   [...] → these, intersected with the schema (stale entries drop).
//   []    → attach nothing.
export function effectiveQueryColumns(
  chosen: readonly string[] | null,
  schema: ReadonlyArray<SchemaColumn>,
): string[] {
  if (chosen === null) {
    return linkNameFirst(
      schema.filter((c) => c.defaultVisible).map((c) => c.name),
    );
  }
  const known = new Set(schema.map((c) => c.name));
  return linkNameFirst(chosen.filter((c) => known.has(c)));
}

// Persisted trace-metadata columns attached to every query result row (shipped
// as `trace_metadata_columns` on /execute_*, resolved via effectiveQueryColumns).
// Distinct from traceColumnsState (what the trace-list grid SHOWS).
// Tri-state: null = unchosen (attach defaultVisible); [] = attach nothing; [...]
// = these. `null` (not `[]`) is the unchosen sentinel — don't collapse `[]`, or
// "attach nothing" couldn't be expressed.
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
