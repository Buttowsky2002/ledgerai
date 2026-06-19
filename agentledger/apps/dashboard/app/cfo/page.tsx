import Link from 'next/link';
import { BarChartClient } from '../../components/charts';
import { Card, DataTable, PageHeader, Stat, num, usd } from '../../components/ui';
import { apiClient, fetchData } from '../../lib/api';
import { defaultRange } from '../../lib/auth';

export const dynamic = 'force-dynamic';

const LEVELS = [0, 0.3, 0.5, 0.7, 0.9] as const;
const DEFAULT_LEVEL = 0.5;

type RoiRow = {
  month: string;
  outcome_type: string;
  outcomes: number | string;
  value_usd: number | string;
  fully_loaded_cost_usd: number | string;
  nominal_roi_usd: number | string;
  expected_roi_usd: number | string;
  risk_adjusted_roi_usd: number | string;
  avg_confidence: number | string;
  avg_risk_exposure: number | string;
};

const sum = (rows: RoiRow[], key: keyof RoiRow) => rows.reduce((s, r) => s + Number(r[key]), 0);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export default async function CfoPage({ searchParams }: { searchParams: { min?: string } }) {
  const min = LEVELS.includes(Number(searchParams.min) as (typeof LEVELS)[number])
    ? Number(searchParams.min)
    : DEFAULT_LEVEL;
  const { from, to } = defaultRange(365);
  const api = apiClient();

  const rows = (await fetchData(
    api.GET('/v1/analytics/roi', { params: { query: { from, to, minConfidence: min } } }),
    [],
  )) as unknown as RoiRow[];

  const value = sum(rows, 'value_usd');
  const cost = sum(rows, 'fully_loaded_cost_usd');
  const nominalRoi = sum(rows, 'nominal_roi_usd');
  const riskAdjRoi = sum(rows, 'risk_adjusted_roi_usd');
  const roiMargin = value > 0 ? riskAdjRoi / value : 0;

  // Risk-adjusted ROI by month (sorted), and a simple run-rate forecast: the
  // mean monthly risk-adjusted ROI over the months observed.
  const byMonth = new Map<string, number>();
  for (const r of rows) {
    const m = String(r.month).slice(0, 7);
    byMonth.set(m, (byMonth.get(m) ?? 0) + Number(r.risk_adjusted_roi_usd));
  }
  const months = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b));
  const trend = months.map(([month, roi]) => ({ month, roi: Number(roi.toFixed(2)) }));
  const forecastNextMonth = months.length > 0 ? riskAdjRoi / months.length : 0;

  return (
    <>
      <PageHeader
        title="CFO view"
        subtitle={`Risk-adjusted ROI · confidence ≥ ${min} · ${from} → ${to}`}
        actions={
          <div className="flex gap-2">
            {LEVELS.map((lvl) => (
              <Link
                key={lvl}
                href={`/cfo?min=${lvl}`}
                className={`rounded px-3 py-1.5 text-sm tabular-nums ${
                  lvl === min ? 'bg-accent/20 text-white' : 'border border-edge text-muted hover:bg-white/5'
                }`}
              >
                ≥ {lvl}
              </Link>
            ))}
          </div>
        }
      />
      <div className="mb-2 grid grid-cols-4 gap-4">
        <Stat label="Risk-adjusted ROI" value={usd(riskAdjRoi)} sub={`nominal ${usd(nominalRoi)}`} />
        <Stat label="Business value" value={usd(value)} sub={`ROI margin ${pct(roiMargin)}`} />
        <Stat label="Fully-loaded cost" value={usd(cost)} sub="tokens + QA + eval + integration + platform" />
        <Stat label="Forecast / month" value={usd(forecastNextMonth)} sub={`run-rate over ${months.length} mo`} />
      </div>
      <p className="mb-6 text-xs text-muted">
        Risk-adjusted ROI discounts value by attribution confidence and agent risk exposure, net of fully-loaded
        cost. Links below confidence {min} are excluded from these headline figures.
      </p>
      <Card title="Risk-adjusted ROI by month (USD)">
        <BarChartClient data={trend} xKey="month" yKey="roi" />
      </Card>
      <Card title="ROI by month & outcome type">
        <DataTable
          columns={[
            { key: 'month', label: 'Month' },
            { key: 'type', label: 'Outcome type' },
            { key: 'outcomes', label: 'Outcomes', align: 'right' },
            { key: 'value', label: 'Value', align: 'right' },
            { key: 'cost', label: 'Fully-loaded cost', align: 'right' },
            { key: 'nominal', label: 'Nominal ROI', align: 'right' },
            { key: 'expected', label: 'Expected ROI', align: 'right' },
            { key: 'riskAdj', label: 'Risk-adj ROI', align: 'right' },
            { key: 'conf', label: 'Avg conf', align: 'right' },
          ]}
          rows={rows.map((r) => ({
            month: String(r.month).slice(0, 7),
            type: r.outcome_type,
            outcomes: num(r.outcomes),
            value: usd(r.value_usd),
            cost: usd(r.fully_loaded_cost_usd),
            nominal: usd(r.nominal_roi_usd),
            expected: usd(r.expected_roi_usd),
            riskAdj: usd(r.risk_adjusted_roi_usd),
            conf: Number(r.avg_confidence).toFixed(2),
          }))}
        />
      </Card>
    </>
  );
}
