import { isDemoIdentityEmail, isDemoUserRow } from '../lib/identity-filters';

describe('isDemoIdentityEmail', () => {
  it('hides @acme.test and demo-user handles', () => {
    expect(isDemoIdentityEmail('alice.chen@acme.test')).toBe(true);
    expect(isDemoIdentityEmail('demo-user-3')).toBe(true);
    expect(isDemoIdentityEmail('brandon@studiodesigner.com')).toBe(false);
  });
});

describe('isDemoUserRow', () => {
  it('matches email or user_id', () => {
    expect(isDemoUserRow({ user_id: 'x', email: 'a@acme.test' })).toBe(true);
    expect(isDemoUserRow({ user_id: 'demo-user-1', email: null })).toBe(true);
    expect(isDemoUserRow({ user_id: 'uuid', email: 'real@studiodesigner.com' })).toBe(false);
  });
});
