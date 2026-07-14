'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { GitHubCopilotDetail } from '@/components/copilot/GitHubCopilotDetail';
import { CursorPlatformDetail, type CursorSpendSummary } from '@/components/overview/CursorPlatformDetail';
import { Card, DataTable, Stat, num, usd } from '@/components/ui';
import { BillingTypeBadge } from '@/components/SpendBillingCell';

export type PlatformSpendRow = {
  platform: string;
  cost_usd: number;
  calls: number;
};

export type ModelMixRow = {
  provider: string;
  model: string;
  cost_usd: number;
  calls: number;
};

function isCopilotPlatform(platform: string): boolean {
  const p = platform.toLowerCase();
  return p === 'github copilot' || p === 'github_copilot' || p.includes('copilot');
}

function isCursorPlatform(platform: string): boolean {
  return platform.toLowerCase() === 'cursor';
}

function platformBillingKind(platform: string): 'metered' | 'per_seat' | 'mixed' {
  if (isCopilotPlatform(platform)) return 'per_seat';
  if (isCursorPlatform(platform)) return 'mixed';
  return 'metered';
}

function PlatformBillingBadge({ platform }: { platform: string }) {
  const kind = platformBillingKind(platform);
  if (kind === 'mixed') {
    return <BillingTypeBadge meteredUsd={1} seatUsd={1} />;
  }
  if (kind === 'per_seat') {
    return <BillingTypeBadge meteredUsd={0} seatUsd={1} />;
  }
  return <BillingTypeBadge meteredUsd={1} seatUsd={0} />;
}

function modelsForPlatform(platform: string, modelMix: ModelMixRow[]): ModelMixRow[] {
  if (isCopilotPlatform(platform)) {
    return modelMix.filter((m) => m.provider === 'github_copilot' || isCopilotPlatform(m.provider));
  }
  return modelMix.filter(
    (m) =>
      m.provider === platform ||
      m.provider.toLowerCase() === platform.toLowerCase(),
  );
}

function GenericPlatformDetail({
  platform,
  modelMix,
  cost,
  calls,
  from,
  to,
}: {
  platform: string;
  modelMix: ModelMixRow[];
  cost: number;
  calls: number;
  from: string;
  to: string;
}) {
  const models = modelsForPlatform(platform, modelMix).sort((a, b) => b.cost_usd - a.cost_usd);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Stat label="Spend" value={usd(cost)} accent />
        <Stat label="Calls / events" value={num(calls)} />
        <Stat label="Models in use" value={String(models.length)} />
      </div>
      {models.length > 0 ? (
        <DataTable
          columns={[
            { key: 'model', label: 'Model' },
            { key: 'cost', label: 'Spend', align: 'right' },
            { key: 'calls', label: 'Calls', align: 'right' },
            { key: 'share', label: 'Share', align: 'right' },
          ]}
          rows={models.map((m) => ({
            model: m.model || '(default)',
            cost: usd(m.cost_usd),
            calls: num(m.calls),
            share: cost > 0 ? `${((m.cost_usd / cost) * 100).toFixed(1)}%` : '—',
          }))}
        />
      ) : (
        <p className="py-4 text-center text-sm text-muted">No per-model breakdown for this source in the selected range.</p>
      )}
      <p className="text-xs text-muted">
        <Link href={`/model-mix?from=${from}&to=${to}`} className="text-accent hover:underline">
          Open full model mix →
        </Link>
      </p>
    </div>
  );
}

function SourcePicker({
  platforms,
  totalSpend,
  selected,
  onSelect,
}: {
  platforms: PlatformSpendRow[];
  totalSpend: number;
  selected: string | null;
  onSelect: (platform: string) => void;
}) {
  if (platforms.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted">
        No AI spend recorded in this range. Connect a data source or sync usage to populate this panel.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {platforms.map((row) => {
        const pct = totalSpend > 0 ? (row.cost_usd / totalSpend) * 100 : 0;
        const active = selected === row.platform;
        return (
          <button
            key={row.platform}
            type="button"
            onClick={() => onSelect(row.platform)}
            className={`w-full rounded-lg border px-4 py-3 text-left transition-colors ${
              active
                ? 'border-accent/40 bg-accent/10 ring-1 ring-inset ring-accent/20'
                : 'border-edge hover:border-edge/80 hover:bg-white/[0.03]'
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-2 text-sm font-medium text-gray-100">
                {row.platform}
                <PlatformBillingBadge platform={row.platform} />
              </span>
              <span className="num text-sm text-gray-200">{usd(row.cost_usd)}</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-edge">
              <div
                className={`h-full rounded-full transition-all ${active ? 'bg-accent' : 'bg-accent/60'}`}
                style={{ width: `${Math.max(pct, 2)}%` }}
              />
            </div>
            <div className="mt-1 flex justify-between text-[11px] text-muted">
              <span>{pct.toFixed(1)}% of spend</span>
              <span>{num(row.calls)} calls</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function OverviewAiSourcesPanel({
  platforms,
  modelMix,
  from,
  to,
  initialSource,
  cursorSpend,
  cursorSpendError = false,
}: {
  platforms: PlatformSpendRow[];
  modelMix: ModelMixRow[];
  from: string;
  to: string;
  initialSource?: string;
  cursorSpend?: CursorSpendSummary | null;
  cursorSpendError?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const totalSpend = platforms.reduce((s, p) => s + p.cost_usd, 0);

  const defaultSource = platforms[0]?.platform ?? null;
  const selected =
    initialSource && platforms.some((p) => p.platform === initialSource)
      ? initialSource
      : defaultSource;

  const selectedRow = platforms.find((p) => p.platform === selected);

  function selectPlatform(platform: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('source', platform);
    params.set('from', from);
    params.set('to', to);
    router.push(`/?${params.toString()}`, { scroll: false });
  }

  return (
    <>
      <Card
        title="AI sources & models"
        subtitle="Select a platform to view spend, models, and source-specific metrics"
        actions={
          selected ? (
            <Link
              href={`/model-mix?from=${from}&to=${to}`}
              className="text-xs text-accent hover:underline"
            >
              Model mix →
            </Link>
          ) : undefined
        }
      >
        <SourcePicker
          platforms={platforms}
          totalSpend={totalSpend}
          selected={selected}
          onSelect={selectPlatform}
        />
      </Card>

      {selected && selectedRow && (
        <Card
          title={selected}
          subtitle={
            isCopilotPlatform(selected)
              ? `${from} → ${to} · ${usd(selectedRow.cost_usd)} allocated (est.) · not a GitHub invoice`
              : isCursorPlatform(selected)
                ? `${from} → ${to} · platform list shows metered overage only · drill down for seats`
                : `${from} → ${to} · ${usd(selectedRow.cost_usd)} · ${num(selectedRow.calls)} calls`
          }
        >
          {isCopilotPlatform(selected) ? (
            <GitHubCopilotDetail from={from} to={to} embedded />
          ) : isCursorPlatform(selected) ? (
            <CursorPlatformDetail
              from={from}
              to={to}
              initialData={cursorSpend}
              initialLoadError={cursorSpendError}
            />
          ) : (
            <GenericPlatformDetail
              platform={selected}
              modelMix={modelMix}
              cost={selectedRow.cost_usd}
              calls={selectedRow.calls}
              from={from}
              to={to}
            />
          )}
        </Card>
      )}
    </>
  );
}
