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

// Pure reconciliation + ordering for a tab's shown-columns selection. The
// selection itself is per-tab state — `BigTraceEditorTab.resultColumns`,
// persisted with the tab — and this resolves it at render time against the
// query's live availableColumnNames:
//
//   null  → show every available column.
//   [...] → show exactly these, intersected with what's actually available so a
//           stale entry from a different-shaped query drops silently; if every
//           entry is stale, fall back to show-all rather than an empty grid.
//
// Either way the result is ordered by groupResultColumns (`link` first, then
// the query's own columns, then `_`-prefixed metadata grouped at the end).
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
