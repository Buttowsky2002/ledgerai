import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import type { ValidationPipeOptions } from '@nestjs/common';
import { env } from './env';

/**
 * Global ValidationPipe options (security rule 5 — reject unknown fields,
 * strip non-DTO props, coerce query/path params into typed DTOs).
 */
export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
};

/** Always-allowed dashboard hosts (in addition to BADGERIQ_DASHBOARD_URL). */
export const EXTRA_CORS_ORIGINS = [
  'https://badgeriq.studiodesigner.com',
  'https://d1e2lzkoizqhk6.cloudfront.net',
] as const;

/**
 * Browser CORS: dashboard origin whitelist only (never `*`), with credentials
 * for cookie-based session auth. Primary origin is BADGERIQ_DASHBOARD_URL
 * (default `http://localhost:3000`); EXTRA_CORS_ORIGINS are always included.
 */
export function allowedCorsOrigins(): string[] {
  const primary = env('BADGERIQ_DASHBOARD_URL') ?? 'http://localhost:3000';
  return [...new Set([primary, ...EXTRA_CORS_ORIGINS])];
}

export function corsOptions(): CorsOptions {
  return {
    origin: allowedCorsOrigins(),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'x-tenant-id'],
    credentials: true,
  };
}
