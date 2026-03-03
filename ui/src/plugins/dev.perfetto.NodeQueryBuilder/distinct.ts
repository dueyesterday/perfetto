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
import {BaseNodeData} from './node_types';
import {MultiSelectDiff, PopupMultiSelect} from '../../widgets/multiselect';
import {ButtonVariant} from '../../widgets/button';
import {ColumnDef} from './graph_utils';

export interface DistinctNodeData extends BaseNodeData {
  readonly type: 'distinct';
  // Which columns to apply DISTINCT on. Empty means DISTINCT on all columns.
  readonly distinctColumns: Record<string, boolean>;
}

export function createDistinctNode(
  id: string,
  x: number,
  y: number,
): DistinctNodeData {
  return {type: 'distinct', id, x, y, distinctColumns: {}};
}

export function renderDistinctNode(
  node: DistinctNodeData,
  updateNode: (updates: Partial<Omit<DistinctNodeData, 'type' | 'id'>>) => void,
  availableColumns: ColumnDef[],
): m.Children {
  if (availableColumns.length === 0) {
    return m('span.pf-qb-placeholder', 'Connect to a table source');
  }

  const mergedCols: Record<string, boolean> = {};
  for (const col of availableColumns) {
    mergedCols[col.name] =
      col.name in node.distinctColumns ? node.distinctColumns[col.name] : false;
  }

  const options = availableColumns.map((col) => ({
    id: col.name,
    name: col.name,
    checked: mergedCols[col.name],
  }));

  return m('.pf-qb-stack', [
    m(PopupMultiSelect, {
      label: 'Columns (optional)',
      showNumSelected: true,
      options,
      variant: ButtonVariant.Filled,
      onChange: (diffs: MultiSelectDiff[]) => {
        const updated = {...mergedCols};
        for (const diff of diffs) {
          updated[diff.id] = diff.checked;
        }
        updateNode({distinctColumns: updated});
      },
    }),
  ]);
}
