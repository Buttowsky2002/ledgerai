import { NextRequest, NextResponse } from 'next/server';
import { proxyApi } from '@/lib/api';

/** PATCH identity team assignment — analyst/admin. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.text();
  const { ok, status, data } = await proxyApi(
    `/v1/identities/${encodeURIComponent(params.id)}/team`,
    { method: 'PATCH', body },
  );
  if (!ok) {
    return NextResponse.json(data ?? { error: 'team update failed' }, {
      status: status >= 400 ? status : 502,
    });
  }
  return NextResponse.json(data);
}
