import { pdfHasEmbeddedImages, pdfPageCount } from '../charts/chart-image';
import { buildOneLiner } from '../formatters';
import { NEW_SPEND_LABEL } from '../executive-report.should-render';
import { generateExecutivePdf, pdfContainsAbsurdPeriodPct } from './pdf-generator';
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
    cachedTokens: 100,
  },
  prior: { costUsd: 0.5, calls: 1, inputTokens: 100, outputTokens: 50, cachedTokens: 0 },
  pctChangeVsPrior: null,
  costPer1kTokens: 8,
  valueMetrics: null,
  spendTrend: [
    { day: '2026-06-01', costUsd: 10 },
    { day: '2026-06-02', costUsd: 20 },
  ],
  priorSpendTrend: [{ day: '2026-05-02', costUsd: 5 }],
  userSpend: [{ userId: 'u1', displayName: 'Alice Smith', teamName: 'Eng', costUsd: 80, calls: 10 }],
  userSpendTable: [
    {
      displayName: 'Alice Smith',
      teamName: 'Eng',
      costUsd: 80,
      pctOfTotal: 66.7,
      topModel: 'gpt-4o',
      calls: 10,
    },
  ],
  modelSpendTable: [
    { model: 'gpt-4o', provider: 'openai', costUsd: 80, pctOfTotal: 66.7, calls: 10 },
    { model: 'default', provider: 'cursor', costUsd: 40, pctOfTotal: 33.3, calls: 5 },
  ],
  providers: [
    { provider: 'openai', costUsd: 80, calls: 20 },
    { provider: 'cursor', costUsd: 40, calls: 5 },
  ],
  models: [
    { provider: 'openai', model: 'gpt-4o', costUsd: 80, calls: 20 },
    { provider: 'cursor', model: 'default', costUsd: 40, calls: 5 },
  ],
  platformBreakdown: [
    {
      provider: 'openai',
      costUsd: 80,
      calls: 20,
      costBasis: 'usage',
      models: [{ provider: 'openai', model: 'gpt-4o', costUsd: 80, calls: 20 }],
      remainderUsd: 0,
    },
    {
      provider: 'cursor',
      costUsd: 40,
      calls: 5,
      costBasis: 'subscription',
      models: [{ provider: 'cursor', model: 'default', costUsd: 40, calls: 5 }],
      remainderUsd: 0,
    },
  ],
  risk: [],
  blockedEvents: 0,
  oneLiner: 'AI spend was $120.00, New spend (no comparable prior period).',
});

describe('executive report PDF (text-only)', () => {
  it('renders a valid PDF without embedded chart images', async () => {
    const pdf = await generateExecutivePdf(baseData());
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdfHasEmbeddedImages(pdf)).toBe(false);
  });

  it('stays within 2 pages with no footer-only orphans', async () => {
    const pdf = await generateExecutivePdf(baseData());
    const pages = pdfPageCount(pdf);
    expect(pages).toBeGreaterThanOrEqual(1);
    expect(pages).toBeLessThanOrEqual(2);
  });

  it('does not print absurd period % when prior is below materiality threshold', async () => {
    const data = baseData();
    data.prior.costUsd = 0.5;
    data.pctChangeVsPrior = 28984.2;
    data.oneLiner = buildOneLiner({
      totalCost: data.current.costUsd,
      priorCost: data.prior.costUsd,
      pctChange: data.pctChangeVsPrior,
      calls: data.current.calls,
      attributionLive: false,
      netValue: null,
      lari: null,
    });
    expect(data.oneLiner).toContain(NEW_SPEND_LABEL);
    const pdf = await generateExecutivePdf(data);
    expect(pdfContainsAbsurdPeriodPct(pdf)).toBe(false);
    expect(pdf.toString('latin1')).not.toMatch(/28984/);
  });
});
