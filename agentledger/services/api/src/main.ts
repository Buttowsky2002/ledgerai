import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { json, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './common/problem-details.filter';
import { buildOpenApiDocument } from './swagger';
import { env } from './env';
import { assertDevTrustHeaderNotInProduction, shouldTrustDevTenantHeader } from './auth/dev-trust';
import { docsBearerGuard, docsToken, resolveDocsMode } from './docs';
import { corsOptions, VALIDATION_PIPE_OPTIONS } from './http-security';

/**
 * Listen port: BADGERIQ_API_ADDR (Go-style ":8094" or bare port) wins, then
 * PORT (set by Cloud Run / most PaaS runtimes), then 8094.
 */
function resolvePort(): number {
  const addr = env('BADGERIQ_API_ADDR');
  if (addr) {
    const port = Number(addr.replace(/^.*:/, ''));
    if (Number.isFinite(port) && port > 0) return port;
  }
  const platformPort = Number(env('PORT'));
  if (Number.isFinite(platformPort) && platformPort > 0) return platformPort;
  return 8094;
}

async function bootstrap(): Promise<void> {
  console.log('[api] bootstrap starting');
  // Fail fast: dev tenant-header auth must never be enabled in production. This
  // runs before anything binds a port or a DB connection.
  assertDevTrustHeaderNotInProduction();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Structured JSON logging via pino.
  const logger = app.get(Logger);
  app.useLogger(logger);

  // Loud, structured warning whenever the dev tenant-header bypass is active
  // (only possible outside production — see assertDevTrustHeaderNotInProduction).
  if (shouldTrustDevTenantHeader()) {
    logger.warn(
      {
        event: 'dev_tenant_header_trust_enabled',
        nodeEnv: process.env.NODE_ENV ?? 'development',
        badgeriqEnv: env('BADGERIQ_ENV') ?? null,
        detail:
          'x-tenant-id is trusted as a dev auth bypass (grants admin). DEV ONLY — ' +
          'never enable LEDGERAI_DEV_TRUST_HEADER in production.',
      },
      'AuthMiddleware',
    );
  }

  // Reject unknown fields on writes; strip non-whitelisted props (security rule 5).
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));

  // Baseline HTTP security headers (CSP, X-Frame-Options, etc.).
  app.use(helmet());

  // Browser clients: dashboard origin only — never '*'.
  app.enableCors(corsOptions());

  // RFC 7807 problem+json for every error response.
  app.useGlobalFilters(new ProblemDetailsFilter());

  // Cap request bodies (control-plane writes are small). Portal CSV uploads need more headroom.
  const defaultBodyLimit = env('BADGERIQ_API_BODY_LIMIT') ?? '256kb';
  const defaultJson = json({ limit: defaultBodyLimit });
  const portalJson = json({ limit: '5mb' });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/v1/portal-import/')) {
      portalJson(req, res, next);
    } else {
      defaultJson(req, res, next);
    }
  });

  // Parse cookies (refresh token + OIDC login transaction).
  app.use(cookieParser());

  // OpenAPI: Swagger UI at /docs, spec JSON at /docs-json — gated by environment.
  // Not exposed in production by default; opt in with LEDGERAI_EXPOSE_DOCS=true
  // (which then requires a LEDGERAI_DOCS_TOKEN bearer in production).
  switch (resolveDocsMode()) {
    case 'enabled':
      SwaggerModule.setup('docs', app, buildOpenApiDocument(app));
      logger.log({ event: 'docs_enabled', path: '/docs' }, 'Swagger');
      break;
    case 'enabled_protected': {
      const guard = docsBearerGuard(docsToken() as string);
      app.use('/docs', guard);
      app.use('/docs-json', guard);
      SwaggerModule.setup('docs', app, buildOpenApiDocument(app));
      logger.warn(
        { event: 'docs_enabled_protected', path: '/docs', detail: 'production docs require an LEDGERAI_DOCS_TOKEN bearer' },
        'Swagger',
      );
      break;
    }
    case 'disabled_no_token':
      logger.error(
        { event: 'docs_disabled_no_token', detail: 'LEDGERAI_EXPOSE_DOCS=true in production but LEDGERAI_DOCS_TOKEN is unset — docs not exposed' },
        'Swagger',
      );
      break;
    case 'disabled':
      logger.log({ event: 'docs_disabled', detail: 'set LEDGERAI_EXPOSE_DOCS=true to enable' }, 'Swagger');
      break;
  }

  app.enableShutdownHooks();

  const port = resolvePort();
  const host = '0.0.0.0';
  console.log('[api] about to listen', {
    host,
    port,
    BADGERIQ_API_ADDR: env('BADGERIQ_API_ADDR'),
    PORT: env('PORT'),
  });
  await app.listen(port, host);
  console.log('[api] listening', { host, port });
}

console.log('[api] main.ts loaded');
void bootstrap().catch((err: unknown) => {
  // Startup failed (e.g. dev trust enabled in production) — report and exit
  // non-zero so an unsafe configuration never serves traffic.
  const e = err as NodeJS.ErrnoException & { cause?: unknown };
  console.error('[api] bootstrap failed', {
    message: e?.message ?? String(err),
    code: e?.code,
    cause: e?.cause,
    name: e?.name,
    stack: e?.stack,
  });
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
