import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { env } from '@/lib/env';
import { logoutUrl } from '@/lib/auth';

/**
 * Clear session cookies for the dashboard host, then best-effort POST the API
 * logout (same public host in prod via ALB /auth/*). Browser Set-Cookie from this
 * response is what middleware sees; the API call covers shared-host cookie clears
 * when Next and Nest share the public origin.
 */
export async function POST() {
  const jar = cookies();
  const access = jar.get('al_access')?.value;
  const refresh = jar.get('al_refresh')?.value;

  // Forward cookies to the API so Nest clearCookie matches how they were set.
  try {
    const headers: Record<string, string> = {};
    if (access || refresh) {
      headers.Cookie = [
        access ? `al_access=${access}` : '',
        refresh ? `al_refresh=${refresh}` : '',
      ]
        .filter(Boolean)
        .join('; ');
    }
    await fetch(logoutUrl(), { method: 'POST', headers, redirect: 'manual' });
  } catch {
    // Cookie clear below still runs — local stacks may not reach the API host.
  }

  const secure = process.env.NODE_ENV === 'production' || env('BADGERIQ_COOKIE_SAMESITE') === 'none';
  const res = new NextResponse(null, { status: 204 });
  for (const name of ['al_access', 'al_refresh', 'al_oidc_tx'] as const) {
    res.cookies.set(name, '', {
      httpOnly: true,
      path: '/',
      maxAge: 0,
      secure,
      sameSite: name === 'al_oidc_tx' ? 'lax' : 'strict',
    });
  }
  return res;
}
