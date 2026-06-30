import { BarChartClient, PieChartClient } from '../../components/charts';
import { DateRangeFilter } from '../../components/DateRangeFilter';
import { Card, DataTable, PageHeader, num, usd } from '../../components/ui';
import { apiClient, fetchData } from '../../lib/api';
import { parseRange } from '../../lib/date-range';

export const dynamic = 'force-dynamic';

type ModelRow = { provider: string; model: string; cost_usd: number; calls: string };
type PlatformRow = { platform: string; cost_usd: number | string; calls: string };

export default async function ModelMixPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string };
}) {
  const { from, to } = parseRange(searchParams);
  const api = apiClient();
  const [rows, platformRows] = await Promise.all([
    fetchData(
      api.GET('/v1/analytics/model-mix', { params: { query: { from, to } } }),
      [],
    ) as Promise<unknown> as Promise<ModelRow[]>,
    fetchData(
      api.GET('/v1/analytics/platform-spend', { params: { query: { from, to } } }),
      [],
    ) as Promise<unknown> as Promise<PlatformRow[]>,
  ]);

  const chart = rows.map((r) => ({ model: r.model || '(none)', cost_usd: Number(r.cost_usd) }));
  const platformChart = platformRows.map((r) => ({
    platform: r.platform || '(unknown)',
    cost_usd: Number(r.cost_usd),
  }));

  return (
    <>
      <PageHeader
        title="Model mix"
        subtitle={`Spend by provider/model · ${from} → ${to}`}
        actions={<DateRangeFilter basePath="/model-mix" from={from} to={to} />}
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Spend by platform">
          {platformChart.length > 0 ? (
            <PieChartClient data={platformChart} nameKey="platform" valueKey="cost_usd" />
          ) : (
            <p className="py-8 text-center text-sm text-muted">No platform spend in this range.</p>
          )}
        </Card>
        <Card title="Spend by model">
          <BarChartClient data={chart} xKey="model" yKey="cost_usd" />
        </Card>
      </div>
      <Card title="Platform spend breakdown">
        <DataTable
          columns={[
            { key: 'platform', label: 'Platform' },
            { key: 'cost', label: 'Spend', align: 'right' },
            { key: 'calls', label: 'Calls', align: 'right' },
          ]}
          rows={platformRows.map((r) => ({
            platform: r.platform,
            cost: usd(Number(r.cost_usd)),
            calls: num(r.calls),
          }))}
        />
      </Card>
      <Card title="Model breakdown">
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
