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

import {sqliteString} from '../../base/string_utils';
import {uuidv4} from '../../base/uuid';
import {TrackEventDetailsPanel} from '../../public/details_panel';
import {Trace} from '../../public/trace';
import {TrackNode} from '../../public/workspace';
import {SourceDataset} from '../../trace_processor/dataset';
import {QueryResult, SqlValue} from '../../trace_processor/query_result';
import {createQueryCounterTrack} from '../../components/tracks/query_counter_track';
import {SliceTrack, RowSchema} from '../../components/tracks/slice_track';

/**
 * Creates a counter track, registers it with the trace, and returns a
 * TrackNode. This eliminates the 3-step boilerplate of
 * createQueryCounterTrack + registerTrack + new TrackNode.
 */
export async function createAndRegisterCounterTrack(args: {
  readonly trace: Trace;
  readonly name: string;
  readonly sqlSource: string;
  readonly description?: string;
  readonly sortOrder?: number;
  readonly removable?: boolean;
}): Promise<TrackNode> {
  const uri = `/track_helpers_counter_${uuidv4()}`;
  const renderer = await createQueryCounterTrack({
    trace: args.trace,
    uri,
    materialize: false,
    data: {sqlSource: args.sqlSource},
    columns: {ts: 'ts', value: 'value'},
  });
  args.trace.tracks.registerTrack({
    uri,
    renderer,
    description: args.description,
  });
  return new TrackNode({
    uri,
    name: args.name,
    sortOrder: args.sortOrder,
    removable: args.removable,
  });
}

/**
 * Creates a slice track, registers it with the trace, and returns a
 * TrackNode.
 */
export function createAndRegisterSliceTrack<T extends RowSchema>(args: {
  readonly trace: Trace;
  readonly name: string;
  readonly dataset: SourceDataset<T>;
  readonly detailsPanel?: () => TrackEventDetailsPanel;
  readonly description?: string;
  readonly sortOrder?: number;
  readonly removable?: boolean;
}): TrackNode {
  const uri = `/track_helpers_slice_${uuidv4()}`;
  const renderer = SliceTrack.create({
    trace: args.trace,
    uri,
    dataset: args.dataset,
    detailsPanel: args.detailsPanel,
  });
  args.trace.tracks.registerTrack({
    uri,
    renderer,
    description: args.description,
  });
  return new TrackNode({
    uri,
    name: args.name,
    sortOrder: args.sortOrder,
    removable: args.removable,
  });
}

export interface TrackTreeFilter {
  readonly column: string;
  readonly value: SqlValue;
}

/**
 * Converts an array of filters to a SQL WHERE clause body.
 * Handles null, string, number, and bigint values correctly.
 */
export function filtersToSql(filters: ReadonlyArray<TrackTreeFilter>): string {
  return filters
    .map(({column, value}) => {
      if (value === null) return `${column} IS NULL`;
      if (typeof value === 'string') return `${column} = ${sqliteString(value)}`;
      return `${column} = ${value}`;
    })
    .join(' AND ');
}

/**
 * Builds a TrackNode tree from query results. For each row, walks through
 * the columns and creates a nested hierarchy of nodes, deduplicating at
 * each level.
 *
 * The caller provides a factory callback to create the right kind of
 * track at each level — this separates tree construction from track
 * creation logic.
 */
export async function buildTrackTree(args: {
  readonly query: QueryResult;
  readonly columns: string[];
  readonly rootNode: TrackNode;
  readonly createNode: (info: {
    name: string;
    level: number;
    filters: ReadonlyArray<TrackTreeFilter>;
  }) => Promise<TrackNode>;
}): Promise<void> {
  // Cache: parent URI → (child name → child TrackNode)
  const cache = new Map<string, Map<string, TrackNode>>();
  cache.set(args.rootNode.uri!, new Map());

  const iter = args.query.iter({});
  for (; iter.valid(); iter.next()) {
    let currentNode = args.rootNode;
    const filters: TrackTreeFilter[] = [];

    for (let level = 0; level < args.columns.length; level++) {
      const column = args.columns[level];
      const rawValue = iter.get(column);
      const childName = rawValue === null ? 'NULL' : rawValue.toString();

      filters.push({column, value: rawValue});

      let children = cache.get(currentNode.uri!);
      if (!children) {
        children = new Map();
        cache.set(currentNode.uri!, children);
      }

      let childNode = children.get(childName);
      if (!childNode) {
        childNode = await args.createNode({
          name: childName,
          level,
          filters: [...filters],
        });
        currentNode.addChildInOrder(childNode);
        children.set(childName, childNode);
      }
      currentNode = childNode;
    }
  }
}
