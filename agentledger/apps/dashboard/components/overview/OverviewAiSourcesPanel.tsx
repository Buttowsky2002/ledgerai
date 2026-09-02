'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { CursorSpendSummary } from '@/components/overview/CursorPlatformDetail';
import { Card, DataTable, num, usd } from '@/components/ui';
import { buildModelTableRows, type ModelTableRow } from '@/components/vendors/VendorDetailSections';
import { vendorDetailHref } from '@/lib/vendor-routes';
import { userVendorTotal, vendorShortLabel, type VendorSpendSlice } from '@/lib/vendor-spend';

type UserRow = {
  user_id: string;
  display_name: string;
  email: string | null;
  team: string;
  vendor_spend?: Record<string, VendorSpendSlice>;
};

type OrgVendorRow = {
  vendor: string;
  seat_usd: number;
  budget_overage_usd: number;
  total_usd: number;
};

type ModelMixRow = {
  provider: string;
  model: string;
  cost_usd: number;
  calls: number;
};

export function OverviewAiSourcesPanel({
  from,
  to,
  users,
  models,
  orgVendors,
  cursorSpend,
}: {
  from: string;
  to: string;
  users: UserRow[];
  models: ModelMixRow[];
  orgVendors: OrgVendorRow[];
  cursorSpend?: CursorSpendSummary | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const viewTab = searchParams.get('aiView') === 'models' ? 'models' : 'users';

  function setView(next: 'users' | 'models') {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'models') {
      params.set('aiView', 'models');
    } else {
      params.delete('aiView');
    }
    router.push(`/?${params.toString()}`, { scroll: false });
  }

  const modelRows: ModelTableRow[] = buildModelTableRows(models, cursorSpend);
  const sortedUsers = [...users].sort((a, b) => userVendorTotal(b) - userVendorTotal(a));

  return (
    <Card title="AI sources & models" subtitle={`${from} → ${to} · Users and models in one view`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-edge pb-4">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setView('users')}
            className={`rounded-md px-4 py-2 text-sm font-medium ${
              viewTab === 'users'
                ? 'bg-accent/20 text-white ring-1 ring-inset ring-accent/30'
                : 'border border-edge text-muted hover:bg-white/5'
            }`}
          >
            Users
          </button>
          <button
            type="button"
            onClick={() => setView('models')}
            className={`rounded-md px-4 py-2 text-sm font-medium ${
              viewTab === 'models'
                ? 'bg-accent/20 text-white ring-1 ring-inset ring-accent/30'
                : 'border border-edge text-muted hover:bg-white/5'
            }`}
          >
            Models
          </button>
        </div>
        {orgVendors.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {orgVendors.map((v) => (
              <Link
                key={v.vendor}
                href={vendorDetailHref(v.vendor, from, to)}
                className="rounded-md border border-edge px-3 py-1.5 text-xs text-gray-200 hover:border-accent/40 hover:bg-accent/10"
              >
                {vendorShortLabel(v.vendor)}{' '}
                <span className="num text-muted">{usd(v.total_usd)}</span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {viewTab === 'users' ? (
        sortedUsers.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">No user spend in this range.</p>
        ) : (
          <DataTable
            columns={[
              { key: 'user', label: 'User' },
              { key: 'email', label: 'Email' },
              { key: 'team', label: 'Team' },
              { key: 'total', label: 'Total $', align: 'right' },
              { key: 'detail', label: '', align: 'right' },
            ]}
            rows={sortedUsers.map((u) => ({
              user: (
                <Link
                  href={`/users/${encodeURIComponent(u.user_id)}?from=${from}&to=${to}`}
                  className="text-accent hover:underline"
                >
                  {u.display_name}
                </Link>
              ),
              email: u.email ?? '—',
              team: u.team || '—',
              total: usd(userVendorTotal(u)),
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
                email: '',
                team: '',
                total: usd(sortedUsers.reduce((s, u) => s + userVendorTotal(u), 0)),
                detail: (
                  <Link
                    href={`/users?from=${from}&to=${to}`}
                    className="text-xs text-accent hover:underline"
                  >
                    Directory →
                  </Link>
                ),
              },
            ]}
          />
        )
      ) : modelRows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">No model usage in this range.</p>
      ) : (
        <DataTable
          columns={[
            { key: 'model', label: 'Model' },
            { key: 'metered', label: 'Metered overage', align: 'right' },
            { key: 'included', label: 'Included usage value', align: 'right' },
            { key: 'calls', label: 'Events', align: 'right' },
          ]}
          rows={modelRows.map((m) => ({
            model: m.model,
            metered: usd(m.metered_overage),
            included: m.included_value > 0 ? usd(m.included_value) : '—',
            calls: num(m.calls),
          }))}
          footerRows={[
            {
              model: (
                <span className="text-xs uppercase tracking-wide text-muted">Grand total</span>
              ),
              metered: usd(modelRows.reduce((s, r) => s + r.metered_overage, 0)),
              included: usd(modelRows.reduce((s, r) => s + r.included_value, 0)),
              calls: num(modelRows.reduce((s, r) => s + r.calls, 0)),
            },
          ]}
        />
      )}

      <p className="mt-4 text-xs text-muted">
        Vendor chips open the full detail page (seats, overage, models, users).{' '}
        <Link href={`/model-mix?from=${from}&to=${to}`} className="text-accent hover:underline">
          Full model mix →
        </Link>
      </p>
    </Card>
  );
}
