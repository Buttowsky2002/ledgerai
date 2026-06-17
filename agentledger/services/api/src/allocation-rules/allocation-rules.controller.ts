import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { Roles } from '../auth/decorators';
import { CrudService } from '../common/crud.service';
import { parsePagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

const TARGET_TYPES = ['team', 'cost_center', 'project', 'customer'];

class CreateAllocationRuleDto {
  @IsObject() matchingLogic!: Record<string, unknown>;
  @IsIn(TARGET_TYPES) targetType!: string;
  @IsString() targetId!: string;
  @IsOptional() @IsInt() priority?: number;
  @IsOptional() @IsNumber() splitPct?: number;
  @IsOptional() @IsDateString() effectiveStart?: string;
  @IsOptional() @IsDateString() effectiveEnd?: string;
  @IsOptional() @IsUUID() ownerUserId?: string;
}

class UpdateAllocationRuleDto {
  @IsOptional() @IsObject() matchingLogic?: Record<string, unknown>;
  @IsOptional() @IsIn(TARGET_TYPES) targetType?: string;
  @IsOptional() @IsString() targetId?: string;
  @IsOptional() @IsInt() priority?: number;
  @IsOptional() @IsNumber() splitPct?: number;
  @IsOptional() @IsDateString() effectiveStart?: string;
  @IsOptional() @IsDateString() effectiveEnd?: string;
  @IsOptional() @IsUUID() ownerUserId?: string;
}

@Controller('v1/allocation-rules')
export class AllocationRulesController {
  private readonly crud: CrudService;
  constructor(prisma: PrismaService) {
    this.crud = new CrudService(prisma, {
      model: 'allocationRule',
      idField: 'ruleId',
      object: 'allocation_rule',
    });
  }

  @Roles('viewer') @Get()
  list(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.crud.list(parsePagination(limit, offset));
  }

  @Roles('viewer') @Get(':id')
  get(@Param('id') id: string) {
    return this.crud.get(id);
  }

  @Roles('admin') @Post()
  create(@Body() dto: CreateAllocationRuleDto) {
    return this.crud.create({ ...dto });
  }

  @Roles('admin') @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAllocationRuleDto) {
    return this.crud.update(id, { ...dto });
  }

  @Roles('admin') @Delete(':id')
  remove(@Param('id') id: string) {
    return this.crud.remove(id);
  }
}
