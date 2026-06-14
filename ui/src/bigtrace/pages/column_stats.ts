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

// Client-side column statistics over a query's result rows. The wire ships all
// values as strings, so numeric-ness is sniffed from the values themselves.

import type {ResultRow} from './result_rows_loader';

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

// A column counts as numeric if most of its sampled non-blank values parse to
// finite numbers.
export function isNumericColumn(
  rows: ReadonlyArray<ResultRow>,
  col: string,
): boolean {
  let seen = 0;
  let numeric = 0;
  for (const r of rows.slice(0, 40)) {
    const v = r[col];
    if (isBlank(v)) continue;
    seen++;
    if (Number.isFinite(Number(v))) numeric++;
  }
  return seen > 0 && numeric / seen >= 0.8;
}

export interface ColumnStat {
  readonly column: string;
  readonly numeric: boolean;
  readonly nonNull: number;
  readonly nulls: number;
  readonly distinct: number;
  readonly min?: number;
  readonly max?: number;
  readonly avg?: number;
}

export function computeColumnStats(
  rows: ReadonlyArray<ResultRow>,
  columns: ReadonlyArray<string>,
): ColumnStat[] {
  return columns.map((col) => {
    const distinct = new Set<string>();
    let nulls = 0;
    let numCount = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const r of rows) {
      const v = r[col];
      if (isBlank(v)) {
        nulls++;
        continue;
      }
      distinct.add(String(v));
      const n = Number(v);
      if (Number.isFinite(n)) {
        numCount++;
        sum += n;
        if (n < min) min = n;
        if (n > max) max = n;
      }
    }
    const nonNull = rows.length - nulls;
    const numeric = nonNull > 0 && numCount / nonNull >= 0.8;
    return {
      column: col,
      numeric,
      nonNull,
      nulls,
      distinct: distinct.size,
      min: numeric ? min : undefined,
      max: numeric ? max : undefined,
      avg: numeric && numCount > 0 ? sum / numCount : undefined,
    };
  });
}
