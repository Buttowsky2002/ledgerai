import { formatUsdExact } from '../formatters';
import { escapeXml, svgText, wrapChartSvg } from './chart-font';

export interface ChartSize {
  width: number;
  height: number;
}

const COLORS = ['#2563eb', '#7c3aed', '#059669', '#d97706', '#dc2626', '#0891b2', '#4f46e5', '#be185d'];

function maxVal(values: number[]): number {
  return values.length ? Math.max(...values, 0) : 0;
}

/** Align prior-period daily costs to current-period day index for ghost overlay. */
export function alignPriorTrend(
  current: { day: string; costUsd: number }[],
  prior: { day: string; costUsd: number }[],
): { costUsd: number }[] {
  if (current.length === 0) return [];
  const priorSorted = [...prior].sort((a, b) => a.day.localeCompare(b.day));
  return current.map((_, i) => ({ costUsd: priorSorted[i]?.costUsd ?? 0 }));
}

/** Line chart: current solid, prior ghosted. Returns SVG string with embedded font. */
export function spendTrendSvg(
  current: { costUsd: number }[],
  prior: { costUsd: number }[],
  size: ChartSize = { width: 520, height: 200 },
): string {
  const { width, height } = size;
  const pad = { l: 48, r: 16, t: 16, b: 32 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const n = Math.max(current.length, prior.length, 1);
  const maxY = maxVal([...current.map((d) => d.costUsd), ...prior.map((d) => d.costUsd), 1]);

  const toX = (i: number) => pad.l + (i / Math.max(n - 1, 1)) * plotW;
  const toY = (v: number) => pad.t + plotH - (v / maxY) * plotH;

  const line = (pts: { costUsd: number }[], opacity: number, dash?: string) => {
    if (pts.length === 0) return '';
    const d = pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(p.costUsd).toFixed(1)}`)
      .join(' ');
    return `<path d="${d}" fill="none" stroke="#2563eb" stroke-width="2" opacity="${opacity}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
  };

  const inner = `<rect width="100%" height="100%" fill="#ffffff"/>
${svgText(pad.l, pad.t + 8, escapeXml(formatUsdExact(maxY)), { size: 10, fill: '#64748b' })}
${line(prior, 0.35, '4 4')}
${line(current, 1)}
<line x1="${pad.l}" y1="${pad.t + plotH}" x2="${width - pad.r}" y2="${pad.t + plotH}" stroke="#e2e8f0"/>`;

  return wrapChartSvg(inner, width, height);
}

/** Donut chart for provider breakdown with readable legend. */
export function providerDonutSvg(
  rows: { provider: string; costUsd: number }[],
  size: ChartSize = { width: 520, height: 220 },
): string {
  const { width, height } = size;
  const cx = width / 2;
  const cy = height / 2 - 10;
  const r = 70;
  const ir = 42;
  const total = rows.reduce((s, x) => s + x.costUsd, 0) || 1;
  let angle = -Math.PI / 2;
  const slices = rows.map((row, i) => {
    const frac = row.costUsd / total;
    const a2 = angle + frac * Math.PI * 2;
    const path = donutSlice(cx, cy, r, ir, angle, a2);
    angle = a2;
    return `<path d="${path}" fill="${COLORS[i % COLORS.length]}"/>`;
  });
  const legend = rows
    .map((row, i) => {
      const y = height - 20 - (rows.length - 1 - i) * 14;
      return `<rect x="16" y="${y - 8}" width="10" height="10" fill="${COLORS[i % COLORS.length]}"/>
${svgText(32, y, escapeXml(`${row.provider} ${formatUsdExact(row.costUsd)}`), { size: 9 })}`;
    })
    .join('\n');

  const inner = `<rect width="100%" height="100%" fill="#ffffff"/>
${slices.join('\n')}
${legend}`;

  return wrapChartSvg(inner, width, height);
}

/** Compact horizontal platform strip for page 1 when space allows. */
export function platformStripSvg(
  rows: { provider: string; costUsd: number }[],
  size: ChartSize = { width: 520, height: 48 },
): string {
  const { width, height } = size;
  const maxX = maxVal(rows.map((r) => r.costUsd)) || 1;
  const labelW = 100;
  const plotW = width - labelW - 70;
  const barH = 12;
  const bars = rows
    .slice(0, 6)
    .map((r, i) => {
      const y = 8 + i * (barH + 4);
      const w = (r.costUsd / maxX) * plotW;
      return `${svgText(0, y + barH * 0.8, escapeXml(r.provider.slice(0, 14)), { size: 9 })}
<rect x="${labelW}" y="${y}" width="${w.toFixed(1)}" height="${barH}" fill="${COLORS[i % COLORS.length]}" rx="2"/>
${svgText(labelW + w + 4, y + barH * 0.8, escapeXml(formatUsdExact(r.costUsd)), { size: 8, fill: '#64748b' })}`;
    })
    .join('\n');
  const inner = `<rect width="100%" height="100%" fill="#ffffff"/>${bars}`;
  return wrapChartSvg(inner, width, Math.max(height, 8 + rows.length * (barH + 4)));
}

function donutSlice(cx: number, cy: number, r: number, ir: number, a1: number, a2: number): string {
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  const x2 = cx + r * Math.cos(a2);
  const y2 = cy + r * Math.sin(a2);
  const xi1 = cx + ir * Math.cos(a2);
  const yi1 = cy + ir * Math.sin(a2);
  const xi2 = cx + ir * Math.cos(a1);
  const yi2 = cy + ir * Math.sin(a1);
  const large = a2 - a1 > Math.PI ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${xi1} ${yi1} A ${ir} ${ir} 0 ${large} 0 ${xi2} ${yi2} Z`;
}
