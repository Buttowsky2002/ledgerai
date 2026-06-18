import { Card, DataTable, PageHeader, Stat, num } from '../../components/ui';
import { apiClient, fetchData } from '../../lib/api';
import { defaultRange } from '../../lib/auth';

export const dynamic = 'force-dynamic';

type RiskRow = { day: string; dlp_action: string; risk_severity: string; events: string };

export default async function RiskPage() {
  const { from, to } = defaultRange();
  const api = apiClient();
  const rows = (await fetchData(
    api.GET('/v1/analytics/risk', { params: { query: { from, to } } }),
    [],
  )) as unknown as RiskRow[];

  const total = rows.reduce((s, r) => s + Number(r.events), 0);
  const blocked = rows.filter((r) => r.dlp_action === 'block').reduce((s, r) => s + Number(r.events), 0);

  return (
    <>
      <PageHeader title="Risk events" subtitle={`DLP actions & severity · ${from} → ${to}`} />
      <div className="mb-6 grid grid-cols-2 gap-4">
        <Stat label="Total risk events" value={num(total)} />
        <Stat label="Blocked" value={num(blocked)} />
      </div>
      <Card title="Events by day / action / severity">
        <DataTable
          columns={[
            { key: 'day', label: 'Day' },
            { key: 'action', label: 'DLP action' },
            { key: 'severity', label: 'Severity' },
            { key: 'events', label: 'Events', align: 'right' },
          ]}
          rows={rows.map((r) => ({
            day: r.day,
            action: r.dlp_action,
            severity: r.risk_severity,
            events: num(r.events),
          }))}
        />
      </Card>
    </>
  );
}
