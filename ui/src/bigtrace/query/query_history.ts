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
import {Button} from '../../widgets/button';
import {Spinner} from '../../widgets/spinner';
import {EmptyState} from '../../widgets/empty_state';
import {TextInput} from '../../widgets/text_input';
import {historyStore} from './history_store';
import {renderRunCard, type OpenQueryFn} from './query_history_item';

interface QueryHistoryComponentAttrs {
  readonly className?: string;
  openQuery: OpenQueryFn;
  readonly refreshSignal?: number;
}

export {setHistoryActiveTab} from './history_store';

export class QueryHistoryComponent
  implements m.ClassComponent<QueryHistoryComponentAttrs>
{
  private search = '';

  oninit(vnode: m.CVnode<QueryHistoryComponentAttrs>) {
    historyStore.requestRefresh(vnode.attrs.refreshSignal ?? 0);
  }

  onbeforeupdate(vnode: m.CVnode<QueryHistoryComponentAttrs>) {
    historyStore.requestRefresh(vnode.attrs.refreshSignal ?? 0);
    return true;
  }

  view({attrs}: m.CVnode<QueryHistoryComponentAttrs>) {
    const {openQuery, ...rest} = attrs;

    if (historyStore.isLoading && historyStore.history.length === 0) {
      return m(
        EmptyState,
        {title: 'Loading runs…', icon: 'hourglass_empty', fillHeight: true},
        m(Spinner),
      );
    }

    if (historyStore.error) {
      return m(EmptyState, {
        title: `Failed to load history: ${historyStore.error}`,
        icon: 'error',
        fillHeight: true,
      });
    }

    // One unified, newest-first run list (no Ephemeral/Persistent tab split —
    // each card carries a quick/saved tag). Full-text filter over the SQL.
    const all = historyStore.history;
    const q = this.search.trim().toLowerCase();
    const filtered = q
      ? all.filter((h) => (h.perfettoSql || '').toLowerCase().includes(q))
      : all;

    return m('.pf-bt-runs', rest, [
      m('.pf-bt-runs__toolbar', [
        m(TextInput, {
          className: 'pf-bt-runs__search',
          leftIcon: 'search',
          placeholder: 'Search runs…',
          value: this.search,
          onInput: (v: string) => {
            this.search = v;
          },
        }),
        m(Button, {
          icon: 'refresh',
          title: 'Refresh runs',
          onclick: () => historyStore.refreshNow(),
        }),
      ]),
      filtered.length === 0
        ? m(
            EmptyState,
            {
              title: all.length === 0 ? 'No runs yet' : 'No matching runs',
              icon: 'search',
              fillHeight: true,
            },
            all.length === 0 &&
              m(
                'div.pf-bt-history-empty-hint',
                'Run a query to see it here.',
              ),
          )
        : m(
            '.pf-bt-runs__list',
            filtered.map((entry) => renderRunCard(entry, openQuery)),
          ),
    ]);
  }
}
