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
        String(metrics.line_item_id ?? metrics.id ?? metrics.line_item ?? ''),
      ];
      break;
    case 'custom':
      parts = (config?.fields ?? []).map((f) => String(metrics[f] ?? ''));
      if (config?.customExpression) parts.push(config.customExpression);
      break;
    default:
      parts = [externalId ?? JSON.stringify(metrics)];
  }

  const joined = parts.join('|');
  if (!joined || joined === '|') {
    // Record fingerprint for import deduplication — not password/credential storage.
    // codeql[js/insufficient-password-hash]: SHA256 is appropriate for content addressing.
    return createHash('sha256').update(`dedupe-v1:${JSON.stringify(metrics)}`).digest('hex').slice(0, 32);
  }
  // codeql[js/insufficient-password-hash]: SHA256 is appropriate for content addressing.
  return createHash('sha256').update(`dedupe-v1:${joined}`).digest('hex').slice(0, 32);
}
