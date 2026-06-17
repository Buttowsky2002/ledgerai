import { Controller, Get } from '@nestjs/common';
import { TeamsService } from './teams.service';

@Controller('v1/teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  /** List teams visible to the current tenant (RLS-scoped). */
  @Get()
  async list() {
    return this.teams.list();
  }
}
