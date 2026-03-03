// Copyright (C) 2025 The Android Open Source Project
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
import {PerfettoPlugin} from '../../public/plugin';
import {Trace} from '../../public/trace';
import SqlModulesPlugin from '../dev.perfetto.SqlModules';
import {QueryBuilderPage} from './query_builder_page';

export default class implements PerfettoPlugin {
  static readonly id = 'dev.perfetto.NodeQueryBuilder';
  static readonly dependencies = [SqlModulesPlugin];

  async onTraceLoad(trace: Trace): Promise<void> {
    const sqlModulesPlugin = trace.plugins.getPlugin(SqlModulesPlugin);

    trace.pages.registerPage({
      route: '/querybuilder',
      render: () => {
        sqlModulesPlugin.ensureInitialized();
        return m(QueryBuilderPage, {
          trace,
          sqlModules: sqlModulesPlugin.getSqlModules(),
        });
      },
    });

    trace.sidebar.addMenuItem({
      section: 'current_trace',
      text: 'Node Query Builder',
      href: '#!/querybuilder',
      icon: 'account_tree',
      sortOrder: 22,
    });
  }
}
