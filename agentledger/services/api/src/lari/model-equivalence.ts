/**
 * Model family grouping and price-book equivalence for LARI model substitution.
 *
 * Cross-reference: apps/dashboard/lib/model-family.ts — keep FAMILY_RULES in sync.
 */

type FamilyRule = { label: string; test: (provider: string, model: string) => boolean };

/** Ordered rules — first match wins. Mirrors dashboard model-family.ts. */
const FAMILY_RULES: FamilyRule[] = [
  {
    label: 'Copilot',
    test: (p, m) => /copilot/.test(p) || /copilot/.test(m) || p === 'github_copilot',
  },
  {
    label: 'Claude',
    test: (p, m) => /claude/.test(m) || p === 'anthropic',
  },
  {
    label: 'ChatGPT',
    test: (p, m) => /gpt|chatgpt|codex|\bo[1349]\b/.test(m) || p === 'openai',
  },
  {
    label: 'Gemini',
    test: (p, m) => /gemini/.test(m) || p === 'google' || p === 'vertex',
  },
  {
    label: 'Cursor',
    test: (p, m) => p === 'cursor' || /composer|agent_review|^premium/.test(m),
  },
];

/** Map a provider/model pair to a family label for same-family substitution only. */
export function modelFamily(provider: string, model: string): string {
  const p = provider.trim().toLowerCase();
  const m = model.trim().toLowerCase();
  for (const rule of FAMILY_RULES) {
    if (rule.test(p, m)) return rule.label;
  }
  if (p) {
    return p
      .split(/[_-]+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  return model.trim() || 'Other';
}

export interface ModelRate {
  provider: string;
  model: string;
  inputUsdPerM: number;
  outputUsdPerM: number;
}

/** Blended $/1M tokens at a given input-token share. */
export function blendedRate(rate: ModelRate, inputShare: number): number {
  const share = Math.min(1, Math.max(0, inputShare));
  return share * rate.inputUsdPerM + (1 - share) * rate.outputUsdPerM;
}

function modelKey(provider: string, model: string): string {
  return `${provider.trim().toLowerCase()}::${model.trim().toLowerCase()}`;
}

/** Longest-prefix match of `model` against price-book model prefixes for a provider. */
export function resolveModelRate(
  provider: string,
  model: string,
  priceBook: ModelRate[],
): ModelRate | undefined {
  const p = provider.trim().toLowerCase();
  const m = model.trim().toLowerCase();
  let bestLen = -1;
  let found: ModelRate | undefined;
  for (const rate of priceBook) {
    if (rate.provider.trim().toLowerCase() !== p) continue;
    const prefix = rate.model.trim().toLowerCase();
    if (!m.startsWith(prefix)) continue;
    if (prefix.length > bestLen) {
      bestLen = prefix.length;
      found = rate;
    }
  }
  return found;
}

/** Same-family candidates with strictly lower blended rate at the tenant's input share. */
export function substitutionCandidates(
  incumbent: { provider: string; model: string },
  inputShare: number,
  priceBook: ModelRate[],
): ModelRate[] {
  const incumbentRate = resolveModelRate(incumbent.provider, incumbent.model, priceBook);
  if (!incumbentRate) return [];

  const family = modelFamily(incumbent.provider, incumbent.model);
  const incumbentBlended = blendedRate(incumbentRate, inputShare);
  const incumbentKey = modelKey(incumbent.provider, incumbent.model);

  return priceBook
    .filter((candidate) => {
      if (modelKey(candidate.provider, candidate.model) === incumbentKey) return false;
      if (modelFamily(candidate.provider, candidate.model) !== family) return false;
      return blendedRate(candidate, inputShare) < incumbentBlended;
    })
    .sort(
      (a, b) => blendedRate(a, inputShare) - blendedRate(b, inputShare),
    );
}

/** Projected USD cost for token volumes at price-book rates. */
export function projectedCostUsd(
  rate: ModelRate,
  inputTokens: number,
  outputTokens: number,
): number {
  return (inputTokens * rate.inputUsdPerM + outputTokens * rate.outputUsdPerM) / 1_000_000;
}
