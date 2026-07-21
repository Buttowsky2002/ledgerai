import { NextRequest, NextResponse } from 'next/server';
import { proxyApi } from '@/lib/api';

/** PATCH identity (admin) — Settings → Permissions changes apiRole. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.text();
  const { ok, status, data } = await proxyApi(`/v1/identities/${encodeURIComponent(params.id)}`, {
    method: 'PATCH',
    body,
  });
  if (!ok) {
    return NextResponse.json(data ?? { error: 'identity update failed' }, {
      status: status >= 400 ? status : 502,
    });
  }
  return NextResponse.json(data);
}
