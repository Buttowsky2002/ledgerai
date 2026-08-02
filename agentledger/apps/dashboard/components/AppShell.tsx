'use client';

import { usePathname } from 'next/navigation';
import { ReactNode } from 'react';
import { Sidebar } from './Sidebar';

/**
 * App chrome (sidebar + main). Login is a bare page — no nav chrome — so SSO
 * screens stay clean and a missing stylesheet can't dump huge unstyled chevrons.
 */
export function AppShell({ children, demoMode }: { children: ReactNode; demoMode: boolean }) {
  const path = usePathname();
  if (path === '/login') {
    return <div className="min-h-screen">{children}</div>;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 p-8">
        <div className="mx-auto max-w-[1400px]">
          {demoMode && (
            <div
              role="status"
              className="mb-4 rounded border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-300"
            >
              <strong>Demo mode</strong> — seeded sample data for evaluation, not a live deployment.
            </div>
          )}
          {children}
        </div>
      </main>
    </div>
  );
}
