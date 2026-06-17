import { LineChartClient } from '../components/charts';
import { Card, PageHeader, Stat, num, usd } from '../components/ui';
import { apiClient, fetchData } from '../lib/api';
import { defaultRange } from '../lib/auth';

export const dynamic = 'force-dynamic';

type SpendRow = {
  day: string;
  cost_usd: number;
  calls: string;
  tokens: string;
  blocked_calls: string;
  error_calls: string;
};

export default async function ExecutiveSpendPage() {
  const { from, to } = defaultRange();
  const api = apiClient();
  const rows = (await fetchData(
    api.GET('/v1/analytics/spend', { params: { query: { from, to } } }),
    [],
  )) as unknown as SpendRow[];

  const totalCost = rows.reduce((s, r) => s + Number(r.cost_usd), 0);
  const totalCalls = rows.reduce((s, r) => s + Number(r.calls), 0);
  const blocked = rows.reduce((s, r) => s + Number(r.blocked_calls), 0);
  const chart = rows.map((r) => ({ day: r.day, cost_usd: Number(r.cost_usd) }));

  return (
    <>
      <PageHeader title="Executive spend" subtitle={`${from} → ${to}`} />
      <div className="mb-6 grid grid-cols-3 gap-4">
        <Stat label="Total spend" value={usd(totalCost)} />
        <Stat label="Calls" value={num(totalCalls)} />
        <Stat label="Blocked calls" value={num(blocked)} />
      </div>
      <Card title="Daily spend (USD)">
        <LineChartClient data={chart} xKey="day" yKey="cost_usd" />
      </Card>
    </>
  );
}
