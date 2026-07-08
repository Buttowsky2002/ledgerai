import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Liveness (Cloud Run contract): 200 while the dashboard process serves HTTP. */
export function GET() {
  return NextResponse.json({ status: 'ok' });
}
