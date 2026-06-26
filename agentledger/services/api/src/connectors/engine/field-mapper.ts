import { FieldMappingRule, ValidationRule } from '../types/connector-definition';
import { getPath } from './path';

export class MappingError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

function parseNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v).replace(/[,$]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function parseCurrency(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    const amount = parseNumber(o.value ?? o.amount);
    if (amount === undefined) return undefined;
    const unit = String(o.currency ?? o.unit ?? 'usd').toLowerCase();
    if (unit === 'cents' || unit === 'cent') return amount / 100;
    return amount;
  }
  return parseNumber(v);
}

function parseDate(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number') {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Evaluate simple derived expressions: +, field refs, / 100 for cents. */
function evaluateDerived(expr: string, metrics: Record<string, unknown>): unknown {
  const trimmed = expr.trim();
  if (trimmed.includes('+')) {
    const parts = trimmed.split('+').map((s) => s.trim()).filter(Boolean);
    let total = 0;
    let any = false;
    for (const part of parts) {
      const v = parseNumber(getPath(metrics, part) ?? metrics[part]);
      if (v !== undefined) {
        total += v;
        any = true;
      }
    }
    if (any) return total;
  }
  const divMatch = /^(\w+)\s*\/\s*(\d+)$/.exec(trimmed);
  if (divMatch) {
    const base = parseNumber(metrics[divMatch[1]]) ?? parseNumber(getPath(metrics, divMatch[1]));
    if (base === undefined) return undefined;
    return base / Number(divMatch[2]);
  }
  const addMatch = /^([\w.]+)\s*\+\s*([\w.]+)$/.exec(trimmed);
  if (addMatch) {
    const a = parseNumber(getPath(metrics, addMatch[1]) ?? metrics[addMatch[1]]);
    const b = parseNumber(getPath(metrics, addMatch[2]) ?? metrics[addMatch[2]]);
    if (a === undefined && b === undefined) return undefined;
    return (a ?? 0) + (b ?? 0);
  }
  return getPath(metrics, trimmed) ?? metrics[trimmed];
}

/** Map a single API record to normalized metrics using field mapping rules. */
export function mapFields(
  source: Record<string, unknown>,
  rules: FieldMappingRule[],
): { metrics: Record<string, unknown>; metadata: Record<string, unknown> } {
  const metrics: Record<string, unknown> = {};
  const metadata: Record<string, unknown> = {};

  for (const rule of rules) {
    switch (rule.type) {
      case 'direct': {
        const val = getPath(source, rule.source);
        if (val !== undefined) metrics[rule.target] = val;
        break;
      }
      case 'constant':
        metrics[rule.target] = rule.value;
        break;
      case 'fallback': {
        let val: unknown;
        for (const s of rule.sources) {
          val = getPath(source, s);
          if (val !== undefined && val !== null && val !== '') break;
        }
        if (val !== undefined) metrics[rule.target] = val;
        break;
      }
      case 'derived': {
        const val = evaluateDerived(rule.expression, { ...source, ...metrics });
        if (val !== undefined) metrics[rule.target] = val;
        break;
      }
      case 'nested': {
        const val = getPath(source, rule.source);
        if (val !== undefined) {
          if (rule.preserveInMetadata) {
            metadata[rule.target] = val;
          } else {
            metrics[rule.target] = val;
          }
        }
        break;
      }
    }
  }

  return { metrics, metadata };
}

/** Validate mapped metrics against rules; returns row-level errors. */
export function validateMetrics(
  metrics: Record<string, unknown>,
  rules: ValidationRule[] | undefined,
): string[] {
  if (!rules?.length) return [];
  const errors: string[] = [];

  for (const rule of rules) {
    const raw = metrics[rule.field];
    if (rule.required && (raw === undefined || raw === null || raw === '')) {
      errors.push(`missing required field "${rule.field}"`);
      continue;
    }
    if (raw === undefined || raw === null || raw === '') continue;

    switch (rule.type) {
      case 'number': {
        const n = parseNumber(raw);
        if (n === undefined) errors.push(`field "${rule.field}" must be a number`);
        else {
          if (rule.min !== undefined && n < rule.min) errors.push(`field "${rule.field}" must be >= ${rule.min}`);
          if (rule.max !== undefined && n > rule.max) errors.push(`field "${rule.field}" must be <= ${rule.max}`);
          metrics[rule.field] = n;
        }
        break;
      }
      case 'currency': {
        const n = parseCurrency(raw);
        if (n === undefined) errors.push(`field "${rule.field}" must be a valid currency amount`);
        else metrics[rule.field] = n;
        break;
      }
      case 'date': {
        const d = parseDate(raw);
        if (!d) errors.push(`field "${rule.field}" must be a valid date`);
        else metrics[rule.field] = d;
        break;
      }
      case 'string':
        if (typeof raw !== 'string') metrics[rule.field] = String(raw);
        break;
    }
  }

  return errors;
}

export { parseNumber, parseCurrency, parseDate };
