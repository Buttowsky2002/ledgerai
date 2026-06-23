import type { Metadata } from 'next';
import { ReactNode } from 'react';
import { Sidebar } from '../components/Sidebar';
import { env } from '../lib/env';
import './globals.css';

export const metadata: Metadata = {
  title: 'LedgerAI',
  description: 'AI FinOps control plane — spend, allocation, risk, and unit economics.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // Show a banner when running on seeded demo data (LEDGERAI_DEMO_MODE=true).
  const demoMode = env('LEDGERAI_DEMO_MODE') === 'true';
  return (
    <html lang="en">
      <body>
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
      </body>
    </html>
  );
}
