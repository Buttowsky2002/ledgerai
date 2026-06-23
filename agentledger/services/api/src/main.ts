import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './common/problem-details.filter';
import { buildOpenApiDocument } from './swagger';
import { env } from './env';
import { assertDevTrustHeaderNotInProduction, shouldTrustDevTenantHeader } from './auth/dev-trust';
import { docsBearerGuard, docsToken, resolveDocsMode } from './docs';

/** Parse a Go-style listen address (":8094") or a bare port; default 8094. */
function resolvePort(): number {
  const addr = env('LEDGERAI_API_ADDR');
  if (addr) {
    const port = Number(addr.replace(/^.*:/, ''));
    if (Number.isFinite(port) && port > 0) return port;
  }
  return 8094;
}

async function bootstrap(): Promise<void> {
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
        detail:
          'x-tenant-id is trusted as a dev auth bypass (grants admin). DEV ONLY — ' +
          'never enable LEDGERAI_DEV_TRUST_HEADER in production.',
      },
      'AuthMiddleware',
    );
  }

  // Reject unknown fields on writes; strip non-whitelisted props (security rule 5).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // RFC 7807 problem+json for every error response.
  app.useGlobalFilters(new ProblemDetailsFilter());

  // Cap request bodies (control-plane writes are small).
  app.use(json({ limit: env('LEDGERAI_API_BODY_LIMIT') ?? '256kb' }));

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
  await app.listen(port, '0.0.0.0');
}

void bootstrap().catch((err: unknown) => {
  // Startup failed (e.g. dev trust enabled in production) — report and exit
  // non-zero so an unsafe configuration never serves traffic.
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
