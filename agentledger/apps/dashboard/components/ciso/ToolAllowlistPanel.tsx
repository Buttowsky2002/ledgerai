'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useMemo, useState } from 'react';

export type AllowlistRow = {
  allowId: string;
  agentId: string;
  toolName: string;
  mcpServer: string | null;
  createdAt?: string;
};

export type AgentOption = {
  agentId: string;
  name: string;
};

const FIELD =
  'rounded border border-edge bg-ink px-2 py-1.5 text-sm text-gray-100 focus:border-accent focus:outline-none';

export function ToolAllowlistPanel({
  entries,
  agents,
  canManage,
}: {
  entries: AllowlistRow[];
  agents: AgentOption[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [agentId, setAgentId] = useState(agents[0]?.agentId ?? '');
  const [toolName, setToolName] = useState('');
  const [mcpServer, setMcpServer] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const agentNameById = useMemo(
    () => Object.fromEntries(agents.map((a) => [a.agentId, a.name])),
    [agents],
  );

  async function addEntry(e: FormEvent) {
    e.preventDefault();
    if (!canManage || !agentId || !toolName.trim()) {return;}
    setBusy(true);
    setErr(null);
    const res = await fetch('/api/agent-tool-allowlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId,
        toolName: toolName.trim(),
        ...(mcpServer.trim() ? { mcpServer: mcpServer.trim() } : {}),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
      setErr(body?.message ?? body?.error ?? `Create failed (${res.status})`);
      return;
    }
    setToolName('');
    setMcpServer('');
    router.refresh();
  }

  async function removeEntry(allowId: string) {
    if (!canManage) {return;}
    setBusyId(allowId);
    setErr(null);
    const res = await fetch(`/api/agent-tool-allowlist/${encodeURIComponent(allowId)}`, {
      method: 'DELETE',
    });
    setBusyId(null);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
      setErr(body?.message ?? body?.error ?? `Delete failed (${res.status})`);
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        Deny-by-default: only tools on this list are permitted for an agent. Unauthorized use raises a
        risk event and increases that agent&apos;s risk exposure.
      </p>

      {canManage && (
        <form onSubmit={addEntry} className="flex flex-wrap items-end gap-2">
          <label className="space-y-1">
            <span className="block text-xs text-muted">Agent</span>
            <select
              className={FIELD}
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              required
              disabled={agents.length === 0}
            >
              {agents.length === 0 && <option value="">No agents</option>}
              {agents.map((a) => (
                <option key={a.agentId} value={a.agentId}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted">Tool name</span>
            <input
              className={FIELD}
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
              placeholder="e.g. github.create_pr"
              required
              maxLength={200}
            />
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted">MCP server (optional)</span>
            <input
              className={FIELD}
              value={mcpServer}
              onChange={(e) => setMcpServer(e.target.value)}
              placeholder="e.g. github"
              maxLength={200}
            />
          </label>
          <button
            type="submit"
            disabled={busy || agents.length === 0}
            className="rounded bg-accent/20 px-3 py-1.5 text-sm text-white ring-1 ring-inset ring-accent/30 hover:bg-accent/30 disabled:opacity-50"
          >
            {busy ? 'Adding…' : 'Allow tool'}
          </button>
        </form>
      )}

      {!canManage && (
        <p className="text-xs text-muted">
          Only users with the <span className="text-gray-100">admin</span> role can change the
          allowlist.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-edge text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="py-2 pr-3 font-medium">Agent</th>
              <th className="py-2 pr-3 font-medium">Tool</th>
              <th className="py-2 pr-3 font-medium">MCP server</th>
              {canManage && <th className="py-2 font-medium">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {entries.map((row) => (
              <tr key={row.allowId} className="border-b border-edge/60">
                <td className="py-2 pr-3 text-gray-100">
                  {agentNameById[row.agentId] ?? row.agentId.slice(0, 8) + '…'}
                </td>
                <td className="py-2 pr-3 font-mono text-xs text-gray-100">{row.toolName}</td>
                <td className="py-2 pr-3 text-muted">{row.mcpServer ?? '—'}</td>
                {canManage && (
                  <td className="py-2">
                    <button
                      type="button"
                      disabled={busyId === row.allowId}
                      onClick={() => void removeEntry(row.allowId)}
                      className="text-xs text-neg hover:underline disabled:opacity-50"
                    >
                      {busyId === row.allowId ? 'Removing…' : 'Remove'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={canManage ? 4 : 3} className="py-4 text-muted">
                  No allowlist entries. Agents start with an empty (deny-all) list.
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
