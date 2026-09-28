import {
  groupIdentitiesByDisplayName,
  mergeAliasLists,
  normalizeDisplayNameKey,
  pickPrimaryIdentity,
  primaryUserIdByIdentityId,
  resolveIdentityForCopilotMember,
  rosterPrimaryUserIds,
  type MergeableIdentity,
} from './identity-merge';

const id = (
  userId: string,
  email: string,
  displayName: string,
  aliases: string[] = [],
  teamId: string | null = null,
): MergeableIdentity => ({
  userId,
  email,
  displayName,
  aliases,
  teamId,
  active: true,
});

describe('identity-merge', () => {
  describe('normalizeDisplayNameKey', () => {
    it('collapses case, hyphens, and whitespace', () => {
      expect(normalizeDisplayNameKey('Russ-McClelland')).toBe('russ mcclelland');
      expect(normalizeDisplayNameKey('  Russ   McClelland ')).toBe('russ mcclelland');
    });
  });

  describe('pickPrimaryIdentity', () => {
    it('prefers @studiodesigner.com over other emails', () => {
      const primary = pickPrimaryIdentity([
        id('a', 'russ@gmail.com', 'Russ McClelland'),
        id('b', 'russ@studiodesigner.com', 'Russ McClelland'),
      ]);
      expect(primary.userId).toBe('b');
      expect(primary.email).toBe('russ@studiodesigner.com');
    });

    it('breaks ties with more aliases then team then email sort', () => {
      const primary = pickPrimaryIdentity([
        id('a', 'a@example.com', 'Tim', []),
        id('b', 'b@example.com', 'Tim', ['alias-1'], 'team-1'),
      ]);
      expect(primary.userId).toBe('b');
    });
  });

  describe('groupIdentitiesByDisplayName', () => {
    it('groups duplicates and ignores singletons', () => {
      const groups = groupIdentitiesByDisplayName([
        id('1', 'a@co.com', 'Russ McClelland'),
        id('2', 'b@co.com', 'Russ-McClelland'),
        id('3', 'c@co.com', 'Alice'),
      ]);
      expect(groups.size).toBe(1);
      expect(
        groups
          .get('russ mcclelland')
          ?.map((g) => g.userId)
          .sort(),
      ).toEqual(['1', '2']);
    });
  });

  describe('rosterPrimaryUserIds', () => {
    it('keeps one primary per display-name group', () => {
      const rows = [
        id('1', 'russ@gmail.com', 'Russ'),
        id('2', 'russ@studiodesigner.com', 'Russ'),
        id('3', 'alice@co.com', 'Alice'),
      ];
      const primaries = rosterPrimaryUserIds(rows);
      expect(primaries.has('2')).toBe(true);
      expect(primaries.has('1')).toBe(false);
      expect(primaries.has('3')).toBe(true);
    });
  });

  describe('primaryUserIdByIdentityId', () => {
    it('maps secondaries onto the preferred primary', () => {
      const map = primaryUserIdByIdentityId([
        id('1', 'russ@gmail.com', 'Russ'),
        id('2', 'russ@studiodesigner.com', 'Russ'),
      ]);
      expect(map.get('1')).toBe('2');
      expect(map.get('2')).toBe('2');
    });
  });

  describe('resolveIdentityForCopilotMember', () => {
    const identities = [
      id('1', 'russ@studiodesigner.com', 'Russ McClelland', ['russ@gmail.com']),
      id('2', 'alice@co.com', 'Alice'),
    ];

    it('matches by email first', () => {
      const hit = resolveIdentityForCopilotMember(
        { githubLogin: 'Russ-McClelland', email: 'russ@gmail.com' },
        identities,
      );
      expect(hit?.userId).toBe('1');
    });

    it('matches by normalized display name when email is missing', () => {
      const hit = resolveIdentityForCopilotMember(
        { githubLogin: 'Russ-McClelland', displayName: 'Russ McClelland' },
        identities,
      );
      expect(hit?.userId).toBe('1');
    });

    it('returns null when nothing matches', () => {
      expect(
        resolveIdentityForCopilotMember(
          { githubLogin: 'nobody', displayName: 'Nobody' },
          identities,
        ),
      ).toBeNull();
    });
  });

  describe('mergeAliasLists', () => {
    it('dedupes case-insensitively and preserves first casing', () => {
      expect(mergeAliasLists(['Russ-McClelland'], ['russ-mcclelland', 'russ@co.com'])).toEqual([
        'Russ-McClelland',
        'russ@co.com',
      ]);
    });
  });
});
