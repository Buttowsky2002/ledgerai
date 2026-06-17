import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/decorators';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { PrismaService } from '../prisma/prisma.service';

/** Liveness + readiness, mirroring the Go services' /healthz and /readyz. */
@Public()
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clickhouse: ClickHouseService,
  ) {}

  @Get('healthz')
  health() {
    return { status: 'ok' };
  }

  @Get('readyz')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: 'postgres unreachable' });
    }
    try {
      await this.clickhouse.ping();
    } catch {
      throw new ServiceUnavailableException({ status: 'clickhouse unreachable' });
    }
    return { status: 'ready' };
  }
}
