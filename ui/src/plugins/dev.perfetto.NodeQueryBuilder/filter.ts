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
import {Button, ButtonGroup, ButtonVariant} from '../../widgets/button';
import {Icon} from '../../widgets/icon';
import {Select} from '../../widgets/select';
import {TextInput} from '../../widgets/text_input';
import {ColumnPicker} from './column_picker';
import {ColumnDef} from './graph_utils';

export type FilterOp =
  | '='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'LIKE'
  | 'NOT LIKE'
  | 'GLOB'
  | 'IS NULL'
  | 'IS NOT NULL';

export const FILTER_OPS: FilterOp[] = [
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'LIKE',
  'NOT LIKE',
  'GLOB',
  'IS NULL',
  'IS NOT NULL',
];

const UNARY_OPS: Set<FilterOp> = new Set(['IS NULL', 'IS NOT NULL']);

export interface FilterCondition {
  readonly column: string;
  readonly op: FilterOp;
  readonly value: string;
}

export type FilterConjunction = 'AND' | 'OR';

export interface FilterNodeData extends BaseNodeData {
  readonly type: 'filter';
  // Legacy field kept for backwards compat with existing graphs.
  readonly filterExpression: string;
  readonly conditions: FilterCondition[];
  readonly conjunction?: FilterConjunction;
}

export function createFilterNode(
  id: string,
  x: number,
  y: number,
): FilterNodeData {
  return {
    type: 'filter',
    id,
    x,
    y,
    filterExpression: '',
    conditions: [],
    conjunction: 'AND',
  };
}

export function conditionsToSql(
  conditions: FilterCondition[],
  conjunction: FilterConjunction = 'AND',
): string {
  const parts = conditions
    .filter((c) => c.column)
    .map((c) => {
      if (UNARY_OPS.has(c.op)) {
        return `${c.column} ${c.op}`;
      }
      return `${c.column} ${c.op} ${c.value}`;
    });
  return parts.join(` ${conjunction} `);
}

export function renderFilterNode(
  node: FilterNodeData,
  updateNode: (updates: Partial<Omit<FilterNodeData, 'type' | 'id'>>) => void,
  availableColumns: ColumnDef[],
): m.Children {
  const conditions = node.conditions;

  const conjunction = node.conjunction ?? 'AND';

  return m('.pf-qb-stack', [
    m(
      ButtonGroup,
      {className: 'pf-qb-conjunction'},
      m(Button, {
        label: 'AND',
        onclick: () => updateNode({conjunction: 'AND'}),
        active: conjunction === 'AND',
      }),
      m(Button, {
        label: 'OR',
        onclick: () => updateNode({conjunction: 'OR'}),
        active: conjunction === 'OR',
      }),
    ),
    m('.pf-qb-filter-list', [
      ...conditions.map((cond, i) =>
        m(
          '.pf-qb-filter-row',
          {
            key: i,
            draggable: true,
            ondragstart: (e: DragEvent) => {
              e.dataTransfer!.effectAllowed = 'move';
              e.dataTransfer!.setData('text/plain', String(i));
              (e.currentTarget as HTMLElement).classList.add('pf-dragging');
            },
            ondragend: (e: DragEvent) => {
              (e.currentTarget as HTMLElement).classList.remove('pf-dragging');
            },
            ondragover: (e: DragEvent) => {
              e.preventDefault();
              e.dataTransfer!.dropEffect = 'move';
              (e.currentTarget as HTMLElement).classList.add('pf-drag-over');
            },
            ondragleave: (e: DragEvent) => {
              (e.currentTarget as HTMLElement).classList.remove('pf-drag-over');
            },
            ondrop: (e: DragEvent) => {
              e.preventDefault();
              (e.currentTarget as HTMLElement).classList.remove('pf-drag-over');
              const fromIdx = parseInt(e.dataTransfer!.getData('text/plain'));
              const toIdx = i;
              if (fromIdx !== toIdx) {
                const newConds = [...conditions];
                const [moved] = newConds.splice(fromIdx, 1);
                newConds.splice(toIdx, 0, moved);
                updateNode({conditions: newConds});
              }
            },
          },
          [
            m(Icon, {icon: 'drag_indicator', className: 'pf-qb-drag-handle'}),
            m(ColumnPicker, {
              value: cond.column,
              columns: availableColumns,
              placeholder: 'column',
              onSelect: (value: string) => {
                const newConds = [...conditions];
                newConds[i] = {...cond, column: value};
                updateNode({conditions: newConds});
              },
            }),
            m(
              Select,
              {
                value: cond.op,
                onchange: (e: Event) => {
                  const newConds = [...conditions];
                  newConds[i] = {
                    ...cond,
                    op: (e.target as HTMLSelectElement).value as FilterOp,
                  };
                  updateNode({conditions: newConds});
                },
              },
              FILTER_OPS.map((op) => m('option', {value: op}, op)),
            ),
            ...(!UNARY_OPS.has(cond.op)
              ? [
                  m(TextInput, {
                    placeholder: 'value',
                    value: cond.value,
                    onChange: (value: string) => {
                      const newConds = [...conditions];
                      newConds[i] = {...cond, value};
                      updateNode({conditions: newConds});
                    },
                  }),
                ]
              : []),
            m(Button, {
              icon: 'close',
              title: 'Remove condition',
              onclick: () => {
                const newConds = conditions.filter((_, j) => j !== i);
                updateNode({conditions: newConds});
              },
            }),
          ],
        ),
      ),
    ]),
    m(Button, {
      label: 'Add condition',
      icon: 'add',
      variant: ButtonVariant.Filled,
      onclick: () => {
        updateNode({
          conditions: [...conditions, {column: '', op: '=', value: ''}],
        });
      },
    }),
  ]);
}
