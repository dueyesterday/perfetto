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

// Live scope counter. Turns "implicit selection via a regex filter" into
// tangible feedback: as the user edits the trace filter/settings, this fetches
// how many traces actually match (and the unfiltered total) so the Scope panel
// and the run contract can say "running over 1,284 of 5,000 traces" — live,
// before any query runs.

import m from 'mithril';
import type {Filter} from '../../components/widgets/datagrid/model';
import type {SettingFilter} from '../settings/settings_types';
import {BigtraceQueryClient, QueryCancelledError} from './bigtrace_query_client';
import {getBigtraceEndpoint} from '../settings/endpoint_storage';

// How many matching traces to pull back as a preview for the Trace selection
// node (also yields the count from the same request).
const SAMPLE_N = 60;

class ScopeCountService {
  matched?: number; // traces matching the current filter
  total?: number; // traces available (filter ignored)
  // A preview of the matching traces (first SAMPLE_N rows) + their columns, so
  // the Trace selection node can list what's in scope, not just a count.
  sample?: ReadonlyArray<Record<string, unknown>>;
  sampleColumns?: ReadonlyArray<string>;
  loading = false;
  error = false;

  private key = '';
  private timer?: number;
  private ac?: AbortController;

  // Call from a view with the active tab's effective settings + trace filters.
  // No-op when nothing relevant changed, so it's cheap to call every render.
  request(settings: ReadonlyArray<SettingFilter>, filters: ReadonlyArray<Filter>) {
    const key = JSON.stringify({s: settings, f: filters});
    if (key === this.key) return;
    this.key = key;
    this.loading = true;
    this.error = false;
    // Drop the previous (settings, filters) results so the new scope doesn't
    // render the prior tab's count/sample during the debounce + fetch.
    this.matched = undefined;
    this.total = undefined;
    this.sample = undefined;
    this.sampleColumns = undefined;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(
      () => void this.fetch(settings, filters, key),
      250,
    );
  }

  private async fetch(
    settings: ReadonlyArray<SettingFilter>,
    filters: ReadonlyArray<Filter>,
    key: string,
  ): Promise<void> {
    this.ac?.abort();
    this.ac = new AbortController();
    const signal = this.ac.signal;
    const client = new BigtraceQueryClient(getBigtraceEndpoint());
    try {
      // Pull a small preview page: gives us the count (totalFilteredRows) and
      // a sample of the matching traces in one request.
      const matched = await client.listTraceMetadata(
        settings,
        SAMPLE_N,
        0,
        signal,
        undefined,
        filters,
      );
      // Don't fire the second (unfiltered total) request if we've already been
      // superseded or aborted.
      if (signal.aborted || key !== this.key) return;
      const total =
        filters.length > 0
          ? await client.listTraceMetadata(settings, 1, 0, signal, undefined, [])
          : matched;
      if (key !== this.key) return; // a newer request superseded this one
      // totalFilteredRows is optional on the wire — fall back to the sample
      // size so a backend that omits it doesn't spin forever.
      this.matched = matched.totalFilteredRows ?? matched.rows.length;
      this.total = total.totalFilteredRows ?? total.rows.length;
      this.sample = matched.rows;
      this.sampleColumns = matched.columns;
      this.loading = false;
      this.error = false;
    } catch (e) {
      // A superseding request aborted this one — not an error.
      if (e instanceof QueryCancelledError || key !== this.key) return;
      this.loading = false;
      this.error = true;
    }
    m.redraw();
  }
}

export const scopeCount = new ScopeCountService();
