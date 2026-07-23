import { NextRequest } from 'next/server';
import { middleware } from '../middleware';
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
  opts: { cookie?: string; headers?: Record<string, string> } = {},
): NextRequest {
  const headers = new Headers(opts.headers);
  if (opts.cookie) {
    headers.set('cookie', `al_access=${opts.cookie}`);
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

  it('redirects to /login when JWT is expired', async () => {
    const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    const res = middleware(requestFor('/overview', { cookie: token }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3000/login');
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

  it('returns 400 for x-middleware-subrequest even before cookie checks', async () => {
    const res = middleware(
      requestFor('/overview', {
        headers: { 'x-middleware-subrequest': 'middleware:middleware' },
      }),
    );
    expect(res.status).toBe(400);
  });
});
