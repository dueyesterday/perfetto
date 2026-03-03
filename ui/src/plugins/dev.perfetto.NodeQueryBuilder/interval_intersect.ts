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
import {Checkbox} from '../../widgets/checkbox';
import {BaseNodeData} from './node_types';
import {MultiSelectDiff, PopupMultiSelect} from '../../widgets/multiselect';
import {ButtonVariant} from '../../widgets/button';

export interface IntervalIntersectNodeData extends BaseNodeData {
  readonly type: 'interval_intersect';
  // Columns to partition by during interval intersection.
  readonly partitionColumns: Record<string, boolean>;
  // Filter out rows with dur < 0.
  readonly filterNegativeDur: boolean;
}

export function createIntervalIntersectNode(
  id: string,
  x: number,
  y: number,
): IntervalIntersectNodeData {
  return {
    type: 'interval_intersect',
    id,
    x,
    y,
    partitionColumns: {},
    filterNegativeDur: true,
  };
}

export function renderIntervalIntersectNode(
  node: IntervalIntersectNodeData,
  updateNode: (
    updates: Partial<Omit<IntervalIntersectNodeData, 'type' | 'id'>>,
  ) => void,
  hasInputs: boolean,
  commonColumns: string[],
): m.Children {
  if (!hasInputs) {
    return m('span.pf-qb-placeholder', 'Connect two interval sources');
  }

  const durCheckbox = m(Checkbox, {
    label: 'Filter dur >= 0',
    checked: node.filterNegativeDur,
    onchange: () => updateNode({filterNegativeDur: !node.filterNegativeDur}),
  });

  const mergedCols: Record<string, boolean> = {};
  for (const col of commonColumns) {
    mergedCols[col] =
      col in node.partitionColumns ? node.partitionColumns[col] : false;
  }

  const options = commonColumns.map((col) => ({
    id: col,
    name: col,
    checked: mergedCols[col],
  }));

  const partitionPicker =
    commonColumns.length > 0
      ? m(PopupMultiSelect, {
          label: 'Partition columns',
          showNumSelected: true,
          options,
          variant: ButtonVariant.Filled,
          onChange: (diffs: MultiSelectDiff[]) => {
            const updated = {...mergedCols};
            for (const diff of diffs) {
              updated[diff.id] = diff.checked;
            }
            updateNode({partitionColumns: updated});
          },
        })
      : m(
          'span',
          {style: {opacity: '0.5', fontSize: '12px'}},
          'No shared columns to partition by',
        );

  return m('.pf-qb-stack', [durCheckbox, partitionPicker]);
}
