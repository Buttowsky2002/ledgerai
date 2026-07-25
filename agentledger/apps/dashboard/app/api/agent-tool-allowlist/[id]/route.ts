import { NextResponse } from 'next/server';
import { proxyApi } from '@/lib/api';

/** DELETE allowlist entry (admin) — tombstones CH projection via API. */
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const { ok, status, data } = await proxyApi(
    `/v1/agent-tool-allowlist/${encodeURIComponent(params.id)}`,
    { method: 'DELETE' },
  );
  if (!ok) {
    return NextResponse.json(data ?? { error: 'delete failed' }, {
      status: status >= 400 ? status : 502,
    });
  }
  return NextResponse.json(data ?? { ok: true });
}
