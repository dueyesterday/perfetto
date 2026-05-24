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
import {FuzzyFinder} from '../../../base/fuzzy';
import {isEmptyVnodes} from '../../../base/mithril_utils';
import {Icons} from '../../../base/semantic_icons';
import type {SqlValue} from '../../../trace_processor/query_result';
import {EmptyState} from '../../../widgets/empty_state';
import {Form} from '../../../widgets/form';
import {Icon} from '../../../widgets/icon';
import {MenuDivider, MenuItem} from '../../../widgets/menu';
import {TextInput} from '../../../widgets/text_input';
import type {DataSource} from './data_source';
import type {ColumnType} from './datagrid_schema';
import type {FilterOpAndValue} from './model';

// Helper to convert search text to case-insensitive glob pattern
export function toCaseInsensitiveGlob(text: string): string {
  const pattern = text
    .split('')
    .map((char) => {
      const lower = char.toLowerCase();
      const upper = char.toUpperCase();
      // Only create character class for letters
      if (lower !== upper) {
        return `[${lower}${upper}]`;
      }
      // Non-letters remain as-is
      return char;
    })
    .join('');
  return `*${pattern}*`;
}

// Helper component to manage distinct values selection
interface DistinctValuesSubmenuAttrs {
  readonly datasource: DataSource;
  readonly field: string;
  readonly excludeNull?: boolean;
  readonly valueFormatter: (value: SqlValue) => string;
  // Pre-selected values shown ticked when the submenu mounts. Read once
  // in oninit so in-flight user edits aren't clobbered by parent
  // re-renders. Default: empty set (add-mode).
  readonly initialSelectedValues?: ReadonlyArray<SqlValue>;
  readonly onApply: (selectedValues: Set<SqlValue>) => void;
}

// Stable string key for value-equality on SqlValue, including types
// that JS Sets compare by reference (Uint8Array). Used as the key type
// for selectedKeys / pinnedKeys so that an externally-provided value
// (e.g. an existing filter's value) compares equal to the
// corresponding entry returned by useDistinctValues, even though they
// are distinct JS references.
//
// Each branch is prefix-tagged so different SqlValue *families* can't
// collide (e.g. the string "123" and the number 123 get different
// keys). Integers from `number` and `bigint` are normalized to the
// SAME key — the same logical SQL integer should match regardless of
// the JS type the data source happens to return it in. Floats and
// non-integer numbers get the 'd:' prefix so they can't collide with
// integer-typed bigints.
function sqlValueKey(v: SqlValue): string {
  if (v === null) return 'n:';
  if (typeof v === 'bigint') return 'i:' + v.toString();
  if (typeof v === 'number') {
    // Number.isInteger is true for finite values that are mathematical
    // integers in float64 representation (so 2**53 + 1 is "integer"
    // because it rounds to 2**53). That's the right semantic: if a
    // number lost precision becoming integer, treat it as the integer
    // it now is.
    if (Number.isInteger(v)) return 'i:' + v.toString();
    return 'd:' + String(v);
  }
  if (typeof v === 'string') return 's:' + v;
  if (v instanceof Uint8Array) {
    let s = 'x:';
    for (const byte of v) s += byte.toString(16).padStart(2, '0');
    return s;
  }
  return 'u:' + String(v);
}

export class DistinctValuesSubmenu
  implements m.ClassComponent<DistinctValuesSubmenuAttrs>
{
  // Tracked as KEYS (not values) so cross-source comparisons work:
  // initialSelectedValues from a parent filter and the data-source's
  // distinct values are different JS references for blobs / objects,
  // and reference-equality Sets would treat them as different.
  private selectedKeys = new Set<string>();
  // Frozen set of keys for the values that were selected when this
  // submenu mounted. Used to pin those items to the top of the list —
  // so edit-mode users see what's already selected immediately, and so
  // toggling during editing doesn't cause items to jump around. Stable
  // for the component's lifetime; not updated when the user toggles.
  private pinnedKeys = new Set<string>();
  // Lookup table: key → canonical SqlValue reference. Populated from
  // both initialSelectedValues (oninit) and from useDistinctValues
  // (each view) so onApply can emit the right references even for the
  // pinned-but-not-in-current-distinct edge case (e.g. a filter on a
  // value that's been deleted from the underlying data).
  private keyToValue = new Map<string, SqlValue>();
  private searchQuery = '';
  private static readonly MAX_VISIBLE_ITEMS = 100;

  oninit({attrs}: m.Vnode<DistinctValuesSubmenuAttrs>) {
    if (attrs.initialSelectedValues !== undefined) {
      for (const v of attrs.initialSelectedValues) {
        const k = sqlValueKey(v);
        this.selectedKeys.add(k);
        this.pinnedKeys.add(k);
        this.keyToValue.set(k, v);
      }
    }
  }

  view({attrs}: m.Vnode<DistinctValuesSubmenuAttrs>) {
    const {datasource, field, excludeNull, valueFormatter, onApply} = attrs;

    // Fetch distinct values - only called when submenu is visible
    const {data, isPending} = datasource.useDistinctValues(field);

    if (isPending || data === undefined) {
      return m('.pf-distinct-values-menu', [
        m(MenuItem, {label: 'Loading...', disabled: true}),
      ]);
    }

    // Filter out null if requested (use "is null" filter instead)
    const distinctValues = excludeNull ? data.filter((v) => v !== null) : data;

    // Refresh the key→value lookup with whatever the data source
    // returned this render. The data source's references are
    // preferred (canonical) but stale entries from oninit survive as
    // fallbacks for pinned-not-in-distinct.
    for (const v of distinctValues) {
      this.keyToValue.set(sqlValueKey(v), v);
    }

    // Use fuzzy search to filter and get highlighted segments
    const baseResults = (() => {
      if (this.searchQuery === '') {
        // No search - show all values without highlighting
        return distinctValues.map((value) => ({
          value,
          key: sqlValueKey(value),
          segments: [{matching: false, value: valueFormatter(value)}],
        }));
      } else {
        // Fuzzy search with highlighting
        const finder = new FuzzyFinder(distinctValues, (v) =>
          valueFormatter(v),
        );
        return finder.find(this.searchQuery).map((result) => ({
          value: result.item,
          key: sqlValueKey(result.item),
          segments: result.segments,
        }));
      }
    })();

    // Partition into pinned (initial selection) + the rest, preserving
    // each group's internal order. Pinned items stay at the top even
    // after the user toggles them off, so the layout doesn't shift
    // mid-edit. Skipped during search — fuzzy relevance order wins.
    const fuzzyResults = (() => {
      if (this.searchQuery !== '') return baseResults;
      const pinned: typeof baseResults = [];
      const rest: typeof baseResults = [];
      for (const r of baseResults) {
        if (this.pinnedKeys.has(r.key)) {
          pinned.push(r);
        } else {
          rest.push(r);
        }
      }
      return [...pinned, ...rest];
    })();

    // Limit the number of items rendered
    const visibleResults = fuzzyResults.slice(
      0,
      DistinctValuesSubmenu.MAX_VISIBLE_ITEMS,
    );
    const remainingCount =
      fuzzyResults.length - DistinctValuesSubmenu.MAX_VISIBLE_ITEMS;

    return m('.pf-distinct-values-menu', [
      m(
        '.pf-distinct-values-menu__search',
        {
          onclick: (e: MouseEvent) => {
            // Prevent menu from closing when clicking search box
            e.stopPropagation();
          },
        },
        m(TextInput, {
          placeholder: 'Search...',
          value: this.searchQuery,
          oninput: (e: InputEvent) => {
            this.searchQuery = (e.target as HTMLInputElement).value;
          },
          onkeydown: (e: KeyboardEvent) => {
            if (this.searchQuery !== '' && e.key === 'Escape') {
              this.searchQuery = '';
              e.stopPropagation(); // Prevent menu from closing
            }
          },
        }),
      ),
      m(
        '.pf-distinct-values-menu__list',
        fuzzyResults.length > 0
          ? [
              visibleResults.map((result) => {
                const isSelected = this.selectedKeys.has(result.key);
                // Render highlighted label
                const labelContent = result.segments.map((segment) => {
                  if (segment.matching) {
                    return m('strong.pf-fuzzy-match', segment.value);
                  } else {
                    return segment.value;
                  }
                });

                // Render custom menu item with highlighted content
                return m(
                  'button.pf-menu-item',
                  {
                    onclick: () => {
                      if (isSelected) {
                        this.selectedKeys.delete(result.key);
                      } else {
                        this.selectedKeys.add(result.key);
                      }
                    },
                  },
                  m(Icon, {
                    className: 'pf-menu-item__left-icon',
                    icon: isSelected ? Icons.Checkbox : Icons.BlankCheckbox,
                  }),
                  m('.pf-menu-item__label', labelContent),
                );
              }),
              remainingCount > 0 &&
                m(MenuItem, {
                  label: `...and ${remainingCount} more`,
                  disabled: true,
                }),
            ]
          : m(EmptyState, {
              title: 'No matches',
            }),
      ),
      m('.pf-distinct-values-menu__footer', [
        m(MenuItem, {
          label: 'Apply',
          icon: 'check',
          disabled: this.selectedKeys.size === 0,
          onclick: () => {
            if (this.selectedKeys.size > 0) {
              // Map keys back to canonical SqlValue references for the
              // emit. Falls back to a synthesized null (shouldn't
              // happen — keyToValue is populated for every key we
              // ever add) but keeps the type honest.
              const out = new Set<SqlValue>();
              for (const k of this.selectedKeys) {
                const v = this.keyToValue.get(k);
                if (v !== undefined) out.add(v);
              }
              onApply(out);
              this.selectedKeys.clear();
              this.searchQuery = '';
            }
          },
        }),
        m(MenuItem, {
          label: 'Clear selection',
          icon: 'close',
          disabled: this.selectedKeys.size === 0,
          closePopupOnClick: false,
          onclick: () => {
            this.selectedKeys.clear();
            m.redraw();
          },
        }),
      ]),
    ]);
  }
}

// Coerce a numeric-input string to a JS number, or a BigInt if it
// looks like an integer past Number.MAX_SAFE_INTEGER (e.g. int64 ids
// from trace_processor). Falls back to the original string on parse
// failure so the downstream filter compiler can decide what to do.
function parseNumericInput(trimmed: string): string | number | bigint {
  // Pure integer (optionally signed). BigInt the moment we'd lose
  // precision; stay as number otherwise so add-mode behavior stays
  // unchanged for the common case.
  if (/^-?\d+$/.test(trimmed)) {
    try {
      const big = BigInt(trimmed);
      const safeMax = BigInt(Number.MAX_SAFE_INTEGER);
      const safeMin = BigInt(Number.MIN_SAFE_INTEGER);
      if (big <= safeMax && big >= safeMin) return Number(big);
      return big;
    } catch {
      // Unreachable for a digit-only string but keeps the type checker honest.
    }
  }
  const n = Number(trimmed);
  return Number.isNaN(n) ? trimmed : n;
}

// Helper component for text-based filter input
interface TextFilterSubmenuAttrs {
  readonly placeholder?: string;
  readonly inputType: 'text' | 'number';
  // Pre-populates the input on mount. Read once in oninit so in-flight
  // typing isn't clobbered by parent re-renders. Default: empty.
  readonly initialValue?: string;
  // Overrides the submit-button label. Defaults to 'Add Filter' for the
  // add-mode flow; edit-mode passes 'Save'.
  readonly submitLabel?: string;
  readonly onApply: (value: string | number | bigint) => void;
}

export class TextFilterSubmenu
  implements m.ClassComponent<TextFilterSubmenuAttrs>
{
  private inputValue = '';

  oninit({attrs}: m.Vnode<TextFilterSubmenuAttrs>) {
    if (attrs.initialValue !== undefined) {
      this.inputValue = attrs.initialValue;
    }
  }

  view({attrs}: m.Vnode<TextFilterSubmenuAttrs>) {
    const {
      placeholder = 'Enter value...',
      inputType,
      submitLabel = 'Add Filter',
      onApply,
    } = attrs;

    const applyFilter = () => {
      const trimmed = this.inputValue.trim();
      if (trimmed.length > 0) {
        const value: string | number | bigint =
          inputType === 'number' ? parseNumericInput(trimmed) : trimmed;
        onApply(value);
        this.inputValue = '';
      }
    };

    return m(
      Form,
      {
        className: 'pf-data-grid__text-filter-form',
        submitLabel,
        submitIcon: 'check',
        onSubmit: (e: Event) => {
          e.preventDefault();
          applyFilter();
        },
        validation: () => this.inputValue.trim().length > 0,
      },
      m(TextInput, {
        placeholder,
        value: this.inputValue,
        autofocus: true,
        onInput: (value) => {
          this.inputValue = value;
        },
      }),
    );
  }
}

export interface FilterMenuAttrs {
  readonly datasource: DataSource;
  readonly field: string;
  readonly columnType: ColumnType | undefined;
  readonly structuredQueryCompatMode: boolean;
  readonly valueFormatter: (value: SqlValue) => string;
  readonly onFilterAdd: (filter: FilterOpAndValue) => void;
}

/**
 * Renders the complete filter menu group for a column header.
 * Returns the "Add filter..." menu item with all filter options as a submenu.
 */
export class FilterMenu implements m.ClassComponent<FilterMenuAttrs> {
  view({attrs}: m.Vnode<FilterMenuAttrs>): m.Children {
    const filterSubmenuItems = renderFilterMenuItems(attrs);

    if (isEmptyVnodes(filterSubmenuItems)) {
      return undefined;
    }

    return m(
      MenuItem,
      {label: 'Add filter', icon: Icons.Filter},
      filterSubmenuItems,
    );
  }
}

/**
 * Renders numeric comparison filter menu items (>, >=, <, <=).
 */
function renderNumericComparisonMenuItems(
  onFilterAdd: (filter: FilterOpAndValue) => void,
): m.ChildArray {
  return [
    m(
      MenuItem,
      {label: 'Greater than'},
      m(TextFilterSubmenu, {
        placeholder: 'Enter number...',
        inputType: 'number',
        onApply: (value) => onFilterAdd({op: '>', value}),
      }),
    ),
    m(
      MenuItem,
      {label: 'Greater than or equals'},
      m(TextFilterSubmenu, {
        placeholder: 'Enter number...',
        inputType: 'number',
        onApply: (value) => onFilterAdd({op: '>=', value}),
      }),
    ),
    m(
      MenuItem,
      {label: 'Less than'},
      m(TextFilterSubmenu, {
        placeholder: 'Enter number...',
        inputType: 'number',
        onApply: (value) => onFilterAdd({op: '<', value}),
      }),
    ),
    m(
      MenuItem,
      {label: 'Less than or equals'},
      m(TextFilterSubmenu, {
        placeholder: 'Enter number...',
        inputType: 'number',
        onApply: (value) => onFilterAdd({op: '<=', value}),
      }),
    ),
  ];
}

/**
 * Renders contains filter menu items (Contains, Not contains).
 */
function renderContainsFilterMenuItems(
  onFilterAdd: (filter: FilterOpAndValue) => void,
  includeNotContains: boolean,
): m.ChildArray {
  return [
    m(
      MenuItem,
      {label: 'Contains'},
      m(TextFilterSubmenu, {
        placeholder: 'Enter text to search...',
        inputType: 'text',
        onApply: (value) =>
          onFilterAdd({
            op: 'glob',
            value: toCaseInsensitiveGlob(String(value)),
          }),
      }),
    ),
    // Not contains - hidden in structuredQueryCompatMode
    includeNotContains &&
      m(
        MenuItem,
        {label: 'Not contains'},
        m(TextFilterSubmenu, {
          placeholder: 'Enter text to exclude...',
          inputType: 'text',
          onApply: (value) =>
            onFilterAdd({
              op: 'not glob',
              value: toCaseInsensitiveGlob(String(value)),
            }),
        }),
      ),
  ];
}

/**
 * Renders glob filter menu items (Glob, Not glob).
 */
function renderGlobFilterMenuItems(
  onFilterAdd: (filter: FilterOpAndValue) => void,
  includNotGlob: boolean,
): m.ChildArray {
  return [
    m(
      MenuItem,
      {label: 'Glob'},
      m(TextFilterSubmenu, {
        placeholder: 'Enter glob pattern (e.g., *text*)...',
        inputType: 'text',
        onApply: (value) => onFilterAdd({op: 'glob', value}),
      }),
    ),
    // Not glob - hidden in structuredQueryCompatMode
    includNotGlob &&
      m(
        MenuItem,
        {label: 'Not glob'},
        m(TextFilterSubmenu, {
          placeholder: 'Enter glob pattern to exclude...',
          inputType: 'text',
          onApply: (value) => onFilterAdd({op: 'not glob', value}),
        }),
      ),
  ];
}

/**
 * Renders numeric equals filter menu items (Equals, Not equals) for quantitative columns.
 */
function renderNumericEqualsFilterMenuItems(
  onFilterAdd: (filter: FilterOpAndValue) => void,
): m.ChildArray {
  return [
    m(
      MenuItem,
      {label: 'Equals'},
      m(TextFilterSubmenu, {
        placeholder: 'Enter value...',
        inputType: 'number',
        onApply: (value) => onFilterAdd({op: '=', value}),
      }),
    ),
    m(
      MenuItem,
      {label: 'Not equals'},
      m(TextFilterSubmenu, {
        placeholder: 'Enter value...',
        inputType: 'number',
        onApply: (value) => onFilterAdd({op: '!=', value}),
      }),
    ),
  ];
}

/**
 * Renders null filter menu items (Is null, Is not null).
 */
function renderNullFilterMenuItems(
  onFilterAdd: (filter: FilterOpAndValue) => void,
): m.ChildArray {
  return [
    m(MenuItem, {
      label: 'Is null',
      onclick: () => {
        onFilterAdd({op: 'is null'});
      },
    }),
    m(MenuItem, {
      label: 'Is not null',
      onclick: () => {
        onFilterAdd({op: 'is not null'});
      },
    }),
  ];
}

/**
 * Renders distinct value picker menu items (Equals, Not equals).
 */
function renderDistinctValueFilterMenuItems(
  config: FilterMenuAttrs,
): m.ChildArray {
  const {datasource, field, valueFormatter, onFilterAdd} = config;

  return [
    m(
      MenuItem,
      {label: 'Equals'},
      m(DistinctValuesSubmenu, {
        datasource,
        field,
        // Filter out null - use "is null" filter instead (SQL IN doesn't match NULL)
        excludeNull: true,
        valueFormatter,
        onApply: (selectedValues) => {
          onFilterAdd({
            op: 'in',
            value: Array.from(selectedValues),
          });
        },
      }),
    ),
    m(
      MenuItem,
      {label: 'Not equals'},
      m(DistinctValuesSubmenu, {
        datasource,
        field,
        // Filter out null - use "is not null" filter instead (SQL NOT IN doesn't exclude NULL)
        excludeNull: true,
        valueFormatter,
        onApply: (selectedValues) => {
          onFilterAdd({
            op: 'not in',
            value: Array.from(selectedValues),
          });
        },
      }),
    ),
  ];
}

/**
 * Renders filter menu items for text columns.
 * Includes: distinct value picker (equals/not equals), contains, glob, null filters.
 */
function renderTextFilterMenuItems(config: FilterMenuAttrs): m.ChildArray {
  const {structuredQueryCompatMode, onFilterAdd} = config;

  return [
    renderDistinctValueFilterMenuItems(config),
    m(MenuDivider),
    renderContainsFilterMenuItems(onFilterAdd, !structuredQueryCompatMode),
    renderGlobFilterMenuItems(onFilterAdd, !structuredQueryCompatMode),
    m(MenuDivider),
    renderNullFilterMenuItems(onFilterAdd),
  ];
}

/**
 * Renders filter menu items for quantitative columns.
 * Includes: numeric equals/not equals, numeric comparisons, null filters.
 */
function renderQuantitativeFilterMenuItems(
  onFilterAdd: (filter: FilterOpAndValue) => void,
): m.ChildArray {
  return [
    renderNumericEqualsFilterMenuItems(onFilterAdd),
    renderNumericComparisonMenuItems(onFilterAdd),
    m(MenuDivider),
    renderNullFilterMenuItems(onFilterAdd),
  ];
}

/**
 * Renders filter menu items for identifier columns.
 * Includes: distinct value picker (equals/not equals), numeric comparisons, null filters.
 */
function renderIdentifierFilterMenuItems(
  config: FilterMenuAttrs,
): m.ChildArray {
  const {onFilterAdd} = config;

  return [
    renderDistinctValueFilterMenuItems(config),
    renderNumericComparisonMenuItems(onFilterAdd),
    m(MenuDivider),
    renderNullFilterMenuItems(onFilterAdd),
  ];
}

/**
 * Renders filter menu items when columnType is undefined.
 * Shows all filter options (distinct value picker, text-based equals, numeric comparisons,
 * contains, glob, null).
 */
function renderUnknownTypeFilterMenuItems(
  config: FilterMenuAttrs,
): m.ChildArray {
  const {structuredQueryCompatMode, onFilterAdd} = config;

  return [
    renderDistinctValueFilterMenuItems(config),
    renderNumericComparisonMenuItems(onFilterAdd),
    m(MenuDivider),
    renderContainsFilterMenuItems(onFilterAdd, !structuredQueryCompatMode),
    renderGlobFilterMenuItems(onFilterAdd, !structuredQueryCompatMode),
    m(MenuDivider),
    renderNullFilterMenuItems(onFilterAdd),
  ];
}

/**
 * Renders the filter submenu items for a column header context menu.
 * Dispatches to type-specific renderers based on columnType.
 */
function renderFilterMenuItems(config: FilterMenuAttrs): m.ChildArray {
  switch (config.columnType) {
    case 'text':
      return renderTextFilterMenuItems(config);
    case 'quantitative':
      return renderQuantitativeFilterMenuItems(config.onFilterAdd);
    case 'identifier':
      return renderIdentifierFilterMenuItems(config);
    default:
      // When columnType is undefined, show all filters
      return renderUnknownTypeFilterMenuItems(config);
  }
}

// ---------------------------------------------------------------------------
// EditFilterMenu — edit-mode counterpart of FilterMenu.
//
// FilterMenu (above) is a `MenuItem` that lives inside the column-header
// dropdown and lets the user ADD a new filter. EditFilterMenu instead
// renders submenu content directly (so callers can mount it inside a
// Popup) and lets the user CHANGE an existing filter's value.
//
// Op is locked: changing the op requires removing the chip and adding a
// new filter via the column header. The exception is the natural
// "promotion" from `=`/`!=` to `in`/`not in` when the column type lets us
// use the distinct-values multiselect (matches the wire shape add-mode
// produces from the same submenu — see renderDistinctValueFilterMenuItems).
// ---------------------------------------------------------------------------

export interface EditFilterMenuAttrs {
  readonly datasource: DataSource;
  readonly field: string;
  readonly columnType: ColumnType | undefined;
  readonly valueFormatter: (value: SqlValue) => string;
  readonly initialFilter: FilterOpAndValue;
  // Called with the new filter the user composed in the editor. The
  // caller is responsible for replacing the old filter at the right
  // index (this component doesn't know its own index).
  readonly onFilterReplace: (filter: FilterOpAndValue) => void;
}

// A filter is "uneditable" when there's nothing meaningful to edit:
// null-arity ops (is null / is not null) or value-bearing ops whose
// value is null (malformed — SQL `col = NULL` never matches, but the
// type system allows it; defend against external callers constructing
// such filters programmatically).
export function isEditableFilter(filter: FilterOpAndValue): boolean {
  // Array-valued ops are always editable (the multi-select can handle
  // even an empty array as the seed).
  if (filter.op === 'in' || filter.op === 'not in') return true;
  // Detect null-arity ops by absence of `value`, not by enumerating
  // every known null-arity op. Any future op that's null-arity will
  // automatically default to non-editable instead of falling through
  // to a malformed-editor render. (Today this catches `is null` /
  // `is not null`.)
  if (!('value' in filter)) return false;
  // Remaining ops are OpFilter with value: SqlValue. Null is malformed
  // for these ops (SQL `col = NULL` never matches) — refuse to edit.
  return filter.value !== null;
}

export class EditFilterMenu implements m.ClassComponent<EditFilterMenuAttrs> {
  view({attrs}: m.Vnode<EditFilterMenuAttrs>): m.Children {
    const {
      datasource,
      field,
      columnType,
      valueFormatter,
      initialFilter,
      onFilterReplace,
    } = attrs;

    // Refuse to render an editor when there's nothing meaningful to
    // edit. Callers (DataGrid) should also skip wiring onEdit for these
    // cases so the popup never opens; this is defense-in-depth.
    if (!isEditableFilter(initialFilter)) {
      return null;
    }

    // Multi-value ops keep their op on save.
    if (initialFilter.op === 'in' || initialFilter.op === 'not in') {
      const op = initialFilter.op;
      return m(DistinctValuesSubmenu, {
        datasource,
        field,
        // Match add-mode: `in`/`not in` doesn't match NULL, use the null
        // op instead.
        excludeNull: true,
        valueFormatter,
        initialSelectedValues: initialFilter.value,
        onApply: (selectedValues) => {
          onFilterReplace({op, value: Array.from(selectedValues)});
        },
      });
    }

    // `=` / `!=` on text/identifier/unknown columns use the distinct-
    // values multiselect — matches add-mode's "Equals" submenu, which
    // emits `op: 'in'` / `op: 'not in'`. We promote the op on save for
    // consistency with that wire shape.
    if (initialFilter.op === '=' || initialFilter.op === '!=') {
      const usesDistinctValues =
        columnType === 'text' ||
        columnType === 'identifier' ||
        columnType === undefined;
      if (usesDistinctValues) {
        const promotedOp: 'in' | 'not in' =
          initialFilter.op === '=' ? 'in' : 'not in';
        return m(DistinctValuesSubmenu, {
          datasource,
          field,
          excludeNull: true,
          valueFormatter,
          initialSelectedValues: [initialFilter.value],
          onApply: (selectedValues) => {
            onFilterReplace({
              op: promotedOp,
              value: Array.from(selectedValues),
            });
          },
        });
      }
      // Quantitative column: numeric input, op preserved on save.
      const op = initialFilter.op;
      return m(TextFilterSubmenu, {
        placeholder: 'Enter value...',
        inputType: 'number',
        initialValue: sqlValueToString(initialFilter.value),
        submitLabel: 'Save',
        onApply: (value) => {
          onFilterReplace({op, value});
        },
      });
    }

    // Numeric comparison ops: numeric input, op preserved.
    if (
      initialFilter.op === '<' ||
      initialFilter.op === '<=' ||
      initialFilter.op === '>' ||
      initialFilter.op === '>='
    ) {
      const op = initialFilter.op;
      return m(TextFilterSubmenu, {
        placeholder: 'Enter number...',
        inputType: 'number',
        initialValue: sqlValueToString(initialFilter.value),
        submitLabel: 'Save',
        onApply: (value) => {
          onFilterReplace({op, value});
        },
      });
    }

    // glob / not glob: text input, op preserved.
    if (initialFilter.op === 'glob' || initialFilter.op === 'not glob') {
      const op = initialFilter.op;
      return m(TextFilterSubmenu, {
        placeholder: 'Enter glob pattern...',
        inputType: 'text',
        initialValue: sqlValueToString(initialFilter.value),
        submitLabel: 'Save',
        onApply: (value) => {
          onFilterReplace({op, value});
        },
      });
    }

    // Exhaustiveness fall-through; FilterOpAndValue should be covered.
    return null;
  }
}

// SqlValue → input-ready string. null becomes empty (NULL filters use
// the dedicated `is null` op, not value-bearing ops, so seeing a null
// value here means a malformed filter; render empty rather than the
// literal "null").
function sqlValueToString(value: SqlValue): string {
  if (value === null) return '';
  return String(value);
}
