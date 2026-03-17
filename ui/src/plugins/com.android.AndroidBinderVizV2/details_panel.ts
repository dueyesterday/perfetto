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
import {asSliceSqlId, SliceSqlId} from '../../components/sql_utils/core_types';
import {getSlice, SliceDetails} from '../../components/sql_utils/slice';
import {renderDetails} from '../../components/details/slice_details';
import {Engine} from '../../trace_processor/engine';
import {NUM_NULL, STR_NULL} from '../../trace_processor/query_result';
import {Tree, TreeNode} from '../../widgets/tree';
import {DetailsShell} from '../../widgets/details_shell';
import {Section} from '../../widgets/section';
import {TrackEventRef} from '../../components/widgets/track_event_ref';

interface BinderTxnDetails {
  txnRole: string;
  interfaceName?: string;
  methodName?: string;
  aidlName?: string;
  counterpartId?: number;
  counterpartProcess?: string;
  counterpartThread?: string;
}

async function getBinderTxnDetails(
  engine: Engine,
  id: SliceSqlId,
): Promise<BinderTxnDetails | undefined> {
  const queryResult = await engine.query(`
    SELECT
      CASE
        WHEN binder_txn_id = ${id} THEN 'Client'
        WHEN binder_reply_id = ${id} THEN 'Server'
        ELSE ''
      END AS txnRole,
      interface AS interfaceName,
      method_name AS methodName,
      aidl_name AS aidlName,
      CASE
        WHEN binder_txn_id = ${id} THEN binder_reply_id
        ELSE binder_txn_id
      END AS counterpartId,
      CASE
        WHEN binder_txn_id = ${id} THEN server_process
        ELSE client_process
      END AS counterpartProcess,
      CASE
        WHEN binder_txn_id = ${id} THEN server_thread
        ELSE client_thread
      END AS counterpartThread
    FROM android_binder_txns
    WHERE binder_txn_id = ${id} OR binder_reply_id = ${id}
  `);

  const it = queryResult.iter({
    txnRole: STR_NULL,
    interfaceName: STR_NULL,
    methodName: STR_NULL,
    aidlName: STR_NULL,
    counterpartId: NUM_NULL,
    counterpartProcess: STR_NULL,
    counterpartThread: STR_NULL,
  });

  if (!it.valid()) return undefined;

  return {
    txnRole: it.txnRole || 'Unknown',
    interfaceName: it.interfaceName ?? undefined,
    methodName: it.methodName ?? undefined,
    aidlName: it.aidlName ?? undefined,
    counterpartId: it.counterpartId ?? undefined,
    counterpartProcess: it.counterpartProcess ?? undefined,
    counterpartThread: it.counterpartThread ?? undefined,
  };
}

export class BinderSliceDetailsPanel implements TrackEventDetailsPanel {
  private sliceDetails: SliceDetails | undefined;
  private binderTxnDetails: BinderTxnDetails | undefined;
  private isLoading = true;

  constructor(private readonly trace: Trace) {}

  async load(selection: TrackEventSelection): Promise<void> {
    const sliceId = asSliceSqlId(selection.eventId);
    this.isLoading = true;
    this.sliceDetails = await getSlice(this.trace.engine, sliceId);
    this.binderTxnDetails = await getBinderTxnDetails(
      this.trace.engine,
      sliceId,
    );
    this.isLoading = false;
  }

  render() {
    if (this.isLoading) {
      return m(DetailsShell, {
        title: 'Binder Transaction',
        description: 'Loading...',
      });
    }

    if (!this.sliceDetails) {
      return m(DetailsShell, {
        title: 'Binder Transaction',
        description: 'Slice not found',
      });
    }

    const txnRole = this.binderTxnDetails?.txnRole ?? 'Binder';
    const name = this.sliceDetails.name ?? 'Transaction';
    const counterpartRole = txnRole === 'Client' ? 'Server' : 'Client';

    return m(
      DetailsShell,
      {title: `${txnRole} ${name}`},
      this.binderTxnDetails &&
        m(
          Section,
          {title: 'Binder'},
          m(
            Tree,
            m(TreeNode, {
              left: 'Interface',
              right: this.binderTxnDetails.interfaceName,
            }),
            m(TreeNode, {
              left: 'Method',
              right: this.binderTxnDetails.methodName,
            }),
            this.binderTxnDetails.aidlName &&
              m(TreeNode, {
                left: 'AIDL',
                right: this.binderTxnDetails.aidlName,
              }),
            this.binderTxnDetails.counterpartId !== undefined &&
              m(TreeNode, {
                left: `${counterpartRole} slice`,
                right: m(TrackEventRef, {
                  trace: this.trace,
                  table: 'slice',
                  id: this.binderTxnDetails.counterpartId,
                  name: `Go to ${counterpartRole}`,
                }),
              }),
            this.binderTxnDetails.counterpartProcess &&
              m(TreeNode, {
                left: `${counterpartRole} process`,
                right: this.binderTxnDetails.counterpartProcess,
              }),
            this.binderTxnDetails.counterpartThread &&
              m(TreeNode, {
                left: `${counterpartRole} thread`,
                right: this.binderTxnDetails.counterpartThread,
              }),
          ),
        ),
      renderDetails(this.trace, this.sliceDetails),
    );
  }
}
