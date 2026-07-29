'use client';

import { useMemo, useState } from 'react';
import type { AuditRow } from '../../lib/settings-types';

export type { AuditRow };

const ACTION_FILTERS = [
  { value: '', label: 'All events' },
  { value: 'login', label: 'Sign-ins' },
  { value: 'logout', label: 'Sign-outs' },
  { value: 'login_failure', label: 'Failed sign-ins' },
  { value: 'create', label: 'Creates' },
  { value: 'update', label: 'Updates' },
  { value: 'delete', label: 'Deletes' },
] as const;

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function actorLabel(row: AuditRow): string {
  if (row.actorDisplayName && row.actorEmail) {
    return `${row.actorDisplayName} (${row.actorEmail})`;
  }
  if (row.actorEmail) return row.actorEmail;
  if (row.actorDisplayName) return row.actorDisplayName;
  if (row.actor.startsWith('sso:')) return row.actor;
  if (row.actor === 'system' || row.actor === 'unknown') return row.actor;
  return row.actor.length > 12 ? `${row.actor.slice(0, 8)}…` : row.actor;
}

function actionLabel(action: string): string {
  switch (action) {
    case 'login':
      return 'Signed in';
    case 'logout':
      return 'Signed out';
    case 'login_failure':
      return 'Failed sign-in';
    case 'create':
      return 'Created';
    case 'update':
      return 'Updated';
    case 'delete':
      return 'Deleted';
    case 'import':
      return 'Imported';
    default:
      return action;
  }
}

function summarizeDetail(row: AuditRow): string {
  const d = row.detail;
  if (row.action === 'login' || row.action === 'logout' || row.action === 'login_failure') {
    const reason = typeof d.reason === 'string' ? d.reason : null;
    const ip = typeof d.ip === 'string' ? d.ip : null;
    const parts = [reason, ip].filter(Boolean);
    return parts.length ? parts.join(' · ') : '—';
  }
  const after = d.after;
  const before = d.before;
  if (after && typeof after === 'object' && after !== null) {
    const a = after as Record<string, unknown>;
    if (typeof a.name === 'string') return a.name;
    if (typeof a.email === 'string') return a.email;
    if (typeof a.displayName === 'string') return a.displayName;
  }
  if (before && typeof before === 'object' && before !== null) {
    const b = before as Record<string, unknown>;
    if (typeof b.name === 'string') return b.name;
    if (typeof b.email === 'string') return b.email;
  }
  return '—';
}

export function AuditingSettings({ rows }: { rows: AuditRow[] }) {
  const [actionFilter, setActionFilter] = useState('');

  const filtered = useMemo(() => {
    if (!actionFilter) return rows;
    return rows.filter((r) => r.action === actionFilter);
  }, [rows, actionFilter]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted">
          Administrative changes and sign-in activity for your organization. Newest events first.
        </p>
        <select
          className="rounded border border-edge bg-ink px-2 py-1.5 text-sm text-gray-100 focus:border-accent focus:outline-none"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
        >
          {ACTION_FILTERS.map((f) => (
            <option key={f.value || 'all'} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-edge text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="py-2 pr-3 font-medium">When</th>
              <th className="py-2 pr-3 font-medium">User</th>
              <th className="py-2 pr-3 font-medium">Action</th>
              <th className="py-2 pr-3 font-medium">Object</th>
              <th className="py-2 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={row.id} className="border-b border-edge/60">
                <td className="whitespace-nowrap py-2 pr-3 text-muted">{formatWhen(row.at)}</td>
                <td className="py-2 pr-3 text-gray-100">{actorLabel(row)}</td>
                <td className="py-2 pr-3 text-gray-100">{actionLabel(row.action)}</td>
                <td className="max-w-[14rem] truncate py-2 pr-3 font-mono text-xs text-muted" title={row.object}>
                  {row.object}
                </td>
                <td className="max-w-[16rem] truncate py-2 text-muted" title={summarizeDetail(row)}>
                  {summarizeDetail(row)}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-muted">
                  No audit events yet. Sign-ins and settings changes will appear here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
