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
import protos from '../../protos';
import {exists} from '../../base/utils';
import {uuidv4} from '../../base/uuid';
import {NUM, STR} from '../../trace_processor/query_result';
import {WasmEngineProxy} from '../../trace_processor/wasm_engine_proxy';
import {AdbKeyManager} from '../dev.perfetto.RecordTraceV2/adb/webusb/adb_key_manager';
import {AdbWebusbDevice} from '../dev.perfetto.RecordTraceV2/adb/webusb/adb_webusb_device';
import {
  ADB_DEVICE_FILTER,
  getAdbWebUsbInterface,
} from '../dev.perfetto.RecordTraceV2/adb/webusb/adb_webusb_utils';
import {AdbDevice} from '../dev.perfetto.RecordTraceV2/adb/adb_device';
import {AdbWebsocketDevice} from '../dev.perfetto.RecordTraceV2/adb/websocket/adb_websocket_device';
import {adbCmdAndWait} from '../dev.perfetto.RecordTraceV2/adb/websocket/adb_websocket_utils';
import {AsyncWebsocket} from '../dev.perfetto.RecordTraceV2/websocket/async_websocket';
import {
  WDP_TRACK_DEVICES_SCHEMA,
  type WdpDevice,
} from '../dev.perfetto.RecordTraceV2/adb/web_device_proxy/wdp_schema';
import {showPopupWindow} from '../../base/popup_window';
import {
  cloneAdbTracingSession,
  createAdbTracingSession,
} from '../dev.perfetto.RecordTraceV2/adb/adb_tracing_session';
import {TracingSession} from '../dev.perfetto.RecordTraceV2/interfaces/tracing_session';
import {Button, ButtonVariant} from '../../widgets/button';
import {Icon} from '../../widgets/icon';
import {SegmentedButtons} from '../../widgets/segmented_buttons';
import {
  LineChart,
  LineChartData,
  LineChartSeries,
} from '../../components/widgets/charts/line_chart';
import {Sankey, SankeyData} from '../../components/widgets/charts/sankey';
import {DataGrid} from '../../components/widgets/datagrid/datagrid';
import type {SchemaRegistry} from '../../components/widgets/datagrid/datagrid_schema';
import type {Row} from '../../trace_processor/query_result';
import {
  categorizeProcess,
  CATEGORIES,
  type CategoryId,
} from './process_categories';
import {Intent} from '../../widgets/common';
import {App} from '../../public/app';

const CLONE_INTERVAL_MS = 3_000;
const CLONE_INITIAL_DELAY_MS = 3_000;

let engineCounter = 0;

// System-level meminfo counters we want to collect.
const SYSTEM_MEMINFO_COUNTERS = [
  'MemTotal',
  'MemFree',
  'MemAvailable',
  'Buffers',
  'Cached',
  'SwapTotal',
  'SwapFree',
  'Shmem',
  'Active(anon)',
  'Inactive(anon)',
  'Active(file)',
  'Inactive(file)',
  'AnonPages',
  'Slab',
  'KernelStack',
  'PageTables',
  'Zram',
  'Mlocked',
] as const;

// Build a lookup from category name → color for the cell renderer.
const CATEGORY_COLOR_MAP = new Map<string, string>(
  (Object.values(CATEGORIES) as readonly {name: string; color: string}[]).map(
    (c) => [c.name, c.color],
  ),
);

const PROCESS_TABLE_SCHEMA: SchemaRegistry = {
  process: {
    process: {title: 'Process', columnType: 'text'},
    category: {
      title: 'Category',
      columnType: 'text',
      cellRenderer: (v) => {
        const color = CATEGORY_COLOR_MAP.get(v as string);
        return color !== undefined
          ? m('span', {style: {color}}, v as string)
          : (v as string);
      },
    },
    pid: {title: 'PID', columnType: 'quantitative'},
    oom_score: {title: 'OOM Adj', columnType: 'quantitative'},
    rss_kb: {
      title: 'RSS',
      columnType: 'quantitative',
      cellRenderer: (v) => formatKb(v as number),
    },
    anon_kb: {
      title: 'Anon',
      columnType: 'quantitative',
      cellRenderer: (v) => ((v as number) > 0 ? formatKb(v as number) : '-'),
    },
    file_kb: {
      title: 'File',
      columnType: 'quantitative',
      cellRenderer: (v) => ((v as number) > 0 ? formatKb(v as number) : '-'),
    },
    shmem_kb: {
      title: 'Shmem',
      columnType: 'quantitative',
      cellRenderer: (v) => ((v as number) > 0 ? formatKb(v as number) : '-'),
    },
    swap_kb: {
      title: 'Swap',
      columnType: 'quantitative',
      cellRenderer: (v) => ((v as number) > 0 ? formatKb(v as number) : '-'),
    },
  },
};

// Per-process memory row (latest value only, for the table).
interface ProcessMemoryRow {
  processName: string;
  pid: number;
  rssKb: number;
  anonKb: number;
  fileKb: number;
  shmemKb: number;
  swapKb: number;
  oomScore: number;
}

function createMonitoringConfig(
  uniqueSessionName: string,
): protos.ITraceConfig {
  return {
    uniqueSessionName,
    buffers: [
      // Small buffer to store the process metadata
      {
        sizeKb: 4 * 1024,
        fillPolicy: protos.TraceConfig.BufferConfig.FillPolicy.DISCARD,
      },
      {
        sizeKb: 8 * 1024,
        fillPolicy: protos.TraceConfig.BufferConfig.FillPolicy.RING_BUFFER,
      },
    ],
    dataSources: [
      {
        config: {
          name: 'linux.process_stats',
          targetBuffer: 0,
          processStatsConfig: {
            scanAllProcessesOnStart: true,
          },
        },
      },
      {
        config: {
          name: 'linux.process_stats',
          targetBuffer: 1,
          processStatsConfig: {
            scanAllProcessesOnStart: false,
            procStatsPollMs: 250,
          },
        },
      },
      {
        config: {
          name: 'linux.sys_stats',
          targetBuffer: 1,
          sysStatsConfig: {
            meminfoPeriodMs: 250,
            psiPeriodMs: 250,
            meminfoCounters: [
              protos.MeminfoCounters.MEMINFO_MEM_TOTAL,
              protos.MeminfoCounters.MEMINFO_MEM_FREE,
              protos.MeminfoCounters.MEMINFO_MEM_AVAILABLE,
              protos.MeminfoCounters.MEMINFO_BUFFERS,
              protos.MeminfoCounters.MEMINFO_CACHED,
              protos.MeminfoCounters.MEMINFO_SWAP_TOTAL,
              protos.MeminfoCounters.MEMINFO_SWAP_FREE,
              protos.MeminfoCounters.MEMINFO_SHMEM,
              protos.MeminfoCounters.MEMINFO_ACTIVE_ANON,
              protos.MeminfoCounters.MEMINFO_INACTIVE_ANON,
              protos.MeminfoCounters.MEMINFO_ACTIVE_FILE,
              protos.MeminfoCounters.MEMINFO_INACTIVE_FILE,
              protos.MeminfoCounters.MEMINFO_ANON_PAGES,
              protos.MeminfoCounters.MEMINFO_SLAB,
              protos.MeminfoCounters.MEMINFO_KERNEL_STACK,
              protos.MeminfoCounters.MEMINFO_PAGE_TABLES,
              protos.MeminfoCounters.MEMINFO_ZRAM,
            ],
          },
        },
      },
    ],
  };
}

interface LiveMemoryPageAttrs {
  app: App;
}

type ConnectionMethod = 'usb' | 'websocket' | 'web_proxy';

interface WsDevice {
  serial: string;
  model: string;
}

export class LiveMemoryPage implements m.ClassComponent<LiveMemoryPageAttrs> {
  private adbKeyMgr = new AdbKeyManager();
  private device?: AdbDevice;
  private deviceName?: string;
  private connecting = false;
  private error?: string;
  private connectionMethod: ConnectionMethod = 'usb';

  // WebSocket bridge state.
  private wsDevices: WsDevice[] = [];
  private wsConnecting = false;
  private wsConnected = false;

  // WDP (Web Device Proxy) state.
  private wdpDevices: WdpDevice[] = [];
  private wdpSocket?: WebSocket;
  private wdpConnecting = false;
  private wdpConnected = false;

  // Tracing session state.
  private sessionName = '';
  private session?: TracingSession;
  private isRecording = false;
  private cloneTimer?: number;
  private snapshotCount = 0;

  // Reusable TP instance for processing cloned traces.
  private engine?: WasmEngineProxy;

  // Chart data extracted from the latest cloned trace (full time-series).
  private systemChartData?: LineChartData;
  private pageCacheChartData?: LineChartData;
  private lruChartData?: LineChartData;
  private categoryChartData?: LineChartData;
  private sankeyData?: SankeyData;
  private psiChartData?: LineChartData;
  // Latest process table (most recent values only).
  private latestProcesses?: ProcessMemoryRow[];

  // Category drill-down state.
  private selectedCategory?: CategoryId;
  private drilldownChartData?: LineChartData;

  // Shared time origin (ns) across all charts for synced x-axes.
  private traceT0?: number;

  // Last cloned trace buffer for "Stop and open trace".
  private lastTraceBuffer?: ArrayBuffer;
  private app!: App;

  onremove() {
    this.stopSession();
    this.disposeEngine();
    this.disconnectWdp();
  }

  view({attrs}: m.CVnode<LiveMemoryPageAttrs>) {
    this.app = attrs.app;
    return m('.pf-live-memory-page__container', this.renderPageContent());
  }

  private renderPageContent() {
    if (!this.device) {
      return this.renderDisconnected();
    }
    if (!this.isRecording) {
      return this.renderConnectedIdle();
    }
    return this.renderRecording();
  }

  // ---------------------------------------------------------------------------
  // Disconnected — show connect button.
  // ---------------------------------------------------------------------------

  private renderDisconnected(): m.Children {
    return m(
      '.pf-live-memory-page',
      m('.pf-live-memory-title-bar', m('h1', 'Memory Monitor')),
      m(
        '.pf-live-memory-hero',
        m(Icon, {icon: 'memory', className: 'pf-live-memory-hero__icon'}),
        m(
          '.pf-live-memory-hero__text',
          'Connect to an Android device to monitor per-process ' +
            'memory usage in real time via traced.',
        ),
        m(SegmentedButtons, {
          options: [
            {label: 'USB', icon: 'usb'},
            {label: 'WebSocket', icon: 'lan'},
            {label: 'Web Proxy', icon: 'corporate_fare'},
          ],
          selectedOption:
            this.connectionMethod === 'usb'
              ? 0
              : this.connectionMethod === 'websocket'
                ? 1
                : 2,
          onOptionSelected: (i: number) => {
            const methods: ConnectionMethod[] = [
              'usb',
              'websocket',
              'web_proxy',
            ];
            this.connectionMethod = methods[i];
            this.error = undefined;
          },
        }),
        this.connectionMethod === 'usb'
          ? this.renderUsbConnect()
          : this.connectionMethod === 'websocket'
            ? this.renderWsConnect()
            : this.renderWdpConnect(),
        this.error && m('.pf-live-memory-error', this.error),
      ),
    );
  }

  private renderUsbConnect(): m.Children {
    return [
      m(Button, {
        label: this.connecting ? 'Connecting...' : 'Connect USB device',
        icon: 'usb',
        variant: ButtonVariant.Filled,
        intent: Intent.Primary,
        disabled: this.connecting || !exists(navigator.usb),
        onclick: () => this.connectDevice(),
      }),
      !exists(navigator.usb) &&
        m('.pf-live-memory-error', 'WebUSB is not available in this browser.'),
    ];
  }

  private renderWsConnect(): m.Children {
    if (!this.wsConnected) {
      return m(Button, {
        label: this.wsConnecting
          ? 'Connecting...'
          : 'Connect to WebSocket bridge',
        icon: 'lan',
        variant: ButtonVariant.Filled,
        intent: Intent.Primary,
        disabled: this.wsConnecting,
        onclick: () => this.connectWebsocket(),
      });
    }

    if (this.wsDevices.length === 0) {
      return m(
        '.pf-live-memory-hero__text',
        'No devices found. Connect an Android device via ADB.',
      );
    }

    return m(
      '.pf-live-memory-device-list',
      this.wsDevices.map((dev) =>
        m(Button, {
          key: dev.serial,
          label: this.connecting
            ? 'Connecting...'
            : `${dev.model} [${dev.serial}]`,
          icon: 'smartphone',
          variant: ButtonVariant.Outlined,
          disabled: this.connecting,
          onclick: () => this.connectWsDevice(dev),
        }),
      ),
    );
  }

  private renderWdpConnect(): m.Children {
    if (!this.wdpConnected) {
      return m(Button, {
        label: this.wdpConnecting
          ? 'Connecting to proxy...'
          : 'Connect to Web Device Proxy',
        icon: 'corporate_fare',
        variant: ButtonVariant.Filled,
        intent: Intent.Primary,
        disabled: this.wdpConnecting,
        onclick: () => this.connectWdp(),
      });
    }

    if (this.wdpDevices.length === 0) {
      return m(
        '.pf-live-memory-hero__text',
        'No devices found. Connect an Android device and authorize it.',
      );
    }

    return m(
      '.pf-live-memory-device-list',
      this.wdpDevices.map((dev) => {
        const ready = dev.proxyStatus === 'ADB' && dev.adbStatus === 'DEVICE';
        const model =
          dev.proxyStatus === 'ADB' ? dev.adbProps?.model ?? '?' : '?';
        const label = ready
          ? `${model} [${dev.serialNumber}]`
          : `${dev.proxyStatus}/${dev.adbStatus} [${dev.serialNumber}]`;
        return m(Button, {
          key: dev.serialNumber,
          label: this.connecting ? 'Connecting...' : label,
          icon: ready ? 'smartphone' : 'lock',
          variant: ButtonVariant.Outlined,
          disabled: this.connecting,
          onclick: () => this.connectWdpDevice(dev),
        });
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Connected but not recording — show start button.
  // ---------------------------------------------------------------------------

  private renderConnectedIdle(): m.Children {
    return m(
      '.pf-live-memory-page',
      m('.pf-live-memory-title-bar', m('h1', 'Memory Monitor')),
      m(
        '.pf-live-memory-hero',
        m(Icon, {icon: 'usb', className: 'pf-live-memory-hero__icon'}),
        m('.pf-live-memory-hero__text', `Connected to ${this.deviceName}`),
        this.error && m('.pf-live-memory-error', this.error),
        m(
          '.pf-live-memory-hero__actions',
          m(Button, {
            label: 'Start monitoring',
            icon: 'play_arrow',
            variant: ButtonVariant.Filled,
            intent: Intent.Primary,
            onclick: () => this.startSession(),
          }),
          m(Button, {
            label: 'Disconnect',
            icon: 'usb_off',
            onclick: () => this.disconnect(),
          }),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Recording — show charts + process table.
  // ---------------------------------------------------------------------------

  private renderRecording(): m.Children {
    return m(
      '.pf-live-memory-page',
      m(
        '.pf-live-memory-title-bar',
        m('h1', 'Memory Monitor'),
        m(
          '.pf-live-memory-title-bar__actions',
          m(Button, {
            label: 'Stop & Open Trace',
            icon: 'open_in_new',
            variant: ButtonVariant.Filled,
            intent: Intent.Primary,
            disabled: this.lastTraceBuffer === undefined,
            onclick: () => this.stopAndOpenTrace(),
          }),
          m(Button, {
            label: 'Stop',
            icon: 'stop',
            variant: ButtonVariant.Filled,
            intent: Intent.Danger,
            onclick: () => this.stopSession(),
          }),
          m(Button, {
            label: 'Disconnect',
            icon: 'usb_off',
            onclick: () => this.disconnect(),
          }),
        ),
      ),
      m(
        '.pf-live-memory-status-bar',
        m('.pf-live-memory-status-bar__dot'),
        `${this.deviceName}`,
        '\u00b7',
        `${this.snapshotCount} snapshots`,
      ),
      this.error && m('.pf-live-memory-error', this.error),

      panel(
        'System Memory Overview',
        'Physical RAM breakdown by category',
        this.sankeyData
          ? m(Sankey, {
              data: this.sankeyData,
              height: 350,
              formatValue: (v: number) => formatKb(v),
            })
          : m('.pf-live-memory-placeholder', 'Waiting for data\u2026'),
      ),

      panel(
        'System Memory',
        'Stacked areas partition MemTotal. Source: /proc/meminfo.',
        this.systemChartData
          ? m(LineChart, {
              data: this.systemChartData,
              height: 250,
              xAxisLabel: 'Time (s)',
              yAxisLabel: 'Memory',
              showLegend: true,
              showPoints: false,
              stacked: true,
              gridLines: 'horizontal',
              formatXValue: (v: number) => `${v.toFixed(0)}s`,
              formatYValue: (v: number) => formatKb(v),
            })
          : m('.pf-live-memory-placeholder', 'Waiting for data\u2026'),
      ),

      panel(
        'Memory Pressure (PSI)',
        '"some" = at least one task stalled, "full" = all tasks stalled. 0 ms/s is healthy.',
        this.psiChartData
          ? m(LineChart, {
              data: this.psiChartData,
              height: 200,
              xAxisLabel: 'Time (s)',
              yAxisLabel: 'Stall (ms/s)',
              showLegend: true,
              showPoints: false,
              gridLines: 'horizontal',
              formatXValue: (v: number) => `${v.toFixed(0)}s`,
              formatYValue: (v: number) => `${v.toFixed(1)} ms/s`,
            })
          : m('.pf-live-memory-placeholder', 'Waiting for data\u2026'),
      ),

      panel(
        'Page Cache',
        'File cache = reclaimable file-backed pages. Shmem = tmpfs/shared memory.',
        this.pageCacheChartData
          ? m(LineChart, {
              data: this.pageCacheChartData,
              height: 250,
              xAxisLabel: 'Time (s)',
              yAxisLabel: 'Cache',
              showLegend: true,
              showPoints: false,
              stacked: true,
              gridLines: 'horizontal',
              formatXValue: (v: number) => `${v.toFixed(0)}s`,
              formatYValue: (v: number) => formatKb(v),
            })
          : m('.pf-live-memory-placeholder', 'Waiting for data\u2026'),
      ),

      panel(
        'Active vs Inactive (LRU Aging)',
        'Anon = heap/stack (swappable only). File = page cache (reclaimable). ' +
          'Growing inactive file = cold pages the kernel may reclaim. ' +
          'Large active anon = pressure will go straight to swap.',
        this.lruChartData
          ? m(LineChart, {
              data: this.lruChartData,
              height: 250,
              xAxisLabel: 'Time (s)',
              yAxisLabel: 'Memory',
              showLegend: true,
              showPoints: false,
              stacked: true,
              gridLines: 'horizontal',
              formatXValue: (v: number) => `${v.toFixed(0)}s`,
              formatYValue: (v: number) => formatKb(v),
            })
          : m('.pf-live-memory-placeholder', 'Waiting for data\u2026'),
      ),

      this.renderProcessSection(),
    );
  }

  private renderProcessSection(): m.Children {
    const cat = this.selectedCategory
      ? CATEGORIES[this.selectedCategory]
      : undefined;

    const chartData = this.selectedCategory
      ? this.drilldownChartData
      : this.categoryChartData;

    const processes = this.latestProcesses
      ? this.selectedCategory
        ? this.latestProcesses.filter(
            (p) => categorizeProcess(p.processName).name === cat!.name,
          )
        : this.latestProcesses
      : undefined;

    const title = cat
      ? `Process Memory: ${cat.name}`
      : 'Process Memory by Category';
    const subtitle = cat
      ? 'Stacked RSS per process. Totals may exceed actual memory usage because RSS counts shared pages (COW, mmap) in every process that maps them.'
      : 'Stacked RSS per category. Click a category to drill into individual processes.';

    return m(
      '.pf-live-memory-panel',
      m(
        '.pf-live-memory-panel__header',
        cat &&
          m(Button, {
            icon: 'arrow_back',
            label: 'All categories',
            minimal: true,
            onclick: () => {
              this.selectedCategory = undefined;
              this.drilldownChartData = undefined;
            },
          }),
        m('h2', title),
        m('p', subtitle),
      ),
      m(
        '.pf-live-memory-panel__body',
        chartData
          ? m(LineChart, {
              data: chartData,
              height: 350,
              xAxisLabel: 'Time (s)',
              yAxisLabel: 'RSS',
              showLegend: true,
              showPoints: false,
              stacked: true,
              gridLines: 'horizontal',
              formatXValue: (v: number) => `${v.toFixed(0)}s`,
              formatYValue: (v: number) => formatKb(v),
              onSeriesClick: this.selectedCategory
                ? undefined
                : (seriesName: string) => {
                    this.drillDownToCategory(seriesName);
                  },
            })
          : m('.pf-live-memory-placeholder', 'Waiting for data\u2026'),
        processes && this.renderProcessTable(processes),
      ),
    );
  }

  private drillDownToCategory(seriesName: string) {
    const catIds = Object.keys(CATEGORIES) as CategoryId[];
    const id = catIds.find((k) => CATEGORIES[k].name === seriesName);
    if (id === undefined) return;
    this.selectedCategory = id;
    this.drilldownChartData = undefined;
    // Recompute drill-down chart from existing engine data.
    if (this.engine) {
      this.queryDrilldownTimeSeries(this.engine, id, this.traceT0 ?? 0).then((data) => {
        this.drilldownChartData = data;
        m.redraw();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Process table
  // ---------------------------------------------------------------------------

  private renderProcessTable(processes: ProcessMemoryRow[]): m.Children {
    const rows: Row[] = processes.map((p) => {
      const cat = categorizeProcess(p.processName);
      return {
        process: p.processName,
        category: cat.name,
        pid: p.pid,
        oom_score: p.oomScore,
        rss_kb: p.rssKb,
        anon_kb: p.anonKb,
        file_kb: p.fileKb,
        shmem_kb: p.shmemKb,
        swap_kb: p.swapKb,
      };
    });

    return m(DataGrid, {
      schema: PROCESS_TABLE_SCHEMA,
      rootSchema: 'process',
      data: rows,
      initialColumns: [
        {id: 'process', field: 'process', sort: undefined},
        {id: 'category', field: 'category', sort: undefined},
        {id: 'pid', field: 'pid', sort: undefined},
        {id: 'oom_score', field: 'oom_score', sort: undefined},
        {id: 'rss_kb', field: 'rss_kb', sort: 'DESC'},
        {id: 'anon_kb', field: 'anon_kb', sort: undefined},
        {id: 'file_kb', field: 'file_kb', sort: undefined},
        {id: 'shmem_kb', field: 'shmem_kb', sort: undefined},
        {id: 'swap_kb', field: 'swap_kb', sort: undefined},
      ],
      fillHeight: false,
    });
  }

  // ---------------------------------------------------------------------------
  // USB connection
  // ---------------------------------------------------------------------------

  private async connectDevice() {
    this.connecting = true;
    this.error = undefined;
    m.redraw();

    try {
      const usbdev = await navigator.usb.requestDevice({
        filters: [ADB_DEVICE_FILTER],
      });

      const usbiface = getAdbWebUsbInterface(usbdev);
      if (!usbiface) {
        this.error = 'Could not find ADB interface on selected device.';
        this.connecting = false;
        m.redraw();
        return;
      }

      const result = await AdbWebusbDevice.connect(usbdev, this.adbKeyMgr);
      if (!result.ok) {
        this.error = result.error;
        this.connecting = false;
        m.redraw();
        return;
      }

      this.device = result.value;
      this.deviceName = `${usbdev.productName} [${usbdev.serialNumber}]`;
      this.connecting = false;
      m.redraw();
    } catch (e) {
      if (`${(e as {name?: string}).name}` === 'NotFoundError') {
        this.connecting = false;
        m.redraw();
        return;
      }
      this.error = `Connection failed: ${e}`;
      this.connecting = false;
      m.redraw();
    }
  }

  private disconnect() {
    this.stopSession();
    this.device?.close();
    this.device = undefined;
    this.deviceName = undefined;
    this.error = undefined;
    this.wsDevices = [];
    this.wsConnected = false;
    this.disconnectWdp();
  }

  // ---------------------------------------------------------------------------
  // WebSocket bridge connection
  // ---------------------------------------------------------------------------

  private async connectWebsocket() {
    this.wsConnecting = true;
    this.error = undefined;
    this.wsDevices = [];
    m.redraw();

    const wsUrl = 'ws://127.0.0.1:8037/adb';
    using sock = await AsyncWebsocket.connect(wsUrl);
    if (!sock) {
      this.error =
        'Failed to connect to websocket_bridge at ' +
        wsUrl +
        '. Make sure websocket_bridge is running.';
      this.wsConnecting = false;
      m.redraw();
      return;
    }

    const status = await adbCmdAndWait(sock, 'host:devices-l', true);
    if (!status.ok) {
      this.error = `Failed to list devices: ${status.error}`;
      this.wsConnecting = false;
      m.redraw();
      return;
    }

    const devices: WsDevice[] = [];
    for (const line of status.value.trimEnd().split('\n')) {
      if (line === '') continue;
      const match = line.match(/^([^\s]+)\s+.*model:([^ ]+)/);
      if (!match) continue;
      devices.push({serial: match[1], model: match[2]});
    }

    this.wsDevices = devices;
    this.wsConnected = true;
    this.wsConnecting = false;
    m.redraw();
  }

  private async connectWsDevice(dev: WsDevice) {
    this.connecting = true;
    this.error = undefined;
    m.redraw();

    try {
      const wsUrl = 'ws://127.0.0.1:8037/adb';
      const result = await AdbWebsocketDevice.connect(
        wsUrl,
        dev.serial,
        'WEBSOCKET_BRIDGE',
      );
      if (!result.ok) {
        this.error = result.error;
        this.connecting = false;
        m.redraw();
        return;
      }

      this.device = result.value;
      this.deviceName = `${dev.model} [${dev.serial}]`;
      this.connecting = false;
      m.redraw();
    } catch (e) {
      this.error = `WebSocket connection failed: ${e}`;
      this.connecting = false;
      m.redraw();
    }
  }

  // ---------------------------------------------------------------------------
  // Web Device Proxy connection
  // ---------------------------------------------------------------------------

  private async connectWdp() {
    this.wdpConnecting = true;
    this.error = undefined;
    this.wdpDevices = [];
    m.redraw();

    const wsUrl = 'ws://127.0.0.1:9167/track-devices-json';

    for (let attempt = 0; attempt < 2; attempt++) {
      const aws = await AsyncWebsocket.connect(wsUrl);
      if (aws === undefined) {
        this.error =
          'Failed to connect to Web Device Proxy. ' +
          'Make sure it is running (see go/web-device-proxy).';
        this.wdpConnecting = false;
        m.redraw();
        return;
      }

      const respStr = await aws.waitForString();
      const respJson = JSON.parse(respStr);
      const respSchema = WDP_TRACK_DEVICES_SCHEMA.safeParse(respJson);
      if (!respSchema.success) {
        this.error = `Invalid WDP response: ${respSchema.error}`;
        this.wdpConnecting = false;
        m.redraw();
        return;
      }
      const resp = respSchema.data;

      if (
        resp.error?.type === 'ORIGIN_NOT_ALLOWLISTED' &&
        resp.error.approveUrl !== undefined
      ) {
        const popup = await showPopupWindow({url: resp.error.approveUrl});
        if (popup === false) {
          this.error = 'You need to enable popups and try again.';
          this.wdpConnecting = false;
          m.redraw();
          return;
        }
        continue; // Retry after user approved.
      } else if (resp.error !== undefined) {
        this.error = resp.error.message ?? 'Unknown WDP error';
        this.wdpConnecting = false;
        m.redraw();
        return;
      }

      // Success — listen for device updates.
      const ws = aws.release();
      this.wdpSocket = ws;
      this.wdpConnected = true;
      this.wdpConnecting = false;
      this.wdpDevices = resp.device ?? [];

      ws.onmessage = (e: MessageEvent<string>) => {
        const parsed = WDP_TRACK_DEVICES_SCHEMA.safeParse(JSON.parse(e.data));
        if (parsed.success && parsed.data.error === undefined) {
          this.wdpDevices = parsed.data.device ?? [];
        }
        m.redraw();
      };
      ws.onclose = () => {
        this.wdpConnected = false;
        this.wdpSocket = undefined;
        m.redraw();
      };
      ws.onerror = () => {
        this.wdpConnected = false;
        this.wdpSocket = undefined;
        m.redraw();
      };

      m.redraw();
      return;
    }

    this.error =
      'Failed to authenticate with WDP. ' +
      'Click allow on the popup and try again.';
    this.wdpConnecting = false;
    m.redraw();
  }

  private async connectWdpDevice(dev: WdpDevice) {
    this.connecting = true;
    this.error = undefined;
    m.redraw();

    try {
      if (dev.proxyStatus === 'PROXY_UNAUTHORIZED') {
        const res = await showPopupWindow({url: dev.approveUrl});
        if (!res) {
          this.error = 'Enable popups and try again.';
          this.connecting = false;
          m.redraw();
          return;
        }
      }

      if (dev.proxyStatus !== 'ADB' || dev.adbStatus !== 'DEVICE') {
        this.error =
          `Device not ready: proxyStatus=${dev.proxyStatus}` +
          ` adbStatus=${dev.adbStatus}`;
        this.connecting = false;
        m.redraw();
        return;
      }

      const wsUrl = 'ws://127.0.0.1:9167/adb-json';
      const result = await AdbWebsocketDevice.connect(
        wsUrl,
        dev.serialNumber,
        'WEB_DEVICE_PROXY',
      );
      if (!result.ok) {
        this.error = result.error;
        this.connecting = false;
        m.redraw();
        return;
      }

      this.device = result.value;
      const model =
        dev.proxyStatus === 'ADB' ? dev.adbProps?.model ?? '?' : '?';
      this.deviceName = `${model} [${dev.serialNumber}]`;
      this.connecting = false;
      m.redraw();
    } catch (e) {
      this.error = `WDP connection failed: ${e}`;
      this.connecting = false;
      m.redraw();
    }
  }

  private disconnectWdp() {
    if (this.wdpSocket) {
      this.wdpSocket.close();
      this.wdpSocket = undefined;
    }
    this.wdpConnected = false;
    this.wdpDevices = [];
  }

  // ---------------------------------------------------------------------------
  // Tracing session lifecycle
  // ---------------------------------------------------------------------------

  private async startSession() {
    if (!this.device) return;

    this.error = undefined;
    this.snapshotCount = 0;
    this.systemChartData = undefined;
    this.pageCacheChartData = undefined;
    this.lruChartData = undefined;
    this.categoryChartData = undefined;
    this.sankeyData = undefined;
    this.psiChartData = undefined;
    this.latestProcesses = undefined;
    this.selectedCategory = undefined;
    this.drilldownChartData = undefined;
    this.sessionName = `livemem-${uuidv4().substring(0, 8)}`;

    const config = createMonitoringConfig(this.sessionName);
    const result = await createAdbTracingSession(this.device, config);
    if (!result.ok) {
      this.error = `Failed to start tracing: ${result.error}`;
      m.redraw();
      return;
    }

    this.session = result.value;
    this.isRecording = true;

    this.session.onSessionUpdate.addListener(() => {
      if (this.session?.state === 'ERRORED') {
        this.error = 'Tracing session errored';
        console.error('[LiveMem] session ERRORED, stopping clone timer');
        this.stopCloneTimer();
        this.isRecording = false;
      }
      m.redraw();
    });

    // First clone after a short delay, then chain subsequent clones.
    this.cloneTimer = window.setTimeout(() => {
      this.cloneAndQuery();
    }, CLONE_INITIAL_DELAY_MS);

    m.redraw();
  }

  private async stopAndOpenTrace() {
    const buffer = this.lastTraceBuffer;
    if (buffer === undefined) return;
    const fileName = `live-memory-${Date.now()}.perfetto-trace`;
    await this.stopSession();
    this.app.openTraceFromBuffer({buffer, title: fileName, fileName});
  }

  private async stopSession() {
    this.stopCloneTimer();
    if (this.session) {
      await this.session.stop();
      this.session = undefined;
    }
    this.disposeEngine();
    this.isRecording = false;
    this.snapshotCount = 0;
    this.systemChartData = undefined;
    this.pageCacheChartData = undefined;
    this.lruChartData = undefined;
    this.categoryChartData = undefined;
    this.sankeyData = undefined;
    this.psiChartData = undefined;
    this.latestProcesses = undefined;
    this.selectedCategory = undefined;
    this.drilldownChartData = undefined;
    this.lastTraceBuffer = undefined;
    this.traceT0 = undefined;
    m.redraw();
  }

  private stopCloneTimer() {
    if (this.cloneTimer !== undefined) {
      window.clearTimeout(this.cloneTimer);
      this.cloneTimer = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Clone + TraceProcessor query loop
  // ---------------------------------------------------------------------------

  private getOrCreateEngine(): WasmEngineProxy {
    if (this.engine === undefined) {
      this.engine = new WasmEngineProxy(`livemem-${++engineCounter}`);
    }
    return this.engine;
  }

  private disposeEngine() {
    if (this.engine !== undefined) {
      this.engine[Symbol.dispose]();
      this.engine = undefined;
    }
  }

  private async cloneAndQuery(): Promise<void> {
    const snapNum = this.snapshotCount + 1;
    if (!this.isRecording || !this.device) {
      return;
    }

    try {
      // Clone the running session by name.
      const cloneResult = await cloneAdbTracingSession(
        this.device,
        this.sessionName,
      );
      if (!cloneResult.ok) {
        this.error = `Clone failed: ${cloneResult.error}`;
        console.error(
          `[LiveMem] #${snapNum} clone failed: ${cloneResult.error}`,
        );
        return;
      }
      this.lastTraceBuffer = cloneResult.value.buffer as ArrayBuffer;

      // Reset the reusable TP instance and load the cloned trace.
      const engine = this.getOrCreateEngine();
      await engine.resetTraceProcessor({
        tokenizeOnly: false,
        cropTrackEvents: false,
        ingestFtraceInRawTable: false,
        analyzeTraceProtoContent: false,
        ftraceDropUntilAllCpusValid: false,
        forceFullSort: false,
      });
      await engine.parse(cloneResult.value);
      await engine.notifyEof();

      // Compute shared time origin on first snapshot, reuse for all subsequent
      // snapshots so x-axes stay synced across charts.
      if (this.traceT0 === undefined) {
        const t0Result = await engine.query(
          'SELECT MIN(ts) AS t0 FROM counter',
        );
        const t0Iter = t0Result.iter({t0: NUM});
        if (t0Iter.valid()) {
          this.traceT0 = t0Iter.t0;
        }
      }
      const t0 = this.traceT0 ?? 0;

      // Query full time-series from the ring buffer and replace chart data.
      const [
        systemData,
        pageCacheData,
        lruData,
        categoryData,
        sankeyData,
        psiData,
        drilldownData,
        latestProcesses,
      ] = await Promise.all([
        this.querySystemTimeSeries(engine, t0),
        this.queryPageCacheTimeSeries(engine, t0),
        this.queryLruTimeSeries(engine, t0),
        this.queryCategoryTimeSeries(engine, t0),
        this.querySankeyData(engine),
        this.queryPsiTimeSeries(engine, t0),
        this.selectedCategory
          ? this.queryDrilldownTimeSeries(engine, this.selectedCategory, t0)
          : Promise.resolve(undefined),
        this.queryLatestProcessMemory(engine),
      ]);

      this.systemChartData = systemData;
      this.pageCacheChartData = pageCacheData;
      this.lruChartData = lruData;
      this.categoryChartData = categoryData;
      this.sankeyData = sankeyData;
      this.psiChartData = psiData;
      if (this.selectedCategory) {
        this.drilldownChartData = drilldownData;
      }
      this.latestProcesses = latestProcesses;
      this.snapshotCount++;
      this.error = undefined;
    } catch (e) {
      this.error = `Snapshot error: ${e}`;
    } finally {
      // Schedule next clone after this one finishes.
      if (this.isRecording) {
        this.cloneTimer = window.setTimeout(() => {
          this.cloneAndQuery();
        }, CLONE_INTERVAL_MS);
      }
      m.redraw();
    }
  }

  // ---------------------------------------------------------------------------
  // System memory: full time-series from TP, decomposed for stacking.
  // ---------------------------------------------------------------------------

  private async querySystemTimeSeries(
    engine: WasmEngineProxy,
    t0: number,
  ): Promise<LineChartData | undefined> {
    const names = SYSTEM_MEMINFO_COUNTERS.map((n) => `'${n}'`).join(',');
    const queryResult = await engine.query(`
      SELECT
        t.name AS counter_name,
        c.ts AS ts,
        c.value AS value_bytes
      FROM counter c
      JOIN counter_track t ON c.track_id = t.id
      WHERE t.name IN (${names})
      ORDER BY c.ts
    `);

    // Group values by timestamp. All meminfo counters share the same poll
    // interval so they arrive at the same ts.
    // TP stores meminfo values in bytes; convert to KB here.
    const byTs = new Map<number, Map<string, number>>();
    const iter = queryResult.iter({
      counter_name: STR,
      ts: NUM,
      value_bytes: NUM,
    });
    for (; iter.valid(); iter.next()) {
      let row = byTs.get(iter.ts);
      if (row === undefined) {
        row = new Map();
        byTs.set(iter.ts, row);
      }
      row.set(iter.counter_name, Math.round(iter.value_bytes / 1024));
    }

    if (byTs.size < 2) return undefined;

    const timestamps = [...byTs.keys()].sort((a, b) => a - b);

    // Partition MemTotal into non-overlapping bands:
    //   AnonPages + Shmem + FileCache + Buffers + Slab + PageTables +
    //   KernelStack + MemFree + OtherKernel = MemTotal
    // where FileCache = Cached - Shmem, and OtherKernel is the residual.
    const anonPts: {x: number; y: number}[] = [];
    const shmemPts: {x: number; y: number}[] = [];
    const fileCachePts: {x: number; y: number}[] = [];
    const buffersPts: {x: number; y: number}[] = [];
    const slabPts: {x: number; y: number}[] = [];
    const pageTablesPts: {x: number; y: number}[] = [];
    const kernelStackPts: {x: number; y: number}[] = [];
    const freePts: {x: number; y: number}[] = [];
    const otherKernelPts: {x: number; y: number}[] = [];

    for (const ts of timestamps) {
      const row = byTs.get(ts)!;
      const total = row.get('MemTotal');
      const free = row.get('MemFree');
      const buffers = row.get('Buffers');
      const cached = row.get('Cached');
      if (
        total === undefined ||
        free === undefined ||
        buffers === undefined ||
        cached === undefined
      ) {
        continue;
      }
      const x = (ts - t0) / 1e9; // ns → seconds
      const anonPages = row.get('AnonPages') ?? 0;
      const shmem = row.get('Shmem') ?? 0;
      const fileCache = Math.max(0, cached - shmem);
      const slab = row.get('Slab') ?? 0;
      const pageTables = row.get('PageTables') ?? 0;
      const kernelStack = row.get('KernelStack') ?? 0;

      const accounted =
        anonPages +
        shmem +
        fileCache +
        buffers +
        slab +
        pageTables +
        kernelStack +
        free;
      const otherKernel = Math.max(0, total - accounted);

      anonPts.push({x, y: anonPages});
      shmemPts.push({x, y: shmem});
      fileCachePts.push({x, y: fileCache});
      buffersPts.push({x, y: buffers});
      slabPts.push({x, y: slab});
      pageTablesPts.push({x, y: pageTables});
      kernelStackPts.push({x, y: kernelStack});
      freePts.push({x, y: free});
      otherKernelPts.push({x, y: otherKernel});
    }

    if (anonPts.length < 2) return undefined;

    const series: LineChartSeries[] = [
      {name: 'AnonPages', points: anonPts, color: '#e74c3c'},
      {name: 'Shmem', points: shmemPts, color: '#ab47bc'},
      {name: 'File cache', points: fileCachePts, color: '#f39c12'},
      {name: 'Buffers', points: buffersPts, color: '#3498db'},
      {name: 'Slab', points: slabPts, color: '#9c27b0'},
      {name: 'PageTables', points: pageTablesPts, color: '#4a148c'},
      {name: 'KernelStack', points: kernelStackPts, color: '#7b1fa2'},
      {name: 'MemFree', points: freePts, color: '#2ecc71'},
      {name: 'Other kernel', points: otherKernelPts, color: '#78909c'},
    ];

    return {series};
  }

  // ---------------------------------------------------------------------------
  // Page cache: stacked breakdown of Cached into file cache + shmem.
  // ---------------------------------------------------------------------------

  private async queryPageCacheTimeSeries(
    engine: WasmEngineProxy,
    t0: number,
  ): Promise<LineChartData | undefined> {
    const counters = ['Cached', 'Shmem', 'Active(file)', 'Inactive(file)'];
    const names = counters.map((n) => `'${n}'`).join(',');
    const queryResult = await engine.query(`
      SELECT
        t.name AS counter_name,
        c.ts AS ts,
        c.value AS value_bytes
      FROM counter c
      JOIN counter_track t ON c.track_id = t.id
      WHERE t.name IN (${names})
      ORDER BY c.ts
    `);

    // TP stores meminfo values in bytes; convert to KB here.
    const byTs = new Map<number, Map<string, number>>();
    const iter = queryResult.iter({
      counter_name: STR,
      ts: NUM,
      value_bytes: NUM,
    });
    for (; iter.valid(); iter.next()) {
      let row = byTs.get(iter.ts);
      if (row === undefined) {
        row = new Map();
        byTs.set(iter.ts, row);
      }
      row.set(iter.counter_name, Math.round(iter.value_bytes / 1024));
    }

    if (byTs.size < 2) return undefined;

    const timestamps = [...byTs.keys()].sort((a, b) => a - b);

    // Decompose Cached into non-overlapping slices:
    //   Cached (from meminfo) = file cache + shmem (tmpfs/ashmem)
    //   File cache = Cached - Shmem
    //   File cache = Active(file) + Inactive(file) (alternative breakdown)
    const activeFilePoints: {x: number; y: number}[] = [];
    const inactiveFilePoints: {x: number; y: number}[] = [];
    const shmemPoints: {x: number; y: number}[] = [];

    for (const ts of timestamps) {
      const row = byTs.get(ts)!;
      const shmem = row.get('Shmem');
      const activeFile = row.get('Active(file)');
      const inactiveFile = row.get('Inactive(file)');
      if (
        shmem === undefined ||
        activeFile === undefined ||
        inactiveFile === undefined
      ) {
        continue;
      }
      const x = (ts - t0) / 1e9;
      activeFilePoints.push({x, y: activeFile});
      inactiveFilePoints.push({x, y: inactiveFile});
      shmemPoints.push({x, y: shmem});
    }

    if (activeFilePoints.length < 2) return undefined;

    // Stack: Active(file) + Inactive(file) + Shmem ≈ Cached
    return {
      series: [
        {name: 'Active(file)', points: activeFilePoints, color: '#2ecc71'},
        {name: 'Inactive(file)', points: inactiveFilePoints, color: '#f39c12'},
        {name: 'Shmem (tmpfs/ashmem)', points: shmemPoints, color: '#9b59b6'},
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // LRU aging: Active/Inactive × Anon/File stacked breakdown.
  // ---------------------------------------------------------------------------

  private async queryLruTimeSeries(
    engine: WasmEngineProxy,
    t0: number,
  ): Promise<LineChartData | undefined> {
    const counters = [
      'Active(anon)',
      'Inactive(anon)',
      'Active(file)',
      'Inactive(file)',
    ];
    const names = counters.map((n) => `'${n}'`).join(',');
    const queryResult = await engine.query(`
      SELECT
        t.name AS counter_name,
        c.ts AS ts,
        c.value AS value_bytes
      FROM counter c
      JOIN counter_track t ON c.track_id = t.id
      WHERE t.name IN (${names})
      ORDER BY c.ts
    `);

    const byTs = new Map<number, Map<string, number>>();
    const iter = queryResult.iter({
      counter_name: STR,
      ts: NUM,
      value_bytes: NUM,
    });
    for (; iter.valid(); iter.next()) {
      let row = byTs.get(iter.ts);
      if (row === undefined) {
        row = new Map();
        byTs.set(iter.ts, row);
      }
      row.set(iter.counter_name, Math.round(iter.value_bytes / 1024));
    }

    if (byTs.size < 2) return undefined;

    const timestamps = [...byTs.keys()].sort((a, b) => a - b);
    const activeAnonPts: {x: number; y: number}[] = [];
    const inactiveAnonPts: {x: number; y: number}[] = [];
    const activeFilePts: {x: number; y: number}[] = [];
    const inactiveFilePts: {x: number; y: number}[] = [];

    for (const ts of timestamps) {
      const row = byTs.get(ts)!;
      const activeAnon = row.get('Active(anon)');
      const inactiveAnon = row.get('Inactive(anon)');
      const activeFile = row.get('Active(file)');
      const inactiveFile = row.get('Inactive(file)');
      if (
        activeAnon === undefined ||
        inactiveAnon === undefined ||
        activeFile === undefined ||
        inactiveFile === undefined
      ) {
        continue;
      }
      const x = (ts - t0) / 1e9;
      activeAnonPts.push({x, y: activeAnon});
      inactiveAnonPts.push({x, y: inactiveAnon});
      activeFilePts.push({x, y: activeFile});
      inactiveFilePts.push({x, y: inactiveFile});
    }

    if (activeAnonPts.length < 2) return undefined;

    return {
      series: [
        {name: 'Active(anon)', points: activeAnonPts, color: '#e74c3c'},
        {name: 'Inactive(anon)', points: inactiveAnonPts, color: '#f39c12'},
        {name: 'Active(file)', points: activeFilePts, color: '#2ecc71'},
        {name: 'Inactive(file)', points: inactiveFilePts, color: '#3498db'},
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Per-process RSS by category: full time-series from TP.
  // ---------------------------------------------------------------------------

  private async queryCategoryTimeSeries(
    engine: WasmEngineProxy,
    t0: number,
  ): Promise<LineChartData | undefined> {
    const queryResult = await engine.query(`
      SELECT
        p.name AS process_name,
        c.ts AS ts,
        c.value AS rss_bytes
      FROM counter c
      JOIN process_counter_track t ON c.track_id = t.id
      JOIN process p ON t.upid = p.upid
      WHERE t.name = 'mem.rss'
        AND p.name IS NOT NULL
      ORDER BY c.ts
    `);

    // Collect all unique timestamps and sum RSS per category at each ts.
    const catIds = Object.keys(CATEGORIES) as CategoryId[];
    const tsSet = new Set<number>();
    // Map<ts, Map<CategoryId, sumKb>>
    const byCatTs = new Map<number, Map<CategoryId, number>>();

    const iter = queryResult.iter({
      process_name: STR,
      ts: NUM,
      rss_bytes: NUM,
    });
    for (; iter.valid(); iter.next()) {
      const ts = iter.ts;
      tsSet.add(ts);
      let catMap = byCatTs.get(ts);
      if (catMap === undefined) {
        catMap = new Map();
        byCatTs.set(ts, catMap);
      }
      const cat = categorizeProcess(iter.process_name);
      const id = catIds.find((k) => CATEGORIES[k].name === cat.name)!;
      catMap.set(id, (catMap.get(id) ?? 0) + Math.round(iter.rss_bytes / 1024));
    }

    const timestamps = [...tsSet].sort((a, b) => a - b);
    if (timestamps.length < 2) return undefined;

    // Build one series per category.
    const pointsByCategory = new Map<CategoryId, {x: number; y: number}[]>();
    for (const id of catIds) {
      pointsByCategory.set(id, []);
    }
    for (const ts of timestamps) {
      const x = (ts - t0) / 1e9;
      const catMap = byCatTs.get(ts)!;
      for (const id of catIds) {
        pointsByCategory.get(id)!.push({x, y: catMap.get(id) ?? 0});
      }
    }

    const series: LineChartSeries[] = [];
    for (const id of catIds) {
      const points = pointsByCategory.get(id)!;
      if (points.some((p) => p.y > 0)) {
        const cat = CATEGORIES[id];
        series.push({name: cat.name, points, color: cat.color});
      }
    }
    if (series.length === 0) return undefined;
    return {series};
  }

  // ---------------------------------------------------------------------------
  // Drill-down: per-process RSS time-series for a single category.
  // ---------------------------------------------------------------------------

  private async queryDrilldownTimeSeries(
    engine: WasmEngineProxy,
    categoryId: CategoryId,
    t0: number = 0,
  ): Promise<LineChartData | undefined> {
    const queryResult = await engine.query(`
      SELECT
        p.name AS process_name,
        c.ts AS ts,
        c.value AS rss_bytes
      FROM counter c
      JOIN process_counter_track t ON c.track_id = t.id
      JOIN process p ON t.upid = p.upid
      WHERE t.name = 'mem.rss'
        AND p.name IS NOT NULL
      ORDER BY c.ts
    `);

    const targetCat = CATEGORIES[categoryId];

    // Collect timestamps and per-process RSS for matching processes.
    const tsSet = new Set<number>();
    // Map<ts, Map<processName, sumKb>> (sum handles multiple PIDs per name)
    const byProcTs = new Map<number, Map<string, number>>();

    const iter = queryResult.iter({
      process_name: STR,
      ts: NUM,
      rss_bytes: NUM,
    });
    for (; iter.valid(); iter.next()) {
      const cat = categorizeProcess(iter.process_name);
      if (cat.name !== targetCat.name) continue;

      const ts = iter.ts;
      tsSet.add(ts);
      let procMap = byProcTs.get(ts);
      if (procMap === undefined) {
        procMap = new Map();
        byProcTs.set(ts, procMap);
      }
      procMap.set(
        iter.process_name,
        (procMap.get(iter.process_name) ?? 0) +
          Math.round(iter.rss_bytes / 1024),
      );
    }

    const timestamps = [...tsSet].sort((a, b) => a - b);
    if (timestamps.length < 2) return undefined;

    // Discover all process names that appear.
    const allNames = new Set<string>();
    for (const procMap of byProcTs.values()) {
      for (const name of procMap.keys()) {
        allNames.add(name);
      }
    }

    // Build one series per process, aligned to all timestamps.
    const pointsByProc = new Map<string, {x: number; y: number}[]>();
    for (const name of allNames) {
      pointsByProc.set(name, []);
    }
    for (const ts of timestamps) {
      const x = (ts - t0) / 1e9;
      const procMap = byProcTs.get(ts)!;
      for (const name of allNames) {
        pointsByProc.get(name)!.push({x, y: procMap.get(name) ?? 0});
      }
    }

    // Sort series by total RSS descending, keep top 15.
    const ranked = [...allNames]
      .map((name) => {
        const points = pointsByProc.get(name)!;
        const total = points.reduce((s, p) => s + p.y, 0);
        return {name, points, total};
      })
      .sort((a, b) => b.total - a.total);

    const TOP_N = 15;
    const top = ranked.slice(0, TOP_N);
    const rest = ranked.slice(TOP_N);

    const series: LineChartSeries[] = top.map((r) => ({
      name: r.name,
      points: r.points,
    }));

    if (rest.length > 0) {
      const otherPoints = timestamps.map((ts, i) => {
        const x = (ts - t0) / 1e9;
        const y = rest.reduce((sum, r) => sum + r.points[i].y, 0);
        return {x, y};
      });
      series.push({
        name: `Other (${rest.length} processes)`,
        points: otherPoints,
        color: '#999',
      });
    }

    if (series.length === 0) return undefined;
    return {series};
  }

  // ---------------------------------------------------------------------------
  // PSI: memory pressure stall time over time (rate of change).
  // ---------------------------------------------------------------------------

  private async queryPsiTimeSeries(
    engine: WasmEngineProxy,
    t0: number,
  ): Promise<LineChartData | undefined> {
    const queryResult = await engine.query(`
      SELECT
        t.name AS counter_name,
        c.ts AS ts,
        c.value AS value_ns
      FROM counter c
      JOIN counter_track t ON c.track_id = t.id
      WHERE t.name IN ('psi.mem.some', 'psi.mem.full')
      ORDER BY c.ts
    `);

    // Group by counter name, then compute rate (delta_ns / delta_s → ms/s).
    const byName = new Map<string, {ts: number; value: number}[]>();
    const iter = queryResult.iter({
      counter_name: STR,
      ts: NUM,
      value_ns: NUM,
    });
    for (; iter.valid(); iter.next()) {
      let arr = byName.get(iter.counter_name);
      if (arr === undefined) {
        arr = [];
        byName.set(iter.counter_name, arr);
      }
      arr.push({ts: iter.ts, value: iter.value_ns});
    }

    const someRaw = byName.get('psi.mem.some');
    if (someRaw === undefined || someRaw.length < 2) return undefined;

    const toRatePoints = (
      raw: {ts: number; value: number}[],
    ): {x: number; y: number}[] => {
      const points: {x: number; y: number}[] = [];
      for (let i = 1; i < raw.length; i++) {
        const dtS = (raw[i].ts - raw[i - 1].ts) / 1e9;
        if (dtS <= 0) continue;
        const deltaNs = raw[i].value - raw[i - 1].value;
        // Convert ns stalled per second → ms stalled per second.
        const msPerSec = deltaNs / (dtS * 1e6);
        points.push({x: (raw[i].ts - t0) / 1e9, y: Math.max(0, msPerSec)});
      }
      return points;
    };

    const series: LineChartSeries[] = [];
    if (someRaw.length >= 2) {
      series.push({
        name: 'some (any task stalled)',
        points: toRatePoints(someRaw),
        color: '#f39c12',
      });
    }
    const fullRaw = byName.get('psi.mem.full');
    if (fullRaw !== undefined && fullRaw.length >= 2) {
      series.push({
        name: 'full (all tasks stalled)',
        points: toRatePoints(fullRaw),
        color: '#e74c3c',
      });
    }

    if (series.length === 0) return undefined;
    return {series};
  }

  // ---------------------------------------------------------------------------
  // Sankey: snapshot of where MemTotal is going right now.
  // ---------------------------------------------------------------------------

  private async querySankeyData(
    engine: WasmEngineProxy,
  ): Promise<SankeyData | undefined> {
    // 1. Latest system meminfo values.
    const sysCounters = [
      'MemTotal',
      'MemFree',
      'Buffers',
      'Cached',
      'AnonPages',
      'Slab',
      'KernelStack',
      'PageTables',
      'Active(file)',
      'Inactive(file)',
      'Shmem',
      'SwapTotal',
      'SwapFree',
    ];
    const sysNames = sysCounters.map((n) => `'${n}'`).join(',');
    const sysResult = await engine.query(`
      SELECT counter_name, value_bytes
      FROM (
        SELECT
          t.name AS counter_name,
          c.value AS value_bytes,
          ROW_NUMBER() OVER (PARTITION BY c.track_id ORDER BY c.ts DESC) AS rn
        FROM counter c
        JOIN counter_track t ON c.track_id = t.id
        WHERE t.name IN (${sysNames})
      )
      WHERE rn = 1
    `);

    const sys = new Map<string, number>();
    const sysIter = sysResult.iter({counter_name: STR, value_bytes: NUM});
    for (; sysIter.valid(); sysIter.next()) {
      sys.set(sysIter.counter_name, Math.round(sysIter.value_bytes / 1024));
    }

    const memTotal = sys.get('MemTotal');
    const memFree = sys.get('MemFree');
    const buffers = sys.get('Buffers');
    const cached = sys.get('Cached');
    if (
      memTotal === undefined ||
      memFree === undefined ||
      buffers === undefined ||
      cached === undefined
    ) {
      return undefined;
    }

    const anonPages = sys.get('AnonPages') ?? 0;
    const shmem = sys.get('Shmem') ?? 0;
    const fileCache = Math.max(0, cached - shmem);
    const slab = sys.get('Slab') ?? 0;
    const kernelStack = sys.get('KernelStack') ?? 0;
    const pageTables = sys.get('PageTables') ?? 0;

    const accounted =
      anonPages +
      shmem +
      fileCache +
      buffers +
      slab +
      pageTables +
      kernelStack +
      memFree;
    const otherKernel = Math.max(0, memTotal - accounted);

    // 2. Latest per-process RssAnon, grouped by category.
    const procResult = await engine.query(`
      SELECT process_name, rss_bytes
      FROM (
        SELECT
          p.name AS process_name,
          c.value AS rss_bytes,
          ROW_NUMBER() OVER (PARTITION BY c.track_id ORDER BY c.ts DESC) AS rn
        FROM counter c
        JOIN process_counter_track t ON c.track_id = t.id
        JOIN process p ON t.upid = p.upid
        WHERE t.name = 'mem.rss.anon'
          AND p.name IS NOT NULL
      )
      WHERE rn = 1
    `);

    const catIds = Object.keys(CATEGORIES) as CategoryId[];
    const catSums = new Map<CategoryId, number>();
    const procIter = procResult.iter({process_name: STR, rss_bytes: NUM});
    for (; procIter.valid(); procIter.next()) {
      const cat = categorizeProcess(procIter.process_name);
      const id = catIds.find((k) => CATEGORIES[k].name === cat.name)!;
      catSums.set(
        id,
        (catSums.get(id) ?? 0) + Math.round(procIter.rss_bytes / 1024),
      );
    }

    // 3. Build Sankey nodes and links.
    // Explicit depth: 0=MemTotal, 1=primary partitions, 2=detail breakdown.
    const nodes: {name: string; color?: string; depth?: number}[] = [
      {name: 'MemTotal', color: '#78909c', depth: 0},
    ];
    const links: {source: string; target: string; value: number}[] = [];

    // Level 1: MemTotal → primary partitions (matching the system chart).
    const addBucket = (name: string, value: number, color: string) => {
      if (value <= 0) return;
      nodes.push({name, color, depth: 1});
      links.push({source: 'MemTotal', target: name, value});
    };
    addBucket('AnonPages', anonPages, '#e74c3c');
    addBucket('Shmem', shmem, '#ab47bc');
    addBucket('File cache', fileCache, '#f39c12');
    addBucket('Buffers', buffers, '#3498db');
    addBucket('Slab', slab, '#9c27b0');
    addBucket('PageTables', pageTables, '#4a148c');
    addBucket('KernelStack', kernelStack, '#7b1fa2');
    addBucket('MemFree', memFree, '#2ecc71');
    addBucket('Other kernel', otherKernel, '#78909c');

    // Level 2: AnonPages → per-process-category breakdown.
    let accountedAnon = 0;
    for (const id of catIds) {
      const sum = catSums.get(id);
      if (sum !== undefined && sum > 0) {
        const cat = CATEGORIES[id];
        nodes.push({name: cat.name, color: cat.color, depth: 2});
        links.push({source: 'AnonPages', target: cat.name, value: sum});
        accountedAnon += sum;
      }
    }
    const unaccountedAnon = anonPages - accountedAnon;
    if (unaccountedAnon > 0) {
      nodes.push({
        name: 'Other (untracked)',
        color: '#9e9e9e',
        depth: 2,
      });
      links.push({
        source: 'AnonPages',
        target: 'Other (untracked)',
        value: unaccountedAnon,
      });
    }

    // Level 2: File cache → Active(file) + Inactive(file).
    const activeFile = sys.get('Active(file)') ?? 0;
    const inactiveFile = sys.get('Inactive(file)') ?? 0;
    if (fileCache > 0) {
      if (activeFile > 0) {
        nodes.push({name: 'Active(file)', color: '#f1c40f', depth: 2});
        links.push({
          source: 'File cache',
          target: 'Active(file)',
          value: activeFile,
        });
      }
      if (inactiveFile > 0) {
        nodes.push({name: 'Inactive(file)', color: '#e67e22', depth: 2});
        links.push({
          source: 'File cache',
          target: 'Inactive(file)',
          value: inactiveFile,
        });
      }
    }

    if (links.length === 0) return undefined;
    return {nodes, links};
  }

  // ---------------------------------------------------------------------------
  // Latest per-process memory (for the table).
  // ---------------------------------------------------------------------------

  private async queryLatestProcessMemory(
    engine: WasmEngineProxy,
  ): Promise<ProcessMemoryRow[]> {
    // Pivot latest counter values per process across multiple track names.
    const queryResult = await engine.query(`
      SELECT
        p.name AS process_name,
        p.pid AS pid,
        MAX(CASE WHEN t.name = 'mem.rss' THEN latest.value END) AS rss_bytes,
        MAX(CASE WHEN t.name = 'mem.rss.anon' THEN latest.value END) AS anon_bytes,
        MAX(CASE WHEN t.name = 'mem.rss.file' THEN latest.value END) AS file_bytes,
        MAX(CASE WHEN t.name = 'mem.rss.shmem' THEN latest.value END) AS shmem_bytes,
        MAX(CASE WHEN t.name = 'mem.swap' THEN latest.value END) AS swap_bytes,
        MAX(CASE WHEN t.name = 'oom_score_adj' THEN latest.value END) AS oom_score
      FROM (
        SELECT
          c.track_id,
          c.value,
          ROW_NUMBER() OVER (PARTITION BY c.track_id ORDER BY c.ts DESC) AS rn
        FROM counter c
        JOIN process_counter_track t ON c.track_id = t.id
        WHERE t.name IN ('mem.rss', 'mem.rss.anon', 'mem.rss.file',
                         'mem.rss.shmem', 'mem.swap', 'oom_score_adj')
      ) latest
      JOIN process_counter_track t ON latest.track_id = t.id
      JOIN process p ON t.upid = p.upid
      WHERE latest.rn = 1
        AND p.name IS NOT NULL
      GROUP BY p.upid
      ORDER BY rss_bytes DESC
    `);

    const rows: ProcessMemoryRow[] = [];
    const iter = queryResult.iter({
      process_name: STR,
      pid: NUM,
      rss_bytes: NUM,
      anon_bytes: NUM,
      file_bytes: NUM,
      shmem_bytes: NUM,
      swap_bytes: NUM,
      oom_score: NUM,
    });

    for (; iter.valid(); iter.next()) {
      rows.push({
        processName: iter.process_name,
        pid: iter.pid,
        rssKb: Math.round(iter.rss_bytes / 1024),
        anonKb: Math.round(iter.anon_bytes / 1024),
        fileKb: Math.round(iter.file_bytes / 1024),
        shmemKb: Math.round(iter.shmem_bytes / 1024),
        swapKb: Math.round(iter.swap_bytes / 1024),
        oomScore: iter.oom_score,
      });
    }
    return rows;
  }
}

function panel(
  title: string,
  subtitle: string | undefined,
  body: m.Children,
): m.Children {
  return m(
    '.pf-live-memory-panel',
    m(
      '.pf-live-memory-panel__header',
      m('h2', title),
      subtitle !== undefined && m('p', subtitle),
    ),
    m('.pf-live-memory-panel__body', body),
  );
}

function formatKb(kb: number): string {
  if (kb < 1024) return `${kb.toLocaleString()} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${(kb / (1024 * 1024)).toFixed(1)} GB`;
}
