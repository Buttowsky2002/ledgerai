import type { ReactNode } from 'react';
import Link from 'next/link';
import { Badge, Card, DataTable, PageHeader, usd } from '../../components/ui';
import { TablePager } from '../../components/TablePager';
import { UtilizationStatusBadge } from '../../components/UtilizationStatusBadge';
import { VendorSpendCell } from '../../components/VendorSpendCell';
import { proxyApi } from '../../lib/api';
import { resolveRange } from '../../lib/resolve-range';
import { vendorLabel } from '../../lib/fixed-cost-catalog';
import { paginateItems, parsePageParam, USERS_PAGE_SIZE } from '../../lib/table-pager';
import {
  sumVendorColumns,
  userVendorTotal,
  vendorShortLabel,
  type VendorSpendSlice,
} from '../../lib/vendor-spend';

export const dynamic = 'force-dynamic';

type UtilizationStatus = 'active' | 'low_use' | 'inactive';

type UserRow = {
  user_id: string;
  display_name: string;
  email: string | null;
  team: string;
  resolved: boolean;
  total_spend_usd: number;
  vendor_spend?: Record<string, VendorSpendSlice>;
  status?: UtilizationStatus;
  has_seat?: boolean;
  utilization_score?: number;
  seat_monthly_cost_usd?: number;
};

type UsersResponse = {
  from: string;
  to: string;
  users: UserRow[];
  vendors: string[];
  org_billing?: { total_cost_of_ai: number };
  sources?: { llm_call_users: number; copilot_members: number; cursor_members?: number };
};

const MEMBER_TABS = [
  { id: 'all', label: 'All' },
  { id: 'linked', label: 'Linked' },
  { id: 'unlinked', label: 'Unlinked' },
] as const;
type MemberTab = (typeof MEMBER_TABS)[number]['id'];

const STATUS_TABS = [
  { id: 'all', label: 'Any status' },
  { id: 'active', label: 'Active' },
  { id: 'low_use', label: 'Low use' },
  { id: 'inactive', label: 'Inactive' },
] as const;
type StatusTab = (typeof STATUS_TABS)[number]['id'];

function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function isStatusTab(v: string | undefined): v is StatusTab {
  return STATUS_TABS.some((t) => t.id === v);
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: {
    from?: string;
    to?: string;
    q?: string;
    tab?: string;
    status?: string;
    page?: string;
  };
}) {
  const { from, to } = resolveRange(searchParams);
  const q = searchParams.q?.trim() ?? '';
  const tab: MemberTab = MEMBER_TABS.some((t) => t.id === searchParams.tab)
    ? (searchParams.tab as MemberTab)
    : 'all';
  const status: StatusTab = isStatusTab(searchParams.status) ? searchParams.status : 'all';
  const page = parsePageParam(searchParams.page);

  const qs = new URLSearchParams({ from, to });
  if (q) {
    qs.set('q', q);
  }

  const { ok, data } = await proxyApi(`/v1/analytics/users?${qs.toString()}`);
  const payload = (
    ok && data && typeof data === 'object' ? data : { users: [], vendors: [] }
  ) as UsersResponse;
  const allUsers = payload.users ?? [];
  const vendors = payload.vendors ?? [];
  const orgTotal = payload.org_billing?.total_cost_of_ai;
  const sources = payload.sources;

  let users =
    tab === 'linked'
      ? allUsers.filter((u) => u.resolved)
      : tab === 'unlinked'
        ? allUsers.filter((u) => !u.resolved)
        : allUsers;
  if (status !== 'all') {
    users = users.filter((u) => u.status === status);
  }

  const pageSlice = paginateItems(users, page, USERS_PAGE_SIZE);
  const loadError = !ok;
  const showUnlinkedBadge = tab !== 'linked' && pageSlice.items.some((u) => !u.resolved);

  const buildHref = (opts: {
    nextTab?: MemberTab;
    nextStatus?: StatusTab;
    nextPage?: number;
    keepQ?: boolean;
  }) => {
    const params = new URLSearchParams({ from, to });
    const nextTab = opts.nextTab ?? tab;
    const nextStatus = opts.nextStatus ?? status;
    if (nextTab !== 'all') {
      params.set('tab', nextTab);
    }
    if (nextStatus !== 'all') {
      params.set('status', nextStatus);
    }
    if (opts.keepQ !== false && q) {
      params.set('q', q);
    }
    if (opts.nextPage != null && opts.nextPage > 1) {
      params.set('page', String(opts.nextPage));
    }
    return `/users?${params.toString()}`;
  };

  const tabHref = (next: MemberTab, keepQ = true) =>
    buildHref({ nextTab: next, nextStatus: status, keepQ });
  const statusHref = (next: StatusTab) => buildHref({ nextStatus: next, nextPage: 1 });

  const inactiveSeats = allUsers.filter((u) => u.has_seat && u.status === 'inactive').length;
  const activeUsers = allUsers.filter((u) => u.status === 'active').length;
  const lowUseUsers = allUsers.filter((u) => u.status === 'low_use').length;

  const tabSubtitle =
    tab === 'linked'
      ? 'Linked members'
      : tab === 'unlinked'
        ? 'Unlinked handles'
        : 'Discovered users · spend + seat utilization';

  const sourceNote =
    sources != null
      ? `${allUsers.length} members · ${sources.llm_call_users} metered · ${sources.cursor_members ?? 0} Cursor · ${sources.copilot_members} Copilot`
      : `${allUsers.length} members`;

  const vendorTotals = sumVendorColumns(users, vendors);
  const directoryTotal = users.reduce((s, u) => s + userVendorTotal(u), 0);

  const columns = [
    { key: 'user', label: 'User' },
    { key: 'email', label: 'Email' },
    { key: 'team', label: 'Team' },
    { key: 'status', label: 'Status' },
    ...vendors.map((v) => ({
      key: `vendor_${v}`,
      label: vendorShortLabel(v),
      align: 'right' as const,
    })),
    { key: 'total', label: 'Total $', align: 'right' as const },
  ];

  const footerRow: Record<string, ReactNode> = {
    user: <span className="text-xs uppercase tracking-wide text-muted">Grand total</span>,
    email: '',
    team: '',
    status: '',
    total: usd(orgTotal ?? directoryTotal),
  };
  for (const v of vendors) {
    footerRow[`vendor_${v}`] = <VendorSpendCell slice={vendorTotals[v]} />;
  }

  return (
    <>
      <PageHeader
        title="Users"
        subtitle={`${tabSubtitle} · ${sourceNote}`}
        actions={
          <div className="flex flex-wrap justify-end gap-2">
            {MEMBER_TABS.map((t) => {
              const count =
                t.id === 'all'
                  ? allUsers.length
                  : t.id === 'linked'
                    ? allUsers.filter((u) => u.resolved).length
                    : allUsers.filter((u) => !u.resolved).length;
              return (
                <Link
                  key={t.id}
                  href={tabHref(t.id)}
                  className={`rounded px-3 py-1.5 text-sm ${
                    t.id === tab
                      ? 'bg-accent/20 text-white'
                      : 'border border-edge text-muted hover:bg-white/5'
                  }`}
                >
                  {t.label}
                  <span className="ml-1.5 text-xs text-muted">({count})</span>
                </Link>
              );
            })}
          </div>
        }
      />

      {loadError && (
        <Card title="Could not load users">
          <p className="text-sm text-warn">
            The users API returned an error. Restart the API service if you recently deployed this
            feature.
          </p>
        </Card>
      )}

      <Card
        title="Utilization (LARI)"
        subtitle="Seat & usage presence — same engine as CFO / product worth"
      >
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-edge/70 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-muted">Active</div>
            <div className="mt-1 text-lg font-semibold tabular-nums text-pos">{activeUsers}</div>
          </div>
          <div className="rounded-lg border border-edge/70 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-muted">Low use</div>
            <div className="mt-1 text-lg font-semibold tabular-nums text-warn">{lowUseUsers}</div>
          </div>
          <div className="rounded-lg border border-edge/70 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-muted">Inactive seats</div>
            <div className="mt-1 text-lg font-semibold tabular-nums text-neg">{inactiveSeats}</div>
          </div>
          <div className="rounded-lg border border-edge/70 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-muted">Showing</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">{users.length}</div>
            <div className="text-[11px] text-muted">after filters</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {STATUS_TABS.map((t) => {
            const count =
              t.id === 'all' ? allUsers.length : allUsers.filter((u) => u.status === t.id).length;
            return (
              <Link
                key={t.id}
                href={statusHref(t.id)}
                className={`rounded px-3 py-1.5 text-sm ${
                  t.id === status
                    ? 'bg-accent/20 text-white'
                    : 'border border-edge text-muted hover:bg-white/5'
                }`}
              >
                {t.label}
                <span className="ml-1.5 text-xs text-muted">({count})</span>
              </Link>
            );
          })}
        </div>
      </Card>

      <Card title="Search">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="from" value={from} />
          <input type="hidden" name="to" value={to} />
          {tab !== 'all' && <input type="hidden" name="tab" value={tab} />}
          {status !== 'all' && <input type="hidden" name="status" value={status} />}
          <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-sm">
            <span className="text-muted">Name, email, or team</span>
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Filter users…"
              className="rounded-md border border-edge bg-panel px-3 py-2 text-sm text-white placeholder:text-muted"
            />
          </label>
          <button
            type="submit"
            className="rounded-md bg-accent/20 px-4 py-2 text-sm text-white ring-1 ring-inset ring-accent/30 hover:bg-accent/30"
          >
            Search
          </button>
          {q && (
            <Link
              href={buildHref({ keepQ: false, nextPage: 1 })}
              className="pb-2 text-sm text-muted hover:text-white"
            >
              Clear
            </Link>
          )}
        </form>
      </Card>

      <Card title={`Member directory · ${MEMBER_TABS.find((t) => t.id === tab)?.label ?? 'All'}`}>
        {vendors.length > 0 && (
          <p className="mb-3 text-xs text-muted">
            Vendors: {vendors.map((v) => vendorLabel(v)).join(' · ')} — click a user for usage
            detail · {USERS_PAGE_SIZE} per page
          </p>
        )}
        {pageSlice.items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">No users match this filter.</p>
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={pageSlice.items.map((u) => {
                const row: Record<string, ReactNode> = {
                  user: (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <Link
                        href={`/users/${encodeURIComponent(u.user_id)}?from=${from}&to=${to}`}
                        className="text-accent hover:text-accent-soft hover:underline"
                      >
                        {u.display_name}
                      </Link>
                      {showUnlinkedBadge && !u.resolved && (
                        <Badge tone="warn" dot>
                          unlinked
                        </Badge>
                      )}
                      {u.has_seat && (
                        <Badge tone="info" dot>
                          seat
                        </Badge>
                      )}
                    </span>
                  ),
                  email: u.email || (isEmailLike(u.user_id) ? u.user_id : '—'),
                  team: u.team || '—',
                  status: u.status ? <UtilizationStatusBadge status={u.status} /> : '—',
                  total: usd(userVendorTotal(u)),
                };
                for (const v of vendors) {
                  row[`vendor_${v}`] = <VendorSpendCell slice={u.vendor_spend?.[v]} />;
                }
                return row;
              })}
              footerRows={[footerRow]}
            />
            <TablePager
              slice={pageSlice}
              hrefForPage={(p) => buildHref({ nextPage: p })}
              label="members"
            />
          </>
        )}
      </Card>
    </>
  );
}
