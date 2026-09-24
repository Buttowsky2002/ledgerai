import { NextRequest, NextResponse } from 'next/server';
import { proxyApi } from '@/lib/api';

/** GET identity seat tiers (basic/premium per vendor). */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const { ok, status, data } = await proxyApi(
    `/v1/identities/${encodeURIComponent(params.id)}/seat-tiers`,
  );
  if (!ok) {
    return NextResponse.json(data ?? { error: 'seat tiers load failed' }, {
      status: status >= 400 ? status : 502,
    });
  }
  return NextResponse.json(data);
}

/** PATCH identity seat tiers — analyst/admin. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.text();
  const { ok, status, data } = await proxyApi(
    `/v1/identities/${encodeURIComponent(params.id)}/seat-tiers`,
    { method: 'PATCH', body },
  );
  if (!ok) {
    return NextResponse.json(data ?? { error: 'seat tiers update failed' }, {
      status: status >= 400 ? status : 502,
    });
  }
  return NextResponse.json(data);
}
