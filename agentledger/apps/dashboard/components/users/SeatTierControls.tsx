'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  defaultUnitUsd,
  PLAN_TIER_BUTTON_LABELS,
  vendorLabel,
  AI_VENDORS,
} from '@/lib/fixed-cost-catalog';
import type { FixedCostVendor } from '@/types/fixed-costs';

type SeatLicense = 'none' | 'basic' | 'premium';

type Props = {
  userId: string;
  vendors: string[];
  /** Stored tiers (basic/premium only — absent vendor means none). */
  initialTiers?: Record<string, 'basic' | 'premium'>;
};

function licenseLabel(vendor: string): string {
  const entry = AI_VENDORS.find((v) => v.id === vendor);
  if (vendor === 'openai') {
    return 'ChatGPT';
  }
  if (entry?.product) {
    return entry.product;
  }
  return vendorLabel(vendor);
}

function unitHint(vendor: string, tier: 'basic' | 'premium'): string | null {
  const v = vendor as FixedCostVendor;
  const plan = tier === 'premium' ? 'premium' : 'team';
  const unit = defaultUnitUsd(v, plan);
  if (unit == null) {
    return null;
  }
  return `$${unit}/seat/mo`;
}

export function SeatTierControls({ userId, vendors, initialTiers = {} }: Props) {
  const router = useRouter();
  const [tiers, setTiers] = useState<Record<string, SeatLicense>>(() => {
    const next: Record<string, SeatLicense> = {};
    for (const vendor of vendors) {
      next[vendor] = initialTiers[vendor] ?? 'none';
    }
    return next;
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (vendors.length === 0) {
    return (
      <p className="text-sm text-muted">
        No license vendors available. ChatGPT and Claude appear once Fixed Overhead or an expense
        import is configured.
      </p>
    );
  }

  const save = (vendor: string, license: SeatLicense) => {
    const next = { ...tiers, [vendor]: license };
    setTiers(next);
    setError(null);
    startTransition(async () => {
      const payload = {
        tiers: vendors.map((v) => ({
          vendor: v,
          tier: next[v] ?? 'none',
        })),
      };
      const res = await fetch(`/api/identities/${encodeURIComponent(userId)}/seat-tiers`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? 'Failed to update seat license');
        const rollback: Record<string, SeatLicense> = {};
        for (const v of vendors) {
          rollback[v] = initialTiers[v] ?? 'none';
        }
        setTiers(rollback);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Basic / Premium assign which Fixed Overhead seat pool this person consumes (matching FO unit
        prices). None means no seat dollars for that product.
      </p>
      <div className="flex flex-col gap-2">
        {vendors.map((vendor) => {
          const license = tiers[vendor] ?? 'none';
          return (
            <div
              key={vendor}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-edge/70 px-3 py-2"
            >
              <div className="min-w-0">
                <span className="text-sm text-white">{licenseLabel(vendor)}</span>
                <span className="ml-2 text-xs text-muted">{vendorLabel(vendor)}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {(['none', 'basic', 'premium'] as const).map((opt) => {
                  const hint = opt === 'none' ? null : unitHint(vendor, opt);
                  return (
                    <button
                      key={opt}
                      type="button"
                      disabled={pending}
                      onClick={() => save(vendor, opt)}
                      className={`rounded px-2.5 py-1 text-xs ${
                        license === opt
                          ? 'bg-accent/20 text-white ring-1 ring-inset ring-accent/40'
                          : 'border border-edge text-muted hover:bg-white/5'
                      } disabled:opacity-50`}
                      title={hint ?? undefined}
                    >
                      {opt === 'none'
                        ? 'None'
                        : `${PLAN_TIER_BUTTON_LABELS[opt === 'basic' ? 'team' : 'premium']}${
                            hint ? ` (${hint})` : ''
                          }`}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {error && <p className="text-sm text-warn">{error}</p>}
    </div>
  );
}
