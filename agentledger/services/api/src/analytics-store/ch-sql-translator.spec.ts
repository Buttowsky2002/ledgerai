import { EFFECTIVE_METERED_COST_USD } from '../connectors/metered-cost';
import { translateChSql, translateFunctions } from './ch-sql-translator';

describe('ch-sql-translator', () => {
  it('binds {name:Type} params positionally with casts, reusing repeats', () => {
    const { sql, values, names } = translateChSql(
      `SELECT * FROM spend_daily WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date} AND day != {from:Date}`,
      { tenant: 't-1', from: '2026-01-01', to: '2026-01-31' },
    );
    expect(sql).toContain('tenant_id = $1::text');
    expect(sql).toContain('BETWEEN $2::date AND $3::date');
    expect(sql).toContain('day != $2::date');
    expect(values).toEqual(['t-1', '2026-01-01', '2026-01-31']);
    expect(names).toEqual(['tenant', 'from', 'to']);
  });

  it('throws on a missing param value', () => {
    expect(() => translateChSql('SELECT {x:String}', {})).toThrow(/missing value/);
  });

  it('throws on an unsupported param type', () => {
    expect(() => translateChSql('SELECT {x:Array}', { x: 1 })).toThrow(/unsupported param type/);
  });

  it('strips the agentledger. prefix, FINAL, and SETTINGS', () => {
    const { sql } = translateChSql(
      `SELECT * FROM agentledger.outcomes o FINAL WHERE o.tenant_id = {tenant:String} SETTINGS join_use_nulls = 1`,
      { tenant: 't' },
    );
    expect(sql).not.toContain('agentledger.');
    expect(sql).not.toMatch(/\bFINAL\b/);
    expect(sql).not.toContain('SETTINGS');
  });

  it('rewrites ALTER TABLE ... DELETE WHERE to DELETE FROM', () => {
    const { sql } = translateChSql(
      `ALTER TABLE agentledger.llm_calls DELETE WHERE tenant_id = {tenant:String} SETTINGS mutations_sync = 1`,
      { tenant: 't' },
    );
    expect(sql.trim()).toMatch(/^DELETE FROM llm_calls WHERE tenant_id = \$1::text/);
  });

  it('translates date functions', () => {
    expect(translateFunctions('SELECT toDate(ts) AS day')).toContain('(ts)::date AS day');
    expect(translateFunctions('toStartOfMonth(o.ts)')).toBe("(date_trunc('month', (o.ts)::timestamp))::date");
    expect(translateFunctions('toStartOfHour(ts)')).toBe("date_trunc('hour', (ts)::timestamp)");
  });

  it('translates uniqExact to count distinct', () => {
    expect(translateFunctions('uniqExact(user_id) AS members')).toBe('count(DISTINCT user_id) AS members');
  });

  it('translates count()/countIf/sumIf/argMax', () => {
    expect(translateFunctions('count() AS calls')).toBe('count(*) AS calls');
    expect(translateFunctions("countIf(status LIKE 'blocked%') AS b")).toBe(
      "count(*) FILTER (WHERE status LIKE 'blocked%') AS b",
    );
    expect(translateFunctions('sumIf(cost_usd, cost_usd > 0)')).toBe(
      'sum(cost_usd) FILTER (WHERE cost_usd > 0)',
    );
    expect(translateFunctions('argMax(e.detail, e.detected_at)')).toBe(
      '(array_agg(e.detail ORDER BY e.detected_at DESC NULLS LAST))[1]',
    );
  });

  it('translates nested if() to CASE, including the metered-cost expression', () => {
    expect(translateFunctions("if(a > 0, b, c)")).toBe('(CASE WHEN a > 0 THEN b ELSE c END)');

    const translated = translateFunctions(`sum(${EFFECTIVE_METERED_COST_USD})`);
    expect(translated).not.toMatch(/\bif\s*\(/i);
    expect(translated).toContain('CASE WHEN');
    expect(translated).toContain('ELSE');
    // Balanced output — every CASE has its END.
    expect((translated.match(/CASE WHEN/g) ?? []).length).toBe((translated.match(/\bEND\b/g) ?? []).length);
  });

  it('translates positionCaseInsensitive to strpos(lower(...))', () => {
    expect(translateFunctions("positionCaseInsensitive(line_item, 'cursor')")).toBe(
      "strpos(lower(line_item), lower('cursor'))",
    );
  });

  it('does not rewrite string literals containing parens or commas', () => {
    const out = translateFunctions("countIf(operation_name = 'cursor:included')");
    expect(out).toBe("count(*) FILTER (WHERE operation_name = 'cursor:included')");
  });

  it('translates a representative analytics query end to end', () => {
    const { sql, values } = translateChSql(
      `SELECT toStartOfMonth(o.ts) AS month, o.outcome_type AS outcome_type,
              count() AS outcomes, countIf(o.attribution_confidence >= 0.5) AS eligible
       FROM agentledger.outcomes o FINAL
       LEFT JOIN agentledger.agent_runs r FINAL ON r.tenant_id = o.tenant_id AND r.run_id = o.run_id
       WHERE o.tenant_id = {tenant:String}
         AND toDate(o.ts) BETWEEN {from:Date} AND {to:Date}
         AND o.attribution_confidence >= {minconf:Float32}
       GROUP BY month, outcome_type ORDER BY month`,
      { tenant: 't', from: '2026-01-01', to: '2026-06-30', minconf: 0.5 },
    );
    expect(sql).toContain("(date_trunc('month', (o.ts)::timestamp))::date AS month");
    expect(sql).toContain('count(*) AS outcomes');
    expect(sql).toContain('count(*) FILTER (WHERE o.attribution_confidence >= 0.5) AS eligible');
    expect(sql).toContain('FROM outcomes o');
    expect(sql).toContain('(o.ts)::date BETWEEN $2::date AND $3::date');
    expect(sql).toContain('$4::float8');
    expect(values).toEqual(['t', '2026-01-01', '2026-06-30', 0.5]);
  });
});
