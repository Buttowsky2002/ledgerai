import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedUsageMetrics } from './types/normalized-usage-event';

interface PriceEntry {
  provider: string;
  model: string;
  token_type: string;
  usd_per_million: number;
  effective_start: string;
  effective_end?: string;
}

let entries: PriceEntry[] = [];

function loadPriceBook(): PriceEntry[] {
  if (entries.length) return entries;
  const candidates = [
    join(__dirname, '../../pricing/pricebook.json'),
    join(__dirname, '../../../../pricing/pricebook.json'),
    join(process.cwd(), 'pricing/pricebook.json'),
    join(process.cwd(), '../pricing/pricebook.json'),
  ];
  for (const path of candidates) {
    try {
      entries = JSON.parse(readFileSync(path, 'utf8')) as PriceEntry[];
      return entries;
    } catch {
      // try next path
    }
  }
  return [];
}

function rate(provider: string, model: string, tokenType: string, at: Date): number | undefined {
  const book = loadPriceBook();
  let bestLen = -1;
  let found: number | undefined;
  for (const e of book) {
    if (e.provider !== provider || e.token_type !== tokenType) continue;
    if (!model.startsWith(e.model)) continue;
    const start = new Date(e.effective_start);
    if (at < start) continue;
    if (e.effective_end && at > new Date(e.effective_end)) continue;
    if (e.model.length > bestLen) {
      bestLen = e.model.length;
      found = e.usd_per_million;
    }
  }
  return found;
}

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Estimate USD cost from tokens when the provider API omits billing fields. */
export function estimateCostFromTokens(metrics: NormalizedUsageMetrics): number {
  const provider = String(metrics.provider ?? '');
  const model = String(metrics.model ?? metrics.product ?? '').split(',')[0].trim();
  const inputTokens = num(metrics.input_tokens);
  const outputTokens = num(metrics.output_tokens);
  if (!provider || !model || (inputTokens === 0 && outputTokens === 0)) return 0;

  const at = metrics.ts ? new Date(String(metrics.ts)) : new Date();
  let total = 0;
  const inRate = rate(provider, model, 'input', at);
  const outRate = rate(provider, model, 'output', at);
  if (inRate !== undefined) total += (inputTokens * inRate) / 1_000_000;
  if (outRate !== undefined) total += (outputTokens * outRate) / 1_000_000;
  return Math.round(total * 1_000_000) / 1_000_000;
}

/** Fill missing/zero cost_usd from provider amount (cents) or price book. */
export function enrichRecordCost(metrics: NormalizedUsageMetrics): NormalizedUsageMetrics {
  const existing = num(metrics.cost_usd);
  if (existing > 0) {
    return { ...metrics, cost_source: metrics.cost_source ?? 'provider' };
  }

  const amountRaw = metrics.amount;
  if (amountRaw !== undefined && amountRaw !== null && typeof amountRaw === 'object') {
    const o = amountRaw as Record<string, unknown>;
    const val = num(o.value ?? o.amount);
    if (val > 0) {
      const unit = String(o.currency ?? o.unit ?? 'usd').toLowerCase();
      const fromAmount = unit === 'cents' || unit === 'cent' ? val / 100 : val;
      return {
        ...metrics,
        cost_usd: fromAmount,
        cost_source: 'provider',
        provider_reported_cost: fromAmount,
      };
    }
  }

  const amount = num(metrics.amount);
  const provider = String(metrics.provider ?? '').toLowerCase();
  if (amount > 0) {
    // Anthropic cost_report amounts are decimal cents (e.g. "123.45" = $1.23).
    const fromCents = provider === 'anthropic' ? amount / 100 : amount >= 100 ? amount / 100 : amount;
    return {
      ...metrics,
      cost_usd: fromCents,
      cost_source: provider === 'anthropic' ? 'provider_cents' : 'provider_cents',
      provider_reported_cost: fromCents,
    };
  }

  const estimated = estimateCostFromTokens(metrics);
  if (estimated > 0) {
    return {
      ...metrics,
      cost_usd: estimated,
      cost_source: 'pricebook_estimate',
    };
  }

  return metrics;
}
