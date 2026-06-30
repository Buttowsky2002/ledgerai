import { NextRequest, NextResponse } from 'next/server';
import { proxyApi } from '@/lib/api';

export async function GET(req: NextRequest) {
  const qs = req.nextUrl.searchParams.toString();
  const path = qs ? `/v1/github-copilot/overview?${qs}` : '/v1/github-copilot/overview';
  const { ok, status, data } = await proxyApi(path);
  if (!ok) {
    return NextResponse.json(data ?? { error: 'overview failed' }, { status: status >= 400 ? status : 502 });
  }
  return NextResponse.json(data);
}
