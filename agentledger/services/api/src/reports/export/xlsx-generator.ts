import ExcelJS from 'exceljs';
import type { ExecutiveReportData } from '../executive-report.types';
import {
  formatPeriodChange,
  shouldRenderProviderChart,
  shouldRenderRisk,
  shouldRenderSingleProviderLabel,
  shouldRenderSpendTrend,
  shouldRenderSummary,
  shouldRenderUserSpend,
  shouldRenderValueKpis,
} from '../executive-report.should-render';
import { costBasisLabel } from '../platform-breakdown';
import { formatPct, formatPctShare, formatUsdExact } from '../formatters';

export async function generateExecutiveXlsx(data: ExecutiveReportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AgentLedger';
  wb.created = new Date();

  if (shouldRenderSummary(data)) {
    const ws = wb.addWorksheet('Summary');
    ws.columns = [
      { header: 'Metric', key: 'metric', width: 32 },
      { header: 'Value', key: 'value', width: 24 },
    ];
    ws.addRow({ metric: 'Tenant', value: data.tenantName });
    ws.addRow({ metric: 'From', value: data.window.from });
    ws.addRow({ metric: 'To', value: data.window.to });
    ws.addRow({ metric: 'Total AI spend', value: data.current.costUsd });
    const change = formatPeriodChange(data.prior.costUsd, data.current.costUsd, data.pctChangeVsPrior, formatPct);
    if (change) ws.addRow({ metric: 'Change vs prior', value: change });
    ws.addRow({ metric: 'Total calls', value: data.current.calls });
    if (data.costPer1kTokens !== null) {
      ws.addRow({ metric: 'Cost per 1K tokens', value: data.costPer1kTokens });
    }
    if (shouldRenderValueKpis(data.attributionLive, data.valueMetrics) && data.valueMetrics) {
      ws.addRow({ metric: 'Net value', value: data.valueMetrics.netValueUsd });
      if (data.valueMetrics.lari !== null) {
        ws.addRow({ metric: 'LARI', value: data.valueMetrics.lari });
      }
    }
    ws.addRow({ metric: 'Summary', value: data.oneLiner });
    ws.addRow({ metric: 'Cached tokens', value: data.current.cachedTokens });
  }

  if (shouldRenderSpendTrend(data.spendTrend)) {
    const ws = wb.addWorksheet('Spend trend');
    ws.columns = [
      { header: 'Day', key: 'day', width: 14 },
      { header: 'Cost USD', key: 'costUsd', width: 14 },
      { header: 'Prior day index', key: 'priorIndex', width: 16 },
      { header: 'Prior cost USD', key: 'priorCostUsd', width: 16 },
    ];
    const prior = data.priorSpendTrend;
    data.spendTrend.forEach((row, i) => {
      ws.addRow({
        day: row.day,
        costUsd: row.costUsd,
        priorIndex: i + 1,
        priorCostUsd: prior[i]?.costUsd ?? null,
      });
    });
  }

  if (shouldRenderUserSpend(data.userSpendTable)) {
    const ws = wb.addWorksheet('Cost per person');
    ws.columns = [
      { header: 'User', key: 'displayName', width: 32 },
      { header: 'Total spend', key: 'costUsd', width: 14 },
      { header: '% of total', key: 'pctOfTotal', width: 12 },
      { header: 'Top model', key: 'topModel', width: 24 },
      { header: 'Calls', key: 'calls', width: 10 },
    ];
    for (const row of data.userSpendTable) {
      ws.addRow({ ...row, pctOfTotal: formatPctShare(row.pctOfTotal) });
    }
  }

  if (data.modelSpendTable.length > 0) {
    const ws = wb.addWorksheet('Spend by model');
    ws.columns = [
      { header: 'Model', key: 'model', width: 28 },
      { header: 'Platform', key: 'provider', width: 16 },
      { header: 'Total spend', key: 'costUsd', width: 14 },
      { header: '% of total', key: 'pctOfTotal', width: 12 },
      { header: 'Calls', key: 'calls', width: 10 },
    ];
    for (const row of data.modelSpendTable) {
      ws.addRow({ ...row, pctOfTotal: formatPctShare(row.pctOfTotal) });
    }
  }

  const activeProviders = data.providers.filter((p) => p.costUsd > 0);
  if (shouldRenderProviderChart(activeProviders) || shouldRenderSingleProviderLabel(activeProviders)) {
    const ws = wb.addWorksheet('Platform breakdown');
    ws.columns = [
      { header: 'Platform', key: 'platform', width: 18 },
      { header: 'Cost basis', key: 'costBasis', width: 16 },
      { header: 'Model', key: 'model', width: 22 },
      { header: 'Cost USD', key: 'costUsd', width: 14 },
      { header: 'Calls', key: 'calls', width: 10 },
    ];
    for (const platform of data.platformBreakdown) {
      ws.addRow({
        platform: platform.provider,
        costBasis: costBasisLabel(platform.costBasis),
        model: '',
        costUsd: platform.costUsd,
        calls: platform.calls,
      });
      for (const model of platform.models) {
        ws.addRow({
          platform: '',
          costBasis: '',
          model: model.model,
          costUsd: model.costUsd,
          calls: model.calls,
        });
      }
      if (platform.remainderUsd !== 0) {
        ws.addRow({
          platform: '',
          costBasis: '',
          model: 'rounding/other',
          costUsd: platform.remainderUsd,
          calls: '',
        });
      }
    }
  }

  if (shouldRenderRisk(data.blockedEvents, data.risk)) {
    const ws = wb.addWorksheet('Risk');
    ws.columns = [
      { header: 'DLP action', key: 'dlpAction', width: 16 },
      { header: 'Severity', key: 'riskSeverity', width: 14 },
      { header: 'Events', key: 'events', width: 10 },
    ];
    for (const row of data.risk.filter((r) => r.events > 0)) {
      ws.addRow(row);
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
