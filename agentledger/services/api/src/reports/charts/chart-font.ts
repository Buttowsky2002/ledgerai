import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CHART_FONT_FAMILY = 'DejaVu Sans';

let cachedBase64: string | null = null;

/** Absolute path to the vendored DejaVu Sans TTF (works locally, dist/, and Docker). */
export function chartFontPath(): string {
  const candidates = [
    join(__dirname, '..', '..', 'assets', 'fonts', 'DejaVuSans.ttf'),
    join(process.cwd(), 'dist', 'assets', 'fonts', 'DejaVuSans.ttf'),
    join(process.cwd(), 'assets', 'fonts', 'DejaVuSans.ttf'),
    join(__dirname, '..', '..', '..', 'assets', 'fonts', 'DejaVuSans.ttf'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `Chart font DejaVuSans.ttf not found (searched: ${candidates.join('; ')}). Rebuild the API (npm run build) or rebuild the Docker image.`,
  );
}

function fontBase64(): string {
  if (!cachedBase64) {
    cachedBase64 = readFileSync(chartFontPath()).toString('base64');
  }
  return cachedBase64;
}

/** CSS @font-face block embedded in every chart SVG so librsvg can rasterize text. */
export function chartFontFaceCss(): string {
  return `@font-face{font-family:'${CHART_FONT_FAMILY}';src:url('data:font/ttf;base64,${fontBase64()}') format('truetype');font-weight:normal;font-style:normal;}`;
}

/** Wrap chart body SVG with embedded font + default text styling. */
export function wrapChartSvg(inner: string, width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs><style>${chartFontFaceCss()} text,tspan{font-family:'${CHART_FONT_FAMILY}',sans-serif;}</style></defs>
${inner}
</svg>`;
}

/** True when SVG includes an embedded DejaVu @font-face (chart label regression guard). */
export function svgEmbedsChartFont(svg: string): boolean {
  return svg.includes('@font-face') && svg.includes(CHART_FONT_FAMILY) && svg.includes('data:font/ttf;base64,');
}

/** Text helper for SVG labels — always uses the embedded chart font. */
export function svgText(
  x: number,
  y: number,
  content: string,
  opts: { size?: number; fill?: string; anchor?: string } = {},
): string {
  const size = opts.size ?? 10;
  const fill = opts.fill ?? '#334155';
  const anchor = opts.anchor ? ` text-anchor="${opts.anchor}"` : '';
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-family="'${CHART_FONT_FAMILY}', sans-serif"${anchor}>${content}</text>`;
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
