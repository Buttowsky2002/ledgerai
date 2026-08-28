/** Model family labels — keep in sync with apps/dashboard/lib/model-family.ts */

type FamilyRule = { label: string; test: (platform: string, model: string) => boolean };

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
  {
    label: 'Lovable',
    test: (p, m) => p === 'lovable' || /lovable/.test(m),
  },
];

export function modelFamilyLabel(platform: string, model: string): string {
  const p = platform.trim().toLowerCase();
  const m = model.trim().toLowerCase();
  for (const rule of FAMILY_RULES) {
    if (rule.test(p, m)) {return rule.label;}
  }
  if (p) {
    return p
      .split(/[_-]+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  return model.trim() || 'Other';
}
