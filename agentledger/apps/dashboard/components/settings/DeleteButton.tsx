'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function DeleteButton({ url, label = 'Delete' }: { url: string; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch(url, { method: 'DELETE' });
        setBusy(false);
        router.refresh();
      }}
      className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
    >
      {busy ? '…' : label}
    </button>
  );
}
