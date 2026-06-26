import { NextResponse } from 'next/server';
import { proxyApi } from '../../../../../lib/api';

type Params = { params: { id: string } };

export async function POST(req: Request, { params }: Params) {
  const body = await req.text();
  const { ok, status, data } = await proxyApi(`/v1/connectors/${params.id}/sync`, {
    method: 'POST',
    body: body || '{}',
  });
  if (!ok) return NextResponse.json(data ?? { error: 'sync failed' }, { status: status >= 400 ? status : 502 });
  return NextResponse.json(data);
}
