import { Card, DataTable, PageHeader, Stat, num, usd } from '../../../components/ui';
import { apiClient, fetchData } from '../../../lib/api';
import { defaultRange } from '../../../lib/auth';

export const dynamic = 'force-dynamic';

type AgentDetail = {
  agentId: string;
  spend: { cost_usd?: number; calls?: string; tokens?: string };
  runs: { runs?: string; cost_total_usd?: number; cost_avg_usd?: number };
  statusMix: { status: string; runs: string }[];
};

export default async function AgentDetailPage({ params }: { params: { agentId: string } }) {
  const { from, to } = defaultRange();
  const api = apiClient();
  const detail = (await fetchData(
    api.GET('/v1/analytics/agents/{agentId}', {
      params: { path: { agentId: params.agentId }, query: { from, to } },
    }),
    { agentId: params.agentId, spend: {}, runs: {}, statusMix: [] },
  )) as unknown as AgentDetail;

  return (
    <>
      <PageHeader title="Agent detail" subtitle={params.agentId} />
      <div className="mb-6 grid grid-cols-4 gap-4">
        <Stat label="Spend" value={usd(detail.spend.cost_usd)} />
        <Stat label="LLM calls" value={num(detail.spend.calls)} />
        <Stat label="Runs" value={num(detail.runs.runs)} />
        <Stat label="Avg cost / run" value={usd(detail.runs.cost_avg_usd)} />
      </div>
      <Card title="Run status mix">
        <DataTable
          columns={[
            { key: 'status', label: 'Status' },
            { key: 'runs', label: 'Runs', align: 'right' },
          ]}
          rows={(detail.statusMix ?? []).map((s) => ({ status: s.status, runs: num(s.runs) }))}
        />
      </Card>
    </>
  );
}
