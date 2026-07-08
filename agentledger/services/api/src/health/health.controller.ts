import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/decorators';
import { AnalyticsStore, analyticsBackend } from '../analytics-store/analytics-store';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Liveness + readiness, mirroring the Go services' /healthz and /readyz.
 * /health, /ready, and /version aliases follow the Cloud Run deployment
 * contract (see the root Dockerfile).
 *
 * Readiness is backend-aware: with BADGERIQ_ANALYTICS_BACKEND=postgres the
 * analytics store ping is a Postgres round-trip, so the MVP deployment is
 * ready as soon as Postgres answers — no ClickHouse required.
 */
@Public()
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: AnalyticsStore,
  ) {}

  @Get(['healthz', 'health'])
  health() {
    return { status: 'ok' };
  }

  @Get(['readyz', 'ready'])
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: 'postgres unreachable' });
    }
    try {
      await this.store.ping();
    } catch {
      throw new ServiceUnavailableException({ status: `analytics store (${analyticsBackend()}) unreachable` });
    }
    return { status: 'ready', analyticsBackend: analyticsBackend() };
  }

  /** Build/version info stamped into the image at build time (never secrets). */
  @Get('version')
  version() {
    return {
      name: 'badgeriq-api',
      version: process.env.BADGERIQ_BUILD_VERSION ?? 'dev',
      gitSha: process.env.BADGERIQ_BUILD_SHA ?? 'unknown',
      builtAt: process.env.BADGERIQ_BUILD_TIME ?? 'unknown',
    };
  }
}
