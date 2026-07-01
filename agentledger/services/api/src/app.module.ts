import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuthGuard } from './auth/auth.guard';
import { AuthMiddleware } from './auth/auth.middleware';
import { AuthModule } from './auth/auth.module';
import { RolesGuard } from './auth/roles.guard';
import { AgentsModule } from './agents/agents.module';
import { AgentCredentialsModule } from './agent-credentials/agent-credentials.module';
import { AgentToolAllowlistModule } from './agent-tool-allowlist/agent-tool-allowlist.module';
import { AllocationRulesModule } from './allocation-rules/allocation-rules.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AppsModule } from './apps/apps.module';
import { AttributionModule } from './attribution/attribution.module';
import { BudgetsModule } from './budgets/budgets.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { GitHubCopilotModule } from './github-copilot/github-copilot.module';
import { ClickHouseModule } from './clickhouse/clickhouse.module';
import { HealthModule } from './health/health.module';
import { IdentitiesModule } from './identities/identities.module';
import { ImportModule } from './import/import.module';
import { PortalImportModule } from './portal-import/portal-import.module';
import { MetricsModule } from './metrics/metrics.module';
import { OutcomesModule } from './outcomes/outcomes.module';
import { PoliciesModule } from './policies/policies.module';
import { PriceBookModule } from './price-book/price-book.module';
import { PrismaModule } from './prisma/prisma.module';
import { RoiTemplatesModule } from './roi-templates/roi-templates.module';
import { RunsModule } from './runs/runs.module';
import { ScimModule } from './scim/scim.module';
import { ScimTokensModule } from './scim-tokens/scim-tokens.module';
import { TeamsModule } from './teams/teams.module';
import { TenantModule } from './tenant/tenant.module';
import { TenantIdpConfigModule } from './tenant-idp-config/tenant-idp-config.module';
import { VirtualKeysModule } from './virtual-keys/virtual-keys.module';
import { ReportsModule } from './reports/reports.module';
import { FixedCostsModule } from './fixed-costs/fixed-costs.module';
import { DesignPartnerModule } from './design-partner/design-partner.module';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        autoLogging: true,
        // Never log secrets/credentials (security rule 6 + conventions).
        redact: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-tenant-id"]',
        ],
        customLogLevel: (_req, res, err) => {
          if (err || res.statusCode >= 500) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'info';
        },
      },
    }),
    // Global default rate limit; auth endpoints tighten it further (rule 6).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    PrismaModule,
    ClickHouseModule,
    AuthModule,
    HealthModule,
    MetricsModule,
    // Control-plane resources (CRUD + audit; RLS-scoped, admin-write/viewer-read).
    TeamsModule,
    IdentitiesModule,
    AppsModule,
    AgentsModule,
    PoliciesModule,
    BudgetsModule,
    RoiTemplatesModule,
    AgentToolAllowlistModule,
    AgentCredentialsModule,
    TenantIdpConfigModule,
    ScimModule,
    ScimTokensModule,
    AllocationRulesModule,
    VirtualKeysModule,
    PriceBookModule,
    TenantModule,
    AnalyticsModule,
    AttributionModule,
    // Outcome Graph MVP: single-run detail + outcomes read/write (ADR-046).
    RunsModule,
    OutcomesModule,
    // Bulk data ingestion (admin-only write into the analytics store).
    ImportModule,
    PortalImportModule,
    // Config-driven API connector framework (presets + custom REST sources).
    ConnectorsModule,
    GitHubCopilotModule,
    ReportsModule,
    FixedCostsModule,
    DesignPartnerModule,
  ],
  providers: [
    // Guard order matters: rate-limit → authenticate → authorize.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Resolve + bind the request principal before guards/handlers run.
    consumer.apply(AuthMiddleware).forRoutes('*');
  }
}
