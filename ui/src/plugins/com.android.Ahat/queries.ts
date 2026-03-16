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

// SQL query layer — pure functions mapping (Engine) → Promise<DisplayType>.
// Replaces the Web Worker RPC protocol with direct trace processor queries.

import {Engine} from '../../trace_processor/engine';
import {NUM, STR} from '../../trace_processor/query_result';
import type {OverviewData, HeapInfo, DuplicateBitmapGroup} from './types';

// ─── Overview ─────────────────────────────────────────────────────────────────

export async function getOverview(engine: Engine): Promise<OverviewData> {
  const countRes = await engine.query(
    `SELECT count(*) as cnt FROM heap_graph_object WHERE reachable != 0`,
  );
  const instanceCount = countRes.iter({cnt: NUM}).cnt;

  const heapRes = await engine.query(`
    SELECT
      ifnull(heap_type, 'default') AS heap,
      SUM(self_size) AS java,
      SUM(native_size) AS native_
    FROM heap_graph_object
    WHERE reachable != 0
    GROUP BY heap
    ORDER BY heap
  `);
  const heaps: HeapInfo[] = [];
  for (
    const it = heapRes.iter({heap: STR, java: NUM, native_: NUM});
    it.valid();
    it.next()
  ) {
    heaps.push({name: it.heap, java: it.java, native_: it.native_});
  }

  // Duplicate bitmaps: find bitmaps with the same (width, height).
  // First query gets per-bitmap dimensions + retained size.
  const dupRes = await engine.query(`
    SELECT
      MAX(CASE WHEN f.field_name GLOB '*mWidth' THEN f.int_value END) AS w,
      MAX(CASE WHEN f.field_name GLOB '*mHeight' THEN f.int_value END) AS h,
      ifnull(d.dominated_size_bytes, o.self_size)
        + ifnull(d.dominated_native_size_bytes, o.native_size) AS total_bytes
    FROM heap_graph_object o
    JOIN heap_graph_class c ON o.type_id = c.id
    LEFT JOIN heap_graph_dominator_tree d ON d.id = o.id
    LEFT JOIN heap_graph_object_data od ON od.object_id = o.id
    LEFT JOIN heap_graph_primitive f ON f.field_set_id = od.field_set_id
    WHERE o.reachable != 0
      AND (c.name = 'android.graphics.Bitmap'
        OR c.deobfuscated_name = 'android.graphics.Bitmap')
    GROUP BY o.id
    HAVING w IS NOT NULL AND h IS NOT NULL
  `);
  // Aggregate by (w, h) to find duplicates.
  const dimGroups = new Map<
    string,
    {w: number; h: number; cnt: number; total: number; min: number}
  >();
  for (
    const it = dupRes.iter({w: NUM, h: NUM, total_bytes: NUM});
    it.valid();
    it.next()
  ) {
    const key = `${it.w}x${it.h}`;
    const existing = dimGroups.get(key);
    if (existing) {
      existing.cnt++;
      existing.total += it.total_bytes;
      existing.min = Math.min(existing.min, it.total_bytes);
    } else {
      dimGroups.set(key, {
        w: it.w,
        h: it.h,
        cnt: 1,
        total: it.total_bytes,
        min: it.total_bytes,
      });
    }
  }
  const duplicateBitmaps: DuplicateBitmapGroup[] = [];
  for (const g of dimGroups.values()) {
    if (g.cnt < 2) continue;
    duplicateBitmaps.push({
      width: g.w,
      height: g.h,
      count: g.cnt,
      totalBytes: g.total,
      wastedBytes: g.total - g.min,
    });
  }
  duplicateBitmaps.sort((a, b) => b.wastedBytes - a.wastedBytes);

  return {
    instanceCount,
    heaps,
    duplicateBitmaps:
      duplicateBitmaps.length > 0 ? duplicateBitmaps : undefined,
  };
}
