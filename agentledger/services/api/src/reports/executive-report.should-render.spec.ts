import {
  addDays,
  daysBetweenInclusive,
  formatPeriodChange,
  NEW_SPEND_LABEL,
  periodDeltaPct,
  PRIOR_PCT_MIN_USD,
  priorWindow,
  rollupUserSpend,
  shouldRenderPctChange,
  shouldRenderProviderChart,
  shouldRenderRisk,
  shouldRenderSingleProviderLabel,
  shouldRenderSpendTrend,
  shouldRenderValueKpis,
  shouldShowPctValue,
} from './executive-report.should-render';

describe('executive-report.should-render', () => {
  describe('priorWindow', () => {
    it('returns an equal-length window immediately before from', () => {
      expect(priorWindow('2026-06-10', '2026-06-16')).toEqual({ from: '2026-06-03', to: '2026-06-09' });
      expect(daysBetweenInclusive('2026-06-03', '2026-06-09')).toBe(7);
      expect(daysBetweenInclusive('2026-06-10', '2026-06-16')).toBe(7);
    });
  });

  describe('periodDeltaPct', () => {
    it('computes percent change vs prior when material', () => {
      expect(periodDeltaPct(120, 100)).toBe(20);
      expect(periodDeltaPct(80, 100)).toBe(-20);
    });

    it('returns null when prior is zero', () => {
      expect(periodDeltaPct(100, 0)).toBeNull();
    });

    it('returns null when prior is below relative materiality threshold', () => {
      expect(periodDeltaPct(3086, 19)).toBeNull();
      expect(periodDeltaPct(290, 0.5)).toBeNull();
      expect(periodDeltaPct(290, PRIOR_PCT_MIN_USD - 0.01)).toBeNull();
    });

    it('computes when prior meets threshold', () => {
      expect(periodDeltaPct(150, 10)).toBe(1400);
      expect(periodDeltaPct(120, 100)).toBe(20);
    });
  });

  describe('periodChangeDisplay / formatPeriodChange', () => {
    it('shows baseline copy for tiny/zero prior with current spend', () => {
      expect(formatPeriodChange(0, 100, null, (n) => `${n}%`)).toBe(NEW_SPEND_LABEL);
      expect(formatPeriodChange(0.25, 100, null, (n) => `${n}%`)).toBe(NEW_SPEND_LABEL);
    });

    it('suppresses when no current spend', () => {
      expect(formatPeriodChange(0, 0, null, (n) => `${n}%`)).toBeNull();
    });
  });

  describe('addDays', () => {
    it('shifts ISO dates in UTC', () => {
      expect(addDays('2026-01-15', -1)).toBe('2026-01-14');
      expect(addDays('2026-01-15', 10)).toBe('2026-01-25');
    });
  });

  describe('shouldRender guards', () => {
    it('suppresses pct change when prior is below materiality threshold', () => {
      expect(shouldRenderPctChange(0, 100)).toBe(false);
      expect(shouldRenderPctChange(0.5, 100)).toBe(false);
      expect(shouldRenderPctChange(19, 3086)).toBe(false);
      expect(shouldRenderPctChange(200, 3086)).toBe(true);
      expect(shouldShowPctValue(10, 100, 10)).toBe(true);
      expect(shouldShowPctValue(0.5, 100, 28984)).toBe(false);
    });

    it('renders spend trend only with positive daily cost', () => {
      expect(shouldRenderSpendTrend([{ day: '2026-01-01', costUsd: 0 }])).toBe(false);
      expect(shouldRenderSpendTrend([{ day: '2026-01-01', costUsd: 1 }])).toBe(true);
    });

    it('requires two providers for provider chart', () => {
      expect(shouldRenderProviderChart([{ provider: 'a', costUsd: 1, calls: 1 }])).toBe(false);
      expect(
        shouldRenderProviderChart([
          { provider: 'a', costUsd: 1, calls: 1 },
          { provider: 'b', costUsd: 2, calls: 1 },
        ]),
      ).toBe(true);
    });

    it('labels single provider without chart', () => {
      expect(shouldRenderSingleProviderLabel([{ provider: 'openai', costUsd: 5, calls: 1 }])).toBe(true);
      expect(shouldRenderSingleProviderLabel([])).toBe(false);
    });

    it('shows value KPIs only when attribution is live and outcomes exist', () => {
      const metrics = {
        outcomes: 2,
        businessValueUsd: 100,
        fullyLoadedCostUsd: 20,
        netValueUsd: 80,
        riskAdjustedRoiUsd: 70,
        lari: 3.5,
        avgConfidence: 0.9,
      };
      expect(shouldRenderValueKpis(false, metrics)).toBe(false);
      expect(shouldRenderValueKpis(true, null)).toBe(false);
      expect(shouldRenderValueKpis(true, { ...metrics, outcomes: 0 })).toBe(false);
      expect(shouldRenderValueKpis(true, metrics)).toBe(true);
    });

    it('omits risk section when no blocked/DLP events', () => {
      expect(shouldRenderRisk(0, [])).toBe(false);
      expect(shouldRenderRisk(0, [{ dlpAction: 'allow', riskSeverity: 'low', events: 5 }])).toBe(false);
      expect(shouldRenderRisk(1, [])).toBe(true);
      expect(shouldRenderRisk(0, [{ dlpAction: 'block', riskSeverity: 'high', events: 2 }])).toBe(true);
    });
  });

  describe('rollupUserSpend', () => {
    it('rolls remainder into All others after top 15', () => {
      const rows = Array.from({ length: 20 }, (_, i) => ({
        userId: `u${i}`,
        displayName: `User ${i}`,
        teamName: 'Eng',
        costUsd: 100 - i,
        calls: 1,
      }));
      const rolled = rollupUserSpend(rows, 15);
      expect(rolled).toHaveLength(16);
      expect(rolled[15].displayName).toBe('All others');
      expect(rolled[15].costUsd).toBe(85 + 84 + 83 + 82 + 81);
    });
  });
});
