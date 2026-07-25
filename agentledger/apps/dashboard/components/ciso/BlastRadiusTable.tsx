'use client';

export type BlastRadiusRow = {
  agentId: string;
  agentName: string;
  approvalStatus: string;
  decommissionedAt: string | null;
  activeCredentials: number;
  totalCredentials: number;
  allowlistedTools: number;
};

export function BlastRadiusTable({ rows }: { rows: BlastRadiusRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted">No agents registered yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-edge text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="py-2 pr-3 font-medium">Agent</th>
            <th className="py-2 pr-3 font-medium">Approval</th>
            <th className="py-2 pr-3 font-medium text-right">Active creds</th>
            <th className="py-2 pr-3 font-medium text-right">Total creds</th>
            <th className="py-2 font-medium text-right">Allowlisted tools</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.agentId} className="border-b border-edge/60">
              <td className="py-2 pr-3 text-gray-100">
                <div>{r.agentName}</div>
                <div className="font-mono text-xs text-muted">{r.agentId.slice(0, 8)}…</div>
                {r.decommissionedAt && (
                  <div className="text-xs text-neg">decommissioned</div>
                )}
              </td>
              <td className="py-2 pr-3 capitalize text-muted">{r.approvalStatus}</td>
              <td className="py-2 pr-3 text-right text-gray-100">{r.activeCredentials}</td>
              <td className="py-2 pr-3 text-right text-muted">{r.totalCredentials}</td>
              <td className="py-2 text-right text-gray-100">{r.allowlistedTools}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
