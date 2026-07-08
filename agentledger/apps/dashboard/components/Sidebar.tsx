'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useMemo, useState } from 'react';

type NavItem = { href: string; label: string };
type NavGroup = { label: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Dashboard',
    items: [{ href: '/', label: 'Overview' }],
  },
  {
    label: 'Spend Management',
    items: [
      { href: '/allocation', label: 'Allocation' },
      { href: '/users', label: 'Users' },
      { href: '/model-mix', label: 'Model mix' },
      { href: '/budgets', label: 'Budgets' },
      { href: '/cost-per-outcome', label: 'Cost per outcome' },
    ],
  },
  {
    label: 'Business Value',
    items: [
      { href: '/roi-templates', label: 'ROI templates' },
      { href: '/cfo', label: 'CFO view' },
    ],
  },
  {
    label: 'Security & Risk',
    items: [
      { href: '/ciso', label: 'CISO view' },
      { href: '/risk', label: 'Risk events' },
      { href: '/attribution', label: 'Attribution audit' },
    ],
  },
  {
    label: 'Admin',
    items: [
      { href: '/settings/connectors', label: 'Data sources' },
      { href: '/admin/billing', label: 'Billing import' },
      { href: '/admin/fixed-overhead', label: 'Fixed overhead' },
      { href: '/settings', label: 'Settings' },
    ],
  },
];

const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function matchesHref(path: string, href: string): boolean {
  if (href === '/') return path === '/';
  if (path === href) return true;
  return path.startsWith(`${href}/`);
}

function isNavActive(path: string, href: string): boolean {
  const matches = ALL_NAV_ITEMS.filter((item) => matchesHref(path, item.href));
  if (matches.length === 0) return false;
  const bestMatch = matches.reduce((best, item) => (item.href.length > best.href.length ? item : best));
  return bestMatch.href === href;
}

function findActiveGroupLabel(path: string): string | null {
  for (const group of NAV_GROUPS) {
    if (group.items.some((item) => isNavActive(path, item.href))) {
      return group.label;
    }
  }
  return null;
}

function navHref(itemHref: string, from: string | null, to: string | null): string {
  if (from && to) {
    return `${itemHref}?from=${from}&to=${to}`;
  }
  return itemHref;
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="none"
      className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform duration-200 ${
        expanded ? 'rotate-90' : ''
      }`}
    >
      <path
        d="M6 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SidebarNav() {
  const path = usePathname();
  const searchParams = useSearchParams();
  const activeGroupLabel = useMemo(() => findActiveGroupLabel(path), [path]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const fromParam = searchParams.get('from')?.slice(0, 10) ?? null;
  const toParam = searchParams.get('to')?.slice(0, 10) ?? null;
  const rangeFrom =
    fromParam && toParam && ISO_DATE.test(fromParam) && ISO_DATE.test(toParam) && fromParam <= toParam
      ? fromParam
      : null;
  const rangeTo = rangeFrom ? toParam : null;

  const isGroupExpanded = useCallback(
    (label: string) => {
      if (label === activeGroupLabel) return true;
      return expanded[label] ?? false;
    },
    [activeGroupLabel, expanded],
  );

  const toggleGroup = (label: string) => {
    if (label === activeGroupLabel) return;
    setExpanded((prev) => ({ ...prev, [label]: !isGroupExpanded(label) }));
  };

  return (
    <nav className="space-y-1">
      {NAV_GROUPS.map((group) => {
        const open = isGroupExpanded(group.label);
        const panelId = `nav-group-${group.label.toLowerCase().replace(/\s+/g, '-')}`;

        return (
          <div key={group.label}>
            <button
              type="button"
              onClick={() => toggleGroup(group.label)}
              aria-expanded={open}
              aria-controls={panelId}
              className="flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm font-medium text-gray-300 hover:bg-white/5"
            >
              <span>{group.label}</span>
              <Chevron expanded={open} />
            </button>
            {open && (
              <div id={panelId} className="mt-0.5 space-y-0.5 pb-1">
                {group.items.map((item) => {
                  const active = isNavActive(path, item.href);
                  return (
                    <Link
                      key={item.href}
                      href={navHref(item.href, rangeFrom, rangeTo)}
                      className={`block rounded py-2 text-sm ${
                        active
                          ? 'border-l-2 border-accent bg-accent/10 pr-3 pl-[10px] text-white ring-1 ring-inset ring-accent/30'
                          : 'pl-7 pr-3 text-muted hover:bg-white/[0.04] hover:text-gray-200'
                      }`}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

export function Sidebar() {
  return (
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 self-start flex-col overflow-y-auto border-r border-edge bg-panel p-4">
      <div className="mb-8 px-2 text-lg font-semibold tracking-tight">
        Badger<span className="text-accent">IQ</span>
      </div>
      <Suspense fallback={<nav className="space-y-1 text-sm text-muted">Loading…</nav>}>
        <SidebarNav />
      </Suspense>
    </aside>
  );
}
