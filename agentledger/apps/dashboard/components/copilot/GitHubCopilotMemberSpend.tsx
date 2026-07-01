'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AreaChartClient,
  BarChartClient,
  LineChartClient,
} from '@/components/charts';
import { Badge, Card, Stat, usd } from '@/components/ui';
import { fetchCopilotMemberSpend } from '@/lib/api/github-copilot';
import { copilotNetValueUsd, formatCopilotRoiMultiple } from '@/lib/copilot-metrics';
import type { CopilotMemberSpendResponse, CopilotMemberSpendRow } from '@/types/github-copilot';

const STATUS_TONE: Record<string, 'info' | 'warn' | 'neg' | 'pos'> = {
  inactive: 'neg',
  low_usage: 'warn',
  active: 'info',
  high_usage: 'pos',
  high_roi: 'pos',
  negative_roi: 'neg',
};

const SPEND_TOOLTIP =
  'GitHub Copilot Business does not provide a per-user invoice. BadgerIQ estimates member spend using seat allocation, usage metrics, AI credit usage, and proportional overage allocation.';

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="block text-xs">
      <span className="text-muted">{label}</span>
      <select
        className="mt-1 w-full rounded border border-edge bg-panel px-2 py-1.5 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function MemberTable({ rows }: { rows: CopilotMemberSpendRow[] }) {
  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-muted">No member spend data for selected filters.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1200px] text-left text-sm">
        <thead>
          <tr className="border-b border-edge text-xs text-muted">
            <th className="py-2 pr-3">Member</th>
            <th className="py-2 pr-3">Seat</th>
            <th className="py-2 pr-3">Last activity</th>
            <th className="py-2 pr-3 text-right">Seat cost (est.)</th>
            <th className="py-2 pr-3 text-right">AI credits</th>
            <th className="py-2 pr-3 text-right">Credit cost (est.)</th>
            <th className="py-2 pr-3 text-right">Overage (alloc.)</th>
            <th className="py-2 pr-3 text-right">Total (alloc.)</th>
            <th className="py-2 pr-3 text-right">Lines</th>
            <th className="py-2 pr-3 text-right">Chat</th>
            <th className="py-2 pr-3 text-right">PR sum.</th>
            <th className="py-2 pr-3 text-right">Hrs saved (est.)</th>
            <th className="py-2 pr-3 text-right">Value (est.)</th>
            <th className="py-2 pr-3 text-right">Net value (est.)</th>
            <th className="py-2 pr-3 text-right" title="Estimated value ÷ allocated cost; capped at 10×">
              Multiple (est.)
            </th>
            <th className="py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => {
            const net = copilotNetValueUsd(m.estimatedValueCreated, m.totalAllocatedCost);
            return (
            <tr key={m.githubLogin} className="border-b border-edge/40 hover:bg-white/[0.02]">
              <td className="py-2 pr-3 font-medium text-gray-100">{m.displayName ?? m.githubLogin}</td>
              <td className="py-2 pr-3 capitalize text-muted">{m.seatStatus.replace('_', ' ')}</td>
              <td className="py-2 pr-3 text-muted">
                {m.lastActivityAt ? m.lastActivityAt.slice(0, 10) : '—'}
              </td>
              <td className="py-2 pr-3 text-right">{usd(m.seatCost)}</td>
              <td className="py-2 pr-3 text-right">{Math.round(m.aiCreditsUsed)}</td>
              <td className="py-2 pr-3 text-right">{usd(m.estimatedCreditCost)}</td>
              <td className="py-2 pr-3 text-right">{usd(m.allocatedOverageCost)}</td>
              <td className="py-2 pr-3 text-right font-medium">{usd(m.totalAllocatedCost)}</td>
              <td className="py-2 pr-3 text-right">{m.linesAccepted}</td>
              <td className="py-2 pr-3 text-right">{m.chatTurns}</td>
              <td className="py-2 pr-3 text-right">{m.prSummaryCount}</td>
              <td className="py-2 pr-3 text-right">{m.estimatedHoursSaved.toFixed(1)}</td>
              <td className="py-2 pr-3 text-right">{usd(m.estimatedValueCreated)}</td>
              <td className={`py-2 pr-3 text-right font-medium ${net < 0 ? 'text-neg' : 'text-pos'}`}>
                {usd(net)}
              </td>
              <td
                className={`py-2 pr-3 text-right ${net < 0 ? 'text-neg' : 'text-muted'}`}
                title="Value ÷ allocated cost (capped at 10×)"
              >
                {formatCopilotRoiMultiple(m.estimatedValueCreated, m.totalAllocatedCost)}
              </td>
              <td className="py-2">
                <Badge tone={STATUS_TONE[m.utilizationStatus] ?? 'info'}>{m.utilizationStatus}</Badge>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function GitHubCopilotMemberSpend({ from, to }: { from: string; to: string }) {
  const [data, setData] = useState<CopilotMemberSpendResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [user, setUser] = useState('');
  const [utilizationStatus, setUtilizationStatus] = useState('');
  const [model, setModel] = useState('');
  const [editor, setEditor] = useState('');
  const [language, setLanguage] = useState('');
  const [month, setMonth] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetchCopilotMemberSpend({
        from,
        to,
        month: month || undefined,
        user: user || undefined,
        utilizationStatus: utilizationStatus || undefined,
        model: model || undefined,
        editor: editor || undefined,
        language: language || undefined,
      });
      setData(res);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [from, to, month, user, utilizationStatus, model, editor, language]);

  useEffect(() => {
    load();
  }, [load]);

  const conn = data?.connections?.[0];
  const s = data?.summary;
  const c = data?.charts;

  const monthOptions = useMemo(() => {
    const opts: string[] = [];
    const d = new Date(`${to}T00:00:00.000Z`);
    for (let i = 0; i < 6; i++) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      opts.push(`${y}-${m}`);
      d.setUTCMonth(d.getUTCMonth() - 1);
    }
    return opts;
  }, [to]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-gray-100">Member Spend</h3>
          <p className="mt-1 max-w-2xl text-sm text-muted" title={SPEND_TOOLTIP}>
            Per-member allocated Copilot spend and estimated ROI — not exact invoice amounts.
          </p>
        </div>
        {conn && (
          <div className="text-right text-xs text-muted">
            {conn.lastSuccessAt && (
              <p>Last sync: {new Date(conn.lastSuccessAt).toLocaleString()}</p>
            )}
            {conn.lastErrorMessage && (
              <p className="text-neg">{conn.lastErrorMessage}</p>
            )}
            <p>{data?.recordsImported ?? 0} records imported</p>
          </div>
        )}
      </div>

      {data?.disclaimer && (
        <p className="rounded-lg border border-edge/80 bg-panel/60 px-4 py-2.5 text-xs text-muted" title={SPEND_TOOLTIP}>
          {data.disclaimer}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        <FilterSelect label="Month" value={month} options={monthOptions} onChange={setMonth} />
        <FilterSelect label="User" value={user} options={data?.filters.users ?? []} onChange={setUser} />
        <FilterSelect
          label="Utilization"
          value={utilizationStatus}
          options={data?.filters.utilizationStatuses ?? []}
          onChange={setUtilizationStatus}
        />
        <FilterSelect label="Model" value={model} options={data?.filters.models ?? []} onChange={setModel} />
        <FilterSelect label="Editor" value={editor} options={data?.filters.editors ?? []} onChange={setEditor} />
        <FilterSelect
          label="Language"
          value={language}
          options={data?.filters.languages ?? []}
          onChange={setLanguage}
        />
      </div>

      {loading && (
        <div className="animate-pulse space-y-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-20 rounded-xl border border-edge bg-panel" />
            ))}
          </div>
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-neg/30 bg-neg/10 px-4 py-3 text-sm text-neg">
          Could not load member spend data.
        </p>
      )}

      {!loading && !error && data?.connected && !s && (
        <p className="py-6 text-center text-sm text-muted">
          No member spend data yet. Run a sync to import seats and usage.
        </p>
      )}

      {s && c && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-5">
            <Stat label="Total Copilot spend (est.)" value={usd(s.totalCopilotSpend)} accent sub="allocated" />
            <Stat label="Allocated member spend" value={usd(s.allocatedMemberSpend)} sub="estimated" />
            <Stat label="Active paid seats" value={String(s.activePaidSeats)} tone="pos" />
            <Stat label="Inactive paid seats" value={String(s.inactivePaidSeats)} tone={s.inactivePaidSeats > 0 ? 'warn' : 'default'} />
            <Stat label="Est. wasted spend" value={usd(s.estimatedWastedSpend)} tone="warn" sub="inactive seats" />
            <Stat label="Avg cost / active member" value={usd(s.avgCostPerActiveMember)} />
            <Stat label="Avg cost / engaged member" value={usd(s.avgCostPerEngagedMember)} />
            <Stat
              label="Highest spend member"
              value={s.highestSpendMember ? s.highestSpendMember.login : '—'}
              sub={s.highestSpendMember ? usd(s.highestSpendMember.cost) : undefined}
            />
            <Stat
              label="Highest ROI member"
              value={s.highestRoiMember ? s.highestRoiMember.login : '—'}
              sub={s.highestRoiMember ? `${s.highestRoiMember.roiPct.toFixed(0)}% est.` : undefined}
              tone="pos"
            />
            <Stat
              label="Lowest ROI member"
              value={s.lowestRoiMember ? s.lowestRoiMember.login : '—'}
              sub={s.lowestRoiMember ? `${s.lowestRoiMember.roiPct.toFixed(0)}% est.` : undefined}
              tone="neg"
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Member spend leaderboard (est.)">
              <BarChartClient data={c.spendLeaderboard} xKey="user" yKey="spend" />
            </Card>
            <Card title="Inactive seat waste">
              <BarChartClient data={c.inactiveSeatWaste} xKey="user" yKey="wasteUsd" />
            </Card>
            <Card title="AI credits by member">
              <BarChartClient data={c.aiCreditsByMember} xKey="user" yKey="credits" />
            </Card>
            <Card title="ROI by member (est.)">
              <BarChartClient data={c.roiByMember} xKey="user" yKey="roiPct" />
            </Card>
            <Card title="Cost vs value (est.)">
              <LineChartClient
                data={c.costVsValue.flatMap((r) => [
                  { user: r.user, metric: 'cost', value: r.cost },
                  { user: r.user, metric: 'value', value: r.value },
                ])}
                xKey="user"
                yKey="value"
              />
            </Card>
            <Card title="Accepted lines by member">
              <BarChartClient data={c.acceptedLinesByMember} xKey="user" yKey="lines" />
            </Card>
            <Card title="Chat usage by member">
              <BarChartClient data={c.chatUsageByMember} xKey="user" yKey="turns" />
            </Card>
            <Card title="Usage trend by date">
              <AreaChartClient data={c.usageTrendByDate} xKey="day" yKey="spend" />
            </Card>
            <Card title="Model mix (top pairs)">
              <BarChartClient
                data={c.modelMix.slice(0, 12).map((r) => ({
                  label: `${r.user}/${r.model}`,
                  count: r.count,
                }))}
                xKey="label"
                yKey="count"
              />
            </Card>
          </div>

          <Card title="Member spend table" subtitle="All values estimated or allocated">
            <MemberTable rows={data?.members ?? []} />
          </Card>

          {(data?.findings?.length ?? 0) > 0 && (
            <Card title="Recommendations" subtitle="Advisory — based on estimated spend and ROI">
              <div className="divide-y divide-edge/60">
                {data!.findings.map((f) => (
                  <div key={f.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                    <Badge tone={f.severity === 'critical' ? 'neg' : f.severity === 'warning' ? 'warn' : 'info'} dot>
                      {f.severity}
                    </Badge>
                    <div>
                      <div className="text-sm font-medium text-gray-100">{f.title}</div>
                      <p className="mt-0.5 text-sm text-muted">{f.message}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
