/*
 * Copyright (C) 2026 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include "src/trace_processor/plugins/interval_self_intersect/interval_self_intersect.h"

#include <algorithm>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "perfetto/base/compiler.h"
#include "perfetto/base/logging.h"
#include "src/trace_processor/containers/string_pool.h"
#include "src/trace_processor/core/dataframe/adhoc_dataframe_builder.h"
#include "src/trace_processor/core/dataframe/dataframe.h"
#include "src/trace_processor/core/plugin/plugin.h"
#include "src/trace_processor/perfetto_sql/engine/perfetto_sql_connection.h"
#include "src/trace_processor/sqlite/bindings/sqlite_aggregate_function.h"
#include "src/trace_processor/sqlite/bindings/sqlite_function.h"
#include "src/trace_processor/sqlite/bindings/sqlite_result.h"
#include "src/trace_processor/sqlite/bindings/sqlite_value.h"
#include "src/trace_processor/sqlite/sqlite_utils.h"
#include "src/trace_processor/storage/trace_storage.h"
#include "src/trace_processor/types/trace_processor_context.h"

namespace perfetto::trace_processor::interval_self_intersect {
namespace {

using ColType = dataframe::AdhocDataframeBuilder::ColumnType;

// Plain interval list collected for the drop-in variant: one entry per input
// row, in insertion order. Ids are opaque int64 payload — duplicate ids are
// legal (each input row is its own interval, matching the SQL macro this
// replaces) and never index anything.
struct IsiPlainIntervals {
  static constexpr char kName[] = "ISI_PLAIN_INTERVALS";

  struct Row {
    int64_t id;
    int64_t start;
    int64_t end;
  };

  std::vector<Row> rows;
};

// Sweep-line event over input-row indices. Tie-break: starts before ends at
// identical ts so an interval that ends exactly when another starts doesn't
// briefly drop the active set.
struct Event {
  int64_t ts;
  uint32_t row;
  int8_t delta;  // +1 = start, -1 = end

  bool operator<(const Event& other) const {
    if (ts != other.ts) {
      return ts < other.ts;
    }
    return delta > other.delta;
  }
};

// Mirror the old SQL intervals.intersect.interval_self_intersect macro's
// output: one row per (atomic segment × active input row), plus one "end
// marker" row at the segment that begins at each interval's end ts,
// deduplicated per (id, end ts) exactly like the old macro's UNION of
// endpoints (dur taken from that segment, so the last endpoint emits a
// dur=0 segment containing only end markers).
//
// Implementation: single O(n log n + m) sweep over all events from the input
// (m = output rows; endpoints are sorted once and the active set uses O(1)
// swap-and-pop removal).
// The active set is keyed by input-row index — never by id — so duplicate
// ids behave as independent intervals, matching the old macro.
void RunSelfIntersect(dataframe::AdhocDataframeBuilder& builder,
                      const IsiPlainIntervals& intervals) {
  if (intervals.rows.empty()) {
    return;
  }

  std::vector<Event> events;
  events.reserve(intervals.rows.size() * 2);
  for (uint32_t i = 0; i < intervals.rows.size(); ++i) {
    events.push_back(Event{intervals.rows[i].start, i, static_cast<int8_t>(1)});
    events.push_back(Event{intervals.rows[i].end, i, static_cast<int8_t>(-1)});
  }
  std::sort(events.begin(), events.end());

  // Active input rows; each row starts and ends exactly once. Removal is
  // O(1) swap-and-pop: active_pos maps a row to its slot in active_rows so an
  // end event can drop it without a linear scan. (Input-row indices are
  // dense, so active_pos is a plain vector.) A linear find+erase here would
  // make the sweep O(n^2) on high-concurrency inputs — where the active set
  // is large across many end events — regardless of output size.
  std::vector<uint32_t> active_rows;
  std::vector<uint32_t> active_pos(intervals.rows.size());

  // Ids whose intervals ended at the previous ts — their end markers land in
  // the segment that STARTS at that ts, matching the old SQL macro's "end
  // marker" attribution. Deduped per segment on id (the old macro's endpoint
  // UNION collapsed same-(id, end ts) markers into one row).
  std::vector<int64_t> ends_at_current;

  int64_t group_id = 1;
  int64_t prev_ts = events.front().ts;

  auto emit_segment = [&](int64_t seg_ts, int64_t next_ts) {
    int64_t seg_dur = next_ts - seg_ts;
    for (uint32_t row : active_rows) {
      builder.PushNonNullUnchecked(0, seg_ts);
      builder.PushNonNullUnchecked(1, seg_dur);
      builder.PushNonNullUnchecked(2, group_id);
      builder.PushNonNullUnchecked(3, intervals.rows[row].id);
      builder.PushNonNullUnchecked(4, static_cast<int64_t>(0));
    }
    std::sort(ends_at_current.begin(), ends_at_current.end());
    ends_at_current.erase(
        std::unique(ends_at_current.begin(), ends_at_current.end()),
        ends_at_current.end());
    for (int64_t id : ends_at_current) {
      builder.PushNonNullUnchecked(0, seg_ts);
      builder.PushNonNullUnchecked(1, seg_dur);
      builder.PushNonNullUnchecked(2, group_id);
      builder.PushNonNullUnchecked(3, id);
      builder.PushNonNullUnchecked(4, static_cast<int64_t>(1));
    }
  };

  for (const auto& ev : events) {
    if (ev.ts > prev_ts) {
      emit_segment(prev_ts, ev.ts);
      ends_at_current.clear();
      ++group_id;
      prev_ts = ev.ts;
    }
    if (ev.delta > 0) {
      active_pos[ev.row] = static_cast<uint32_t>(active_rows.size());
      active_rows.push_back(ev.row);
    } else {
      // Swap-and-pop: overwrite the ending row's slot with the last active
      // row, fix that row's recorded position, and shrink. Iteration order of
      // active_rows is not meaningful (emit_segment treats it as a set), so
      // reordering is safe.
      uint32_t idx = active_pos[ev.row];
      PERFETTO_DCHECK(active_rows[idx] == ev.row);
      uint32_t moved = active_rows.back();
      active_rows[idx] = moved;
      active_pos[moved] = idx;
      active_rows.pop_back();
      ends_at_current.push_back(intervals.rows[ev.row].id);
    }
  }

  // Final segment at the last endpoint: dur=0, no active rows, end markers
  // for the intervals that closed at this ts.
  emit_segment(prev_ts, prev_ts);
}

// __intrinsic_isi_plain_intervals_agg(id, ts, dur)
//
// Collects one interval per input row for the drop-in self-intersect. Input
// does NOT need to be sorted (the sweep sorts events itself) and ids are
// payload, not keys — duplicates and any int64 value (including negatives)
// are legal.
struct IsiPlainIntervalsAgg
    : public sqlite::AggregateFunction<IsiPlainIntervalsAgg> {
  static constexpr char kName[] = "__intrinsic_isi_plain_intervals_agg";
  static constexpr int kArgCount = 3;

  struct AggCtx : sqlite::AggregateContext<AggCtx> {
    IsiPlainIntervals intervals;
  };

  static void Step(sqlite3_context* ctx, int argc, sqlite3_value** argv) {
    PERFETTO_DCHECK(argc == kArgCount);
    auto& agg_ctx = AggCtx::GetOrCreateContextForStep(ctx);

    int64_t id = sqlite::value::Int64(argv[0]);
    int64_t ts = sqlite::value::Int64(argv[1]);
    int64_t dur = sqlite::value::Int64(argv[2]);
    if (dur < 0) {
      return sqlite::result::Error(
          ctx, "interval_self_intersect: negative durations are not supported");
    }
    if (ts > std::numeric_limits<int64_t>::max() - dur) {
      return sqlite::result::Error(
          ctx, "interval_self_intersect: ts + dur overflows");
    }
    agg_ctx.intervals.rows.push_back(IsiPlainIntervals::Row{id, ts, ts + dur});
  }

  static void Final(sqlite3_context* ctx) {
    auto raw = AggCtx::GetContextOrNullForFinal(ctx);
    if (!raw) {
      return sqlite::result::Null(ctx);
    }
    return sqlite::result::UniquePointer(
        ctx,
        std::make_unique<IsiPlainIntervals>(std::move(raw.get()->intervals)),
        IsiPlainIntervals::kName);
  }
};

struct IntervalSelfIntersect : public sqlite::Function<IntervalSelfIntersect> {
  static constexpr char kName[] = "__intrinsic_interval_self_intersect";
  static constexpr int kArgCount = 1;

  struct UserData {
    StringPool* pool;
  };

  static void Step(sqlite3_context* ctx, int argc, sqlite3_value** argv) {
    PERFETTO_DCHECK(argc == kArgCount);

    std::vector<std::string> ret_col_names{"ts", "dur", "group_id", "id",
                                           "interval_ends_at_ts"};
    std::vector<ColType> col_types{ColType::kInt64, ColType::kInt64,
                                   ColType::kInt64, ColType::kInt64,
                                   ColType::kInt64};

    auto* intervals = sqlite::value::Pointer<IsiPlainIntervals>(
        argv[0], IsiPlainIntervals::kName);

    dataframe::AdhocDataframeBuilder builder(
        ret_col_names, GetUserData(ctx)->pool,
        dataframe::AdhocDataframeBuilder::Options{
            col_types, dataframe::NullabilityType::kDenseNull});

    if (intervals) {
      RunSelfIntersect(builder, *intervals);
    }

    SQLITE_ASSIGN_OR_RETURN(ctx, dataframe::Dataframe ret_tab,
                            std::move(builder).Build());
    return sqlite::result::UniquePointer(
        ctx, std::make_unique<dataframe::Dataframe>(std::move(ret_tab)),
        "TABLE");
  }
};

class IntervalSelfIntersectPlugin : public Plugin<IntervalSelfIntersectPlugin> {
 public:
  ~IntervalSelfIntersectPlugin() override;

  void RegisterFunctions(PerfettoSqlConnection*,
                         std::vector<FunctionRegistration>& out) override {
    StringPool* pool = trace_context_->storage->mutable_string_pool();
    out.push_back(MakeFunctionRegistration<IntervalSelfIntersect>(
        std::make_unique<IntervalSelfIntersect::UserData>(
            IntervalSelfIntersect::UserData{pool})));
  }

  void RegisterAggregateFunctions(
      PerfettoSqlConnection*,
      std::vector<AggregateFunctionRegistration>& out) override {
    // The collector needs no user data — it only stashes id/ts/dur.
    out.push_back(MakeAggregateRegistration<IsiPlainIntervalsAgg>(nullptr));
  }
};

IntervalSelfIntersectPlugin::~IntervalSelfIntersectPlugin() = default;

}  // namespace

void RegisterPlugin() {
  static PluginRegistration reg(
      []() -> std::unique_ptr<PluginBase> {
        return std::make_unique<IntervalSelfIntersectPlugin>();
      },
      IntervalSelfIntersectPlugin::kPluginId,
      IntervalSelfIntersectPlugin::kDepIds.data(),
      IntervalSelfIntersectPlugin::kDepIds.size());
  base::ignore_result(reg);
}

}  // namespace perfetto::trace_processor::interval_self_intersect
