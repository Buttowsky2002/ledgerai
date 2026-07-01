import PDFDocument from 'pdfkit';
import type { ExecutiveReportData, PlatformBreakdownRow } from '../executive-report.types';
import type { ModelSpendTableRow, UserSpendTableRow } from '../report-tables';
import {
  formatPeriodChange,
  shouldRenderCacheCallout,
  shouldRenderCostPer1k,
  shouldRenderRisk,
  shouldRenderSummary,
  shouldRenderUserSpend,
} from '../executive-report.should-render';
import {
  formatInt,
  formatPctShare,
  formatTokens,
  formatUsd,
  formatUsdExact,
} from '../formatters';
import { costBasisLabel } from '../platform-breakdown';
import { PDF_THEME as T } from './report-pdf-theme';

const HEADER_H = 16;
const ROW_H = 14;
const FOOTER_Y_OFFSET = 44;
const CONTENT_BOTTOM_PAD = 72;

type PdfDoc = InstanceType<typeof PDFDocument>;

type LayoutCtx = {
  doc: PdfDoc;
  data: ExecutiveReportData;
  contentBottom: number;
  marginX: number;
  contentW: number;
};

type ColAlign = 'left' | 'right';

type TableColumn<T> = {
  header: string;
  width: number;
  align: ColAlign;
  text: (row: T) => string;
};

function platformLabel(provider: string): string {
  if (provider === 'github_copilot') return 'GitHub Copilot';
  return provider;
}

function dateRangeLabel(from: string, to: string, days: number): string {
  return `${from} - ${to} (${days} days)`;
}

function contentBottomY(doc: PdfDoc): number {
  return doc.page.height - CONTENT_BOTTOM_PAD;
}

function truncateToWidth(doc: PdfDoc, text: string, maxWidth: number): string {
  if (!text) return '';
  if (doc.widthOfString(text) <= maxWidth) return text;
  const ell = '…';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.widthOfString(text.slice(0, mid) + ell) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + ell : ell;
}

function paintInkBackground(doc: PdfDoc): void {
  doc.save();
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(T.ink);
  doc.restore();
}

function paintFixedFooters(doc: PdfDoc, data: ExecutiveReportData): void {
  const range = doc.bufferedPageRange();
  const total = range.count;
  const footerY = doc.page.height - FOOTER_Y_OFFSET;
  const footerText = `BadgerIQ Executive Report · ${data.tenantName} · ${dateRangeLabel(
    data.window.from,
    data.window.to,
    data.window.days,
  )}`;

  for (let i = 0; i < total; i++) {
    doc.switchToPage(range.start + i);
    const savedMargins = doc.page.margins;
    doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };
    doc.save();
    doc.fontSize(7).fillColor(T.muted);
    doc.text(footerText, 48, footerY, {
      width: doc.page.width - 96,
      align: 'center',
      lineBreak: false,
    });
    doc.text(`Page ${i + 1} of ${total}`, doc.page.width - 108, footerY, {
      width: 60,
      align: 'right',
      lineBreak: false,
    });
    doc.restore();
    doc.page.margins = savedMargins;
  }

  doc.switchToPage(range.start + total - 1);
  doc.x = 48;
  doc.y = 48;
}

function ensureSpace(ctx: LayoutCtx, needed: number): void {
  if (ctx.doc.y + needed > ctx.contentBottom) {
    ctx.doc.addPage();
    ctx.doc.y = 48;
    ctx.contentBottom = contentBottomY(ctx.doc);
  }
}

type KpiTile = { label: string; value: string };

function drawKpiBand(ctx: LayoutCtx, tiles: KpiTile[]): void {
  if (tiles.length === 0) return;
  const { doc } = ctx;
  const startY = doc.y;
  const gap = 8;
  const tileW = (ctx.contentW - gap * (tiles.length - 1)) / tiles.length;
  tiles.forEach((tile, i) => {
    const x = ctx.marginX + i * (tileW + gap);
    doc.roundedRect(x, startY, tileW, 52, 4).fillAndStroke(T.panel, T.edge);
    doc.fillColor(T.muted).fontSize(7).text(tile.label, x + 6, startY + 6, { width: tileW - 12, lineBreak: false });
    const valueSize = tile.value.length > 22 ? 8 : 11;
    doc.fillColor(T.accent).fontSize(valueSize).text(tile.value, x + 6, startY + 20, {
      width: tileW - 12,
      lineGap: 1,
    });
  });
  doc.y = startY + 60;
}

function drawTableHeader<T>(ctx: LayoutCtx, columns: TableColumn<T>[], y: number): void {
  const { doc } = ctx;
  doc.save();
  doc.rect(ctx.marginX, y - 2, ctx.contentW, HEADER_H).fill(T.panel2);
  doc.fillColor(T.muted).fontSize(7).font('Helvetica-Bold');
  let x = ctx.marginX + 4;
  for (const col of columns) {
    const label = col.align === 'right' ? truncateToWidth(doc, col.header, col.width - 8) : col.header;
    doc.text(label, x, y, { width: col.width - 8, align: col.align, lineBreak: false });
    x += col.width;
  }
  doc.restore();
  doc.font('Helvetica');
}

function drawTableRow<T>(ctx: LayoutCtx, columns: TableColumn<T>[], row: T, y: number, zebra: boolean): void {
  const { doc } = ctx;
  if (zebra) {
    doc.save();
    doc.rect(ctx.marginX, y - 1, ctx.contentW, ROW_H).fill(T.panel);
    doc.restore();
  }
  doc.save();
  doc.strokeColor(T.edge).lineWidth(0.5);
  doc.moveTo(ctx.marginX, y + ROW_H - 2).lineTo(ctx.marginX + ctx.contentW, y + ROW_H - 2).stroke();
  doc.restore();

  doc.fillColor(T.text).fontSize(7);
  let x = ctx.marginX + 4;
  for (const col of columns) {
    const raw = col.text(row);
    const cell = truncateToWidth(doc, raw, col.width - 8);
    doc.text(cell, x, y, { width: col.width - 8, align: col.align, lineBreak: false });
    x += col.width;
  }
}

function drawTable<T>(
  ctx: LayoutCtx,
  title: string,
  columns: TableColumn<T>[],
  rows: T[],
  minRowsOnPage = 2,
): void {
  if (rows.length === 0) return;
  const { doc } = ctx;
  const tableBlock = HEADER_H + 4 + ROW_H * Math.min(rows.length, minRowsOnPage) + 20;
  ensureSpace(ctx, tableBlock);

  doc.fillColor(T.text).fontSize(11).text(title, ctx.marginX, doc.y, { lineBreak: false });
  doc.y += 16;

  let rowIndex = 0;
  let headerDrawn = false;

  while (rowIndex < rows.length) {
    const headerY = doc.y;
    if (!headerDrawn || doc.y + ROW_H * minRowsOnPage > ctx.contentBottom) {
      if (headerDrawn) {
        ensureSpace(ctx, HEADER_H + ROW_H * minRowsOnPage + 8);
      }
      drawTableHeader(ctx, columns, doc.y);
      doc.y = headerY + HEADER_H + 4;
      headerDrawn = true;
    }

    const rowsThisPage = Math.floor((ctx.contentBottom - doc.y) / ROW_H);
    const batch = Math.max(minRowsOnPage, Math.min(rowsThisPage, rows.length - rowIndex));
    if (batch <= 0) {
      doc.addPage();
      doc.y = 48;
      ctx.contentBottom = contentBottomY(doc);
      headerDrawn = false;
      continue;
    }

    for (let i = 0; i < batch && rowIndex < rows.length; i++, rowIndex++) {
      const y = doc.y;
      drawTableRow(ctx, columns, rows[rowIndex], y, rowIndex % 2 === 1);
      doc.y = y + ROW_H;
    }

    if (rowIndex < rows.length) {
      doc.addPage();
      doc.y = 48;
      ctx.contentBottom = contentBottomY(doc);
      headerDrawn = false;
    }
  }
  doc.moveDown(0.4);
}

const userColumns = (ctx: LayoutCtx): TableColumn<UserSpendTableRow>[] => [
  {
    header: 'User',
    width: Math.round(ctx.contentW * 0.36),
    align: 'left',
    text: (r) => r.displayName,
  },
  {
    header: 'Spend',
    width: Math.round(ctx.contentW * 0.18),
    align: 'right',
    text: (r) => formatUsdExact(r.costUsd),
  },
  {
    header: '% of total',
    width: Math.round(ctx.contentW * 0.14),
    align: 'right',
    text: (r) => formatPctShare(r.pctOfTotal),
  },
  {
    header: 'Top model',
    width: Math.round(ctx.contentW * 0.32),
    align: 'left',
    text: (r) => r.topModel || '—',
  },
];

const modelColumns = (ctx: LayoutCtx): TableColumn<ModelSpendTableRow>[] => [
  {
    header: 'Model',
    width: Math.round(ctx.contentW * 0.34),
    align: 'left',
    text: (r) => r.model,
  },
  {
    header: 'Platform',
    width: Math.round(ctx.contentW * 0.16),
    align: 'left',
    text: (r) => platformLabel(r.provider),
  },
  {
    header: 'Spend',
    width: Math.round(ctx.contentW * 0.16),
    align: 'right',
    text: (r) => formatUsdExact(r.costUsd),
  },
  {
    header: '%',
    width: Math.round(ctx.contentW * 0.1),
    align: 'right',
    text: (r) => formatPctShare(r.pctOfTotal),
  },
  {
    header: 'Calls',
    width: Math.round(ctx.contentW * 0.14),
    align: 'right',
    text: (r) => formatInt(r.calls),
  },
];

function drawPlatformSection(ctx: LayoutCtx, platforms: PlatformBreakdownRow[]): void {
  const { doc } = ctx;
  if (platforms.length === 0) return;

  ensureSpace(ctx, 24);
  doc.fillColor(T.text).fontSize(11).text('Platform Breakdown', ctx.marginX, doc.y, { lineBreak: false });
  doc.y += 14;

  for (const platform of platforms) {
    ensureSpace(ctx, 14 + platform.models.length * 12);
    const basis = costBasisLabel(platform.costBasis);
    const platformLabelText = truncateToWidth(
      doc,
      `${platformLabel(platform.provider)} ${basis}`,
      ctx.contentW * 0.55,
    );
    doc.fillColor(T.accent).fontSize(8).font('Helvetica-Bold');
    doc.text(platformLabelText, ctx.marginX, doc.y, { continued: true, lineBreak: false });
    doc.font('Helvetica').fillColor(T.text).text(`  ${formatUsdExact(platform.costUsd)}`, { continued: false });
    doc.y += 12;

    doc.fontSize(7).fillColor(T.muted);
    for (const model of platform.models) {
      ensureSpace(ctx, 12);
      const modelLabel = truncateToWidth(doc, model.model, ctx.contentW * 0.5);
      doc.text(`    ${modelLabel}`, ctx.marginX + 8, doc.y, { continued: true, lineBreak: false, width: ctx.contentW * 0.55 });
      doc.fillColor(T.muted).text(`  ${formatUsdExact(model.costUsd)}`, { continued: false });
      doc.fillColor(T.muted);
      doc.y += 11;
    }
    if (platform.remainderUsd !== 0) {
      ensureSpace(ctx, 12);
      doc.text('    rounding/other', ctx.marginX + 8, doc.y, { continued: true, lineBreak: false });
      doc.fillColor(T.muted).text(`  ${formatUsdExact(platform.remainderUsd)}`, { continued: false });
      doc.fillColor(T.muted);
      doc.y += 11;
    }
    doc.moveDown(0.15);
  }
}

function drawBrandHeader(doc: PdfDoc): void {
  doc.rect(0, 0, doc.page.width, 56).fill(T.panel);
  doc.rect(0, 55, doc.page.width, 1).fill(T.accent);
  doc.fillColor(T.accent).fontSize(18).text('BadgerIQ', 48, 18, { lineBreak: false });
  doc.fillColor(T.muted).fontSize(10).text('Executive AI Report', 48, 38, { lineBreak: false });
}

function drawTitleBlock(doc: PdfDoc, data: ExecutiveReportData): void {
  doc.fillColor(T.text);
  doc.y = 72;
  const titleY = doc.y;
  doc.fontSize(14).text(data.tenantName, 48, titleY, { lineBreak: false });
  doc.fontSize(10).fillColor(T.muted).text(
    dateRangeLabel(data.window.from, data.window.to, data.window.days),
    48,
    titleY + 18,
    { lineBreak: false },
  );
  doc.y = titleY + 36;
}

export function generateExecutivePdf(data: ExecutiveReportData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (c) => chunks.push(c));
  paintInkBackground(doc);
  doc.on('pageAdded', () => paintInkBackground(doc));

  const ctx: LayoutCtx = {
    doc,
    data,
    contentBottom: contentBottomY(doc),
    marginX: 48,
    contentW: doc.page.width - 96,
  };

  drawBrandHeader(doc);
  drawTitleBlock(doc, data);

  if (shouldRenderSummary(data)) {
    const tiles: KpiTile[] = [];
    if (data.current.costUsd > 0) {
      tiles.push({ label: 'Total AI spend', value: formatUsd(data.current.costUsd) });
    }
    if (data.current.calls > 0) {
      tiles.push({ label: 'Total calls', value: formatInt(data.current.calls) });
    }
    if (
      shouldRenderCostPer1k(data.current.inputTokens + data.current.outputTokens) &&
      data.costPer1kTokens !== null
    ) {
      tiles.push({ label: 'Cost / 1K tokens', value: formatUsdExact(data.costPer1kTokens) });
    }
    const change = formatPeriodChange(data.prior.costUsd, data.current.costUsd, data.pctChangeVsPrior, (n) =>
      `${n > 0 ? '+' : ''}${n.toFixed(1)}%`,
    );
    if (change) {
      tiles.push({ label: 'Vs prior period', value: change });
    }
    drawKpiBand(ctx, tiles);
  }

  doc.fontSize(9).fillColor(T.muted).text(data.oneLiner, ctx.marginX, doc.y, {
    width: ctx.contentW,
    lineGap: 2,
  });
  doc.moveDown(0.6);

  if (shouldRenderUserSpend(data.userSpendTable)) {
    drawTable(ctx, 'Cost per Person', userColumns(ctx), data.userSpendTable);
  }

  doc.addPage();
  doc.y = 48;
  ctx.contentBottom = contentBottomY(doc);

  if (data.modelSpendTable.length > 0) {
    drawTable(ctx, 'Spend by Model', modelColumns(ctx), data.modelSpendTable);
  }

  if (data.platformBreakdown.length > 0) {
    drawPlatformSection(ctx, data.platformBreakdown);
  }

  if (shouldRenderCacheCallout(data.current.cachedTokens)) {
    ensureSpace(ctx, 20);
    doc.fontSize(8).fillColor(T.pos).text(
      `Cache reads: ${formatTokens(data.current.cachedTokens)} tokens.`,
      ctx.marginX,
      doc.y,
      { width: ctx.contentW, lineBreak: false },
    );
    doc.moveDown(0.3);
  }

  if (shouldRenderRisk(data.blockedEvents, data.risk)) {
    ensureSpace(ctx, 60);
    doc.fillColor(T.neg).fontSize(11).text('Risk Callout', ctx.marginX, doc.y, { lineBreak: false });
    doc.y += 14;
    doc.fontSize(9).fillColor(T.muted);
    doc.text(`${formatInt(data.blockedEvents)} DLP-blocked events in this period.`, ctx.marginX, doc.y, {
      width: ctx.contentW,
    });
    doc.moveDown(0.2);
    for (const row of data.risk.filter((r) => r.events > 0 && r.dlpAction !== 'allow').slice(0, 5)) {
      doc.text(`- ${row.dlpAction} (${row.riskSeverity || 'unspecified'}): ${formatInt(row.events)}`, ctx.marginX, doc.y, {
        width: ctx.contentW,
      });
      doc.moveDown(0.15);
    }
  }

  paintFixedFooters(doc, data);

  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/** @internal test helper — scan PDF bytes for absurd period-over-period percentages. */
export function pdfContainsAbsurdPeriodPct(pdf: Buffer): boolean {
  const raw = pdf.toString('latin1');
  return /\+?\d{4,}\.\d%/.test(raw);
}
