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

// Deep linking support: given a CUJ in the URL, navigate to that CUJ's process
// and area-select its time range on the main thread, in the same way the
// AndroidAnr and AndroidStartup plugins handle their own deeplinks.
//
// E.g. https://ui.perfetto.dev/#!/?com.android.AndroidCujs.cujId=12
//      https://ui.perfetto.dev/#!/?com.android.AndroidCujs.cujTs=1457070153380
//      https://ui.perfetto.dev/#!/?com.android.AndroidCujs.cujName=SOME_CUJ

import {sqliteString} from '../../base/string_utils';
import {Time} from '../../base/time';
import type {Trace} from '../../public/trace';
import type {RouteArgs} from '../../public/route_schema';
import {
  LONG,
  LONG_NULL,
  NUM,
  NUM_NULL,
} from '../../trace_processor/query_result';
import ProcessThreadGroupsPlugin from '../dev.perfetto.ProcessThreadGroups';
import {findTrackUriByTrackId, scrollToTrackAndSelect} from './navigate';

export interface CujDeeplinkArgs {
  // `android_jank_latency_cujs.cuj_id` of the CUJ to navigate to.
  readonly cujId?: number;
  // `android_jank_latency_cujs.ts` of the CUJ to navigate to.
  readonly cujTs?: bigint;
  // CUJ name without the `J<`/`L<` wrapper, e.g. 'NOTIFICATION_SHADE_EXPAND'.
  readonly cujName?: string;
}

// Route args are only ever strings or booleans, so numeric args arrive as
// strings and have to be converted by hand.
function parseInteger(rawValue: RouteArgs[string]): number | undefined {
  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    return undefined;
  }
  const value = Number(rawValue);
  return Number.isInteger(value) ? value : undefined;
}

function parseString(rawValue: RouteArgs[string]): string | undefined {
  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    return undefined;
  }
  return rawValue;
}

// Timestamps are int64 nanoseconds, so they are parsed as bigints: going via a
// JS number would silently lose precision on large clock values.
function parseTimestamp(rawValue: RouteArgs[string]): bigint | undefined {
  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    return undefined;
  }
  try {
    return BigInt(rawValue.trim());
  } catch {
    return undefined;
  }
}

/**
 * Extracts the CUJ deeplink args from the URL route args.
 *
 * URL args are namespaced by the plugin id, which is passed in rather than
 * imported so that this module doesn't depend on index.ts.
 *
 * Args that are absent or malformed are dropped; if nothing is left, no
 * navigation happens at all.
 */
export function getCujArgsFromRouteArgs(
  args: RouteArgs,
  pluginId: string,
): CujDeeplinkArgs {
  const cujId = parseInteger(args[`${pluginId}.cujId`]);
  const cujTs = parseTimestamp(args[`${pluginId}.cujTs`]);
  const cujName = parseString(args[`${pluginId}.cujName`]);
  return {
    ...(cujId !== undefined && {cujId}),
    ...(cujTs !== undefined && {cujTs}),
    ...(cujName !== undefined && {cujName}),
  };
}

/**
 * Builds the query locating the CUJ referenced by the deeplink, or undefined if
 * the URL didn't reference one.
 */
export function buildCujLookupQuery(args: CujDeeplinkArgs): string | undefined {
  const filters = [
    args.cujId !== undefined && `cuj.cuj_id = ${args.cujId}`,
    // Note for jank CUJs this is the start of the first overlapping expected
    // frame rather than the CUJ slice's own ts. Matching the table keeps the
    // args and the range this ends up selecting consistent with each other.
    args.cujTs !== undefined && `cuj.ts = ${args.cujTs}`,
    // `cuj_name` is the name without the `J<`/`L<` wrapper, which is what the
    // rest of the plugin keys CUJs on too.
    args.cujName !== undefined &&
      `cuj.cuj_name = ${sqliteString(args.cujName)}`,
  ].filter((filter) => filter !== false);

  if (filters.length === 0) {
    return undefined;
  }

  // `android_jank_latency_cujs` covers both jank and latency CUJs, so the args
  // above address either kind.
  //
  // The main thread is resolved via `thread.is_main_thread` rather than the
  // table's `ui_thread` column: for latency CUJs the stdlib puts a upid in that
  // column, so it is wrong for half the rows.
  //
  // If several CUJs match, take the one that started last, like the ANR and
  // startup deeplinks do.
  return `
    SELECT
      cuj.upid AS upid,
      cuj.ts AS ts,
      cuj.dur AS dur,
      tt.id AS main_thread_track_id
    FROM android_jank_latency_cujs AS cuj
    LEFT JOIN thread AS t
      ON t.upid = cuj.upid AND t.is_main_thread = 1
    LEFT JOIN thread_track AS tt
      ON tt.utid = t.utid
    WHERE ${filters.join(' AND ')}
    ORDER BY cuj.ts DESC
    LIMIT 1
  `;
}

/**
 * Navigates to the CUJ referenced by the deeplink, if any.
 *
 * No-op (not even a query) when the URL references no CUJ.
 */
export async function selectCujFromDeeplink(
  ctx: Trace,
  args: CujDeeplinkArgs,
): Promise<void> {
  const query = buildCujLookupQuery(args);
  if (query === undefined) {
    return;
  }

  await ctx.engine.query('INCLUDE PERFETTO MODULE android.cujs.sysui_cujs;');
  const result = await ctx.engine.query(query);
  const it = result.iter({
    upid: NUM,
    ts: LONG,
    dur: LONG_NULL,
    main_thread_track_id: NUM_NULL,
  });
  if (!it.valid()) {
    return;
  }

  const cuj = {
    upid: it.upid,
    ts: Time.fromRaw(it.ts),
    dur: it.dur ?? 0n,
    mainThreadTrackId: it.main_thread_track_id,
  };

  // Defer the navigation until all plugins have registered their tracks,
  // otherwise the process group and the main thread track don't exist yet.
  ctx.onTraceReady.addListener(() => {
    const group = (
      ctx.plugins.getPlugin(
        ProcessThreadGroupsPlugin,
      ) as ProcessThreadGroupsPlugin
    ).getGroupForProcess(cuj.upid);

    if (!group?.uri) {
      return;
    }
    group.expand();

    const tracksToSelect: string[] = [];
    if (cuj.mainThreadTrackId !== null) {
      const uri = findTrackUriByTrackId(ctx, cuj.mainThreadTrackId);
      if (uri) {
        tracksToSelect.push(uri);
      }
    }

    scrollToTrackAndSelect(ctx, group.uri, tracksToSelect, cuj.ts, cuj.dur);
  });
}
