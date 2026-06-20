import { Body, Controller, Delete, Get, Logger, Param, Post, Query } from '@nestjs/common';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { Roles } from '../auth/decorators';
import { ChParam, ClickHouseService } from '../clickhouse/clickhouse.service';
import { CrudService } from '../common/crud.service';
import { parsePagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

class CreateAllowDto {
  @IsUUID() agentId!: string;
  @IsString() toolName!: string;
  @IsOptional() @IsString() mcpServer?: string;
}

/**
 * Per-agent tool/MCP allowlist (Phase 5 governance). Postgres is the source of
 * truth (RLS, audit); each write is projected into the ClickHouse agent_tool_allow
 * table the risk-engine reads — allowed=1 on create, allowed=0 (tombstone) on
 * delete, so a removed entry stops permitting the tool.
 */
@Controller('v1/agent-tool-allowlist')
export class AgentToolAllowlistController {
  private readonly logger = new Logger(AgentToolAllowlistController.name);
  private readonly crud: CrudService;
  constructor(
    prisma: PrismaService,
    private readonly ch: ClickHouseService,
  ) {
    this.crud = new CrudService(prisma, {
      model: 'agentToolAllowlist',
      idField: 'allowId',
      object: 'agent_tool_allowlist',
    });
  }

  @Roles('viewer') @Get()
  list(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.crud.list(parsePagination(limit, offset));
  }

  @Roles('admin') @Post()
  async create(@Body() dto: CreateAllowDto) {
    const created = await this.crud.create({ ...dto });
    await this.project(created, 1);
    return created;
  }

  @Roles('admin') @Delete(':id')
  async remove(@Param('id') id: string) {
    const before = await this.crud.get(id); // 404s under RLS if another tenant's
    const result = await this.crud.remove(id);
    await this.project(before, 0);
    return result;
  }

  // Upsert the (tenant, agent, tool) allow state into ClickHouse. Best-effort:
  // the Postgres row is already committed, so a ClickHouse outage logs rather than
  // failing the request (the entry can be re-projected by re-saving).
  private async project(row: { tenantId: string; agentId: string; toolName: string }, allowed: 0 | 1): Promise<void> {
    const params: Record<string, ChParam> = {
      tenant: row.tenantId,
      agent: row.agentId,
      tool: row.toolName,
      allowed,
    };
    try {
      await this.ch.command(
        `INSERT INTO agentledger.agent_tool_allow (tenant_id, agent_id, tool_name, allowed, updated_at)
         VALUES ({tenant:String}, {agent:String}, {tool:String}, {allowed:UInt8}, now64(3))`,
        params,
      );
    } catch (err) {
      this.logger.warn(`agent_tool_allow projection failed for ${row.agentId}/${row.toolName}: ${String(err)}`);
    }
  }
}
