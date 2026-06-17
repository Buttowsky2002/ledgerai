import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString } from 'class-validator';
import { Roles } from '../auth/decorators';
import { CrudService } from '../common/crud.service';
import { parsePagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

const SCOPE_TYPES = ['tenant', 'team', 'app', 'agent', 'key', 'model'];
const PERIODS = ['monthly', 'quarterly'];

class CreateBudgetDto {
  @IsIn(SCOPE_TYPES) scopeType!: string;
  @IsString() scopeId!: string;
  @IsNumber() amountUsd!: number;
  @IsOptional() @IsIn(PERIODS) period?: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) alertPcts?: number[];
  @IsOptional() @IsBoolean() hardLimit?: boolean;
}

class UpdateBudgetDto {
  @IsOptional() @IsIn(SCOPE_TYPES) scopeType?: string;
  @IsOptional() @IsString() scopeId?: string;
  @IsOptional() @IsNumber() amountUsd?: number;
  @IsOptional() @IsIn(PERIODS) period?: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) alertPcts?: number[];
  @IsOptional() @IsBoolean() hardLimit?: boolean;
}

@Controller('v1/budgets')
export class BudgetsController {
  private readonly crud: CrudService;
  constructor(prisma: PrismaService) {
    this.crud = new CrudService(prisma, { model: 'budget', idField: 'budgetId', object: 'budget' });
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
  create(@Body() dto: CreateBudgetDto) {
    return this.crud.create({ ...dto });
  }

  @Roles('admin') @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateBudgetDto) {
    return this.crud.update(id, { ...dto });
  }

  @Roles('admin') @Delete(':id')
  remove(@Param('id') id: string) {
    return this.crud.remove(id);
  }
}
