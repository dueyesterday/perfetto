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

import {isoToEpochMs, parseSnapshotTraceFilter} from './query_history_storage';

describe('parseSnapshotTraceFilter', () => {
  test('parses a JSON-encoded Filter[] string into the in-app shape', () => {
    const wire = '[{"field":"file_name","op":"=","value":"a.pftrace"}]';
    expect(parseSnapshotTraceFilter(wire)).toEqual([
      {field: 'file_name', op: '=', value: 'a.pftrace'},
    ]);
  });

  test('returns [] for empty wire string', () => {
    expect(parseSnapshotTraceFilter('')).toEqual([]);
  });

  test('returns [] for undefined input', () => {
    expect(parseSnapshotTraceFilter(undefined)).toEqual([]);
  });

  test('returns [] for malformed JSON instead of throwing', () => {
    expect(parseSnapshotTraceFilter('not-json')).toEqual([]);
  });

  test('returns [] when JSON parses but is not an array', () => {
    expect(parseSnapshotTraceFilter('{"field":"x"}')).toEqual([]);
    expect(parseSnapshotTraceFilter('null')).toEqual([]);
  });
});

describe('isoToEpochMs', () => {
  test('parses a valid ISO-8601 timestamp', () => {
    const ms = isoToEpochMs('2026-01-02T03:04:05.000Z');
    expect(ms).toBe(Date.UTC(2026, 0, 2, 3, 4, 5));
  });

  test('returns undefined for undefined input', () => {
    expect(isoToEpochMs(undefined)).toBeUndefined();
  });

  test('returns undefined for an unparseable string', () => {
    expect(isoToEpochMs('not-a-date')).toBeUndefined();
  });

  test('returns undefined for a digit-only string (regression)', () => {
    // Regression: digit strings must not silently parse (Date(digits) → NaN).
    expect(isoToEpochMs('1730000000000')).toBeUndefined();
  });

  test('returns undefined for an empty string', () => {
    expect(isoToEpochMs('')).toBeUndefined();
  });
});
