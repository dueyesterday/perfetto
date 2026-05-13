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

import {traceQueryColumnsState} from './trace_query_columns_state';

describe('traceQueryColumnsState — LocalStorage round-trip', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('returns [] when nothing is persisted', () => {
    // The "empty" sentinel here is [] (unlike traceColumnsState
    // which uses null for "fall back to schema defaults").
    // Reason: there is no schema default for query-result metadata
    // enrichment — the user explicitly opts in.
    expect(traceQueryColumnsState.get()).toEqual([]);
  });

  test('set then get round-trips the column list', () => {
    traceQueryColumnsState.set(['file_name', 'size_bytes']);
    expect(traceQueryColumnsState.get()).toEqual(['file_name', 'size_bytes']);
  });

  test('preserves user-given order', () => {
    // Order matters: the executor stitches metadata columns into
    // result rows in the order received, so the wire output
    // mirrors what the user picked.
    traceQueryColumnsState.set(['mtime', 'file_name', 'size_bytes']);
    expect(traceQueryColumnsState.get()).toEqual([
      'mtime',
      'file_name',
      'size_bytes',
    ]);
  });

  test('clear empties the persisted selection', () => {
    traceQueryColumnsState.set(['file_name']);
    traceQueryColumnsState.clear();
    expect(traceQueryColumnsState.get()).toEqual([]);
  });

  test('non-array stored value falls through to []', () => {
    // Older format / partial write / hand-edited LocalStorage —
    // shouldn't throw. Same defensive pattern as the other state
    // modules.
    localStorage.setItem(
      'bigtraceTraceQueryColumns',
      JSON.stringify({chosen: 'oops'}),
    );
    expect(traceQueryColumnsState.get()).toEqual([]);
  });

  test('non-string entries are filtered out', () => {
    // A hand-rolled LocalStorage write that sneaks non-strings in
    // shouldn't poison the column list. Only string entries
    // survive.
    localStorage.setItem(
      'bigtraceTraceQueryColumns',
      JSON.stringify({chosen: ['file_name', 42, null, 'size_bytes']}),
    );
    expect(traceQueryColumnsState.get()).toEqual(['file_name', 'size_bytes']);
  });

  test('malformed JSON in LocalStorage falls through to []', () => {
    localStorage.setItem('bigtraceTraceQueryColumns', 'not-json');
    expect(traceQueryColumnsState.get()).toEqual([]);
  });
});
