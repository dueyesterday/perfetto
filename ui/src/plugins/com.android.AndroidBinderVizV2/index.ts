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

import {PerfettoPlugin} from '../../public/plugin';
import {Trace} from '../../public/trace';
import {SourceDataset} from '../../trace_processor/dataset';
import {LONG, LONG_NULL, NUM, STR} from '../../trace_processor/query_result';
import {
  buildTrackTree,
  createAndRegisterCounterTrack,
  createAndRegisterSliceTrack,
  filtersToSql,
} from './track_helpers';
import {BinderSliceDetailsPanel} from './details_panel';

export default class implements PerfettoPlugin {
  static readonly id = 'com.android.AndroidBinderVizV2';

  async onTraceLoad(ctx: Trace): Promise<void> {
    await ctx.engine.query(`
      INCLUDE PERFETTO MODULE android.binder;
      INCLUDE PERFETTO MODULE intervals.overlap;
    `);

    await Promise.all([
      this.createPerspectiveTrack(ctx, 'server', 'client', 'binder_txn_id'),
      this.createPerspectiveTrack(ctx, 'client', 'server', 'binder_reply_id'),
    ]);
  }

  private async createPerspectiveTrack(
    ctx: Trace,
    perspective: string,
    opposite: string,
    sliceIdCol: string,
  ): Promise<void> {
    const aggColumns = [
      `${perspective}_process`,
      `(IFNULL(interface, "unknown interface"))`,
      `(IFNULL(method_name, "unknown method"))`,
      `(${opposite}_process || ":" || ${opposite}_upid)`,
      `(${opposite}_thread || ":" || ${opposite}_utid)`,
    ];
    const sliceColumn = 'IFNULL(aidl_name, "unknown aidl")';
    const allColumns = [...aggColumns, sliceColumn];

    const overlapSql = (whereClause?: string) => {
      const filter = whereClause ? `WHERE ${whereClause}` : '';
      return `
        SELECT ts, value FROM intervals_overlap_count!(
          (SELECT ${opposite}_ts AS ts, ${opposite}_dur AS dur
           FROM android_binder_txns ${filter}),
          ts, dur
        )
      `;
    };

    // Query all distinct value combinations for building the hierarchy.
    const query = await ctx.engine.query(`
      SELECT ${allColumns.join(', ')}
      FROM android_binder_txns
      GROUP BY ${allColumns.join(', ')}
    `);

    // Root counter track shows total overlap count.
    const rootNode = await createAndRegisterCounterTrack({
      trace: ctx,
      name: `Binder ${perspective} Transaction Counts`,
      sqlSource: overlapSql(),
    });

    // Build the hierarchy: levels 0–4 are counter tracks, level 5 is slices.
    await buildTrackTree({
      query,
      columns: allColumns,
      rootNode,
      createNode: async ({name, level, filters}) => {
        const where = filtersToSql(filters);
        if (level < aggColumns.length) {
          return createAndRegisterCounterTrack({
            trace: ctx,
            name,
            sqlSource: overlapSql(where),
          });
        }
        return createAndRegisterSliceTrack({
          trace: ctx,
          name,
          dataset: new SourceDataset({
            schema: {id: NUM, ts: LONG, dur: LONG_NULL, name: STR},
            src: `
              SELECT
                ${sliceIdCol} AS id,
                ${opposite}_ts AS ts,
                ${opposite}_dur AS dur,
                ${sliceColumn} AS name
              FROM android_binder_txns
              WHERE ${where}
            `,
          }),
          detailsPanel: () => new BinderSliceDetailsPanel(ctx),
        });
      },
    });

    ctx.defaultWorkspace.addChildInOrder(rootNode);
  }
}
