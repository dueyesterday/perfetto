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

// Unified "jump to anything" command palette (Ctrl/Cmd+K). One fuzzy-searched
// surface over three kinds of target — commands, pages, and (when a trace is
// loaded) tracks — so the user can run, navigate, or reveal from a single
// keystroke instead of hunting across the topbar command box and the separate
// track finder.

import './command_palette.scss';
import m from 'mithril';
import {AppImpl} from '../core/app_impl';
import {Router} from '../core/router';
import {closeModal, redrawModal, showModal} from '../widgets/modal';
import {FuzzyFinder, type FuzzySegment} from '../base/fuzzy';
import {Icon} from '../widgets/icon';
import {HotkeyGlyphs} from '../widgets/hotkey_glyphs';
import type {Hotkey} from '../base/hotkeys';

const PALETTE_KEY = 'pf-command-palette';

type ItemKind = 'page' | 'track' | 'command';

interface PaletteItem {
  readonly kind: ItemKind;
  readonly title: string;
  readonly subtitle?: string;
  readonly icon: string;
  readonly hotkey?: Hotkey;
  readonly run: () => void;
}

// Sections are rendered (and keyboard-traversed) in this order.
const SECTION_ORDER: ReadonlyArray<ItemKind> = ['page', 'track', 'command'];
const SECTION_LABEL: Record<ItemKind, string> = {
  page: 'Pages',
  track: 'Tracks',
  command: 'Commands',
};
const SECTION_CAP: Record<ItemKind, number> = {page: 100, track: 40, command: 60};

// PageHandler carries no human title/icon, so map the known routes here. Any
// unmapped route still appears, labelled by its raw route string.
const PAGE_META: Record<string, {title: string; icon: string}> = {
  '/': {title: 'Home', icon: 'home'},
  '/viewer': {title: 'Timeline', icon: 'timeline'},
  '/query': {title: 'Query (SQL)', icon: 'database'},
  '/explore': {title: 'Data Explorer', icon: 'data_exploration'},
  '/metrics': {title: 'Metrics', icon: 'speed'},
  '/info': {title: 'Trace Info', icon: 'info'},
  '/settings': {title: 'Settings', icon: 'settings'},
  '/flags': {title: 'Flags', icon: 'flag'},
  '/plugins': {title: 'Plugins', icon: 'extension'},
  '/widgets': {title: 'Widgets', icon: 'widgets'},
  '/record': {title: 'Record New Trace', icon: 'fiber_smart_record'},
};

function buildItems(app: AppImpl): PaletteItem[] {
  const items: PaletteItem[] = [];

  for (const p of app.pages.listPages()) {
    const meta = PAGE_META[p.route];
    items.push({
      kind: 'page',
      title: meta?.title ?? p.route,
      subtitle: 'Go to page',
      icon: meta?.icon ?? 'description',
      run: () => Router.navigate(`#!${p.route}`),
    });
  }

  const trace = app.trace;
  if (trace !== undefined) {
    for (const node of trace.currentWorkspace.flatTracksOrdered) {
      const uri = node.uri;
      if (uri === undefined) continue; // group/container rows aren't jumpable
      const path = node.fullPath.slice(0, -1).join(' › ');
      items.push({
        kind: 'track',
        title: node.name,
        subtitle: path.length > 0 ? path : 'Reveal track',
        icon: 'show_chart',
        run: () => trace.selection.selectTrack(uri, {scrollToSelection: true}),
      });
    }
  }

  for (const c of app.commands.getCommands()) {
    items.push({
      kind: 'command',
      title: c.name,
      subtitle: 'Run command',
      icon: 'bolt',
      hotkey: c.defaultHotkey,
      run: () => app.commands.runCommand(c.id),
    });
  }

  return items;
}

interface Row {
  readonly item: PaletteItem;
  readonly segments: FuzzySegment[];
  readonly index: number; // position in the flat, ordered visible list
}

// Holds the live palette state for one open session.
class PaletteState {
  query = '';
  active = 0;
  visibleCount = 0;
  sections: Array<{kind: ItemKind; rows: Row[]}> = [];
  private readonly finders: Record<ItemKind, FuzzyFinder<PaletteItem>>;

  constructor(app: AppImpl) {
    const items = buildItems(app);
    const byKind = (k: ItemKind) =>
      new FuzzyFinder(
        items.filter((it) => it.kind === k),
        (it) => it.title,
      );
    this.finders = {page: byKind('page'), track: byKind('track'), command: byKind('command')};
    this.recompute();
  }

  setQuery(q: string) {
    this.query = q;
    this.active = 0;
    this.recompute();
  }

  move(delta: number) {
    if (this.visibleCount === 0) return;
    this.active = (this.active + delta + this.visibleCount) % this.visibleCount;
  }

  chosen(): PaletteItem | undefined {
    for (const s of this.sections) {
      for (const r of s.rows) if (r.index === this.active) return r.item;
    }
    return undefined;
  }

  private recompute() {
    this.sections = [];
    let i = 0;
    for (const kind of SECTION_ORDER) {
      const found = this.finders[kind].find(this.query).slice(0, SECTION_CAP[kind]);
      if (found.length === 0) continue;
      const rows: Row[] = found.map((r) => ({item: r.item, segments: r.segments, index: i++}));
      this.sections.push({kind, rows});
    }
    this.visibleCount = i;
    if (this.active >= this.visibleCount) {
      this.active = Math.max(0, this.visibleCount - 1);
    }
  }
}

function renderSegments(segments: FuzzySegment[]): m.Children {
  return segments.map((s) =>
    s.matching ? m('span.pf-cmdp__match', s.value) : s.value,
  );
}

// Opens the command palette. Safe to call repeatedly; showModal replaces any
// existing palette instance.
export function openCommandPalette() {
  const app = AppImpl.instance;
  const state = new PaletteState(app);

  const choose = (item?: PaletteItem) => {
    if (item === undefined) return;
    closeModal(PALETTE_KEY);
    // Defer the action one tick so the modal teardown render finishes first
    // (navigating / running a command mid-close fights the unmount).
    setTimeout(() => item.run(), 0);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        state.move(1);
        redrawModal();
        break;
      case 'ArrowUp':
        e.preventDefault();
        state.move(-1);
        redrawModal();
        break;
      case 'Enter':
        e.preventDefault();
        choose(state.chosen());
        break;
      case 'Escape':
        e.preventDefault();
        closeModal(PALETTE_KEY);
        break;
    }
  };

  showModal({
    key: PALETTE_KEY,
    title: '',
    className: 'pf-command-palette-modal',
    vAlign: 'TOP',
    content: () =>
      m('.pf-cmdp', [
        m('.pf-cmdp__search', [
          m(Icon, {icon: 'search', className: 'pf-cmdp__search-icon'}),
          m('input.pf-cmdp__input[type=text]', {
            placeholder: 'Jump to a command, page, or track…',
            value: state.query,
            oncreate: (v: m.VnodeDOM) => (v.dom as HTMLInputElement).focus(),
            oninput: (e: Event) => {
              state.setQuery((e.target as HTMLInputElement).value);
              redrawModal();
            },
            onkeydown: onKeyDown,
          }),
          m('kbd.pf-cmdp__esc', 'Esc'),
        ]),
        m(
          '.pf-cmdp__results',
          state.visibleCount === 0
            ? m('.pf-cmdp__empty', 'No matches')
            : state.sections.map((section) =>
                m('.pf-cmdp__section', [
                  m('.pf-cmdp__section-label', SECTION_LABEL[section.kind]),
                  section.rows.map((row) =>
                    m(
                      '.pf-cmdp__row',
                      {
                        className:
                          row.index === state.active ? 'pf-cmdp__row--active' : '',
                        onclick: () => choose(row.item),
                      },
                      m(Icon, {icon: row.item.icon, className: 'pf-cmdp__row-icon'}),
                      m('.pf-cmdp__row-text', [
                        m('.pf-cmdp__row-title', renderSegments(row.segments)),
                        row.item.subtitle &&
                          m('.pf-cmdp__row-sub', row.item.subtitle),
                      ]),
                      row.item.hotkey &&
                        m(HotkeyGlyphs, {hotkey: row.item.hotkey}),
                    ),
                  ),
                ]),
              ),
        ),
      ]),
  });
}
