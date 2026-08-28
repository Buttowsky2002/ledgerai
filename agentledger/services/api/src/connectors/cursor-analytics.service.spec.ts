import { CursorAnalyticsService } from './cursor-analytics.service';
import type { AnalyticsStore } from '../analytics-store/analytics-store';

describe('CursorAnalyticsService.getSpendSummary', () => {
  it('counts included usage value only — not on-demand chargedCents', async () => {
    const queryScoped = jest.fn(async (sql: string) => {
      if (sql.includes('GROUP BY model')) {
        return [
          {
            model: 'claude-4-sonnet',
            billed_usd: 8.75,
            usage_value_usd: 0.08,
            calls: 2,
          },
        ];
      }
      if (sql.includes('toDate(ts) AS day')) {
        return [{ day: '2026-07-01', cost_usd: 8.75, calls: 1 }];
      }
      // Totals query — assert SQL filters included usage.
      expect(sql).toContain("operation_name = 'cursor:included'");
      expect(sql).toContain('legacy_usage_usd');
      return [
        {
          billed_usd: 8.75,
          usage_value_usd: 0.08,
          legacy_usage_usd: 0,
          calls: 2,
          included_calls: 1,
          on_demand_calls: 1,
          legacy_calls: 0,
          tokens: 576,
        },
      ];
    });

    const ch = { queryScoped } as unknown as AnalyticsStore;
    const svc = new CursorAnalyticsService(ch);
    const summary = await svc.getSpendSummary('t1', '2026-07-01', '2026-07-31');

    expect(summary).toMatchObject({
      billedUsd: 8.75,
      meteredOverageUsd: 8.75,
      usageValueUsd: 0.08,
      totalCalls: 2,
      includedCalls: 1,
      onDemandCalls: 1,
      totalTokens: 576,
      legacyUntagged: false,
    });
    expect(summary!.modelMix[0]).toMatchObject({
      billed_usd: 8.75,
      usage_value_usd: 0.08,
    });
  });

  it('does not fold legacy untagged usage into included usage value', async () => {
    const queryScoped = jest.fn(async (sql: string) => {
      if (sql.includes('GROUP BY model')) {return [];}
      if (sql.includes('toDate(ts) AS day')) {return [];}
      return [
        {
          billed_usd: 0,
          usage_value_usd: 0,
          legacy_usage_usd: 12.5,
          calls: 3,
          included_calls: 0,
          on_demand_calls: 0,
          legacy_calls: 3,
          tokens: 100,
        },
      ];
    });

    const svc = new CursorAnalyticsService({ queryScoped } as unknown as AnalyticsStore);
    const summary = await svc.getSpendSummary('t1', '2026-07-01', '2026-07-31');

    expect(summary).toMatchObject({
      billedUsd: 0,
      usageValueUsd: 0,
      legacyUntagged: true,
      totalCalls: 3,
    });
    expect(summary!.disclaimer).toContain('untagged');
  });
});
