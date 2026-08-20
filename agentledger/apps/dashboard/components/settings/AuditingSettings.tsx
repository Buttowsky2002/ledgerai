'use client';

import { useCallback, useEffect, useState } from 'react';
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
  { value: 'import', label: 'Imports' },
] as const;

const PAGE_SIZE = 50;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 86_400_000);
  return { from: isoDate(from), to: isoDate(to) };
}

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

type AuditListResponse = {
  rows: AuditRow[];
  total: number;
  limit: number;
  offset: number;
};

export function AuditingSettings() {
  const defaults = defaultRange();
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [actionFilter, setActionFilter] = useState('');
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  const fetchPage = useCallback(
    async (offset: number, append: boolean) => {
      const qs = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
        from,
        to,
      });
      if (actionFilter) qs.set('action', actionFilter);
      const res = await fetch(`/api/audit?${qs.toString()}`, { cache: 'no-store' });
      if (!res.ok) {
        setError(true);
        return;
      }
      const data = (await res.json()) as AuditListResponse;
      setError(false);
      setTotal(data.total ?? 0);
      setRows((prev) => (append ? [...prev, ...(data.rows ?? [])] : (data.rows ?? [])));
    },
    [from, to, actionFilter],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchPage(0, false)
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  const hasMore = rows.length < total;

  const onLoadMore = async () => {
    setLoadingMore(true);
    try {
      await fetchPage(rows.length, true);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-xs text-muted">
          Administrative changes and sign-in activity for your organization. Newest events first.
          {total > 0 && (
            <span className="ml-2 text-gray-300">
              Showing {rows.length} of {total}
            </span>
          )}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted">
            From
            <input
              type="date"
              className="mt-1 block rounded border border-edge bg-ink px-2 py-1.5 text-sm text-gray-100"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="text-xs text-muted">
            To
            <input
              type="date"
              className="mt-1 block rounded border border-edge bg-ink px-2 py-1.5 text-sm text-gray-100"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
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
      </div>

      {error && (
        <p className="text-sm text-neg">Could not load audit events. Confirm you have the admin role.</p>
      )}

      {loading ? (
        <div className="animate-pulse space-y-2 py-4">
          <div className="h-8 rounded bg-edge" />
          <div className="h-8 rounded bg-edge" />
          <div className="h-8 rounded bg-edge" />
        </div>
      ) : (
        <>
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
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-edge/60">
                    <td className="whitespace-nowrap py-2 pr-3 text-muted">{formatWhen(row.at)}</td>
                    <td className="py-2 pr-3 text-gray-100">{actorLabel(row)}</td>
                    <td className="py-2 pr-3 text-gray-100">{actionLabel(row.action)}</td>
                    <td
                      className="max-w-[14rem] truncate py-2 pr-3 font-mono text-xs text-muted"
                      title={row.object}
                    >
                      {row.object}
                    </td>
                    <td className="max-w-[16rem] truncate py-2 text-muted" title={summarizeDetail(row)}>
                      {summarizeDetail(row)}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && !error && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-muted">
                      No audit events in this range. Widen the dates or clear the action filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <button
              type="button"
              className="rounded border border-edge px-3 py-1.5 text-sm text-gray-200 hover:bg-white/5 disabled:opacity-50"
              disabled={loadingMore}
              onClick={() => void onLoadMore()}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
