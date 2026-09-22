import {
  applyUserPatch,
  departmentFromAliases,
  fromScimUser,
  hasScimGroupAlias,
  memberIdsFromPatchOp,
  mergeDepartmentAlias,
  mergeScimGroupAlias,
  parsePatch,
  removeScimGroupAlias,
} from './scim.types';

describe('SCIM PATCH parsing', () => {
  const patchBody = (ops: unknown[]) => ({
    schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations: ops,
  });

  it('rejects a body that is not a PatchOp', () => {
    expect(() => parsePatch({ schemas: ['wrong'], Operations: [] })).toThrow();
    expect(() => parsePatch(patchBody([]))).toThrow(); // empty Operations
  });

  it('parses Okta-style deactivation (replace active with a path)', () => {
    const ops = parsePatch(patchBody([{ op: 'replace', path: 'active', value: false }]));
    expect(applyUserPatch(ops)).toEqual({ active: false });
  });

  it('coerces a string "false" active value', () => {
    const ops = parsePatch(patchBody([{ op: 'Replace', path: 'active', value: 'False' }]));
    expect(applyUserPatch(ops).active).toBe(false);
  });

  it('parses Entra-style no-path replace with an attribute object', () => {
    const ops = parsePatch(
      patchBody([{ op: 'replace', value: { displayName: 'New Name', active: true } }]),
    );
    expect(applyUserPatch(ops)).toEqual({ displayName: 'New Name', active: true });
  });

  it('maps name.formatted and userName paths', () => {
    const ops = parsePatch(
      patchBody([
        { op: 'replace', path: 'name.formatted', value: 'Jane Doe' },
        { op: 'replace', path: 'userName', value: 'JANE@Acme.com' },
      ]),
    );
    expect(applyUserPatch(ops)).toEqual({ displayName: 'Jane Doe', email: 'jane@acme.com' });
  });

  it('maps externalId and ignores Entra-only attributes', () => {
    const ops = parsePatch(
      patchBody([
        { op: 'replace', path: 'externalId', value: 'brandon.balams' },
        { op: 'replace', path: 'title', value: 'Analyst' },
        { op: 'replace', path: 'name.givenName', value: 'Brandon' },
      ]),
    );
    expect(applyUserPatch(ops)).toEqual({ externalId: 'brandon.balams' });
  });

  it('maps enterprise department to a team name', () => {
    const ops = parsePatch(
      patchBody([
        {
          op: 'replace',
          path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department',
          value: 'Security',
        },
      ]),
    );
    expect(applyUserPatch(ops)).toEqual({ department: 'Security' });
  });

  it('extracts member ids from Entra path-filter remove ops', () => {
    expect(
      memberIdsFromPatchOp({
        op: 'remove',
        path: 'members[value eq "e1439b68-d4ee-4ce3-8685-6a12cc0d6a37"]',
      }),
    ).toEqual(['e1439b68-d4ee-4ce3-8685-6a12cc0d6a37']);
    expect(
      memberIdsFromPatchOp({
        op: 'add',
        path: 'members',
        value: [{ value: 'u1' }, { value: 'u2' }],
      }),
    ).toEqual(['u1', 'u2']);
  });

  it('ignores remove ops that do not map onto identity columns', () => {
    const ops = parsePatch(patchBody([{ op: 'remove', path: 'emails[type eq "work"]' }]));
    expect(applyUserPatch(ops)).toEqual({});
  });
});

describe('SCIM User mapping', () => {
  it('extracts email from userName, primary email, or first email', () => {
    expect(fromScimUser({ userName: 'A@b.com' }).email).toBe('a@b.com');
    expect(fromScimUser({ emails: [{ value: 'x@y.com', primary: true }] }).email).toBe('x@y.com');
    expect(fromScimUser({ emails: [{ value: 'first@y.com' }] }).email).toBe('first@y.com');
  });

  it('extracts enterprise department from nested or flat keys', () => {
    expect(
      fromScimUser({
        userName: 'a@b.com',
        'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': {
          department: ' Engineering ',
        },
      }).department,
    ).toBe('Engineering');
    expect(
      fromScimUser({
        userName: 'a@b.com',
        'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department': 'Security',
      }).department,
    ).toBe('Security');
  });
});

describe('department alias helpers', () => {
  it('stores and reads department markers without dropping other aliases', () => {
    const merged = mergeDepartmentAlias(['cursor:abc', 'department:Old'], 'Engineering');
    expect(merged).toEqual(['cursor:abc', 'department:Engineering']);
    expect(departmentFromAliases(merged)).toBe('Engineering');
    expect(departmentFromAliases(['x'])).toBeNull();
  });
});

describe('SCIM group membership aliases', () => {
  it('adds and removes scim-group markers without touching department', () => {
    const teamId = '11111111-1111-1111-1111-111111111111';
    let aliases = mergeDepartmentAlias([], 'Engineering');
    aliases = mergeScimGroupAlias(aliases, teamId);
    expect(hasScimGroupAlias(aliases, teamId)).toBe(true);
    expect(departmentFromAliases(aliases)).toBe('Engineering');
    aliases = removeScimGroupAlias(aliases, teamId);
    expect(hasScimGroupAlias(aliases, teamId)).toBe(false);
    expect(departmentFromAliases(aliases)).toBe('Engineering');
  });
});
