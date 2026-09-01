import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { env } from '@/lib/env';
import { refreshUrl } from '@/lib/auth';

function cookieOptsFromRaw(
  raw: string,
): { name: string; value: string; options: Record<string, unknown> } | null {
  const parts = raw.split(';').map((s) => s.trim());
  const pair = parts[0];
  const eq = pair.indexOf('=');
  if (eq <= 0) {
    return null;
  }
  const name = pair.slice(0, eq);
  const value = pair.slice(eq + 1);
  const options: Record<string, unknown> = { httpOnly: true, path: '/' };
  for (const attr of parts.slice(1)) {
    const lower = attr.toLowerCase();
    if (lower.startsWith('max-age=')) {
      options.maxAge = Number.parseInt(lower.slice('max-age='.length), 10);
    } else if (lower === 'secure') {
      options.secure = true;
    } else if (lower.startsWith('samesite=')) {
      const site = attr.split('=')[1]?.toLowerCase();
      if (site === 'lax' || site === 'none' || site === 'strict') {
        options.sameSite = site;
      }
    }
  }
  return { name, value, options };
}

function applyApiSetCookies(res: NextResponse, apiRes: Response): void {
  const setCookies =
    typeof apiRes.headers.getSetCookie === 'function' ? apiRes.headers.getSetCookie() : [];
  for (const raw of setCookies) {
    const parsed = cookieOptsFromRaw(raw);
    if (!parsed) {
      continue;
    }
    res.cookies.set(
      parsed.name,
      parsed.value,
      parsed.options as Parameters<typeof res.cookies.set>[2],
    );
  }
}

function clearSessionCookies(res: NextResponse): void {
  const secure =
    process.env.NODE_ENV === 'production' || env('BADGERIQ_COOKIE_SAMESITE') === 'none';
  for (const name of ['al_access', 'al_refresh', 'al_oidc_tx'] as const) {
    res.cookies.set(name, '', {
      httpOnly: true,
      path: '/',
      maxAge: 0,
      secure,
      sameSite: name === 'al_oidc_tx' ? 'lax' : 'strict',
    });
  }
}

async function refreshSession(): Promise<Response> {
  const jar = cookies();
  const refresh = jar.get('al_refresh')?.value;
  if (!refresh) {
    return new Response(null, { status: 401 });
  }
  const access = jar.get('al_access')?.value;
  const cookieHeader = [access ? `al_access=${access}` : '', `al_refresh=${refresh}`]
    .filter(Boolean)
    .join('; ');
  return fetch(refreshUrl(), {
    method: 'POST',
    headers: { Cookie: cookieHeader },
    redirect: 'manual',
  });
}

/** GET — middleware redirect target after an expired access token. */
export async function GET(req: NextRequest) {
  const apiRes = await refreshSession();
  if (!apiRes.ok) {
    const res = NextResponse.redirect(new URL('/login', req.url));
    clearSessionCookies(res);
    return res;
  }
  const nextPath = req.nextUrl.searchParams.get('next') || '/';
  const res = NextResponse.redirect(new URL(nextPath, req.url));
  applyApiSetCookies(res, apiRes);
  return res;
}

/** POST — proactive refresh from the dashboard (SessionRefresh). */
export async function POST() {
  const apiRes = await refreshSession();
  if (!apiRes.ok) {
    const res = new NextResponse(null, { status: 401 });
    clearSessionCookies(res);
    return res;
  }
  const res = NextResponse.json({ ok: true });
  applyApiSetCookies(res, apiRes);
  return res;
}
