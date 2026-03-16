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
import type {Engine} from '../../../trace_processor/engine';
import {Spinner} from '../../../widgets/spinner';
import type {InstanceRow, InstanceDetail, HeapInfo, PrimOrRef} from '../types';
import {fmtSize, fmtHex} from '../format';
import {downloadBlob} from '../download';
import {
  type NavFn,
  InstanceLink,
  Section,
  SortableTable,
  PrimOrRefCell,
  BitmapImage,
  shallowSizeCol,
  nativeSizeCol,
  retainedSizeCol,
  retainedNativeSizeCol,
  reachableSizeCol,
  reachableNativeSizeCol,
} from '../components';
import * as queries from '../queries';

export interface ObjectParams {
  id: number;
}

interface ObjectViewAttrs {
  engine: Engine;
  heaps: HeapInfo[];
  navigate: NavFn;
  params: ObjectParams;
  onViewInTimeline?: (objectId: number) => void;
}

function ObjectView(): m.Component<ObjectViewAttrs> {
  let detail: InstanceDetail | null | 'loading' = 'loading';
  let prevId: number | undefined;
  let alive = true;
  let fetchSeq = 0;

  function fetchData(attrs: ObjectViewAttrs) {
    detail = 'loading';
    prevId = attrs.params.id;
    const seq = ++fetchSeq;
    queries
      .getInstance(attrs.engine, attrs.params.id)
      .then((d) => {
        if (!alive || seq !== fetchSeq) return;
        detail = d;
        m.redraw();
        if (d) {
          // Enrich with reachable sizes asynchronously.
          const enrichPromises: Promise<void>[] = [];
          enrichPromises.push(
            queries.enrichWithReachable(attrs.engine, [d.row]),
          );
          enrichPromises.push(
            queries.enrichWithReachable(attrs.engine, d.reverseRefs),
          );
          enrichPromises.push(
            queries.enrichWithReachable(attrs.engine, d.dominated),
          );
          if (d.instanceFields.length > 0) {
            enrichPromises.push(
              queries.enrichFieldsWithReachable(attrs.engine, d.instanceFields),
            );
          }
          if (d.staticFields.length > 0) {
            enrichPromises.push(
              queries.enrichFieldsWithReachable(attrs.engine, d.staticFields),
            );
          }
          if (d.arrayElems.length > 0) {
            enrichPromises.push(
              queries.enrichArrayElemsWithReachable(attrs.engine, d.arrayElems),
            );
          }
          Promise.all(enrichPromises).then(() => {
            if (alive && seq === fetchSeq) m.redraw();
          });
        }
      })
      .catch((err) => {
        console.error(err);
        if (!alive || seq !== fetchSeq) return;
        detail = null;
        m.redraw();
      });
  }

  return {
    oninit(vnode) {
      fetchData(vnode.attrs);
    },
    onupdate(vnode) {
      if (vnode.attrs.params.id !== prevId) {
        fetchData(vnode.attrs);
      }
    },
    onremove() {
      alive = false;
    },
    view(vnode) {
      const {heaps, navigate, params, onViewInTimeline} = vnode.attrs;

      if (detail === 'loading') {
        return m('div', {class: 'ah-loading'}, m(Spinner, {easing: true}));
      }
      if (!detail) {
        return m(
          'div',
          {class: 'ah-error-text'},
          'No object with id ' + fmtHex(params.id),
        );
      }

      const {row} = detail;

      return m('div', {class: 'ah-view-stack'}, [
        m('div', [
          m(
            'h2',
            {
              class: 'ah-view-heading',
              style: {marginBottom: '0.25rem'},
            },
            'Object ' + fmtHex(row.id),
          ),
          m(
            'div',
            {style: {display: 'flex', alignItems: 'center', gap: '0.75rem'}},
            [
              m(InstanceLink, {row, navigate}),
              onViewInTimeline
                ? m(
                    'button',
                    {
                      class: 'ah-download-link',
                      onclick: () => onViewInTimeline(row.id),
                    },
                    'View in Timeline',
                  )
                : null,
            ],
          ),
        ]),

        detail.bitmap
          ? m(Section, {title: 'Bitmap Image'}, [
              m(BitmapImage, {
                width: detail.bitmap.width,
                height: detail.bitmap.height,
                format: detail.bitmap.format,
                data: detail.bitmap.data,
              }),
              m(
                'div',
                {
                  class: 'ah-mt-1',
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    fontSize: '0.75rem',
                    lineHeight: '1rem',
                    color: 'var(--ah-text-muted)',
                  },
                },
                [
                  m(
                    'span',
                    detail.bitmap.width +
                      ' x ' +
                      detail.bitmap.height +
                      ' px (' +
                      detail.bitmap.format.toUpperCase() +
                      ')',
                  ),
                  m(
                    'button',
                    {
                      class: 'ah-download-link',
                      onclick: () => {
                        if (
                          detail === null ||
                          detail === 'loading' ||
                          detail.bitmap === null
                        ) {
                          return;
                        }
                        const ext = detail.bitmap.format;
                        downloadBlob(
                          `bitmap-${fmtHex(row.id)}.${ext}`,
                          detail.bitmap.data,
                        );
                      },
                    },
                    'Download image',
                  ),
                ],
              ),
            ])
          : null,

        detail.pathFromRoot
          ? m(
              Section,
              {
                title: detail.isUnreachablePath
                  ? 'Sample Path'
                  : 'Sample Path from GC Root',
              },
              m(
                'div',
                {
                  class: 'ah-view-stack',
                  style: {gap: '0.125rem'},
                },
                detail.pathFromRoot.map((pe, i) =>
                  m(
                    'div',
                    {
                      key: i,
                      class: `ah-path-entry${pe.isDominator ? ' ah-semibold' : ''}`,
                      style: {
                        paddingLeft: Math.min(i, 20) * 12,
                      },
                    },
                    [
                      m(
                        'span',
                        {class: 'ah-path-arrow'},
                        i === 0 ? '' : '\u2192',
                      ),
                      m(InstanceLink, {row: pe.row, navigate}),
                      pe.field
                        ? m('span', {class: 'ah-path-field'}, pe.field)
                        : null,
                    ],
                  ),
                ),
              ),
            )
          : null,

        m(Section, {title: 'Object Info'}, [
          m('div', {class: 'ah-info-grid'}, [
            m('span', {class: 'ah-info-grid__label'}, 'Class:'),
            m(
              'span',
              detail.classObjRow
                ? m(InstanceLink, {
                    row: detail.classObjRow,
                    navigate,
                  })
                : '???',
            ),
            m('span', {class: 'ah-info-grid__label'}, 'Heap:'),
            m('span', row.heap),
            ...(row.isRoot
              ? [
                  m('span', {class: 'ah-info-grid__label'}, 'Root Types:'),
                  m('span', row.rootTypeNames?.join(', ')),
                ]
              : []),
          ]),
        ]),

        m(Section, {title: 'Object Size'}, [
          m('div', {class: 'ah-info-grid'}, [
            m('span', {class: 'ah-info-grid__label'}, 'Shallow:'),
            m('span', {class: 'ah-mono'}, fmtSize(row.shallowJava)),
            m('span', {class: 'ah-info-grid__label'}, 'Shallow Native:'),
            m('span', {class: 'ah-mono'}, fmtSize(row.shallowNative)),
            m('span', {class: 'ah-info-grid__label'}, 'Retained:'),
            m(
              'span',
              {class: 'ah-mono'},
              (() => {
                let j = 0;
                for (const h of row.retainedByHeap) j += h.java;
                return fmtSize(j);
              })(),
            ),
            m('span', {class: 'ah-info-grid__label'}, 'Retained Native:'),
            m(
              'span',
              {class: 'ah-mono'},
              (() => {
                let n = 0;
                for (const h of row.retainedByHeap) n += h.native_;
                return fmtSize(n);
              })(),
            ),
            m('span', {class: 'ah-info-grid__label'}, 'Reachable:'),
            row.reachableSize === null
              ? m('span', {class: 'ah-mono ah-opacity-60'}, '\u2026')
              : m('span', {class: 'ah-mono'}, fmtSize(row.reachableSize)),
            m('span', {class: 'ah-info-grid__label'}, 'Reachable Native:'),
            row.reachableNative === null
              ? m('span', {class: 'ah-mono ah-opacity-60'}, '\u2026')
              : m('span', {class: 'ah-mono'}, fmtSize(row.reachableNative)),
          ]),
        ]),

        detail.isClassObj
          ? m(Section, {title: 'Class Info'}, [
              m('div', {class: 'ah-info-grid ah-mb-3'}, [
                m('span', {class: 'ah-info-grid__label'}, 'Super Class:'),
                m(
                  'span',
                  detail.superClassObjId != null
                    ? m(InstanceLink, {
                        row: {
                          id: detail.superClassObjId,
                          display: fmtHex(detail.superClassObjId),
                        },
                        navigate,
                      })
                    : 'none',
                ),
                m('span', {class: 'ah-info-grid__label'}, 'Instance Size:'),
                m('span', {class: 'ah-mono'}, String(detail.instanceSize)),
              ]),
            ])
          : null,

        detail.isClassObj
          ? m(
              Section,
              {title: 'Static Fields'},
              m(FieldsTable, {
                fields: detail.staticFields,
                navigate,
              }),
            )
          : null,

        detail.isClassInstance && detail.instanceFields.length > 0
          ? m(
              Section,
              {title: 'Fields'},
              m(FieldsTable, {
                fields: detail.instanceFields,
                navigate,
              }),
            )
          : null,

        detail.isArrayInstance
          ? m(
              Section,
              {title: `Array Elements (${detail.arrayLength})`},
              m(ArrayView, {
                elems: detail.arrayElems,
                elemTypeName: detail.elemTypeName ?? 'Object',
                total: detail.arrayLength,
                navigate,
                onDownloadBytes:
                  detail.elemTypeName === 'byte'
                    ? () => {
                        queries
                          .getRawArrayBlob(vnode.attrs.engine, params.id)
                          .then((blob) => {
                            if (blob !== null) {
                              downloadBlob(
                                `array-${fmtHex(params.id)}.bin`,
                                blob,
                              );
                            }
                          })
                          .catch(console.error);
                      }
                    : undefined,
              }),
            )
          : null,

        detail.reverseRefs.length > 0
          ? m(
              Section,
              {
                title: `Objects with References to this Object (${detail.reverseRefs.length})`,
                defaultOpen: detail.reverseRefs.length < 50,
              },
              m(SortableTable, {
                columns: [
                  shallowSizeCol(),
                  nativeSizeCol(),
                  retainedSizeCol(),
                  retainedNativeSizeCol(),
                  reachableSizeCol(),
                  reachableNativeSizeCol(),
                  {
                    label: 'Object',
                    sortKey: (r: InstanceRow) => r.className,
                    render: (r: InstanceRow) =>
                      m(InstanceLink, {row: r, navigate}),
                  },
                ],
                data: detail.reverseRefs,
                rowKey: (r: InstanceRow) => r.id,
              }),
            )
          : null,

        detail.dominated.length > 0
          ? m(
              Section,
              {
                title: `Immediately Dominated Objects (${detail.dominated.length})`,
                defaultOpen: detail.dominated.length < 50,
              },
              m(SortableTable, {
                columns: [
                  shallowSizeCol(),
                  nativeSizeCol(),
                  retainedSizeCol(),
                  retainedNativeSizeCol(),
                  reachableSizeCol(),
                  reachableNativeSizeCol(),
                  ...heaps
                    .filter((h) => h.java + h.native_ > 0)
                    .map((h) => ({
                      label: h.name,
                      align: 'right',
                      sortKey: (r: InstanceRow) => {
                        const s = r.retainedByHeap.find(
                          (x) => x.heap === h.name,
                        );
                        return (s?.java ?? 0) + (s?.native_ ?? 0);
                      },
                      render: (r: InstanceRow) => {
                        const s = r.retainedByHeap.find(
                          (x) => x.heap === h.name,
                        );
                        return m(
                          'span',
                          {class: 'ah-mono'},
                          fmtSize((s?.java ?? 0) + (s?.native_ ?? 0)),
                        );
                      },
                    })),
                  {
                    label: 'Object',
                    sortKey: (r: InstanceRow) => r.className,
                    render: (r: InstanceRow) =>
                      m(InstanceLink, {row: r, navigate}),
                  },
                ],
                data: detail.dominated,
                rowKey: (r: InstanceRow) => r.id,
              }),
            )
          : null,
      ]);
    },
  };
}

// Java primitive type sizes in bytes.
const JAVA_PRIM_SIZE: Record<string, number> = {
  boolean: 1,
  byte: 1,
  char: 2,
  short: 2,
  int: 4,
  float: 4,
  long: 8,
  double: 8,
};

type FieldRow = {name: string; typeName: string; value: PrimOrRef};

function fieldShallowJava(f: FieldRow): number {
  const v = f.value;
  if (v.kind === 'ref') return v.shallowJava ?? 0;
  return JAVA_PRIM_SIZE[f.typeName] ?? 0;
}

function fieldShallowNative(f: FieldRow): number {
  const v = f.value;
  return v.kind === 'ref' ? v.shallowNative ?? 0 : 0;
}

function fieldRetainedJava(f: FieldRow): number {
  const v = f.value;
  return v.kind === 'ref' ? v.retainedJava ?? 0 : 0;
}

function fieldRetainedNative(f: FieldRow): number {
  const v = f.value;
  return v.kind === 'ref' ? v.retainedNative ?? 0 : 0;
}

function fieldReachableJava(f: FieldRow): number {
  const v = f.value;
  return v.kind === 'ref' ? v.reachableJava ?? 0 : 0;
}

function fieldReachableNative(f: FieldRow): number {
  const v = f.value;
  return v.kind === 'ref' ? v.reachableNative ?? 0 : 0;
}

function renderFieldSize(
  f: FieldRow,
  getter: (f: FieldRow) => number,
  isReachable?: boolean,
): m.Children {
  const v = f.value;
  const ref = v.kind === 'ref' ? v : undefined;
  const primSize = JAVA_PRIM_SIZE[f.typeName];
  if (ref) {
    if (isReachable && ref.reachableJava === undefined) {
      return m('span', {class: 'ah-mono ah-opacity-60'}, '\u2026');
    }
    return m('span', {class: 'ah-mono'}, fmtSize(getter(f)));
  }
  if (primSize !== undefined) {
    return m('span', {class: 'ah-mono'}, fmtSize(getter(f)));
  }
  return null;
}

interface FieldsTableAttrs {
  fields: FieldRow[];
  navigate: NavFn;
}

function FieldsTable(): m.Component<FieldsTableAttrs> {
  return {
    view(vnode) {
      const {fields, navigate} = vnode.attrs;
      return m(SortableTable, {
        columns: [
          {
            label: 'Type',
            sortKey: (f: FieldRow) => f.typeName,
            render: (f: FieldRow) => m('span', f.typeName),
          },
          {
            label: 'Name',
            sortKey: (f: FieldRow) => f.name,
            render: (f: FieldRow) => m('span', f.name),
          },
          {
            label: 'Value',
            sortKey: (f: FieldRow) =>
              f.value.kind === 'ref' ? f.value.display : f.value.v,
            render: (f: FieldRow) => m(PrimOrRefCell, {v: f.value, navigate}),
          },
          {
            label: 'Shallow',
            align: 'right',
            sortKey: fieldShallowJava,
            render: (f: FieldRow) => renderFieldSize(f, fieldShallowJava),
          },
          {
            label: 'Shallow Native',
            align: 'right',
            sortKey: fieldShallowNative,
            render: (f: FieldRow) => renderFieldSize(f, fieldShallowNative),
          },
          {
            label: 'Retained',
            align: 'right',
            sortKey: fieldRetainedJava,
            render: (f: FieldRow) => renderFieldSize(f, fieldRetainedJava),
          },
          {
            label: 'Retained Native',
            align: 'right',
            sortKey: fieldRetainedNative,
            render: (f: FieldRow) => renderFieldSize(f, fieldRetainedNative),
          },
          {
            label: 'Reachable',
            align: 'right',
            sortKey: fieldReachableJava,
            render: (f: FieldRow) =>
              renderFieldSize(f, fieldReachableJava, true),
          },
          {
            label: 'Reachable Native',
            align: 'right',
            sortKey: fieldReachableNative,
            render: (f: FieldRow) =>
              renderFieldSize(f, fieldReachableNative, true),
          },
        ],
        data: fields,
        rowKey: (_f: FieldRow, i: number) => i,
      });
    },
  };
}

const ARRAY_SHOW_LIMIT = 5_000;

type ArrayElemRow = {idx: number; value: PrimOrRef};

function elemShallowJava(e: ArrayElemRow, elemTypeName: string): number {
  if (e.value.kind === 'ref') return e.value.shallowJava ?? 0;
  return JAVA_PRIM_SIZE[elemTypeName] ?? 0;
}

function elemShallowNative(e: ArrayElemRow): number {
  return e.value.kind === 'ref' ? e.value.shallowNative ?? 0 : 0;
}

function elemRetainedJava(e: ArrayElemRow): number {
  return e.value.kind === 'ref' ? e.value.retainedJava ?? 0 : 0;
}

function elemRetainedNative(e: ArrayElemRow): number {
  return e.value.kind === 'ref' ? e.value.retainedNative ?? 0 : 0;
}

function elemReachableJava(e: ArrayElemRow): number {
  return e.value.kind === 'ref' ? e.value.reachableJava ?? 0 : 0;
}

function elemReachableNative(e: ArrayElemRow): number {
  return e.value.kind === 'ref' ? e.value.reachableNative ?? 0 : 0;
}

interface ArrayViewAttrs {
  elems: ArrayElemRow[];
  elemTypeName: string;
  total: number;
  navigate: NavFn;
  onDownloadBytes?: () => void;
}

function ArrayView(): m.Component<ArrayViewAttrs> {
  let showCount = ARRAY_SHOW_LIMIT;

  return {
    view(vnode) {
      const {elems, elemTypeName, navigate, onDownloadBytes} = vnode.attrs;
      const visible = elems.slice(0, showCount);

      function copyTsv() {
        const header = 'Index\tValue';
        const lines = elems.map(
          (e) =>
            e.idx +
            '\t' +
            (e.value.kind === 'prim' ? e.value.v : e.value.display),
        );
        navigator.clipboard
          .writeText(header + '\n' + lines.join('\n'))
          .catch(console.error);
      }

      return m('div', [
        onDownloadBytes || elems.length > 0
          ? m(
              'div',
              {class: 'ah-mb-2', style: {display: 'flex', gap: '0.75rem'}},
              [
                onDownloadBytes
                  ? m(
                      'button',
                      {class: 'ah-download-link', onclick: onDownloadBytes},
                      'Download bytes',
                    )
                  : null,
                elems.length > 0
                  ? m(
                      'button',
                      {class: 'ah-download-link', onclick: copyTsv},
                      'Copy as TSV',
                    )
                  : null,
              ],
            )
          : null,
        m(SortableTable, {
          columns: [
            {
              label: 'Index',
              align: 'right',
              sortKey: (e: ArrayElemRow) => e.idx,
              render: (e: ArrayElemRow) =>
                m('span', {class: 'ah-mono'}, String(e.idx)),
            },
            {
              label: 'Value (' + elemTypeName + ')',
              sortKey: (e: ArrayElemRow) =>
                e.value.kind === 'ref' ? e.value.display : e.value.v,
              render: (e: ArrayElemRow) =>
                m(PrimOrRefCell, {v: e.value, navigate}),
            },
            {
              label: 'Shallow',
              align: 'right',
              sortKey: (e: ArrayElemRow) => elemShallowJava(e, elemTypeName),
              render: (e: ArrayElemRow) =>
                m(
                  'span',
                  {class: 'ah-mono'},
                  fmtSize(elemShallowJava(e, elemTypeName)),
                ),
            },
            {
              label: 'Shallow Native',
              align: 'right',
              sortKey: elemShallowNative,
              render: (e: ArrayElemRow) =>
                m('span', {class: 'ah-mono'}, fmtSize(elemShallowNative(e))),
            },
            {
              label: 'Retained',
              align: 'right',
              sortKey: elemRetainedJava,
              render: (e: ArrayElemRow) =>
                m('span', {class: 'ah-mono'}, fmtSize(elemRetainedJava(e))),
            },
            {
              label: 'Retained Native',
              align: 'right',
              sortKey: elemRetainedNative,
              render: (e: ArrayElemRow) =>
                m('span', {class: 'ah-mono'}, fmtSize(elemRetainedNative(e))),
            },
            {
              label: 'Reachable',
              align: 'right',
              sortKey: elemReachableJava,
              render: (e: ArrayElemRow) =>
                e.value.kind === 'ref' && e.value.reachableJava === undefined
                  ? m('span', {class: 'ah-mono ah-opacity-60'}, '\u2026')
                  : m(
                      'span',
                      {class: 'ah-mono'},
                      fmtSize(elemReachableJava(e)),
                    ),
            },
            {
              label: 'Reachable Native',
              align: 'right',
              sortKey: elemReachableNative,
              render: (e: ArrayElemRow) =>
                e.value.kind === 'ref' && e.value.reachableNative === undefined
                  ? m('span', {class: 'ah-mono ah-opacity-60'}, '\u2026')
                  : m(
                      'span',
                      {class: 'ah-mono'},
                      fmtSize(elemReachableNative(e)),
                    ),
            },
          ],
          data: visible,
          rowKey: (e: ArrayElemRow, i: number) =>
            Number.isNaN(e.idx) ? `i${i}` : e.idx,
        }),
        elems.length > showCount
          ? m('div', {class: 'ah-table__more'}, [
              'Showing ' +
                showCount.toLocaleString() +
                ' of ' +
                elems.length.toLocaleString(),
              ' \u2014 ',
              m(
                'button',
                {
                  class: 'ah-more-link',
                  onclick: () => {
                    showCount = Math.min(showCount + 5_000, elems.length);
                  },
                },
                'show more',
              ),
              ' ',
              m(
                'button',
                {
                  class: 'ah-more-link',
                  onclick: () => {
                    showCount = elems.length;
                  },
                },
                'show all',
              ),
            ])
          : null,
        vnode.attrs.total > elems.length
          ? m(
              'div',
              {class: 'ah-table__more ah-mt-2'},
              'Showing first ' +
                elems.length.toLocaleString() +
                ' of ' +
                vnode.attrs.total.toLocaleString() +
                ' elements',
            )
          : null,
      ]);
    },
  };
}

export default ObjectView;
