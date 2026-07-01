import { Card, DataTable, PageHeader, Stat, num, usd } from '../../components/ui';
import { apiClient, fetchData } from '../../lib/api';

export const dynamic = 'force-dynamic';

const HEADLINE = 0.5; // edges below this are shown but excluded from headline aggregates

type Contribution = {
  signal: string;
  signal_type?: string;
  value?: number;
  weight?: number;
  weighted_log_odds?: number;
  evidence_ref?: string;
};

type Edge = {
  edge_id: string;
  outcome_id: string;
  run_id: string;
  agent_id: string;
  coalition_id: string | null;
  attribution_method: string;
  confidence_raw: number | string;
  confidence_calibrated: number | string;
  signal_contributions: Contribution[];
  counterfactual_delta: number | string | null;
  value_attributed: number | string | null;
  cost_attributed: number | string | null;
  model_version: string;
};

type CoalitionMember = {
  agent_id: string;
  run_id: string;
  shapley_value: number;
  cost_usd: number;
  ci?: number;
};

type Coalition = {
  coalition_id: string;
  outcome_id: string;
  members: CoalitionMember[];
  method: string;
  sample_count: number;
};

// Method badge — deterministic / probabilistic / shapley are visually distinct
// (the §3.7 acceptance). Tailwind classes only; no untrusted data in the class.
function methodBadge(method: string) {
  const styles: Record<string, string> = {
    deterministic: 'bg-pos/15 text-pos border-pos/40',
    probabilistic: 'bg-accent/15 text-accent border-accent/40',
    shapley: 'bg-accent-soft/15 text-accent-soft border-accent-soft/40',
  };
  const cls = styles[method] ?? 'bg-white/10 text-muted border-edge';
  return <span className={`rounded border px-2 py-0.5 text-xs font-medium ${cls}`}>{method}</span>;
}

export default async function AttributionAuditPage({ searchParams }: { searchParams: { outcome?: string } }) {
  const outcome = searchParams.outcome?.trim();
  const api = apiClient();

  if (!outcome) {
    return (
      <>
        <PageHeader title="Attribution audit" subtitle="Trace any attributed score to its source evidence" />
        <Card title="Pick an outcome">
          <p className="text-sm text-muted">
            Append <code className="rounded bg-white/10 px-1">?outcome=&lt;outcome_id&gt;</code> to inspect every edge
            attributing that outcome — its signals, evidence, method, model version, and (for multi-agent chains) the
            Shapley split.
          </p>
        </Card>
      </>
    );
  }

  const edges = (await fetchData(
    api.GET('/v1/attribution/edges', { params: { query: { outcomeId: outcome, minConfidence: 0 } } }),
    [],
  )) as unknown as Edge[];

  const coalitionId = edges.find((e) => e.coalition_id)?.coalition_id ?? null;
  const coalition = coalitionId
    ? ((await fetchData(
        api.GET('/v1/attribution/coalitions/{coalitionId}', { params: { path: { coalitionId } } }),
        null as unknown,
      )) as unknown as Coalition | null)
    : null;

  const totalValue = edges.reduce((s, e) => s + Number(e.value_attributed ?? 0), 0);
  const headlineCount = edges.filter((e) => Number(e.confidence_calibrated) >= HEADLINE).length;

  return (
    <>
      <PageHeader title="Attribution audit" subtitle={outcome} />

      <div className="mb-6 grid grid-cols-3 gap-4">
        <Stat label="Edges" value={num(edges.length)} sub={`${num(headlineCount)} headline-eligible (≥ ${HEADLINE})`} />
        <Stat label="Attributed value" value={usd(totalValue)} sub="incremental (counterfactual-adjusted)" />
        <Stat label="Coalition" value={coalition ? `${num(coalition.members.length)} agents` : '—'} sub={coalition ? coalition.method : 'single-agent'} />
      </div>

      {edges.length === 0 && (
        <Card title="No attribution">
          <p className="text-sm text-muted">No edges attribute this outcome yet.</p>
        </Card>
      )}

      {edges.map((e) => {
        const cal = Number(e.confidence_calibrated);
        const excluded = cal < HEADLINE;
        return (
          <Card
            key={e.edge_id}
            title={`${e.agent_id || 'unattributed'} · run ${e.run_id || '—'}`}
            actions={
              <div className="flex items-center gap-2">
                {methodBadge(e.attribution_method)}
                {excluded && (
                  <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">
                    below {HEADLINE} · excluded from headline
                  </span>
                )}
              </div>
            }
          >
            <div className="mb-3 grid grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-muted">Confidence</div>
                <div className="tabular-nums">{cal.toFixed(3)} <span className="text-muted">(raw {Number(e.confidence_raw).toFixed(3)})</span></div>
              </div>
              <div>
                <div className="text-muted">Incremental value</div>
                <div className="tabular-nums">{usd(e.value_attributed ?? 0)}</div>
              </div>
              <div>
                <div className="text-muted">Counterfactual δ</div>
                <div className="tabular-nums">{e.counterfactual_delta == null ? '—' : Number(e.counterfactual_delta).toFixed(2)}</div>
              </div>
              <div>
                <div className="text-muted">Model</div>
                <div className="font-mono text-xs">{e.model_version}</div>
              </div>
            </div>
            {e.signal_contributions.length > 0 && (
              <DataTable
                columns={[
                  { key: 'signal', label: 'Signal' },
                  { key: 'value', label: 'Value', align: 'right' },
                  { key: 'wlo', label: 'Weighted log-odds', align: 'right' },
                  { key: 'evidence', label: 'Evidence' },
                ]}
                rows={e.signal_contributions.map((c) => ({
                  signal: c.signal,
                  value: c.value == null ? '—' : Number(c.value).toFixed(3),
                  wlo: c.weighted_log_odds == null ? '—' : Number(c.weighted_log_odds).toFixed(3),
                  // evidence_ref is untrusted source data — React escapes it (rules 5/13).
                  evidence: c.evidence_ref ? <span className="font-mono text-xs break-all">{c.evidence_ref}</span> : '—',
                }))}
              />
            )}
          </Card>
        );
      })}

      {coalition && (
        <Card title="Shapley split" actions={methodBadge('shapley')}>
          <p className="mb-3 text-xs text-muted">
            Value allocated across {num(coalition.members.length)} agents by marginal contribution
            {coalition.sample_count > 0 ? ` (Monte Carlo, ${num(coalition.sample_count)} samples)` : ' (exact)'}.
          </p>
          <DataTable
            columns={[
              { key: 'agent', label: 'Agent' },
              { key: 'run', label: 'Run' },
              { key: 'share', label: 'Value share', align: 'right' },
              { key: 'value', label: 'Allocated value', align: 'right' },
              { key: 'cost', label: 'Own cost', align: 'right' },
            ]}
            rows={[...coalition.members]
              .sort((a, b) => b.shapley_value - a.shapley_value)
              .map((m) => ({
                agent: m.agent_id,
                run: m.run_id,
                share: `${(m.shapley_value * 100).toFixed(1)}%`,
                value: usd(totalValue * m.shapley_value),
                cost: usd(m.cost_usd),
              }))}
          />
        </Card>
      )}
    </>
  );
}
