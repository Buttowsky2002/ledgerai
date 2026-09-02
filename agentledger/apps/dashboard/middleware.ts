import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { env } from './lib/env';
import { isStructurallyValidJwt } from './lib/jwt-structure';

/**
 * Soft gate: require a structurally valid `al_access` JWT cookie before
 * rendering app pages. Signature verification stays on the control-plane API
 * (AuthGuard). Dev/demo with BADGERIQ_DEV_TENANT_ID skips the cookie gate so
 * local stacks without OIDC still work.
 *
 * Defense-in-depth for CVE-2025-29927: reject any request that still carries
 * x-middleware-subrequest. The real fix is Next.js >= 14.2.25 (this app pins
 * that floor; currently pinned to 14.2.35); rejecting the header here covers
 * misconfigured proxies that forward it into the app.
 */
export function middleware(request: NextRequest) {
  // Block CVE-2025-29927: attackers can send x-middleware-subrequest to skip
  // all middleware checks entirely. Strip or reject any request carrying it.
  if (request.headers.get('x-middleware-subrequest')) {
    return new NextResponse(null, { status: 400 });
  }

  if (env('BADGERIQ_DEV_TENANT_ID')) {
    return NextResponse.next();
  }

  const token = request.cookies.get('al_access')?.value;
  if (!token || !isStructurallyValidJwt(token)) {
    const refresh = request.cookies.get('al_refresh')?.value;
    if (refresh && request.nextUrl.pathname !== '/api/auth/refresh') {
      const refreshTarget = request.nextUrl.clone();
      refreshTarget.pathname = '/api/auth/refresh';
      refreshTarget.searchParams.set(
        'next',
        `${request.nextUrl.pathname}${request.nextUrl.search}`,
      );
      return NextResponse.redirect(refreshTarget);
    }
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    login.search = '';
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Everything except login, invite accept (public), Next internals, favicon, health.
    '/((?!login|invite/accept|api/invites/accept|api/auth/refresh|_next/static|_next/image|favicon.ico|healthz).*)',
  ],
};
