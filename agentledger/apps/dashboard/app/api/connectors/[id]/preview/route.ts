import { NextRequest, NextResponse } from 'next/server';
import { proxyApi } from '../../../../../lib/api';

type Params = { params: { id: string } };

export async function POST(req: NextRequest, { params }: Params) {
  const body = await req.text();
  const { ok, status, data } = await proxyApi(`/v1/connectors/${params.id}/preview`, {
    method: 'POST',
    body: body || '{}',
  });
  if (!ok) return NextResponse.json(data ?? { error: 'preview failed' }, { status: status >= 400 ? status : 502 });
  return NextResponse.json(data);
}
