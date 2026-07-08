import Link from 'next/link';
import { Badge, Card, DataTable, PageHeader, num, usd } from '../../components/ui';
import { proxyApi } from '../../lib/api';
import { resolveRange } from '../../lib/resolve-range';
import { discoverModelFamilies } from '../../lib/model-family';

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

type UsersResponse = {
  from: string;
  to: string;
  users: UserRow[];
  sources?: { llm_call_users: number; copilot_members: number };
};

const MEMBER_TABS = [
  { id: 'all', label: 'All' },
  { id: 'linked', label: 'Linked' },
  { id: 'unlinked', label: 'Unlinked' },
] as const;
type MemberTab = (typeof MEMBER_TABS)[number]['id'];

const MODEL_CHIP_LIMIT = 3;

function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function ModelChips({ families }: { families: string[] }) {
  if (families.length === 0) return <>—</>;
  const shown = families.slice(0, MODEL_CHIP_LIMIT);
  const rest = families.length - shown.length;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {shown.map((label) => (
        <Badge key={label} tone="neutral">
          {label}
        </Badge>
      ))}
      {rest > 0 && <span className="text-xs text-muted">and {rest} more</span>}
    </span>
  );
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string; q?: string; tab?: string };
}) {
  const { from, to } = resolveRange(searchParams);
  const q = searchParams.q?.trim() ?? '';
  const tab: MemberTab = MEMBER_TABS.some((t) => t.id === searchParams.tab)
    ? (searchParams.tab as MemberTab)
    : 'all';
  const qs = new URLSearchParams({ from, to });
  if (q) qs.set('q', q);

  const { ok, data } = await proxyApi(`/v1/analytics/users?${qs.toString()}`);
  const payload = (ok && data && typeof data === 'object' ? data : { users: [] }) as UsersResponse;
  const allUsers = payload.users ?? [];
  const sources = payload.sources;
  const users =
    tab === 'linked'
      ? allUsers.filter((u) => u.resolved)
      : tab === 'unlinked'
        ? allUsers.filter((u) => !u.resolved)
        : allUsers;
  const loadError = !ok;
  const showUnlinkedBadge = tab !== 'linked' && users.some((u) => !u.resolved);

  const tabHref = (next: MemberTab, keepQ = true) => {
    const params = new URLSearchParams({ from, to });
    if (next !== 'all') params.set('tab', next);
    if (keepQ && q) params.set('q', q);
    return `/users?${params.toString()}`;
  };

  const tabSubtitle =
    tab === 'linked'
      ? 'Linked members'
      : tab === 'unlinked'
        ? 'Unlinked handles'
        : 'Discovered users with spend';

  const sourceNote =
    sources != null
      ? `${allUsers.length} members · ${sources.llm_call_users} from metered API usage · ${sources.copilot_members} from GitHub Copilot`
      : `${allUsers.length} members`;

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
                      t.id === tab ? 'bg-accent/20 text-white' : 'border border-edge text-muted hover:bg-white/5'
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
            The users API returned an error. Restart the API service if you recently deployed this feature.
          </p>
        </Card>
      )}

      <Card title="Search">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="from" value={from} />
          <input type="hidden" name="to" value={to} />
          {tab !== 'all' && <input type="hidden" name="tab" value={tab} />}
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
            <Link href={tabHref(tab, false)} className="pb-2 text-sm text-muted hover:text-white">
              Clear
            </Link>
          )}
        </form>
      </Card>

      <Card title={`Member directory · ${MEMBER_TABS.find((t) => t.id === tab)?.label ?? 'All'}`}>
        <DataTable
          columns={[
            { key: 'user', label: 'User' },
            { key: 'email', label: 'Email' },
            { key: 'team', label: 'Team' },
            { key: 'spend', label: 'Total spend', align: 'right' },
            { key: 'calls', label: 'Calls', align: 'right' },
            { key: 'models', label: 'Models used' },
          ]}
          rows={users.map((u) => ({
            user: (
              <span className="inline-flex flex-wrap items-center gap-2">
                <Link href={`/users/${encodeURIComponent(u.user_id)}?from=${from}&to=${to}`} className="text-accent hover:text-accent-soft hover:underline">
                  {u.display_name}
                </Link>
                {showUnlinkedBadge && !u.resolved && (
                  <Badge tone="warn" dot>
                    unlinked
                  </Badge>
                )}
              </span>
            ),
            email: u.email || (isEmailLike(u.user_id) ? u.user_id : '—'),
            team: u.team || '—',
            spend: usd(u.total_spend_usd),
            calls: num(u.calls),
            models: <ModelChips families={discoverModelFamilies(u.model_breakdown)} />,
          }))}
        />
      </Card>
    </>
  );
}
