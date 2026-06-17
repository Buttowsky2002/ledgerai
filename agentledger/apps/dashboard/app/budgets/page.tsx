import { LineChartClient } from '../../components/charts';
import { Card, DataTable, PageHeader, usd } from '../../components/ui';
import { apiClient, fetchData } from '../../lib/api';
import { defaultRange } from '../../lib/auth';

export const dynamic = 'force-dynamic';

type BurnRow = { hour: string; hourly_cost_usd: number; cumulative_cost_usd: number };
type Budget = {
  budgetId: string;
  scopeType: string;
  scopeId: string;
  period: string;
  amountUsd: string;
  hardLimit: boolean;
};

export default async function BudgetsPage() {
  const { from, to } = defaultRange();
  const api = apiClient();
  const [burn, budgets] = await Promise.all([
    fetchData(api.GET('/v1/analytics/burndown', { params: { query: { from, to } } }), []) as Promise<unknown> as Promise<BurnRow[]>,
    fetchData(api.GET('/v1/budgets', { params: { query: { limit: '100', offset: '0' } } }), []) as Promise<unknown> as Promise<Budget[]>,
  ]);
  const chart = burn.map((r) => ({ hour: r.hour, cumulative: Number(r.cumulative_cost_usd) }));

  return (
    <>
      <PageHeader title="Budgets" subtitle={`Burn-down · ${from} → ${to}`} />
      <Card title="Cumulative spend (USD)">
        <LineChartClient data={chart} xKey="hour" yKey="cumulative" />
      </Card>
      <Card title="Configured budgets">
        <DataTable
          columns={[
            { key: 'scope', label: 'Scope' },
            { key: 'period', label: 'Period' },
            { key: 'amount', label: 'Amount', align: 'right' },
            { key: 'hard', label: 'Hard limit' },
          ]}
          rows={budgets.map((b) => ({
            scope: `${b.scopeType}:${b.scopeId}`,
            period: b.period,
            amount: usd(b.amountUsd),
            hard: b.hardLimit ? 'yes' : 'no',
          }))}
        />
      </Card>
      <p className="text-xs text-muted">Manage budgets under Settings → Budgets.</p>
    </>
  );
}
