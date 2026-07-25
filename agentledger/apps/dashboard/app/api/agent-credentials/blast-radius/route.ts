import { NextResponse } from 'next/server';
import { proxyApi } from '@/lib/api';

/** GET NHI blast-radius per agent (CISO governance). */
export async function GET() {
  const { ok, status, data } = await proxyApi('/v1/agent-credentials/blast-radius');
  if (!ok) {
    return NextResponse.json(data ?? { error: 'blast-radius failed' }, {
      status: status >= 400 ? status : 502,
    });
  }
  return NextResponse.json(data);
}
