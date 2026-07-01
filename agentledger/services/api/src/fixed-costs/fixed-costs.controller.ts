import { Body, Controller, Delete, Get, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '../auth/decorators';
import {
  CreateFixedCostDto,
  DeleteFixedCostDto,
  ListFixedCostsQueryDto,
  UpdateFixedCostDto,
} from './fixed-costs.dto';
import { FixedCostsService } from './fixed-costs.service';

/**
 * Manual fixed / recurring AI overhead (seat licenses, subscriptions, platform fees).
 * Un-attributable — never assigned to agents or outcomes. Writes land in ClickHouse
 * fixed_costs; totals surface via v_total_cost_of_ai.
 */
@Controller('v1/fixed-costs')
export class FixedCostsController {
  constructor(private readonly fixedCosts: FixedCostsService) {}

  @Roles('viewer')
  @Get()
  list(@Query() q: ListFixedCostsQueryDto) {
    return this.fixedCosts.list(q);
  }

  @Roles('viewer')
  @Get('monthly')
  monthly(@Query() q: ListFixedCostsQueryDto) {
    return this.fixedCosts.monthlySummary(q.from, q.to);
  }

  @Roles('viewer')
  @Get('total-cost-of-ai')
  totalCostOfAi(@Query() q: ListFixedCostsQueryDto) {
    return this.fixedCosts.totalCostOfAi(q.from, q.to);
  }

  @Roles('admin')
  @Post()
  create(@Body() dto: CreateFixedCostDto) {
    return this.fixedCosts.create(dto);
  }

  @Roles('admin')
  @Patch()
  update(@Body() dto: UpdateFixedCostDto) {
    return this.fixedCosts.update(dto);
  }

  @Roles('admin')
  @Delete()
  remove(@Body() dto: DeleteFixedCostDto) {
    return this.fixedCosts.remove(dto);
  }
}
