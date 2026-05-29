#!/usr/bin/env python3
# Copyright (C) 2026 The Android Open Source Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from python.generators.diff_tests.testing import Csv, TextProto
from python.generators.diff_tests.testing import DiffTestBlueprint
from python.generators.diff_tests.testing import TestSuite


class IntervalsSelfIntersect(TestSuite):

  # Mirrors test_intersect_list in intervals/tests.py: same input, same
  # expected output. Confirms the C++ _interval_self_intersect in
  # intervals.self_intersect is a drop-in for the SQL stdlib's
  # intervals.intersect.interval_self_intersect.
  def test_self_intersect_list(self):
    return DiffTestBlueprint(
        trace=TextProto(""),
        query="""
        INCLUDE PERFETTO MODULE intervals.self_intersect;

        WITH
          data(ts, dur, id) AS (
            VALUES
              (10, 100, 0),
              (20, 40, 1),
              (30, 120, 2),
              (200, 10, 3),
              (200, 20, 4),
              (300, 10, 5)
          )
        SELECT *
        FROM _interval_self_intersect!(data)
        ORDER BY ts ASC, id ASC;
        """,
        out=Csv("""
        "ts","dur","group_id","id","interval_ends_at_ts"
        10,10,1,0,0
        20,10,2,0,0
        20,10,2,1,0
        30,30,3,0,0
        30,30,3,1,0
        30,30,3,2,0
        60,50,4,0,0
        60,50,4,1,1
        60,50,4,2,0
        110,40,5,0,1
        110,40,5,2,0
        150,50,6,2,1
        200,10,7,3,0
        200,10,7,4,0
        210,10,8,3,1
        210,10,8,4,0
        220,80,9,4,1
        300,10,10,5,0
        310,0,11,5,1
        """))

  # Adjacent intervals: end of one coincides with start of the next.
  # Active set should not include the ending interval in segments at/after
  # its end ts; the end marker fires at the segment beginning at the end ts.
  def test_adjacent_intervals(self):
    return DiffTestBlueprint(
        trace=TextProto(""),
        query="""
        INCLUDE PERFETTO MODULE intervals.self_intersect;

        WITH
          data(ts, dur, id) AS (
            VALUES
              (0, 10, 0),
              (10, 10, 1)
          )
        SELECT *
        FROM _interval_self_intersect!(data)
        ORDER BY ts ASC, id ASC;
        """,
        out=Csv("""
        "ts","dur","group_id","id","interval_ends_at_ts"
        0,10,1,0,0
        10,10,2,0,1
        10,10,2,1,0
        20,0,3,1,1
        """))

  # Empty input table: zero rows out, no error.
  def test_empty_input(self):
    return DiffTestBlueprint(
        trace=TextProto(""),
        query="""
        INCLUDE PERFETTO MODULE intervals.self_intersect;

        WITH data(ts, dur, id) AS (SELECT 0, 0, 0 WHERE FALSE)
        SELECT * FROM _interval_self_intersect!(data);
        """,
        out=Csv("""
        "ts","dur","group_id","id","interval_ends_at_ts"
        """))

  # Duplicate ids behave as independent intervals (the active set is keyed
  # by input row, not id): staggered same-id intervals keep full coverage,
  # exact-duplicate rows emit one active row each, and end markers dedupe
  # per (id, end ts) — all matching the old SQL macro's output verbatim.
  def test_duplicate_ids(self):
    return DiffTestBlueprint(
        trace=TextProto(""),
        query="""
        INCLUDE PERFETTO MODULE intervals.self_intersect;

        WITH data(id, ts, dur) AS (
          VALUES (7, 0, 10), (7, 5, 10), (9, 20, 5), (9, 20, 5)
        )
        SELECT ts, dur, group_id, id, interval_ends_at_ts
        FROM _interval_self_intersect!(data)
        ORDER BY ts, interval_ends_at_ts, id;
        """,
        out=Csv("""
        "ts","dur","group_id","id","interval_ends_at_ts"
        0,5,1,7,0
        5,5,2,7,0
        5,5,2,7,0
        10,5,3,7,0
        10,5,3,7,1
        15,5,4,7,1
        20,5,5,9,0
        20,5,5,9,0
        25,0,6,9,1
        """))

  # Ids are opaque int64 payload: values past uint32 range and negative
  # values round-trip unchanged in both active rows and end markers, and
  # ids that would collide mod 2^32 stay distinct. (Deliberate deviation
  # from the old macro, which truncated ACTIVE-row ids to uint32 while end
  # markers carried the raw value.)
  def test_int64_id_domain(self):
    return DiffTestBlueprint(
        trace=TextProto(""),
        query="""
        INCLUDE PERFETTO MODULE intervals.self_intersect;

        WITH data(id, ts, dur) AS (
          VALUES (1, 0, 10), (4294967297, 2, 10), (-1, 5, 2)
        )
        SELECT ts, dur, group_id, id, interval_ends_at_ts
        FROM _interval_self_intersect!(data)
        ORDER BY ts, interval_ends_at_ts, id;
        """,
        out=Csv("""
        "ts","dur","group_id","id","interval_ends_at_ts"
        0,2,1,1,0
        2,3,2,1,0
        2,3,2,4294967297,0
        5,2,3,-1,0
        5,2,3,1,0
        5,2,3,4294967297,0
        7,3,4,1,0
        7,3,4,4294967297,0
        7,3,4,-1,1
        10,2,5,4294967297,0
        10,2,5,1,1
        12,0,6,4294967297,1
        """))
