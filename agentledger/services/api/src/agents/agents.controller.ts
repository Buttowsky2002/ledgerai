import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsOptional, IsString, IsUUID } from 'class-validator';
import { AgentRoiService } from './agent-roi.service';
import { LariService } from '../lari/lari.service';
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
  constructor(
    prisma: PrismaService,
    private readonly agentRoi: AgentRoiService,
    private readonly lari: LariService,
  ) {
    this.crud = new CrudService(prisma, { model: 'agent', idField: 'agentId', object: 'agent' });
  }

  @Roles('viewer') @Get()
  list(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.crud.list(parsePagination(limit, offset));
  }

  // Per-agent finance-grade ROI (cost → outcome economics). Declared before
  // ':id' is irrelevant for distinct sub-paths, but ':id/roi' is a separate route.
  @Roles('viewer') @Get(':id/roi')
  roi(@Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.agentRoi.agentRoi(id, from, to);
  }

  // LARI — risk-adjusted incremental ROI with confidence + recommendation + ledger.
  @Roles('viewer') @Get(':id/lari')
  lariRoi(@Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.lari.computeForAgent(id, from, to);
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
