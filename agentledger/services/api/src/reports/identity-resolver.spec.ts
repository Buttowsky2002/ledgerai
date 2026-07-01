import {
  matchIdentity,
  resolveDisplayName,
  resolveUserDirectoryIdentity,
  rollupUserSpendForChart,
  UNASSIGNED_LABEL,
  UNATTRIBUTED_LABEL,
} from './identity-resolver';

const entry = (displayName: string, teamName: string, email: string | null = null) => ({
  displayName,
  email,
  teamName,
});

describe('identity-resolver', () => {
  const uuidAlice = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const byId = new Map([[uuidAlice, entry('Alice Smith', 'Eng', 'alice@acme.test')]]);
  const byEmail = new Map([['developer@company.com', entry('Dev User', 'Eng', 'developer@company.com')]]);
  const byAlias = new Map([
    ['cursor-user-99', entry('Cursor Dev', 'Eng')],
    ['demo-user-0', entry('Alice Chen', 'Engineering')],
  ]);

  describe('resolveDisplayName', () => {
    it('prefers display_name then email local-part then handle', () => {
      expect(resolveDisplayName('Alice Smith', 'alice@acme.test')).toBe('Alice Smith');
      expect(resolveDisplayName(null, 'bob@acme.test')).toBe('bob');
      expect(resolveDisplayName(null, null, 'demo-user-3')).toBe('demo-user-3');
      expect(resolveDisplayName('', '')).toBe(UNASSIGNED_LABEL);
    });
  });

  describe('matchIdentity', () => {
    it('matches internal user_id (UUID) first', () => {
      const hit = matchIdentity(uuidAlice, byId, byEmail, byAlias);
      expect(hit?.displayName).toBe('Alice Smith');
    });

    it('matches email case-insensitively when UUID misses', () => {
      const hit = matchIdentity('Developer@Company.com', byId, byEmail, byAlias);
      expect(hit?.displayName).toBe('Dev User');
    });

    it('matches aliases when UUID and email miss', () => {
      expect(matchIdentity('cursor-user-99', byId, byEmail, byAlias)?.displayName).toBe('Cursor Dev');
      expect(matchIdentity('demo-user-0', byId, byEmail, byAlias)?.displayName).toBe('Alice Chen');
    });

    it('prefers email over alias when both could match', () => {
      const emailFirst = new Map(byEmail);
      emailFirst.set('shared-key', entry('Email Match', ''));
      const aliasSecond = new Map(byAlias);
      aliasSecond.set('shared-key', entry('Alias Match', ''));
      expect(matchIdentity('shared-key', byId, emailFirst, aliasSecond)?.displayName).toBe('Email Match');
    });

    it('returns null when all three paths miss', () => {
      expect(matchIdentity('orphan-id', byId, byEmail, byAlias)).toBeNull();
    });
  });

  describe('resolveUserDirectoryIdentity', () => {
    it('returns resolved identity fields for linked users', () => {
      expect(resolveUserDirectoryIdentity(uuidAlice, byId, byEmail, byAlias)).toMatchObject({
        display_name: 'Alice Smith',
        email: 'alice@acme.test',
        team: 'Eng',
        resolved: true,
      });
    });

    it('keeps raw handle for unlinked users', () => {
      expect(resolveUserDirectoryIdentity('orphan-handle', byId, byEmail, byAlias)).toMatchObject({
        display_name: 'orphan-handle',
        email: null,
        team: '',
        resolved: false,
      });
    });

    it('surfaces email for unlinked email-shaped handles', () => {
      expect(resolveUserDirectoryIdentity('orphan@acme.test', byId, byEmail, byAlias)).toMatchObject({
        display_name: 'orphan',
        email: 'orphan@acme.test',
        resolved: false,
      });
    });
  });

  describe('rollupUserSpendForChart', () => {
    it('keeps unattributed as a separate bar', () => {
      const rows = [
        { userId: 'a', displayName: 'Alice', teamName: '', costUsd: 50, calls: 1 },
        {
          userId: '__unattributed__',
          displayName: `${UNATTRIBUTED_LABEL} (2 identifiers)`,
          teamName: '',
          costUsd: 30,
          calls: 2,
        },
      ];
      const rolled = rollupUserSpendForChart(rows);
      expect(rolled.some((r) => r.userId === '__unattributed__')).toBe(true);
      expect(rolled.find((r) => r.displayName.startsWith(UNATTRIBUTED_LABEL))?.costUsd).toBe(30);
    });
  });
});
