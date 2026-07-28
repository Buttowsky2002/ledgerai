'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { isDemoIdentityEmail } from '../../lib/identity-filters';

const USER_ROLES = ['viewer', 'analyst', 'admin'] as const;
type UserRole = (typeof USER_ROLES)[number];

const ROLE_LABEL: Record<UserRole, string> = {
  viewer: 'Viewer — read-only',
  analyst: 'Analyst — analytics + attribution',
  admin: 'Admin — full access + user management',
};

export type IdentityRow = {
  userId: string;
  email: string;
  displayName: string | null;
  apiRole: string;
  role?: string;
  active: boolean;
  source: string;
};

export type InviteRow = {
  inviteId: string;
  email: string;
  apiRole: string;
  status: string;
  expiresAt: string;
  acceptedAt: string | null;
  displayName: string | null;
  invitedByName: string | null;
};

const FIELD =
  'rounded border border-edge bg-ink px-2 py-1.5 text-sm text-gray-100 focus:border-accent focus:outline-none';

function InviteModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [email, setEmail] = useState('');
  const [apiRole, setApiRole] = useState<UserRole>('viewer');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const res = await fetch('/api/identities/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, apiRole }),
    });
    setBusy(false);
    const body = (await res.json().catch(() => ({}))) as { message?: string; link?: string };
    if (!res.ok) {
      setErr(body.message ?? 'Failed to send invite.');
      return;
    }
    setLink(body.link ?? null);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md space-y-5 rounded-lg border border-edge bg-panel p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Invite team member</h2>
          <button type="button" onClick={onClose} className="text-lg leading-none text-muted hover:text-white">
            ×
          </button>
        </div>

        {link ? (
          <div className="space-y-3">
            <p className="text-sm text-pos">Invite created. Share this link with {email}:</p>
            <input
              readOnly
              value={link}
              className="w-full rounded border border-edge bg-ink px-2 py-1.5 font-mono text-xs text-muted"
              onFocus={(e) => e.target.select()}
            />
            <p className="text-xs text-muted">
              The link expires in 7 days. In production, this is sent by email automatically.
            </p>
            <button
              type="button"
              onClick={onSuccess}
              className="w-full rounded bg-accent/20 px-3 py-2 text-sm text-white ring-1 ring-inset ring-accent/30 hover:bg-accent/30"
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <label className="block space-y-1">
              <span className="text-sm text-muted">Email address</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="colleague@studiodesigner.com"
                className="w-full rounded border border-edge bg-ink px-2 py-1.5 text-sm text-white placeholder:text-muted focus:border-accent focus:outline-none"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-sm text-muted">Role</span>
              <select
                value={apiRole}
                onChange={(e) => setApiRole(e.target.value as UserRole)}
                className="w-full rounded border border-edge bg-ink px-2 py-1.5 text-sm text-white focus:border-accent focus:outline-none"
              >
                {USER_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>

            {err && <p className="text-sm text-neg">{err}</p>}

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded border border-edge px-3 py-2 text-sm text-muted hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="flex-1 rounded bg-accent/20 px-3 py-2 text-sm text-white ring-1 ring-inset ring-accent/30 hover:bg-accent/30 disabled:opacity-50"
              >
                {busy ? 'Sending…' : 'Send invite'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export function PermissionsSettings({
  identities,
  pendingInvites,
  canManage,
  currentUserId,
}: {
  identities: IdentityRow[];
  pendingInvites: InviteRow[];
  canManage: boolean;
  currentUserId: string | null;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const members = identities.filter((i) => !isDemoIdentityEmail(i.email));
  const [roles, setRoles] = useState<Record<string, string>>(() =>
    Object.fromEntries(members.map((i) => [i.userId, i.apiRole])),
  );

  async function saveRole(userId: string, apiRole: UserRole) {
    setBusyId(userId);
    setErr(null);
    const res = await fetch(`/api/identities/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiRole }),
    });
    setBusyId(null);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
      setErr(body?.message ?? body?.error ?? `Update failed (${res.status})`);
      setRoles((prev) => ({
        ...prev,
        [userId]: members.find((i) => i.userId === userId)?.apiRole ?? prev[userId],
      }));
      return;
    }
    setRoles((prev) => ({ ...prev, [userId]: apiRole }));
    router.refresh();
  }

  async function revokeInvite(inviteId: string) {
    setBusyId(inviteId);
    setErr(null);
    const res = await fetch(`/api/identities/invite/${encodeURIComponent(inviteId)}`, {
      method: 'DELETE',
    });
    setBusyId(null);
    if (!res.ok && res.status !== 204) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      setErr(body?.message ?? `Revoke failed (${res.status})`);
      return;
    }
    router.refresh();
  }

  if (!canManage) {
    return (
      <p className="text-sm text-muted">
        Only users with the <span className="text-gray-100">admin</span> role can change permissions.
        Ask an admin to promote your identity, then sign out and back in.
      </p>
    );
  }

  const invites = pendingInvites.filter((i) => !isDemoIdentityEmail(i.email));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted">
          Roles control what each person can do in the app (viewer → analyst → admin). Changes apply
          on the next access-token refresh (about 15 minutes) or after the user signs out and back in.
        </p>
        <button
          type="button"
          onClick={() => setShowInvite(true)}
          className="shrink-0 rounded bg-accent/20 px-3 py-1.5 text-sm text-white ring-1 ring-inset ring-accent/30 hover:bg-accent/30"
        >
          Invite member
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-edge text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="py-2 pr-3 font-medium">Email</th>
              <th className="py-2 pr-3 font-medium">Name</th>
              <th className="py-2 pr-3 font-medium">Source</th>
              <th className="py-2 pr-3 font-medium">Role</th>
              <th className="py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {members.map((row) => {
              const value = (roles[row.userId] ?? row.apiRole) as UserRole;
              const isSelf = currentUserId === row.userId;
              return (
                <tr key={row.userId} className="border-b border-edge/60">
                  <td className="py-2 pr-3 text-gray-100">
                    {row.email}
                    {isSelf && <span className="ml-2 text-xs text-muted">(you)</span>}
                  </td>
                  <td className="py-2 pr-3 text-muted">{row.displayName ?? '—'}</td>
                  <td className="py-2 pr-3 text-muted">{row.source}</td>
                  <td className="py-2 pr-3">
                    <select
                      className={FIELD}
                      value={value}
                      disabled={busyId === row.userId || !row.active}
                      onChange={(e) => {
                        const next = e.target.value as UserRole;
                        setRoles((prev) => ({ ...prev, [row.userId]: next }));
                        void saveRole(row.userId, next);
                      }}
                    >
                      {USER_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    {busyId === row.userId && (
                      <span className="ml-2 text-xs text-muted">Saving…</span>
                    )}
                  </td>
                  <td className="py-2 text-muted">{row.active ? 'active' : 'inactive'}</td>
                </tr>
              );
            })}
            {members.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-muted">
                  No team members yet. Invite a teammate or wait for SSO/SCIM provisioning.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {invites.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-gray-100">Pending invites</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-edge text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-2 pr-3 font-medium">Email</th>
                  <th className="py-2 pr-3 font-medium">Role</th>
                  <th className="py-2 pr-3 font-medium">Expires</th>
                  <th className="py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {invites.map((inv) => (
                  <tr key={inv.inviteId} className="border-b border-edge/60">
                    <td className="py-2 pr-3 text-gray-100">{inv.email}</td>
                    <td className="py-2 pr-3 capitalize text-muted">{inv.apiRole}</td>
                    <td className="py-2 pr-3 text-muted">
                      {inv.expiresAt ? new Date(inv.expiresAt).toISOString().slice(0, 10) : '—'}
                    </td>
                    <td className="py-2">
                      <button
                        type="button"
                        disabled={busyId === inv.inviteId}
                        onClick={() => void revokeInvite(inv.inviteId)}
                        className="text-xs text-neg hover:underline disabled:opacity-50"
                      >
                        {busyId === inv.inviteId ? 'Revoking…' : 'Revoke'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {err && <p className="text-xs text-neg">{err}</p>}

      {showInvite && (
        <InviteModal
          onClose={() => setShowInvite(false)}
          onSuccess={() => {
            setShowInvite(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
