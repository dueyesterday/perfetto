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

import {LocalStorage} from '../../core/local_storage';

// Persisted state for the trace-selection grid's sort.
//
// The grid lets the user sort `/traces` by clicking a column header
// (`file_name asc`, `size_bytes desc`, etc.). That sort matters
// functionally — under `trace_limit > 0`, the backend keeps the FIRST
// N traces in this order, so changing the sort changes which traces a
// query runs over. The state survives navigations / reloads / tabs so
// the user's choice doesn't get reset under them.
//
// Wire shape: an AIP-132 ordering string ("field [asc|desc][, …]"),
// shipped verbatim as the top-level `trace_order_by` field on
// `/execute_*`. Empty string means "let the backend pick its default"
// (the reference uses `file_path ASC` so the cap is deterministic).

const STORAGE_KEY = 'bigtraceTraceOrderBy';
const ORDER_BY_FIELD = 'orderBy';

class TraceOrderByState {
  private readonly storage = new LocalStorage(STORAGE_KEY);

  // Returns '' when nothing is persisted, when the stored value is
  // not a string (older format, partial write, hand-edited
  // LocalStorage), or when the key was cleared.
  get(): string {
    const raw = this.storage.load()[ORDER_BY_FIELD];
    return typeof raw === 'string' ? raw : '';
  }

  set(orderBy: string): void {
    this.storage.save({[ORDER_BY_FIELD]: orderBy});
  }

  clear(): void {
    this.set('');
  }
}

export const traceOrderByState = new TraceOrderByState();
