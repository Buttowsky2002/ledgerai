import Link from 'next/link';
import { Card, usd } from '@/components/ui';
import { combinedAiCost } from '@/lib/combined-ai-cost';
import { aggregateByVendor, vendorLabel } from '@/lib/fixed-cost-catalog';
import { proxyApi } from '@/lib/api';

type TotalCostRow = {
  month: string;
  attributable_cost_usd: number | string;
  fixed_cost_usd: number | string;
  total_cost_of_ai_usd: number | string;
  fixed_cost_pct: number | string;
};

type MonthlyFixedRow = {
  period_month: string;
  vendor: string;
  cost_type: string;
  cost_usd: number | string;
  line_item?: string;
};

async function fetchFixedCosts<T>(path: string, fallback: T): Promise<T> {
  const { ok, data } = await proxyApi(path);
  if (!ok || !Array.isArray(data)) return fallback;
  return data as T;
}

export async function FixedOverheadPanel({ from, to }: { from: string; to: string }) {
  const qs = new URLSearchParams({ from, to }).toString();
  const [totals, monthly, spendRes, detailRows] = await Promise.all([
    fetchFixedCosts<TotalCostRow[]>(`/v1/fixed-costs/total-cost-of-ai?${qs}`, []),
    fetchFixedCosts<MonthlyFixedRow[]>(`/v1/fixed-costs/monthly?${qs}`, []),
    proxyApi(`/v1/analytics/spend?${qs}`),
    fetchFixedCosts<{ vendor: string; cost_usd: number; line_item: string; period_month: string }[]>(
      `/v1/fixed-costs?${qs}`,
      [],
    ),
  ]);

  const metered =
    spendRes.ok && Array.isArray(spendRes.data)
      ? (spendRes.data as { cost_usd: number | string }[]).reduce((s, r) => s + Number(r.cost_usd), 0)
      : 0;
  const agg = combinedAiCost(metered, totals);
  const fixedPct = agg.total > 0 ? (agg.fixed / agg.total) * 100 : 0;
  const byVendor = aggregateByVendor(
    detailRows.length > 0
      ? detailRows.map((r) => ({ vendor: r.vendor, cost_usd: r.cost_usd }))
      : monthly.map((r) => ({ vendor: r.vendor, cost_usd: r.cost_usd })),
  );

  return (
    <Card
      title="Fixed / overhead costs"
      subtitle={`${from} → ${to} · seat subscriptions prorated by days in range`}
      actions={
        <Link href="/admin/fixed-overhead" className="text-xs text-accent hover:underline">
          Manage seats & plans
        </Link>
      }
    >
      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Total cost of AI</p>
          <p className="num text-xl font-semibold text-gray-100">{usd(agg.total)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Attributable (metered)</p>
          <p className="num text-xl text-gray-200">{usd(agg.attributable)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Un-attributable overhead</p>
          <p className="num text-xl text-warn">{usd(agg.fixed)}</p>
          <p className="text-xs text-muted">{fixedPct.toFixed(1)}% of total</p>
        </div>
      </div>

      {byVendor.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {byVendor.map((v) => (
            <span
              key={v.vendor}
              className="rounded-md border border-edge bg-black/20 px-3 py-1.5 text-xs text-gray-200"
            >
              {v.label}{' '}
              <span className="num text-muted">{usd(v.total)}</span>
            </span>
          ))}
        </div>
      )}

      {monthly.length > 0 ? (
        <ul className="divide-y divide-edge text-sm">
          {monthly.slice(0, 8).map((r) => (
            <li key={`${r.period_month}-${r.vendor}-${r.cost_type}`} className="flex justify-between py-2">
              <span className="text-gray-300">
                {String(r.period_month).slice(0, 7)} · {vendorLabel(r.vendor)}
                {r.line_item ? ` · ${r.line_item}` : ''}
              </span>
              <span className="num text-gray-100">{usd(Number(r.cost_usd))}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">
          No fixed overhead recorded for this period.{' '}
          <Link href="/admin/fixed-overhead" className="text-accent hover:underline">
            Add vendor seats & plans
          </Link>
        </p>
      )}
    </Card>
  );
}
