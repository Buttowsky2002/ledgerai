import { NextResponse } from 'next/server';
import { proxyApi } from '@/lib/api';

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const body = await req.text();
  const { ok, status, data } = await proxyApi(
    `/v1/github-copilot/connections/${params.id}/roi-assumptions`,
    { method: 'PATCH', body },
  );
  if (!ok) {
    return NextResponse.json(data ?? { error: 'update failed' }, { status: status >= 400 ? status : 502 });
  }
  return NextResponse.json(data);
}
