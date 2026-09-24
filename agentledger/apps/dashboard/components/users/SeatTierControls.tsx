'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { vendorLabel } from '@/lib/fixed-cost-catalog';

type SeatClass = 'basic' | 'premium';

type Props = {
  userId: string;
  vendors: string[];
  initialTiers?: Record<string, SeatClass>;
};

export function SeatTierControls({ userId, vendors, initialTiers = {} }: Props) {
  const router = useRouter();
  const [tiers, setTiers] = useState<Record<string, SeatClass>>(() => ({ ...initialTiers }));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (vendors.length === 0) {
    return (
      <p className="text-sm text-muted">
        No platform presence in this range — seat tier tags appear once a vendor column exists.
      </p>
    );
  }

  const save = (vendor: string, tier: SeatClass) => {
    const next = { ...tiers, [vendor]: tier };
    if (tier === 'basic') {
      delete next[vendor];
    }
    setTiers(next);
    setError(null);
    startTransition(async () => {
      const payload = {
        tiers: vendors.map((v) => ({
          vendor: v,
          tier: (next[v] ?? 'basic') as SeatClass,
        })),
      };
      const res = await fetch(`/api/identities/${encodeURIComponent(userId)}/seat-tiers`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? 'Failed to update seat tier');
        setTiers({ ...initialTiers });
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Premium marks who consumes Fixed Overhead premium seats — it does not add a second charge.
      </p>
      <div className="flex flex-col gap-2">
        {vendors.map((vendor) => {
          const tier = tiers[vendor] ?? 'basic';
          return (
            <div
              key={vendor}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-edge/70 px-3 py-2"
            >
              <span className="text-sm text-white">{vendorLabel(vendor)}</span>
              <div className="flex gap-1">
                {(['basic', 'premium'] as const).map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    disabled={pending}
                    onClick={() => save(vendor, opt)}
                    className={`rounded px-2.5 py-1 text-xs capitalize ${
                      tier === opt
                        ? 'bg-accent/20 text-white ring-1 ring-inset ring-accent/40'
                        : 'border border-edge text-muted hover:bg-white/5'
                    } disabled:opacity-50`}
                  >
                    {opt === 'basic' ? 'Basic' : 'Premium'}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {error && <p className="text-sm text-warn">{error}</p>}
    </div>
  );
}
