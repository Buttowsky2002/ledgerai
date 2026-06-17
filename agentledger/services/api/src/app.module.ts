import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { PrismaModule } from './prisma/prisma.module';
import { TeamsModule } from './teams/teams.module';
import { TenantMiddleware } from './tenant/tenant.middleware';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        // Structured JSON to stdout, matching the Go services' slog output.
        autoLogging: true,
        // Never log secrets or full bodies (security rules 6 + engineering conventions).
        redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-tenant-id"]'],
        // Health/metrics polling shouldn't flood logs.
        customLogLevel: (_req, res, err) => {
          if (err || res.statusCode >= 500) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'info';
        },
      },
    }),
    PrismaModule,
    HealthModule,
    MetricsModule,
    TeamsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Tenant context wraps every route.
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
