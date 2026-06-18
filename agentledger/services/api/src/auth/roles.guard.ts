import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getPrincipal } from '../tenant/tenant-context';
import { ApiRole, ROLES_KEY, ROLE_RANK } from './decorators';

/**
 * RBAC gate. Runs after AuthGuard. A route with no @Roles() is open to any
 * authenticated user. @Roles('analyst') admits analyst and admin (min-rank
 * hierarchy: admin ⊇ analyst ⊇ viewer).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<ApiRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }
    const role = getPrincipal()?.role;
    const have = role ? (ROLE_RANK[role] ?? 0) : 0;
    const need = Math.min(...required.map((r) => ROLE_RANK[r] ?? Infinity));
    if (have < need) {
      throw new ForbiddenException('insufficient role');
    }
    return true;
  }
}
