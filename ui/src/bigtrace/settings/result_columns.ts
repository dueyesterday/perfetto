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

import {groupResultColumns} from './column_order';

// Resolve a tab's shown-columns selection (BigTraceEditorTab.resultColumns,
// persisted per-tab) against the live availableColumnNames: null = show all; an
// explicit list is intersected (stale entries drop, all-stale → show all).
// Ordered by groupResultColumns.
export function resolveResultColumns(
  chosen: readonly string[] | null,
  available: ReadonlyArray<string>,
): string[] {
  if (chosen === null) {
    return groupResultColumns([...available]);
  }
  const known = new Set(available);
  const filtered = chosen.filter((c) => known.has(c));
  return groupResultColumns(filtered.length === 0 ? [...available] : filtered);
}
