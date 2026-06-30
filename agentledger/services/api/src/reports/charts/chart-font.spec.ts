import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { chartFontPath, svgEmbedsChartFont } from './chart-font';
import { providerDonutSvg, spendTrendSvg } from './chart-renderer';

describe('chart-font', () => {
  it('loads vendored DejaVuSans.ttf', () => {
    const buf = readFileSync(chartFontPath());
    expect(buf.length).toBeGreaterThan(100_000);
    expect(buf.subarray(0, 4).toString()).toBe('\x00\x01\x00\x00');
  });

  it('embeds font in spend trend SVG and rasterizes readable labels', async () => {
    const svg = spendTrendSvg([{ costUsd: 10 }, { costUsd: 25 }], [{ costUsd: 5 }], { width: 400, height: 120 });
    expect(svgEmbedsChartFont(svg)).toBe(true);
    expect(svg).toContain('DejaVu Sans');
    expect(svg).toContain('$25.00');

    const png = await sharp(Buffer.from(svg), { density: 144 }).png().toBuffer();
    expect(png.length).toBeGreaterThan(500);
  });

  it('renders provider legend text in PNG (not empty/tofu-only)', async () => {
    const svg = providerDonutSvg(
      [
        { provider: 'openai', costUsd: 60 },
        { provider: 'anthropic', costUsd: 40 },
      ],
      { width: 400, height: 160 },
    );
    expect(svg).toContain('openai');
    expect(svg).toContain('anthropic');
    expect(svgEmbedsChartFont(svg)).toBe(true);

    const stats = await sharp(Buffer.from(svg), { density: 144 }).png().stats();
    expect(stats.channels.length).toBeGreaterThan(0);
    expect(stats.channels[0].max - stats.channels[0].min).toBeGreaterThan(50);
  });
});
