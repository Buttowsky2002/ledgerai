'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge, Card, DataTable, usd } from '@/components/ui';
import { fetchProductWorth } from '@/lib/api/lari';
import type { BudgetSuggestionEntry, ProductWorthResponse } from '@/types/lari';

const SCOPE_LABEL: Record<BudgetSuggestionEntry['scope'], string> = {
  tenant: 'Portfolio',
  product: 'Product',
  agent: 'Agent',
};

export function SuggestedBudgetsPanel({ from, to }: { from: string; to: string }) {
  const [data, setData] = useState<ProductWorthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetchProductWorth({ startDate: from, endDate: to })
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

  const suggestions = data?.budgetSuggestions ?? [];
  const totalSavings = suggestions
    .filter((s) => s.deltaUsd > 0)
    .reduce((sum, s) => sum + s.deltaUsd, 0);

  return (
    <Card
      title="Suggested budgets"
      subtitle={`Advisory caps from ROI engine · ${from} → ${to}`}
      actions={
        totalSavings > 0 ? (
          <Badge tone="pos">{usd(totalSavings)}/mo potential reduction</Badge>
        ) : undefined
      }
    >
      {error && (
        <p className="mb-4 rounded-lg border border-neg/30 bg-neg/10 px-4 py-3 text-sm text-neg">
          Could not load budget suggestions.
        </p>
      )}
      {loading ? (
        <div className="animate-pulse space-y-3 py-4">
          <div className="h-12 rounded-lg bg-edge" />
          <div className="h-12 rounded-lg bg-edge" />
        </div>
      ) : suggestions.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">
          No budget adjustments recommended — current run-rates align with ROI targets.
        </p>
      ) : (
        <DataTable
          columns={[
            { key: 'scope', label: 'Scope' },
            { key: 'label', label: 'Target' },
            { key: 'current', label: 'Run-rate/mo', align: 'right' },
            { key: 'recommended', label: 'Suggested/mo', align: 'right' },
            { key: 'delta', label: 'Change', align: 'right' },
            { key: 'rationale', label: 'Rationale' },
          ]}
          rows={suggestions.map((s) => ({
            scope: SCOPE_LABEL[s.scope],
            label:
              s.scope === 'agent' ? (
                <Link
                  href={`/agents/${encodeURIComponent(s.scopeId)}`}
                  className="text-accent hover:underline"
                >
                  {s.label}
                </Link>
              ) : (
                s.label
              ),
            current: usd(s.currentRunRateUsd),
            recommended: usd(s.recommendedBudgetUsd),
            delta: (
              <span className={s.deltaUsd > 0 ? 'text-pos' : s.deltaUsd < 0 ? 'text-warn' : ''}>
                {s.deltaUsd > 0 ? '−' : s.deltaUsd < 0 ? '+' : ''}
                {usd(Math.abs(s.deltaUsd))}
              </span>
            ),
            rationale: <span className="text-xs text-muted">{s.rationale}</span>,
          }))}
        />
      )}
      <p className="mt-4 text-xs text-muted">
        Suggestions are advisory estimates — configure hard limits under Settings → Budgets.
      </p>
    </Card>
  );
}
