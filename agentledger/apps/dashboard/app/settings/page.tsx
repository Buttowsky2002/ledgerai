import Link from 'next/link';
import { Suspense } from 'react';
import { AccountSettings } from '../../components/settings/AccountSettings';
import { AuditingSettings } from '../../components/settings/AuditingSettings';
import { DeleteButton } from '../../components/settings/DeleteButton';
import { CreateBudget, CreateKey, CreatePolicy } from '../../components/settings/forms';
import {
  AddIdpForm,
  IssueScimTokenForm,
  RevokeButton,
} from '../../components/settings/IntegrationsForms';
import { PermissionsSettings } from '../../components/settings/PermissionsSettings';
import { PrivacySettings } from '../../components/settings/PrivacySettings';
import { Card, DataTable, PageHeader, usd } from '../../components/ui';
import { apiClient, fetchData, proxyApi } from '../../lib/api';
import { isDemoIdentityEmail } from '../../lib/identity-filters';
import type { IdentityRow, InviteRow } from '../../lib/settings-types';

export const dynamic = 'force-dynamic';

const TABS = [
  ['account', 'Account'],
  ['permissions', 'Permissions'],
  ['auditing', 'Auditing'],
  ['keys', 'Virtual keys'],
  ['policies', 'Policies'],
  ['budgets', 'Budgets'],
  ['integrations', 'Integrations'],
  ['connectors', 'Data sources'],
] as const;
type SettingsTab =
  | 'account'
  | 'permissions'
  | 'auditing'
  | 'keys'
  | 'policies'
  | 'budgets'
  | 'integrations';

export default async function SettingsPage({ searchParams }: { searchParams: { tab?: string } }) {
  if (searchParams.tab === 'connectors') {
    const { ConnectorsClient } = await import('../../components/connectors/ConnectorsClient');
    return (
      <Suspense fallback={<p className="p-8 text-sm text-muted">Loading data sources…</p>}>
        <ConnectorsClient />
      </Suspense>
    );
  }

  const tab: SettingsTab = (
    ['account', 'permissions', 'auditing', 'keys', 'policies', 'budgets', 'integrations'] as const
  ).includes(searchParams.tab as SettingsTab)
    ? (searchParams.tab as SettingsTab)
    : 'account';
  const api = apiClient();
  const tenant = (await fetchData(api.GET('/v1/tenant'), null)) as {
    complianceFlags?: Record<string, unknown>;
  } | null;
  const complianceFlags = (tenant?.complianceFlags ?? {}) as Record<string, unknown>;
  const individualAnalytics = complianceFlags.perUserAnalytics === 'individual';

  return (
    <>
      <PageHeader
        title="Settings"
        actions={
          <div className="flex flex-wrap gap-2">
            {TABS.map(([key, label]) => (
              <Link
                key={key}
                href={key === 'connectors' ? '/settings?tab=connectors' : `/settings?tab=${key}`}
                className={`rounded px-3 py-1.5 text-sm ${
                  key === tab || (key === 'connectors' && searchParams.tab === 'connectors')
                    ? 'bg-accent/20 text-white'
                    : 'border border-edge text-muted hover:bg-white/5'
                }`}
              >
                {label}
              </Link>
            ))}
          </div>
        }
      />

      {tab === 'account' && <AccountTab />}
      {tab === 'permissions' && <PermissionsTab api={api} />}
      {tab === 'auditing' && <AuditingTab />}

      {tab !== 'account' && tab !== 'permissions' && tab !== 'auditing' && (
        <Card title="Privacy & analytics">
          <PrivacySettings
            initialIndividualAnalytics={individualAnalytics}
            initialComplianceFlags={complianceFlags}
          />
        </Card>
      )}

      {tab === 'keys' && <KeysTab api={api} />}
      {tab === 'policies' && <PoliciesTab api={api} />}
      {tab === 'budgets' && <BudgetsTab api={api} />}
      {tab === 'integrations' && <IntegrationsTab api={api} />}
    </>
  );
}

async function AccountTab() {
  const { ok, data } = await proxyApi('/auth/me');
  const session =
    ok && data && typeof data === 'object' && 'userId' in data
      ? (data as {
          userId: string;
          tenantId: string;
          role: string;
          displayName?: string | null;
          email?: string | null;
        })
      : null;
  return (
    <Card title="Login & session">
      <AccountSettings session={session} />
    </Card>
  );
}

async function PermissionsTab({ api }: { api: Api }) {
  try {
    const [{ ok, data: me }, identities, invRes] = await Promise.all([
      proxyApi('/auth/me'),
      fetchData(
        api.GET('/v1/identities', { params: { query: { limit: '200', offset: '0' } } }),
        [],
      ) as Promise<IdentityRow[]>,
      proxyApi('/v1/invites'),
    ]);
    const session =
      ok && me && typeof me === 'object' && 'role' in me
        ? (me as { userId: string | null; role: string })
        : null;
    const canManage = session?.role === 'admin';
    const pendingInvites: InviteRow[] = (
      invRes.ok && Array.isArray(invRes.data) ? (invRes.data as InviteRow[]) : []
    ).filter((i) => i.status === 'pending' && !isDemoIdentityEmail(i.email));
    const members = (Array.isArray(identities) ? identities : []).filter(
      (i) => !isDemoIdentityEmail(i.email),
    );
    return (
      <Card title="User roles">
        <PermissionsSettings
          identities={members}
          pendingInvites={pendingInvites}
          canManage={canManage}
          currentUserId={session?.userId ?? null}
        />
      </Card>
    );
  } catch (err) {
    console.error('settings/permissions failed', err);
    return (
      <Card title="User roles">
        <p className="text-sm text-neg">
          Could not load team permissions. Refresh the page or try again in a moment.
        </p>
      </Card>
    );
  }
}

async function AuditingTab() {
  return (
    <Card title="Activity audit">
      <p className="mb-4 text-xs text-muted">
        Only users with the <span className="text-gray-100">admin</span> role can view the audit
        log. History defaults to the last 30 days — widen the range or load more to see older
        events.
      </p>
      <AuditingSettings />
    </Card>
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
            actions: k.revokedAt ? null : (
              <DeleteButton url={`/api/keys/${k.keyId}`} label="Revoke" />
            ),
          }))}
        />
      </Card>
    </>
  );
}

async function IntegrationsTab({ api }: { api: Api }) {
  const [scimTokens, idps] = await Promise.all([
    fetchData(
      api.GET('/v1/scim-tokens', { params: { query: { limit: '100', offset: '0' } } }),
      [],
    ) as Promise<
      { tokenId: string; name: string; revokedAt: string | null; lastUsedAt: string | null }[]
    >,
    fetchData(
      api.GET('/v1/tenant-idp-config', { params: { query: { limit: '100', offset: '0' } } }),
      [],
    ) as Promise<
      {
        idpId: string;
        issuer: string;
        emailDomains: string[];
        jitEnabled: boolean;
        enabled: boolean;
      }[]
    >,
  ]);

  return (
    <>
      <Card title="SCIM provisioning">
        <IssueScimTokenForm />
        <div className="mt-4">
          <DataTable
            columns={[
              { key: 'name', label: 'Name' },
              { key: 'status', label: 'Status' },
              { key: 'lastUsed', label: 'Last used' },
              { key: 'actions', label: '' },
            ]}
            rows={scimTokens.map((t) => ({
              name: t.name,
              status: t.revokedAt ? 'revoked' : 'active',
              lastUsed: t.lastUsedAt ? new Date(t.lastUsedAt).toISOString().slice(0, 10) : '—',
              actions: t.revokedAt ? null : (
                <RevokeButton url={`/api/scim-tokens/${t.tokenId}/revoke`} />
              ),
            }))}
          />
        </div>
        <p className="mt-3 text-xs text-muted">
          Point your IdP (Okta, Entra, Google Workspace) to https://app.yourdomain.com/scim/v2 with
          this token as the Bearer credential. SCIM Users map to identities; SCIM Groups map to
          teams.
        </p>
      </Card>

      <Card title="SSO / identity provider">
        <AddIdpForm />
        <div className="mt-4">
          <DataTable
            columns={[
              { key: 'issuer', label: 'Issuer' },
              { key: 'domains', label: 'Email domains' },
              { key: 'jit', label: 'JIT' },
              { key: 'status', label: 'Status' },
              { key: 'actions', label: '' },
            ]}
            rows={idps.map((i) => ({
              issuer: i.issuer,
              domains: i.emailDomains.join(', '),
              jit: i.jitEnabled ? 'yes' : 'no',
              status: i.enabled ? 'enabled' : 'disabled',
              actions: <DeleteButton url={`/api/tenant-idp-config/${i.idpId}`} />,
            }))}
          />
        </div>
        <p className="mt-3 text-xs text-muted">
          Users whose email domain matches will be redirected to this IdP at login. Set the callback
          URL in your IdP to https://app.yourdomain.com/auth/sso/callback.
        </p>
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
