// SCIM 2.0 (RFC 7643/7644) envelopes, mappers, and a focused PATCH-op parser.
// BadgerIQ maps SCIM Users → identities and SCIM Groups → teams; only the
// attributes those tables hold are honored (others are accepted and ignored).

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

/** A SCIM Error object (RFC 7644 §3.12). status is a string per the spec. */
export function scimError(status: number, detail: string, scimType?: string): Record<string, unknown> {
  return {
    schemas: [ERROR_SCHEMA],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
}

/** Wrap resources in a SCIM ListResponse with paging metadata. */
export function listResponse(
  resources: Record<string, unknown>[],
  totalResults: number,
  startIndex: number,
): Record<string, unknown> {
  return {
    schemas: [LIST_SCHEMA],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

// ---- identity ↔ SCIM User ----

export interface IdentityShape {
  userId: string;
  email: string;
  displayName: string | null;
  externalId: string | null;
  active: boolean;
}

export function toScimUser(i: IdentityShape, baseUrl: string): Record<string, unknown> {
  return {
    schemas: [USER_SCHEMA],
    id: i.userId,
    ...(i.externalId ? { externalId: i.externalId } : {}),
    userName: i.email,
    name: { formatted: i.displayName ?? i.email },
    displayName: i.displayName ?? i.email,
    emails: [{ value: i.email, primary: true }],
    active: i.active,
    meta: { resourceType: 'User', location: `${baseUrl}/Users/${i.userId}` },
  };
}

/** Extract the identity-relevant fields from a SCIM User create/replace body. */
export function fromScimUser(body: Record<string, unknown>): {
  email?: string;
  displayName?: string;
  externalId?: string;
  active?: boolean;
} {
  const emails = body.emails as { value?: string; primary?: boolean }[] | undefined;
  const name = body.name as { formatted?: string } | undefined;
  const primaryEmail = emails?.find((e) => e.primary)?.value ?? emails?.[0]?.value;
  return {
    email: ((body.userName as string) ?? primaryEmail)?.toLowerCase(),
    displayName: (body.displayName as string) ?? name?.formatted,
    externalId: body.externalId as string | undefined,
    active: typeof body.active === 'boolean' ? body.active : undefined,
  };
}

// ---- team ↔ SCIM Group ----

export interface GroupShape {
  teamId: string;
  name: string;
  externalId: string | null;
  members: { userId: string; email: string }[];
}

export function toScimGroup(g: GroupShape, baseUrl: string): Record<string, unknown> {
  return {
    schemas: [GROUP_SCHEMA],
    id: g.teamId,
    ...(g.externalId ? { externalId: g.externalId } : {}),
    displayName: g.name,
    members: g.members.map((m) => ({ value: m.userId, display: m.email })),
    meta: { resourceType: 'Group', location: `${baseUrl}/Groups/${g.teamId}` },
  };
}

export function memberIdsFromGroup(body: Record<string, unknown>): string[] {
  const members = body.members as { value?: string }[] | undefined;
  return (members ?? []).map((m) => m.value).filter((v): v is string => typeof v === 'string');
}

// ---- PATCH (RFC 7644 §3.5.2) ----

export interface PatchOp {
  op: 'add' | 'replace' | 'remove';
  path?: string;
  value?: unknown;
}

/** Validate + normalize a PatchOp body into the supported operation list. */
export function parsePatch(body: Record<string, unknown>): PatchOp[] {
  const schemas = body.schemas as string[] | undefined;
  if (!schemas?.includes(PATCH_SCHEMA)) {
    throw new Error('not a PatchOp');
  }
  const ops = body.Operations as Record<string, unknown>[] | undefined;
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new Error('Operations required');
  }
  return ops.map((o) => ({
    op: String(o.op).toLowerCase() as PatchOp['op'],
    path: o.path as string | undefined,
    value: o.value,
  }));
}

/**
 * Reduce User PATCH operations to a flat attribute patch. Supports the ops Okta
 * and Entra actually emit: `replace` of `active`, `displayName`/`name.formatted`,
 * `userName` — both with an explicit path and as a no-path value object.
 */
export function applyUserPatch(ops: PatchOp[]): {
  email?: string;
  displayName?: string;
  active?: boolean;
} {
  const out: { email?: string; displayName?: string; active?: boolean } = {};
  const setAttr = (path: string, value: unknown) => {
    switch (path.toLowerCase()) {
      case 'active':
        out.active = typeof value === 'boolean' ? value : String(value).toLowerCase() === 'true';
        break;
      case 'displayname':
      case 'name.formatted':
        out.displayName = String(value);
        break;
      case 'username':
        out.email = String(value).toLowerCase();
        break;
    }
  };
  for (const op of ops) {
    if (op.op === 'remove') {
      continue; // nothing removable maps onto our identity columns
    }
    if (op.path) {
      setAttr(op.path, op.value);
    } else if (op.value && typeof op.value === 'object') {
      for (const [k, v] of Object.entries(op.value as Record<string, unknown>)) {
        setAttr(k, v);
      }
    }
  }
  return out;
}
