import { isDemoIdentityKey } from './demo-identity';

describe('isDemoIdentityKey', () => {
  it('matches @acme.test emails', () => {
    expect(isDemoIdentityKey('alice.chen@acme.test')).toBe(true);
    expect(isDemoIdentityKey('Alice.Chen@Acme.Test')).toBe(true);
  });

  it('matches legacy demo-user handles', () => {
    expect(isDemoIdentityKey('demo-user-0')).toBe(true);
    expect(isDemoIdentityKey('demo-user-8')).toBe(true);
  });

  it('allows real identities', () => {
    expect(isDemoIdentityKey('brandon@studiodesigner.com')).toBe(false);
    expect(isDemoIdentityKey('alice.chen@studiodesigner.test')).toBe(false);
    expect(isDemoIdentityKey(null)).toBe(false);
  });
});
