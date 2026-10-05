import { mergeDepartmentAlias, departmentFromAliases } from '../scim/scim.types';

/** Mirrors identities.controller patchTeam alias rewrite for clear / set. */
function nextAliasesForTeam(raw: unknown, teamName: string | null): unknown[] {
  if (teamName) {
    return mergeDepartmentAlias(raw, teamName);
  }
  const existing = Array.isArray(raw) ? raw : [];
  return existing.filter(
    (item) => !(typeof item === 'string' && item.startsWith('department:')),
  );
}

describe('identity team assignment aliases', () => {
  it('sets department alias when assigning a team', () => {
    const next = nextAliasesForTeam(['scim-group:abc'], 'Finance');
    expect(departmentFromAliases(next)).toBe('Finance');
    expect(next).toContain('scim-group:abc');
  });

  it('clears department alias when unassigning', () => {
    const before = mergeDepartmentAlias(['scim-group:abc'], 'Finance');
    const next = nextAliasesForTeam(before, null);
    expect(departmentFromAliases(next)).toBeNull();
    expect(next).toContain('scim-group:abc');
  });

  it('replaces a prior department alias', () => {
    const before = mergeDepartmentAlias([], 'Eng');
    const next = nextAliasesForTeam(before, 'Product');
    expect(departmentFromAliases(next)).toBe('Product');
    expect(next.filter((a) => typeof a === 'string' && a.startsWith('department:'))).toHaveLength(
      1,
    );
  });
});
