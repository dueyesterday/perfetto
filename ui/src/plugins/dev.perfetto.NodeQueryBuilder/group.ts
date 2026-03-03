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

import m from 'mithril';
import {shortUuid} from '../../base/uuid';
import {Button, ButtonVariant} from '../../widgets/button';
import {BaseNodeData, NodeData} from './node_types';

export interface GroupInputNodeData extends BaseNodeData {
  readonly type: 'group_input';
  readonly portLabels: string[];
}

export interface GroupOutputNodeData extends BaseNodeData {
  readonly type: 'group_output';
  readonly portLabels: string[];
}

export interface GroupNodeData extends BaseNodeData {
  readonly type: 'group';
  readonly innerNodes: Map<string, NodeData>;
  readonly innerConnections: Array<{
    readonly fromNode: string;
    readonly fromPort: number;
    readonly toNode: string;
    readonly toPort: number;
  }>;
  readonly inputNodeId: string;
  readonly outputNodeId: string;
}

export function createGroupNode(
  id: string,
  x: number,
  y: number,
): GroupNodeData {
  const inputNodeId = shortUuid();
  const outputNodeId = shortUuid();

  const innerNodes = new Map<string, NodeData>();
  innerNodes.set(inputNodeId, {
    type: 'group_input' as const,
    id: inputNodeId,
    x: 100,
    y: 100,
    portLabels: ['Input 1'],
  });
  innerNodes.set(outputNodeId, {
    type: 'group_output' as const,
    id: outputNodeId,
    x: 500,
    y: 100,
    portLabels: ['Output 1'],
  });

  return {
    type: 'group',
    id,
    x,
    y,
    innerNodes,
    innerConnections: [],
    inputNodeId,
    outputNodeId,
  };
}

export function renderGroupNode(
  node: GroupNodeData,
  onEnterGroup: () => void,
): m.Children {
  const innerNodeCount = node.innerNodes.size - 2; // Exclude pseudo-nodes
  return m('.pf-qb-stack', [
    m(
      'span',
      {style: {fontSize: '12px', opacity: '0.7'}},
      innerNodeCount === 0
        ? 'Empty group'
        : `${innerNodeCount} inner node${innerNodeCount !== 1 ? 's' : ''}`,
    ),
    m(Button, {
      variant: ButtonVariant.Filled,
      label: 'Edit Group',
      icon: 'open_in_new',
      onclick: (e: Event) => {
        e.stopPropagation();
        onEnterGroup();
      },
    }),
  ]);
}

export function renderGroupInputNode(
  node: GroupInputNodeData,
  onAddPort: () => void,
  onRemovePort: (index: number) => void,
): m.Children {
  return m('.pf-qb-stack', [
    ...node.portLabels.map((label, i) =>
      m(
        '.pf-qb-row',
        {style: {display: 'flex', alignItems: 'center', gap: '4px'}},
        [
          m('span', {style: {flex: '1', fontSize: '12px'}}, label),
          node.portLabels.length > 1 &&
            m(Button, {
              icon: 'close',
              compact: true,
              onclick: () => onRemovePort(i),
            }),
        ],
      ),
    ),
    m(Button, {
      label: 'Add Input',
      icon: 'add',
      compact: true,
      onclick: onAddPort,
    }),
  ]);
}

export function renderGroupOutputNode(
  node: GroupOutputNodeData,
  onAddPort: () => void,
  onRemovePort: (index: number) => void,
): m.Children {
  return m('.pf-qb-stack', [
    ...node.portLabels.map((label, i) =>
      m(
        '.pf-qb-row',
        {style: {display: 'flex', alignItems: 'center', gap: '4px'}},
        [
          m('span', {style: {flex: '1', fontSize: '12px'}}, label),
          node.portLabels.length > 1 &&
            m(Button, {
              icon: 'close',
              compact: true,
              onclick: () => onRemovePort(i),
            }),
        ],
      ),
    ),
    m(Button, {
      label: 'Add Output',
      icon: 'add',
      compact: true,
      onclick: onAddPort,
    }),
  ]);
}
