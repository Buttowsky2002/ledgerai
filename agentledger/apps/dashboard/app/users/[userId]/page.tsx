import Link from 'next/link';
import { Badge, Card, PageHeader } from '../../../components/ui';
import { UserVendorDetailTabs } from '../../../components/users/UserVendorDetailTabs';
import { proxyApi } from '../../../lib/api';
import { resolveRange } from '../../../lib/resolve-range';
import { userVendorTotal, type VendorSpendSlice, type VendorUsageSlice } from '../../../lib/vendor-spend';
import { usd } from '../../../components/ui';

export const dynamic = 'force-dynamic';

type UserRow = {
  user_id: string;
  display_name: string;
  email: string | null;
  team: string;
  resolved: boolean;
  total_spend_usd: number;
  vendor_spend?: Record<string, VendorSpendSlice>;
  vendor_usage?: Record<string, VendorUsageSlice>;
};

export default async function UserDetailPage({
  params,
  searchParams,
}: {
  params: { userId: string };
  searchParams: { from?: string; to?: string };
}) {
  const { from, to } = resolveRange(searchParams);
  const userId = decodeURIComponent(params.userId);
  const qs = new URLSearchParams({ from, to });

  const [{ data: userData }, { data: listData }] = await Promise.all([
    proxyApi(`/v1/analytics/users/${encodeURIComponent(userId)}?${qs.toString()}`),
    proxyApi(`/v1/analytics/users?${qs.toString()}`),
  ]);

  const user = (userData ?? null) as UserRow | null;
  const vendors = (listData as { vendors?: string[] } | null)?.vendors ?? Object.keys(user?.vendor_spend ?? {});

  if (!user) {
    return (
      <>
        <PageHeader title="User not found" subtitle={userId} />
        <Link href={`/users?from=${from}&to=${to}`} className="text-sm text-accent hover:text-accent-soft hover:underline">
          ← Back to users
        </Link>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={user.display_name}
        subtitle={`${from} → ${to}`}
        actions={
          <Link href={`/users?from=${from}&to=${to}`} className="text-sm text-muted hover:text-white">
            ← All users
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        {!user.resolved && (
          <Badge tone="warn" dot>
            unlinked
          </Badge>
        )}
        {user.email && <span className="text-sm text-muted">{user.email}</span>}
        {user.team && <span className="text-sm text-muted">Team: {user.team}</span>}
        <span className="text-xs text-muted">ID: {user.user_id}</span>
        <span className="text-sm text-gray-200">
          Total AI cost: <span className="num font-medium">{usd(userVendorTotal(user))}</span>
        </span>
      </div>

      <Card title="Usage by vendor">
        <UserVendorDetailTabs
          userId={user.user_id}
          from={from}
          to={to}
          vendors={vendors}
          vendorSpend={user.vendor_spend ?? {}}
          vendorUsage={user.vendor_usage ?? {}}
        />
      </Card>
    </>
  );
}
