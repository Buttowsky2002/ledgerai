import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import { ReactNode } from 'react';
import { AppShell } from '../components/AppShell';
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
  title: 'BadgerIQ',
  description: 'AI FinOps control plane — spend, allocation, risk, and unit economics.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // Show a banner when running on seeded demo data (BADGERIQ_DEMO_MODE=true).
  const demoMode = env('BADGERIQ_DEMO_MODE') === 'true';
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <AppShell demoMode={demoMode}>{children}</AppShell>
      </body>
    </html>
  );
}
