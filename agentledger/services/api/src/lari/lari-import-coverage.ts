/**
 * Import parity + outcome coverage — verifies spend imports feed worth analysis
 * and surfaces what's needed to unlock outcome-based ROI.
 */
import type {
  ConnectorPresence,
  DataCoverageSummary,
  OutcomeSourceStatus,
  ProductSpendBySource,
  ProductWorthEntry,
} from './lari-product-worth.types';

const usd = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

export const RECOMMENDED_OUTCOME_SOURCES = [
  {
    id: 'azure_devops',
    label: 'Azure DevOps',
    outcomeType: 'pr_merged',
    href: '/settings/connectors?preset=azure-devops-outcomes',
  },
  { id: 'github', label: 'GitHub', outcomeType: 'merged_pr', href: '/settings/connectors' },
  { id: 'jira', label: 'Jira', outcomeType: 'closed_issue', href: '/settings/connectors' },
  { id: 'zendesk', label: 'Zendesk', outcomeType: 'resolved_ticket', href: '/settings/connectors' },
] as const;

export type { OutcomeStats, ImportStats, ConnectorPresence } from './lari-product-worth.types';

export interface CoverageAssemblyInput {
  products: ProductWorthEntry[];
  spendBySource: Map<string, ProductSpendBySource>;
  outcomeStats: import('./lari-product-worth.types').OutcomeStats;
  importStats: import('./lari-product-worth.types').ImportStats;
  connectors: ConnectorPresence;
}

function normalizeProvider(name: string): string {
  return name.trim().toLowerCase();
}

/** Attach per-product spend source breakdown. */
export function enrichProductsWithSources(
  products: ProductWorthEntry[],
  spendBySource: Map<string, ProductSpendBySource>,
): ProductWorthEntry[] {
  return products.map((p) => {
    const src = spendBySource.get(normalizeProvider(p.product));
    if (!src) {
      return p;
    }
    const total = src.portalImportUsd + src.connectorUsd + src.liveUsd;
    const dominant =
      total <= 0
        ? 'none'
        : src.portalImportUsd >= src.connectorUsd && src.portalImportUsd >= src.liveUsd
          ? 'portal_import'
          : src.connectorUsd >= src.liveUsd
            ? 'connector'
            : 'live';
    return {
      ...p,
      spendBySource: src,
      dataMode:
        dominant === 'portal_import' && src.connectorUsd === 0 && src.liveUsd === 0
          ? 'import_only'
          : dominant === 'connector' && src.portalImportUsd === 0 && src.liveUsd === 0
            ? 'connector_only'
            : dominant === 'live' && src.portalImportUsd === 0 && src.connectorUsd === 0
              ? 'live_only'
              : 'mixed',
    };
  });
}

/** Tenant-level data coverage summary for import parity. */
export function buildDataCoverage(input: CoverageAssemblyInput): DataCoverageSummary {
  const { products, spendBySource, outcomeStats, importStats, connectors } = input;

  let portalImportUsd = 0;
  let connectorUsd = 0;
  let liveUsd = 0;
  for (const src of spendBySource.values()) {
    portalImportUsd += src.portalImportUsd;
    connectorUsd += src.connectorUsd;
    liveUsd += src.liveUsd;
  }
  const totalSpendUsd = usd(portalImportUsd + connectorUsd + liveUsd);

  const importOnlyProducts = products.filter((p) => p.dataMode === 'import_only').length;
  const productsWithoutOutcomes = products.filter(
    (p) => p.attributedValueUsd <= 0 && p.connectOutcomesPrompt,
  ).length;

  const roiCoveragePct =
    outcomeStats.totalOutcomes > 0
      ? Math.round((outcomeStats.roiLinkedOutcomes / outcomeStats.totalOutcomes) * 100)
      : 0;

  return {
    totalSpendUsd,
    portalImportUsd: usd(portalImportUsd),
    connectorUsd: usd(connectorUsd),
    liveUsd: usd(liveUsd),
    portalImportSharePct:
      totalSpendUsd > 0 ? Math.round((portalImportUsd / totalSpendUsd) * 100) : 0,
    importOnlyProducts,
    productsWithoutOutcomes,
    totalOutcomes: outcomeStats.totalOutcomes,
    importOutcomes: outcomeStats.importOutcomes,
    connectorOutcomes: outcomeStats.connectorOutcomes,
    roiLinkedOutcomes: outcomeStats.roiLinkedOutcomes,
    roiLinkedValueUsd: usd(outcomeStats.roiLinkedValueUsd),
    roiCoveragePct,
    headlineEligibleOutcomes: outcomeStats.headlineEligibleOutcomes,
    portalImportRuns: importStats.portalImportRuns,
    bulkImportEvents: importStats.bulkImportEvents,
    billingConnectors: connectors.billingConnectors,
    outcomeConnectors: connectors.outcomeConnectors,
    worthAnalysisReady: totalSpendUsd > 0,
    outcomeRoiReady: outcomeStats.roiLinkedOutcomes > 0,
  };
}

/** Which outcome sources are connected vs still recommended. */
export function buildOutcomeSourceStatus(connectors: ConnectorPresence): OutcomeSourceStatus {
  const connected = new Set(connectors.outcomeConnectors.map((c) => c.toLowerCase()));
  const normalize = (s: string) => s.toLowerCase().replace(/[_\s-]+/g, '');
  const connectedNorm = [...connected].map(normalize);

  const connectedSources = RECOMMENDED_OUTCOME_SOURCES.filter((s) => {
    const idNorm = normalize(s.id);
    const labelNorm = normalize(s.label);
    return connectedNorm.some((c) => c.includes(idNorm) || c.includes(labelNorm));
  }).map((s) => s.label);

  const recommended = RECOMMENDED_OUTCOME_SOURCES.filter(
    (s) => !connectedSources.includes(s.label),
  ).map((s) => ({
    id: s.id,
    label: s.label,
    outcomeType: s.outcomeType,
    href: s.href,
    reason: `Connect ${s.label} to attribute ${s.outcomeType.replace(/_/g, ' ')} outcomes and unlock outcome-based ROI.`,
  }));

  return { connected: connectedSources, recommended };
}

/** Actionable prompt when imports exist but outcomes do not feed v_roi. */
export function importParityNarrative(coverage: DataCoverageSummary): string | null {
  if (!coverage.worthAnalysisReady) {
    if (coverage.billingConnectors.length > 0) {
      const names = coverage.billingConnectors.slice(0, 3).join(', ');
      const suffix = coverage.billingConnectors.length > 3 ? '…' : '';
      return `Billing connector${coverage.billingConnectors.length === 1 ? '' : 's'} connected (${names}${suffix}) — run a sync or widen the date range to populate worth analysis.`;
    }
    return 'No spend data in range — connect a billing provider under Settings → Connectors, or import a billing CSV.';
  }
  if (coverage.outcomeRoiReady) {
    if (coverage.portalImportSharePct >= 50 && coverage.importOutcomes > 0) {
      return `${coverage.portalImportSharePct}% of spend came from portal imports and ${coverage.importOutcomes} outcomes were imported — both feed the ROI engine.`;
    }
    return null;
  }
  if (coverage.portalImportSharePct >= 30 || coverage.portalImportRuns > 0) {
    return `${coverage.portalImportSharePct}% of spend is from portal CSV imports. Import outcomes (outcome_type + outcome_value_usd) or connect GitHub/Jira to unlock worth verdicts beyond utilization.`;
  }
  if (coverage.totalOutcomes === 0) {
    return 'Spend tracked but no outcomes in range — connect an outcome source or bulk-import outcome rows to calculate whether spend is worth it.';
  }
  if (coverage.roiLinkedOutcomes === 0 && coverage.totalOutcomes > 0) {
    return `${coverage.totalOutcomes} outcomes exist but none link to agent runs for ROI — ensure imports include run_id and agent_id, or connect outcome sync.`;
  }
  return null;
}
