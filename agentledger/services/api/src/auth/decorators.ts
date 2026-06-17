import { SetMetadata } from '@nestjs/common';

/** Marks a route (or controller) as not requiring authentication. */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Restricts a route (or controller) to the listed API roles (min-rank semantics). */
export const ROLES_KEY = 'roles';
export type ApiRole = 'viewer' | 'analyst' | 'admin';
export const Roles = (...roles: ApiRole[]) => SetMetadata(ROLES_KEY, roles);

/** Role hierarchy: admin ⊇ analyst ⊇ viewer. */
export const ROLE_RANK: Record<string, number> = { viewer: 1, analyst: 2, admin: 3 };
