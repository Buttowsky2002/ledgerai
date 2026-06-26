import { createHash } from 'node:crypto';
import { DedupeConfig } from '../types/connector-definition';

/** Compute a stable dedupe hash for a normalized record. */
export function computeDedupeHash(
  config: DedupeConfig | undefined,
  metrics: Record<string, unknown>,
  externalId?: string,
): string {
  const strategy = config?.strategy ?? 'provider_record_id';

  let parts: string[];
  switch (strategy) {
    case 'provider_record_id':
      parts = [externalId ?? String(metrics.id ?? metrics.record_id ?? '')];
      break;
    case 'period_model_user_product_cost':
      parts = [
        String(metrics.period_start ?? metrics.ts ?? ''),
        String(metrics.model ?? ''),
        String(metrics.user_id ?? metrics.user_email ?? ''),
        String(metrics.product ?? ''),
        String(metrics.cost_usd ?? ''),
      ];
      break;
    case 'period_project_api_key_line_item':
      parts = [
        String(metrics.period_start ?? metrics.ts ?? ''),
        String(metrics.project_id ?? ''),
        String(metrics.api_key_id ?? ''),
        String(metrics.line_item_id ?? metrics.id ?? ''),
      ];
      break;
    case 'custom':
      parts = (config?.fields ?? []).map((f) => String(metrics[f] ?? ''));
      if (config?.customExpression) parts.push(config.customExpression);
      break;
    default:
      parts = [externalId ?? JSON.stringify(metrics)];
  }

  const payload = parts.join('|');
  if (!payload || payload === '|') {
    return createHash('sha256').update(JSON.stringify(metrics)).digest('hex').slice(0, 32);
  }
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}
