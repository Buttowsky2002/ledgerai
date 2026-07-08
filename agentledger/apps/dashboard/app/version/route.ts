import { NextResponse } from 'next/server';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

const API_URL = env('BADGERIQ_API_URL') ?? 'http://localhost:8094';

/** Build info (git sha, build time) — merges the API's stamp with the dashboard's. */
export async function GET() {
  const dashboard = {
    name: 'badgeriq-dashboard',
    version: process.env.BADGERIQ_BUILD_VERSION ?? 'dev',
    gitSha: process.env.BADGERIQ_BUILD_SHA ?? 'unknown',
    builtAt: process.env.BADGERIQ_BUILD_TIME ?? 'unknown',
  };
  try {
    const res = await fetch(`${API_URL}/version`, { cache: 'no-store' });
    const api = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return NextResponse.json({ ...dashboard, api });
  } catch {
    return NextResponse.json({ ...dashboard, api: null });
  }
}
