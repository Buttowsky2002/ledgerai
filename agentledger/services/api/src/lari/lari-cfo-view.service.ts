import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { ChParam } from '../analytics-store/analytics-store';

import { AnalyticsStore } from '../analytics-store/analytics-store';

import {
  CopilotAnalyticsService,
  COPILOT_ANALYTICS_PLATFORM,
} from '../github-copilot/github-copilot-analytics.service';
import { CursorAnalyticsService } from '../connectors/cursor-analytics.service';
import { CursorProductivityService } from '../connectors/cursor-productivity.service';
import {
  RECONCILED_COST_BASIS_MONTHLY_SQL,
  RECONCILED_COST_BASIS_TOTALS_SQL,
  RECONCILED_MODEL_USAGE_SQL,
  RECONCILED_PROVIDER_SPEND_SQL,
  RECONCILED_UNMAPPED_SPEND_SQL,
  RECONCILED_USER_DAY_SPEND_SQL,
  RECONCILED_USER_MODEL_BREAKDOWN_SQL,
} from '../connectors/metered-cost';

import { PrismaService } from '../prisma/prisma.service';
import { loadIdentityLookups, resolveUserDirectoryIdentity } from '../reports/identity-resolver';
import {
  allocateSeatPools,
  mergeAllocatedWithConnectorFallback,
  presenceVendorsFromBreakdown,
  seatPoolsForRange,
  vendorsWithFixedSeatPools,
  type SeatClass,
  type SeatTierAssignment,
  type UserPlatformPresence,
} from '../analytics/seat-allocation';
import { platformToVendor } from '../analytics/vendor-spend';
import { canonicalUserKey } from '../analytics/user-directory.util';

import { getTenantId } from '../tenant/tenant-context';
import {
  billingMonthsInRange,
  currentMonthlySeatRunRate,
  forecastFixedSeatCost,
  periodSeatTotalForRange,
  prorateMonthlyCost,
  seatLookupFromDate,
  seatLookupToDate,
  type FixedCostSeatRow,
} from '../fixed-costs/fixed-cost-prorate';

import {
  CostBasisMode,
  CostProvenance,
  CfoViewProviderBreakdown,
  CfoViewResponse,
  CfoViewSummary,
  CfoViewTeamBreakdown,
} from './lari-cfo-view.types';
import {
  Range,
  RoiAggRow,
  CostBasisTotals,
  CostBasisMonthlyRow,
  n,
  usd,
  normalizeCostBasis,
  usageCostForBasis,
  buildCostProvenance,
  range,
  buildModelBreakdown,
  computeCostPerOutcomeFallback,
  buildMonthly,
  buildOutcomeBreakdown,
  buildWarnings,
  buildTeamSpendBreakdown,
} from './lari-cfo-view.util';

/**

 * Tenant-level CFO view — aggregates the existing v_roi engine (no duplicate ROI

 * math) plus supplemental subscription and coding-agent costs from Postgres/CH.

 * Confidence threshold filters outcome links before aggregation (Phase 4 bar).

 */

@Injectable()
export class LariCfoViewService {
  private readonly logger = new Logger(LariCfoViewService.name);

  constructor(
    private readonly ch: AnalyticsStore,

    private readonly prisma: PrismaService,

    private readonly copilotAnalytics: CopilotAnalyticsService,

    private readonly cursorAnalytics: CursorAnalyticsService,

    private readonly cursorProductivity: CursorProductivityService,
  ) {}

  async getCfoView(
    from?: string,

    to?: string,

    confidenceThreshold = 0.5,

    team?: string,

    costBasis: CostBasisMode = 'reconciled',

    forecastDays = 365,
  ): Promise<CfoViewResponse> {
    const tenantId = getTenantId();

    if (!tenantId) {
      throw new BadRequestException('no tenant in context');
    }

    const basis = normalizeCostBasis(costBasis);

    const r = range(from, to, 365);

    const minconf = Math.max(0, Math.min(1, confidenceThreshold));

    const params: Record<string, ChParam> = { ...r, minconf };

    const tf = team ? ((params.team = team), 'AND team_id = {team:String}') : '';

    const roiRows = await this.ch.queryScoped<RoiAggRow>(
      `SELECT toStartOfMonth(outcome_ts) AS month, outcome_type AS outcome_type,

              count() AS outcomes,

              sum(value_usd) AS value_usd,

              sum(ai_cost_usd) AS ai_cost_usd,

              sum(fully_loaded_cost_usd) AS fully_loaded_cost_usd,

              sum(nominal_roi_usd) AS nominal_roi_usd,

              sum(risk_adjusted_roi_usd) AS risk_adjusted_roi_usd,

              avg(attribution_confidence) AS avg_confidence

       FROM agentledger.v_roi

       WHERE tenant_id = {tenant:String}

         AND toDate(outcome_ts) BETWEEN {from:Date} AND {to:Date}

         AND attribution_confidence >= {minconf:Float32} ${tf}

       GROUP BY month, outcome_type ORDER BY month`,

      params,
    );

    const providerRows =
      basis === 'reconciled'
        ? await this.ch.queryScoped<{ provider: string; cost_usd: number; calls: number }>(
            RECONCILED_PROVIDER_SPEND_SQL,
            params,
          )
        : await this.ch.queryScoped<{ provider: string; cost_usd: number; calls: number }>(
            `SELECT provider, sum(cost_usd) AS cost_usd, sum(calls) AS calls
       FROM spend_daily
       WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
       GROUP BY provider ORDER BY cost_usd DESC`,
            params,
          );
    const costBasisTotals = await this.queryCostBasisTotals(params, basis);
    const costBasisMonthly = await this.queryCostBasisMonthly(params, basis);
    const modelUsageRows =
      basis === 'reconciled'
        ? await this.ch
            .queryScoped<{
              provider: string;
              model: string;
              input_tokens: number;
              output_tokens: number;
              calls: number;
              cost_usd: number;
            }>(RECONCILED_MODEL_USAGE_SQL, params)
            .then((rows) =>
              rows.map((row) => ({
                provider: String(row.provider),
                model: String(row.model),
                input_tokens: n(row.input_tokens),
                output_tokens: n(row.output_tokens),
                calls: n(row.calls),
                computed_cost_usd: n(row.cost_usd),
              })),
            )
        : await this.ch.queryScoped<{
            provider: string;
            model: string;
            input_tokens: number;
            output_tokens: number;
            calls: number;
            computed_cost_usd: number;
          }>(
            `SELECT provider, model,
                sum(input_tokens) AS input_tokens,
                sum(output_tokens) AS output_tokens,
                sum(calls) AS calls,
                sum(cost_usd) AS computed_cost_usd
         FROM spend_daily
         WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
         GROUP BY provider, model
         ORDER BY computed_cost_usd DESC`,
            params,
          );
    const modelBasisRows =
      basis === 'reconciled'
        ? modelUsageRows.map((row) => ({
            provider: row.provider,
            model: row.model,
            computed_cost_usd: row.computed_cost_usd,
            metered_cost_usd: row.computed_cost_usd,
            effective_cost_usd: row.computed_cost_usd,
          }))
        : await this.queryModelCostBasis(params);

    const codingAgentCost = await this.ch.queryScoped<{ cost_usd: number }>(
      `SELECT sum(cost_usd) AS cost_usd

       FROM agentledger.coding_agent_daily

       WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}`,

      params,
    );

    const unmappedSpend = await this.ch.queryScoped<{ unmapped_cost: number }>(
      basis === 'reconciled'
        ? RECONCILED_UNMAPPED_SPEND_SQL
        : `SELECT sum(cost_usd) AS unmapped_cost
       FROM spend_daily_by_user
       WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
         AND user_id = 'Unassigned'`,
      params,
    );

    const [
      subscriptionCost,
      fixedCostSnapshot,
      seatStats,
      copilotSpend,
      cursorSpendSummary,
      cursorProductivity,
      teamBreakdown,
    ] = await Promise.all([
      this.subscriptionCostForPeriod(tenantId, r),

      this.fixedCostForPeriod(r),

      this.seatStats(tenantId),

      this.copilotAnalytics.getSpendSummary(tenantId, r.from, r.to),

      this.cursorAnalytics.getSpendSummary(tenantId, r.from, r.to),

      this.cursorProductivity.getProductivitySummary(tenantId, r.from, r.to),

      this.buildTeamBreakdown(tenantId, r),
    ]);

    const fixedCostBase =
      fixedCostSnapshot.periodTotal > 0 ? fixedCostSnapshot.periodTotal : subscriptionCost;
    const monthlySeatRunRate =
      fixedCostSnapshot.monthlyRunRate > 0
        ? fixedCostSnapshot.monthlyRunRate
        : fixedCostBase > 0
          ? fixedCostBase / Math.max(billingMonthsInRange(r.from, r.to).length, 1)
          : 0;

    const totals = costBasisTotals[0] ?? {
      computed_cost_usd: 0,

      metered_cost_usd: 0,

      effective_cost_usd: 0,

      calls: 0,

      total_keys: 0,

      metered_keys: 0,
    };

    const costProvenanceBase = buildCostProvenance(totals);

    const usageCost = usageCostForBasis(basis, totals);

    const copilotCost = copilotSpend?.totalCostUsd ?? 0;

    const copilotValue = copilotSpend?.estimatedValueUsd ?? 0;
    const cursorProductivityValue = cursorProductivity?.estimatedValueUsd ?? 0;
    const cursorSpendUsd =
      (cursorSpendSummary?.meteredOverageUsd ?? 0) + (cursorSpendSummary?.seatLicenseUsd ?? 0);

    const supplementalCost = n(codingAgentCost[0]?.cost_usd) + fixedCostBase + copilotCost;

    const outcomeCount = roiRows.reduce((s, row) => s + n(row.outcomes), 0);

    const totalOutcomesAll = await this.outcomeCountAll(tenantId, r, tf, params);

    const businessValue =
      roiRows.reduce((s, row) => s + n(row.value_usd), 0) + copilotValue + cursorProductivityValue;

    const outcomeFullyLoaded = roiRows.reduce((s, row) => s + n(row.fully_loaded_cost_usd), 0);

    const outcomeAiCost = roiRows.reduce((s, row) => s + n(row.ai_cost_usd), 0);

    const outcomeRiskAdjustedValue = roiRows.reduce(
      (s, row) => s + n(row.risk_adjusted_roi_usd) + n(row.fully_loaded_cost_usd),

      0,
    );

    // Copilot estimated value already applies qualityAdjustmentFactor (default 0.5) — treat as
    // risk-adjusted productivity value with no additional risk_exposure discount.
    const riskAdjustedValue = outcomeRiskAdjustedValue + copilotValue + cursorProductivityValue;

    // Token/API usage from v_cost_basis_daily; v_roi only covers AI cost on outcome-linked runs.

    // Add QA/eval/integration/platform from outcomes without double-counting token spend.

    const qaEvalOverhead = Math.max(0, outcomeFullyLoaded - outcomeAiCost);

    const observedFullyLoadedCost = usageCost + supplementalCost + qaEvalOverhead;

    const periodDays = Math.max(
      1,
      (new Date(r.to).getTime() - new Date(r.from).getTime()) / 86_400_000 + 1,
    );
    const horizonDays = Math.max(1, forecastDays);
    const variableScale = horizonDays / periodDays;
    const forecastFixed = forecastFixedSeatCost(monthlySeatRunRate, horizonDays);

    const forecastToken = usageCost * variableScale;
    const forecastCoding = n(codingAgentCost[0]?.cost_usd) * variableScale;
    const forecastCopilot = copilotCost * variableScale;
    const forecastOverhead = qaEvalOverhead * variableScale;

    const fullyLoadedCost =
      forecastToken + forecastFixed + forecastCoding + forecastCopilot + forecastOverhead;

    // Headline ROI uses observed window — projected spend is shown separately on the forecast card.
    const observedNominalRoi = businessValue - observedFullyLoadedCost;
    const observedRiskAdjustedRoi = riskAdjustedValue - observedFullyLoadedCost;

    const effectiveOutcomeCount = outcomeCount + (cursorProductivity?.activeUserDays ?? 0);
    const costPerOutcome =
      effectiveOutcomeCount > 0 ? usd(observedFullyLoadedCost / effectiveOutcomeCount) : null;
    const cpoFallback =
      effectiveOutcomeCount === 0
        ? computeCostPerOutcomeFallback(
            observedFullyLoadedCost,
            n(totals.calls),
            modelUsageRows.reduce((s, row) => s + n(row.input_tokens) + n(row.output_tokens), 0),
            copilotSpend?.totalCalls ?? 0,
          )
        : {
            costPerOutcomeFallback: null,
            costPerOutcomeFallbackLabel: null,
            costPerOutcomeFallbackBasis: null,
          };

    const costProvenance: CostProvenance = {
      ...costProvenanceBase,
      stack: {
        tokenUsageUsd: usd(forecastToken),
        tokenComputedUsd: usd(n(totals.computed_cost_usd) * variableScale),
        tokenMeteredUsd: usd(n(totals.metered_cost_usd) * variableScale),
        fixedCostUsd: usd(forecastFixed),
        codingAgentUsd: usd(forecastCoding),
        copilotUsd: usd(forecastCopilot),
        qaEvalOverheadUsd: usd(forecastOverhead),
      },
    };

    const monthly = buildMonthly(roiRows, costBasisMonthly, supplementalCost, basis);

    const runRateMonths = monthly.length;

    const forecastPerMonth = runRateMonths > 0 ? observedRiskAdjustedRoi / runRateMonths : 0;

    const roiMargin =
      observedFullyLoadedCost > 0 ? observedRiskAdjustedRoi / observedFullyLoadedCost : 0;

    const summary: CfoViewSummary = {
      riskAdjustedRoi: usd(observedRiskAdjustedRoi),

      nominalRoi: usd(observedNominalRoi),

      businessValue: usd(businessValue),

      fullyLoadedCost: usd(fullyLoadedCost),

      observedFullyLoadedCost: usd(observedFullyLoadedCost),

      forecastPerMonth: usd(forecastPerMonth),

      roiMargin: Math.round(roiMargin * 10_000) / 10_000,

      runRateMonths,

      costPerOutcome,

      costPerOutcomeFallback: cpoFallback.costPerOutcomeFallback,

      costPerOutcomeFallbackLabel: cpoFallback.costPerOutcomeFallbackLabel,

      costPerOutcomeFallbackBasis: cpoFallback.costPerOutcomeFallbackBasis,

      costBasis: basis,

      forecastDays: horizonDays,

      observedPeriodDays: periodDays,

      observedFixedCostUsd: usd(fixedCostBase),

      monthlySeatRunRateUsd: usd(monthlySeatRunRate),
    };

    const outcomeBreakdown = buildOutcomeBreakdown(roiRows, {
      usageCost,
      supplementalCost: fixedCostBase + n(codingAgentCost[0]?.cost_usd) + copilotCost,
      outcomeAiCost,
      outcomeCount,
    });
    if (cursorProductivity && cursorProductivity.estimatedValueUsd > 0) {
      outcomeBreakdown.push(
        this.cursorProductivity.toOutcomeBreakdownRow(cursorProductivity, cursorSpendUsd),
      );
      outcomeBreakdown.sort((a, b) => b.riskAdjustedRoi - a.riskAdjustedRoi);
    }

    const modelBreakdown = buildModelBreakdown(
      modelUsageRows,
      modelBasisRows,
      basis,
      variableScale,
    );

    const providerBreakdown: CfoViewProviderBreakdown[] = providerRows.map((row) => ({
      provider: String(row.provider),

      costUsd: usd(n(row.cost_usd)),

      calls: n(row.calls),
    }));

    if (copilotCost > 0) {
      providerBreakdown.push({
        provider: COPILOT_ANALYTICS_PLATFORM,

        costUsd: usd(copilotCost),

        calls: copilotSpend?.totalCalls ?? 0,
      });

      providerBreakdown.sort((a, b) => b.costUsd - a.costUsd);
    }

    const warnings = buildWarnings({
      fullyLoadedCost,

      usageCost,

      businessValue,

      outcomeCount,

      totalOutcomesAll,

      minconf,

      unmappedCost: n(unmappedSpend[0]?.unmapped_cost),

      seatStats,

      supplementalCost,

      copilotValue,

      cursorProductivityValue,

      costBasis: basis,

      costProvenance,
    });

    return {
      from: r.from,

      to: r.to,

      confidenceThreshold: minconf,

      summary,

      monthly,

      outcomeBreakdown,

      modelBreakdown,

      providerBreakdown,

      teamBreakdown,

      costProvenance,

      warnings,
    };
  }

  /**
   * Spend by team: billable $ + calls collapsed by identity email (same as Users
   * directory) then rolled to identities.team_id. Fixed Overhead seats are
   * allocated by platform presence + basic/premium tier (same allocator as Users);
   * Cursor connector seats fill gaps when fixed_costs has no Cursor pool.
   */
  private async buildTeamBreakdown(tenantId: string, r: Range): Promise<CfoViewTeamBreakdown[]> {
    try {
      const params = r as Record<string, ChParam>;
      const [
        spendRows,
        codingRows,
        copilotRows,
        cursorSeatByUser,
        cursorActivity,
        modelRows,
        lookups,
        teams,
      ] = await Promise.all([
        this.ch.queryScoped<{ key: string; cost_usd: unknown; calls: unknown }>(
          `SELECT key, cost_usd, calls
             FROM (${RECONCILED_USER_DAY_SPEND_SQL}) AS reconciled
             WHERE cost_usd > 0 OR calls > 0
             ORDER BY cost_usd DESC`,
          params,
        ),
        this.ch.queryScoped<{ key: string; cost_usd: unknown; calls: unknown }>(
          `SELECT if(user_id = '', 'Unassigned', user_id) AS key,
                    sum(cost_usd) AS cost_usd,
                    sum(requests) AS calls
             FROM coding_agent_daily
             WHERE tenant_id = {tenant:String}
               AND day BETWEEN {from:Date} AND {to:Date}
             GROUP BY key
             HAVING sum(cost_usd) > 0 OR sum(requests) > 0`,
          params,
        ),
        this.copilotAnalytics.getUserSpendAllocation(tenantId, r.from, r.to).catch(() => []),
        this.cursorSeatSpendByUser(tenantId, r).catch(() => new Map<string, number>()),
        this.cursorAnalytics.getUserActivity(tenantId, r.from, r.to).catch(() => []),
        this.ch
          .queryScoped<{ user_id: string; platform: string; spend_usd: unknown; calls: unknown }>(
            `SELECT user_id, platform, spend_usd, calls
             FROM (${RECONCILED_USER_MODEL_BREAKDOWN_SQL}) AS reconciled
             WHERE user_id != '' AND user_id != 'Unassigned'`,
            params,
          )
          .catch(() => []),
        loadIdentityLookups(this.prisma, tenantId),
        this.prisma.withTenant(tenantId, (tx) =>
          tx.team.findMany({ select: { teamId: true, name: true }, orderBy: { name: 'asc' } }),
        ),
      ]);

      type Agg = {
        costUsd: number;
        calls: number;
        teamId: string | null;
        teamName: string;
        sampleUserId: string;
      };
      const byCanon = new Map<string, Agg>();

      const ingest = (userId: string, costUsd: number, calls: number) => {
        const raw = userId.trim();
        if (!raw || (costUsd <= 0 && calls <= 0)) {
          return;
        }
        if (raw === 'Unassigned') {
          const cur = byCanon.get('raw:unassigned') ?? {
            costUsd: 0,
            calls: 0,
            teamId: null,
            teamName: '',
            sampleUserId: 'Unassigned',
          };
          cur.costUsd = usd(cur.costUsd + costUsd);
          cur.calls += calls;
          byCanon.set('raw:unassigned', cur);
          return;
        }
        const identity = resolveUserDirectoryIdentity(
          raw,
          lookups.byId,
          lookups.byEmail,
          lookups.byAlias,
        );
        const canon = canonicalUserKey(raw, identity);
        const cur = byCanon.get(canon) ?? {
          costUsd: 0,
          calls: 0,
          teamId: identity.teamId,
          teamName: identity.team,
          sampleUserId: raw,
        };
        if (identity.resolved && identity.teamId) {
          cur.teamId = identity.teamId;
          cur.teamName = identity.team;
          if (identity.email) {
            cur.sampleUserId = identity.email;
          }
        }
        cur.costUsd = usd(cur.costUsd + costUsd);
        cur.calls += calls;
        byCanon.set(canon, cur);
      };

      for (const row of spendRows) {
        ingest(String(row.key), n(row.cost_usd), n(row.calls));
      }
      for (const row of codingRows) {
        ingest(String(row.key), n(row.cost_usd), n(row.calls));
      }
      for (const row of copilotRows) {
        ingest(row.userId, row.costUsd, row.calls);
      }
      // Attribute Cursor on-demand before seats so we don't subtract seat $ from overage.
      for (const row of cursorActivity) {
        if (row.on_demand_usd <= 0) {
          continue;
        }
        const identity = resolveUserDirectoryIdentity(
          row.user_id,
          lookups.byId,
          lookups.byEmail,
          lookups.byAlias,
        );
        const canon = canonicalUserKey(row.user_id, identity);
        const have = byCanon.get(canon)?.costUsd ?? 0;
        if (have + 0.005 < row.on_demand_usd) {
          ingest(row.user_id, usd(row.on_demand_usd - have), 0);
        }
      }

      // Platform presence for Fixed Overhead allocation (matches Users directory).
      const presenceByCanon = new Map<string, Set<string>>();
      const notePresence = (userId: string, vendor: string) => {
        const raw = userId.trim();
        if (!raw || raw === 'Unassigned') {
          return;
        }
        const identity = resolveUserDirectoryIdentity(
          raw,
          lookups.byId,
          lookups.byEmail,
          lookups.byAlias,
        );
        const canon = canonicalUserKey(raw, identity);
        const set = presenceByCanon.get(canon) ?? new Set<string>();
        set.add(platformToVendor(vendor));
        presenceByCanon.set(canon, set);
      };
      for (const row of modelRows) {
        notePresence(String(row.user_id), String(row.platform));
      }
      for (const row of copilotRows) {
        notePresence(row.userId, 'github');
      }
      for (const row of cursorActivity) {
        notePresence(row.user_id, 'cursor');
      }
      for (const userId of cursorSeatByUser.keys()) {
        notePresence(userId, 'cursor');
      }

      const allocatedSeats = await this.allocateTeamSeats(
        tenantId,
        r,
        byCanon,
        presenceByCanon,
        cursorSeatByUser,
      );
      for (const [userId, seatUsd] of allocatedSeats) {
        ingest(userId, seatUsd, 0);
      }

      return buildTeamSpendBreakdown(
        [...byCanon.values()].map((v) => ({
          userId: v.sampleUserId,
          costUsd: v.costUsd,
          calls: v.calls,
        })),
        (userId) => {
          if (userId === 'Unassigned') {
            return { teamId: null, teamName: '' };
          }
          const hit = [...byCanon.values()].find((v) => v.sampleUserId === userId);
          if (hit) {
            return { teamId: hit.teamId, teamName: hit.teamName };
          }
          const identity = resolveUserDirectoryIdentity(
            userId,
            lookups.byId,
            lookups.byEmail,
            lookups.byAlias,
          );
          return { teamId: identity.teamId, teamName: identity.team };
        },
        teams.map((t) => ({ teamId: t.teamId, teamName: t.name })),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`CFO team breakdown failed: ${msg}`);
      return [];
    }
  }

  /**
   * Allocate fixed_costs seat pools onto users in the team rollup. Connector
   * Cursor seats apply only when Fixed Overhead has no Cursor pool.
   */
  private async allocateTeamSeats(
    tenantId: string,
    r: Range,
    byCanon: Map<
      string,
      {
        costUsd: number;
        calls: number;
        teamId: string | null;
        teamName: string;
        sampleUserId: string;
      }
    >,
    presenceByCanon: Map<string, Set<string>>,
    cursorSeatByUser: Map<string, number>,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const fixedRows = await this.loadFixedCostRowsForAllocation(r);
    const pools = seatPoolsForRange(fixedRows, r.from, r.to);
    const fixedVendors = vendorsWithFixedSeatPools(pools);

    const { assignments, userIdAliases } = await this.loadSeatTierForCfo(tenantId, byCanon);

    // Explicit premium tags count as presence for that vendor.
    for (const a of assignments) {
      for (const [canon, agg] of byCanon) {
        if (
          agg.sampleUserId === a.user_id ||
          userIdAliases.get(agg.sampleUserId.toLowerCase()) === a.user_id
        ) {
          const set = presenceByCanon.get(canon) ?? new Set<string>();
          set.add(a.vendor);
          presenceByCanon.set(canon, set);
        }
      }
    }

    const presence: UserPlatformPresence[] = [...byCanon.entries()].map(([canon, agg]) => ({
      user_id: agg.sampleUserId,
      vendors: [
        ...(presenceByCanon.get(canon) ?? new Set()),
        ...presenceVendorsFromBreakdown([]),
      ],
      activity_score: agg.costUsd + agg.calls,
    }));

    const allocated = allocateSeatPools({
      pools,
      presence,
      tiers: assignments,
      userIdAliases,
    });

    const connectorSeats = new Map<string, Record<string, number>>();
    for (const [uid, seatUsd] of cursorSeatByUser) {
      if (seatUsd > 0) {
        connectorSeats.set(uid, { cursor: seatUsd });
      }
    }
    const merged = mergeAllocatedWithConnectorFallback(allocated, connectorSeats, fixedVendors);

    for (const [userId, byVendor] of merged) {
      const total = Object.values(byVendor).reduce((s, v) => s + v, 0);
      if (total > 0) {
        out.set(userId, usd(total));
      }
    }
    return out;
  }

  private async loadFixedCostRowsForAllocation(r: Range): Promise<FixedCostSeatRow[]> {
    const seatFrom = seatLookupFromDate(r.to);
    const seatTo = seatLookupToDate(r.to);
    try {
      const rows = await this.ch.queryScoped<{
        period_month: string;
        vendor: string;
        cost_usd: unknown;
        seats: unknown;
        line_item: string;
        cost_type: string;
      }>(
        `SELECT period_month, vendor, cost_type, line_item, seats, cost_usd
         FROM agentledger.fixed_costs FINAL
         WHERE tenant_id = {tenant:String}
           AND period_month >= toDate({seatFrom:String})
           AND period_month <= toStartOfMonth(toDate({seatTo:String}))
           AND attributable = 0`,
        { seatFrom, seatTo },
      );
      return rows.map((row) => ({
        period_month: String(row.period_month),
        vendor: String(row.vendor).trim().toLowerCase(),
        cost_usd: n(row.cost_usd),
        seats: n(row.seats),
        line_item: String(row.line_item ?? ''),
        cost_type: String(row.cost_type ?? ''),
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`CFO fixed_costs load failed: ${msg}`);
      return [];
    }
  }

  private async loadSeatTierForCfo(
    tenantId: string,
    byCanon: Map<string, { sampleUserId: string }>,
  ): Promise<{
    assignments: SeatTierAssignment[];
    userIdAliases: Map<string, string>;
  }> {
    const assignments: SeatTierAssignment[] = [];
    const userIdAliases = new Map<string, string>();
    for (const agg of byCanon.values()) {
      userIdAliases.set(agg.sampleUserId.toLowerCase(), agg.sampleUserId);
    }
    try {
      const rows = await this.prisma.withTenant(tenantId, (tx) =>
        tx.$queryRaw<{ user_id: string; vendor: string; tier: string; email: string | null }[]>`
          SELECT t.user_id::text, t.vendor, t.tier, i.email
          FROM identity_seat_tiers t
          JOIN identities i ON i.user_id = t.user_id`,
      );
      for (const row of rows) {
        const tier: SeatClass = row.tier === 'premium' ? 'premium' : 'basic';
        const vendor = String(row.vendor).trim().toLowerCase();
        const uid = String(row.user_id);
        assignments.push({ user_id: uid, vendor, tier });
        if (row.email) {
          userIdAliases.set(row.email.toLowerCase(), uid);
          assignments.push({ user_id: row.email, vendor, tier });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/identity_seat_tiers|does not exist|42P01/i.test(msg)) {
        this.logger.warn(`CFO seat tiers load failed: ${msg}`);
      }
    }
    return { assignments, userIdAliases };
  }

  /**
   * Prorate Cursor seat license $ onto assigned identities (ai_seats), else split
   * org seat run-rate across active Cursor users in the window — same rule as the
   * Users directory so CFO team spend matches member totals.
   */
  private async cursorSeatSpendByUser(tenantId: string, r: Range): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const activity = await this.cursorAnalytics.getUserActivity(tenantId, r.from, r.to);
    if (activity.length === 0) {
      return out;
    }

    const seatRows = await this.prisma.withTenant(
      tenantId,
      (tx) =>
        tx.$queryRaw<
          {
            user_id: string | null;
            email: string | null;
            monthly_price_per_user: number | string;
          }[]
        >`
        SELECT s.user_id::text, i.email, p.monthly_price_per_user
        FROM ai_seats s
        JOIN ai_subscription_plans p ON s.plan_id = p.plan_id
        LEFT JOIN identities i ON s.user_id = i.user_id
        WHERE s.active = true AND lower(s.provider) = 'cursor' AND s.user_id IS NOT NULL`,
    );

    const assigned = new Set<string>();
    for (const row of seatRows) {
      const monthly = n(row.monthly_price_per_user);
      if (monthly <= 0) {
        continue;
      }
      const prorated = prorateMonthlyCost(monthly, `${r.from.slice(0, 7)}-01`, r.from, r.to);
      const uid = String(row.user_id);
      out.set(uid, usd((out.get(uid) ?? 0) + prorated));
      assigned.add(uid);
      if (row.email) {
        assigned.add(String(row.email).toLowerCase());
      }
    }

    let orgSeatUsd = 0;
    try {
      const summary = await this.cursorAnalytics.getSpendSummary(tenantId, r.from, r.to);
      orgSeatUsd = summary?.seatLicenseUsd ?? 0;
    } catch {
      orgSeatUsd = 0;
    }

    const activeMembers = activity.length;
    const perUserFallback =
      orgSeatUsd > 0 && activeMembers > 0 ? usd(orgSeatUsd / activeMembers) : 0;
    if (perUserFallback > 0) {
      for (const row of activity) {
        const uid = String(row.user_id);
        if (out.has(uid) || assigned.has(uid.toLowerCase())) {
          continue;
        }
        out.set(uid, perUserFallback);
      }
    }

    return out;
  }

  private async queryModelCostBasis(params: Record<string, ChParam>): Promise<
    Array<{
      provider: string;
      model: string;
      computed_cost_usd: number;
      metered_cost_usd: number;
      effective_cost_usd: number;
    }>
  > {
    try {
      return await this.ch.queryScoped(
        `SELECT provider, model,
                sum(computed_cost_usd) AS computed_cost_usd,
                sum(metered_cost_usd) AS metered_cost_usd,
                sum(effective_cost_usd) AS effective_cost_usd
         FROM agentledger.v_cost_basis_daily
         WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
         GROUP BY provider, model`,
        params,
      );
    } catch {
      return [];
    }
  }

  private async queryCostBasisTotals(
    params: Record<string, ChParam>,
    basis: CostBasisMode,
  ): Promise<CostBasisTotals[]> {
    if (basis === 'reconciled') {
      return this.ch.queryScoped<CostBasisTotals>(RECONCILED_COST_BASIS_TOTALS_SQL, params);
    }
    try {
      return await this.ch.queryScoped<CostBasisTotals>(
        `SELECT sum(computed_cost_usd) AS computed_cost_usd,
                sum(metered_cost_usd) AS metered_cost_usd,
                sum(effective_cost_usd) AS effective_cost_usd,
                sum(calls) AS calls,
                count() AS total_keys,
                countIf(metered_cost_usd > 0) AS metered_keys
         FROM agentledger.v_cost_basis_daily
         WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}`,
        params,
      );
    } catch {
      return this.ch.queryScoped<CostBasisTotals>(
        `SELECT sum(cost_usd) AS computed_cost_usd,
                0 AS metered_cost_usd,
                sum(cost_usd) AS effective_cost_usd,
                sum(calls) AS calls,
                count() AS total_keys,
                0 AS metered_keys
         FROM spend_daily
         WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}`,
        params,
      );
    }
  }

  private async queryCostBasisMonthly(
    params: Record<string, ChParam>,
    basis: CostBasisMode,
  ): Promise<CostBasisMonthlyRow[]> {
    if (basis === 'reconciled') {
      return this.ch.queryScoped<CostBasisMonthlyRow>(RECONCILED_COST_BASIS_MONTHLY_SQL, params);
    }
    try {
      return await this.ch.queryScoped<CostBasisMonthlyRow>(
        `SELECT toStartOfMonth(day) AS month,
                sum(computed_cost_usd) AS computed_cost_usd,
                sum(metered_cost_usd) AS metered_cost_usd,
                sum(effective_cost_usd) AS effective_cost_usd
         FROM agentledger.v_cost_basis_daily
         WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
         GROUP BY month ORDER BY month`,
        params,
      );
    } catch {
      return this.ch.queryScoped<CostBasisMonthlyRow>(
        `SELECT toStartOfMonth(day) AS month,
                sum(cost_usd) AS computed_cost_usd,
                0 AS metered_cost_usd,
                sum(cost_usd) AS effective_cost_usd
         FROM spend_daily
         WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
         GROUP BY month ORDER BY month`,
        params,
      );
    }
  }

  /** Seat licenses and recurring overhead from fixed_costs for the query window. */
  private async fixedCostForPeriod(
    r: Range,
  ): Promise<{ periodTotal: number; monthlyRunRate: number }> {
    const seatFrom = seatLookupFromDate(r.to);
    const rows = await this.ch.queryScoped<{
      period_month: string;
      vendor: string;
      cost_usd: number;
      seats: number;
    }>(
      `SELECT period_month, vendor, cost_usd, seats
       FROM agentledger.fixed_costs FINAL
       WHERE tenant_id = {tenant:String}
         AND period_month >= toDate({seatFrom:String})
         AND period_month <= toStartOfMonth(toDate({to:String}))
         AND attributable = 0`,
      { seatFrom, to: r.to },
    );
    const mapped: FixedCostSeatRow[] = rows.map((row) => ({
      period_month: String(row.period_month),
      vendor: String(row.vendor),
      cost_usd: n(row.cost_usd),
      seats: n(row.seats),
    }));
    return {
      periodTotal: periodSeatTotalForRange(mapped, r.from, r.to),
      monthlyRunRate: currentMonthlySeatRunRate(mapped),
    };
  }

  /** Prorate subscription contract cost across the query window (fallback when fixed_costs empty). */

  private async subscriptionCostForPeriod(tenantId: string, r: Range): Promise<number> {
    const plans = await this.prisma.withTenant(
      tenantId,
      (tx) =>
        tx.$queryRaw<{ contract_monthly_cost: number | string }[]>`

        SELECT contract_monthly_cost FROM ai_subscription_plans WHERE contract_monthly_cost > 0`,
    );

    if (plans.length === 0) {
      return 0;
    }

    const fromMs = new Date(r.from).getTime();

    const toMs = new Date(r.to).getTime();

    const windowDays = Math.max(1, (toMs - fromMs) / 86_400_000 + 1);

    const monthsInWindow = windowDays / 30;

    const monthlyTotal = plans.reduce((s, p) => s + n(p.contract_monthly_cost), 0);

    return monthlyTotal * monthsInWindow;
  }

  private async seatStats(tenantId: string): Promise<{ purchased: number; active: number }> {
    const rows = await this.prisma.withTenant(
      tenantId,
      (tx) =>
        tx.$queryRaw<{ purchased: number; active: number }[]>`

        SELECT

          COALESCE(SUM(p.seats_purchased), 0)::int AS purchased,

          COALESCE(SUM(CASE WHEN s.active THEN s.seats_assigned ELSE 0 END), 0)::int AS active

        FROM ai_subscription_plans p

        LEFT JOIN ai_seats s ON s.plan_id = p.plan_id`,
    );

    return { purchased: n(rows[0]?.purchased), active: n(rows[0]?.active) };
  }

  private async outcomeCountAll(
    tenantId: string,

    r: Range,

    tf: string,

    params: Record<string, ChParam>,
  ): Promise<number> {
    const rows = await this.ch.queryScoped<{ cnt: number }>(
      `SELECT count() AS cnt FROM agentledger.v_roi

       WHERE tenant_id = {tenant:String}

         AND toDate(outcome_ts) BETWEEN {from:Date} AND {to:Date} ${tf}`,

      params,
    );

    return n(rows[0]?.cnt);
  }
}
