'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/', label: 'Executive spend' },
  { href: '/allocation', label: 'Allocation' },
  { href: '/model-mix', label: 'Model mix' },
  { href: '/budgets', label: 'Budgets' },
  { href: '/roi-templates', label: 'ROI templates' },
  { href: '/cost-per-outcome', label: 'Cost per outcome' },
  { href: '/cfo', label: 'CFO view' },
  { href: '/ciso', label: 'CISO view' },
  { href: '/risk', label: 'Risk events' },
  { href: '/settings', label: 'Settings' },
];

export function Sidebar() {
  const path = usePathname();
  return (
    <aside className="w-60 shrink-0 border-r border-edge bg-panel p-4">
      <div className="mb-8 px-2 text-lg font-semibold">
        Agent<span className="text-accent">Ledger</span>
      </div>
      <nav className="space-y-1">
        {NAV.map((n) => {
          const active = n.href === '/' ? path === '/' : path.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              className={`block rounded px-3 py-2 text-sm ${
                active ? 'bg-accent/20 text-white' : 'text-muted hover:bg-white/5'
              }`}
            >
              {n.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
