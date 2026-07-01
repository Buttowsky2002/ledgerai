import { buildOneLiner, formatPct, oneLinerHasImmateralPct } from './formatters';
import { formatPeriodChange, NEW_SPEND_LABEL, periodDeltaPct } from './executive-report.should-render';

describe('formatPeriodChange / one-liner', () => {
  it('never shows percent when prior is zero or below $1', () => {
    expect(periodDeltaPct(290, 0)).toBeNull();
    expect(periodDeltaPct(290, 0.99)).toBeNull();
    expect(formatPeriodChange(0, 100, null, formatPct)).toBe(NEW_SPEND_LABEL);
    expect(formatPeriodChange(0.5, 100, null, formatPct)).toBe(NEW_SPEND_LABEL);
    expect(formatPeriodChange(0.5, 100, 28984, formatPct)).toBe(NEW_SPEND_LABEL);

    const liner = buildOneLiner({
      totalCost: 290,
      priorCost: 0.5,
      pctChange: null,
      calls: 10,
      attributionLive: false,
      netValue: null,
      lari: null,
    });
    expect(liner).toContain(NEW_SPEND_LABEL);
    expect(oneLinerHasImmateralPct(0.5, liner)).toBe(false);
    expect(liner).not.toMatch(/28984/);
  });

  it('shows percent only when prior meets materiality threshold', () => {
    expect(formatPeriodChange(100, 120, 20, formatPct)).toBe('+20.0%');
    expect(formatPeriodChange(19, 3086, 16325, formatPct)).toBe(NEW_SPEND_LABEL);
  });
});
