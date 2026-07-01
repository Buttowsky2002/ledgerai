import { Suspense } from 'react';
import { ConnectorsClient } from '../../../components/connectors/ConnectorsClient';

export const dynamic = 'force-dynamic';

export default function ConnectorsPage() {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-muted">Loading data sources…</p>}>
      <ConnectorsClient />
    </Suspense>
  );
}
