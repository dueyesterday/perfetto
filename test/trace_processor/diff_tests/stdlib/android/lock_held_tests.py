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

# `<lock>_lock_held` slices are emitted by app code via atrace, so every trace
# here is built from ftrace print events on named threads.
PROCESS_TREE = r"""
packet {
  process_tree {
    processes {
      pid: 1000
      cmdline: "com.example.app"
    }
    threads {
      tid: 1001
      tgid: 1000
      name: "main-thread"
    }
    threads {
      tid: 1002
      tgid: 1000
      name: "worker-thread"
    }
  }
}
"""


class AndroidLockHeld(TestSuite):

  def test_android_lock_held(self):
    return DiffTestBlueprint(
        trace=TextProto(PROCESS_TREE + r"""
        packet { ftrace_events {
          cpu: 0
          event {
            timestamp: 1000
            pid: 1001
            print { buf: "B|1000|mLockA_lock_held\n" }
          }
          event {
            timestamp: 1500
            pid: 1001
            print { buf: "E|1000\n" }
          }
          event {
            timestamp: 2000
            pid: 1002
            print { buf: "B|1000|mLockB_lock_held\n" }
          }
          event {
            timestamp: 2600
            pid: 1002
            print { buf: "E|1000\n" }
          }
        }}
        """),
        query="""
        INCLUDE PERFETTO MODULE android.lock_held;

        SELECT
          h.lock_name,
          h.ts,
          h.dur,
          h.tid,
          h.thread_name,
          h.pid,
          h.process_name,
          s.name AS held_slice_name
        FROM android_lock_held AS h
        JOIN slice AS s
          ON s.id = h.id
        ORDER BY h.ts;
        """,
        out=Csv("""
        "lock_name","ts","dur","tid","thread_name","pid","process_name","held_slice_name"
        "mLockA",1000,500,1001,"main-thread",1000,"com.example.app","mLockA_lock_held"
        "mLockB",2000,600,1002,"worker-thread",1000,"com.example.app","mLockB_lock_held"
        """))

  # A lock taken recursively nests, so the two holds overlap and collapse into
  # one row spanning the outermost acquire to the outermost release. `id` must
  # resolve to the outer slice, not the inner one.
  def test_android_lock_held_merges_recursive_holds(self):
    return DiffTestBlueprint(
        trace=TextProto(PROCESS_TREE + r"""
        packet { ftrace_events {
          cpu: 0
          event {
            timestamp: 1000
            pid: 1001
            print { buf: "B|1000|mLockC_lock_held\n" }
          }
          event {
            timestamp: 1200
            pid: 1001
            print { buf: "B|1000|mLockC_lock_held\n" }
          }
          event {
            timestamp: 1400
            pid: 1001
            print { buf: "E|1000\n" }
          }
          event {
            timestamp: 1600
            pid: 1001
            print { buf: "E|1000\n" }
          }
        }}
        """),
        query="""
        INCLUDE PERFETTO MODULE android.lock_held;

        SELECT
          (SELECT count(*) FROM slice WHERE name GLOB '*_lock_held')
            AS source_slices,
          h.lock_name,
          h.ts,
          h.dur,
          s.ts AS held_slice_ts,
          s.dur AS held_slice_dur
        FROM android_lock_held AS h
        JOIN slice AS s
          ON s.id = h.id
        ORDER BY h.ts;
        """,
        out=Csv("""
        "source_slices","lock_name","ts","dur","held_slice_ts","held_slice_dur"
        2,"mLockC",1000,600,1000,600
        """))

  # Two threads reporting the same lock held at overlapping times are separate
  # rows: `dur` is how long each thread held the lock, never truncated at the
  # point the other thread takes it. A consumer wanting a non-overlapping
  # per-lock timeline does that truncation itself.
  def test_android_lock_held_does_not_truncate_across_threads(self):
    return DiffTestBlueprint(
        trace=TextProto(PROCESS_TREE + r"""
        packet { ftrace_events {
          cpu: 0
          event {
            timestamp: 1000
            pid: 1001
            print { buf: "B|1000|mLockD_lock_held\n" }
          }
          event {
            timestamp: 2000
            pid: 1002
            print { buf: "B|1000|mLockD_lock_held\n" }
          }
          event {
            timestamp: 2500
            pid: 1001
            print { buf: "E|1000\n" }
          }
          event {
            timestamp: 3000
            pid: 1002
            print { buf: "E|1000\n" }
          }
        }}
        """),
        query="""
        INCLUDE PERFETTO MODULE android.lock_held;

        SELECT lock_name, ts, dur, tid
        FROM android_lock_held
        ORDER BY ts;
        """,
        out=Csv("""
        "lock_name","ts","dur","tid"
        "mLockD",1000,1500,1001
        "mLockD",2000,1000,1002
        """))

  # A lock acquired but never released before the trace ends arrives as an
  # incomplete slice and has no observed duration, so it is excluded.
  def test_android_lock_held_excludes_unreleased(self):
    return DiffTestBlueprint(
        trace=TextProto(PROCESS_TREE + r"""
        packet { ftrace_events {
          cpu: 0
          event {
            timestamp: 1000
            pid: 1001
            print { buf: "B|1000|mLockA_lock_held\n" }
          }
          event {
            timestamp: 1500
            pid: 1001
            print { buf: "E|1000\n" }
          }
          event {
            timestamp: 2000
            pid: 1002
            print { buf: "B|1000|mLockF_lock_held\n" }
          }
        }}
        """),
        query="""
        INCLUDE PERFETTO MODULE android.lock_held;

        SELECT
          (SELECT count(*) FROM slice
           WHERE name = 'mLockF_lock_held' AND dur = -1) AS unreleased_slices,
          (SELECT count(*) FROM android_lock_held
           WHERE lock_name = 'mLockF') AS unreleased_rows,
          (SELECT count(*) FROM android_lock_held) AS total_rows;
        """,
        out=Csv("""
        "unreleased_slices","unreleased_rows","total_rows"
        1,0,1
        """))
