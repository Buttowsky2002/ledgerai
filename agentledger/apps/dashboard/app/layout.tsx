import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import { ReactNode } from 'react';
import { Sidebar } from '../components/Sidebar';
import { env } from '../lib/env';
import './globals.css';

// IBM Plex — institutional, characterful, and the mono is purpose-built for the
// dense tabular figures a finance/FinOps surface lives on. Exposed as CSS vars so
// Tailwind's font-sans / font-mono resolve to them app-wide.
const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'LedgerAI',
  description: 'AI FinOps control plane — spend, allocation, risk, and unit economics.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // Show a banner when running on seeded demo data (LEDGERAI_DEMO_MODE=true).
  const demoMode = env('LEDGERAI_DEMO_MODE') === 'true';
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
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
