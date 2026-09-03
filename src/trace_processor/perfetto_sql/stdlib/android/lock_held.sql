--
-- Copyright 2026 The Android Open Source Project
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     https://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.
--

INCLUDE PERFETTO MODULE intervals.overlap;

INCLUDE PERFETTO MODULE slices.with_context;

-- The individual `<lock>_lock_held` slices a trace contains, with the suffix
-- removed from the lock name.
--
-- These slices are emitted by app code instrumenting its own locks, not by the
-- platform, so they are only present if the app under test opted in. The
-- suffix is stripped with the same `replace` that `android.monitor_contention`
-- uses when it recovers a lock name, so that the two agree.
--
-- Slices with a non-positive duration are dropped. In particular a lock which
-- is acquired but never released before the trace ends arrives as an
-- incomplete slice (`dur = -1`) and is not represented here.
CREATE PERFETTO TABLE _android_lock_held_slices AS
SELECT
  id,
  ts,
  dur,
  replace(name, '_lock_held', '') AS lock_name,
  utid,
  tid,
  thread_name,
  upid,
  pid,
  process_name
FROM thread_slice
WHERE
  dur > 0
  AND name GLOB '*_lock_held';

-- Intervals during which a named lock was held by a thread.
--
-- Holds of the same lock which overlap on the same thread - a lock taken
-- recursively - are merged into a single row. `dur` therefore runs from the
-- outermost acquire to the outermost release, and a recursively taken lock
-- contributes its held time once rather than once per acquire.
--
-- `dur` is the duration for which the lock was actually held. It is not
-- truncated at the point another thread takes the same lock; a consumer which
-- wants a non-overlapping per-lock timeline is expected to do that itself.
--
-- Locks acquired but never released before the end of the trace are not
-- included, as they have no observed duration. See
-- `_android_lock_held_slices`.
CREATE PERFETTO TABLE android_lock_held(
  -- Slice id of the `_lock_held` slice which starts this hold.
  id JOINID(slice.id),
  -- Timestamp at which the lock was acquired.
  ts TIMESTAMP,
  -- Duration for which the lock was held.
  dur DURATION,
  -- Name of the lock, with the `_lock_held` suffix removed. Joins against
  -- `android_monitor_contention.lock_name`.
  lock_name STRING,
  -- Thread holding the lock.
  utid JOINID(thread.id),
  -- Tid of the thread holding the lock.
  tid LONG,
  -- Name of the thread holding the lock.
  thread_name STRING,
  -- Process containing the thread holding the lock.
  upid JOINID(process.id),
  -- Pid of the process containing the thread holding the lock.
  pid LONG,
  -- Name of the process containing the thread holding the lock.
  process_name STRING
)
AS
WITH
  merged AS (
    SELECT ts, dur, lock_name, utid
    FROM interval_merge_overlapping_partitioned!((
        SELECT ts, dur, lock_name, utid FROM _android_lock_held_slices
      ), (lock_name, utid))
  )
SELECT
  held.id,
  merged.ts,
  merged.dur,
  merged.lock_name,
  merged.utid,
  held.tid,
  held.thread_name,
  held.upid,
  held.pid,
  held.process_name
FROM merged
-- The merge macro returns only (ts, dur, partition columns), so the slice which
-- starts each hold has to be recovered. The merged interval's ts is the min ts
-- of the slices it covers, hence the equality on ts.
JOIN _android_lock_held_slices AS held
  ON held.lock_name = merged.lock_name
  AND held.utid = merged.utid
  AND held.ts = merged.ts;
