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

import {beforeEach, describe, expect, test} from 'vitest';
import {traceFilterState} from './trace_filter_state';
import {traceColumnsState} from './trace_columns_state';
import {traceOrderByState} from './trace_order_by_state';
import {traceQueryColumnsState} from './trace_query_columns_state';
import type {Filter} from '../../components/widgets/datagrid/model';

beforeEach(() => {
  localStorage.clear();
});

describe('traceFilterState', () => {
  test('defaults to an empty list', () => {
    expect(traceFilterState.get()).toEqual([]);
  });

  test('round-trips a set of chips', () => {
    const filters: Filter[] = [
      {field: 'file_name', op: 'glob', value: '*.pftrace'},
      {field: 'size_bytes', op: '>', value: '100'},
    ];
    traceFilterState.set(filters);
    expect(traceFilterState.get()).toEqual(filters);
  });

  test('clear() empties the list', () => {
    traceFilterState.set([{field: 'a', op: '=', value: '1'}]);
    traceFilterState.clear();
    expect(traceFilterState.get()).toEqual([]);
  });

  test('a malformed stored value reads back as empty', () => {
    localStorage.setItem('bigtraceTraceFilters', '{"filters":"not-an-array"}');
    expect(traceFilterState.get()).toEqual([]);
  });
});

describe('traceColumnsState', () => {
  const schema = [
    {name: 'file_name', defaultVisible: true},
    {name: 'size_bytes', defaultVisible: true},
    {name: 'device_name', defaultVisible: false},
  ];

  test('defaults to null (use schema defaults)', () => {
    expect(traceColumnsState.get()).toBeNull();
  });

  test('round-trips an explicit selection', () => {
    traceColumnsState.set(['file_name', 'device_name']);
    expect(traceColumnsState.get()).toEqual(['file_name', 'device_name']);
  });

  test('an empty selection collapses to the null default', () => {
    traceColumnsState.set([]);
    expect(traceColumnsState.get()).toBeNull();
  });

  test('clear() reverts to the null default', () => {
    traceColumnsState.set(['file_name']);
    traceColumnsState.clear();
    expect(traceColumnsState.get()).toBeNull();
  });

  test('effective() returns the defaultVisible columns when unset', () => {
    expect(traceColumnsState.effective(schema)).toEqual([
      'file_name',
      'size_bytes',
    ]);
  });

  test('effective() intersects an explicit selection with the live schema', () => {
    // 'gone' is stale (not in schema) and drops; order follows the selection.
    traceColumnsState.set(['device_name', 'gone', 'file_name']);
    expect(traceColumnsState.effective(schema)).toEqual([
      'device_name',
      'file_name',
    ]);
  });
});

describe('traceOrderByState', () => {
  test('defaults to the empty string', () => {
    expect(traceOrderByState.get()).toBe('');
  });

  test('round-trips an AIP-132 ordering string', () => {
    traceOrderByState.set('size_bytes desc');
    expect(traceOrderByState.get()).toBe('size_bytes desc');
  });

  test('clear() resets to the empty string', () => {
    traceOrderByState.set('file_name asc');
    traceOrderByState.clear();
    expect(traceOrderByState.get()).toBe('');
  });

  test('a non-string stored value reads back as empty', () => {
    localStorage.setItem('bigtraceTraceOrderBy', '{"orderBy":42}');
    expect(traceOrderByState.get()).toBe('');
  });
});

describe('traceQueryColumnsState', () => {
  test('defaults to an empty list (attach nothing)', () => {
    expect(traceQueryColumnsState.get()).toEqual([]);
  });

  test('round-trips a selection', () => {
    traceQueryColumnsState.set(['device_name', 'android_id']);
    expect(traceQueryColumnsState.get()).toEqual(['device_name', 'android_id']);
  });

  test('drops non-string entries from a malformed write', () => {
    localStorage.setItem(
      'bigtraceTraceQueryColumns',
      '{"chosen":["device_name",7,null,"android_id"]}',
    );
    expect(traceQueryColumnsState.get()).toEqual(['device_name', 'android_id']);
  });

  test('clear() empties the list', () => {
    traceQueryColumnsState.set(['device_name']);
    traceQueryColumnsState.clear();
    expect(traceQueryColumnsState.get()).toEqual([]);
  });
});
