import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { PrismaService } from '../prisma/prisma.service';
import { getPrincipal, getTenantId } from '../tenant/tenant-context';
import {
  CreateFixedCostDto,
  DeleteFixedCostDto,
  ListFixedCostsQueryDto,
  UpdateFixedCostDto,
} from './fixed-costs.dto';

export interface FixedCostRow {
  tenant_id: string;
  period_month: string;
  vendor: string;
  cost_type: string;
  line_item: string;
  seats: number;
  unit_cost_usd: number;
  cost_usd: number;
  currency: string;
  attributable: number;
  source: string;
  note: string;
  imported_at: string;
}

/**
 * Fixed / recurring AI overhead — un-attributable costs beside the outcome graph.
 * Writes go directly to ClickHouse fixed_costs via insertRows (mirrors OutcomesService);
 * tenant_id is stamped from the principal, never from the request body.
 */
@Injectable()
export class FixedCostsService {
  private readonly logger = new Logger(FixedCostsService.name);

  constructor(
    private readonly ch: ClickHouseService,
    private readonly prisma: PrismaService,
  ) {}

  private range(from?: string, to?: string): { from: string; to: string } {
    const today = new Date();
    const start = new Date(today);
    start.setUTCFullYear(start.getUTCFullYear() - 1);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return { from: from ?? iso(start), to: to ?? iso(today) };
  }

  list(q: ListFixedCostsQueryDto): Promise<FixedCostRow[]> {
    const r = this.range(q.from, q.to);
    return this.ch.queryScoped<FixedCostRow>(
      `SELECT tenant_id, period_month, vendor, cost_type,
              line_item, seats, unit_cost_usd, cost_usd, currency, attributable, source, note,
              imported_at
       FROM agentledger.fixed_costs FINAL
       WHERE tenant_id = {tenant:String}
         AND period_month BETWEEN {from:Date} AND {to:Date}
         AND attributable = 0
       ORDER BY period_month DESC, vendor, cost_type, line_item`,
      { ...r },
    );
  }

  monthlySummary(from?: string, to?: string): Promise<Record<string, unknown>[]> {
    const r = this.range(from, to);
    return this.ch.queryScoped(
      `SELECT period_month, vendor, cost_type,
              cost_usd, seats, last_imported_at
       FROM agentledger.v_fixed_cost_monthly
       WHERE tenant_id = {tenant:String}
         AND period_month BETWEEN {from:Date} AND {to:Date}
       ORDER BY period_month DESC, vendor, cost_type`,
      { ...r },
    );
  }

  totalCostOfAi(from?: string, to?: string): Promise<Record<string, unknown>[]> {
    const r = this.range(from, to);
    return this.ch.queryScoped(
      `SELECT month, attributable_cost_usd, fixed_cost_usd,
              total_cost_of_ai_usd, fixed_cost_pct
       FROM agentledger.v_total_cost_of_ai
       WHERE tenant_id = {tenant:String}
         AND month BETWEEN {from:Date} AND {to:Date}
       ORDER BY month`,
      { ...r },
    );
  }

  async create(dto: CreateFixedCostDto): Promise<FixedCostRow> {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new BadRequestException('no tenant in context');
    }
    const row = this.toRow(tenantId, dto);
    await this.ch.insertRows('fixed_costs', [row]);
    await this.audit(tenantId, 'create', row);
    this.logger.log({ event: 'fixed_cost_created', tenantId, ...this.keyOf(row) }, 'fixed_cost');
    return this.asFixedCostRow(row);
  }

  async update(dto: UpdateFixedCostDto): Promise<FixedCostRow> {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new BadRequestException('no tenant in context');
    }
    const existing = await this.findOne(tenantId, dto);
    if (!existing) {
      throw new BadRequestException('fixed cost row not found');
    }
    const row = {
      ...this.toRow(tenantId, {
        periodMonth: dto.periodMonth,
        vendor: dto.vendor,
        costType: dto.costType,
        costUsd: dto.costUsd ?? Number(existing.cost_usd),
        lineItem: dto.lineItem ?? existing.line_item,
        seats: dto.seats ?? Number(existing.seats),
        unitCostUsd: dto.unitCostUsd ?? Number(existing.unit_cost_usd),
        note: dto.note ?? existing.note,
      }),
    };
    await this.ch.insertRows('fixed_costs', [row]);
    await this.audit(tenantId, 'update', row);
    return this.asFixedCostRow(row);
  }

  async remove(dto: DeleteFixedCostDto): Promise<{ deleted: true }> {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new BadRequestException('no tenant in context');
    }
    const lineItem = dto.lineItem ?? '';
    await this.ch.command(
      `ALTER TABLE agentledger.fixed_costs DELETE
       WHERE tenant_id = {tenant:String}
         AND period_month = {period:Date}
         AND vendor = {vendor:String}
         AND cost_type = {ctype:String}
         AND line_item = {line:String}`,
      {
        tenant: tenantId,
        period: dto.periodMonth,
        vendor: dto.vendor,
        ctype: dto.costType,
        line: lineItem,
      },
    );
    await this.audit(tenantId, 'delete', {
      tenant_id: tenantId,
      period_month: dto.periodMonth,
      vendor: dto.vendor,
      cost_type: dto.costType,
      line_item: lineItem,
    });
    return { deleted: true };
  }

  private async findOne(
    tenantId: string,
    key: Pick<UpdateFixedCostDto, 'periodMonth' | 'vendor' | 'costType' | 'lineItem'>,
  ): Promise<FixedCostRow | undefined> {
    const rows = await this.ch.query<FixedCostRow>(
      `SELECT tenant_id, period_month, vendor, cost_type,
              line_item, seats, unit_cost_usd, cost_usd, currency, attributable, source, note,
              imported_at
       FROM agentledger.fixed_costs FINAL
       WHERE tenant_id = {tenant:String}
         AND period_month = {period:Date}
         AND vendor = {vendor:String}
         AND cost_type = {ctype:String}
         AND line_item = {line:String}
       LIMIT 1`,
      {
        tenant: tenantId,
        period: key.periodMonth,
        vendor: key.vendor,
        ctype: key.costType,
        line: key.lineItem ?? '',
      },
    );
    return rows[0];
  }

  private toRow(tenantId: string, dto: CreateFixedCostDto): Record<string, unknown> {
    const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
    return {
      tenant_id: tenantId,
      period_month: dto.periodMonth,
      vendor: dto.vendor,
      cost_type: dto.costType,
      line_item: dto.lineItem ?? '',
      seats: dto.seats ?? 0,
      unit_cost_usd: dto.unitCostUsd ?? 0,
      cost_usd: dto.costUsd,
      currency: 'USD',
      attributable: 0,
      source: 'manual',
      note: dto.note ?? '',
      imported_at: now,
    };
  }

  private keyOf(row: Record<string, unknown>) {
    return {
      period_month: row.period_month,
      vendor: row.vendor,
      cost_type: row.cost_type,
      line_item: row.line_item,
    };
  }

  private asFixedCostRow(row: Record<string, unknown>): FixedCostRow {
    return {
      tenant_id: String(row.tenant_id),
      period_month: String(row.period_month),
      vendor: String(row.vendor),
      cost_type: String(row.cost_type),
      line_item: String(row.line_item ?? ''),
      seats: Number(row.seats ?? 0),
      unit_cost_usd: Number(row.unit_cost_usd ?? 0),
      cost_usd: Number(row.cost_usd),
      currency: String(row.currency ?? 'USD'),
      attributable: Number(row.attributable ?? 0),
      source: String(row.source),
      note: String(row.note ?? ''),
      imported_at: String(row.imported_at),
    };
  }

  private async audit(tenantId: string, action: string, detail: Record<string, unknown>) {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.auditLog.create({
        data: {
          tenantId,
          actor: getPrincipal()?.userId ?? 'system',
          action,
          object: `fixed_cost:${detail.period_month}:${detail.vendor}:${detail.cost_type}:${detail.line_item ?? ''}`,
          detail: detail as Prisma.InputJsonValue,
        },
      }),
    );
  }
}
