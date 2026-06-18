import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsIn, IsObject, IsOptional, IsString } from 'class-validator';
import { Roles } from '../auth/decorators';
import { CrudService } from '../common/crud.service';
import { parsePagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

const KINDS = ['dlp', 'budget', 'model_allow', 'approval'];
const ACTIONS = ['allow', 'log', 'warn', 'redact', 'block', 'ticket'];
const FAIL_MODES = ['open', 'closed'];

class CreatePolicyDto {
  @IsString() name!: string;
  @IsIn(KINDS) kind!: string;
  @IsIn(ACTIONS) action!: string;
  @IsOptional() @IsObject() scope?: Record<string, unknown>;
  @IsOptional() @IsObject() condition?: Record<string, unknown>;
  @IsOptional() @IsString() severity?: string;
  @IsOptional() @IsIn(FAIL_MODES) failMode?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class UpdatePolicyDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsIn(KINDS) kind?: string;
  @IsOptional() @IsIn(ACTIONS) action?: string;
  @IsOptional() @IsObject() scope?: Record<string, unknown>;
  @IsOptional() @IsObject() condition?: Record<string, unknown>;
  @IsOptional() @IsString() severity?: string;
  @IsOptional() @IsIn(FAIL_MODES) failMode?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

@Controller('v1/policies')
export class PoliciesController {
  private readonly crud: CrudService;
  constructor(prisma: PrismaService) {
    this.crud = new CrudService(prisma, { model: 'policy', idField: 'policyId', object: 'policy' });
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
  create(@Body() dto: CreatePolicyDto) {
    return this.crud.create({ ...dto });
  }

  @Roles('admin') @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePolicyDto) {
    return this.crud.update(id, { ...dto });
  }

  @Roles('admin') @Delete(':id')
  remove(@Param('id') id: string) {
    return this.crud.remove(id);
  }
}
