import { alignPriorTrend, providerDonutSvg, spendTrendSvg } from './chart-renderer';
import { svgEmbedsChartFont } from './chart-font';

describe('chart-renderer', () => {
  it('produces SVG for spend trend with embedded font', () => {
    const svg = spendTrendSvg(
      [{ costUsd: 10 }, { costUsd: 20 }],
      [{ costUsd: 5 }],
    );
    expect(svg).toContain('<svg');
    expect(svg).toContain('stroke-dasharray');
    expect(svgEmbedsChartFont(svg)).toBe(true);
  });

  it('produces SVG for provider donut with legend labels', () => {
    const svg = providerDonutSvg([
      { provider: 'openai', costUsd: 60 },
      { provider: 'anthropic', costUsd: 40 },
    ]);
    expect(svg).toContain('openai');
    expect(svg).toContain('anthropic');
    expect(svgEmbedsChartFont(svg)).toBe(true);
  });

  it('aligns prior trend by day index', () => {
    const aligned = alignPriorTrend(
      [
        { day: '2026-06-01', costUsd: 10 },
        { day: '2026-06-02', costUsd: 20 },
      ],
      [{ day: '2026-05-01', costUsd: 5 }],
    );
    expect(aligned).toEqual([{ costUsd: 5 }, { costUsd: 0 }]);
  });
});
