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
import {Select} from '../../widgets/select';
import {TextInput} from '../../widgets/text_input';
import {MultiSelectDiff, PopupMultiSelect} from '../../widgets/multiselect';
import {ButtonVariant} from '../../widgets/button';
import {ColumnPicker} from './column_picker';
import {ColumnDef} from './graph_utils';

export type JoinConditionType = 'ON' | 'USING';

export interface JoinColumnAlias {
  readonly side: 'left' | 'right';
  readonly column: string;
  readonly alias: string;
}

export interface JoinNodeData extends BaseNodeData {
  readonly type: 'join';
  readonly joinType: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL';
  readonly joinConditionType: JoinConditionType;
  readonly joinOn: string;
  readonly joinUsing: string;
  // Column selections from each side. Absent columns default to true.
  readonly leftColumns: Record<string, boolean>;
  readonly rightColumns: Record<string, boolean>;
  // Custom aliases for columns. Key: "left:col" or "right:col", value: alias.
  readonly columnAliases: Record<string, string>;
}

export function createJoinNode(id: string, x: number, y: number): JoinNodeData {
  return {
    type: 'join',
    id,
    x,
    y,
    joinType: 'LEFT',
    joinConditionType: 'USING',
    joinOn: '',
    joinUsing: '',
    leftColumns: {},
    rightColumns: {},
    columnAliases: {},
  };
}

// Build the SQL join clause (e.g. "ON a.id = b.id" or "USING (id)").
export function joinConditionToSql(node: JoinNodeData): string {
  if (node.joinConditionType === 'USING') {
    return `USING (${node.joinUsing})`;
  }
  return `ON ${node.joinOn}`;
}

// Get the selected columns from a side, given available columns.
// Absent columns default to true (selected).
export function getSelectedJoinColumns(
  selection: Record<string, boolean>,
  available: string[],
): string[] {
  return available.filter((col) => !(col in selection) || selection[col]);
}

// Compute the resolved aliases for all selected join columns.
// Columns that appear on both sides get prefixed with "left_" / "right_" by default.
// Custom aliases from node.columnAliases override the defaults.
export function getJoinColumnAliases(
  node: JoinNodeData,
  leftAvail: string[],
  rightAvail: string[],
): JoinColumnAlias[] {
  const leftSelected = getSelectedJoinColumns(node.leftColumns, leftAvail);
  const rightSelected = getSelectedJoinColumns(node.rightColumns, rightAvail);

  const leftSet = new Set(leftSelected);
  const rightSet = new Set(rightSelected);

  const result: JoinColumnAlias[] = [];
  for (const col of leftSelected) {
    const key = `left:${col}`;
    const defaultAlias = rightSet.has(col) ? `left_${col}` : col;
    result.push({
      side: 'left',
      column: col,
      alias: node.columnAliases[key] ?? defaultAlias,
    });
  }
  for (const col of rightSelected) {
    const key = `right:${col}`;
    const defaultAlias = leftSet.has(col) ? `right_${col}` : col;
    result.push({
      side: 'right',
      column: col,
      alias: node.columnAliases[key] ?? defaultAlias,
    });
  }
  return result;
}

export interface JoinNodeRenderAttrs {
  readonly leftColumns: ColumnDef[];
  readonly rightColumns: ColumnDef[];
}

export function renderJoinNode(
  node: JoinNodeData,
  updateNode: (updates: Partial<Omit<JoinNodeData, 'type' | 'id'>>) => void,
  attrs: JoinNodeRenderAttrs,
): m.Children {
  const {leftColumns, rightColumns} = attrs;

  function renderColumnMultiSelect(
    label: string,
    available: ColumnDef[],
    selection: Record<string, boolean>,
    field: 'leftColumns' | 'rightColumns',
  ): m.Children {
    if (available.length === 0) return null;

    const options = available.map((col) => ({
      id: col.name,
      name: col.name,
      checked: !(col.name in selection) || selection[col.name],
    }));

    return m(PopupMultiSelect, {
      label,
      showNumSelected: true,
      options,
      variant: ButtonVariant.Filled,
      onChange: (diffs: MultiSelectDiff[]) => {
        const merged: Record<string, boolean> = {};
        for (const col of available) {
          merged[col.name] = !(col.name in selection) || selection[col.name];
        }
        for (const diff of diffs) {
          merged[diff.id] = diff.checked;
        }
        updateNode({[field]: merged});
      },
    });
  }

  return m('.pf-qb-stack', [
    m(
      Select,
      {
        value: node.joinType,
        onchange: (e: Event) => {
          updateNode({
            joinType: (e.target as HTMLSelectElement)
              .value as JoinNodeData['joinType'],
          });
        },
      },
      [
        m('option', {value: 'INNER'}, 'INNER'),
        m('option', {value: 'LEFT'}, 'LEFT'),
        m('option', {value: 'RIGHT'}, 'RIGHT'),
        m('option', {value: 'FULL'}, 'FULL'),
      ],
    ),
    m(
      Select,
      {
        value: node.joinConditionType,
        onchange: (e: Event) => {
          updateNode({
            joinConditionType: (e.target as HTMLSelectElement)
              .value as JoinConditionType,
          });
        },
      },
      [
        m('option', {value: 'ON'}, 'ON'),
        m('option', {value: 'USING'}, 'USING'),
      ],
    ),
    node.joinConditionType === 'USING'
      ? (() => {
          const rightNames = new Set(rightColumns.map((c) => c.name));
          const sharedColumns = leftColumns.filter((c) =>
            rightNames.has(c.name),
          );
          return m(ColumnPicker, {
            value: node.joinUsing,
            columns: sharedColumns,
            placeholder: 'column',
            onSelect: (value: string) => {
              updateNode({joinUsing: value});
            },
          });
        })()
      : m(TextInput, {
          placeholder: 'e.g. l.id = r.id',
          value: node.joinOn,
          onChange: (value: string) => {
            updateNode({joinOn: value});
          },
        }),
    renderColumnMultiSelect(
      'Left columns',
      leftColumns,
      node.leftColumns,
      'leftColumns',
    ),
    renderColumnMultiSelect(
      'Right columns',
      rightColumns,
      node.rightColumns,
      'rightColumns',
    ),
    renderAliasEditor(
      node,
      updateNode,
      leftColumns.map((c) => c.name),
      rightColumns.map((c) => c.name),
    ),
  ]);
}

function renderAliasEditor(
  node: JoinNodeData,
  updateNode: (updates: Partial<Omit<JoinNodeData, 'type' | 'id'>>) => void,
  leftAvail: string[],
  rightAvail: string[],
): m.Children {
  const aliases = getJoinColumnAliases(node, leftAvail, rightAvail);
  if (aliases.length === 0) return null;

  return m('.pf-qb-stack', [
    m('span.pf-qb-section-label', 'Aliases'),
    m('.pf-qb-tight-list', [
      ...aliases.map((a) => {
        const key = `${a.side}:${a.column}`;
        const label = `${a.side === 'left' ? 'l' : 'r'}.${a.column}`;
        return m('.pf-qb-alias-row', [
          m('span.pf-qb-alias-label', {title: label}, label),
          m('span.pf-qb-alias-arrow', '\u2192'),
          m(TextInput, {
            value: a.alias,
            onChange: (value: string) => {
              const updated = {...node.columnAliases};
              if (value === '') {
                delete updated[key];
              } else {
                updated[key] = value;
              }
              updateNode({columnAliases: updated});
            },
          }),
        ]);
      }),
    ]),
  ]);
}
