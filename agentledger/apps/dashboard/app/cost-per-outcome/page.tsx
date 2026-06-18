import Link from 'next/link';
import { BarChartClient } from '../../components/charts';
import { Card, DataTable, PageHeader, Stat, num, usd } from '../../components/ui';
import { apiClient, fetchData } from '../../lib/api';
import { defaultRange } from '../../lib/auth';

export const dynamic = 'force-dynamic';

const LEVELS = [0, 0.3, 0.5, 0.7, 0.9] as const;
const DEFAULT_LEVEL = 0.5;

type UnitEconRow = {
  month: string;
  outcome_type: string;
  team_id: string;
  outcomes: number | string;
  ai_cost_usd: number | string;
  business_value_usd: number | string;
  cost_per_outcome: number | string;
  net_value_usd: number | string;
  avg_confidence: number | string;
};

const sum = (rows: UnitEconRow[], key: keyof UnitEconRow) =>
  rows.reduce((s, r) => s + Number(r[key]), 0);

export default async function CostPerOutcomePage({ searchParams }: { searchParams: { min?: string } }) {
  const min = LEVELS.includes(Number(searchParams.min) as (typeof LEVELS)[number])
    ? Number(searchParams.min)
    : DEFAULT_LEVEL;
  const { from, to } = defaultRange(365);
  const api = apiClient();

  // Filtered headline set + the unfiltered baseline (minConfidence 0) so we can
  // show how many outcomes the threshold excludes.
  const [rows, baseline] = await Promise.all([
    fetchData(
      api.GET('/v1/analytics/unit-economics', { params: { query: { from, to, minConfidence: min } } }),
      [],
    ) as Promise<unknown> as Promise<UnitEconRow[]>,
    fetchData(
      api.GET('/v1/analytics/unit-economics', { params: { query: { from, to, minConfidence: 0 } } }),
      [],
    ) as Promise<unknown> as Promise<UnitEconRow[]>,
  ]);

  const totalOutcomes = sum(rows, 'outcomes');
  const aiCost = sum(rows, 'ai_cost_usd');
  const businessValue = sum(rows, 'business_value_usd');
  const costPerOutcome = totalOutcomes > 0 ? aiCost / totalOutcomes : 0;
  const netValue = businessValue - aiCost;
  const baselineOutcomes = sum(baseline, 'outcomes');
  const excluded = Math.max(baselineOutcomes - totalOutcomes, 0);

  // Cost per outcome by outcome_type (aggregate across months) for the chart.
  const byType = new Map<string, { cost: number; outcomes: number }>();
  for (const r of rows) {
    const cur = byType.get(r.outcome_type) ?? { cost: 0, outcomes: 0 };
    cur.cost += Number(r.ai_cost_usd);
    cur.outcomes += Number(r.outcomes);
    byType.set(r.outcome_type, cur);
  }
  const chart = [...byType.entries()].map(([outcome_type, v]) => ({
    outcome_type,
    cost_per_outcome: v.outcomes > 0 ? Number((v.cost / v.outcomes).toFixed(2)) : 0,
  }));

  return (
    <>
      <PageHeader
        title="Cost per outcome"
        subtitle={`Confidence ≥ ${min} · ${from} → ${to}`}
        actions={
          <div className="flex gap-2">
            {LEVELS.map((lvl) => (
              <Link
                key={lvl}
                href={`/cost-per-outcome?min=${lvl}`}
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
        <Stat label="Cost per outcome" value={usd(costPerOutcome)} sub={`confidence ≥ ${min}`} />
        <Stat label="Outcomes included" value={num(totalOutcomes)} sub={`${num(excluded)} excluded below ${min}`} />
        <Stat label="AI cost" value={usd(aiCost)} />
        <Stat label="Net value" value={usd(netValue)} />
      </div>
      <p className="mb-6 text-xs text-muted">
        Including {num(totalOutcomes)} of {num(baselineOutcomes)} attributed outcomes — {num(excluded)} below the
        confidence threshold are excluded from the headline numbers.
      </p>
      <Card title="Cost per outcome by type (USD)">
        <BarChartClient data={chart} xKey="outcome_type" yKey="cost_per_outcome" />
      </Card>
      <Card title="Unit economics">
        <DataTable
          columns={[
            { key: 'month', label: 'Month' },
            { key: 'type', label: 'Outcome type' },
            { key: 'team', label: 'Team' },
            { key: 'outcomes', label: 'Outcomes', align: 'right' },
            { key: 'cpo', label: 'Cost / outcome', align: 'right' },
            { key: 'aiCost', label: 'AI cost', align: 'right' },
            { key: 'value', label: 'Business value', align: 'right' },
            { key: 'conf', label: 'Avg confidence', align: 'right' },
          ]}
          rows={rows.map((r) => ({
            month: String(r.month).slice(0, 7),
            type: r.outcome_type,
            team: r.team_id || '—',
            outcomes: num(r.outcomes),
            cpo: usd(r.cost_per_outcome),
            aiCost: usd(r.ai_cost_usd),
            value: usd(r.business_value_usd),
            conf: Number(r.avg_confidence).toFixed(2),
          }))}
        />
      </Card>
    </>
  );
}
