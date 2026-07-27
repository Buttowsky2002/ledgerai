import { generateExecutiveXlsx } from './xlsx-generator';
import type { ExecutiveReportData } from '../executive-report.types';

const baseData = (): ExecutiveReportData => ({
  tenantName: 'Acme Corp',
  window: { from: '2026-06-01', to: '2026-06-30', days: 30 },
  priorWindow: { from: '2026-05-02', to: '2026-05-31' },
  attributionLive: false,
  current: {
    costUsd: 120,
    calls: 40,
    inputTokens: 10000,
    outputTokens: 5000,
    cachedTokens: 0,
  },
  prior: { costUsd: 100, calls: 30, inputTokens: 8000, outputTokens: 4000, cachedTokens: 0 },
  pctChangeVsPrior: 20,
  costPer1kTokens: 8,
  valueMetrics: null,
  spendTrend: [
    { day: '2026-06-01', costUsd: 10 },
    { day: '2026-06-02', costUsd: 20 },
  ],
  priorSpendTrend: [],
  userSpend: [],
  userSpendTable: [
    {
      displayName: 'Alice',
      teamName: 'Eng',
      costUsd: 80,
      pctOfTotal: 66.7,
      topModel: 'gpt-4o',
      calls: 10,
    },
  ],
  modelSpendTable: [{ model: 'gpt-4o', provider: 'openai', costUsd: 80, pctOfTotal: 66.7, calls: 10 }],
  providers: [{ provider: 'openai', costUsd: 80, calls: 20 }],
  models: [{ provider: 'openai', model: 'gpt-4o', costUsd: 80, calls: 20 }],
  platformBreakdown: [
    {
      provider: 'openai',
      costUsd: 80,
      calls: 20,
      costBasis: 'usage',
      models: [{ provider: 'openai', model: 'gpt-4o', costUsd: 80, calls: 20 }],
      remainderUsd: 0,
    },
  ],
  risk: [],
  blockedEvents: 0,
  oneLiner: 'AI spend was $120.00 (+20.0% vs prior).',
  projection: {
    forecastDays: 365,
    observedPeriodDays: 30,
    observedFullyLoadedCost: 150,
    projectedFullyLoadedCost: 1825,
    stack: {
      tokenUsageUsd: 1460,
      tokenComputedUsd: 1400,
      tokenMeteredUsd: 1460,
      fixedCostUsd: 240,
      codingAgentUsd: 0,
      copilotUsd: 125,
      qaEvalOverheadUsd: 0,
    },
  },
});

describe('generateExecutiveXlsx', () => {
  it('builds a workbook that includes CFO projection rows', async () => {
    const buf = await generateExecutiveXlsx(baseData());
    expect(buf.byteLength).toBeGreaterThan(1000);
    // XLSX is a zip; PK header
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('builds when projection is null', async () => {
    const data = baseData();
    data.projection = null;
    const buf = await generateExecutiveXlsx(data);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
  });
});
