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

/**
 * Browser CORS: dashboard origin only (never `*`), with credentials for
 * cookie-based session auth. Default matches apps/dashboard (`next dev -p 3000`).
 */
export function corsOptions(): CorsOptions {
  return {
    origin: env('BADGERIQ_DASHBOARD_URL') ?? 'http://localhost:3000',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'x-tenant-id'],
    credentials: true,
  };
}
