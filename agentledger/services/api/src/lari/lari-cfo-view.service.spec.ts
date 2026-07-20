import { AnalyticsStore } from '../analytics-store/analytics-store';
import { CopilotAnalyticsService } from '../github-copilot/github-copilot-analytics.service';
import { PrismaService } from '../prisma/prisma.service';
import { Principal, runWithTenant } from '../tenant/tenant-context';
import { calculateAttributedIncrementalValue, calculateFullyLoadedCost } from './lari';
import { LariCfoViewService } from './lari-cfo-view.service';
import { CostBreakdown, OutcomeLink } from './lari.types';

const principal: Principal = { tenantId: 'tenant-1', userId: 'u1', role: 'viewer' };

function harness(opts?: {
  costBasisTotals?: Record<string, unknown>;
  costBasisMonthly?: Record<string, unknown>[];
  roiRows?: Record<string, unknown>[];
  copilotSpend?: {
    totalCostUsd: number;
    estimatedValueUsd: number;
    totalCalls: number;
  } | null;
  cursorProductivity?: {
    estimatedValueUsd: number;
    activeUserDays: number;
    linesCommitted: number;
    linesAccepted: number;
    distinctUsers: number;
    avgConfidence: number;
    disclaimer: string;
  } | null;
}) {
  const costBasisTotals = opts?.costBasisTotals ?? {
    computed_cost_usd: 100,
    metered_cost_usd: 110,
    effective_cost_usd: 110,
    calls: 50,
    total_keys: 10,
    metered_keys: 6,
  };
  const costBasisMonthly = opts?.costBasisMonthly ?? [
    { month: '2026-06-01', computed_cost_usd: 100, metered_cost_usd: 110, effective_cost_usd: 110 },
  ];
  const roiRows = opts?.roiRows ?? [
    {
      month: '2026-06-01',
      outcome_type: 'pr_merged',
      outcomes: 10,
      value_usd: 1000,
      ai_cost_usd: 40,
      fully_loaded_cost_usd: 60,
      nominal_roi_usd: 940,
      risk_adjusted_roi_usd: 800,
      avg_confidence: 0.8,
    },
  ];

  const queryScoped = jest.fn(async (sql: string) => {
    if (/per_day_model/.test(sql) && /countIf\(reconciled_usd/.test(sql)) return [costBasisTotals];
    if (/per_day_model/.test(sql) && /toStartOfMonth\(day\)/.test(sql)) return costBasisMonthly;
    if (/platform AS provider/.test(sql) && /reconciled/.test(sql)) return [];
    // RECONCILED_MODEL_USAGE_SQL (metered-cost.ts) — unique outer alias; raw rows use cost_usd
    // (service .map renames to computed_cost_usd). Do NOT match spend_daily / computed_cost_usd here.
    if (/sum\(reconciled_input_tokens\) AS input_tokens/.test(sql)) {
      return [
        {
          provider: 'cursor',
          model: 'claude-sonnet',
          input_tokens: 1_000_000,
          output_tokens: 500_000,
          calls: 100,
          cost_usd: 100,
        },
      ];
    }
    if (/v_cost_basis_daily/.test(sql) && /countIf/.test(sql)) return [costBasisTotals];
    if (/v_cost_basis_daily/.test(sql) && /toStartOfMonth/.test(sql)) return costBasisMonthly;
    if (/FROM agentledger\.v_roi/.test(sql) && /outcome_type/.test(sql)) return roiRows;
    if (/FROM agentledger\.v_roi/.test(sql) && /count\(\)/.test(sql)) return [{ cnt: 10 }];
    // Unmapped spend only — do not match other reconciled SQL that embeds 'Unassigned'.
    if (/unmapped_cost/.test(sql) || /spend_daily_by_user/.test(sql)) return [{ unmapped_cost: 0 }];
    if (/coding_agent_daily/.test(sql) && /lines_accepted/.test(sql)) {
      return opts?.cursorProductivity
        ? [
            {
              user_id: 'dev@acme.com',
              day: '2026-06-15',
              lines_accepted: 100,
              lines_added: 200,
              lines_deleted: 10,
              lines_committed: 200,
              tabs_accepted: 20,
              composer_requests: 2,
              chat_requests: 4,
            },
          ]
        : [];
    }
    if (/coding_agent_daily/.test(sql)) return [{ cost_usd: 0 }];
    if (/FROM spend_daily/.test(sql) && /GROUP BY provider, model/.test(sql)) {
      return [
        {
          provider: 'cursor',
          model: 'claude-sonnet',
          input_tokens: 1_000_000,
          output_tokens: 500_000,
          calls: 100,
          computed_cost_usd: 100,
        },
      ];
    }
    if (/v_cost_basis_daily/.test(sql) && /GROUP BY provider, model/.test(sql)) {
      return [
        {
          provider: 'cursor',
          model: 'claude-sonnet',
          computed_cost_usd: 100,
          metered_cost_usd: 110,
          effective_cost_usd: 110,
        },
      ];
    }
    if (/FROM spend_daily/.test(sql) && /GROUP BY provider ORDER BY/.test(sql)) return [];
    if (/fixed_costs/.test(sql)) return [{ cost_usd: 0 }];
    return [];
  });

  const ch = { queryScoped } as unknown as AnalyticsStore;
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $queryRaw: jest.fn(async () => []),
      }),
    ),
  } as unknown as PrismaService;
  const copilotAnalytics = {
    getSpendSummary: jest.fn(async () => opts?.copilotSpend ?? null),
  } as unknown as CopilotAnalyticsService;
  const cursorAnalytics = {
    getSpendSummary: jest.fn(async () =>
      opts?.cursorProductivity
        ? {
            billedUsd: 50,
            meteredOverageUsd: 50,
            usageValueUsd: 100,
            seatLicenseUsd: 40,
            seatCount: 5,
            seatUnitUsdPerMonth: 40,
            seatSource: 'fixed_costs' as const,
            activeMembersInRange: 5,
            totalCalls: 10,
            includedCalls: 5,
            onDemandCalls: 5,
            legacyUntagged: false,
            daily: [],
            modelMix: [],
            platform: { platform: 'cursor', cost_usd: 50, calls: 10 },
            disclaimer: '',
          }
        : null,
    ),
  } as unknown as import('../connectors/cursor-analytics.service').CursorAnalyticsService;
  const cursorProductivity = {
    getProductivitySummary: jest.fn(async () => opts?.cursorProductivity ?? null),
    toOutcomeBreakdownRow: jest.fn((summary: {
      estimatedValueUsd: number;
      activeUserDays: number;
      avgConfidence: number;
    }, spend: number) => ({
      outcomeType: 'cursor_code_activity',
      outcomes: summary.activeUserDays,
      businessValue: summary.estimatedValueUsd,
      fullyLoadedCost: spend,
      nominalRoi: summary.estimatedValueUsd - spend,
      riskAdjustedRoi: summary.estimatedValueUsd * summary.avgConfidence - spend,
      avgConfidence: summary.avgConfidence,
      costPerOutcome: summary.activeUserDays > 0 ? spend / summary.activeUserDays : 0,
    })),
  } as unknown as import('../connectors/cursor-productivity.service').CursorProductivityService;

  return {
    svc: new LariCfoViewService(ch, prisma, copilotAnalytics, cursorAnalytics, cursorProductivity),
    queryScoped,
  };
}

describe('LariCfoViewService helpers', () => {
  it('fully-loaded cost sums all LARI cost components', () => {
    const cost: CostBreakdown = {
      tokenCostUsd: 100,
      humanReviewCostUsd: 20,
      infraCostUsd: 30,
      amortizedBuildCostUsd: 10,
    };
    expect(calculateFullyLoadedCost(cost)).toBe(160);
  });

  it('risk-adjusted value uses attribution confidence', () => {
    const outcomes: OutcomeLink[] = [
      {
        outcome: {
          outcomeId: 'o1',
          outcomeType: 'pr_merged',
          grossValueUsd: 1000,
          source: 'deterministic',
          verified: true,
          occurredAt: '2026-01-01',
        },
        attributionConfidence: 0.8,
        incrementalityFactor: 1,
        attributionMethod: 'deterministic',
        evidenceRefs: [],
      },
    ];
    expect(calculateAttributedIncrementalValue(outcomes)).toBe(800);
  });
});

describe('LariCfoViewService.getCfoView', () => {
  it('uses reconciled (effective) cost basis by default', async () => {
    const { svc } = harness();
    const res = await runWithTenant(principal, () =>
      svc.getCfoView('2026-06-01', '2026-06-30', 0.5, undefined, 'reconciled', 30),
    );
    expect(res.summary.costBasis).toBe('reconciled');
    expect(res.summary.fullyLoadedCost).toBe(130);
    expect(res.costProvenance.effectiveCostUsd).toBe(110);
  });

  it('computes costPerOutcome from observed fully-loaded cost / outcome count', async () => {
    const { svc } = harness();
    const res = await runWithTenant(principal, () =>
      svc.getCfoView('2026-06-01', '2026-06-30', 0.5, undefined, 'reconciled', 30),
    );
    expect(res.summary.costPerOutcome).toBe(13);
    expect(res.outcomeBreakdown[0].costPerOutcome).toBe(13);
    expect(res.costProvenance.stack.tokenUsageUsd).toBe(110);
    expect(res.costProvenance.stack.fixedCostUsd).toBe(0);
    expect(res.modelBreakdown.length).toBeGreaterThan(0);
    expect(res.modelBreakdown[0].costPer1MTokens).toBeGreaterThan(0);
  });

  it('warns when computed vs metered variance exceeds 2%', async () => {
    const { svc } = harness({
      costBasisTotals: {
        computed_cost_usd: 100,
        metered_cost_usd: 110,
        effective_cost_usd: 110,
        calls: 1,
        total_keys: 2,
        metered_keys: 1,
      },
    });
    const res = await runWithTenant(principal, () =>
      svc.getCfoView('2026-06-01', '2026-06-30', 0.5, undefined, 'reconciled', 30),
    );
    expect(res.warnings.some((w) => /variance is 10\.0%/.test(w))).toBe(true);
  });

  it('warns on metered basis when metered coverage is below 50%', async () => {
    const { svc } = harness({
      costBasisTotals: {
        computed_cost_usd: 100,
        metered_cost_usd: 20,
        effective_cost_usd: 100,
        calls: 1,
        total_keys: 10,
        metered_keys: 2,
      },
    });
    const res = await runWithTenant(principal, () =>
      svc.getCfoView('2026-06-01', '2026-06-30', 0.5, undefined, 'metered', 30),
    );
    expect(res.summary.costBasis).toBe('metered');
    expect(res.summary.fullyLoadedCost).toBe(40);
    expect(res.warnings.some((w) => /only 20% of provider\/model keys/.test(w))).toBe(true);
  });

  it('costBasis=computed matches pre-change spend_daily totals (regression pin)', async () => {
    const { svc } = harness({
      costBasisTotals: {
        computed_cost_usd: 100,
        metered_cost_usd: 150,
        effective_cost_usd: 150,
        calls: 50,
        total_keys: 5,
        metered_keys: 5,
      },
    });
    const res = await runWithTenant(principal, () =>
      svc.getCfoView('2026-06-01', '2026-06-30', 0.5, undefined, 'computed', 30),
    );
    expect(res.summary.costBasis).toBe('computed');
    expect(res.summary.fullyLoadedCost).toBe(120);
    expect(res.summary.riskAdjustedRoi).toBe(740);
    expect(res.summary.nominalRoi).toBe(880);
    expect(res.summary.costPerOutcome).toBe(12);
    expect(res.summary.costPerOutcomeFallback).toBeNull();
  });

  it('includes copilot estimated value in risk-adjusted ROI', async () => {
    const { svc } = harness({
      copilotSpend: { totalCostUsd: 50, estimatedValueUsd: 500, totalCalls: 200 },
    });
    const res = await runWithTenant(principal, () =>
      svc.getCfoView('2026-06-01', '2026-06-30', 0.5, undefined, 'reconciled', 30),
    );
    expect(res.summary.businessValue).toBe(1500);
    expect(res.summary.riskAdjustedRoi).toBe(1180);
    expect(res.summary.nominalRoi).toBe(1320);
  });

  it('returns null costPerOutcome and API-call fallback when no outcomes', async () => {
    const { svc } = harness({
      roiRows: [],
      costBasisTotals: {
        computed_cost_usd: 100,
        metered_cost_usd: 110,
        effective_cost_usd: 110,
        calls: 50,
        total_keys: 10,
        metered_keys: 6,
      },
    });
    const res = await runWithTenant(principal, () =>
      svc.getCfoView('2026-06-01', '2026-06-30', 0.5, undefined, 'reconciled', 30),
    );
    expect(res.summary.costPerOutcome).toBeNull();
    expect(res.summary.costPerOutcomeFallback).toBe(2.2);
    expect(res.summary.costPerOutcomeFallbackLabel).toBe('per model call');
    expect(res.summary.costPerOutcomeFallbackBasis).toMatch(/50 API\/model calls/);
  });
});
