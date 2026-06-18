import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getPrincipal } from '../tenant/tenant-context';
import { IS_PUBLIC_KEY } from './decorators';

/**
 * Global authentication gate. Allows @Public routes; otherwise requires an
 * authenticated principal (a bound tenant). The principal is set by
 * AuthMiddleware, which has already run inside this request's async context.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    const principal = getPrincipal();
    if (!principal || !principal.tenantId) {
      throw new UnauthorizedException('authentication required');
    }
    return true;
  }
}
