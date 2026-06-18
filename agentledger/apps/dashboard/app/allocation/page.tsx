import Link from 'next/link';
import { BarChartClient } from '../../components/charts';
import { Card, DataTable, PageHeader, num, usd } from '../../components/ui';
import { apiClient, fetchData } from '../../lib/api';
import { defaultRange } from '../../lib/auth';

export const dynamic = 'force-dynamic';

type AllocRow = { key: string; cost_usd: number; calls: string };
const DIMENSIONS = ['team', 'app', 'agent'] as const;
type Dimension = (typeof DIMENSIONS)[number];

export default async function AllocationPage({ searchParams }: { searchParams: { dimension?: string } }) {
  const dimension: Dimension = DIMENSIONS.includes(searchParams.dimension as Dimension)
    ? (searchParams.dimension as Dimension)
    : 'team';
  const { from, to } = defaultRange();
  const api = apiClient();
  const rows = (await fetchData(
    api.GET('/v1/analytics/allocation', { params: { query: { from, to, dimension } } }),
    [],
  )) as unknown as AllocRow[];

  const chart = rows.map((r) => ({ key: r.key || '(none)', cost_usd: Number(r.cost_usd) }));

  return (
    <>
      <PageHeader
        title="Allocation"
        subtitle={`Spend by ${dimension} · ${from} → ${to}`}
        actions={
          <div className="flex gap-2">
            {DIMENSIONS.map((d) => (
              <Link
                key={d}
                href={`/allocation?dimension=${d}`}
                className={`rounded px-3 py-1.5 text-sm capitalize ${
                  d === dimension ? 'bg-accent/20 text-white' : 'border border-edge text-muted hover:bg-white/5'
                }`}
              >
                {d}
              </Link>
            ))}
          </div>
        }
      />
      <Card title={`Spend by ${dimension}`}>
        <BarChartClient data={chart} xKey="key" yKey="cost_usd" />
      </Card>
      <Card title="Breakdown">
        <DataTable
          columns={[
            { key: 'key', label: dimension },
            { key: 'cost', label: 'Spend', align: 'right' },
            { key: 'calls', label: 'Calls', align: 'right' },
          ]}
          rows={rows.map((r) => ({ key: r.key || '(none)', cost: usd(r.cost_usd), calls: num(r.calls) }))}
        />
      </Card>
    </>
  );
}
