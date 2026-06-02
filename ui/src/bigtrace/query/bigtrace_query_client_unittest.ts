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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {
  BigtraceQueryClient,
  QueryNotFoundError,
  parseQueryResponse,
} from './bigtrace_query_client';
import {encodeFilters} from './filter_encoding';

describe('parseQueryResponse', () => {
  test('returns empty result for null/undefined response', () => {
    expect(parseQueryResponse({})).toEqual({rows: [], columns: []});
    expect(parseQueryResponse({columnNames: ['a'], rows: undefined})).toEqual({
      rows: [],
      columns: [],
    });
  });

  test('aligns row values with column names', () => {
    const result = parseQueryResponse({
      columnNames: ['a', 'b', 'c'],
      rows: [{values: ['one', 'two', null]}],
    });
    expect(result.columns).toEqual(['a', 'b', 'c']);
    expect(result.rows).toEqual([{a: 'one', b: 'two', c: null}]);
  });

  test('preserves numeric strings as strings (no precision loss)', () => {
    // The wire is always-strings so 64-bit values round-trip without going
    // through JS Number (which would lose precision past 2^53).
    const big = '9007199254740993';
    const result = parseQueryResponse({
      columnNames: ['id'],
      rows: [{values: [big]}],
    });
    expect(result.rows[0].id).toBe(big);
    expect(typeof result.rows[0].id).toBe('string');
  });

  test('preserves empty strings (does not coerce to 0)', () => {
    const result = parseQueryResponse({
      columnNames: ['s'],
      rows: [{values: ['']}],
    });
    expect(result.rows[0].s).toBe('');
  });

  test("translates the 'NULL' SQL marker into JS null", () => {
    const result = parseQueryResponse({
      columnNames: ['x'],
      rows: [{values: ['NULL']}],
    });
    expect(result.rows[0].x).toBeNull();
  });

  test('preserves explicit JSON null', () => {
    const result = parseQueryResponse({
      columnNames: ['x'],
      rows: [{values: [null]}],
    });
    expect(result.rows[0].x).toBeNull();
  });

  test('multiple rows in the right order', () => {
    const result = parseQueryResponse({
      columnNames: ['n'],
      rows: [{values: ['1']}, {values: ['2']}, {values: ['3']}],
    });
    expect(result.rows.map((r) => r.n)).toEqual(['1', '2', '3']);
  });

  test('passes through totalFilteredRows when present', () => {
    const result = parseQueryResponse({
      columnNames: ['n'],
      rows: [{values: ['1']}],
      totalFilteredRows: 42,
    });
    expect(result.totalFilteredRows).toBe(42);
  });

  test('totalFilteredRows is undefined for non-fetchResults responses', () => {
    const result = parseQueryResponse({
      columnNames: ['n'],
      rows: [{values: ['1']}],
    });
    expect(result.totalFilteredRows).toBeUndefined();
  });

  test('does not plumb availableColumnNames (fetchResults attaches it)', () => {
    // WIRE_SPEC §9.9 / §14.6: `availableColumnNames` is `:fetch_results`-
    // only. Keeping the parser endpoint-agnostic means the field can't
    // accidentally leak from `/traces` (whose column catalog lives on
    // `/traces_schema`, not echoed in the page response).
    const result = parseQueryResponse({
      columnNames: ['n'],
      rows: [{values: ['1']}],
      availableColumnNames: ['n', 'extra_col'],
    });
    expect(result.availableColumnNames).toBeUndefined();
  });
});

describe('encodeFilters', () => {
  test('strings and null pass through unchanged', () => {
    const out = encodeFilters([
      {field: 'name', op: 'glob', value: 'ui::*'},
      {field: 'kind', op: 'in', value: ['a', 'b']},
      {field: 'parent_id', op: 'is null'},
    ]);
    expect(JSON.parse(out)).toEqual([
      {field: 'name', op: 'glob', value: 'ui::*'},
      {field: 'kind', op: 'in', value: ['a', 'b']},
      {field: 'parent_id', op: 'is null'},
    ]);
  });

  test('coerces non-string primitives so the wire is always-strings', () => {
    // Always-strings: numbers, bigints, booleans all coerce losslessly.
    // Booleans aren't in `SqlValue`; the encoder handles them anyway.
    const out = encodeFilters([
      {field: 'count', op: '>=', value: 10},
      {field: 'dur', op: '>', value: 9223372036854775807n},
      JSON.parse('{"field":"flag","op":"=","value":true}'),
    ]);
    expect(JSON.parse(out)).toEqual([
      {field: 'count', op: '>=', value: '10'},
      {field: 'dur', op: '>', value: '9223372036854775807'},
      {field: 'flag', op: '=', value: 'true'},
    ]);
  });

  test('coerces every entry of an in-list', () => {
    const out = encodeFilters([{field: 'tid', op: 'in', value: [1n, 2, 3n]}]);
    expect(JSON.parse(out)).toEqual([
      {field: 'tid', op: 'in', value: ['1', '2', '3']},
    ]);
  });

  test('preserves JSON null distinct from the literal "null" string', () => {
    // JSON null must NOT coerce to the string "null" (would match VARCHAR rows).
    const out = encodeFilters([{field: 'a', op: '=', value: null}]);
    expect(out).toBe('[{"field":"a","op":"=","value":null}]');
  });

  test('empty array → "[]"', () => {
    expect(encodeFilters([])).toBe('[]');
  });

  test('produces canonical (key-sorted) output for stable equality', () => {
    // Construction-order differences must not change the encoded string.
    const a = encodeFilters([{field: 'x', op: '=', value: '1'}]);
    const b = encodeFilters([JSON.parse('{"value":"1","op":"=","field":"x"}')]);
    expect(a).toBe(b);
    // And the canonical form is alphabetical.
    expect(a).toBe('[{"field":"x","op":"=","value":"1"}]');
  });
});

describe('BigtraceQueryClient.fetchResults body construction', () => {
  // :fetch_results is POST + body since the strict-native filter migration
  // (2026-06-03). The URL is plain (no query string); the body carries
  // limit/offset/order_by?/filter?/columns?. Filter ships as a native
  // array (matches /execute_* trace_filters + /traces filter contracts).
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function captureFetch(): ReturnType<typeof vi.fn> {
    const fakeResp = {
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({columnNames: [], rows: []})),
      json: () => Promise.resolve({columnNames: [], rows: []}),
    };
    const fn = vi.fn().mockResolvedValue(fakeResp);
    global.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  function bodyFrom(
    fetchMock: ReturnType<typeof vi.fn>,
  ): Record<string, unknown> {
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    return JSON.parse(init.body as string);
  }

  test('hits :fetch_results with POST and a plain URL', async () => {
    const fetchMock = captureFetch();
    const client = new BigtraceQueryClient('http://example/');
    await client.fetchResults('uid', 50, 0);
    const url = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(url).toBe('http://example//query_executions/uid:fetch_results');
    expect(init.method).toBe('POST');
    // limit / offset always ride in the body, never the URL.
    expect(url).not.toContain('?');
    expect(bodyFrom(fetchMock).limit).toBe(50);
    expect(bodyFrom(fetchMock).offset).toBe(0);
  });

  test('omits filter from body when none / empty array passed', async () => {
    const fetchMock = captureFetch();
    const client = new BigtraceQueryClient('http://example/');
    await client.fetchResults('uid', 50, 0);
    expect(bodyFrom(fetchMock).filter).toBeUndefined();

    const fetchMock2 = captureFetch();
    await client.fetchResults('uid', 50, 0, undefined, undefined, []);
    expect(bodyFrom(fetchMock2).filter).toBeUndefined();
  });

  test('ships filter as a native array in the body with always-strings coercion', async () => {
    const fetchMock = captureFetch();
    const client = new BigtraceQueryClient('http://example/');
    await client.fetchResults('uid', 50, 0, undefined, undefined, [
      {field: 'name', op: 'glob', value: 'ui::*'},
      {field: 'dur', op: '>', value: 9223372036854775807n},
    ]);
    const body = bodyFrom(fetchMock);
    // Native array, NOT a JSON-encoded string.
    expect(Array.isArray(body.filters)).toBe(true);
    // bigint → string for lossless int64 round-trip across JS Number.
    expect(body.filters).toEqual([
      {field: 'name', op: 'glob', value: 'ui::*'},
      {field: 'dur', op: '>', value: '9223372036854775807'},
    ]);
  });

  test('order_by and filter both appear in the body when set', async () => {
    const fetchMock = captureFetch();
    const client = new BigtraceQueryClient('http://example/');
    await client.fetchResults('uid', 50, 0, undefined, 'name desc', [
      {field: 'kind', op: '=', value: 'sched'},
    ]);
    const body = bodyFrom(fetchMock);
    expect(body.order_by).toBe('name desc');
    expect(body.filters).toEqual([{field: 'kind', op: '=', value: 'sched'}]);
  });

  test('columns is omitted from body when empty, included as array when set', async () => {
    const client = new BigtraceQueryClient('http://example/');
    let fetchMock = captureFetch();
    await client.fetchResults('uid', 50, 0);
    expect(bodyFrom(fetchMock).columns).toBeUndefined();

    fetchMock = captureFetch();
    await client.fetchResults(
      'uid',
      50,
      0,
      undefined,
      undefined,
      undefined,
      [],
    );
    expect(bodyFrom(fetchMock).columns).toBeUndefined();

    fetchMock = captureFetch();
    await client.fetchResults('uid', 50, 0, undefined, undefined, undefined, [
      'trace_id',
      'name',
      'file_name',
    ]);
    // Native array in the body — no comma-joining, no URL encoding.
    expect(bodyFrom(fetchMock).columns).toEqual([
      'trace_id',
      'name',
      'file_name',
    ]);
  });

  test('fetchResults surfaces availableColumnNames from the wire', async () => {
    // WIRE_SPEC §9.5: `:fetch_results` ships the union of result +
    // sidecar columns so the UI's column-picker knows what's
    // selectable. The parser stays endpoint-agnostic; only fetchResults
    // attaches the field on the way out.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            columnNames: ['trace_id', 'name'],
            rows: [{values: ['a', 'evt']}],
            totalFilteredRows: 1,
            availableColumnNames: [
              'trace_id',
              'name',
              'file_name',
              'size_bytes',
            ],
          }),
        ),
      json: () =>
        Promise.resolve({
          columnNames: ['trace_id', 'name'],
          rows: [{values: ['a', 'evt']}],
          totalFilteredRows: 1,
          availableColumnNames: ['trace_id', 'name', 'file_name', 'size_bytes'],
        }),
    }) as unknown as typeof fetch;
    const client = new BigtraceQueryClient('http://example/');
    const page = await client.fetchResults('uid', 50, 0);
    expect(page.availableColumnNames).toEqual([
      'trace_id',
      'name',
      'file_name',
      'size_bytes',
    ]);
  });
});

describe('BigtraceQueryClient.listTraces body construction', () => {
  // /traces is POST so the contract lives in the request body, not
  // the URL. Pin (a) the endpoint, (b) settings array snake_case
  // (matches /execute_*), (c) order_by/filter/columns inclusion rules.
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function captureFetch(): ReturnType<typeof vi.fn> {
    const fakeResp = {
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({columnNames: [], rows: [], totalFilteredRows: 0}),
        ),
      json: () =>
        Promise.resolve({columnNames: [], rows: [], totalFilteredRows: 0}),
    };
    const fn = vi.fn().mockResolvedValue(fakeResp);
    global.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  function bodyFrom(
    fetchMock: ReturnType<typeof vi.fn>,
  ): Record<string, unknown> {
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    return JSON.parse(init.body as string);
  }

  test('hits /traces with POST', async () => {
    const fetchMock = captureFetch();
    const client = new BigtraceQueryClient('http://example/');
    await client.listTraces([], 100, 0);
    const url = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(url).toBe('http://example//traces');
    expect(init.method).toBe('POST');
  });

  test('settings are renamed to snake_case on the wire', async () => {
    const fetchMock = captureFetch();
    const client = new BigtraceQueryClient('http://example/');
    await client.listTraces(
      [
        {
          settingId: 'trace_directory',
          values: ['/tmp/x'],
          category: 'TRACE_ADDRESS',
        },
      ],
      100,
      0,
    );
    const body = bodyFrom(fetchMock);
    // Same rename rule as /execute_* (server uses _first_setting_value
    // which is strict on snake_case `setting_id`).
    expect(body.settings).toEqual([
      {
        setting_id: 'trace_directory',
        values: ['/tmp/x'],
        category: 'TRACE_ADDRESS',
      },
    ]);
  });

  test('order_by is omitted when empty, included when set', async () => {
    const client = new BigtraceQueryClient('http://example/');
    let fetchMock = captureFetch();
    await client.listTraces([], 100, 0);
    expect(bodyFrom(fetchMock).order_by).toBeUndefined();
    fetchMock = captureFetch();
    await client.listTraces([], 100, 0, undefined, 'file_name desc');
    expect(bodyFrom(fetchMock).order_by).toBe('file_name desc');
  });

  test('filter is omitted when empty, included as structured array when set', async () => {
    const client = new BigtraceQueryClient('http://example/');
    let fetchMock = captureFetch();
    await client.listTraces([], 100, 0, undefined, undefined, []);
    expect(bodyFrom(fetchMock).filter).toBeUndefined();
    fetchMock = captureFetch();
    await client.listTraces([], 100, 0, undefined, undefined, [
      {field: 'file_name', op: 'glob', value: 'a*'},
    ]);
    // Body is the JSON-decoded array — NOT a URL-encoded string. The
    // server JSON-parses the body, so re-encoding via encodeFilters
    // (which the :fetch_results path uses) would land a doubly-encoded
    // string here.
    expect(bodyFrom(fetchMock).filter).toEqual([
      {field: 'file_name', op: 'glob', value: 'a*'},
    ]);
  });

  test('columns is omitted when undefined or empty, included verbatim when set', async () => {
    const client = new BigtraceQueryClient('http://example/');
    let fetchMock = captureFetch();
    await client.listTraces([], 100, 0);
    expect(bodyFrom(fetchMock).columns).toBeUndefined();
    fetchMock = captureFetch();
    await client.listTraces([], 100, 0, undefined, undefined, undefined, []);
    expect(bodyFrom(fetchMock).columns).toBeUndefined();
    fetchMock = captureFetch();
    // Set: shipped as an array in user-given order. The server projects
    // exactly these columns; the array order also determines the
    // response column order.
    await client.listTraces([], 100, 0, undefined, undefined, undefined, [
      'file_name',
      'size_bytes',
    ]);
    expect(bodyFrom(fetchMock).columns).toEqual(['file_name', 'size_bytes']);
  });

  test('does not surface availableColumnNames even if the wire ships one', async () => {
    // WIRE_SPEC §9.9: `/traces` MUST NOT echo a column catalog —
    // `/traces_schema` is the source of truth. Even if a non-compliant
    // backend ships `availableColumnNames`, the client drops it so no
    // consumer can grow a dependency on it.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            columnNames: ['file_name'],
            rows: [{values: ['a.pftrace']}],
            totalFilteredRows: 1,
            availableColumnNames: ['file_path', 'file_name', 'size_bytes'],
          }),
        ),
      json: () =>
        Promise.resolve({
          columnNames: ['file_name'],
          rows: [{values: ['a.pftrace']}],
          totalFilteredRows: 1,
          availableColumnNames: ['file_path', 'file_name', 'size_bytes'],
        }),
    }) as unknown as typeof fetch;
    const client = new BigtraceQueryClient('http://example/');
    const page = await client.listTraces([], 100, 0);
    expect(page.availableColumnNames).toBeUndefined();
  });
});

describe('BigtraceQueryClient.listTracesSchema body construction', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function captureFetch(): ReturnType<typeof vi.fn> {
    const fakeResp = {
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({columns: []})),
      json: () => Promise.resolve({columns: []}),
    };
    const fn = vi.fn().mockResolvedValue(fakeResp);
    global.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  test('hits /traces_schema with POST and snake_case settings', async () => {
    const fetchMock = captureFetch();
    const client = new BigtraceQueryClient('http://example/');
    await client.listTracesSchema([
      {
        settingId: 'trace_directory',
        values: ['/tmp/x'],
        category: 'TRACE_ADDRESS',
      },
    ]);
    const url = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(url).toBe('http://example//traces_schema');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.settings).toEqual([
      {
        setting_id: 'trace_directory',
        values: ['/tmp/x'],
        category: 'TRACE_ADDRESS',
      },
    ]);
  });

  test('returns the parsed columns array', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            columns: [
              {name: 'file_name', type: 'VARCHAR', defaultVisible: true},
              {name: 'mtime', type: 'VARCHAR', defaultVisible: false},
            ],
          }),
        ),
      json: () =>
        Promise.resolve({
          columns: [
            {name: 'file_name', type: 'VARCHAR', defaultVisible: true},
            {name: 'mtime', type: 'VARCHAR', defaultVisible: false},
          ],
        }),
    }) as unknown as typeof fetch;
    const client = new BigtraceQueryClient('http://example/');
    const resp = await client.listTracesSchema([]);
    expect(resp.columns).toHaveLength(2);
    expect(resp.columns[0].name).toBe('file_name');
    expect(resp.columns[0].defaultVisible).toBe(true);
    expect(resp.columns[1].defaultVisible).toBe(false);
  });
});

describe('BigtraceQueryClient executeSync/executeAsync trace_filters', () => {
  // The top-level `trace_filters` field on /execute_* is a native
  // `Filter[]` JSON array under the strict-native body contract.
  // The backend rejects JSON-encoded strings with 400. Absence on
  // the wire means "process every trace in the directory".
  // (`:fetch_results?filter=` URL still ships the encoded string —
  // only body sites switched to native on the 2026-06-03 migration.)
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function captureFetch(): ReturnType<typeof vi.fn> {
    const fakeResp = {
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({queryUuid: 'u', columnNames: [], rows: []}),
        ),
      json: () => Promise.resolve({queryUuid: 'u', columnNames: [], rows: []}),
    };
    const fn = vi.fn().mockResolvedValue(fakeResp);
    global.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  function bodyFrom(
    fetchMock: ReturnType<typeof vi.fn>,
  ): Record<string, unknown> {
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    return JSON.parse(init.body as string);
  }

  test('omits trace_filters when undefined or empty', async () => {
    const client = new BigtraceQueryClient('http://example/');
    let fetchMock = captureFetch();
    await client.executeSync('SELECT 1', 10, []);
    expect(bodyFrom(fetchMock).trace_filters).toBeUndefined();
    fetchMock = captureFetch();
    await client.executeAsync('SELECT 1', 10, [], undefined, []);
    expect(bodyFrom(fetchMock).trace_filters).toBeUndefined();
  });

  test('ships trace_filters as a native JSON array at the wire boundary', async () => {
    const fetchMock = captureFetch();
    const client = new BigtraceQueryClient('http://example/');
    await client.executeAsync('SELECT 1', 10, [], undefined, [
      {field: 'file_name', op: '=', value: 'a.pftrace'},
    ]);
    const body = bodyFrom(fetchMock);
    // Strict-native body contract: the wire value MUST be a native
    // array, not a JSON-encoded string. Backend rejects strings with 400.
    expect(Array.isArray(body.trace_filterss)).toBe(true);
    expect(body.trace_filterss).toEqual([
      {field: 'file_name', op: '=', value: 'a.pftrace'},
    ]);
    // The "is" here is intentional: trace_filters sits at the same level
    // as `perfetto_sql` and `settings`, not nested inside settings.
    expect(body.perfetto_sql).toBe('SELECT 1');
    expect(body.settings).toEqual([]);
  });

  test('sync and async share the trace_filters wire shape (native array)', async () => {
    const filter = [{field: 'size_bytes', op: '>', value: '1024'}] as const;
    const client = new BigtraceQueryClient('http://example/');
    let fetchMock = captureFetch();
    await client.executeSync('SELECT 1', 10, [], undefined, filter);
    const syncBody = bodyFrom(fetchMock);
    fetchMock = captureFetch();
    await client.executeAsync('SELECT 1', 10, [], undefined, filter);
    const asyncBody = bodyFrom(fetchMock);
    const expected = [{field: 'size_bytes', op: '>', value: '1024'}];
    expect(syncBody.trace_filters).toEqual(expected);
    expect(asyncBody.trace_filters).toEqual(expected);
  });
});

describe('BigtraceQueryClient executeSync/executeAsync trace_order_by', () => {
  // Top-level AIP-132 ordering string controlling the trace fan-out
  // order. Matters under `trace_limit > 0` — the cap keeps the first
  // N traces in this order. Absence means "let the backend pick its
  // default" (`file_path ASC` on the reference).
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function captureFetch(): ReturnType<typeof vi.fn> {
    const fakeResp = {
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({queryUuid: 'u', columnNames: [], rows: []}),
        ),
      json: () => Promise.resolve({queryUuid: 'u', columnNames: [], rows: []}),
    };
    const fn = vi.fn().mockResolvedValue(fakeResp);
    global.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  function bodyFrom(
    fetchMock: ReturnType<typeof vi.fn>,
  ): Record<string, unknown> {
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    return JSON.parse(init.body as string);
  }

  test('omits trace_order_by when undefined or empty', async () => {
    const client = new BigtraceQueryClient('http://example/');
    let fetchMock = captureFetch();
    await client.executeAsync('SELECT 1', 10, [], undefined, [], [], '');
    expect(bodyFrom(fetchMock).trace_order_by).toBeUndefined();
    fetchMock = captureFetch();
    await client.executeAsync('SELECT 1', 10, [], undefined);
    expect(bodyFrom(fetchMock).trace_order_by).toBeUndefined();
  });

  test('ships trace_order_by verbatim when set', async () => {
    const fetchMock = captureFetch();
    const client = new BigtraceQueryClient('http://example/');
    await client.executeAsync(
      'SELECT 1',
      10,
      [],
      undefined,
      [],
      [],
      'size_bytes desc',
    );
    expect(bodyFrom(fetchMock).trace_order_by).toBe('size_bytes desc');
  });

  test('sync and async share the trace_order_by shape', async () => {
    const orderBy = 'file_name asc';
    const client = new BigtraceQueryClient('http://example/');
    let fetchMock = captureFetch();
    await client.executeSync('SELECT 1', 10, [], undefined, [], [], orderBy);
    expect(bodyFrom(fetchMock).trace_order_by).toBe(orderBy);
    fetchMock = captureFetch();
    await client.executeAsync('SELECT 1', 10, [], undefined, [], [], orderBy);
    expect(bodyFrom(fetchMock).trace_order_by).toBe(orderBy);
  });
});

describe('BigtraceQueryClient 404 handling', () => {
  // resume-from-history relies on 404 → QueryNotFoundError to drop dead UUIDs.
  // Jest runs in Node, so we hand-roll a minimal Response-shaped object.
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function fakeResponse(status: number, body: string): unknown {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(body),
      json: () => Promise.resolve(JSON.parse(body)),
    };
  }

  function mockStatus(status: number, body: string): void {
    global.fetch = vi.fn().mockResolvedValue(fakeResponse(status, body));
  }

  test('getQueryExecution rejects with QueryNotFoundError on 404', async () => {
    const uuid = 'abc-123';
    mockStatus(404, JSON.stringify({detail: `Query ${uuid} not found`}));
    const client = new BigtraceQueryClient('http://example/');
    await expect(client.getQueryExecution(uuid)).rejects.toBeInstanceOf(
      QueryNotFoundError,
    );
  });

  test('extracted UUID matches the request path', async () => {
    const uuid = 'abc-123';
    mockStatus(404, JSON.stringify({detail: `Query ${uuid} not found`}));
    const client = new BigtraceQueryClient('http://example/');
    let caught: unknown;
    try {
      await client.getStatus(uuid);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueryNotFoundError);
    expect((caught as Error).message).toContain(uuid);
  });

  test('non-404 errors are not converted to QueryNotFoundError', async () => {
    mockStatus(500, 'boom');
    const client = new BigtraceQueryClient('http://example/');
    await expect(client.getQueryExecution('any')).rejects.not.toBeInstanceOf(
      QueryNotFoundError,
    );
  });
});
