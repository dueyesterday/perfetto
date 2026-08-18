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

import {type time, Time} from '../../base/time';
import type {Trace} from '../../public/trace';

// Finds the URI of the workspace track rendering a given trace_processor track
// id, by searching the workspace's track tags.
//
// Note a single workspace track can render several trace_processor tracks (the
// UI merges sibling async tracks), so the id can't be turned into a URI by
// string construction - the tags have to be searched.
export function findTrackUriByTrackId(
  trace: Trace,
  trackId: number,
): string | undefined {
  const node = trace.currentWorkspace.flatTracks.find((track) => {
    if (!track.uri) return false;
    const desc = trace.tracks.getTrack(track.uri);
    return desc?.tags?.trackIds?.includes(trackId);
  });
  return node?.uri;
}

// Scrolls to a track at a specific time region and selects the area on
// the given tracks.
export function scrollToTrackAndSelect(
  trace: Trace,
  trackToScroll: string,
  tracksToSelect: string[],
  startTime: time,
  dur: bigint,
): void {
  const endTime = Time.fromRaw(startTime + dur);

  trace.scrollTo({
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

  trace.selection.selectArea(
    {
      start: startTime,
      end: endTime,
      trackUris: tracksToSelect,
    },
    {
      switchToCurrentSelectionTab: true,
    },
  );
}
