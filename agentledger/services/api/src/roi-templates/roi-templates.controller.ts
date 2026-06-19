import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Roles } from '../auth/decorators';
import { CrudService } from '../common/crud.service';
import { parsePagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

// Match the outcome connectors (ADR-016/017) and the outcomes schema.
const OUTCOME_TYPES = ['pr_merged', 'ticket_resolved', 'issue_closed'];
const SOURCE_SYSTEMS = ['github', 'jira', 'zendesk', 'manual', 'api'];
const MATCH_ON = ['branch', 'user', 'issue'];

// value_formula JSONB — turns an outcome into business_value_usd (applied later,
// task 5). rework_pct is optional; the others are required.
class ValueFormulaDto {
  @IsNumber() hourly_rate!: number;
  @IsNumber() baseline_minutes!: number;
  @IsOptional() @IsNumber() rework_pct?: number;
}

// attribution JSONB — overrides for the attribution matcher (ADR-018).
class AttributionDto {
  @IsOptional() @IsInt() window_minutes?: number;
  @IsOptional() @IsArray() @IsIn(MATCH_ON, { each: true }) match_on?: string[];
}

class CreateRoiTemplateDto {
  @IsString() name!: string;
  @IsIn(OUTCOME_TYPES) outcomeType!: string;
  @IsIn(SOURCE_SYSTEMS) sourceSystem!: string;
  @IsObject() @ValidateNested() @Type(() => ValueFormulaDto) valueFormula!: ValueFormulaDto;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => AttributionDto) attribution?: AttributionDto;
}

class UpdateRoiTemplateDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsIn(OUTCOME_TYPES) outcomeType?: string;
  @IsOptional() @IsIn(SOURCE_SYSTEMS) sourceSystem?: string;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => ValueFormulaDto) valueFormula?: ValueFormulaDto;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => AttributionDto) attribution?: AttributionDto;
}

@Controller('v1/roi-templates')
export class RoiTemplatesController {
  private readonly crud: CrudService;
  constructor(prisma: PrismaService) {
    this.crud = new CrudService(prisma, {
      model: 'roiTemplate',
      idField: 'templateId',
      object: 'roi_template',
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
  create(@Body() dto: CreateRoiTemplateDto) {
    return this.crud.create({ ...dto });
  }

  @Roles('admin') @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateRoiTemplateDto) {
    return this.crud.update(id, { ...dto });
  }

  @Roles('admin') @Delete(':id')
  remove(@Param('id') id: string) {
    return this.crud.remove(id);
  }
}
