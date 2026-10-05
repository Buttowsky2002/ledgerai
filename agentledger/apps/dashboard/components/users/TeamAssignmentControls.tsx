'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

export type TeamOption = {
  teamId: string;
  name: string;
};

type Props = {
  /** Identity UUID or email — same resolver as seat-tiers. */
  userId: string;
  teams: TeamOption[];
  initialTeamId?: string | null;
  /** Compact select for table cells. */
  compact?: boolean;
};

export function TeamAssignmentControls({
  userId,
  teams,
  initialTeamId = null,
  compact = false,
}: Props) {
  const router = useRouter();
  const [teamId, setTeamId] = useState<string>(initialTeamId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = (next: string) => {
    const previous = teamId;
    setTeamId(next);
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/identities/${encodeURIComponent(userId)}/team`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId: next === '' ? null : next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? 'Failed to update team');
        setTeamId(previous);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className={compact ? 'min-w-[8rem]' : 'space-y-2'}>
      <select
        value={teamId}
        disabled={pending}
        onChange={(e) => save(e.target.value)}
        aria-label="Team"
        className={
          compact
            ? 'w-full max-w-[10rem] truncate rounded border border-edge bg-transparent px-1.5 py-1 text-xs text-white disabled:opacity-50'
            : 'w-full max-w-xs rounded border border-edge bg-transparent px-2 py-1.5 text-sm text-white disabled:opacity-50'
        }
      >
        <option value="">Unassigned</option>
        {teams.map((t) => (
          <option key={t.teamId} value={t.teamId}>
            {t.name}
          </option>
        ))}
      </select>
      {error && <p className={`text-warn ${compact ? 'text-[10px]' : 'text-sm'}`}>{error}</p>}
    </div>
  );
}
