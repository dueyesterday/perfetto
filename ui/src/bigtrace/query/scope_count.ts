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
import {BigtraceQueryClient} from './bigtrace_query_client';
import {getBigtraceEndpoint} from '../settings/endpoint_storage';

class ScopeCountService {
  matched?: number; // traces matching the current filter
  total?: number; // traces available (filter ignored)
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
      // limit 1: we only want the count (totalFilteredRows), not the rows.
      const matched = await client.listTraceMetadata(
        settings,
        1,
        0,
        signal,
        undefined,
        filters,
      );
      const total =
        filters.length > 0
          ? await client.listTraceMetadata(settings, 1, 0, signal, undefined, [])
          : matched;
      if (key !== this.key) return; // a newer request superseded this one
      this.matched = matched.totalFilteredRows;
      this.total = total.totalFilteredRows;
      this.loading = false;
      this.error = false;
    } catch (e) {
      if (key !== this.key) return;
      this.loading = false;
      this.error = true;
    }
    m.redraw();
  }
}

export const scopeCount = new ScopeCountService();
