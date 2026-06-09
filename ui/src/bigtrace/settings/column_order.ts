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

// Convention: a column literally named `link` (the clickable open-trace link,
// rendered via linkify in both grids) leads every grid and picker when present.
// These helpers hoist it to the front of an already-ordered column list; both
// are no-ops when `link` is absent or already first, and preserve the relative
// order of every other column.

export const LINK_COLUMN = 'link';

// Hoist the `link` entry to the front, keying each item by name (so it works
// for both bare column-name lists and schema-descriptor objects).
export function linkColumnFirst<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
): T[] {
  const i = items.findIndex((it) => nameOf(it) === LINK_COLUMN);
  if (i <= 0) return [...items];
  return [items[i], ...items.slice(0, i), ...items.slice(i + 1)];
}

// String-list convenience over linkColumnFirst.
export function linkNameFirst(names: readonly string[]): string[] {
  return linkColumnFirst(names, (n) => n);
}
