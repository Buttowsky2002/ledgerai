// SCIM 2.0 (RFC 7643/7644) envelopes, mappers, and a focused PATCH-op parser.
// AgentLedger maps SCIM Users → identities and SCIM Groups → teams; only the
// attributes those tables hold are honored (others are accepted and ignored).

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const ENTERPRISE_USER = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';

function isEmailLike(value: string | undefined | null): boolean {
  return Boolean(value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()));
}

/** A SCIM Error object (RFC 7644 §3.12). status is a string per the spec. */
export function scimError(
  status: number,
  detail: string,
  scimType?: string,
): Record<string, unknown> {
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
  /** Optional — when present, echoed as enterprise User.department. */
  aliases?: unknown;
  teamName?: string | null;
}

/**
 * Entra matches on userName. When they map objectId → userName we store that as
 * externalId and must echo it back as userName (not email) or provision-on-demand
 * fails matching after create. Okta-style externalIds (mailNickname) stay on
 * externalId — userName remains the work email.
 */
export function scimUserName(i: Pick<IdentityShape, 'email' | 'externalId'>): string {
  if (i.externalId && isUuidLike(i.externalId)) {
    return i.externalId;
  }
  return i.email;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value.trim(),
  );
}

export function toScimUser(i: IdentityShape, baseUrl: string): Record<string, unknown> {
  const fromAlias = departmentFromAliases(i.aliases);
  const fromTeam = i.teamName?.trim() || null;
  const department = fromAlias ?? fromTeam;
  const body: Record<string, unknown> = {
    schemas: department ? [USER_SCHEMA, ENTERPRISE_USER] : [USER_SCHEMA],
    id: i.userId,
    ...(i.externalId ? { externalId: i.externalId } : {}),
    userName: scimUserName(i),
    name: { formatted: i.displayName ?? i.email },
    displayName: i.displayName ?? i.email,
    emails: [{ value: i.email, primary: true, type: 'work' }],
    active: i.active,
    meta: { resourceType: 'User', location: `${baseUrl}/Users/${i.userId}` },
  };
  if (department) {
    body[ENTERPRISE_USER] = { department };
  }
  return body;
}

/** Extract the identity-relevant fields from a SCIM User create/replace body. */
export function fromScimUser(body: Record<string, unknown>): {
  email?: string;
  displayName?: string;
  externalId?: string;
  active?: boolean;
  /** Entra maps [department] → enterprise User:department; we use it as team name. */
  department?: string;
} {
  const emails = body.emails as { value?: string; primary?: boolean }[] | undefined;
  const name = body.name as { formatted?: string } | undefined;
  const primaryEmail = emails?.find((e) => e.primary)?.value ?? emails?.[0]?.value;
  const userName = typeof body.userName === 'string' ? body.userName.trim() : undefined;
  // Entra often sets userName to objectId (UUID). Prefer a real email from emails[].
  // Never persist a non-email (objectId) as identities.email — that breaks login + matching.
  const emailRaw = isEmailLike(primaryEmail)
    ? primaryEmail
    : isEmailLike(userName)
      ? userName
      : undefined;
  const email = emailRaw?.trim().toLowerCase();
  const bodyExternal =
    typeof body.externalId === 'string' && body.externalId.trim()
      ? body.externalId.trim()
      : undefined;
  // Persist Entra objectId when it arrives as userName so later filters match.
  const externalId = bodyExternal ?? (userName && !isEmailLike(userName) ? userName : undefined);
  return {
    email,
    displayName: (body.displayName as string) ?? name?.formatted,
    externalId,
    active: typeof body.active === 'boolean' ? body.active : undefined,
    department: enterpriseDepartment(body),
  };
}

/** Read enterprise:2.0:User department from nested object or dotted Entra path key. */
export function enterpriseDepartment(body: Record<string, unknown>): string | undefined {
  const nested = body[ENTERPRISE_USER] as { department?: unknown } | undefined;
  if (typeof nested?.department === 'string' && nested.department.trim()) {
    return nested.department.trim();
  }
  const flat = body[`${ENTERPRISE_USER}:department`];
  if (typeof flat === 'string' && flat.trim()) {
    return flat.trim();
  }
  if (typeof body.department === 'string' && body.department.trim()) {
    return body.department.trim();
  }
  return undefined;
}

const DEPARTMENT_ALIAS_PREFIX = 'department:';
const SCIM_GROUP_ALIAS_PREFIX = 'scim-group:';

/** Persist enterprise department on aliases so Group sync can re-assert it. */
export function mergeDepartmentAlias(raw: unknown, department: string): unknown[] {
  const name = department.trim();
  const marker = `${DEPARTMENT_ALIAS_PREFIX}${name}`;
  const existing = Array.isArray(raw)
    ? raw.filter((item) => typeof item === 'string' && !item.startsWith(DEPARTMENT_ALIAS_PREFIX))
    : [];
  return [...existing, marker];
}

export function departmentFromAliases(raw: unknown): string | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  for (const item of raw) {
    if (typeof item === 'string' && item.startsWith(DEPARTMENT_ALIAS_PREFIX)) {
      const name = item.slice(DEPARTMENT_ALIAS_PREFIX.length).trim();
      if (name) {
        return name;
      }
    }
  }
  return null;
}

/** SCIM Group membership marker; also drives FinOps team_id when no User.department. */
export function scimGroupAlias(teamId: string): string {
  return `${SCIM_GROUP_ALIAS_PREFIX}${teamId}`;
}

/** Team ids recorded via `scim-group:` aliases, in alias-list order. */
export function scimGroupTeamIdsFromAliases(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.startsWith(SCIM_GROUP_ALIAS_PREFIX)) {
      const id = item.slice(SCIM_GROUP_ALIAS_PREFIX.length).trim();
      if (id) {
        out.push(id);
      }
    }
  }
  return out;
}

export function mergeScimGroupAlias(raw: unknown, teamId: string): unknown[] {
  const marker = scimGroupAlias(teamId);
  const existing = Array.isArray(raw) ? [...raw] : [];
  if (existing.some((item) => item === marker)) {
    return existing;
  }
  return [...existing, marker];
}

export function removeScimGroupAlias(raw: unknown, teamId: string): unknown[] {
  const marker = scimGroupAlias(teamId);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item) => item !== marker);
}

export function hasScimGroupAlias(raw: unknown, teamId: string): boolean {
  const marker = scimGroupAlias(teamId);
  return Array.isArray(raw) && raw.some((item) => item === marker);
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

/** Member refs from a Group PATCH op (value array or Entra path filter). */
export function memberIdsFromPatchOp(op: PatchOp): string[] {
  if (Array.isArray(op.value)) {
    return (op.value as { value?: string }[])
      .map((m) => m.value)
      .filter((v): v is string => typeof v === 'string');
  }
  const path = op.path ?? '';
  const m = /members\[\s*value\s+eq\s+"([^"]+)"\s*\]/i.exec(path);
  return m ? [m[1]] : [];
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
  // Entra usually sends the PatchOp schema; some clients omit it but still send Operations.
  const ops = (body.Operations ?? body.operations) as Record<string, unknown>[] | undefined;
  if (schemas && schemas.length > 0 && !schemas.includes(PATCH_SCHEMA) && !Array.isArray(ops)) {
    throw new Error('not a PatchOp');
  }
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
 * `userName`, `externalId`, and enterprise `department` (→ team name).
 */
export function applyUserPatch(ops: PatchOp[]): {
  email?: string;
  displayName?: string;
  externalId?: string;
  active?: boolean;
  department?: string;
} {
  const out: {
    email?: string;
    displayName?: string;
    externalId?: string;
    active?: boolean;
    department?: string;
  } = {};
  const setAttr = (path: string, value: unknown) => {
    const p = path.toLowerCase();
    switch (p) {
      case 'active':
        out.active = typeof value === 'boolean' ? value : String(value).toLowerCase() === 'true';
        break;
      case 'displayname':
      case 'name.formatted':
        out.displayName = String(value);
        break;
      case 'username': {
        const raw = String(value).trim();
        if (isEmailLike(raw)) {
          out.email = raw.toLowerCase();
        } else if (raw) {
          // Entra objectId-as-userName must not overwrite identities.email.
          out.externalId = raw;
        }
        break;
      }
      case 'externalid':
        out.externalId = String(value);
        break;
      case 'department':
      case `${ENTERPRISE_USER.toLowerCase()}:department`:
        if (typeof value === 'string' && value.trim()) {
          out.department = value.trim();
        }
        break;
      default:
        // Nested enterprise object on a no-path replace.
        if (p === ENTERPRISE_USER.toLowerCase() && value && typeof value === 'object') {
          const dept = (value as { department?: unknown }).department;
          if (typeof dept === 'string' && dept.trim()) {
            out.department = dept.trim();
          }
        }
        // title, phoneNumbers, addresses, name.givenName, etc. ignored.
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
