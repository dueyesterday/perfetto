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

// `link` (the clickable open-trace column, rendered via linkify in both grids)
// leads every grid/picker. These helpers reorder an already-ordered list.

export const LINK_COLUMN = 'link';

// Hoist `link` to the front (keyed by name); no-op if absent or already first.
export function linkColumnFirst<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
): T[] {
  const i = items.findIndex((it) => nameOf(it) === LINK_COLUMN);
  if (i <= 0) return [...items];
  return [items[i], ...items.slice(0, i), ...items.slice(i + 1)];
}

export function linkNameFirst(names: readonly string[]): string[] {
  return linkColumnFirst(names, (n) => n);
}

// Display order: `link`, then result columns, then `_`-prefixed metadata grouped
// at the end (stable within groups) — clusters metadata into a visual block.
// Nothing dropped.
export function groupResultColumns(names: readonly string[]): string[] {
  const link = names.filter((n) => n === LINK_COLUMN);
  const ordinary = names.filter((n) => n !== LINK_COLUMN && !n.startsWith('_'));
  const meta = names.filter((n) => n !== LINK_COLUMN && n.startsWith('_'));
  return [...link, ...ordinary, ...meta];
}
