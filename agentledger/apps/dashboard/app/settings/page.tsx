import Link from 'next/link';
import { DeleteButton } from '../../components/settings/DeleteButton';
import { CreateBudget, CreateKey, CreatePolicy } from '../../components/settings/forms';
import { Card, DataTable, PageHeader, usd } from '../../components/ui';
import { apiClient, fetchData } from '../../lib/api';

export const dynamic = 'force-dynamic';

const TABS = [
  ['keys', 'Virtual keys'],
  ['policies', 'Policies'],
  ['budgets', 'Budgets'],
] as const;
type Tab = (typeof TABS)[number][0];

export default async function SettingsPage({ searchParams }: { searchParams: { tab?: string } }) {
  const tab: Tab = (['keys', 'policies', 'budgets'] as const).includes(searchParams.tab as Tab)
    ? (searchParams.tab as Tab)
    : 'keys';
  const api = apiClient();

  return (
    <>
      <PageHeader
        title="Settings"
        actions={
          <div className="flex gap-2">
            {TABS.map(([key, label]) => (
              <Link
                key={key}
                href={`/settings?tab=${key}`}
                className={`rounded px-3 py-1.5 text-sm ${
                  key === tab ? 'bg-accent/20 text-white' : 'border border-edge text-muted hover:bg-white/5'
                }`}
              >
                {label}
              </Link>
            ))}
          </div>
        }
      />

      {tab === 'keys' && <KeysTab api={api} />}
      {tab === 'policies' && <PoliciesTab api={api} />}
      {tab === 'budgets' && <BudgetsTab api={api} />}
    </>
  );
}

type Api = ReturnType<typeof apiClient>;

async function KeysTab({ api }: { api: Api }) {
  const keys = (await fetchData(
    api.GET('/v1/virtual-keys', { params: { query: { limit: '100', offset: '0' } } }),
    [],
  )) as unknown as {
    keyId: string;
    name: string;
    environment: string;
    revokedAt: string | null;
  }[];
  return (
    <>
      <Card title="Create virtual key">
        <CreateKey />
      </Card>
      <Card title="Virtual keys">
        <DataTable
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'env', label: 'Environment' },
            { key: 'status', label: 'Status' },
            { key: 'actions', label: '' },
          ]}
          rows={keys.map((k) => ({
            name: k.name,
            env: k.environment,
            status: k.revokedAt ? 'revoked' : 'active',
            actions: k.revokedAt ? null : <DeleteButton url={`/api/keys/${k.keyId}`} label="Revoke" />,
          }))}
        />
      </Card>
    </>
  );
}

async function PoliciesTab({ api }: { api: Api }) {
  const policies = (await fetchData(
    api.GET('/v1/policies', { params: { query: { limit: '100', offset: '0' } } }),
    [],
  )) as unknown as {
    policyId: string;
    name: string;
    kind: string;
    action: string;
    enabled: boolean;
  }[];
  return (
    <>
      <Card title="Create policy">
        <CreatePolicy />
      </Card>
      <Card title="Policies">
        <DataTable
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'kind', label: 'Kind' },
            { key: 'action', label: 'Action' },
            { key: 'enabled', label: 'Enabled' },
            { key: 'actions', label: '' },
          ]}
          rows={policies.map((p) => ({
            name: p.name,
            kind: p.kind,
            action: p.action,
            enabled: p.enabled ? 'yes' : 'no',
            actions: <DeleteButton url={`/api/policies/${p.policyId}`} />,
          }))}
        />
      </Card>
    </>
  );
}

async function BudgetsTab({ api }: { api: Api }) {
  const budgets = (await fetchData(
    api.GET('/v1/budgets', { params: { query: { limit: '100', offset: '0' } } }),
    [],
  )) as unknown as {
    budgetId: string;
    scopeType: string;
    scopeId: string;
    amountUsd: string;
    period: string;
  }[];
  return (
    <>
      <Card title="Create budget">
        <CreateBudget />
      </Card>
      <Card title="Budgets">
        <DataTable
          columns={[
            { key: 'scope', label: 'Scope' },
            { key: 'period', label: 'Period' },
            { key: 'amount', label: 'Amount', align: 'right' },
            { key: 'actions', label: '' },
          ]}
          rows={budgets.map((b) => ({
            scope: `${b.scopeType}:${b.scopeId}`,
            period: b.period,
            amount: usd(b.amountUsd),
            actions: <DeleteButton url={`/api/budgets/${b.budgetId}`} />,
          }))}
        />
      </Card>
    </>
  );
}
