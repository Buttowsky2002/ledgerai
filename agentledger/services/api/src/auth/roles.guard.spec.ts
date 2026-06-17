import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiRole } from './decorators';
import { runWithTenant } from '../tenant/tenant-context';
import { RolesGuard } from './roles.guard';

function ctx(): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function guardWithRequired(required: ApiRole[] | undefined): RolesGuard {
  const reflector = { getAllAndOverride: () => required } as unknown as Reflector;
  return new RolesGuard(reflector);
}

describe('RolesGuard (admin ⊇ analyst ⊇ viewer)', () => {
  it('allows any authenticated user when no @Roles is set', () => {
    const guard = guardWithRequired(undefined);
    const ok = runWithTenant({ tenantId: 't', userId: 'u', role: 'viewer' }, () =>
      guard.canActivate(ctx()),
    );
    expect(ok).toBe(true);
  });

  it('admits a higher role than required', () => {
    const guard = guardWithRequired(['analyst']);
    const ok = runWithTenant({ tenantId: 't', userId: 'u', role: 'admin' }, () =>
      guard.canActivate(ctx()),
    );
    expect(ok).toBe(true);
  });

  it('admits the exact required role', () => {
    const guard = guardWithRequired(['analyst']);
    const ok = runWithTenant({ tenantId: 't', userId: 'u', role: 'analyst' }, () =>
      guard.canActivate(ctx()),
    );
    expect(ok).toBe(true);
  });

  it('forbids a lower role', () => {
    const guard = guardWithRequired(['analyst']);
    expect(() =>
      runWithTenant({ tenantId: 't', userId: 'u', role: 'viewer' }, () =>
        guard.canActivate(ctx()),
      ),
    ).toThrow(ForbiddenException);
  });

  it('forbids when there is no role', () => {
    const guard = guardWithRequired(['viewer']);
    expect(() =>
      runWithTenant({ tenantId: 't', userId: 'u', role: null }, () => guard.canActivate(ctx())),
    ).toThrow(ForbiddenException);
  });
});
