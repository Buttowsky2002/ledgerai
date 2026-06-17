import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsOptional, IsString, IsUUID } from 'class-validator';
import { Roles } from '../auth/decorators';
import { CrudService } from '../common/crud.service';
import { parsePagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

class CreateAgentDto {
  @IsString() name!: string;
  @IsOptional() @IsUUID() appId?: string;
  @IsOptional() @IsString() runtimeType?: string;
  @IsOptional() @IsUUID() ownerUserId?: string;
  @IsOptional() @IsArray() dataAccessScope?: unknown[];
  @IsOptional() @IsArray() connectedTools?: unknown[];
  @IsOptional() @IsString() approvalStatus?: string;
  @IsOptional() @IsString() riskPosture?: string;
}

class UpdateAgentDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsUUID() appId?: string;
  @IsOptional() @IsString() runtimeType?: string;
  @IsOptional() @IsUUID() ownerUserId?: string;
  @IsOptional() @IsArray() dataAccessScope?: unknown[];
  @IsOptional() @IsArray() connectedTools?: unknown[];
  @IsOptional() @IsString() approvalStatus?: string;
  @IsOptional() @IsString() riskPosture?: string;
}

@Controller('v1/agents')
export class AgentsController {
  private readonly crud: CrudService;
  constructor(prisma: PrismaService) {
    this.crud = new CrudService(prisma, { model: 'agent', idField: 'agentId', object: 'agent' });
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
  create(@Body() dto: CreateAgentDto) {
    return this.crud.create({ ...dto });
  }

  @Roles('admin') @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAgentDto) {
    return this.crud.update(id, { ...dto });
  }

  @Roles('admin') @Delete(':id')
  remove(@Param('id') id: string) {
    return this.crud.remove(id);
  }
}
