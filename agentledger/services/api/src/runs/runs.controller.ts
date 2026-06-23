import { Controller, Get, Param } from '@nestjs/common';
import { Roles } from '../auth/decorators';
import { RunsService } from './runs.service';

@Controller('v1/runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Roles('viewer') @Get(':id')
  get(@Param('id') id: string) {
    return this.runs.get(id);
  }
}
