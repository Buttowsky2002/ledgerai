import Link from 'next/link';
import { GitHubCopilotDetail } from '@/components/copilot/GitHubCopilotDetail';
import {
  CursorPlatformDetail,
  type CursorSpendSummary,
} from '@/components/overview/CursorPlatformDetail';
import { VendorSpendCell } from '@/components/VendorSpendCell';
import { VendorSpendPie } from '@/components/VendorSpendPie';
import { Card, DataTable, PageHeader, Stat, num, usd } from '@/components/ui';
import { vendorLabel } from '@/lib/fixed-cost-catalog';
import { vendorDetailHref, providerMatchesVendor } from '@/lib/vendor-routes';
import { type VendorSpendSlice } from '@/lib/vendor-spend';

export type OrgVendorRow = {
  vendor: string;
  seat_usd: number;
  budget_overage_usd: number;
  total_usd: number;
};

export type ModelTableRow = {
  model: string;
  metered_overage: number;
  included_value: number;
  calls: number;
};

type UserRow = {
  user_id: string;
  display_name: string;
  email: string | null;
  team: string;
  vendor_spend?: Record<string, VendorSpendSlice>;
};

export function VendorDetailSections({
  vendorId,
  from,
  to,
  orgRow,
  users,
  modelRows,
  cursorSpend,
  cursorSpendError = false,
}: {
  vendorId: string;
  from: string;
  to: string;
  orgRow: OrgVendorRow | null;
  users: UserRow[];
  modelRows: ModelTableRow[];
  cursorSpend?: CursorSpendSummary | null;
  cursorSpendError?: boolean;
}) {
  const label = vendorLabel(vendorId);
  const seat = orgRow?.seat_usd ?? 0;
  const overage = orgRow?.budget_overage_usd ?? 0;
  const total = orgRow?.total_usd ?? seat + overage;

  const vendorUsers = users
    .filter((u) => (u.vendor_spend?.[vendorId]?.total_usd ?? 0) > 0)
    .sort(
      (a, b) =>
        (b.vendor_spend?.[vendorId]?.total_usd ?? 0) - (a.vendor_spend?.[vendorId]?.total_usd ?? 0),
    );

  return (
    <>
      <PageHeader
        title={label}
        subtitle={`${from} → ${to}`}
        actions={
          <Link href={`/?from=${from}&to=${to}`} className="text-sm text-muted hover:text-white">
            ← Overview
          </Link>
        }
      />

      <Card title={`${label} · billing summary`}>
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Stat label="Subscription amount" value={usd(seat)} sub="Monthly seats · org level" />
          <Stat label="Budget overage" value={usd(overage)} sub="Metered beyond pool" accent />
          <Stat label="Total (seats + overage)" value={usd(total)} />
        </div>
        <VendorSpendPie seatUsd={seat} overageUsd={overage} size={180} />
      </Card>

      {vendorId === 'cursor' && (
        <Card
          title="Cursor usage detail"
          subtitle="Seat licenses, metered overage, and included pool"
        >
          <CursorPlatformDetail
            from={from}
            to={to}
            initialData={cursorSpend}
            initialLoadError={cursorSpendError}
          />
        </Card>
      )}

      {vendorId === 'github' && (
        <Card title="GitHub Copilot detail">
          <GitHubCopilotDetail from={from} to={to} embedded />
        </Card>
      )}

      {modelRows.length > 0 && vendorId !== 'cursor' && (
        <Card title="Models" subtitle="Metered overage vs included usage value">
          <DataTable
            columns={[
              { key: 'model', label: 'Model' },
              { key: 'metered', label: 'Metered overage', align: 'right', width: '9rem' },
              { key: 'included', label: 'Included usage value', align: 'right', width: '11rem' },
              { key: 'calls', label: 'Events', align: 'right', width: '6rem' },
            ]}
            rows={modelRows.map((m) => ({
              model: m.model,
              metered: usd(m.metered_overage),
              included: m.included_value > 0 ? usd(m.included_value) : '—',
              calls: num(m.calls),
            }))}
            footerRows={[
              {
                model: <span className="text-xs uppercase tracking-wide text-muted">Total</span>,
                metered: usd(modelRows.reduce((s, r) => s + r.metered_overage, 0)),
                included: usd(modelRows.reduce((s, r) => s + r.included_value, 0)),
                calls: num(modelRows.reduce((s, r) => s + r.calls, 0)),
              },
            ]}
          />
        </Card>
      )}

      <Card title="Users" subtitle={`Spend attributed to ${label}`}>
        {vendorUsers.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted">
            No user spend for this vendor in range.
          </p>
        ) : (
          <DataTable
            columns={[
              { key: 'user', label: 'User' },
              { key: 'team', label: 'Team' },
              { key: 'spend', label: 'Spend', align: 'right' },
              { key: 'detail', label: '', align: 'right' },
            ]}
            rows={vendorUsers.map((u) => ({
              user: u.display_name,
              team: u.team || '—',
              spend: <VendorSpendCell slice={u.vendor_spend?.[vendorId]} />,
              detail: (
                <Link
                  href={`/users/${encodeURIComponent(u.user_id)}?from=${from}&to=${to}`}
                  className="text-xs text-accent hover:underline"
                >
                  Details →
                </Link>
              ),
            }))}
            footerRows={[
              {
                user: (
                  <span className="text-xs uppercase tracking-wide text-muted">Grand total</span>
                ),
                team: '',
                spend: usd(
                  vendorUsers.reduce((s, u) => s + (u.vendor_spend?.[vendorId]?.total_usd ?? 0), 0),
                ),
                detail: '',
              },
            ]}
          />
        )}
      </Card>

      <p className="text-xs text-muted">
        <Link href={vendorDetailHref(vendorId, from, to)} className="text-accent hover:underline">
          Permalink
        </Link>
        {' · '}
        <Link href={`/users?from=${from}&to=${to}`} className="text-accent hover:underline">
          Member directory
        </Link>
      </p>
    </>
  );
}

export function buildModelTableRows(
  models: { provider: string; model: string; cost_usd: number; calls: number }[],
  cursorSpend?: CursorSpendSummary | null,
  vendorFilter?: string,
): ModelTableRow[] {
  const rows: ModelTableRow[] = [];
  const cursorByModel = new Map((cursorSpend?.modelMix ?? []).map((m) => [m.model, m]));

  if (!vendorFilter || vendorFilter === 'cursor') {
    for (const m of cursorSpend?.modelMix ?? []) {
      rows.push({
        model: m.model || '(default)',
        metered_overage: m.billed_usd ?? 0,
        included_value: m.usage_value_usd ?? 0,
        calls: m.calls ?? 0,
      });
    }
  }

  for (const m of models) {
    if (vendorFilter && !providerMatchesVendor(m.provider, vendorFilter)) {
      continue;
    }
    if (m.provider.toLowerCase() === 'cursor' || cursorByModel.has(m.model)) {
      continue;
    }
    rows.push({
      model: m.model || '(default)',
      metered_overage: m.cost_usd,
      included_value: 0,
      calls: m.calls,
    });
  }

  return rows.sort(
    (a, b) => b.metered_overage + b.included_value - (a.metered_overage + a.included_value),
  );
}
