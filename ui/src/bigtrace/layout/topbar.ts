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

import '../../frontend/topbar.scss';
import m from 'mithril';
import {classNames} from '../../base/classnames';
import {Omnibox} from './omnibox';
import {getBigtraceEndpoint} from '../settings/endpoint_storage';
import {openBigtraceSettings} from '../pages/workspace_tree';

interface TopbarAttrs {
  sidebarVisible: boolean;
}

type ConnState = 'checking' | 'connected' | 'error';

// Live backend connection indicator. Replaces the previous "no connection
// status anywhere in the chrome" gap: pings the configured endpoint once and
// shows reachability + the host, and links to the connection settings.
class ConnectionStatus implements m.ClassComponent {
  private state: ConnState = 'checking';
  private host = '';

  oninit() {
    const ep = getBigtraceEndpoint();
    this.host = shortHost(ep);
    if (!ep) {
      this.state = 'error';
      return;
    }
    fetch(`${ep}/bigtrace_execution_config`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: '{}',
      credentials: 'include',
      mode: 'cors',
    })
      .then((r) => {
        this.state = r.ok ? 'connected' : 'error';
        m.redraw();
      })
      .catch(() => {
        this.state = 'error';
        m.redraw();
      });
  }

  view() {
    const label =
      this.state === 'checking'
        ? 'Connecting…'
        : this.state === 'error'
          ? this.host || 'No backend'
          : this.host;
    return m(
      'button.pf-bt-conn',
      {
        className: `pf-bt-conn--${this.state}`,
        title: `BigTrace backend: ${getBigtraceEndpoint() || 'not set'} — click to change`,
        onclick: () => openBigtraceSettings?.(),
      },
      m('span.pf-bt-conn__dot'),
      m('span.pf-bt-conn__label', label),
    );
  }
}

function shortHost(ep: string): string {
  if (!ep) return '';
  try {
    return new URL(ep).host;
  } catch {
    return ep;
  }
}

export class Topbar implements m.ClassComponent<TopbarAttrs> {
  view({attrs}: m.CVnode<TopbarAttrs>) {
    return m(
      '.pf-topbar',
      {
        className: classNames(
          !attrs.sidebarVisible && 'pf-topbar--hide-sidebar',
        ),
      },
      m(Omnibox),
      m('.pf-topbar__right', m(ConnectionStatus)),
    );
  }
}
