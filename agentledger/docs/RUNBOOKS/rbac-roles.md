# BadgerIQ RBAC Roles

## API Roles (gate control-plane actions)

| Role      | Access |
|-----------|--------|
| `viewer`  | Read dashboards, reports, analytics, user list. No write access. |
| `analyst` | All of viewer + modify attribution rules, run ad-hoc queries, manage allocation rules. |
| `admin`   | All of analyst + manage users, send/revoke invites, manage connectors, budgets, policies, virtual keys, and tenant settings. |

Role hierarchy: `admin ⊇ analyst ⊇ viewer`.
Changes take effect on the next access-token refresh (~15 min) or after sign-out/sign-in.

## Who can invite users?

Only users with the `admin` API role can send invites.
The Invite button is hidden from `viewer` and `analyst` roles in the Settings → Permissions tab.

## Invite flow

1. Admin opens Settings → Permissions → "Invite member".
2. Admin enters the invitee's email and selects their role.
3. The invitee receives a link valid for 7 days.
4. Invitee clicks the link, sets their display name, and accepts.
5. The identity is provisioned in the DB.
6. Invitee authenticates via Google or Microsoft OIDC.
7. `loginByEmail` finds the provisioned identity → session issued.

Users who have not been invited **cannot log in**, even with a valid OIDC token.
