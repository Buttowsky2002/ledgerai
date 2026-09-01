'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type Me = {
  userId: string;
  tenantId: string;
  role: string;
  displayName: string | null;
  email: string | null;
};

const ROLE_BADGE: Record<string, string> = {
  admin: 'bg-accent/20 text-accent',
  analyst: 'bg-warn/20 text-warn',
  viewer: 'bg-muted/20 text-muted',
};

export function UserProfile() {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Me | null) => {
        if (data?.userId) {setMe(data);}
      })
      .catch(() => null);
  }, []);

  if (!me) {return null;}

  const label = me.displayName ?? me.email ?? 'You';
  const initials = label
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <Link
      href="/settings?tab=account"
      className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-white/5"
      title="Account settings"
    >
      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/20 text-xs font-semibold text-accent">
        {initials || '?'}
      </div>
      <span className="hidden text-white sm:block truncate max-w-[8rem]">{label}</span>
      <span
        className={`hidden rounded px-1.5 py-0.5 text-xs font-medium capitalize sm:block ${
          ROLE_BADGE[me.role] ?? 'bg-muted/20 text-muted'
        }`}
      >
        {me.role}
      </span>
    </Link>
  );
}
