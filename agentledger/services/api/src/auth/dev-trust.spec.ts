import {
  assertDevTrustHeaderNotInProduction,
  devTrustHeaderRequested,
  isUuid,
  shouldTrustDevTenantHeader,
} from './dev-trust';

const ENV_KEYS = ['NODE_ENV', 'LEDGERAI_DEV_TRUST_HEADER', 'AGENTLEDGER_DEV_TRUST_HEADER'];

describe('dev tenant-header trust gating', () => {
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

  describe('assertDevTrustHeaderNotInProduction (production bypass is impossible)', () => {
    it('throws when NODE_ENV=production and LEDGERAI_DEV_TRUST_HEADER=true', () => {
      process.env.NODE_ENV = 'production';
      process.env.LEDGERAI_DEV_TRUST_HEADER = 'true';
      expect(() => assertDevTrustHeaderNotInProduction()).toThrow(/refusing to start/i);
    });

    it('throws when NODE_ENV=production and the deprecated AGENTLEDGER_DEV_TRUST_HEADER=true', () => {
      process.env.NODE_ENV = 'production';
      process.env.AGENTLEDGER_DEV_TRUST_HEADER = 'true';
      expect(() => assertDevTrustHeaderNotInProduction()).toThrow();
    });

    it('does not throw in production when the flags are unset', () => {
      process.env.NODE_ENV = 'production';
      expect(() => assertDevTrustHeaderNotInProduction()).not.toThrow();
    });

    it('does not throw outside production even with the flag set', () => {
      process.env.NODE_ENV = 'development';
      process.env.LEDGERAI_DEV_TRUST_HEADER = 'true';
      expect(() => assertDevTrustHeaderNotInProduction()).not.toThrow();
    });
  });

  describe('shouldTrustDevTenantHeader', () => {
    it('is true outside production with the flag set', () => {
      process.env.NODE_ENV = 'development';
      process.env.LEDGERAI_DEV_TRUST_HEADER = 'true';
      expect(shouldTrustDevTenantHeader()).toBe(true);
    });

    it('honors the deprecated AGENTLEDGER_DEV_TRUST_HEADER alias', () => {
      process.env.NODE_ENV = 'test';
      process.env.AGENTLEDGER_DEV_TRUST_HEADER = 'true';
      expect(shouldTrustDevTenantHeader()).toBe(true);
    });

    it('is false in production even with the flag set', () => {
      process.env.NODE_ENV = 'production';
      process.env.LEDGERAI_DEV_TRUST_HEADER = 'true';
      expect(shouldTrustDevTenantHeader()).toBe(false);
    });

    it('is false outside production when the flag is not set', () => {
      process.env.NODE_ENV = 'development';
      expect(shouldTrustDevTenantHeader()).toBe(false);
    });
  });

  describe('devTrustHeaderRequested', () => {
    it('is true if either the current or the legacy flag is true', () => {
      expect(devTrustHeaderRequested()).toBe(false);
      process.env.AGENTLEDGER_DEV_TRUST_HEADER = 'true';
      expect(devTrustHeaderRequested()).toBe(true);
    });
  });

  describe('isUuid', () => {
    it('accepts a well-formed UUID', () => {
      expect(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
    });

    it('rejects non-UUID strings', () => {
      for (const s of ['', 'tenant-a', '123', 'not-a-uuid', '3f2504e0-4f89-41d3-9a0c']) {
        expect(isUuid(s)).toBe(false);
      }
    });
  });
});
