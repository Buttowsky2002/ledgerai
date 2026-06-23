import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Roles } from '../auth/decorators';
import { CreateOutcomeDto, ListOutcomesQueryDto } from './outcomes.dto';
import { OutcomesService } from './outcomes.service';

@Controller('v1/outcomes')
export class OutcomesController {
  constructor(private readonly outcomes: OutcomesService) {}

  @Roles('viewer') @Get()
  list(@Query() q: ListOutcomesQueryDto) {
    return this.outcomes.list(q);
  }

  @Roles('analyst') @Post()
  create(@Body() dto: CreateOutcomeDto) {
    return this.outcomes.create(dto);
  }
}
