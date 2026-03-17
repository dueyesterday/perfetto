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

import m from 'mithril';
import {TrackEventDetailsPanel} from '../../public/details_panel';
import {TrackEventSelection} from '../../public/selection';
import {Trace} from '../../public/trace';
import {DetailsShell} from '../../widgets/details_shell';
import {Section} from '../../widgets/section';
import {Tree, TreeNode} from '../../widgets/tree';
import {Button} from '../../widgets/button';
import {Timestamp} from '../../components/widgets/timestamp';
import {DurationWidget} from '../../components/widgets/duration';
import {exists} from '../../base/utils';
import {Time} from '../../base/time';
import {NUM_NULL} from '../../trace_processor/query_result';
import ProcessThreadGroupsPlugin from '../dev.perfetto.ProcessThreadGroups';

interface AnrInfo {
  processName: string;
  pid: number | null;
  upid: number | null;
  anrType: string;
  subject: string | null;
  mainThreadTrackId: number | null;
}

export class AnrDetailsPanel implements TrackEventDetailsPanel {
  private anr?: AnrInfo;
  private selection?: TrackEventSelection;
  private isLoading = true;

  constructor(private readonly trace: Trace) {}

  async load(sel: TrackEventSelection): Promise<void> {
    this.isLoading = true;
    this.selection = sel;

    // The selection object is enriched with dataset columns by
    // getSelectionDetails(). Extract the ANR-specific fields.
    const extra = sel as unknown as {
      process_name: string;
      pid: number | null;
      upid: number | null;
      anr_type: string;
      subject: string | null;
    };

    // Query for the main thread track ID so we can navigate like the deeplink.
    let mainThreadTrackId: number | null = null;
    if (extra.upid != null) {
      const result = await this.trace.engine.query(`
        SELECT tt.id AS main_thread_track_id
        FROM thread t
        JOIN thread_track tt ON t.utid = tt.utid
        WHERE t.upid = ${extra.upid} AND t.is_main_thread = 1
        LIMIT 1
      `);
      const it = result.iter({main_thread_track_id: NUM_NULL});
      if (it.valid()) {
        mainThreadTrackId = it.main_thread_track_id;
      }
    }

    this.anr = {
      processName: extra.process_name,
      pid: extra.pid,
      upid: extra.upid,
      anrType: extra.anr_type,
      subject: extra.subject,
      mainThreadTrackId,
    };

    this.isLoading = false;
  }

  render(): m.Children {
    if (this.isLoading || !this.anr || !this.selection) {
      return m(DetailsShell, {
        title: 'Android ANR',
        description: 'Loading...',
      });
    }

    const {processName, pid, anrType, subject, upid} = this.anr;
    const sel = this.selection;

    return m(
      DetailsShell,
      {title: 'Android ANR'},
      m(
        Section,
        {title: 'Details'},
        m(
          Tree,
          m(TreeNode, {
            left: 'Process',
            right: pid != null ? `${processName} (${pid})` : processName,
          }),
          m(TreeNode, {left: 'ANR Type', right: anrType}),
          exists(subject) &&
            m(TreeNode, {left: 'Subject', right: subject}),
          m(TreeNode, {
            left: 'Start time',
            right: m(Timestamp, {trace: this.trace, ts: sel.ts}),
          }),
          exists(sel.dur) &&
            sel.dur > 0n &&
            m(TreeNode, {
              left: 'Duration',
              right: m(DurationWidget, {trace: this.trace, dur: sel.dur}),
            }),
        ),
      ),
      upid != null &&
        m(
          Section,
          {title: 'Actions'},
          m(Button, {
            label: 'Go to process',
            icon: 'call_made',
            onclick: () => this.goToProcess(),
          }),
        ),
    );
  }

  private goToProcess() {
    if (this.anr?.upid == null || !this.selection) return;

    const processGroups = this.trace.plugins.getPlugin(
      ProcessThreadGroupsPlugin,
    ) as ProcessThreadGroupsPlugin;

    const group = processGroups.getGroupForProcess(this.anr.upid);
    if (!group?.uri) return;

    group.expand();

    // Find the main thread track node by its track ID via the track tags.
    let mainThreadTrackUri: string | undefined;
    if (this.anr.mainThreadTrackId != null) {
      const mainThreadTrackNode =
        this.trace.currentWorkspace.flatTracks.find((track) => {
          if (!track.uri) return false;
          const trackDesc = this.trace.tracks.getTrack(track.uri);
          return trackDesc?.tags?.trackIds?.includes(
            this.anr!.mainThreadTrackId!,
          );
        });
      mainThreadTrackUri = mainThreadTrackNode?.uri;
    }

    const trackToScroll = mainThreadTrackUri ?? group.uri;
    const sel = this.selection;
    const dur = sel.dur ?? 0n;
    const startTime = Time.fromRaw(sel.ts);
    const endTime = Time.fromRaw(sel.ts + dur);

    // Scroll to the time region and the process/main thread track.
    this.trace.scrollTo({
      track: {
        uri: trackToScroll,
        expandGroup: true,
      },
      time:
        dur > 0n
          ? {
              start: startTime,
              end: endTime,
              behavior: {viewPercentage: 0.8},
            }
          : {
              start: startTime,
              behavior: 'focus',
            },
    });

    // Select the area on the main thread track (if found).
    if (mainThreadTrackUri) {
      this.trace.selection.selectArea(
        {
          start: startTime,
          end: endTime,
          trackUris: [mainThreadTrackUri],
        },
        {
          switchToCurrentSelectionTab: true,
        },
      );
    }
  }
}
