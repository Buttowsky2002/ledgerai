import { resolveCanonicalIdentity, type SyncIdentityRow } from './import-identity-sync';

function row(
  partial: Partial<SyncIdentityRow> & Pick<SyncIdentityRow, 'userId' | 'email'>,
): SyncIdentityRow {
  return {
    aliases: [],
    active: true,
    source: 'scim',
    ...partial,
  };
}

describe('resolveCanonicalIdentity', () => {
  it('matches mixed-case directory email to lowercased import email', () => {
    const hit = resolveCanonicalIdentity({ email: 'alice@studiodesigner.com', aliases: [] }, [
      row({ userId: 'u1', email: 'Alice@StudioDesigner.com', source: 'scim' }),
    ]);
    expect(hit?.userId).toBe('u1');
  });

  it('matches via Anthropic account alias when primary email differs', () => {
    const hit = resolveCanonicalIdentity(
      {
        email: 'alice.work@gmail.com',
        aliases: ['user_abc123', 'acct-uuid-1'],
      },
      [
        row({
          userId: 'u-scim',
          email: 'alice@studiodesigner.com',
          aliases: ['user_abc123'],
          source: 'scim',
        }),
      ],
    );
    expect(hit?.userId).toBe('u-scim');
  });

  it('prefers active SCIM identity over portal_import shell', () => {
    const hit = resolveCanonicalIdentity({ email: 'bob@studiodesigner.com', aliases: [] }, [
      row({
        userId: 'u-portal',
        email: 'bob@studiodesigner.com',
        source: 'portal_import',
      }),
      row({
        userId: 'u-scim',
        email: 'Bob@StudioDesigner.com',
        source: 'scim',
      }),
    ]);
    expect(hit?.userId).toBe('u-scim');
  });

  it('prefers active identity over inactive duplicate', () => {
    const hit = resolveCanonicalIdentity({ email: 'cara@studiodesigner.com', aliases: [] }, [
      row({
        userId: 'u-inactive',
        email: 'cara@studiodesigner.com',
        active: false,
        source: 'scim',
      }),
      row({
        userId: 'u-active',
        email: 'cara@studiodesigner.com',
        active: true,
        source: 'manual',
      }),
    ]);
    expect(hit?.userId).toBe('u-active');
  });

  it('returns null when no identity matches (caller may create)', () => {
    const hit = resolveCanonicalIdentity(
      { email: 'newbie@studiodesigner.com', aliases: ['user_new'] },
      [row({ userId: 'u1', email: 'other@studiodesigner.com' })],
    );
    expect(hit).toBeNull();
  });

  it('prefers @studiodesigner.com primary when both match via alias', () => {
    const hit = resolveCanonicalIdentity({ email: 'shared@external.test', aliases: ['gh-login'] }, [
      row({
        userId: 'u-ext',
        email: 'shared@external.test',
        aliases: ['gh-login'],
        source: 'manual',
      }),
      row({
        userId: 'u-corp',
        email: 'shared@studiodesigner.com',
        aliases: ['gh-login'],
        source: 'manual',
      }),
    ]);
    expect(hit?.userId).toBe('u-corp');
  });
});
