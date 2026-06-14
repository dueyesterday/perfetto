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

// Saved trace cohorts UI: save the active query's trace selection (filters +
// order) under a name, then re-apply it to any query — so a curated fleet
// subset becomes reusable across tabs.

import m from 'mithril';
import {Button} from '../../widgets/button';
import {Icon} from '../../widgets/icon';
import {TextInput} from '../../widgets/text_input';
import {Popup, PopupPosition} from '../../widgets/popup';
import {showModal} from '../../widgets/modal';
import {traceSetStore, type TraceSet} from '../settings/trace_set_store';
import type {SettingsBindings} from '../settings/tab_bound_setting';

interface TraceSetPickerAttrs {
  readonly bindings: SettingsBindings;
}

export class TraceSetPicker implements m.ClassComponent<TraceSetPickerAttrs> {
  view({attrs: {bindings}}: m.Vnode<TraceSetPickerAttrs>): m.Children {
    const sets = traceSetStore.list();
    return m(
      Popup,
      {
        position: PopupPosition.Bottom,
        trigger: m(Button, {
          icon: 'bookmarks',
          label: sets.length > 0 ? `Cohorts (${sets.length})` : 'Cohorts',
        }),
      },
      m('.pf-bt-cohorts', [
        m(
          'button.pf-bt-cohorts__save',
          {onclick: () => this.saveCurrent(bindings)},
          m(Icon, {icon: 'bookmark_add'}),
          'Save current scope…',
        ),
        sets.length > 0 && m('.pf-bt-cohorts__divider'),
        sets.length === 0
          ? m('.pf-bt-cohorts__empty', 'No saved cohorts yet.')
          : sets.map((s) =>
              m('.pf-bt-cohorts__item', {key: s.id}, [
                m(
                  'button.pf-bt-cohorts__apply',
                  {
                    title: 'Apply this cohort to the active query',
                    onclick: () => this.apply(bindings, s),
                  },
                  m(Icon, {
                    className: 'pf-bt-cohorts__icon',
                    icon: 'workspaces',
                  }),
                  m('span.pf-bt-cohorts__name', s.name),
                  m(
                    'span.pf-bt-cohorts__meta',
                    `${s.filters.length} filter${s.filters.length === 1 ? '' : 's'}`,
                  ),
                ),
                m(Button, {
                  icon: 'delete',
                  className: 'pf-bt-cohorts__del',
                  title: 'Delete cohort',
                  onclick: () => traceSetStore.remove(s.id),
                }),
              ]),
            ),
      ]),
    );
  }

  private apply(bindings: SettingsBindings, set: TraceSet): void {
    bindings.setTraceFilters([...set.filters]);
    bindings.setTraceOrderBy(set.orderBy);
  }

  private saveCurrent(bindings: SettingsBindings): void {
    let name = '';
    void showModal({
      title: 'Save trace cohort',
      content: () =>
        m('.pf-bt-cohort-save', [
          m(
            'p',
            'Name this trace selection so you can re-apply it to other queries.',
          ),
          m(TextInput, {
            placeholder: 'e.g. Pixel 8 cold starts',
            autofocus: true,
            onInput: (v: string) => {
              name = v;
            },
          }),
        ]),
      buttons: [
        {text: 'Cancel'},
        {
          text: 'Save',
          primary: true,
          action: () => {
            const n = name.trim();
            if (n === '') return;
            traceSetStore.add({
              id: `ts-${Date.now()}`,
              name: n,
              filters: [...bindings.getTraceFilters()],
              orderBy: bindings.getTraceOrderBy(),
              createdMs: Date.now(),
            });
          },
        },
      ],
    });
  }
}
