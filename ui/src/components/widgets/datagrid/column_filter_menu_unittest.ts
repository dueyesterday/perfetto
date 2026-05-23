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
import type {SqlValue} from '../../../trace_processor/query_result';
import {
  DistinctValuesSubmenu,
  EditFilterMenu,
  type EditFilterMenuAttrs,
  isEditableFilter,
  TextFilterSubmenu,
} from './column_filter_menu';
import type {DataSource} from './data_source';
import type {ColumnType} from './datagrid_schema';
import type {FilterOpAndValue} from './model';

// Minimal DataSource stub. EditFilterMenu only forwards the datasource
// to DistinctValuesSubmenu, which calls useDistinctValues; everything
// else throws if accessed (tests should fail loudly on unexpected use).
function makeStubDataSource(distinctData?: readonly SqlValue[]): DataSource {
  return {
    useDistinctValues: () => ({
      data: distinctData,
      isPending: distinctData === undefined,
      isFresh: true,
    }),
  } as unknown as DataSource;
}

// Helper: render EditFilterMenu's view() and return the resulting
// vnode (or null). Tests inspect tag + attrs to assert dispatch.
function editView(
  initialFilter: FilterOpAndValue,
  columnType: ColumnType | undefined,
  overrides: Partial<EditFilterMenuAttrs> = {},
): m.Children {
  const inst = new EditFilterMenu();
  return inst.view({
    attrs: {
      datasource: makeStubDataSource(['a', 'b', 'c']),
      field: 'col',
      columnType,
      valueFormatter: (v) => String(v),
      initialFilter,
      onFilterReplace: vi.fn(),
      ...overrides,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

// Narrow a Children return to a single Vnode for assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asVnode(c: m.Children): m.Vnode<any, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c as unknown as m.Vnode<any, any>;
}

describe('EditFilterMenu — dispatch by op', () => {
  test('in → DistinctValuesSubmenu with array seed', () => {
    const v = asVnode(editView({op: 'in', value: ['x', 'y']}, 'text'));
    expect(v.tag).toBe(DistinctValuesSubmenu);
    expect(v.attrs.initialSelectedValues).toEqual(['x', 'y']);
    expect(v.attrs.excludeNull).toBe(true);
  });

  test('not in → DistinctValuesSubmenu with array seed', () => {
    const v = asVnode(editView({op: 'not in', value: ['a']}, 'text'));
    expect(v.tag).toBe(DistinctValuesSubmenu);
    expect(v.attrs.initialSelectedValues).toEqual(['a']);
  });

  test('= on text → DistinctValuesSubmenu with single-element seed', () => {
    const v = asVnode(editView({op: '=', value: 'foo'}, 'text'));
    expect(v.tag).toBe(DistinctValuesSubmenu);
    expect(v.attrs.initialSelectedValues).toEqual(['foo']);
  });

  test('= on identifier → DistinctValuesSubmenu', () => {
    const v = asVnode(editView({op: '=', value: 42}, 'identifier'));
    expect(v.tag).toBe(DistinctValuesSubmenu);
    expect(v.attrs.initialSelectedValues).toEqual([42]);
  });

  test('= on undefined column type → DistinctValuesSubmenu', () => {
    const v = asVnode(editView({op: '=', value: 'foo'}, undefined));
    expect(v.tag).toBe(DistinctValuesSubmenu);
  });

  test('= on quantitative → TextFilterSubmenu(number)', () => {
    const v = asVnode(editView({op: '=', value: 100}, 'quantitative'));
    expect(v.tag).toBe(TextFilterSubmenu);
    expect(v.attrs.inputType).toBe('number');
    expect(v.attrs.initialValue).toBe('100');
    expect(v.attrs.submitLabel).toBe('Save');
  });

  test('!= on text → DistinctValuesSubmenu', () => {
    const v = asVnode(editView({op: '!=', value: 'foo'}, 'text'));
    expect(v.tag).toBe(DistinctValuesSubmenu);
  });

  test('!= on quantitative → TextFilterSubmenu(number)', () => {
    const v = asVnode(editView({op: '!=', value: 1}, 'quantitative'));
    expect(v.tag).toBe(TextFilterSubmenu);
    expect(v.attrs.inputType).toBe('number');
  });

  test.each(['<', '<=', '>', '>='] as const)(
    '%s → TextFilterSubmenu(number)',
    (op) => {
      const v = asVnode(editView({op, value: 100}, 'quantitative'));
      expect(v.tag).toBe(TextFilterSubmenu);
      expect(v.attrs.inputType).toBe('number');
      expect(v.attrs.initialValue).toBe('100');
      expect(v.attrs.submitLabel).toBe('Save');
    },
  );

  test.each(['glob', 'not glob'] as const)(
    '%s → TextFilterSubmenu(text)',
    (op) => {
      const v = asVnode(editView({op, value: '*hello*'}, 'text'));
      expect(v.tag).toBe(TextFilterSubmenu);
      expect(v.attrs.inputType).toBe('text');
      expect(v.attrs.initialValue).toBe('*hello*');
    },
  );

  test('is null → null (no editor)', () => {
    expect(editView({op: 'is null'}, 'text')).toBeNull();
  });

  test('is not null → null (no editor)', () => {
    expect(editView({op: 'is not null'}, 'quantitative')).toBeNull();
  });

  test('malformed {op: "=", value: null} → null (refuse to edit)', () => {
    // This shape never comes from add-mode (multi-select emits arrays)
    // but is legal per the FilterOpAndValue type. Treat it as
    // uneditable rather than rendering an incoherent empty editor.
    expect(editView({op: '=', value: null}, 'quantitative')).toBeNull();
    expect(editView({op: '!=', value: null}, 'text')).toBeNull();
    expect(editView({op: '>', value: null}, 'quantitative')).toBeNull();
    expect(editView({op: 'glob', value: null}, 'text')).toBeNull();
  });
});

describe('isEditableFilter', () => {
  test('null-arity ops are not editable', () => {
    expect(isEditableFilter({op: 'is null'})).toBe(false);
    expect(isEditableFilter({op: 'is not null'})).toBe(false);
  });

  test('value-bearing ops with null value are not editable', () => {
    expect(isEditableFilter({op: '=', value: null})).toBe(false);
    expect(isEditableFilter({op: '!=', value: null})).toBe(false);
    expect(isEditableFilter({op: '>', value: null})).toBe(false);
    expect(isEditableFilter({op: 'glob', value: null})).toBe(false);
  });

  test('value-bearing ops with a concrete value are editable', () => {
    expect(isEditableFilter({op: '=', value: 'foo'})).toBe(true);
    expect(isEditableFilter({op: '>', value: 42})).toBe(true);
    expect(isEditableFilter({op: 'glob', value: '*x*'})).toBe(true);
  });

  test('in / not in are always editable (array value)', () => {
    expect(isEditableFilter({op: 'in', value: ['a']})).toBe(true);
    expect(isEditableFilter({op: 'not in', value: []})).toBe(true);
  });
});

describe('EditFilterMenu — op promotion on save', () => {
  test('= on text + apply emits {op: "in", value: [...]}', () => {
    const onFilterReplace = vi.fn();
    const v = asVnode(
      editView({op: '=', value: 'foo'}, 'text', {onFilterReplace}),
    );
    v.attrs.onApply(new Set(['foo', 'bar']));
    expect(onFilterReplace).toHaveBeenCalledWith({
      op: 'in',
      value: ['foo', 'bar'],
    });
  });

  test('!= on text + apply emits {op: "not in", value: [...]}', () => {
    const onFilterReplace = vi.fn();
    const v = asVnode(
      editView({op: '!=', value: 'foo'}, 'text', {onFilterReplace}),
    );
    v.attrs.onApply(new Set(['baz']));
    expect(onFilterReplace).toHaveBeenCalledWith({
      op: 'not in',
      value: ['baz'],
    });
  });

  test('= on quantitative + apply preserves op', () => {
    const onFilterReplace = vi.fn();
    const v = asVnode(
      editView({op: '=', value: 100}, 'quantitative', {onFilterReplace}),
    );
    v.attrs.onApply(200);
    expect(onFilterReplace).toHaveBeenCalledWith({op: '=', value: 200});
  });

  test('in + apply preserves op', () => {
    const onFilterReplace = vi.fn();
    const v = asVnode(
      editView({op: 'in', value: ['a']}, 'text', {onFilterReplace}),
    );
    v.attrs.onApply(new Set(['a', 'b', 'c']));
    expect(onFilterReplace).toHaveBeenCalledWith({
      op: 'in',
      value: ['a', 'b', 'c'],
    });
  });

  test('> + apply preserves op', () => {
    const onFilterReplace = vi.fn();
    const v = asVnode(
      editView({op: '>', value: 100}, 'quantitative', {onFilterReplace}),
    );
    v.attrs.onApply(500);
    expect(onFilterReplace).toHaveBeenCalledWith({op: '>', value: 500});
  });

  test('glob + apply preserves op', () => {
    const onFilterReplace = vi.fn();
    const v = asVnode(
      editView({op: 'glob', value: '*x*'}, 'text', {onFilterReplace}),
    );
    v.attrs.onApply('*y*');
    expect(onFilterReplace).toHaveBeenCalledWith({op: 'glob', value: '*y*'});
  });
});

describe('TextFilterSubmenu — initial state', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('initialValue pre-fills the input', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.render(
      root,
      m(TextFilterSubmenu, {
        inputType: 'text',
        initialValue: 'hello world',
        onApply: vi.fn(),
      }),
    );
    const input = root.querySelector('input') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input!.value).toBe('hello world');
  });

  test('submitLabel overrides the default "Add Filter" label', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.render(
      root,
      m(TextFilterSubmenu, {
        inputType: 'text',
        submitLabel: 'Save Filter',
        onApply: vi.fn(),
      }),
    );
    expect(root.textContent).toContain('Save Filter');
    expect(root.textContent).not.toContain('Add Filter');
  });

  test('default submitLabel is "Add Filter" when not overridden', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.render(
      root,
      m(TextFilterSubmenu, {
        inputType: 'text',
        onApply: vi.fn(),
      }),
    );
    expect(root.textContent).toContain('Add Filter');
  });

  // Helpers for the numeric-coercion tests below. Submitting the form
  // takes a click on the submit button.
  function submitForm(root: HTMLElement): void {
    const submit = root.querySelector(
      'button[type=submit]',
    ) as HTMLButtonElement | null;
    expect(submit).not.toBeNull();
    submit!.click();
  }

  test('numeric input within safe-integer range emits number', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const onApply = vi.fn();
    m.render(
      root,
      m(TextFilterSubmenu, {
        inputType: 'number',
        initialValue: '1234',
        onApply,
      }),
    );
    submitForm(root);
    expect(onApply).toHaveBeenCalledWith(1234);
    expect(typeof onApply.mock.calls[0][0]).toBe('number');
  });

  test('numeric input past MAX_SAFE_INTEGER emits bigint (no precision loss)', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const onApply = vi.fn();
    m.render(
      root,
      m(TextFilterSubmenu, {
        inputType: 'number',
        // 2^53 + 1: not representable as a JS number without precision loss.
        initialValue: '9007199254740993',
        onApply,
      }),
    );
    submitForm(root);
    expect(typeof onApply.mock.calls[0][0]).toBe('bigint');
    expect(onApply).toHaveBeenCalledWith(BigInt('9007199254740993'));
  });

  test('numeric input below MIN_SAFE_INTEGER emits bigint', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const onApply = vi.fn();
    m.render(
      root,
      m(TextFilterSubmenu, {
        inputType: 'number',
        initialValue: '-9007199254740993',
        onApply,
      }),
    );
    submitForm(root);
    expect(typeof onApply.mock.calls[0][0]).toBe('bigint');
    expect(onApply).toHaveBeenCalledWith(BigInt('-9007199254740993'));
  });

  test('numeric input with a decimal stays as a number (BigInt only for integers)', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const onApply = vi.fn();
    m.render(
      root,
      m(TextFilterSubmenu, {
        inputType: 'number',
        initialValue: '1.5',
        onApply,
      }),
    );
    submitForm(root);
    expect(typeof onApply.mock.calls[0][0]).toBe('number');
    expect(onApply).toHaveBeenCalledWith(1.5);
  });
});

describe('DistinctValuesSubmenu — initial state', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  // Locate the Apply MenuItem's button via its label child (the icon
  // glyph contributes text to the button's textContent, so we filter
  // on the inner .pf-menu-item__label instead).
  function findApplyButton(root: HTMLElement): HTMLButtonElement | undefined {
    const labels = Array.from(
      root.querySelectorAll('.pf-menu-item__label'),
    ) as HTMLElement[];
    const applyLabel = labels.find(
      (el) => (el.textContent ?? '').trim() === 'Apply',
    );
    return (
      (applyLabel?.closest(
        'button.pf-menu-item',
      ) as HTMLButtonElement | null) ?? undefined
    );
  }

  test('initialSelectedValues enables the Apply button (non-empty seed)', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.render(
      root,
      m(DistinctValuesSubmenu, {
        datasource: makeStubDataSource(['a', 'b', 'c']),
        field: 'col',
        valueFormatter: (v) => String(v),
        initialSelectedValues: ['a'],
        onApply: vi.fn(),
      }),
    );
    const applyButton = findApplyButton(root);
    expect(applyButton).toBeDefined();
    expect(applyButton!.disabled).toBe(false);
  });

  test('no initialSelectedValues: Apply is disabled (empty seed)', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.render(
      root,
      m(DistinctValuesSubmenu, {
        datasource: makeStubDataSource(['a', 'b', 'c']),
        field: 'col',
        valueFormatter: (v) => String(v),
        onApply: vi.fn(),
      }),
    );
    const applyButton = findApplyButton(root);
    expect(applyButton).toBeDefined();
    expect(applyButton!.disabled).toBe(true);
  });

  // Return the visible distinct-value labels in DOM order (excludes
  // Apply / Clear footer items, which live in a sibling __footer).
  function listLabels(root: HTMLElement): string[] {
    const items = Array.from(
      root.querySelectorAll('.pf-distinct-values-menu__list .pf-menu-item'),
    ) as HTMLElement[];
    return items.map((el) => {
      const label = el.querySelector('.pf-menu-item__label');
      return (label?.textContent ?? '').trim();
    });
  }

  test('pinned: initial selection renders at the top in original order', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.render(
      root,
      m(DistinctValuesSubmenu, {
        datasource: makeStubDataSource(['alpha', 'beta', 'gamma', 'delta']),
        field: 'col',
        valueFormatter: (v) => String(v),
        // gamma comes after alpha+beta in the source list but pinning
        // bumps both pinned items to the top, preserving the source
        // order WITHIN the pinned group.
        initialSelectedValues: ['gamma', 'alpha'],
        onApply: vi.fn(),
      }),
    );
    // Pinned items first (in source order: alpha before gamma),
    // then the unpinned rest (in source order: beta, delta).
    expect(listLabels(root)).toEqual(['alpha', 'gamma', 'beta', 'delta']);
  });

  test('pinned: divider sits between pinned and unpinned groups', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.render(
      root,
      m(DistinctValuesSubmenu, {
        datasource: makeStubDataSource(['a', 'b', 'c']),
        field: 'col',
        valueFormatter: (v) => String(v),
        initialSelectedValues: ['b'],
        onApply: vi.fn(),
      }),
    );
    const dividers = root.querySelectorAll(
      '.pf-distinct-values-menu__list .pf-menu-divider',
    );
    expect(dividers.length).toBe(1);
  });

  test('pinned: no divider when nothing is pinned', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.render(
      root,
      m(DistinctValuesSubmenu, {
        datasource: makeStubDataSource(['a', 'b', 'c']),
        field: 'col',
        valueFormatter: (v) => String(v),
        // no initialSelectedValues → empty pinned set
        onApply: vi.fn(),
      }),
    );
    const dividers = root.querySelectorAll(
      '.pf-distinct-values-menu__list .pf-menu-divider',
    );
    expect(dividers.length).toBe(0);
  });

  test('pinned: no divider when EVERY visible item is pinned', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.render(
      root,
      m(DistinctValuesSubmenu, {
        datasource: makeStubDataSource(['a', 'b', 'c']),
        field: 'col',
        valueFormatter: (v) => String(v),
        initialSelectedValues: ['a', 'b', 'c'],
        onApply: vi.fn(),
      }),
    );
    const dividers = root.querySelectorAll(
      '.pf-distinct-values-menu__list .pf-menu-divider',
    );
    expect(dividers.length).toBe(0);
    // All three items still shown (in source order).
    expect(listLabels(root)).toEqual(['a', 'b', 'c']);
  });

  test('value-equality: pinned Uint8Array matches a distinct DIFFERENT instance with same bytes', () => {
    // The bug fixed here: JS Sets use SameValueZero, which is reference
    // equality for Uint8Array. Without the stable-key fix, an external
    // initial value (one reference) and the data source's distinct
    // value (a different reference, same bytes) compare as different.
    const root = document.createElement('div');
    document.body.appendChild(root);
    const fromDataSource = new Uint8Array([1, 2, 3]);
    const fromExternalFilter = new Uint8Array([1, 2, 3]);
    m.render(
      root,
      m(DistinctValuesSubmenu, {
        datasource: makeStubDataSource([fromDataSource]),
        field: 'col',
        // Tag both blobs with the same label so the order check
        // doesn't get confused; bytes are what matters for membership.
        valueFormatter: () => 'blob',
        initialSelectedValues: [fromExternalFilter],
        onApply: vi.fn(),
      }),
    );
    // The blob renders as a pinned item (visible exactly once) and
    // shows as already-selected (filled checkbox icon, Apply enabled).
    expect(listLabels(root)).toEqual(['blob']);
    expect(findApplyButton(root)!.disabled).toBe(false);
  });

  test('value-equality: bigint pinning works (same numeric value across separate BigInt instances)', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.render(
      root,
      m(DistinctValuesSubmenu, {
        // 10n past Number.MAX_SAFE_INTEGER ensures we'd lose precision
        // if we coerced through Number. Bigints compare equal by value,
        // but mixing in other ops requires consistent string keys.
        datasource: makeStubDataSource([BigInt('9007199254740993')]),
        field: 'col',
        valueFormatter: (v) => String(v),
        initialSelectedValues: [BigInt('9007199254740993')],
        onApply: vi.fn(),
      }),
    );
    expect(listLabels(root)).toEqual(['9007199254740993']);
    expect(findApplyButton(root)!.disabled).toBe(false);
  });

  test('apply emits canonical SqlValue references from the data source (not the seed copies)', async () => {
    // When initialSelectedValues seeds a blob value but the data source
    // returns a different-reference identical blob, Apply must emit the
    // data-source's reference (or at minimum a value-equal one) — not
    // throw, not skip the entry.
    const root = document.createElement('div');
    document.body.appendChild(root);
    const canonical = new Uint8Array([7, 7, 7]);
    let captured: Set<SqlValue> | undefined;
    m.render(
      root,
      m(DistinctValuesSubmenu, {
        datasource: makeStubDataSource([canonical]),
        field: 'col',
        valueFormatter: () => 'blob',
        initialSelectedValues: [new Uint8Array([7, 7, 7])],
        onApply: (vals) => {
          captured = vals;
        },
      }),
    );
    findApplyButton(root)!.click();
    expect(captured).toBeDefined();
    expect(captured!.size).toBe(1);
    // Canonical reference from the data source (preferred over the seed).
    expect([...captured!][0]).toBe(canonical);
  });
});
