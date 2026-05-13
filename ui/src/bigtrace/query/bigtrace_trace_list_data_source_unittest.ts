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

import {BigtraceTraceListDataSource} from './bigtrace_trace_list_data_source';
import {BigtraceQueryClient} from './bigtrace_query_client';
import {DataSourceModel} from '../../components/widgets/datagrid/data_source';
import {Filter} from '../../components/widgets/datagrid/model';
import {SettingFilter} from '../settings/settings_types';

// One microtask is enough for listTraces to settle and bookkeeping to update.
function flushAsync() {
  return new Promise<void>((r) => setTimeout(r, 0));
}

function fakeModel(opts: {
  filters?: ReadonlyArray<Filter>;
  offset?: number;
  limit?: number;
  sort?: {alias: string; direction: 'ASC' | 'DESC'};
  columns?: ReadonlyArray<string>;
}): DataSourceModel {
  return {
    pagination: {offset: opts.offset ?? 0, limit: opts.limit ?? 10},
    filters: opts.filters,
    sort: opts.sort,
    columns: opts.columns?.map((c) => ({field: c, alias: c})),
  } as never;
}

interface ListTracesCall {
  settings: ReadonlyArray<SettingFilter>;
  limit: number;
  offset: number;
  orderBy: string | undefined;
  filter: ReadonlyArray<Filter> | undefined;
  columns: ReadonlyArray<string> | undefined;
}

function makeMockClient() {
  let next: {
    rows: ReadonlyArray<Record<string, unknown>>;
    columns: ReadonlyArray<string>;
    totalFilteredRows: number;
  } = {rows: [], columns: [], totalFilteredRows: 0};
  const calls: ListTracesCall[] = [];
  const listTraces = jest.fn(
    async (
      settings: ReadonlyArray<SettingFilter>,
      limit: number,
      offset: number,
      _signal?: AbortSignal,
      orderBy?: string,
      filter?: ReadonlyArray<Filter>,
      columns?: ReadonlyArray<string>,
    ) => {
      calls.push({settings, limit, offset, orderBy, filter, columns});
      return {
        rows: next.rows,
        columns: next.columns,
        totalFilteredRows: next.totalFilteredRows,
      };
    },
  );
  return {
    client: {listTraces} as unknown as BigtraceQueryClient,
    setNextResponse: (r: {
      rows?: ReadonlyArray<Record<string, unknown>>;
      columns?: ReadonlyArray<string>;
      totalFilteredRows?: number;
    }) => {
      next = {
        rows: r.rows ?? [],
        columns: r.columns ?? [],
        totalFilteredRows: r.totalFilteredRows ?? 0,
      };
    },
    calls: () => calls,
  };
}

const NO_SETTINGS: SettingFilter[] = [];

describe('BigtraceTraceListDataSource — initial fetch', () => {
  test('triggers /traces on the first render with limit > 0', async () => {
    const mock = makeMockClient();
    mock.setNextResponse({
      columns: ['file_path', 'file_name', 'size_bytes', 'mtime'],
      rows: [
        {
          file_path: '/t/a.pftrace',
          file_name: 'a.pftrace',
          size_bytes: '100',
          mtime: '2026-01-01T00:00:00.000Z',
        },
      ],
      totalFilteredRows: 1,
    });
    const ds = new BigtraceTraceListDataSource(mock.client, () => NO_SETTINGS);
    ds.useRows(fakeModel({limit: 10}));
    await flushAsync();
    expect(mock.calls()).toHaveLength(1);
    expect(mock.calls()[0].limit).toBe(10);
    expect(mock.calls()[0].offset).toBe(0);
    expect(mock.calls()[0].filter).toEqual([]);
    expect(mock.calls()[0].orderBy).toBe('');
    expect(ds.filteredTotalRows).toBe(1);
    expect(ds.getColumns()).toEqual([
      'file_path',
      'file_name',
      'size_bytes',
      'mtime',
    ]);
  });

  test('limit=0 on first render falls back to a default-size fetch', async () => {
    // Mirrors BigtraceAsyncDataSource: the first useRows() can land
    // with limit=0 before Mithril has measured the viewport. We still
    // need to fetch — the schema/columns come back even without rows
    // — so the source falls back to a default-size window of 100.
    const mock = makeMockClient();
    const ds = new BigtraceTraceListDataSource(mock.client, () => NO_SETTINGS);
    ds.useRows(fakeModel({limit: 0}));
    await flushAsync();
    expect(mock.calls()).toHaveLength(1);
    expect(mock.calls()[0].limit).toBe(100);
  });
});

describe('BigtraceTraceListDataSource — change detection', () => {
  test('refetches when filter changes', async () => {
    const mock = makeMockClient();
    const ds = new BigtraceTraceListDataSource(mock.client, () => NO_SETTINGS);
    ds.useRows(fakeModel({limit: 10}));
    await flushAsync();
    ds.useRows(
      fakeModel({
        limit: 10,
        filters: [{field: 'file_name', op: 'glob', value: 'a*'}],
      }),
    );
    await flushAsync();
    expect(mock.calls()).toHaveLength(2);
    expect(mock.calls()[1].filter).toEqual([
      {field: 'file_name', op: 'glob', value: 'a*'},
    ]);
  });

  test('refetches when sort alias/direction changes', async () => {
    const mock = makeMockClient();
    const ds = new BigtraceTraceListDataSource(mock.client, () => NO_SETTINGS);
    ds.useRows(fakeModel({limit: 10}));
    await flushAsync();
    ds.useRows(
      fakeModel({
        limit: 10,
        sort: {alias: 'size_bytes', direction: 'DESC'},
      }),
    );
    await flushAsync();
    expect(mock.calls()).toHaveLength(2);
    // formatOrderBy uses `${alias} ${direction.toLowerCase()}`.
    expect(mock.calls()[1].orderBy).toBe('size_bytes desc');
  });

  test('refetches when settings (e.g. trace_directory) change', async () => {
    const mock = makeMockClient();
    let settings: SettingFilter[] = [
      {
        settingId: 'trace_directory',
        values: ['/tmp/a'],
        category: 'TRACE_ADDRESS',
      },
    ];
    const ds = new BigtraceTraceListDataSource(mock.client, () => settings);
    ds.useRows(fakeModel({limit: 10}));
    await flushAsync();
    expect(mock.calls()).toHaveLength(1);

    settings = [
      {
        settingId: 'trace_directory',
        values: ['/tmp/b'],
        category: 'TRACE_ADDRESS',
      },
    ];
    ds.useRows(fakeModel({limit: 10}));
    await flushAsync();
    expect(mock.calls()).toHaveLength(2);
    expect(mock.calls()[1].settings).toEqual(settings);
  });

  test('does not refetch when nothing relevant has changed', async () => {
    const mock = makeMockClient();
    const ds = new BigtraceTraceListDataSource(mock.client, () => NO_SETTINGS);
    ds.useRows(fakeModel({limit: 10}));
    await flushAsync();
    ds.useRows(fakeModel({limit: 10}));
    await flushAsync();
    ds.useRows(fakeModel({limit: 10}));
    await flushAsync();
    expect(mock.calls()).toHaveLength(1);
  });
});

describe('BigtraceTraceListDataSource — column projection', () => {
  test('ships model.columns as the listTraces `columns` arg', async () => {
    const mock = makeMockClient();
    const ds = new BigtraceTraceListDataSource(mock.client, () => NO_SETTINGS);
    ds.useRows(fakeModel({limit: 10, columns: ['file_name', 'size_bytes']}));
    await flushAsync();
    expect(mock.calls()).toHaveLength(1);
    expect(mock.calls()[0].columns).toEqual(['file_name', 'size_bytes']);
  });

  test('omits the columns arg when the model has no columns', async () => {
    // Initial state — useRows called with no columns (FlatModel
    // without an explicit column list). Backend then falls back to
    // its schema defaults.
    const mock = makeMockClient();
    const ds = new BigtraceTraceListDataSource(mock.client, () => NO_SETTINGS);
    ds.useRows(fakeModel({limit: 10}));
    await flushAsync();
    expect(mock.calls()[0].columns).toBeUndefined();
  });

  test('refetches when the visible-columns set changes', async () => {
    const mock = makeMockClient();
    const ds = new BigtraceTraceListDataSource(mock.client, () => NO_SETTINGS);
    ds.useRows(fakeModel({limit: 10, columns: ['file_name', 'size_bytes']}));
    await flushAsync();
    ds.useRows(fakeModel({limit: 10, columns: ['file_name']}));
    await flushAsync();
    expect(mock.calls()).toHaveLength(2);
    expect(mock.calls()[1].columns).toEqual(['file_name']);
  });

  test('refetches when only the column ORDER changes', async () => {
    // The DataGrid's column reorder UI emits onColumnsChanged with
    // the same set but a different order. The backend honours that
    // order in the response, so the grid must refetch.
    const mock = makeMockClient();
    const ds = new BigtraceTraceListDataSource(mock.client, () => NO_SETTINGS);
    ds.useRows(fakeModel({limit: 10, columns: ['file_name', 'size_bytes']}));
    await flushAsync();
    ds.useRows(fakeModel({limit: 10, columns: ['size_bytes', 'file_name']}));
    await flushAsync();
    expect(mock.calls()).toHaveLength(2);
    expect(mock.calls()[1].columns).toEqual(['size_bytes', 'file_name']);
  });
});

describe('BigtraceTraceListDataSource — pagination', () => {
  test('refetches when offset changes after initial load', async () => {
    const mock = makeMockClient();
    const ds = new BigtraceTraceListDataSource(mock.client, () => NO_SETTINGS);
    ds.useRows(fakeModel({limit: 10, offset: 0}));
    await flushAsync();
    ds.useRows(fakeModel({limit: 10, offset: 10}));
    await flushAsync();
    expect(mock.calls()).toHaveLength(2);
    expect(mock.calls()[1].offset).toBe(10);
  });
});

describe('BigtraceTraceListDataSource — error path', () => {
  test('error clears rows so a stale match set is not shown', async () => {
    // Only one useRows() call: a second render would kick off a fresh
    // fetchWindow that resets `error` back to null at its start before
    // the catch can re-set it, masking the post-error observable
    // state. The data source intentionally retries on every render
    // until the first successful fetch completes (so a transient 400
    // from "trace_directory not set yet" recovers); the test just
    // pins the first-error visibility.
    const errClient = {
      listTraces: jest.fn().mockRejectedValue(new Error('boom')),
    } as unknown as BigtraceQueryClient;
    const ds = new BigtraceTraceListDataSource(errClient, () => NO_SETTINGS);
    ds.useRows(fakeModel({limit: 10}));
    await flushAsync();
    expect(ds.getError()).toBe('boom');
    expect(ds.filteredTotalRows).toBe(0);
  });
});
