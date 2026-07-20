import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { env } from './lib/env';

/**
 * Soft gate: require an `al_access` cookie before rendering app pages.
 * Presence-only — no API call. AuthGuard on the control-plane API remains the
 * real security boundary. Dev/demo with BADGERIQ_DEV_TENANT_ID skips this so
 * local stacks without OIDC still work.
 */
export function middleware(request: NextRequest) {
  if (env('BADGERIQ_DEV_TENANT_ID')) {
    return NextResponse.next();
  }

  const token = request.cookies.get('al_access')?.value;
  if (!token) {
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    login.search = '';
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Everything except login, Next internals, favicon, and the ALB/ECS health probe.
    '/((?!login|_next/static|_next/image|favicon.ico|healthz).*)',
  ],
};
