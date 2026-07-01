import Link from 'next/link';
import { Badge, Card, DataTable, PageHeader, Stat, num, usd } from '../../../components/ui';
import { proxyApi } from '../../../lib/api';
import { parseRange } from '../../../lib/date-range';
import { discoverModelFamilies } from '../../../lib/model-family';

export const dynamic = 'force-dynamic';

type ModelBreakdown = { model: string; platform: string; spend_usd: number; calls: number };

type UserRow = {
  user_id: string;
  display_name: string;
  email: string | null;
  team: string;
  resolved: boolean;
  total_spend_usd: number;
  calls: number;
  models: string[];
  model_breakdown: ModelBreakdown[];
};

export default async function UserDetailPage({
  params,
  searchParams,
}: {
  params: { userId: string };
  searchParams: { from?: string; to?: string };
}) {
  const { from, to } = parseRange(searchParams);
  const userId = decodeURIComponent(params.userId);
  const qs = new URLSearchParams({ from, to });
  const { data } = await proxyApi(`/v1/analytics/users/${encodeURIComponent(userId)}?${qs.toString()}`);
  const user = (data ?? null) as UserRow | null;

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

  const breakdown = user.model_breakdown ?? [];
  const families = discoverModelFamilies(breakdown);

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
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3">
        <Stat label="Total spend" value={usd(user.total_spend_usd)} />
        <Stat label="Calls" value={num(user.calls)} />
        <Stat label="Models used" value={num(families.length)} sub={families.join(', ') || undefined} />
      </div>

      <Card title="Spend by model">
        {breakdown.length === 0 ? (
          <p className="text-sm text-muted">—</p>
        ) : (
          <DataTable
            columns={[
              { key: 'model', label: 'Model' },
              { key: 'platform', label: 'Platform' },
              { key: 'spend', label: 'Spend', align: 'right' },
              { key: 'calls', label: 'Calls', align: 'right' },
            ]}
            rows={breakdown.map((row) => ({
              model: row.model,
              platform: row.platform,
              spend: usd(row.spend_usd),
              calls: num(row.calls),
            }))}
          />
        )}
      </Card>
    </>
  );
}
