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

import {traceColumnsState} from './trace_columns_state';

const SCHEMA = [
  {name: 'file_path', default: true},
  {name: 'file_name', default: true},
  {name: 'size_bytes', default: true},
  {name: 'mtime', default: false}, // non-default to exercise that branch
];

describe('traceColumnsState — LocalStorage round-trip', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('returns null when nothing is stored', () => {
    expect(traceColumnsState.get()).toBeNull();
  });

  test('returns null when the stored field is non-array (older format)', () => {
    localStorage.setItem(
      'bigtraceTraceColumns',
      JSON.stringify({chosen: 'oops'}),
    );
    expect(traceColumnsState.get()).toBeNull();
  });

  test('returns null when the stored array is empty (degenerate)', () => {
    localStorage.setItem('bigtraceTraceColumns', JSON.stringify({chosen: []}));
    // Empty selection is treated as "no selection" so the UI falls
    // back to defaults — see the comment in traceColumnsState.get().
    expect(traceColumnsState.get()).toBeNull();
  });

  test('set then get round-trips the column list', () => {
    traceColumnsState.set(['file_name', 'size_bytes']);
    expect(traceColumnsState.get()).toEqual(['file_name', 'size_bytes']);
  });

  test('clear reverts to "use defaults"', () => {
    traceColumnsState.set(['file_name']);
    traceColumnsState.clear();
    expect(traceColumnsState.get()).toBeNull();
  });
});

describe('traceColumnsState.effective — schema reconciliation', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('returns default-flagged columns when nothing is persisted', () => {
    expect(traceColumnsState.effective(SCHEMA)).toEqual([
      'file_path',
      'file_name',
      'size_bytes',
    ]);
  });

  test('returns persisted selection when set (including non-default cols)', () => {
    traceColumnsState.set(['mtime', 'file_name']);
    expect(traceColumnsState.effective(SCHEMA)).toEqual(['mtime', 'file_name']);
  });

  test('drops persisted columns the schema no longer declares', () => {
    // A backend update removed a column; the stale localStorage
    // entry shouldn't blow up the grid — just silently skip it.
    traceColumnsState.set(['file_name', 'gone_column', 'size_bytes']);
    expect(traceColumnsState.effective(SCHEMA)).toEqual([
      'file_name',
      'size_bytes',
    ]);
  });

  test('preserves the order the user picked, not the schema order', () => {
    // The DataGrid renders columns in this order; if it didn't
    // preserve user choice, the column-picker UI would have to
    // include a "drag to reorder" affordance.
    traceColumnsState.set(['size_bytes', 'file_path']);
    expect(traceColumnsState.effective(SCHEMA)).toEqual([
      'size_bytes',
      'file_path',
    ]);
  });
});
