import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsDateString, IsObject, IsOptional, IsString } from 'class-validator';
import { Roles } from '../auth/decorators';
import { parsePagination } from '../common/pagination';
import { ConnectorDefinitionsService } from './connector-definitions.service';
import { ConnectorsService } from './connectors.service';
import { ConnectorDefinition } from './types/connector-definition';

class CreateConnectorDto {
  @IsOptional() @IsString() connectorDefinitionId?: string;
  @IsOptional() @IsString() presetId?: string;
  @IsString() displayName!: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsObject() configJson?: Record<string, unknown>;
  @IsOptional() @IsObject() mappingOverridesJson?: Record<string, unknown>;
  @IsOptional() @IsObject() scheduleJson?: Record<string, unknown>;
  @IsOptional() @IsString() authSecret?: string;
  @IsOptional() @IsString() baseUrl?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class UpdateConnectorDto {
  @IsOptional() @IsString() displayName?: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsObject() configJson?: Record<string, unknown>;
  @IsOptional() @IsObject() mappingOverridesJson?: Record<string, unknown>;
  @IsOptional() @IsObject() scheduleJson?: Record<string, unknown>;
  @IsOptional() @IsString() authSecret?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class TestConnectorDto {
  @IsOptional() @IsString() authSecret?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

class CreateCustomDefinitionDto {
  @IsObject() definition!: ConnectorDefinition;
}

@Controller('v1/connector-definitions')
export class ConnectorDefinitionsController {
  constructor(private readonly defs: ConnectorDefinitionsService) {}

  @Roles('viewer') @Get()
  list() {
    return this.defs.list();
  }

  @Roles('admin') @Post('custom')
  createCustom(@Body() dto: CreateCustomDefinitionDto) {
    return this.defs.createCustom(dto.definition);
  }
}

@Controller('v1/connectors')
export class ConnectorsController {
  constructor(private readonly connectors: ConnectorsService) {}

  @Roles('viewer') @Get()
  list(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.connectors.list(parsePagination(limit, offset));
  }

  @Roles('viewer') @Get(':id')
  get(@Param('id') id: string) {
    return this.connectors.get(id);
  }

  @Roles('admin') @Post()
  create(@Body() dto: CreateConnectorDto) {
    return this.connectors.create(dto);
  }

  @Roles('admin') @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateConnectorDto) {
    return this.connectors.update(id, dto);
  }

  @Roles('admin') @Delete(':id')
  delete(@Param('id') id: string) {
    return this.connectors.delete(id);
  }

  @Roles('admin') @Post(':id/test')
  test(@Param('id') id: string, @Body() dto: TestConnectorDto) {
    return this.connectors.testConnection(id, dto.authSecret);
  }

  @Roles('admin') @Post(':id/preview')
  preview(@Param('id') id: string, @Body() dto: TestConnectorDto) {
    return this.connectors.preview(id, dto.authSecret, { from: dto.from, to: dto.to });
  }

  @Roles('admin') @Post(':id/sync')
  sync(@Param('id') id: string, @Body() dto: TestConnectorDto) {
    return this.connectors.sync(id, { from: dto.from, to: dto.to });
  }

  @Roles('viewer') @Get(':id/sync-runs')
  syncRuns(@Param('id') id: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.connectors.listSyncRuns(id, parsePagination(limit, offset));
  }

  @Roles('viewer') @Get(':id/errors')
  errors(@Param('id') id: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.connectors.listErrors(id, parsePagination(limit, offset));
  }
}
