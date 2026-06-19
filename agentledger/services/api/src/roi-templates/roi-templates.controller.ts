import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, Query } from '@nestjs/common';
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
import { ChParam, ClickHouseService } from '../clickhouse/clickhouse.service';
import { CrudService } from '../common/crud.service';
import { parsePagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

// Match the outcome connectors (ADR-016/017) and the outcomes schema.
const OUTCOME_TYPES = ['pr_merged', 'ticket_resolved', 'issue_closed'];
const SOURCE_SYSTEMS = ['github', 'jira', 'zendesk', 'manual', 'api'];
const MATCH_ON = ['branch', 'user', 'issue'];

// value_formula JSONB — the finance inputs the ROI engine (v_roi) applies per
// outcome. hourly_rate + baseline_minutes give the pre-agent (baseline) value;
// the rest tune rework, redeployment and fully-loaded cost. Only the first two
// are required; the rest default in v_roi (rework 0, redeployment 1, costs 0).
class ValueFormulaDto {
  @IsNumber() hourly_rate!: number;
  @IsNumber() baseline_minutes!: number;
  @IsOptional() @IsNumber() rework_pct?: number;
  @IsOptional() @IsNumber() redeployment_factor?: number; // 1 full | 0.5 partial | 0 deferred
  @IsOptional() @IsNumber() qa_cost_per_outcome?: number;
  @IsOptional() @IsNumber() eval_cost_per_outcome?: number;
  @IsOptional() @IsNumber() integration_cost_per_outcome?: number;
  @IsOptional() @IsNumber() platform_overhead_pct?: number;
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
  private readonly logger = new Logger(RoiTemplatesController.name);
  private readonly crud: CrudService;
  constructor(
    prisma: PrismaService,
    private readonly ch: ClickHouseService,
  ) {
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
  async create(@Body() dto: CreateRoiTemplateDto) {
    const created = await this.crud.create({ ...dto });
    await this.projectRates(created);
    return created;
  }

  @Roles('admin') @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateRoiTemplateDto) {
    const after = await this.crud.update(id, { ...dto });
    await this.projectRates(after);
    return after;
  }

  @Roles('admin') @Delete(':id')
  remove(@Param('id') id: string) {
    return this.crud.remove(id);
  }

  // Project the template's value_formula into the ClickHouse roi_rates table so
  // the v_roi engine can apply it by (tenant, source_system, outcome_type).
  // Best-effort: the template is already committed in Postgres, so a transient
  // ClickHouse outage must not fail the request — log and move on (the rate can
  // be re-projected by re-saving the template).
  private async projectRates(t: {
    tenantId: string;
    sourceSystem: string;
    outcomeType: string;
    valueFormula: unknown;
  }): Promise<void> {
    const f = (t.valueFormula ?? {}) as Record<string, number | undefined>;
    const params: Record<string, ChParam> = {
      tenant: t.tenantId,
      ssys: t.sourceSystem,
      otype: t.outcomeType,
      hr: f.hourly_rate ?? 0,
      bm: f.baseline_minutes ?? 0,
      rw: f.rework_pct ?? 0,
      rd: f.redeployment_factor ?? 1,
      qa: f.qa_cost_per_outcome ?? 0,
      ev: f.eval_cost_per_outcome ?? 0,
      ig: f.integration_cost_per_outcome ?? 0,
      po: f.platform_overhead_pct ?? 0,
    };
    try {
      await this.ch.command(
        `INSERT INTO agentledger.roi_rates
           (tenant_id, source_system, outcome_type, hourly_rate, baseline_minutes,
            rework_pct, redeployment_factor, qa_cost_per_outcome, eval_cost_per_outcome,
            integration_cost_per_outcome, platform_overhead_pct, updated_at)
         VALUES
           ({tenant:String}, {ssys:String}, {otype:String}, {hr:Float64}, {bm:Float64},
            {rw:Float64}, {rd:Float64}, {qa:Float64}, {ev:Float64},
            {ig:Float64}, {po:Float64}, now64(3))`,
        params,
      );
    } catch (err) {
      this.logger.warn(`roi_rates projection failed for ${t.sourceSystem}/${t.outcomeType}: ${String(err)}`);
    }
  }
}
