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

import {queryResultColumnsState} from './query_result_columns_state';

describe('queryResultColumnsState — LocalStorage round-trip', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('null when nothing is persisted', () => {
    expect(queryResultColumnsState.get()).toBeNull();
  });

  test('set then get round-trips the list', () => {
    queryResultColumnsState.set(['trace_id', 'name']);
    expect(queryResultColumnsState.get()).toEqual(['trace_id', 'name']);
  });

  test('clear reverts to null', () => {
    queryResultColumnsState.set(['name']);
    queryResultColumnsState.clear();
    expect(queryResultColumnsState.get()).toBeNull();
  });

  test('non-array stored value is ignored', () => {
    localStorage.setItem(
      'bigtraceQueryResultColumns',
      JSON.stringify({chosen: 'oops'}),
    );
    expect(queryResultColumnsState.get()).toBeNull();
  });
});

describe('queryResultColumnsState.effective — show-all defaults', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('null persisted -> returns every available column', () => {
    // Default behavior: nothing chosen = show all. New users see
    // every column the backend offers, no hidden surprises.
    expect(
      queryResultColumnsState.effective(['trace_id', 'name', 'dur']),
    ).toEqual(['trace_id', 'name', 'dur']);
  });

  test('persisted selection intersects with availableColumns', () => {
    queryResultColumnsState.set(['name', 'dur']);
    expect(
      queryResultColumnsState.effective(['trace_id', 'name', 'dur']),
    ).toEqual(['name', 'dur']);
  });

  test('drops persisted entries not in availableColumns', () => {
    // Stale entry from a previous query's schema. Don't blow up;
    // silently skip.
    queryResultColumnsState.set(['name', 'gone_col', 'dur']);
    expect(
      queryResultColumnsState.effective(['trace_id', 'name', 'dur']),
    ).toEqual(['name', 'dur']);
  });

  test('every persisted entry stale -> fall back to show all', () => {
    // If the user picked columns that no longer exist (e.g.,
    // switched to a totally different query), don't leave the grid
    // empty — fall back to showing everything available.
    queryResultColumnsState.set(['old_col_1', 'old_col_2']);
    expect(
      queryResultColumnsState.effective(['trace_id', 'name', 'dur']),
    ).toEqual(['trace_id', 'name', 'dur']);
  });

  test('preserves the order the user picked, not availableColumns order', () => {
    queryResultColumnsState.set(['dur', 'name']);
    expect(
      queryResultColumnsState.effective(['trace_id', 'name', 'dur']),
    ).toEqual(['dur', 'name']);
  });
});
