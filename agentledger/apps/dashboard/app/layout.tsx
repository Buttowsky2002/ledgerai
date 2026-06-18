import type { Metadata } from 'next';
import { ReactNode } from 'react';
import { Sidebar } from '../components/Sidebar';
import './globals.css';

export const metadata: Metadata = {
  title: 'AgentLedger',
  description: 'AI FinOps control plane — spend, allocation, risk, and unit economics.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="flex-1 p-8">
            <div className="mx-auto max-w-[1400px]">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
