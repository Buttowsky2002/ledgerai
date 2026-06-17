import { Controller, Get } from '@nestjs/common';
import { Roles } from '../auth/decorators';
import { TeamsService } from './teams.service';

@Controller('v1/teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  /**
   * List teams visible to the current tenant (RLS-scoped). Requires at least
   * `analyst` — exercises RBAC end to end (a `viewer` token gets 403).
   */
  @Roles('analyst')
  @Get()
  async list() {
    return this.teams.list();
  }
}
