import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';
import { Principal, runWithTenant } from '../tenant/tenant-context';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';

describe('InvitesController', () => {
  let controller: InvitesController;
  let invites: {
    create: jest.Mock;
    list: jest.Mock;
    revoke: jest.Mock;
    resolve: jest.Mock;
    accept: jest.Mock;
  };

  beforeEach(() => {
    invites = {
      create: jest.fn(),
      list: jest.fn(),
      revoke: jest.fn(),
      resolve: jest.fn(),
      accept: jest.fn(),
    };
    controller = new InvitesController(invites as unknown as InvitesService);
  });

  it('admin create returns inviteId + link from the service', async () => {
    invites.create.mockResolvedValue({ inviteId: 'inv-1', link: 'https://app/invite/accept?token=abc' });
    await expect(controller.create({ email: 'a@b.com', apiRole: 'viewer' })).resolves.toEqual({
      inviteId: 'inv-1',
      link: 'https://app/invite/accept?token=abc',
    });
  });

  it('public resolve returns email + role', async () => {
    invites.resolve.mockResolvedValue({
      inviteId: 'inv-1',
      email: 'a@b.com',
      apiRole: 'analyst',
      expiresAt: new Date('2026-08-01'),
    });
    await expect(controller.resolve('a'.repeat(40))).resolves.toMatchObject({
      email: 'a@b.com',
      apiRole: 'analyst',
    });
  });

  it('public resolve surfaces NotFound from service', async () => {
    const { NotFoundException } = await import('@nestjs/common');
    invites.resolve.mockRejectedValue(new NotFoundException('gone'));
    await expect(controller.resolve('b'.repeat(40))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('public accept returns email + tenantId', async () => {
    invites.accept.mockResolvedValue({ email: 'a@b.com', tenantId: 't1' });
    await expect(
      controller.accept({ token: 'c'.repeat(40), displayName: 'Alex' }),
    ).resolves.toEqual({ email: 'a@b.com', tenantId: 't1' });
  });

  it('public accept surfaces BadRequest for already-used token', async () => {
    const { BadRequestException } = await import('@nestjs/common');
    invites.accept.mockRejectedValue(new BadRequestException('invalid or expired invite token'));
    await expect(controller.accept({ token: 'd'.repeat(40) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('InvitesController route metadata', () => {
  it('create / list / revoke require admin', () => {
    expect(Reflect.getMetadata(ROLES_KEY, InvitesController.prototype.create)).toEqual(['admin']);
    expect(Reflect.getMetadata(ROLES_KEY, InvitesController.prototype.list)).toEqual(['admin']);
    expect(Reflect.getMetadata(ROLES_KEY, InvitesController.prototype.revoke)).toEqual(['admin']);
  });

  it('accept endpoints are public', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, InvitesController.prototype.resolve)).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, InvitesController.prototype.accept)).toBe(true);
  });
});

describe('RolesGuard on invite create (viewer → 403)', () => {
  function fakeContext(handler: object) {
    return {
      getHandler: () => handler,
      getClass: () => InvitesController,
    } as never;
  }

  it('forbids viewer from admin-only create', () => {
    const guard = new RolesGuard(new Reflector());
    const viewer: Principal = {
      tenantId: 't1',
      userId: 'u1',
      role: 'viewer',
    };
    expect(() =>
      runWithTenant(viewer, () =>
        guard.canActivate(fakeContext(InvitesController.prototype.create)),
      ),
    ).toThrow(ForbiddenException);
  });

  it('allows admin on create', () => {
    const guard = new RolesGuard(new Reflector());
    const admin: Principal = {
      tenantId: 't1',
      userId: 'u1',
      role: 'admin',
    };
    expect(
      runWithTenant(admin, () =>
        guard.canActivate(fakeContext(InvitesController.prototype.create)),
      ),
    ).toBe(true);
  });
});
