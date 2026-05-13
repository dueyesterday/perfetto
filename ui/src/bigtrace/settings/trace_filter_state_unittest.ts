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

import {traceFilterState} from './trace_filter_state';

describe('traceFilterState — LocalStorage round-trip', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('returns [] when nothing is stored', () => {
    expect(traceFilterState.get()).toEqual([]);
  });

  test('returns [] when a non-array sneaks into storage (older format etc.)', () => {
    localStorage.setItem(
      'bigtraceTraceFilter',
      JSON.stringify({filters: 'oops'}),
    );
    expect(traceFilterState.get()).toEqual([]);
  });

  test('returns [] when the stored JSON is malformed', () => {
    localStorage.setItem('bigtraceTraceFilter', 'not-json');
    expect(traceFilterState.get()).toEqual([]);
  });

  test('set then get round-trips the Filter[]', () => {
    const filters = [
      {field: 'file_name', op: 'glob', value: 'a*'},
      {field: 'size_bytes', op: '>', value: '1024'},
    ] as const;
    traceFilterState.set(filters);
    expect(traceFilterState.get()).toEqual(filters);
  });

  test('clear empties the persisted filter', () => {
    traceFilterState.set([{field: 'file_name', op: '=', value: 'a.pftrace'}]);
    traceFilterState.clear();
    expect(traceFilterState.get()).toEqual([]);
  });
});
