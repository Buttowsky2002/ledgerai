import { applyUserPatch, fromScimUser, parsePatch } from './scim.types';

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
});
