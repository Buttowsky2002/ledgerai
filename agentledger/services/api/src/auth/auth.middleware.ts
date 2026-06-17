import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { Principal, runWithTenant } from '../tenant/tenant-context';
import { JwtService } from './jwt.service';

const ANONYMOUS: Principal = { tenantId: null, userId: null, role: null };

/**
 * Resolves the request principal and binds it to the async context for the rest
 * of the pipeline (guards + handler + the RLS-scoped transaction all read it).
 *
 * Order of resolution:
 *  1. `Authorization: Bearer <access JWT>` → verified principal.
 *  2. Dev fallback (only when AGENTLEDGER_DEV_TRUST_HEADER=true and no Bearer):
 *     `x-tenant-id` header → dev admin principal, so local dev / the task-1
 *     isolation suite keep working without real login.
 *  3. Otherwise anonymous → AuthGuard 401s any non-@Public route.
 *
 * An invalid/expired Bearer token resolves to anonymous (→ 401 at the guard)
 * rather than throwing here, keeping a single enforcement point.
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  private readonly trustHeader = process.env.AGENTLEDGER_DEV_TRUST_HEADER === 'true';

  constructor(private readonly jwt: JwtService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    let principal: Principal = ANONYMOUS;

    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      try {
        principal = await this.jwt.verifyAccess(auth.slice(7).trim());
      } catch {
        principal = ANONYMOUS;
      }
    } else if (this.trustHeader) {
      const header = req.headers['x-tenant-id'];
      if (typeof header === 'string' && header.trim() !== '') {
        principal = { tenantId: header.trim(), userId: null, role: 'admin' };
      }
    }

    runWithTenant(principal, () => next());
  }
}
