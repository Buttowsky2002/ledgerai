'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge, BadgeTone, Card, DataTable, usd } from '@/components/ui';
import { fetchLariRecommendations } from '@/lib/api/lari';
import type {
  LariActionableRecommendation,
  LariRecommendationsResponse,
  RecommendationPriority,
} from '@/types/lari';

const PRIORITY_META: Record<
  RecommendationPriority,
  { label: string; tone: BadgeTone }
> = {
  critical: { label: 'Critical', tone: 'neg' },
  high: { label: 'High', tone: 'warn' },
  medium: { label: 'Medium', tone: 'info' },
  low: { label: 'Low', tone: 'neutral' },
};

const CATEGORY_LABEL: Record<string, string> = {
  seat_optimization: 'Seats',
  plan_optimization: 'Plans',
  provider_value: 'Provider value',
  agent_economics: 'Agent economics',
  attribution: 'Attribution',
  configuration: 'Configuration',
  model_substitution: 'Model right-sizing',
  user_value: 'Platform usage',
};

function RecommendationRow({ rec }: { rec: LariActionableRecommendation }) {
  const meta = PRIORITY_META[rec.priority];
  return (
    <div className="rounded-lg border border-edge bg-panel/50 p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge tone={meta.tone}>{meta.label}</Badge>
        <Badge tone="neutral">{CATEGORY_LABEL[rec.category] ?? rec.category}</Badge>
        <span className="ml-auto text-xs text-muted">ML score {rec.mlScore}</span>
      </div>
      <h4 className="text-sm font-medium text-gray-100">{rec.title}</h4>
      <p className="mt-1 text-sm text-muted">{rec.message}</p>
      <p className="mt-2 text-sm text-accent">{rec.action}</p>
      {(rec.estimatedSavingsUsd !== undefined || rec.estimatedImpactUsd !== undefined) && (
        <p className="mt-2 text-xs text-muted">
          {rec.estimatedSavingsUsd !== undefined && (
            <span>Est. savings {usd(rec.estimatedSavingsUsd)}/mo · </span>
          )}
          {rec.estimatedImpactUsd !== undefined && (
            <span>Impact {usd(rec.estimatedImpactUsd)}</span>
          )}
        </p>
      )}
      {rec.relatedEntity?.type === 'agent' && (
        <Link
          href={`/agents/${encodeURIComponent(rec.relatedEntity.id)}`}
          className="mt-2 inline-block text-xs text-accent hover:underline"
        >
          View agent →
        </Link>
      )}
    </div>
  );
}

export function LariRecommendationsPanel({
  from,
  to,
  compact = false,
}: {
  from: string;
  to: string;
  compact?: boolean;
}) {
  const [data, setData] = useState<LariRecommendationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetchLariRecommendations({ startDate: from, endDate: to })
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setError(!res);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  const recs = data?.recommendations ?? [];
  const shown = compact ? recs.slice(0, 5) : recs;

  return (
    <Card
      title="LARI recommendations"
      subtitle={`Savings & configuration · ${from} → ${to}`}
      actions={
        data ? (
          <div className="flex gap-2 text-xs">
            <Badge tone={data.summary.criticalCount > 0 ? 'neg' : 'neutral'}>
              {data.summary.criticalCount} critical
            </Badge>
            <Badge tone={data.summary.highPriorityCount > 0 ? 'warn' : 'pos'}>
              {usd(data.summary.totalEstimatedSavingsUsd)}/mo potential
            </Badge>
          </div>
        ) : undefined
      }
    >
      {error && (
        <p className="mb-4 rounded-lg border border-neg/30 bg-neg/10 px-4 py-3 text-sm text-neg">
          Could not load recommendations.
        </p>
      )}
      {loading ? (
        <div className="animate-pulse space-y-3 py-4">
          <div className="h-16 rounded-lg bg-edge" />
          <div className="h-16 rounded-lg bg-edge" />
        </div>
      ) : shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">
          No savings or configuration actions flagged — portfolio looks efficient.
        </p>
      ) : (
        <div className="space-y-3">{shown.map((rec) => <RecommendationRow key={rec.id} rec={rec} />)}</div>
      )}

      {!loading && !compact && data && data.providerRankings.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-3 text-sm font-medium text-gray-200">Provider value ranking</h3>
          <DataTable
            columns={[
              { key: 'rank', label: '#', align: 'right' },
              { key: 'provider', label: 'Provider' },
              { key: 'cost', label: 'Spend', align: 'right' },
              { key: 'value', label: 'Attributed value', align: 'right' },
              { key: 'vpd', label: 'Value/$', align: 'right' },
              { key: 'score', label: 'Efficiency', align: 'right' },
            ]}
            rows={data.providerRankings.map((r) => ({
              rank: String(r.rank),
              provider: r.provider,
              cost: usd(r.costUsd),
              value: usd(r.attributedValueUsd),
              vpd: r.valuePerDollar.toFixed(2),
              score: `${r.efficiencyScore}`,
            }))}
          />
        </div>
      )}

      {!loading && !compact && data && data.agentEconomicsHighlights.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-3 text-sm font-medium text-gray-200">Agent economics highlights</h3>
          <DataTable
            columns={[
              { key: 'agent', label: 'Agent' },
              { key: 'value', label: 'Value', align: 'right' },
              { key: 'cost', label: 'Cost', align: 'right' },
              { key: 'lari', label: 'LARI', align: 'right' },
              { key: 'rec', label: 'Action' },
              { key: 'provider', label: 'Top provider' },
            ]}
            rows={data.agentEconomicsHighlights.slice(0, 10).map((a) => ({
              agent: (
                <Link href={`/agents/${encodeURIComponent(a.agentId)}`} className="text-accent hover:underline">
                  {a.agentId}
                </Link>
              ),
              value: usd(a.valueUsd),
              cost: usd(a.costUsd),
              lari: `${a.lari.toFixed(2)}×`,
              rec: a.recommendation.replace(/_/g, ' '),
              provider: a.topProvider ?? '—',
            }))}
          />
        </div>
      )}
    </Card>
  );
}
