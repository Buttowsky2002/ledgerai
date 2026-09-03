import { NextRequest } from 'next/server';
import { config, middleware } from '../middleware';
import { isStructurallyValidJwt } from '../lib/jwt-structure';

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function fakeJwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.sig`;
}

function requestFor(
  path: string,
  opts: { cookie?: string; refreshCookie?: string; headers?: Record<string, string> } = {},
): NextRequest {
  const headers = new Headers(opts.headers);
  const cookieParts: string[] = [];
  if (opts.cookie) cookieParts.push(`al_access=${opts.cookie}`);
  if (opts.refreshCookie) cookieParts.push(`al_refresh=${opts.refreshCookie}`);
  if (cookieParts.length) {
    headers.set('cookie', cookieParts.join('; '));
  }
  return new NextRequest(new URL(path, 'http://localhost:3000'), { headers });
}

describe('isStructurallyValidJwt', () => {
  it('accepts a three-segment token with future exp', () => {
    const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    expect(isStructurallyValidJwt(token)).toBe(true);
  });

  it('rejects malformed (not three segments)', () => {
    expect(isStructurallyValidJwt('only.two')).toBe(false);
    expect(isStructurallyValidJwt('not-a-jwt')).toBe(false);
  });

  it('rejects expired tokens', () => {
    const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) - 10 });
    expect(isStructurallyValidJwt(token)).toBe(false);
  });

  it('rejects missing exp', () => {
    const token = fakeJwt({ sub: 'user-1' });
    expect(isStructurallyValidJwt(token)).toBe(false);
  });
});

describe('middleware', () => {
  const savedDevTenant = process.env.BADGERIQ_DEV_TENANT_ID;

  beforeEach(() => {
    delete process.env.BADGERIQ_DEV_TENANT_ID;
    delete process.env.LEDGERAI_DEV_TENANT_ID;
    delete process.env.AGENTLEDGER_DEV_TENANT_ID;
  });

  afterAll(() => {
    if (savedDevTenant === undefined) {
      delete process.env.BADGERIQ_DEV_TENANT_ID;
    } else {
      process.env.BADGERIQ_DEV_TENANT_ID = savedDevTenant;
    }
  });

  it('redirects to /login when cookie is missing', async () => {
    const res = middleware(requestFor('/overview'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3000/login');
  });

  it('redirects to /login when JWT is malformed', async () => {
    const res = middleware(requestFor('/overview', { cookie: 'not.a.jwt.extra' }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3000/login');
  });

  it('redirects to /login when JWT is expired and no refresh cookie', async () => {
    const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    const res = middleware(requestFor('/overview', { cookie: token }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3000/login');
  });

  it('redirects to refresh when JWT is expired but refresh cookie exists', async () => {
    const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    const res = middleware(
      requestFor('/overview', { cookie: token, refreshCookie: 'refresh-token-value' }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/api/auth/refresh?next=%2Foverview',
    );
  });

  it('passes when JWT has a future exp', async () => {
    const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const res = middleware(requestFor('/overview', { cookie: token }));
    expect(res.status).toBe(200);
    // next() responses are opaque 200 with no redirect
    expect(res.headers.get('location')).toBeNull();
  });

  it('returns 400 when x-middleware-subrequest is present', async () => {
    const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const res = middleware(
      requestFor('/overview', {
        cookie: token,
        headers: { 'x-middleware-subrequest': '1' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 JSON for API routes instead of an HTML login redirect', async () => {
    const res = middleware(requestFor('/api/portal-import/anthropic/preview'));
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/json/);
    expect(res.headers.get('location')).toBeNull();
    await expect(res.json()).resolves.toEqual({ error: 'unauthorized' });
  });

  it('returns session_expired JSON for API routes when only a refresh cookie exists', async () => {
    const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    const res = middleware(
      requestFor('/api/portal-import/anthropic/preview', {
        cookie: token,
        refreshCookie: 'refresh-token-value',
      }),
    );
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'session_expired' });
  });

  it('returns 400 for x-middleware-subrequest even before cookie checks', async () => {
    const res = middleware(
      requestFor('/overview', {
        headers: { 'x-middleware-subrequest': 'middleware:middleware' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("skips Edge middleware for portal CSV uploads so large bodies are not 413'd", () => {
    expect(config.matcher).toHaveLength(1);
    expect(config.matcher[0]).toContain('api/portal-import');
  });
});
