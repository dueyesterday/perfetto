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

import type {Filter} from '../../components/widgets/datagrid/model';
import {endpointStorage} from '../settings/endpoint_storage';
import type {SettingFilter} from '../settings/settings_types';
import {BigtraceQueryClient} from './bigtrace_query_client';
import type {QueryExecution} from './query_store';

// Wire shape from /query_executions[*]; field list in CLAUDE.md.
// Times are ISO-8601; `readonly` marks the wire boundary.
//
// Field availability varies by endpoint:
// - `:status` returns only `status` / `processedRows` /
//   `processedTraces` / `totalTraces` (every other field is
//   absent — the client must tolerate missing keys on the polling
//   response).
// - `/query_executions/{uuid}` (full GET) returns the full shape
//   including the submit-time snapshot
//   (`settings` / `traceFilters` / `traceMetadataColumns`).
// - `/query_executions` (list) returns everything except the
//   snapshot — the history sidebar stays lean.
export interface RawQueryExecution {
  readonly queryUuid?: string;
  readonly status?: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly processedRows?: number;
  readonly processedTraces?: number;
  readonly totalTraces?: number;
  readonly error?: string;
  readonly errorMessage?: string;
  readonly perfettoSql?: string;
  readonly limit?: number;
  readonly materialized?: boolean;
  readonly tableName?: string;
  readonly tableLink?: string;
  // Submit-time snapshot — only on the full per-UUID GET. Empty
  // values when the row predates the feature (or the client didn't
  // opt in). `null` never appears on the wire.
  //
  // `traceFilters` is the native `Filter[]` array the client shipped
  // (strict-native body contract; only the `:fetch_results?filter=`
  // URL form still ships a JSON-encoded string). `traceOrderBy` is
  // the AIP-132 wire string controlling trace fan-out order — same
  // grammar as `/trace_metadata?order_by=`. Empty string means the backend
  // used its default.
  readonly settings?: ReadonlyArray<SnapshotSettingEntry>;
  readonly traceFilters?: ReadonlyArray<Filter>;
  readonly traceMetadataColumns?: ReadonlyArray<string>;
  readonly traceOrderBy?: string;
}

// Wire entry inside `RawQueryExecution.settings`. Same shape as
// `SettingFilter` but with the backend's `setting_id` field-name
// convention. Caller code converts via `snapshotSettingsToFilters`.
export interface SnapshotSettingEntry {
  readonly setting_id: string;
  readonly values: ReadonlyArray<string | number | boolean | null>;
  readonly category: string;
}

// Convert a wire snapshot's `settings` to the in-app `SettingFilter`
// shape (camelCase keys). Stripping unknown / malformed entries is
// silent — snapshot rehydration is advisory; broken entries shouldn't
// derail the Settings sub-tab.
export function snapshotSettingsToFilters(
  raw: ReadonlyArray<SnapshotSettingEntry> | undefined,
): SettingFilter[] {
  if (!raw) return [];
  const out: SettingFilter[] = [];
  for (const s of raw) {
    if (
      typeof s?.setting_id !== 'string' ||
      !Array.isArray(s.values) ||
      typeof s?.category !== 'string'
    ) {
      continue;
    }
    out.push({
      settingId: s.setting_id,
      // SettingFilter.values is `string[]`. The backend stores
      // exactly what the client sent (numbers / booleans / strings)
      // because the wire is permissive; on rehydrate we coerce
      // back to strings so the bigTraceSettingsStorage layer sees
      // the same shape it serialized.
      values: s.values.map((v) => (v === null ? '' : String(v))),
      // Narrow to SettingCategory by trust — the backend echoes
      // back what the client sent. Unknown categories pass through
      // and the settings UI falls back to a default rendering.
      category: s.category as SettingFilter['category'],
    });
  }
  return out;
}

// ISO-8601 → epoch ms; invalid/missing → undefined (never NaN).
export function isoToEpochMs(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

export class QueryHistoryStorage {
  // Fresh client per call so endpoint changes apply without restart.
  private client(): BigtraceQueryClient {
    const setting = endpointStorage.get('bigtraceEndpoint');
    const endpoint = setting ? (setting.get() as string) : '';
    return new BigtraceQueryClient(endpoint);
  }

  async getAllHistory(): Promise<QueryExecution[]> {
    // No endpoint → empty, so the sidebar shows its empty state, not a 404.
    const setting = endpointStorage.get('bigtraceEndpoint');
    const endpoint = setting ? (setting.get() as string) : '';
    if (endpoint.trim() === '') return [];
    const list = await this.client().listQueryExecutions();
    const mapped = list.map(toQueryExecution);
    mapped.sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));
    return mapped;
  }

  async getMaterializedHistory(): Promise<QueryExecution[]> {
    return (await this.getAllHistory()).filter(
      (item) => item.materialized === true,
    );
  }

  async getNonMaterializedHistory(): Promise<QueryExecution[]> {
    return (await this.getAllHistory()).filter(
      (item) => item.materialized !== true,
    );
  }

  async deleteQuery(uuid: string): Promise<void> {
    await this.client().deleteQueryExecution(uuid);
  }

  // The listing endpoint clips perfettoSql; the per-uuid endpoint
  // returns the full text. Used by the history sidebar when the user
  // expands a clamped SQL preview.
  async fetchFullSql(uuid: string): Promise<string | undefined> {
    const raw = await this.client().getQueryExecution(uuid);
    return raw.perfettoSql;
  }
}

function toQueryExecution(raw: RawQueryExecution): QueryExecution {
  return {
    uuid: raw.queryUuid ?? '',
    status: raw.status ?? 'UNKNOWN',
    startTime: isoToEpochMs(raw.startTime),
    endTime: isoToEpochMs(raw.endTime),
    processedRows: raw.processedRows ?? 0,
    processedTraces: raw.processedTraces ?? 0,
    totalTraces: raw.totalTraces ?? 0,
    error: raw.error ?? raw.errorMessage,
    perfettoSql: raw.perfettoSql,
    limit: raw.limit,
    materialized: raw.materialized,
    tableName: raw.tableName,
    tableLink: raw.tableLink,
  };
}

export const queryHistoryStorage = new QueryHistoryStorage();
