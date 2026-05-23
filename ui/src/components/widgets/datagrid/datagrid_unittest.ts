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

import {shiftEditingIndexOnRemove} from './datagrid';

describe('shiftEditingIndexOnRemove', () => {
  test('returns undefined when nothing is being edited', () => {
    expect(shiftEditingIndexOnRemove(undefined, 0)).toBeUndefined();
    expect(shiftEditingIndexOnRemove(undefined, 5)).toBeUndefined();
  });

  test('closes the popup when the edited filter is removed', () => {
    expect(shiftEditingIndexOnRemove(3, 3)).toBeUndefined();
  });

  test('shifts the index down when an EARLIER filter is removed', () => {
    // Editing filter at index 5, sibling at index 2 is removed.
    // What was at 5 now sits at 4 — popup should follow.
    expect(shiftEditingIndexOnRemove(5, 2)).toBe(4);
    expect(shiftEditingIndexOnRemove(1, 0)).toBe(0);
    expect(shiftEditingIndexOnRemove(10, 9)).toBe(9);
  });

  test('leaves the index unchanged when a LATER filter is removed', () => {
    // Editing filter at index 2, sibling at index 5 is removed.
    // Indices ≤ 2 are unaffected — popup stays put.
    expect(shiftEditingIndexOnRemove(2, 5)).toBe(2);
    expect(shiftEditingIndexOnRemove(0, 1)).toBe(0);
    expect(shiftEditingIndexOnRemove(0, 10)).toBe(0);
  });
});
