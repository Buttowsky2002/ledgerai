import { NextResponse } from 'next/server';
import { proxyApi } from '@/lib/api';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const { ok, status, data } = await proxyApi(`/v1/github-copilot/connections/${params.id}/sync`, {
    method: 'POST',
  });
  if (!ok) {
    return NextResponse.json(data ?? { error: 'sync failed' }, { status: status >= 400 ? status : 502 });
  }
  return NextResponse.json(data);
}
