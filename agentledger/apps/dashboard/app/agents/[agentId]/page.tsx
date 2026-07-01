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

type AgentRoi = {
  summary: {
    cost_usd?: number;
    value_usd?: number;
    net_value_usd?: number;
    outcomes_count?: number;
    cost_per_success?: number | null;
    attribution_confidence_avg?: number;
    risk_adjusted_roi?: number;
  };
};

type OutcomeRow = {
  outcome_id: string;
  outcome_type: string;
  run_id?: string;
  value_usd?: number;
  cost_usd?: number;
  confidence?: number;
  occurred_at?: string;
};

const pct = (n: number | undefined): string => (typeof n === 'number' ? `${(n * 100).toFixed(0)}%` : '—');

export default async function AgentDetailPage({ params }: { params: { agentId: string } }) {
  const { from, to } = defaultRange();
  const api = apiClient();

  const [detail, roi, outcomes] = await Promise.all([
    fetchData(
      api.GET('/v1/analytics/agents/{agentId}', {
        params: { path: { agentId: params.agentId }, query: { from, to } },
      }),
      { agentId: params.agentId, spend: {}, runs: {}, statusMix: [] },
    ) as Promise<unknown> as Promise<AgentDetail>,
    fetchData(
      api.GET('/v1/agents/{id}/roi', {
        params: { path: { id: params.agentId }, query: { from, to } },
      }),
      { summary: {} },
    ) as Promise<unknown> as Promise<AgentRoi>,
    fetchData(
      api.GET('/v1/outcomes', {
        params: { query: { agentId: params.agentId, from, to, limit: '50' } },
      }),
      [],
    ) as Promise<unknown> as Promise<OutcomeRow[]>,
  ]);

  const sum = roi.summary ?? {};

  return (
    <>
      <PageHeader title="Agent detail" subtitle={params.agentId} />

      <div className="mb-6 grid grid-cols-4 gap-4">
        <Stat label="Spend" value={usd(detail.spend.cost_usd)} />
        <Stat label="LLM calls" value={num(detail.spend.calls)} />
        <Stat label="Runs" value={num(detail.runs.runs)} />
        <Stat label="Avg cost / run" value={usd(detail.runs.cost_avg_usd)} />
      </div>

      {/* Finance-grade ROI (cost → outcome economics) from v_roi / v_agent_daily_unit_economics. */}
      <div className="mb-6 grid grid-cols-4 gap-4">
        <Stat label="Outcomes" value={num(sum.outcomes_count)} />
        <Stat label="Value" value={usd(sum.value_usd)} sub={`net ${usd(sum.net_value_usd)}`} />
        <Stat label="Cost / success" value={usd(sum.cost_per_success ?? undefined)} sub={`avg conf ${pct(sum.attribution_confidence_avg)}`} />
        <Stat label="Risk-adjusted ROI" value={usd(sum.risk_adjusted_roi)} />
      </div>

      <Card title="Cost → outcome (evidence chain)">
        <DataTable
          columns={[
            { key: 'outcome_type', label: 'Outcome' },
            { key: 'run_id', label: 'Run' },
            { key: 'cost_usd', label: 'AI cost', align: 'right' },
            { key: 'value_usd', label: 'Value', align: 'right' },
            { key: 'confidence', label: 'Confidence', align: 'right' },
            { key: 'evidence', label: 'Evidence' },
          ]}
          rows={(outcomes ?? []).map((o) => ({
            outcome_type: o.outcome_type,
            run_id: o.run_id || '—',
            cost_usd: usd(o.cost_usd),
            value_usd: usd(o.value_usd),
            confidence: pct(o.confidence),
            evidence: (
              <a className="text-accent hover:text-accent-soft hover:underline" href={`/attribution?outcome=${encodeURIComponent(o.outcome_id)}`}>
                view signals →
              </a>
            ),
          }))}
        />
      </Card>

      <div className="mt-6">
        <Card title="Run status mix">
          <DataTable
            columns={[
              { key: 'status', label: 'Status' },
              { key: 'runs', label: 'Runs', align: 'right' },
            ]}
            rows={(detail.statusMix ?? []).map((row) => ({ status: row.status, runs: num(row.runs) }))}
          />
        </Card>
      </div>
    </>
  );
}
