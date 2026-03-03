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

import m from 'mithril';
import {produce} from 'immer';
import {perfettoSqlTypeToString} from '../../trace_processor/perfetto_sql_type';
import {shortUuid} from '../../base/uuid';
import {Button, ButtonVariant} from '../../widgets/button';
import {MenuItem, PopupMenu} from '../../widgets/menu';
import {
  Connection,
  Node,
  NodeGraph,
  NodeGraphApi,
} from '../../widgets/nodegraph';
import {SplitPanel} from '../../widgets/split_panel';
import {Trace} from '../../public/trace';
import {EmptyState} from '../../widgets/empty_state';
import {SqlModules} from '../dev.perfetto.SqlModules/sql_modules';
import {DataGrid} from '../../components/widgets/datagrid/datagrid';
import {SchemaRegistry} from '../../components/widgets/datagrid/datagrid_schema';
import {Tabs} from '../../widgets/tabs';

import {NodeData, NodeQueryBuilderStore, NODE_CONFIGS} from './node_types';
import {createFromNode, renderFromNode} from './from';
import {createSelectNode, renderSelectNode} from './select';
import {createFilterNode, renderFilterNode} from './filter';
import {createSortNode, renderSortNode} from './sort';
import {createLimitNode, renderLimitNode} from './limit';
import {createJoinNode, renderJoinNode} from './join';
import {createExtendNode, renderExtendNode} from './extend';
import {createExtractArgNode, renderExtractArgNode} from './extract_arg';
import {createGroupByNode, renderGroupByNode} from './groupby';
import {createDistinctNode, renderDistinctNode} from './distinct';
import {
  createIntervalIntersectNode,
  renderIntervalIntersectNode,
} from './interval_intersect';
import {createSelectionNode, renderSelectionNode} from './selection';
import {createUnionAllNode, renderUnionAllNode} from './union_all';
import {
  createGroupNode,
  renderGroupNode,
  renderGroupInputNode,
  renderGroupOutputNode,
} from './group';
import type {GroupNodeData} from './group';
import {buildIR} from './ir';
import {
  findConnectedInputs,
  findDockedParent,
  getColumnsForNode,
  getOutputColumnsForNode,
  getRootNodeIds,
} from './graph_utils';
import {
  CacheEntry,
  MaterializationService,
  QueryReport,
} from './materialization';
import {Intent} from '../../widgets/common';

function formatQueryReport(report: QueryReport): string {
  const lines: string[] = [];
  const hits = report.entries.filter((e) => e.cacheHit).length;
  const misses = report.entries.length - hits;
  lines.push(
    `${report.entries.length} entries | ${hits} cache hits | ${misses} misses | ${report.totalTimeMs.toFixed(1)}ms total`,
  );
  lines.push('');
  for (const entry of report.entries) {
    const status = entry.cacheHit ? 'HIT ' : 'MISS';
    const time = entry.cacheHit
      ? '     '
      : `${entry.timeMs.toFixed(1).padStart(5)}ms`;
    lines.push(`${status}  ${time}  ${entry.hash}`);
    const sqlOneLine = entry.sql.replace(/\n/g, ' ').replace(/\s+/g, ' ');
    const truncated =
      sqlOneLine.length > 80 ? sqlOneLine.slice(0, 77) + '...' : sqlOneLine;
    lines.push(`                ${truncated}`);
  }
  return lines.join('\n');
}

function formatCacheInfo(entries: readonly CacheEntry[]): string {
  if (entries.length === 0) return 'Cache is empty';
  const lines: string[] = [];
  lines.push(`${entries.length} tables cached`);
  lines.push('');
  // Sort by most recently hit first.
  const sorted = [...entries].sort((a, b) => b.lastHitAt - a.lastHitAt);
  for (const entry of sorted) {
    const hits = entry.hitCount === 1 ? '1 hit' : `${entry.hitCount} hits`;
    lines.push(
      `${entry.hash}  ${hits}  ${entry.materializeTimeMs.toFixed(1)}ms`,
    );
    lines.push(
      `  created ${formatTimestamp(entry.createdAt)} | last hit ${formatTimestamp(entry.lastHitAt)}`,
    );
    const sqlOneLine = entry.sql.replace(/\n/g, ' ').replace(/\s+/g, ' ');
    const truncated =
      sqlOneLine.length > 72 ? sqlOneLine.slice(0, 69) + '...' : sqlOneLine;
    lines.push(`  ${truncated}`);
  }
  return lines.join('\n');
}

function formatTimestamp(perfNow: number): string {
  // Convert performance.now() to a wall-clock Date.
  const wallMs = Date.now() - (performance.now() - perfNow);
  const d = new Date(wallMs);
  return d.toLocaleTimeString();
}

export interface QueryBuilderPageAttrs {
  readonly trace: Trace;
  readonly sqlModules: SqlModules | undefined;
}

export function QueryBuilderPage(
  _initialVnode: m.Vnode<QueryBuilderPageAttrs>,
): m.Component<QueryBuilderPageAttrs> {
  let graphApi: NodeGraphApi | undefined;

  // Initialize store
  const initialId = shortUuid();
  let store: NodeQueryBuilderStore = {
    nodes: new Map([[initialId, createFromNode(initialId, 150, 100)]]),
    connections: [],
    labels: [],
  };

  // History management
  const history: NodeQueryBuilderStore[] = [store];
  let historyIndex = 0;

  // Selection state (separate from undo/redo history)
  const selectedNodeIds = new Set<string>();

  // Pinned node: when set, results panel always shows this node's query
  let pinnedNodeId: string | undefined;

  // Group navigation: when set, the UI shows the inner graph of this group.
  let activeGroupId: string | undefined;

  // Helpers to get the nodes/connections for the currently active view.
  function getActiveNodes(): Map<string, NodeData> {
    if (activeGroupId) {
      const group = store.nodes.get(activeGroupId);
      if (group?.type === 'group') return group.innerNodes;
    }
    return store.nodes;
  }

  function getActiveConnections(): Connection[] {
    if (activeGroupId) {
      const group = store.nodes.get(activeGroupId);
      if (group?.type === 'group') return group.innerConnections;
    }
    return store.connections;
  }

  function enterGroup(groupId: string) {
    activeGroupId = groupId;
    selectedNodeIds.clear();
    pinnedNodeId = undefined;
  }

  function exitGroup() {
    activeGroupId = undefined;
    selectedNodeIds.clear();
    pinnedNodeId = undefined;
  }

  function addGroupPort(pseudoNodeType: 'group_input' | 'group_output') {
    if (!activeGroupId) return;
    updateStore((draft) => {
      const group = draft.nodes.get(activeGroupId!);
      if (group?.type !== 'group') return;

      const nodeId =
        pseudoNodeType === 'group_input'
          ? group.inputNodeId
          : group.outputNodeId;
      const node = group.innerNodes.get(nodeId);
      if (
        !node ||
        (node.type !== 'group_input' && node.type !== 'group_output')
      )
        return;

      const prefix = pseudoNodeType === 'group_input' ? 'Input' : 'Output';
      const labels = [
        ...node.portLabels,
        `${prefix} ${node.portLabels.length + 1}`,
      ];
      Object.assign(node, {portLabels: labels});
    });
  }

  function removeGroupPort(
    pseudoNodeType: 'group_input' | 'group_output',
    portIndex: number,
  ) {
    if (!activeGroupId) return;
    updateStore((draft) => {
      const group = draft.nodes.get(activeGroupId!);
      if (group?.type !== 'group') return;

      const nodeId =
        pseudoNodeType === 'group_input'
          ? group.inputNodeId
          : group.outputNodeId;
      const node = group.innerNodes.get(nodeId);
      if (
        !node ||
        (node.type !== 'group_input' && node.type !== 'group_output')
      )
        return;
      if (node.portLabels.length <= 1) return;

      const labels = node.portLabels.filter((_, i) => i !== portIndex);
      Object.assign(node, {portLabels: labels});

      // Clean up inner connections referencing removed port.
      const isFromPort = pseudoNodeType === 'group_input';
      for (let i = group.innerConnections.length - 1; i >= 0; i--) {
        const conn = group.innerConnections[i];
        if (isFromPort && conn.fromNode === nodeId) {
          if (conn.fromPort === portIndex) {
            group.innerConnections.splice(i, 1);
          } else if (conn.fromPort > portIndex) {
            group.innerConnections[i] = {
              ...conn,
              fromPort: conn.fromPort - 1,
            };
          }
        } else if (!isFromPort && conn.toNode === nodeId) {
          if (conn.toPort === portIndex) {
            group.innerConnections.splice(i, 1);
          } else if (conn.toPort > portIndex) {
            group.innerConnections[i] = {
              ...conn,
              toPort: conn.toPort - 1,
            };
          }
        }
      }

      // Clean up external connections on the group node itself.
      if (isFromPort) {
        for (let i = draft.connections.length - 1; i >= 0; i--) {
          const conn = draft.connections[i];
          if (conn.toNode === activeGroupId) {
            if (conn.toPort === portIndex) {
              draft.connections.splice(i, 1);
            } else if (conn.toPort > portIndex) {
              draft.connections[i] = {...conn, toPort: conn.toPort - 1};
            }
          }
        }
      } else {
        for (let i = draft.connections.length - 1; i >= 0; i--) {
          const conn = draft.connections[i];
          if (conn.fromNode === activeGroupId) {
            if (conn.fromPort === portIndex) {
              draft.connections.splice(i, 1);
            } else if (conn.fromPort > portIndex) {
              draft.connections[i] = {...conn, fromPort: conn.fromPort - 1};
            }
          }
        }
      }
    });
  }

  let matService: MaterializationService | undefined;

  const STORAGE_KEY = 'perfetto.nodeQueryBuilder.savedGraph';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function serializeNode(node: NodeData): any {
    if (node.type === 'group') {
      return {
        ...node,
        innerNodes: Array.from(node.innerNodes.entries()).map(
          ([id, n]) => [id, serializeNode(n)] as const,
        ),
      };
    }
    return node;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function deserializeNode(raw: any): NodeData {
    if (raw.type === 'group') {
      return {
        ...raw,
        innerNodes: new Map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          raw.innerNodes.map(([id, n]: [string, any]) => [
            id,
            deserializeNode(n),
          ]),
        ),
      };
    }
    return raw;
  }

  function serializeStore(s: NodeQueryBuilderStore): string {
    return JSON.stringify({
      nodes: Array.from(s.nodes.entries()).map(
        ([id, node]) => [id, serializeNode(node)] as const,
      ),
      connections: s.connections,
      labels: s.labels,
    });
  }

  function deserializeStore(json: string): NodeQueryBuilderStore {
    const obj = JSON.parse(json);
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nodes: new Map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        obj.nodes.map(([id, raw]: [string, any]) => [id, deserializeNode(raw)]),
      ),
      connections: obj.connections ?? [],
      labels: obj.labels ?? [],
    };
  }

  function saveGraph() {
    try {
      localStorage.setItem(STORAGE_KEY, serializeStore(store));
      console.log('[QueryBuilder] Graph saved');
    } catch (e) {
      console.error('[QueryBuilder] Failed to save graph:', e);
    }
  }

  function loadGraph() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) {
        console.log('[QueryBuilder] No saved graph found');
        return;
      }
      store = deserializeStore(saved);
      history.splice(0, history.length, store);
      historyIndex = 0;
      selectedNodeIds.clear();
      pinnedNodeId = undefined;
      activeGroupId = undefined;
      console.log('[QueryBuilder] Graph loaded');
    } catch (e) {
      console.error('[QueryBuilder] Failed to load graph:', e);
    }
  }

  // Update store with history
  const updateStore = (updater: (draft: NodeQueryBuilderStore) => void) => {
    const newStore = produce(store, updater);
    store = newStore;

    if (historyIndex < history.length - 1) {
      history.splice(historyIndex + 1);
    }

    history.push(store);
    historyIndex = history.length - 1;

    if (history.length > 50) {
      history.shift();
      historyIndex--;
    }
  };

  const undo = () => {
    if (historyIndex > 0) {
      historyIndex--;
      store = history[historyIndex];
    }
  };

  const redo = () => {
    if (historyIndex < history.length - 1) {
      historyIndex++;
      store = history[historyIndex];
    }
  };

  const canUndo = () => historyIndex > 0;
  const canRedo = () => historyIndex < history.length - 1;

  const updateNode = (
    nodeId: string,
    updates: Partial<Omit<NodeData, 'id'>>,
  ) => {
    updateStore((draft) => {
      const nodes = activeGroupId
        ? (draft.nodes.get(activeGroupId) as GroupNodeData | undefined)
            ?.innerNodes
        : draft.nodes;
      if (!nodes) return;
      const node = nodes.get(nodeId);
      if (node) {
        Object.assign(node, updates);
      }
    });
  };

  const removeNode = (nodeId: string) => {
    updateStore((draft) => {
      const nodes = activeGroupId
        ? (draft.nodes.get(activeGroupId) as GroupNodeData | undefined)
            ?.innerNodes
        : draft.nodes;
      const connections = activeGroupId
        ? (draft.nodes.get(activeGroupId) as GroupNodeData | undefined)
            ?.innerConnections
        : draft.connections;
      if (!nodes || !connections) return;

      const nodeToDelete = nodes.get(nodeId);
      if (!nodeToDelete) return;

      // Don't allow deleting pseudo-nodes.
      if (
        nodeToDelete.type === 'group_input' ||
        nodeToDelete.type === 'group_output'
      )
        return;

      for (const parent of nodes.values()) {
        if (parent.nextId === nodeId) {
          parent.nextId = nodeToDelete.nextId;
        }
      }

      for (let i = connections.length - 1; i >= 0; i--) {
        const c = connections[i];
        if (c.fromNode === nodeId || c.toNode === nodeId) {
          connections.splice(i, 1);
        }
      }

      nodes.delete(nodeId);
    });

    selectedNodeIds.delete(nodeId);
    if (pinnedNodeId === nodeId) pinnedNodeId = undefined;
  };

  // --- Clipboard support ---

  interface ClipboardEntry {
    node: NodeData;
    relativeX: number;
    relativeY: number;
  }

  interface ClipboardConnection {
    fromIndex: number;
    toIndex: number;
    fromPort: number;
    toPort: number;
  }

  interface ClipboardDock {
    parentIndex: number;
    childIndex: number;
  }

  let clipboard:
    | {
        nodes: ClipboardEntry[];
        connections: ClipboardConnection[];
        docks: ClipboardDock[];
      }
    | undefined;

  function copySelectedNodes() {
    if (selectedNodeIds.size === 0) return;

    const activeNodes = getActiveNodes();
    const activeConns = getActiveConnections();

    const selected: NodeData[] = [];
    const idToIndex = new Map<string, number>();
    for (const id of selectedNodeIds) {
      const node = activeNodes.get(id);
      if (node && node.type !== 'group_input' && node.type !== 'group_output') {
        idToIndex.set(id, selected.length);
        selected.push(node);
      }
    }
    if (selected.length === 0) return;

    const minX = Math.min(...selected.map((n) => n.x));
    const minY = Math.min(...selected.map((n) => n.y));

    const clipNodes: ClipboardEntry[] = selected.map((n) => ({
      node: structuredClone(n),
      relativeX: n.x - minX,
      relativeY: n.y - minY,
    }));

    const clipConns: ClipboardConnection[] = [];
    for (const conn of activeConns) {
      const fi = idToIndex.get(conn.fromNode);
      const ti = idToIndex.get(conn.toNode);
      if (fi !== undefined && ti !== undefined) {
        clipConns.push({
          fromIndex: fi,
          toIndex: ti,
          fromPort: conn.fromPort,
          toPort: conn.toPort,
        });
      }
    }

    const clipDocks: ClipboardDock[] = [];
    for (const node of selected) {
      if (node.nextId && idToIndex.has(node.nextId)) {
        clipDocks.push({
          parentIndex: idToIndex.get(node.id)!,
          childIndex: idToIndex.get(node.nextId)!,
        });
      }
    }

    clipboard = {nodes: clipNodes, connections: clipConns, docks: clipDocks};
  }

  function pasteNodes() {
    if (!clipboard || clipboard.nodes.length === 0) return;

    const pasteOffset = 50;
    const newNodes: NodeData[] = clipboard.nodes.map((entry) => {
      const newId = shortUuid();
      return {
        ...structuredClone(entry.node),
        id: newId,
        x: entry.relativeX + pasteOffset,
        y: entry.relativeY + pasteOffset,
        nextId: undefined as string | undefined,
      };
    });

    for (const dock of clipboard.docks) {
      newNodes[dock.parentIndex].nextId = newNodes[dock.childIndex].id;
    }

    updateStore((draft) => {
      const nodes = activeGroupId
        ? (draft.nodes.get(activeGroupId) as GroupNodeData | undefined)
            ?.innerNodes
        : draft.nodes;
      const connections = activeGroupId
        ? (draft.nodes.get(activeGroupId) as GroupNodeData | undefined)
            ?.innerConnections
        : draft.connections;
      if (!nodes || !connections) return;

      for (const node of newNodes) {
        nodes.set(node.id, node);
      }
      for (const conn of clipboard!.connections) {
        connections.push({
          fromNode: newNodes[conn.fromIndex].id,
          fromPort: conn.fromPort,
          toNode: newNodes[conn.toIndex].id,
          toPort: conn.toPort,
        });
      }
    });

    selectedNodeIds.clear();
    for (const node of newNodes) {
      selectedNodeIds.add(node.id);
    }
  }

  function cutSelectedNodes() {
    copySelectedNodes();
    for (const id of [...selectedNodeIds]) {
      removeNode(id);
    }
  }

  const addNode = (
    factory: (id: string, x: number, y: number) => NodeData,
    toNodeId?: string,
  ) => {
    const id = shortUuid();

    let x: number;
    let y: number;

    if (graphApi && !toNodeId) {
      const tempNode = factory(id, 0, 0);
      const config = NODE_CONFIGS[tempNode.type];
      const placement = graphApi.findPlacementForNode({
        id,
        inputs: config.inputs,
        outputs: config.outputs,
        content: m('span', tempNode.type),
        canDockBottom: config.canDockBottom,
        canDockTop: config.canDockTop,
        titleBar: {title: config.title, icon: config.icon},
        hue: config.hue,
      });
      x = placement.x;
      y = placement.y;
    } else {
      x = 100 + Math.random() * 200;
      y = 50 + Math.random() * 200;
    }

    const newNode = factory(id, x, y);

    updateStore((draft) => {
      const nodes = activeGroupId
        ? (draft.nodes.get(activeGroupId) as GroupNodeData | undefined)
            ?.innerNodes
        : draft.nodes;
      const connections = activeGroupId
        ? (draft.nodes.get(activeGroupId) as GroupNodeData | undefined)
            ?.innerConnections
        : draft.connections;
      if (!nodes || !connections) return;

      nodes.set(newNode.id, newNode);

      if (toNodeId) {
        const parentNode = nodes.get(toNodeId);
        if (parentNode) {
          newNode.nextId = parentNode.nextId;
          parentNode.nextId = id;
        }

        const bottomConnectionIdx = connections.findIndex(
          (c) => c.fromNode === toNodeId && c.fromPort === 0,
        );
        if (bottomConnectionIdx > -1) {
          connections[bottomConnectionIdx] = {
            ...connections[bottomConnectionIdx],
            fromNode: id,
            fromPort: 0,
          };
        }
      }
    });
  };

  function renderTitleBarActions(nodeData: NodeData): m.Children {
    return [
      m(Button, {
        icon: 'push_pin',
        rounded: true,
        active: pinnedNodeId === nodeData.id,
        onclick: (e: Event) => {
          e.stopPropagation();
          pinnedNodeId = pinnedNodeId === nodeData.id ? undefined : nodeData.id;
        },
      }),
    ];
  }

  // Render node content with context (sqlModules, tableNames)
  function renderNodeContentWithContext(
    nodeData: NodeData,
    updateNodeFn: (updates: Partial<Omit<NodeData, 'id'>>) => void,
    tableNames: string[],
    sqlModules: SqlModules | undefined,
    trace: Trace,
  ): m.Children {
    const activeNodes = getActiveNodes();
    const activeConns = getActiveConnections();

    switch (nodeData.type) {
      case 'from':
        return renderFromNode(nodeData, updateNodeFn, tableNames);
      case 'select': {
        const cols = getColumnsForNode(
          activeNodes,
          activeConns,
          nodeData.id,
          sqlModules,
        );
        return renderSelectNode(nodeData, updateNodeFn, cols);
      }
      case 'filter': {
        const cols = getColumnsForNode(
          activeNodes,
          activeConns,
          nodeData.id,
          sqlModules,
        );
        return renderFilterNode(nodeData, updateNodeFn, cols);
      }
      case 'sort': {
        const cols = getColumnsForNode(
          activeNodes,
          activeConns,
          nodeData.id,
          sqlModules,
        );
        return renderSortNode(nodeData, updateNodeFn, cols);
      }
      case 'limit':
        return renderLimitNode(nodeData, updateNodeFn);
      case 'join': {
        const parent = findDockedParent(activeNodes, nodeData.id);
        const leftInput =
          parent ??
          findConnectedInputs(activeNodes, activeConns, nodeData.id).get(0);
        const leftCols = leftInput
          ? getOutputColumnsForNode(
              activeNodes,
              activeConns,
              leftInput.id,
              sqlModules,
            ) ?? []
          : [];
        const rightInput = findConnectedInputs(
          activeNodes,
          activeConns,
          nodeData.id,
        ).get(1);
        const rightCols = rightInput
          ? getOutputColumnsForNode(
              activeNodes,
              activeConns,
              rightInput.id,
              sqlModules,
            ) ?? []
          : [];
        return renderJoinNode(nodeData, updateNodeFn, {
          leftColumns: leftCols,
          rightColumns: rightCols,
        });
      }
      case 'extend': {
        const parent = findDockedParent(activeNodes, nodeData.id);
        const leftInput =
          parent ??
          findConnectedInputs(activeNodes, activeConns, nodeData.id).get(0);
        const leftCols = leftInput
          ? getOutputColumnsForNode(
              activeNodes,
              activeConns,
              leftInput.id,
              sqlModules,
            ) ?? []
          : [];
        const rightInput = findConnectedInputs(
          activeNodes,
          activeConns,
          nodeData.id,
        ).get(1);
        const rightCols = rightInput
          ? getOutputColumnsForNode(
              activeNodes,
              activeConns,
              rightInput.id,
              sqlModules,
            ) ?? []
          : [];
        return renderExtendNode(nodeData, updateNodeFn, {
          leftColumns: leftCols,
          rightColumns: rightCols,
        });
      }
      case 'extract_arg': {
        const cols = getColumnsForNode(
          activeNodes,
          activeConns,
          nodeData.id,
          sqlModules,
        );
        return renderExtractArgNode(nodeData, updateNodeFn, cols);
      }
      case 'groupby': {
        const cols = getColumnsForNode(
          activeNodes,
          activeConns,
          nodeData.id,
          sqlModules,
        );
        return renderGroupByNode(nodeData, updateNodeFn, cols);
      }
      case 'distinct': {
        const cols = getColumnsForNode(
          activeNodes,
          activeConns,
          nodeData.id,
          sqlModules,
        );
        return renderDistinctNode(nodeData, updateNodeFn, cols);
      }
      case 'selection':
        return renderSelectionNode(nodeData, updateNodeFn, trace);
      case 'union_all': {
        const uaParent = findDockedParent(activeNodes, nodeData.id);
        const uaLeftInput =
          uaParent ??
          findConnectedInputs(activeNodes, activeConns, nodeData.id).get(0);
        const uaRightInput = findConnectedInputs(
          activeNodes,
          activeConns,
          nodeData.id,
        ).get(1);
        return renderUnionAllNode(
          nodeData,
          updateNodeFn,
          uaLeftInput !== undefined && uaRightInput !== undefined,
        );
      }
      case 'interval_intersect': {
        const iiParent = findDockedParent(activeNodes, nodeData.id);
        const iiLeftInput =
          iiParent ??
          findConnectedInputs(activeNodes, activeConns, nodeData.id).get(0);
        const iiLeftCols = iiLeftInput
          ? getOutputColumnsForNode(
              activeNodes,
              activeConns,
              iiLeftInput.id,
              sqlModules,
            ) ?? []
          : [];
        const iiRightInput = findConnectedInputs(
          activeNodes,
          activeConns,
          nodeData.id,
        ).get(1);
        const iiRightCols = iiRightInput
          ? getOutputColumnsForNode(
              activeNodes,
              activeConns,
              iiRightInput.id,
              sqlModules,
            ) ?? []
          : [];
        const excluded = new Set(['id', 'ts', 'dur']);
        const rightNames = new Set(iiRightCols.map((c) => c.name));
        const commonCols = iiLeftCols
          .filter((c) => !excluded.has(c.name) && rightNames.has(c.name))
          .map((c) => c.name);
        const iiHasInputs =
          iiLeftInput !== undefined && iiRightInput !== undefined;
        return renderIntervalIntersectNode(
          nodeData,
          updateNodeFn,
          iiHasInputs,
          commonCols,
        );
      }
      case 'group':
        return renderGroupNode(nodeData, () => enterGroup(nodeData.id));
      case 'group_input':
        return renderGroupInputNode(
          nodeData,
          () => addGroupPort('group_input'),
          (index) => removeGroupPort('group_input', index),
        );
      case 'group_output':
        return renderGroupOutputNode(
          nodeData,
          () => addGroupPort('group_output'),
          (index) => removeGroupPort('group_output', index),
        );
    }
  }

  function buildNodeModel(
    nodeData: NodeData,
    tableNames: string[],
    trace: Trace,
    sqlModules: SqlModules | undefined,
  ): Omit<Node, 'x' | 'y'> {
    const activeNodes = getActiveNodes();
    const nextModel = nodeData.nextId
      ? activeNodes.get(nodeData.nextId)
      : undefined;

    const config = NODE_CONFIGS[nodeData.type];

    // Dynamic ports for group-related nodes.
    let inputs = config.inputs;
    let outputs = config.outputs;

    if (nodeData.type === 'group') {
      const inputPseudo = nodeData.innerNodes.get(nodeData.inputNodeId);
      const outputPseudo = nodeData.innerNodes.get(nodeData.outputNodeId);
      if (inputPseudo?.type === 'group_input') {
        inputs = inputPseudo.portLabels.map((label) => ({
          content: label,
          direction: 'left' as const,
        }));
      }
      if (outputPseudo?.type === 'group_output') {
        outputs = outputPseudo.portLabels.map((label) => ({
          content: label,
          direction: 'right' as const,
        }));
      }
    } else if (nodeData.type === 'group_input') {
      outputs = nodeData.portLabels.map((label) => ({
        content: label,
        direction: 'right' as const,
      }));
    } else if (nodeData.type === 'group_output') {
      inputs = nodeData.portLabels.map((label) => ({
        content: label,
        direction: 'left' as const,
      }));
    }

    const isPseudoNode =
      nodeData.type === 'group_input' || nodeData.type === 'group_output';

    return {
      id: nodeData.id,
      inputs,
      outputs,
      content: renderNodeContentWithContext(
        nodeData,
        (updates) => updateNode(nodeData.id, updates),
        tableNames,
        sqlModules,
        trace,
      ),
      canDockBottom: config.canDockBottom,
      canDockTop: config.canDockTop,
      next: nextModel
        ? buildNodeModel(nextModel, tableNames, trace, sqlModules)
        : undefined,
      titleBar: {
        title: config.title,
        icon: config.icon,
        actions: isPseudoNode ? undefined : renderTitleBarActions(nodeData),
      },
      hue: config.hue,
      contextMenuItems: isPseudoNode
        ? undefined
        : [
            m(MenuItem, {
              label: 'Delete',
              icon: 'delete',
              onclick: () => removeNode(nodeData.id),
            }),
          ],
    };
  }

  // Render a node and its docked chain
  function renderNodeChain(
    nodeData: NodeData,
    tableNames: string[],
    trace: Trace,
    sqlModules: SqlModules | undefined,
  ): Node {
    const model = buildNodeModel(nodeData, tableNames, trace, sqlModules);
    return {
      ...model,
      x: nodeData.x,
      y: nodeData.y,
    };
  }

  return {
    onremove() {
      matService?.dispose();
    },
    view({attrs}: m.Vnode<QueryBuilderPageAttrs>) {
      const {trace, sqlModules} = attrs;

      // Get table names from SqlModules, falling back to a basic list
      const tableNames = sqlModules
        ? sqlModules.listTablesNames().sort()
        : ['slice', 'sched', 'thread', 'process'];

      // Build the rendered nodes list from the active view.
      const activeNodes = getActiveNodes();
      const activeConns = getActiveConnections();

      const rootIds = getRootNodeIds(activeNodes);
      const renderedNodes: Node[] = rootIds
        .map((id) => activeNodes.get(id))
        .filter((n): n is NodeData => n !== undefined)
        .map((n) => renderNodeChain(n, tableNames, trace, sqlModules));

      const toolbarItems: m.Children[] = [];

      // Back button when inside a group.
      if (activeGroupId) {
        toolbarItems.push(
          m(Button, {
            variant: ButtonVariant.Filled,
            label: 'Back',
            icon: 'arrow_back',
            onclick: () => exitGroup(),
          }),
        );
      }

      const addNodeMenuItems = [
        m(MenuItem, {
          label: 'From',
          icon: 'table_chart',
          onclick: () => addNode(createFromNode),
        }),
        m(MenuItem, {
          label: 'Selection',
          icon: 'highlight_alt',
          onclick: () => addNode(createSelectionNode),
        }),
        m(MenuItem, {
          label: 'Select',
          icon: 'view_column',
          onclick: () => addNode(createSelectNode),
        }),
        m(MenuItem, {
          label: 'Filter',
          icon: 'filter_alt',
          onclick: () => addNode(createFilterNode),
        }),
        m(MenuItem, {
          label: 'Extract Arg',
          icon: 'data_object',
          onclick: () => addNode(createExtractArgNode),
        }),
        m(MenuItem, {
          label: 'Sort',
          icon: 'sort',
          onclick: () => addNode(createSortNode),
        }),
        m(MenuItem, {
          label: 'Limit',
          icon: 'horizontal_rule',
          onclick: () => addNode(createLimitNode),
        }),
        m(MenuItem, {
          label: 'Distinct',
          icon: 'fingerprint',
          onclick: () => addNode(createDistinctNode),
        }),
        m(MenuItem, {
          label: 'Group By',
          icon: 'workspaces',
          onclick: () => addNode(createGroupByNode),
        }),
        m(MenuItem, {
          label: 'Join',
          icon: 'join',
          onclick: () => addNode(createJoinNode),
        }),
        m(MenuItem, {
          label: 'Extend',
          icon: 'add_circle',
          onclick: () => addNode(createExtendNode),
        }),
        m(MenuItem, {
          label: 'Union',
          icon: 'merge',
          onclick: () => addNode(createUnionAllNode),
        }),
        m(MenuItem, {
          label: 'Interval Intersect',
          icon: 'compare_arrows',
          onclick: () => addNode(createIntervalIntersectNode),
        }),
      ];

      if (!activeGroupId) {
        addNodeMenuItems.push(
          m(MenuItem, {
            label: 'Group',
            icon: 'folder',
            onclick: () => addNode(createGroupNode),
          }),
        );
      }

      toolbarItems.push(
        m(
          PopupMenu,
          {
            trigger: m(Button, {
              variant: ButtonVariant.Filled,
              intent: Intent.Primary,
              label: 'Add Node',
              icon: 'add',
            }),
          },
          addNodeMenuItems,
        ),
      );

      toolbarItems.push(
        m('div', {style: {flex: '1'}}),
        m(Button, {
          variant: ButtonVariant.Filled,
          icon: 'save',
          onclick: saveGraph,
        }),
        m(Button, {
          variant: ButtonVariant.Filled,
          icon: 'folder_open',
          onclick: loadGraph,
        }),
        m(Button, {
          variant: ButtonVariant.Filled,
          icon: 'undo',
          disabled: !canUndo(),
          onclick: undo,
        }),
        m(Button, {
          variant: ButtonVariant.Filled,
          icon: 'redo',
          disabled: !canRedo(),
          onclick: redo,
        }),
      );

      const graphPanel = m(NodeGraph, {
        nodes: renderedNodes,
        connections: activeConns,
        labels: activeGroupId ? undefined : store.labels,
        selectedNodeIds,
        fillHeight: true,
        toolbarItems,
        onReady: (api: NodeGraphApi) => {
          graphApi = api;
        },
        onCopy: () => copySelectedNodes(),
        onPaste: () => pasteNodes(),
        onCut: () => cutSelectedNodes(),
        onConnect: (conn: Connection) => {
          updateStore((draft) => {
            if (activeGroupId) {
              const group = draft.nodes.get(activeGroupId) as
                | GroupNodeData
                | undefined;
              group?.innerConnections.push(conn);
            } else {
              draft.connections.push(conn);
            }
          });
        },
        onConnectionRemove: (index: number) => {
          updateStore((draft) => {
            if (activeGroupId) {
              const group = draft.nodes.get(activeGroupId) as
                | GroupNodeData
                | undefined;
              group?.innerConnections.splice(index, 1);
            } else {
              draft.connections.splice(index, 1);
            }
          });
        },
        onNodeMove: (nodeId: string, x: number, y: number) => {
          updateNode(nodeId, {x, y});
        },
        onNodeRemove: (nodeId: string) => {
          removeNode(nodeId);
        },
        onNodeSelect: (nodeId: string) => {
          selectedNodeIds.clear();
          selectedNodeIds.add(nodeId);
        },
        onNodeAddToSelection: (nodeId: string) => {
          selectedNodeIds.add(nodeId);
        },
        onNodeRemoveFromSelection: (nodeId: string) => {
          selectedNodeIds.delete(nodeId);
        },
        onSelectionClear: () => {
          selectedNodeIds.clear();
        },
        onDock: (targetId: string, childNode: Omit<Node, 'x' | 'y'>) => {
          updateStore((draft) => {
            const nodes = activeGroupId
              ? (draft.nodes.get(activeGroupId) as GroupNodeData | undefined)
                  ?.innerNodes
              : draft.nodes;
            const connections = activeGroupId
              ? (draft.nodes.get(activeGroupId) as GroupNodeData | undefined)
                  ?.innerConnections
              : draft.connections;
            if (!nodes || !connections) return;

            const target = nodes.get(targetId);
            const child = nodes.get(childNode.id);
            if (target && child) {
              target.nextId = child.id;
            }
            for (let i = connections.length - 1; i >= 0; i--) {
              const conn = connections[i];
              if (
                (conn.fromNode === targetId && conn.toNode === childNode.id) ||
                (conn.fromNode === childNode.id && conn.toNode === targetId)
              ) {
                connections.splice(i, 1);
              }
            }
          });
        },
        onUndock: (parentId: string, nodeId: string, x: number, y: number) => {
          updateStore((draft) => {
            const nodes = activeGroupId
              ? (draft.nodes.get(activeGroupId) as GroupNodeData | undefined)
                  ?.innerNodes
              : draft.nodes;
            if (!nodes) return;

            const parent = nodes.get(parentId);
            const child = nodes.get(nodeId);
            if (parent && child) {
              child.x = x;
              child.y = y;
              parent.nextId = undefined;
            }
          });
        },
        onLabelMove: activeGroupId
          ? undefined
          : (labelId: string, x: number, y: number) => {
              updateStore((draft) => {
                const label = draft.labels.find((l) => l.id === labelId);
                if (label) {
                  label.x = x;
                  label.y = y;
                }
              });
            },
        onLabelResize: activeGroupId
          ? undefined
          : (labelId: string, width: number) => {
              updateStore((draft) => {
                const label = draft.labels.find((l) => l.id === labelId);
                if (label) {
                  label.width = width;
                }
              });
            },
        onLabelRemove: activeGroupId
          ? undefined
          : (labelId: string) => {
              updateStore((draft) => {
                const idx = draft.labels.findIndex((l) => l.id === labelId);
                if (idx !== -1) {
                  draft.labels.splice(idx, 1);
                }
              });
              selectedNodeIds.delete(labelId);
            },
      });

      // Use pinned node if set, otherwise fall back to selected node.
      const activeNodeId =
        pinnedNodeId ??
        (selectedNodeIds.size === 1
          ? (selectedNodeIds.values().next().value as string)
          : undefined);

      // Lazily create the materialization service.
      if (!matService) {
        matService = new MaterializationService(trace.engine);
      }

      // Schedule materialization on every render — the AsyncLimiter
      // ensures only the latest invocation actually runs.
      const effectiveStore: NodeQueryBuilderStore = activeGroupId
        ? {
            nodes: activeNodes,
            connections: activeConns,
            labels: [],
          }
        : store;
      matService.scheduleUpdate(effectiveStore, activeNodeId, sqlModules);

      const displaySql = matService.displaySql;
      const dataSource = matService.dataSource;
      const matError = matService.error;
      const queryReport = matService.queryReport;
      const cacheEntries = matService.cacheEntries;

      // Build DataGrid schema from the node's output columns.
      const outputColumns = activeNodeId
        ? getOutputColumnsForNode(
            activeNodes,
            activeConns,
            activeNodeId,
            sqlModules,
          )
        : undefined;

      const sqlText = activeNodeId
        ? displaySql ?? 'Incomplete query — fill in all required fields'
        : 'Select a node to preview its SQL';

      // Build IR JSON for the IR tab.
      let irJson: string | undefined;
      if (activeNodeId) {
        const entries = buildIR(
          activeNodes,
          activeConns,
          activeNodeId,
          sqlModules,
        );
        if (entries && entries.length > 0) {
          irJson = JSON.stringify(entries, null, 2);
        }
      }

      function renderPreBlock(text: string, hasContent: boolean): m.Children {
        return m(
          'pre',
          {
            style: {
              margin: '0',
              padding: '8px',
              overflow: 'auto',
              flex: '1',
              fontFamily: 'monospace',
              fontSize: '12px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              opacity: hasContent ? '1' : '0.5',
            },
          },
          text,
        );
      }

      const sqlPanel = m(
        '',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            background: 'var(--surface)',
          },
        },
        m(Tabs, {
          tabs: [
            {
              key: 'sql',
              title: 'SQL',
              content: m(
                '',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    flex: '1',
                    overflow: 'hidden',
                  },
                },
                [
                  displaySql
                    ? m(
                        '',
                        {
                          style: {
                            display: 'flex',
                            justifyContent: 'flex-end',
                            padding: '4px 8px 0',
                            gap: '4px',
                          },
                        },
                        m(Button, {
                          variant: ButtonVariant.Filled,
                          icon: 'content_copy',
                          label: 'Copy',
                          compact: true,
                          onclick: () => {
                            navigator.clipboard.writeText(displaySql);
                          },
                        }),
                      )
                    : null,
                  renderPreBlock(sqlText, !!displaySql),
                ],
              ),
            },
            {
              key: 'columns',
              title: 'Columns',
              content: m(
                '',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    flex: '1',
                    overflow: 'hidden',
                  },
                },
                renderPreBlock(
                  outputColumns && outputColumns.length > 0
                    ? outputColumns
                        .map(
                          (c) =>
                            `${c.name}: ${perfettoSqlTypeToString(c.type)}`,
                        )
                        .join('\n')
                    : activeNodeId
                      ? 'No columns available'
                      : 'Select a node',
                  !!(outputColumns && outputColumns.length > 0),
                ),
              ),
            },
            {
              key: 'ir',
              title: 'IR',
              content: m(
                '',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    flex: '1',
                    overflow: 'hidden',
                  },
                },
                [
                  irJson
                    ? m(
                        '',
                        {
                          style: {
                            display: 'flex',
                            justifyContent: 'flex-end',
                            padding: '4px 8px 0',
                            gap: '4px',
                          },
                        },
                        m(Button, {
                          variant: ButtonVariant.Filled,
                          icon: 'content_copy',
                          label: 'Copy',
                          compact: true,
                          onclick: () => {
                            navigator.clipboard.writeText(irJson!);
                          },
                        }),
                      )
                    : null,
                  renderPreBlock(
                    irJson ??
                      (activeNodeId ? 'No IR available' : 'Select a node'),
                    !!irJson,
                  ),
                ],
              ),
            },
            {
              key: 'report',
              title: 'Report',
              content: m(
                '',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    flex: '1',
                    overflow: 'hidden',
                  },
                },
                queryReport
                  ? renderPreBlock(formatQueryReport(queryReport), true)
                  : renderPreBlock(
                      activeNodeId ? 'No report yet' : 'Select a node',
                      false,
                    ),
              ),
            },
            {
              key: 'cache',
              title: `Cache (${cacheEntries.length})`,
              content: m(
                '',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    flex: '1',
                    overflow: 'hidden',
                  },
                },
                [
                  cacheEntries.length > 0 &&
                    m(
                      '',
                      {
                        style: {
                          display: 'flex',
                          justifyContent: 'flex-end',
                          padding: '4px 8px 0',
                          gap: '4px',
                        },
                      },
                      m(Button, {
                        variant: ButtonVariant.Filled,
                        icon: 'delete_sweep',
                        label: 'Clear cache',
                        compact: true,
                        onclick: () => matService?.clearCache(),
                      }),
                    ),
                  renderPreBlock(
                    formatCacheInfo(cacheEntries),
                    cacheEntries.length > 0,
                  ),
                ],
              ),
            },
          ],
        }),
      );

      const datagridSchema: SchemaRegistry = {
        query: Object.fromEntries(
          (outputColumns ?? []).map((col) => [col.name, {}]),
        ),
      };

      const resultsPanel = dataSource
        ? m(DataGrid, {
            key: displaySql,
            data: dataSource,
            schema: datagridSchema,
            rootSchema: 'query',
            fillHeight: true,
          })
        : m(
            EmptyState,
            {
              fillHeight: true,
              title: matError
                ? 'Query error'
                : activeNodeId
                  ? 'Incomplete query'
                  : 'No node selected',
            },
            matError ??
              (activeNodeId
                ? 'Fill in all required fields to see results.'
                : 'Click on a node in the graph to see its query results.'),
          );

      const bottomPanel = m(SplitPanel, {
        direction: 'vertical',
        controlledPanel: 'first',
        initialSplit: {percent: 30},
        minSize: 50,
        firstPanel: sqlPanel,
        secondPanel: resultsPanel,
      });

      return m(
        '.pf-node-query-builder-page',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
          },
        },
        m(SplitPanel, {
          direction: 'horizontal',
          controlledPanel: 'second',
          initialSplit: {percent: 40},
          minSize: 100,
          firstPanel: graphPanel,
          secondPanel: bottomPanel,
        }),
      );
    },
  };
}
