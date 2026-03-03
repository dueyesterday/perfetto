// Copyright (C) 2025 The Android Open Source Project
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

import {Connection, Label, NodePort} from '../../widgets/nodegraph';
import {FromNodeData} from './from';
import {SelectNodeData} from './select';
import {FilterNodeData} from './filter';
import {SortNodeData} from './sort';
import {LimitNodeData} from './limit';
import {JoinNodeData} from './join';
import {GroupByNodeData} from './groupby';
import {DistinctNodeData} from './distinct';
import {IntervalIntersectNodeData} from './interval_intersect';
import {SelectionNodeData} from './selection';
import {UnionAllNodeData} from './union_all';
import {ExtendNodeData} from './extend';
import {ExtractArgNodeData} from './extract_arg';
import type {
  GroupNodeData,
  GroupInputNodeData,
  GroupOutputNodeData,
} from './group';

export {FromNodeData} from './from';
export {SelectNodeData} from './select';
export {FilterNodeData} from './filter';
export {SortNodeData} from './sort';
export {LimitNodeData} from './limit';
export {JoinNodeData} from './join';
export {GroupByNodeData} from './groupby';
export {DistinctNodeData} from './distinct';
export {IntervalIntersectNodeData} from './interval_intersect';
export {SelectionNodeData} from './selection';
export {UnionAllNodeData} from './union_all';
export {ExtendNodeData} from './extend';
export {ExtractArgNodeData} from './extract_arg';
export {GroupNodeData, GroupInputNodeData, GroupOutputNodeData} from './group';

export interface BaseNodeData {
  readonly id: string;
  x: number;
  y: number;
  nextId?: string;
}

export type NodeData =
  | FromNodeData
  | SelectNodeData
  | FilterNodeData
  | SortNodeData
  | LimitNodeData
  | JoinNodeData
  | GroupByNodeData
  | DistinctNodeData
  | IntervalIntersectNodeData
  | SelectionNodeData
  | UnionAllNodeData
  | ExtendNodeData
  | ExtractArgNodeData
  | GroupNodeData
  | GroupInputNodeData
  | GroupOutputNodeData;

export interface NodeQueryBuilderStore {
  readonly nodes: Map<string, NodeData>;
  readonly connections: Connection[];
  readonly labels: Label[];
}

export interface NodeConfig {
  readonly title: string;
  readonly icon?: string;
  readonly inputs?: ReadonlyArray<NodePort>;
  readonly outputs?: ReadonlyArray<NodePort>;
  readonly canDockTop?: boolean;
  readonly canDockBottom?: boolean;
  readonly hue: number;
}

export const NODE_CONFIGS: Record<NodeData['type'], NodeConfig> = {
  from: {
    title: 'From',
    icon: 'table_chart',
    outputs: [{content: 'Output', direction: 'right'}],
    canDockBottom: true,
    hue: 200,
  },
  select: {
    title: 'Select',
    icon: 'view_column',
    inputs: [{content: 'Input', direction: 'left'}],
    outputs: [{content: 'Output', direction: 'right'}],
    canDockTop: true,
    canDockBottom: true,
    hue: 100,
  },
  filter: {
    title: 'Filter',
    icon: 'filter_alt',
    inputs: [{content: 'Input', direction: 'left'}],
    outputs: [{content: 'Output', direction: 'right'}],
    canDockTop: true,
    canDockBottom: true,
    hue: 50,
  },
  sort: {
    title: 'Sort',
    icon: 'sort',
    inputs: [{content: 'Input', direction: 'left'}],
    outputs: [{content: 'Output', direction: 'right'}],
    canDockTop: true,
    canDockBottom: true,
    hue: 150,
  },
  limit: {
    title: 'Limit',
    icon: 'horizontal_rule',
    inputs: [{content: 'Input', direction: 'left'}],
    outputs: [{content: 'Output', direction: 'right'}],
    canDockTop: true,
    canDockBottom: true,
    hue: 30,
  },
  join: {
    title: 'Join',
    icon: 'join',
    inputs: [
      {content: 'Left', direction: 'left'},
      {content: 'Right', direction: 'left'},
    ],
    outputs: [{content: 'Output', direction: 'right'}],
    canDockTop: true,
    canDockBottom: true,
    hue: 300,
  },
  groupby: {
    title: 'Group By',
    icon: 'workspaces',
    inputs: [{content: 'Input', direction: 'left'}],
    outputs: [{content: 'Output', direction: 'right'}],
    canDockTop: true,
    canDockBottom: true,
    hue: 270,
  },
  distinct: {
    title: 'Distinct',
    icon: 'fingerprint',
    inputs: [{content: 'Input', direction: 'left'}],
    outputs: [{content: 'Output', direction: 'right'}],
    canDockTop: true,
    canDockBottom: true,
    hue: 330,
  },
  interval_intersect: {
    title: 'Interval Intersect',
    icon: 'compare_arrows',
    inputs: [
      {content: 'Left', direction: 'left'},
      {content: 'Right', direction: 'left'},
    ],
    outputs: [{content: 'Output', direction: 'right'}],
    canDockTop: true,
    canDockBottom: true,
    hue: 180,
  },
  selection: {
    title: 'Selection',
    icon: 'highlight_alt',
    outputs: [{content: 'Output', direction: 'right'}],
    canDockBottom: true,
    hue: 40,
  },
  union_all: {
    title: 'Union',
    icon: 'merge',
    inputs: [
      {content: 'Left', direction: 'left'},
      {content: 'Right', direction: 'left'},
    ],
    outputs: [{content: 'Output', direction: 'right'}],
    canDockTop: true,
    canDockBottom: true,
    hue: 240,
  },
  extract_arg: {
    title: 'Extract Arg',
    icon: 'data_object',
    inputs: [{content: 'Input', direction: 'left'}],
    outputs: [{content: 'Output', direction: 'right'}],
    canDockTop: true,
    canDockBottom: true,
    hue: 70,
  },
  extend: {
    title: 'Extend',
    icon: 'add_circle',
    inputs: [
      {content: 'Left', direction: 'left'},
      {content: 'Right', direction: 'left'},
    ],
    outputs: [{content: 'Output', direction: 'right'}],
    canDockTop: true,
    canDockBottom: true,
    hue: 290,
  },
  group: {
    title: 'Group',
    icon: 'folder',
    // Inputs/outputs are dynamic, derived from inner pseudo-nodes.
    hue: 60,
  },
  group_input: {
    title: 'Inputs',
    icon: 'login',
    // Outputs are dynamic, derived from portLabels.
    hue: 60,
  },
  group_output: {
    title: 'Outputs',
    icon: 'logout',
    // Inputs are dynamic, derived from portLabels.
    hue: 60,
  },
};
