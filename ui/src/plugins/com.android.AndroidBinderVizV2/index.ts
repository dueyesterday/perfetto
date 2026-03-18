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
import {TrackNode} from '../../public/workspace';
import {SourceDataset} from '../../trace_processor/dataset';
import {LONG, LONG_NULL, NUM, STR} from '../../trace_processor/query_result';
import {
  TrackTreeFilter,
  createAndRegisterCounterTrack,
  createAndRegisterSliceTrack,
  filtersToSql,
} from './track_helpers';
import {BinderSliceDetailsPanel} from './details_panel';

export default class implements PerfettoPlugin {
  static readonly id = 'com.android.AndroidBinderVizV2';

  async onTraceLoad(ctx: Trace): Promise<void> {
    ctx.commands.registerCommand({
      id: 'com.android.AndroidBinderVizV2.visualize',
      name: 'Binder: Visualize transaction counts',
      callback: () => this.visualize(ctx),
    });
  }

  private async visualize(ctx: Trace): Promise<void> {
    await ctx.engine.query(`
      INCLUDE PERFETTO MODULE android.binder;
      INCLUDE PERFETTO MODULE intervals.overlap;
    `);

    const count = await ctx.engine.query(
      'SELECT COUNT(*) AS cnt FROM android_binder_txns',
    );
    if (count.firstRow({cnt: LONG}).cnt === 0n) {
      return;
    }

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

    // Human-readable description for each hierarchy level, given the
    // name of the node at that level.
    const levelDescriptions: Array<(name: string) => string> = [
      // Level 0: perspective process
      (name) =>
        `Concurrent binder transactions ${perspective === 'server' ? 'handled by' : 'sent from'} ${name}.`,
      // Level 1: interface
      (name) => `Concurrent transactions on the ${name} interface.`,
      // Level 2: method
      (name) => `Concurrent calls to ${name}.`,
      // Level 3: opposite process
      (name) =>
        `Concurrent calls ${perspective === 'server' ? 'from client' : 'to server'} ${name}.`,
      // Level 4: opposite thread
      (name) => `Concurrent calls on ${opposite} thread ${name}.`,
      // Level 5: aidl slice
      (name) => `Individual binder transactions for AIDL method ${name}.`,
    ];

    const rootNode = await createAndRegisterCounterTrack({
      trace: ctx,
      name: `Binder ${perspective} Transaction Counts`,
      description:
        `Number of concurrent binder transactions ` +
        `${perspective === 'server' ? 'being handled by servers' : 'waiting for replies from servers'} ` +
        `across all processes.`,
      sqlSource: overlapSql(),
      onExpand: () => {
        this.expandLevel(
          ctx,
          rootNode,
          allColumns,
          aggColumns,
          sliceColumn,
          opposite,
          sliceIdCol,
          overlapSql,
          levelDescriptions,
          [],
          0,
        );
      },
    });

    ctx.defaultWorkspace.pinnedTracksNode.addChildLast(rootNode);
  }

  private async expandLevel(
    ctx: Trace,
    parentNode: TrackNode,
    allColumns: string[],
    aggColumns: string[],
    sliceColumn: string,
    opposite: string,
    sliceIdCol: string,
    overlapSql: (where?: string) => string,
    levelDescriptions: Array<(name: string) => string>,
    parentFilters: TrackTreeFilter[],
    level: number,
  ): Promise<void> {
    const column = allColumns[level];
    const whereClause =
      parentFilters.length > 0 ? `WHERE ${filtersToSql(parentFilters)}` : '';

    const result = await ctx.engine.query(`
      SELECT DISTINCT ${column}
      FROM android_binder_txns
      ${whereClause}
      ORDER BY ${column}
    `);

    const iter = result.iter({});
    for (; iter.valid(); iter.next()) {
      const rawValue = iter.get(column);
      const name = rawValue === null ? 'NULL' : rawValue.toString();
      const filters: TrackTreeFilter[] = [
        ...parentFilters,
        {column, value: rawValue},
      ];
      const where = filtersToSql(filters);
      const description = levelDescriptions[level](name);

      if (level < aggColumns.length) {
        const isLastAggLevel = level === aggColumns.length - 1;
        const nextLevel = level + 1;

        const childNode = await createAndRegisterCounterTrack({
          trace: ctx,
          name,
          description,
          sqlSource: overlapSql(where),
          onExpand: () => {
            this.expandLevel(
              ctx,
              childNode,
              allColumns,
              aggColumns,
              sliceColumn,
              opposite,
              sliceIdCol,
              overlapSql,
              levelDescriptions,
              filters,
              isLastAggLevel ? aggColumns.length : nextLevel,
            );
          },
        });
        parentNode.addChildInOrder(childNode);
      } else {
        // Leaf level: create a slice track (no further expansion).
        const childNode = createAndRegisterSliceTrack({
          trace: ctx,
          name,
          description,
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
        parentNode.addChildInOrder(childNode);
      }
    }
  }
}
