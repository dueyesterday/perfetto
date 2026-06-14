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

// Saved, named trace cohorts: a reusable (filter + order) over the fleet. Fleet
// work is many queries over the same curated subset of traces, so make that
// subset a durable, first-class object the user can name, re-apply and delete.

import type {Filter} from '../../components/widgets/datagrid/model';
import {SingleFieldStorage} from './single_field_storage';

export interface TraceSet {
  readonly id: string;
  readonly name: string;
  readonly filters: ReadonlyArray<Filter>;
  readonly orderBy: string;
  readonly createdMs: number;
}

function isTraceSet(s: unknown): s is TraceSet {
  if (s === null || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    Array.isArray(o.filters)
  );
}

function parse(raw: unknown): readonly TraceSet[] {
  return Array.isArray(raw) ? raw.filter(isTraceSet) : [];
}

const storage = new SingleFieldStorage<readonly TraceSet[]>(
  'bigtraceTraceSets',
  'sets',
  parse,
  [],
);

export const traceSetStore = {
  list(): readonly TraceSet[] {
    return storage.get();
  },
  // Saving with an existing name replaces it (newest first).
  add(set: TraceSet): void {
    storage.set([set, ...storage.get().filter((s) => s.name !== set.name)]);
  },
  remove(id: string): void {
    storage.set(storage.get().filter((s) => s.id !== id));
  },
};
