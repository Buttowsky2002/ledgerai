import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { runWithTenant } from './tenant-context';

/**
 * Establishes the per-request tenant context.
 *
 * STAND-IN until Phase 3 task 2 (OIDC/JWT): the tenant id is taken from the
 * `x-tenant-id` header, but ONLY when AGENTLEDGER_DEV_TRUST_HEADER=true. In any
 * other configuration the header is ignored and the request runs with no tenant
 * context, which RLS treats as "see nothing" (fail closed). Task 2 replaces the
 * header source with verified JWT claims; the RLS plumbing it feeds is permanent.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  private readonly trustHeader = process.env.AGENTLEDGER_DEV_TRUST_HEADER === 'true';

  use(req: Request, _res: Response, next: NextFunction): void {
    let tenantId: string | null = null;
    if (this.trustHeader) {
      const header = req.headers['x-tenant-id'];
      if (typeof header === 'string' && header.trim() !== '') {
        tenantId = header.trim();
      }
    }
    // Bind the context around the rest of the request pipeline.
    runWithTenant(tenantId, () => next());
  }
}
