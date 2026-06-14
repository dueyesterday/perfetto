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

// Schema-aware PerfettoSQL autocomplete for the BigTrace editor. Sources its
// suggestions from the live stdlib schema (sqlTablesLoader) so it improves as
// the schema loads, with three context modes:
//   1. `table.` / `alias.`  -> that table's columns
//   2. right after FROM / JOIN -> table names ranked first
//   3. anywhere else -> keywords + table names + columns of the tables already
//      referenced in this query's FROM/JOIN clauses.

import {sqlTablesLoader} from './sql_tables';
import {perfettoSqlTypeToString} from '../../trace_processor/perfetto_sql_type';
import type {
  CompletionContextLike,
  CompletionOption,
  CompletionResultLike,
  EditorCompletionSource,
} from '../../widgets/editor';
import type {SqlModules, SqlTable} from './sql_modules';

// Common PerfettoSQL keywords + aggregate functions (the grammar highlights
// these but offers no completion).
const KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP BY',
  'ORDER BY',
  'LIMIT',
  'OFFSET',
  'JOIN',
  'LEFT JOIN',
  'INNER JOIN',
  'ON',
  'USING',
  'AS',
  'AND',
  'OR',
  'NOT',
  'IN',
  'LIKE',
  'GLOB',
  'BETWEEN',
  'IS NULL',
  'IS NOT NULL',
  'DISTINCT',
  'WITH',
  'UNION',
  'UNION ALL',
  'HAVING',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'DESC',
  'ASC',
  'INCLUDE PERFETTO MODULE',
];

const FUNCTIONS = [
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'CAST',
  'IFNULL',
  'COALESCE',
  'ROW_NUMBER',
  'RANK',
  'LAG',
  'LEAD',
  'GROUP_CONCAT',
];

// Words that can't be a table alias (so `from slice where ...` doesn't treat
// `where` as the alias of `slice`).
const NON_ALIAS = new Set([
  'where',
  'on',
  'using',
  'group',
  'order',
  'limit',
  'join',
  'left',
  'inner',
  'cross',
  'union',
  'having',
  'as',
]);

// Scan the document for the tables (and aliases) referenced in FROM/JOIN
// clauses, so column suggestions are scoped to what the query actually uses.
function scanReferencedTables(
  doc: string,
): {tables: Set<string>; aliases: Map<string, string>} {
  const tables = new Set<string>();
  const aliases = new Map<string, string>();
  const re = /(?:\bfrom|\bjoin)\s+([a-z_][\w]*)(?:\s+(?:as\s+)?([a-z_][\w]*))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc)) !== null) {
    const table = m[1];
    tables.add(table.toLowerCase());
    aliases.set(table.toLowerCase(), table);
    const alias = m[2];
    if (alias && !NON_ALIAS.has(alias.toLowerCase())) {
      aliases.set(alias.toLowerCase(), table);
    }
  }
  return {tables, aliases};
}

function columnOptions(table: SqlTable): CompletionOption[] {
  return table.columns.map((c) => ({
    label: c.name,
    type: 'property',
    detail: c.type ? perfettoSqlTypeToString(c.type) : table.name,
    info: c.description,
    boost: 20,
  }));
}

function tableOption(t: SqlTable, boost: number): CompletionOption {
  return {
    label: t.name,
    type: 'class',
    detail: 'table',
    info: t.description,
    boost,
  };
}

// Is the cursor immediately after a FROM/JOIN keyword (table position)?
function inTablePosition(textBefore: string): boolean {
  return /(?:\bfrom|\bjoin)\s+[\w]*$/i.test(textBefore);
}

function buildResult(
  ctx: CompletionContextLike,
  modules: SqlModules | undefined,
): CompletionResultLike | null {
  const textBefore = ctx.state.doc.toString().slice(0, ctx.pos);

  // Mode 0: `INCLUDE PERFETTO MODULE <partial>` → stdlib module names (so you
  // don't have to remember the exact dotted path).
  const incMatch = /include\s+perfetto\s+module\s+([\w.]*)$/i.exec(textBefore);
  if (incMatch) {
    if (!modules) return null;
    const partial = incMatch[1];
    return {
      from: ctx.pos - partial.length,
      options: modules
        .listModules()
        .map((mod) => mod.includeKey)
        .filter((k) => !k.startsWith('prelude'))
        .map((k) => ({label: k, type: 'namespace', detail: 'module', boost: 30})),
      validFor: /[\w.]*/,
    };
  }

  // Mode 1: `table.` or `alias.` → that table's columns.
  const dotted = ctx.matchBefore(/[A-Za-z_][\w]*\.[\w]*/);
  if (dotted) {
    const dot = dotted.text.indexOf('.');
    const lhs = dotted.text.slice(0, dot).toLowerCase();
    if (modules) {
      const {aliases} = scanReferencedTables(ctx.state.doc.toString());
      const tableName = aliases.get(lhs) ?? lhs;
      const table = modules.getTable(tableName);
      if (table) {
        return {
          from: dotted.from + dot + 1,
          options: columnOptions(table),
          validFor: /\w*/,
        };
      }
    }
    return null;
  }

  const word = ctx.matchBefore(/[\w]+/);
  if (!word && !ctx.explicit) return null;
  const from = word ? word.from : ctx.pos;
  const tablePos = inTablePosition(textBefore);

  const options: CompletionOption[] = [];

  // Keywords + SQL built-in functions (low priority).
  for (const k of KEYWORDS) {
    options.push({label: k, type: 'keyword', boost: -20});
  }
  for (const f of FUNCTIONS) {
    options.push({label: f, type: 'function', boost: -18});
  }

  if (modules) {
    // Stdlib scalar functions + macros — with their signatures + docs.
    for (const fn of modules.listFunctions()) {
      options.push({
        label: fn.name,
        type: 'function',
        detail: fn.returnType,
        info: signatureInfo(fn.name, fn.args, fn.returnType, fn.description),
        boost: -8,
      });
    }
    for (const mac of modules.listMacros()) {
      options.push({
        label: mac.name,
        type: 'function',
        detail: 'macro',
        info: signatureInfo(mac.name, mac.args, mac.returnType, mac.description),
        boost: -10,
      });
    }
    // Tables + table-valued functions — ranked first in a table position.
    for (const t of modules.listTables()) {
      options.push(tableOption(t, tablePos ? 60 : 0));
    }
    for (const tf of modules.listTableFunctions()) {
      options.push({
        label: tf.name,
        type: 'class',
        detail: 'table function',
        info: signatureInfo(tf.name, tf.args, 'TABLE', tf.description),
        boost: tablePos ? 55 : -8,
      });
    }
    // Columns of the tables this query already references.
    if (!tablePos) {
      const {tables} = scanReferencedTables(textBefore);
      for (const name of tables) {
        const table = modules.getTable(name);
        if (table) options.push(...columnOptions(table));
      }
    }
  }

  return {from, options, validFor: /[\w]*/};
}

// Renders a callable's signature + first line of docs for the completion popup.
function signatureInfo(
  name: string,
  args: ReadonlyArray<{name: string; type: string}>,
  ret: string,
  description: string,
): string {
  const sig = `${name}(${args.map((a) => `${a.name} ${a.type}`).join(', ')}) → ${ret}`;
  const firstLine = description.split('\n')[0].trim();
  return firstLine ? `${sig}\n${firstLine}` : sig;
}

// The singleton completion source wired into the BigTrace editor.
export const perfettoSqlCompletions: EditorCompletionSource = (ctx) =>
  buildResult(ctx, sqlTablesLoader.modules);

// ---------------------------------------------------------------------------
// Missing INCLUDE PERFETTO MODULE detection.
//
// Stdlib tables require their module to be included first
// (`INCLUDE PERFETTO MODULE android.startup.startups;`). Forgetting that is the
// most common cause of "no such table" errors. Detect, from the schema, which
// modules a query references but hasn't included, so the UI can offer to add
// them.
// ---------------------------------------------------------------------------

function alreadyIncluded(key: string, included: ReadonlySet<string>): boolean {
  const k = key.toLowerCase();
  if (included.has(k)) return true;
  // A wildcard include (`android.*`) covers everything under that prefix.
  for (const inc of included) {
    if (inc.endsWith('*') && k.startsWith(inc.slice(0, -1))) return true;
  }
  return false;
}

// Returns the module include-keys a query references but hasn't included yet
// (deduped, in first-referenced order). Empty when the schema isn't loaded.
export function detectMissingIncludes(
  query: string,
  modules: SqlModules | undefined = sqlTablesLoader.modules,
): string[] {
  if (!modules) return [];

  const included = new Set<string>();
  const incRe = /include\s+perfetto\s+module\s+([\w.]+\*?)/gi;
  let inc: RegExpExecArray | null;
  while ((inc = incRe.exec(query)) !== null) {
    included.add(inc[1].toLowerCase());
  }

  const missing: string[] = [];
  const seen = new Set<string>();
  const {tables} = scanReferencedTables(query);
  for (const name of tables) {
    const table = modules.getTable(name);
    const key = table?.includeKey; // undefined for prelude / built-in tables
    if (key === undefined) continue;
    if (alreadyIncluded(key, included)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    missing.push(key);
  }
  return missing;
}

// Prepends the needed INCLUDE statements to a query.
export function addIncludes(query: string, modules: string[]): string {
  const stmts = modules.map((m) => `INCLUDE PERFETTO MODULE ${m};`).join('\n');
  return `${stmts}\n\n${query}`;
}

// ---------------------------------------------------------------------------
// Turn a run error into an actionable, schema-aware fix.
// ---------------------------------------------------------------------------

export type ErrorFix =
  // The query hit a stdlib table whose module isn't included.
  | {readonly kind: 'include'; readonly module: string; readonly table: string}
  // The query referenced a table that looks like a typo of a known one.
  | {readonly kind: 'rename'; readonly badTable: string; readonly suggestion: string};

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

function closestTable(target: string, names: ReadonlyArray<string>): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  const t = target.toLowerCase();
  for (const n of names) {
    const d = editDistance(t, n.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  // Only suggest a rename when it's genuinely close (a likely typo).
  const threshold = Math.max(2, Math.floor(target.length / 3));
  return best !== undefined && bestD > 0 && bestD <= threshold ? best : undefined;
}

// Given a run's error message, suggest a one-click fix if the schema implies
// one. Recognises "no such table: X" (the most common failure).
export function suggestFixForError(
  error: string,
  modules: SqlModules | undefined = sqlTablesLoader.modules,
): ErrorFix | undefined {
  if (!modules) return undefined;
  const m = /no such (?:table|view):?\s*([a-z_][\w.]*)/i.exec(error);
  if (!m) return undefined;
  const ref = m[1];
  const bad = ref.includes('.') ? (ref.split('.').pop() ?? ref) : ref;

  const table = modules.getTable(bad);
  if (table?.includeKey) {
    return {kind: 'include', module: table.includeKey, table: bad};
  }
  if (!table) {
    const near = closestTable(bad, modules.listTablesNames());
    if (near) return {kind: 'rename', badTable: bad, suggestion: near};
  }
  return undefined;
}

// Replaces a (likely-mistyped) table identifier with the suggested one.
export function applyRename(query: string, from: string, to: string): string {
  return query.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
}
