import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { AuthMiddleware } from './auth.middleware';
import type { JwtService } from './jwt.service';
import { getPrincipal, Principal } from '../tenant/tenant-context';

const ENV_KEYS = ['NODE_ENV', 'LEDGERAI_DEV_TRUST_HEADER', 'AGENTLEDGER_DEV_TRUST_HEADER'];

// Run the middleware with the given headers (+ optional JwtService stub) and
// capture the principal it binds to the async context via runWithTenant.
async function resolvePrincipal(
  headers: Record<string, string>,
  jwt: Partial<JwtService> = {},
): Promise<Principal | null> {
  const mw = new AuthMiddleware(jwt as JwtService);
  let captured: Principal | null = null;
  const req = { headers } as unknown as Request;
  await mw.use(req, {} as Response, () => {
    captured = getPrincipal();
  });
  return captured;
}

describe('AuthMiddleware dev tenant-header handling', () => {
  const saved: Record<string, string | undefined> = {};
  const validTenant = randomUUID();
  const ANON: Principal = { tenantId: null, userId: null, role: null };

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  it('development + valid x-tenant-id (UUID) → accepted as that tenant (dev admin)', async () => {
    process.env.NODE_ENV = 'development';
    process.env.LEDGERAI_DEV_TRUST_HEADER = 'true';
    const p = await resolvePrincipal({ 'x-tenant-id': validTenant });
    expect(p).toEqual({ tenantId: validTenant, userId: null, role: 'admin' });
  });

  it('development + invalid x-tenant-id → rejected (anonymous, no admin)', async () => {
    process.env.NODE_ENV = 'development';
    process.env.LEDGERAI_DEV_TRUST_HEADER = 'true';
    const p = await resolvePrincipal({ 'x-tenant-id': 'not-a-uuid' });
    expect(p).toEqual(ANON);
  });

  it('production + valid x-tenant-id + flag → ignored (anonymous): no production bypass', async () => {
    process.env.NODE_ENV = 'production';
    process.env.LEDGERAI_DEV_TRUST_HEADER = 'true';
    const p = await resolvePrincipal({ 'x-tenant-id': validTenant });
    expect(p).toEqual(ANON);
  });

  it('development + flag unset → header ignored (anonymous)', async () => {
    process.env.NODE_ENV = 'development';
    const p = await resolvePrincipal({ 'x-tenant-id': validTenant });
    expect(p).toEqual(ANON);
  });

  it('a valid Bearer token is used and the dev header is never consulted', async () => {
    process.env.NODE_ENV = 'development';
    process.env.LEDGERAI_DEV_TRUST_HEADER = 'true';
    const verifyAccess = jest.fn().mockResolvedValue({ tenantId: 't', userId: 'u', role: 'viewer' });
    const p = await resolvePrincipal(
      { authorization: 'Bearer good.token', 'x-tenant-id': validTenant },
      { verifyAccess },
    );
    expect(verifyAccess).toHaveBeenCalledWith('good.token');
    expect(p).toEqual({ tenantId: 't', userId: 'u', role: 'viewer' });
  });
});
