import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public, Roles } from '../auth/decorators';
import { AcceptInviteDto, CreateInviteDto } from './invites.dto';
import { InvitesService } from './invites.service';

@Controller('v1/invites')
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  /** Admin only: send an invite. Returns the invite link (email delivery later). */
  @Roles('admin')
  @Post()
  create(@Body() dto: CreateInviteDto) {
    return this.invites.create(dto);
  }

  /** Admin only: list all invites for this tenant. */
  @Roles('admin')
  @Get()
  list() {
    return this.invites.list();
  }

  /** Admin only: revoke a pending invite. */
  @Roles('admin')
  @Delete(':id')
  @HttpCode(204)
  async revoke(@Param('id') id: string) {
    await this.invites.revoke(id);
  }

  /**
   * Public: resolve a token (GET /v1/invites/accept?token=...).
   * Called by the accept page to show the user's email and chosen role.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('accept')
  resolve(@Query('token') token: string) {
    return this.invites.resolve(token);
  }

  /**
   * Public: submit the accept form (POST /v1/invites/accept).
   * Creates the identity row and marks the invite used.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('accept')
  accept(@Body() dto: AcceptInviteDto) {
    return this.invites.accept(dto.token, dto.displayName);
  }
}
