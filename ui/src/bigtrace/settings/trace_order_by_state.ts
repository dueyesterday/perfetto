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

import {SingleFieldStorage} from './single_field_storage';

// Persisted processing order for the trace set a query runs over.
//
// Wire shape: an AIP-132 ordering string ("field [asc|desc][, …]"), shipped
// verbatim as the top-level `trace_order_by` field on /execute_*. It matters
// functionally under a trace cap — the backend keeps the FIRST N traces in
// this order — so it's persisted across navigations / reloads / tabs.
//
// `get()` returns '' for nothing-stored / a non-string value / a cleared key,
// meaning "let the backend pick its default".
export const traceOrderByState = new SingleFieldStorage<string>(
  'bigtraceTraceOrderBy',
  'orderBy',
  (raw) => (typeof raw === 'string' ? raw : ''),
  '',
);
