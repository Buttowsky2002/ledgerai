import {
  buildDataCoverage,
  buildOutcomeSourceStatus,
  enrichProductsWithSources,
  importParityNarrative,
} from './lari-import-coverage';
import type { ProductWorthEntry } from './lari-product-worth.types';

const baseProduct = (): ProductWorthEntry => ({
  product: 'openai',
  totalSpendUsd: 800,
  seatCostUsd: 0,
  meteredSpendUsd: 800,
  attributedValueUsd: 0,
  worthRatio: null,
  verdict: 'insufficient_data',
  confidenceScore: 30,
  confidenceBasis: 'utilization',
  monthlyRunRateUsd: 800,
  recommendedBudgetUsd: 800,
  topDrivers: [],
  spendNarrative: 'No outcomes.',
  spendTrend: 'flat',
  periodChangePct: null,
  periodChangeUsd: null,
  connectOutcomesPrompt: true,
});

describe('Import coverage', () => {
  it('tags import-only products', () => {
    const src = new Map([
      [
        'openai',
        {
          portalImportUsd: 800,
          connectorUsd: 0,
          liveUsd: 0,
          portalImportCalls: 100,
          connectorCalls: 0,
          liveCalls: 0,
        },
      ],
    ]);
    const enriched = enrichProductsWithSources([baseProduct()], src);
    expect(enriched[0]!.dataMode).toBe('import_only');
    expect(enriched[0]!.spendBySource?.portalImportUsd).toBe(800);
  });

  it('tags connector-only products', () => {
    const src = new Map([
      [
        'anthropic',
        {
          portalImportUsd: 0,
          connectorUsd: 400,
          liveUsd: 0,
          portalImportCalls: 0,
          connectorCalls: 80,
          liveCalls: 0,
        },
      ],
    ]);
    const enriched = enrichProductsWithSources([{ ...baseProduct(), product: 'anthropic' }], src);
    expect(enriched[0]!.dataMode).toBe('connector_only');
  });

  it('builds tenant data coverage summary', () => {
    const coverage = buildDataCoverage({
      products: [{ ...baseProduct(), dataMode: 'import_only', connectOutcomesPrompt: true }],
      spendBySource: new Map([
        [
          'openai',
          {
            portalImportUsd: 800,
            connectorUsd: 0,
            liveUsd: 0,
            portalImportCalls: 100,
            connectorCalls: 0,
            liveCalls: 0,
          },
        ],
      ]),
      outcomeStats: {
        totalOutcomes: 0,
        importOutcomes: 0,
        connectorOutcomes: 0,
        apiOutcomes: 0,
        totalValueUsd: 0,
        roiLinkedOutcomes: 0,
        roiLinkedValueUsd: 0,
        headlineEligibleOutcomes: 0,
      },
      importStats: { portalImportRuns: 2, bulkImportEvents: 0 },
      connectors: { billingConnectors: ['Anthropic'], outcomeConnectors: [] },
    });
    expect(coverage.portalImportSharePct).toBe(100);
    expect(coverage.worthAnalysisReady).toBe(true);
    expect(coverage.outcomeRoiReady).toBe(false);
    expect(coverage.productsWithoutOutcomes).toBe(1);
  });

  it('recommends outcome sources not yet connected', () => {
    const status = buildOutcomeSourceStatus({ billingConnectors: [], outcomeConnectors: [] });
    expect(status.recommended.length).toBeGreaterThan(0);
    expect(status.connected).toHaveLength(0);
  });

  it('generates import parity narrative for import-only tenants', () => {
    const msg = importParityNarrative({
      totalSpendUsd: 800,
      portalImportUsd: 800,
      connectorUsd: 0,
      liveUsd: 0,
      portalImportSharePct: 100,
      importOnlyProducts: 1,
      productsWithoutOutcomes: 1,
      totalOutcomes: 0,
      importOutcomes: 0,
      connectorOutcomes: 0,
      roiLinkedOutcomes: 0,
      roiLinkedValueUsd: 0,
      roiCoveragePct: 0,
      headlineEligibleOutcomes: 0,
      portalImportRuns: 1,
      bulkImportEvents: 0,
      billingConnectors: [],
      outcomeConnectors: [],
      worthAnalysisReady: true,
      outcomeRoiReady: false,
    });
    expect(msg).toContain('portal CSV');
  });

  it('prompts connector sync when billing connectors exist but no spend', () => {
    const msg = importParityNarrative({
      totalSpendUsd: 0,
      portalImportUsd: 0,
      connectorUsd: 0,
      liveUsd: 0,
      portalImportSharePct: 0,
      importOnlyProducts: 0,
      productsWithoutOutcomes: 0,
      totalOutcomes: 0,
      importOutcomes: 0,
      connectorOutcomes: 0,
      roiLinkedOutcomes: 0,
      roiLinkedValueUsd: 0,
      roiCoveragePct: 0,
      headlineEligibleOutcomes: 0,
      portalImportRuns: 0,
      bulkImportEvents: 0,
      billingConnectors: ['Anthropic Usage', 'GitHub Copilot'],
      outcomeConnectors: [],
      worthAnalysisReady: false,
      outcomeRoiReady: false,
    });
    expect(msg).toContain('Billing connectors connected');
    expect(msg).toContain('Anthropic Usage');
  });

  it('returns null when imports and outcomes both feed ROI', () => {
    const msg = importParityNarrative({
      totalSpendUsd: 800,
      portalImportUsd: 500,
      connectorUsd: 300,
      liveUsd: 0,
      portalImportSharePct: 62,
      importOnlyProducts: 0,
      productsWithoutOutcomes: 0,
      totalOutcomes: 10,
      importOutcomes: 5,
      connectorOutcomes: 5,
      roiLinkedOutcomes: 10,
      roiLinkedValueUsd: 2000,
      roiCoveragePct: 100,
      headlineEligibleOutcomes: 8,
      portalImportRuns: 1,
      bulkImportEvents: 5,
      billingConnectors: ['Anthropic'],
      outcomeConnectors: ['GitHub'],
      worthAnalysisReady: true,
      outcomeRoiReady: true,
    });
    expect(msg).toContain('feed the ROI engine');
  });
});
