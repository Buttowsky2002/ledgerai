'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

const API_ROLES = ['viewer', 'analyst', 'admin'] as const;
type ApiRole = (typeof API_ROLES)[number];

export type IdentityRow = {
  userId: string;
  email: string;
  displayName: string | null;
  apiRole: string;
  active: boolean;
  source: string;
};

const FIELD =
  'rounded border border-edge bg-ink px-2 py-1.5 text-sm text-gray-100 focus:border-accent focus:outline-none';

export function PermissionsSettings({
  identities,
  canManage,
  currentUserId,
}: {
  identities: IdentityRow[];
  canManage: boolean;
  currentUserId: string | null;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [roles, setRoles] = useState<Record<string, string>>(() =>
    Object.fromEntries(identities.map((i) => [i.userId, i.apiRole])),
  );

  async function saveRole(userId: string, apiRole: ApiRole) {
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
        [userId]: identities.find((i) => i.userId === userId)?.apiRole ?? prev[userId],
      }));
      return;
    }
    setRoles((prev) => ({ ...prev, [userId]: apiRole }));
    router.refresh();
  }

  if (!canManage) {
    return (
      <p className="text-sm text-muted">
        Only users with the <span className="text-gray-100">admin</span> API role can change permissions.
        Ask an admin to promote your identity, then sign out and back in.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        API roles gate control-plane actions (viewer → analyst → admin). Changes apply on the next
        access-token refresh (about 15 minutes) or after the user signs out and back in.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-edge text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="py-2 pr-3 font-medium">Email</th>
              <th className="py-2 pr-3 font-medium">Name</th>
              <th className="py-2 pr-3 font-medium">Source</th>
              <th className="py-2 pr-3 font-medium">API role</th>
              <th className="py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {identities.map((row) => {
              const value = (roles[row.userId] ?? row.apiRole) as ApiRole;
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
                        const next = e.target.value as ApiRole;
                        setRoles((prev) => ({ ...prev, [row.userId]: next }));
                        void saveRole(row.userId, next);
                      }}
                    >
                      {API_ROLES.map((r) => (
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
            {identities.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-muted">
                  No identities yet. Users appear here after SSO or SCIM provisioning.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {err && <p className="text-xs text-neg">{err}</p>}
    </div>
  );
}
