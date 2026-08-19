/**
 * Merge billing-connector spend (Postgres-native summaries) into product-worth
 * provider rollups. Analytics-store llm_calls covers API-synced metered usage;
 * Copilot and similar connectors also store spend outside that path.
 */
import type { CursorSpendSummary } from '../connectors/cursor-analytics.service';
import {
  COPILOT_ANALYTICS_PLATFORM,
  type CopilotSpendSummary,
} from '../github-copilot/github-copilot-analytics.service';
import type { ProductSpendBySource } from './lari-product-worth.types';

export type ProviderSpendRow = { provider: string; costUsd: number; calls: number };

const usd = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

export function normalizeProviderKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Dedupe by normalized provider name; sums cost and calls. */
export function mergeProviderSpendRows(
  base: ProviderSpendRow[],
  extras: ProviderSpendRow[],
): ProviderSpendRow[] {
  const byKey = new Map<string, ProviderSpendRow>();
  for (const row of [...base, ...extras]) {
    const key = normalizeProviderKey(row.provider);
    const cur = byKey.get(key);
    if (cur) {
      cur.costUsd = usd(cur.costUsd + row.costUsd);
      cur.calls += row.calls;
    } else {
      byKey.set(key, {
        provider: row.provider,
        costUsd: usd(row.costUsd),
        calls: row.calls,
      });
    }
  }
  return [...byKey.values()];
}

function addConnectorSource(
  map: Map<string, ProductSpendBySource>,
  provider: string,
  costUsd: number,
  calls: number,
): void {
  const key = normalizeProviderKey(provider);
  const existing = map.get(key);
  if (existing) {
    existing.connectorUsd = usd(existing.connectorUsd + costUsd);
    existing.connectorCalls += calls;
    return;
  }
  map.set(key, {
    portalImportUsd: 0,
    connectorUsd: usd(costUsd),
    liveUsd: 0,
    portalImportCalls: 0,
    connectorCalls: calls,
    liveCalls: 0,
  });
}

/**
 * Supplemental spend from enabled billing connectors not fully represented in
 * reconciled llm_calls rollups (notably GitHub Copilot license + overage in Postgres).
 */
export function supplementalConnectorSpend(
  copilot: CopilotSpendSummary | null,
  cursor: CursorSpendSummary | null,
  existingProviderSpend: ProviderSpendRow[],
): { providerSpend: ProviderSpendRow[]; spendBySource: Map<string, ProductSpendBySource> } {
  const extras: ProviderSpendRow[] = [];
  const spendBySource = new Map<string, ProductSpendBySource>();

  if (copilot && copilot.totalCostUsd > 0) {
    extras.push({
      provider: COPILOT_ANALYTICS_PLATFORM,
      costUsd: usd(copilot.totalCostUsd),
      calls: copilot.totalCalls,
    });
    addConnectorSource(spendBySource, COPILOT_ANALYTICS_PLATFORM, copilot.totalCostUsd, copilot.totalCalls);
  }

  // Cursor metered usage is usually in llm_calls; seat license may only appear here.
  if (cursor) {
    const seatOnly = usd(cursor.seatLicenseUsd);
    const hasCursorInCh = existingProviderSpend.some(
      (p) => normalizeProviderKey(p.provider) === 'cursor' && p.costUsd > 0,
    );
    if (seatOnly > 0 && !hasCursorInCh) {
      const cursorTotal = usd(cursor.meteredOverageUsd + cursor.seatLicenseUsd);
      if (cursorTotal > 0) {
        extras.push({
          provider: 'cursor',
          costUsd: cursorTotal,
          calls: cursor.totalCalls,
        });
        addConnectorSource(spendBySource, 'cursor', cursorTotal, cursor.totalCalls);
      }
    } else if (seatOnly > 0 && hasCursorInCh) {
      extras.push({ provider: 'cursor', costUsd: seatOnly, calls: 0 });
      addConnectorSource(spendBySource, 'cursor', seatOnly, 0);
    }
  }

  return { providerSpend: extras, spendBySource };
}
