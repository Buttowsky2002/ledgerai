import type { Request } from 'express';
import { cookieOpts, cookieSameSite, dashboardUrl, oidcTxCookieOpts, wantsJsonResponse } from './auth.controller';

/**
 * Unit coverage for the session-cookie security logic (no DB required). The
 * end-to-end cookie *flow* (callback → al_access/al_refresh, refresh, logout) is
 * exercised in auth.e2e-spec.ts / sso.e2e-spec.ts against a live Postgres.
 */
const ENV_KEYS = [
  'NODE_ENV',
  'BADGERIQ_COOKIE_SAMESITE',
  'LEDGERAI_COOKIE_SAMESITE',
  'AGENTLEDGER_COOKIE_SAMESITE',
  'LEDGERAI_DASHBOARD_URL',
  'AGENTLEDGER_DASHBOARD_URL',
];

describe('auth cookie helpers', () => {
  const saved: Record<string, string | undefined> = {};

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

  describe('cookieOpts', () => {
    it('is httpOnly, sameSite=strict, path=/ with the given maxAge by default', () => {
      const o = cookieOpts(900_000);
      expect(o.httpOnly).toBe(true);
      expect(o.sameSite).toBe('strict');
      expect(o.path).toBe('/');
      expect(o.maxAge).toBe(900_000);
    });

    it('omits maxAge when none is given (used for clearing cookies)', () => {
      expect(cookieOpts()).not.toHaveProperty('maxAge');
    });

    it('secure=false outside production', () => {
      process.env.NODE_ENV = 'test';
      expect(cookieOpts().secure).toBe(false);
    });

    it('secure=true in production', () => {
      process.env.NODE_ENV = 'production';
      expect(cookieOpts().secure).toBe(true);
    });
  });

  describe('oidcTxCookieOpts', () => {
    it('uses SameSite=Lax by default so IdP return navigations keep the tx cookie', () => {
      const o = oidcTxCookieOpts(600_000);
      expect(o.sameSite).toBe('lax');
      expect(o.httpOnly).toBe(true);
      expect(o.maxAge).toBe(600_000);
    });

    it('stays Lax even when session cookies are Strict', () => {
      process.env.BADGERIQ_COOKIE_SAMESITE = 'strict';
      expect(oidcTxCookieOpts().sameSite).toBe('lax');
      expect(cookieOpts().sameSite).toBe('strict');
    });

    it('follows session SameSite=None (cross-site deploy) for the tx cookie', () => {
      process.env.NODE_ENV = 'test';
      process.env.BADGERIQ_COOKIE_SAMESITE = 'none';
      const o = oidcTxCookieOpts(600_000);
      expect(o.sameSite).toBe('none');
      expect(o.secure).toBe(true);
    });
  });

  describe('cookieSameSite (cross-site deployment flag)', () => {
    it('defaults to strict', () => {
      expect(cookieSameSite()).toBe('strict');
    });

    it('honors LEDGERAI_COOKIE_SAMESITE=lax', () => {
      process.env.LEDGERAI_COOKIE_SAMESITE = 'lax';
      expect(cookieSameSite()).toBe('lax');
    });

    it('falls back to the deprecated AGENTLEDGER_COOKIE_SAMESITE alias', () => {
      process.env.AGENTLEDGER_COOKIE_SAMESITE = 'none';
      expect(cookieSameSite()).toBe('none');
    });

    it('ignores an invalid value and stays strict', () => {
      process.env.LEDGERAI_COOKIE_SAMESITE = 'bogus';
      expect(cookieSameSite()).toBe('strict');
    });

    it('sameSite=none forces secure=true even outside production', () => {
      process.env.NODE_ENV = 'test';
      process.env.LEDGERAI_COOKIE_SAMESITE = 'none';
      const o = cookieOpts(900_000);
      expect(o.sameSite).toBe('none');
      expect(o.secure).toBe(true);
    });
  });

  describe('dashboardUrl', () => {
    it('defaults to http://localhost:3000', () => {
      expect(dashboardUrl()).toBe('http://localhost:3000');
    });

    it('prefers LEDGERAI_DASHBOARD_URL', () => {
      process.env.LEDGERAI_DASHBOARD_URL = 'https://dash.ledgerai.test';
      expect(dashboardUrl()).toBe('https://dash.ledgerai.test');
    });

    it('falls back to the deprecated AGENTLEDGER_DASHBOARD_URL', () => {
      process.env.AGENTLEDGER_DASHBOARD_URL = 'https://legacy.example';
      expect(dashboardUrl()).toBe('https://legacy.example');
    });

    it('prefers the new var when both are set', () => {
      process.env.LEDGERAI_DASHBOARD_URL = 'https://new.example';
      process.env.AGENTLEDGER_DASHBOARD_URL = 'https://legacy.example';
      expect(dashboardUrl()).toBe('https://new.example');
    });
  });

  describe('wantsJsonResponse', () => {
    const mk = (query: Record<string, unknown>, accept = ''): Request =>
      ({
        query,
        get: (h: string) => (h.toLowerCase() === 'accept' ? accept : undefined),
      }) as unknown as Request;

    it('is false for a browser navigation (text/html Accept)', () => {
      expect(wantsJsonResponse(mk({}, 'text/html,application/xhtml+xml,application/xml;q=0.9'))).toBe(false);
    });

    it('is true with ?response=json', () => {
      expect(wantsJsonResponse(mk({ response: 'json' }, 'text/html'))).toBe(true);
    });

    it('is true with Accept: application/json', () => {
      expect(wantsJsonResponse(mk({}, 'application/json'))).toBe(true);
    });
  });
});
