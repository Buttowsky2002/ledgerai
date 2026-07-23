import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTH_THROTTLE, SCIM_THROTTLE } from './throttle-limits';

describe('auth + SCIM rate limits (security rule 6)', () => {
  it('login / SSO initiation is 5 per 60s', () => {
    expect(AUTH_THROTTLE.login.default).toEqual({ limit: 5, ttl: 60_000 });
  });

  it('token refresh is 10 per 60s', () => {
    expect(AUTH_THROTTLE.refresh.default).toEqual({ limit: 10, ttl: 60_000 });
  });

  it('OIDC / SSO callback is 20 per 60s (redirect bursts)', () => {
    expect(AUTH_THROTTLE.callback.default).toEqual({ limit: 20, ttl: 60_000 });
  });

  it('SCIM is 30 per 60s', () => {
    expect(SCIM_THROTTLE.default).toEqual({ limit: 30, ttl: 60_000 });
  });

  it('auth.controller wires AUTH_THROTTLE on login, callback, and refresh', () => {
    const src = readFileSync(join(__dirname, 'auth.controller.ts'), 'utf8');
    expect(src).toContain('@Throttle(AUTH_THROTTLE.login)');
    expect(src).toContain('@Throttle(AUTH_THROTTLE.callback)');
    expect(src).toContain('@Throttle(AUTH_THROTTLE.refresh)');
    // No blanket class-level throttle that would override per-route limits.
    expect(src).not.toMatch(/@Controller\('auth'\)\s*\n@Throttle/);
  });

  it('SCIM uses bearer-token ScimAuthGuard and SCIM_THROTTLE', () => {
    const ctrl = readFileSync(join(__dirname, '../scim/scim.controller.ts'), 'utf8');
    expect(ctrl).toContain('@Throttle(SCIM_THROTTLE)');
    expect(ctrl).toContain('@UseGuards(ScimAuthGuard)');
    expect(ctrl).toContain('@Public()');

    const guard = readFileSync(join(__dirname, '../scim/scim-auth.guard.ts'), 'utf8');
    expect(guard).toMatch(/Bearer /);
    expect(guard).toMatch(/scim_token_resolve/);
  });
});
