import { BadRequestException, Injectable } from '@nestjs/common';
import { ChParam } from '../clickhouse/clickhouse.service';
import { AnalyticsStore } from '../analytics-store/analytics-store';
import { loadIdentityLookups, resolveUserDirectoryIdentity } from '../reports/identity-resolver';
import { PrismaService } from '../prisma/prisma.service';
import { getPerUserAnalyticsMode } from '../tenant/per-user-analytics';
import { getTenantId } from '../tenant/tenant-context';
import type {
  UserUtilizationRow,
  UserValueIndividualResponse,
  UserValueResponse,
  UserValueTeamResponse,
} from './user-value.types';
import {
  computeUserStatus,
  computeUtilizationScore,
  seatMonthlyCost,
} from './user-value.util';

type Range = { from: string; to: string };

const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const MS_DAY = 86_400_000;

interface MutableUserRow {
  userId: string;
  displayName: string;
  providers: Set<string>;
  costUsd: number;
  calls: number;
  activeDays: number;
  codingAgentCostUsd: number;
  sessions: number;
  seatMonthlyCostUsd: number;
  hasSeat: boolean;
  planId?: string;
  planName?: string;
  seatProvider?: string;
  dailyCost?: Map<string, number>;
  dailyCalls?: Map<string, number>;
}

@Injectable()
export class UserValueService {
  constructor(
    private readonly ch: AnalyticsStore,
    private readonly prisma: PrismaService,
  ) {}

  async getUserValue(from?: string, to?: string): Promise<UserValueResponse> {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new BadRequestException('no tenant in context');
    }
    const r = this.range(from, to);
    const mode = await getPerUserAnalyticsMode(this.prisma, tenantId);
    const rows = await this.assembleUserUtilization(tenantId, r, mode);
    if (mode === 'individual') {
      return {
        from: r.from,
        to: r.to,
        mode: 'individual',
        users: rows,
      } satisfies UserValueIndividualResponse;
    }
    return {
      from: r.from,
      to: r.to,
      mode: 'team',
      aggregates: this.teamAggregates(rows),
    } satisfies UserValueTeamResponse;
  }

  /** Shared assembly for GET /v1/analytics/user-value and LARI recommendations. */
  async assembleUserUtilization(
    tenantId: string,
    r: Range,
    mode: 'individual' | 'team',
  ): Promise<UserUtilizationRow[]> {
    const periodDays = Math.max(
      1,
      (new Date(r.to).getTime() - new Date(r.from).getTime()) / MS_DAY + 1,
    );
    const params: Record<string, ChParam> = { ...r };

    const [spendRows, codingRows, seatRows, lookups] = await Promise.all([
      this.ch.queryScoped<{
        user_id: string;
        cost_usd: number;
        calls: number;
        active_days: number;
        providers: string[];
      }>(
        `SELECT user_id,
                sum(cost_usd) AS cost_usd,
                sum(calls) AS calls,
                uniqExact(day) AS active_days,
                groupUniqArray(provider) AS providers
         FROM spend_daily_by_user
         WHERE tenant_id = {tenant:String}
           AND day BETWEEN {from:Date} AND {to:Date}
           AND user_id != '' AND user_id != 'Unassigned'
         GROUP BY user_id`,
        params,
      ),
      this.ch.queryScoped<{
        user_id: string;
        provider: string;
        cost_usd: number;
        sessions: number;
      }>(
        `SELECT user_id, provider,
                sum(cost_usd) AS cost_usd,
                sum(sessions) AS sessions
         FROM coding_agent_daily
         WHERE tenant_id = {tenant:String}
           AND day BETWEEN {from:Date} AND {to:Date}
           AND user_id != ''
         GROUP BY user_id, provider`,
        params,
      ),
      this.loadSeatAssignments(tenantId),
      loadIdentityLookups(this.prisma, tenantId),
    ]);

    const dailySpendByUser =
      mode === 'individual'
        ? await this.ch.queryScoped<{ user_id: string; day: string; cost_usd: number; calls: number }>(
            `SELECT user_id, day, sum(cost_usd) AS cost_usd, sum(calls) AS calls
             FROM spend_daily_by_user
             WHERE tenant_id = {tenant:String}
               AND day BETWEEN {from:Date} AND {to:Date}
               AND user_id != '' AND user_id != 'Unassigned'
             GROUP BY user_id, day
             ORDER BY user_id, day`,
            params,
          )
        : [];

    const byKey = new Map<string, MutableUserRow>();

    const resolveKey = (rawUserId: string): string => {
      const identity = resolveUserDirectoryIdentity(
        rawUserId,
        lookups.byId,
        lookups.byEmail,
        lookups.byAlias,
      );
      return (identity.email ?? rawUserId).trim().toLowerCase() || rawUserId;
    };

    const ensure = (rawUserId: string): MutableUserRow => {
      const key = resolveKey(rawUserId);
      const existing = byKey.get(key);
      if (existing) return existing;
      const identity = resolveUserDirectoryIdentity(
        rawUserId,
        lookups.byId,
        lookups.byEmail,
        lookups.byAlias,
      );
      const row: MutableUserRow = {
        userId: rawUserId,
        displayName: identity.display_name,
        providers: new Set<string>(),
        costUsd: 0,
        calls: 0,
        activeDays: 0,
        codingAgentCostUsd: 0,
        sessions: 0,
        seatMonthlyCostUsd: 0,
        hasSeat: false,
      };
      byKey.set(key, row);
      return row;
    };

    for (const row of spendRows) {
      const user = ensure(String(row.user_id));
      user.costUsd += n(row.cost_usd);
      user.calls += n(row.calls);
      user.activeDays = Math.max(user.activeDays, n(row.active_days));
      for (const p of row.providers ?? []) {
        if (p) user.providers.add(String(p));
      }
    }

    for (const row of codingRows) {
      const user = ensure(String(row.user_id));
      user.codingAgentCostUsd += n(row.cost_usd);
      user.sessions += n(row.sessions);
      if (row.provider) user.providers.add(String(row.provider));
    }

    for (const seat of seatRows) {
      const rawId = seat.email ?? seat.userId;
      if (!rawId) continue;
      const user = ensure(rawId);
      user.hasSeat = true;
      user.seatMonthlyCostUsd = Math.max(
        user.seatMonthlyCostUsd,
        seatMonthlyCost(seat.monthlyPricePerUser, seat.contractMonthlyCost, seat.seatsPurchased),
      );
      user.planId = seat.planId;
      user.planName = seat.planName;
      user.seatProvider = seat.provider;
      user.providers.add(seat.provider);
    }

    if (mode === 'individual') {
      for (const row of dailySpendByUser) {
        const user = ensure(String(row.user_id));
        const day = String(row.day).slice(0, 10);
        if (!user.dailyCost) user.dailyCost = new Map();
        if (!user.dailyCalls) user.dailyCalls = new Map();
        user.dailyCost.set(day, (user.dailyCost.get(day) ?? 0) + n(row.cost_usd));
        user.dailyCalls.set(day, (user.dailyCalls.get(day) ?? 0) + n(row.calls));
      }
    }

    return [...byKey.values()].map((row) => {
      const utilizationScore = computeUtilizationScore(
        row.activeDays,
        row.calls,
        row.sessions,
        periodDays,
      );
      const status = computeUserStatus(row.calls, row.sessions, utilizationScore, row.hasSeat);
      const dailyCost =
        row.dailyCost && row.dailyCost.size > 0
          ? [...row.dailyCost.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, v]) => v)
          : undefined;
      const dailyCalls =
        row.dailyCalls && row.dailyCalls.size > 0
          ? [...row.dailyCalls.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, v]) => v)
          : undefined;

      return {
        userId: row.userId,
        displayName: row.displayName,
        providers: [...row.providers].sort(),
        costUsd: Math.round((row.costUsd + row.codingAgentCostUsd + Number.EPSILON) * 100) / 100,
        calls: row.calls,
        activeDays: row.activeDays,
        codingAgentCostUsd: Math.round((row.codingAgentCostUsd + Number.EPSILON) * 100) / 100,
        sessions: row.sessions,
        utilizationScore,
        seatMonthlyCostUsd: row.seatMonthlyCostUsd,
        status,
        hasSeat: row.hasSeat,
        planId: row.planId,
        planName: row.planName,
        seatProvider: row.seatProvider,
        dailyCost,
        dailyCalls,
      };
    });
  }

  private teamAggregates(rows: UserUtilizationRow[]) {
    const provisionedSeats = rows.filter((r) => r.hasSeat).length;
    const activeSeats = rows.filter((r) => r.hasSeat && r.status === 'active').length;
    const inactiveSeats = rows.filter((r) => r.hasSeat && r.status === 'inactive').length;
    const lowUseSeats = rows.filter((r) => r.hasSeat && r.status === 'low_use').length;
    const reclaimableMonthlyUsd = rows
      .filter((r) => r.hasSeat && r.status === 'inactive')
      .reduce((s, r) => s + r.seatMonthlyCostUsd, 0);

    const byPlanMap = new Map<
      string,
      { planId: string; planName: string; provider: string; inactiveCount: number; reclaimableMonthlyUsd: number }
    >();
    const byProviderMap = new Map<string, { provider: string; inactiveCount: number; reclaimableMonthlyUsd: number }>();

    for (const row of rows) {
      if (!row.hasSeat || row.status !== 'inactive') continue;
      const planKey = row.planId ?? row.seatProvider ?? 'unknown';
      const planEntry = byPlanMap.get(planKey) ?? {
        planId: row.planId ?? planKey,
        planName: row.planName ?? 'Unassigned plan',
        provider: row.seatProvider ?? 'unknown',
        inactiveCount: 0,
        reclaimableMonthlyUsd: 0,
      };
      planEntry.inactiveCount += 1;
      planEntry.reclaimableMonthlyUsd += row.seatMonthlyCostUsd;
      byPlanMap.set(planKey, planEntry);

      const provider = row.seatProvider ?? 'unknown';
      const provEntry = byProviderMap.get(provider) ?? {
        provider,
        inactiveCount: 0,
        reclaimableMonthlyUsd: 0,
      };
      provEntry.inactiveCount += 1;
      provEntry.reclaimableMonthlyUsd += row.seatMonthlyCostUsd;
      byProviderMap.set(provider, provEntry);
    }

    const round = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

    return {
      provisionedSeats,
      activeSeats,
      inactiveSeats,
      lowUseSeats,
      reclaimableMonthlyUsd: round(reclaimableMonthlyUsd),
      byPlan: [...byPlanMap.values()].map((p) => ({
        ...p,
        reclaimableMonthlyUsd: round(p.reclaimableMonthlyUsd),
      })),
      byProvider: [...byProviderMap.values()].map((p) => ({
        ...p,
        reclaimableMonthlyUsd: round(p.reclaimableMonthlyUsd),
      })),
    };
  }

  private async loadSeatAssignments(tenantId: string) {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<
        {
          user_id: string | null;
          email: string | null;
          provider: string;
          plan_id: string;
          plan_name: string;
          monthly_price_per_user: number | string;
          contract_monthly_cost: number | string;
          seats_purchased: number;
        }[]
      >`
        SELECT
          s.user_id::text,
          i.email,
          s.provider,
          p.plan_id::text,
          p.plan_name,
          p.monthly_price_per_user,
          p.contract_monthly_cost,
          p.seats_purchased
        FROM ai_seats s
        JOIN ai_subscription_plans p ON s.plan_id = p.plan_id
        LEFT JOIN identities i ON s.user_id = i.user_id
        WHERE s.active = true AND s.user_id IS NOT NULL`,
    );
    return rows.map((r) => ({
      userId: r.user_id ? String(r.user_id) : null,
      email: r.email ? String(r.email) : null,
      provider: String(r.provider),
      planId: String(r.plan_id),
      planName: String(r.plan_name),
      monthlyPricePerUser: n(r.monthly_price_per_user),
      contractMonthlyCost: n(r.contract_monthly_cost),
      seatsPurchased: n(r.seats_purchased),
    }));
  }

  private range(from: string | undefined, to: string | undefined, days = 90): Range {
    const today = new Date();
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - days);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return { from: from ?? iso(start), to: to ?? iso(today) };
  }
}
