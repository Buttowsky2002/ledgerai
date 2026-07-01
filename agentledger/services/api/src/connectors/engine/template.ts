import { TemplateContext } from '../types/connector-definition';

const VAR_RE = /\{\{(\w+)\}\}/g;

/** Substitute {{variable}} placeholders in strings using sync context. */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(VAR_RE, (_, key: string) => {
    const v = ctx[key as keyof TemplateContext];
    return v !== undefined && v !== null ? String(v) : '';
  });
}

export function renderObject(
  obj: Record<string, string> | undefined,
  ctx: TemplateContext,
): Record<string, string> {
  if (!obj) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[renderTemplate(k, ctx)] = renderTemplate(v, ctx);
  }
  return out;
}
