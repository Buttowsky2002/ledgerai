import { BarChartClient } from '../../components/charts';
import { Card, DataTable, PageHeader, num, usd } from '../../components/ui';
import { apiClient, fetchData } from '../../lib/api';
import { defaultRange } from '../../lib/auth';

export const dynamic = 'force-dynamic';

type ModelRow = { provider: string; model: string; cost_usd: number; calls: string };

export default async function ModelMixPage() {
  const { from, to } = defaultRange();
  const api = apiClient();
  const rows = (await fetchData(
    api.GET('/v1/analytics/model-mix', { params: { query: { from, to } } }),
    [],
  )) as unknown as ModelRow[];

  const chart = rows.map((r) => ({ model: r.model || '(none)', cost_usd: Number(r.cost_usd) }));

  return (
    <>
      <PageHeader title="Model mix" subtitle={`Spend by provider/model · ${from} → ${to}`} />
      <Card title="Spend by model">
        <BarChartClient data={chart} xKey="model" yKey="cost_usd" />
      </Card>
      <Card title="Breakdown">
        <DataTable
          columns={[
            { key: 'provider', label: 'Provider' },
            { key: 'model', label: 'Model' },
            { key: 'cost', label: 'Spend', align: 'right' },
            { key: 'calls', label: 'Calls', align: 'right' },
          ]}
          rows={rows.map((r) => ({
            provider: r.provider,
            model: r.model,
            cost: usd(r.cost_usd),
            calls: num(r.calls),
          }))}
        />
      </Card>
    </>
  );
}
