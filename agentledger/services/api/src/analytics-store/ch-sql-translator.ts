/**
 * ClickHouse → Postgres SQL translation for the MVP analytics backend.
 *
 * The API's analytics queries are written in the ClickHouse dialect (the
 * original backend). Rather than rewriting every service, the Postgres store
 * translates the constructs the codebase actually uses:
 *
 *   {name:Type} params  → $n placeholders with type-appropriate casts
 *   agentledger. prefix → stripped (Postgres uses the default schema)
 *   FINAL               → stripped (Postgres tables upsert; latest row wins)
 *   SETTINGS ...        → stripped (mutations_sync / join_use_nulls)
 *   ALTER TABLE t DELETE WHERE ... → DELETE FROM t WHERE ...
 *   toDate(x)           → (x)::date
 *   toStartOfMonth(x)   → (date_trunc('month', (x)::timestamp))::date
 *   toStartOfHour(x)    → date_trunc('hour', (x)::timestamp)
 *   toStartOfDay(x)     → date_trunc('day', (x)::timestamp)
 *   count()             → count(*)
 *   countIf(cond)       → count(*) FILTER (WHERE cond)
 *   uniqExact(x)        → count(DISTINCT x)
 *   sumIf(x, cond)      → sum(x) FILTER (WHERE cond)
 *   if(a, b, c)         → CASE WHEN a THEN b ELSE c END   (recursive)
 *   positionCaseInsensitive(haystack, needle) → position(lower(needle) in lower(haystack))
 *   argMax(a, b)        → (array_agg(a ORDER BY b DESC))[1]
 *   now64(3)            → now()
 *
 * This is intentionally NOT a general SQL transpiler — it covers the dialect
 * surface of this repo's queries and throws on unknown {param:Type} types so
 * gaps fail loudly instead of silently misbehaving.
 */

import { ChParam } from './analytics-store';

const TYPE_CASTS: Record<string, string> = {
  String: '::text',
  Date: '::date',
  Date32: '::date',
  DateTime: '::timestamptz',
  DateTime64: '::timestamptz',
  Float32: '::float8',
  Float64: '::float8',
  UInt8: '::int',
  UInt16: '::int',
  UInt32: '::bigint',
  UInt64: '::bigint',
  Int8: '::int',
  Int16: '::int',
  Int32: '::bigint',
  Int64: '::bigint',
};

export interface TranslatedQuery {
  sql: string;
  values: ChParam[];
  /** Param names in positional order (deduplicated). */
  names: string[];
}

/** Find the index of the `(` that opens a call ending balanced, return index after matching `)`. */
function matchParen(sql: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < sql.length; i++) {
    const c = sql[i];
    // Skip string literals so parens inside quotes don't affect depth.
    if (c === "'") {
      i++;
      while (i < sql.length && sql[i] !== "'") i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('ch-sql-translator: unbalanced parentheses');
}

/** Split a call's argument list on top-level commas (quote/paren aware). */
function splitArgs(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "'") {
      i++;
      while (i < inner.length && inner[i] !== "'") i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      args.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(inner.slice(start).trim());
  return args;
}

/**
 * Replace every call of `fn(` (word-boundary, case-insensitive) using `build`
 * on its already-translated argument list. Runs innermost-out via recursion on
 * the argument text, so nested calls (e.g. nested if()) are handled.
 */
function rewriteCalls(sql: string, fn: string, build: (args: string[]) => string): string {
  const re = new RegExp(`\\b${fn}\\s*\\(`, 'i');
  for (;;) {
    const m = re.exec(sql);
    if (!m) return sql;
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = matchParen(sql, openIdx);
    const inner = sql.slice(openIdx + 1, closeIdx);
    const args = splitArgs(inner).map((a) => rewriteCalls(a, fn, build));
    sql = sql.slice(0, m.index) + build(args) + sql.slice(closeIdx + 1);
  }
}

/** Translate the ClickHouse function surface used by this repo to Postgres. */
export function translateFunctions(sql: string): string {
  // count() → count(*) (only the zero-arg form; count(x) is valid PG already).
  sql = sql.replace(/\bcount\s*\(\s*\)/gi, 'count(*)');
  sql = sql.replace(/\bnow64\s*\(\s*\d*\s*\)/gi, 'now()');

  sql = rewriteCalls(sql, 'toDate', ([x]) => `(${x})::date`);
  sql = rewriteCalls(sql, 'toStartOfMonth', ([x]) => `(date_trunc('month', (${x})::timestamp))::date`);
  sql = rewriteCalls(sql, 'toStartOfWeek', ([x]) => `(date_trunc('week', (${x})::timestamp))::date`);
  sql = rewriteCalls(sql, 'toStartOfDay', ([x]) => `date_trunc('day', (${x})::timestamp)`);
  sql = rewriteCalls(sql, 'toStartOfHour', ([x]) => `date_trunc('hour', (${x})::timestamp)`);
  sql = rewriteCalls(sql, 'countIf', ([cond]) => `count(*) FILTER (WHERE ${cond})`);
  sql = rewriteCalls(sql, 'uniqExact', ([x]) => `count(DISTINCT ${x})`);
  sql = rewriteCalls(sql, 'sumIf', ([x, cond]) => `sum(${x}) FILTER (WHERE ${cond})`);
  sql = rewriteCalls(sql, 'argMax', ([a, b]) => `(array_agg(${a} ORDER BY ${b} DESC NULLS LAST))[1]`);
  // CH positionCaseInsensitive(haystack, needle) is 1-based; PG position(needle in haystack) matches.
  sql = rewriteCalls(
    sql,
    'positionCaseInsensitive',
    ([haystack, needle]) => `position(lower(${needle}) in lower(${haystack}))`,
  );
  // ClickHouse ternary if(). PG's own IF doesn't exist in SQL expressions, so
  // any if( in this codebase's queries is the CH form.
  sql = rewriteCalls(sql, 'if', ([a, b, c]) => `(CASE WHEN ${a} THEN ${b} ELSE ${c} END)`);
  return sql;
}

/** Translate structural statement differences. */
function translateStatement(sql: string): string {
  // ALTER TABLE t DELETE WHERE ... → DELETE FROM t WHERE ...
  sql = sql.replace(/\bALTER\s+TABLE\s+(\S+)\s+DELETE\s+WHERE\b/gi, 'DELETE FROM $1 WHERE');
  // Trailing SETTINGS clause (mutations_sync=1, join_use_nulls=1, ...).
  sql = sql.replace(/\bSETTINGS\s+[\w\s=,]+$/gi, '');
  // agentledger.<object> schema prefix — Postgres objects live in the default schema.
  sql = sql.replace(/\bagentledger\./gi, '');
  // ReplacingMergeTree FINAL — a no-op on Postgres (tables upsert; one row per key).
  sql = sql.replace(/\bFINAL\b/gi, '');
  return sql;
}

/**
 * Convert `{name:Type}` server-side substitution params to `$n` placeholders
 * with explicit casts, collecting values positionally. The same name reuses
 * one placeholder.
 */
export function bindParams(sql: string, params: Record<string, ChParam>): TranslatedQuery {
  const names: string[] = [];
  const out = sql.replace(/\{\s*(\w+)\s*:\s*(\w+)(?:\(\d+\))?\s*\}/g, (_m, name: string, type: string) => {
    const cast = TYPE_CASTS[type];
    if (cast === undefined) {
      throw new Error(`ch-sql-translator: unsupported param type ${type} for {${name}:${type}}`);
    }
    let idx = names.indexOf(name);
    if (idx === -1) {
      names.push(name);
      idx = names.length - 1;
    }
    return `$${idx + 1}${cast}`;
  });
  const values = names.map((nm) => {
    const v = params[nm];
    if (v === undefined) {
      throw new Error(`ch-sql-translator: missing value for param {${nm}}`);
    }
    return v;
  });
  return { sql: out, values, names };
}

/** Full translation: dialect + statement shape + parameter binding. */
export function translateChSql(sql: string, params: Record<string, ChParam>): TranslatedQuery {
  return bindParams(translateFunctions(translateStatement(sql)), params);
}
