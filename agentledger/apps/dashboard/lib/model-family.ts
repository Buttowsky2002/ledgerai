/** One row of per-model spend — enough to infer discovered model families. */
export type ModelUsageRow = { platform: string; model: string; spend_usd?: number };

type FamilyRule = { label: string; test: (platform: string, model: string) => boolean };

/**
 * Ordered rules — first match wins.
 * Cross-reference: services/api/src/lari/model-equivalence.ts (modelFamily) — keep in sync.
 */
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

/** Map a provider/model pair to a short human label (Claude, ChatGPT, Copilot, …). */
export function modelFamilyLabel(platform: string, model: string): string {
  const p = platform.trim().toLowerCase();
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

/** Distinct model families for a user, ranked by spend (highest first). */
export function discoverModelFamilies(rows: ModelUsageRow[]): string[] {
  const spendByFamily = new Map<string, number>();
  for (const row of rows) {
    const label = modelFamilyLabel(row.platform, row.model);
    spendByFamily.set(label, (spendByFamily.get(label) ?? 0) + (row.spend_usd ?? 0));
  }
  return [...spendByFamily.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label]) => label);
}
