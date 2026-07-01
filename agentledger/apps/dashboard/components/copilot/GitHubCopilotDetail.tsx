'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AreaChartClient,
  BarChartClient,
  LineChartClient,
  PieChartClient,
} from '@/components/charts';
import { Badge, Card, Stat, usd } from '@/components/ui';
import {
  fetchCopilotOverview,
  syncCopilotConnection,
  updateCopilotAssumptions,
} from '@/lib/api/github-copilot';
import { GitHubCopilotConnectForm } from '@/components/copilot/GitHubCopilotConnectForm';
import { GitHubCopilotMemberSpend } from '@/components/copilot/GitHubCopilotMemberSpend';
import type {
  CopilotConnectionStatus,
  CopilotOverviewResponse,
  CopilotRoiAssumptions,
} from '@/types/github-copilot';

const DEFAULT_ASSUMPTIONS: CopilotRoiAssumptions = {
  avgEngineerHourlyRate: 55,
  minutesSavedPerAcceptedLine: 0.25,
  minutesSavedPerChatTurn: 2,
  minutesSavedPerPrSummary: 5,
  qualityAdjustmentFactor: 0.5,
  seatPriceUsd: 19,
  includedCreditsPerSeat: 1900,
  creditValueUsd: 0.01,
};

const FINDING_TONE: Record<string, 'info' | 'warn' | 'neg'> = {
  info: 'info',
  warning: 'warn',
  critical: 'neg',
};

function SkeletonBlock() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-24 rounded-xl border border-edge bg-panel" />
        ))}
      </div>
      <div className="h-64 rounded-xl border border-edge bg-panel" />
    </div>
  );
}

/** Copilot metrics and charts — embeddable in Overview drill-down. Connection setup lives in Data sources. */
export function GitHubCopilotDetail({
  from,
  to,
  embedded = false,
}: {
  from: string;
  to: string;
  embedded?: boolean;
}) {
  const [data, setData] = useState<CopilotOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncSuccess, setSyncSuccess] = useState<string | null>(null);
  const [assumptionsOpen, setAssumptionsOpen] = useState(false);
  const [assumptions, setAssumptions] = useState<CopilotRoiAssumptions>(DEFAULT_ASSUMPTIONS);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetchCopilotOverview(from, to);
      setData(res);
      if (res?.roiAssumptions) setAssumptions(res.roiAssumptions);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSync(conn: CopilotConnectionStatus) {
    setSyncing(conn.connectionId);
    setSyncError(null);
    setSyncSuccess(null);
    const result = await syncCopilotConnection(conn.connectionId);
    setSyncing(null);
    if (result?.ok) {
      setSyncSuccess(
        `Sync complete: ${result.seatsImported} seats, ${result.usageRowsImported} usage rows, ${result.roiRowsComputed} ROI snapshots${result.memberSpendRowsComputed != null ? `, ${result.memberSpendRowsComputed} member spend rows` : ''}.`,
      );
    } else {
      setSyncError(result?.errorMessage ?? 'Sync failed. Check token scopes and try again.');
    }
    await load();
  }

  async function handleSaveAssumptions(connectionId: string) {
    await updateCopilotAssumptions(connectionId, assumptions);
    setAssumptionsOpen(false);
    await load();
  }

  const m = data?.metrics;
  const c = data?.charts;
  const empty =
    !loading &&
    !error &&
    data?.connected &&
    m &&
    m.activeSeats === 0 &&
    m.inactiveSeats === 0 &&
    m.monthlyCopilotSpend === 0;

  return (
    <div className={embedded ? 'space-y-6' : 'mt-10 space-y-6'}>
      {!embedded && (
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-100">GitHub Copilot Business</h2>
            <p className="mt-1 text-sm text-muted">
              Seat, usage, AI credit, and estimated ROI — daily sync · license + usage cost model
            </p>
          </div>
        </div>
      )}

      {data?.connections?.[0] && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => handleSync(data.connections[0])}
            disabled={syncing !== null}
            className="rounded-lg border border-edge px-3 py-1.5 text-sm text-gray-200 hover:bg-white/5 disabled:opacity-50"
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
          <button
            type="button"
            onClick={() => setAssumptionsOpen((v) => !v)}
            className="rounded-lg border border-edge px-3 py-1.5 text-sm text-muted hover:bg-white/5"
          >
            ROI assumptions
          </button>
        </div>
      )}

      {data?.disclaimer && (
        <p className="rounded-lg border border-edge/80 bg-panel/60 px-4 py-2.5 text-xs text-muted">
          {data.disclaimer}
        </p>
      )}

      {syncError && (
        <p className="rounded-lg border border-neg/30 bg-neg/10 px-4 py-3 text-sm text-neg">{syncError}</p>
      )}
      {syncSuccess && (
        <p className="rounded-lg border border-pos/30 bg-pos/10 px-4 py-3 text-sm text-pos">{syncSuccess}</p>
      )}

      {assumptionsOpen && data?.connections?.[0] && (
        <Card title="ROI assumptions (estimated)" subtitle="Adjust model inputs — not exact productivity measures">
          <div className="grid max-w-2xl grid-cols-2 gap-3 text-sm">
            {(
              [
                ['avgEngineerHourlyRate', 'Avg engineer hourly rate ($)'],
                ['minutesSavedPerAcceptedLine', 'Minutes saved per accepted line'],
                ['minutesSavedPerChatTurn', 'Minutes saved per chat turn'],
                ['minutesSavedPerPrSummary', 'Minutes saved per PR summary'],
                ['qualityAdjustmentFactor', 'Quality adjustment (0–1)'],
                ['seatPriceUsd', 'Seat price ($/month)'],
                ['includedCreditsPerSeat', 'Included AI credits per seat'],
                ['creditValueUsd', 'AI credit value ($)'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="block">
                <span className="text-muted">{label}</span>
                <input
                  type="number"
                  step="any"
                  className="mt-1 w-full rounded border border-edge bg-panel px-2 py-1.5"
                  value={assumptions[key]}
                  onChange={(e) => setAssumptions({ ...assumptions, [key]: Number(e.target.value) })}
                />
              </label>
            ))}
          </div>
          <button
            type="button"
            className="mt-4 rounded bg-accent px-3 py-1.5 text-sm text-white"
            onClick={() => handleSaveAssumptions(data.connections[0].connectionId)}
          >
            Save assumptions
          </button>
        </Card>
      )}

      {loading && <SkeletonBlock />}

      {error && (
        <p className="rounded-lg border border-neg/30 bg-neg/10 px-4 py-3 text-sm text-neg">
          Could not load GitHub Copilot data. Check API connectivity.
        </p>
      )}

      {!loading && !error && !data?.connected && (
        <Card title="Connect GitHub Copilot Business" subtitle="Org slug + fine-grained PAT — token encrypted at rest">
          <GitHubCopilotConnectForm compact onConnected={() => void load()} />
          <p className="mt-4 text-center text-xs text-muted">
            Or configure in{' '}
            <Link
              href="/settings/connectors?preset=github-copilot-business"
              className="text-accent hover:underline"
            >
              Settings → Data sources
            </Link>
          </p>
        </Card>
      )}

      {empty && (
        <p className="py-6 text-center text-sm text-muted">
          Connection is active but no seats or usage were imported. Run <strong>Sync now</strong> or sync from{' '}
          <Link href="/settings/connectors" className="text-accent hover:underline">
            Data sources
          </Link>
          .
        </p>
      )}

      {m && c && data?.connected && !empty && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-6">
            <Stat label="Allocated spend (est.)" value={usd(m.monthlyCopilotSpend)} accent sub="sum of member rows" />
            <Stat label="Active seats" value={String(m.activeSeats)} tone="pos" />
            <Stat
              label="Inactive seats"
              value={String(m.inactiveSeats)}
              tone={m.inactiveSeats > 0 ? 'warn' : 'default'}
            />
            <Stat label="AI credits used" value={String(Math.round(m.aiCreditsUsed))} />
            <Stat label="Credit utilization" value={`${m.creditUtilizationPct.toFixed(1)}%`} />
            <Stat label="Est. hours saved" value={m.estimatedHoursSaved.toFixed(1)} sub="estimated" />
            <Stat label="Est. value created" value={usd(m.estimatedValueCreated)} sub="estimated" />
            <Stat
              label="Est. ROI %"
              value={`${m.roiPercentage.toFixed(0)}%`}
              tone={m.roiPercentage >= 0 ? 'pos' : 'neg'}
              sub="estimated"
            />
            <Stat label="Cost / active user" value={usd(m.costPerActiveUser)} />
            <Stat label="Cost / engaged user" value={usd(m.costPerEngagedUser)} />
            <Stat label="Cost / accepted line" value={usd(m.costPerAcceptedLine)} />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Usage by feature">
              {c.usageByFeature.length > 0 ? (
                <PieChartClient
                  data={c.usageByFeature.map((r) => ({ name: r.feature, value: r.count }))}
                  nameKey="name"
                  valueKey="value"
                />
              ) : (
                <p className="py-8 text-center text-sm text-muted">No feature usage data.</p>
              )}
            </Card>
            <Card title="AI credits by user">
              {c.aiCreditsByUser.length > 0 ? (
                <BarChartClient data={c.aiCreditsByUser} xKey="user" yKey="credits" />
              ) : (
                <p className="py-8 text-center text-sm text-muted">No per-user credit data.</p>
              )}
            </Card>
            <Card title="Accepted lines by language">
              {c.acceptedLinesByLanguage.length > 0 ? (
                <BarChartClient data={c.acceptedLinesByLanguage} xKey="language" yKey="lines" />
              ) : (
                <p className="py-8 text-center text-sm text-muted">No language breakdown.</p>
              )}
            </Card>
            <Card title="Model mix">
              {c.modelMix.length > 0 ? (
                <PieChartClient
                  data={c.modelMix.map((r) => ({ name: r.model, value: r.count }))}
                  nameKey="name"
                  valueKey="value"
                />
              ) : (
                <p className="py-8 text-center text-sm text-muted">No model data.</p>
              )}
            </Card>
            <Card title="Seat waste">
              <BarChartClient data={c.seatWaste} xKey="bucket" yKey="wasteUsd" />
            </Card>
            <Card title="Adoption trend (28 days)">
              {c.adoptionTrend.length > 0 ? (
                <AreaChartClient data={c.adoptionTrend} xKey="day" yKey="activeUsers" />
              ) : (
                <LineChartClient data={[]} xKey="day" yKey="activeUsers" />
              )}
            </Card>
          </div>

          {data.findings.length > 0 && (
            <Card title="Automated findings" subtitle="Advisory recommendations">
              <div className="divide-y divide-edge/60">
                {data.findings.map((f) => (
                  <div key={f.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                    <Badge tone={FINDING_TONE[f.severity] ?? 'info'} dot>
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

      {data?.connected && (
        <div className="border-t border-edge pt-8">
          <GitHubCopilotMemberSpend from={from} to={to} />
        </div>
      )}
    </div>
  );
}
