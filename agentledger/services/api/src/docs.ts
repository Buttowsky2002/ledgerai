import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from './env';

/**
 * Swagger / OpenAPI docs exposure policy.
 *
 * Docs (`/docs` UI + `/docs-json` spec) are served outside production, or when an
 * operator explicitly opts in with LEDGERAI_EXPOSE_DOCS=true. In production they
 * are additionally gated behind a bearer token (LEDGERAI_DOCS_TOKEN) so an opted-in
 * production deployment never exposes the spec unauthenticated. If docs are opted
 * into in production without a token, they are refused (fail closed).
 */
export type DocsMode = 'enabled' | 'enabled_protected' | 'disabled' | 'disabled_no_token';

/** Docs are exposed outside production, or when explicitly opted in. */
export function docsEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' || env('LEDGERAI_EXPOSE_DOCS') === 'true';
}

/** Bearer token required to view docs in production (LEDGERAI_DOCS_TOKEN). */
export function docsToken(): string | undefined {
  return env('LEDGERAI_DOCS_TOKEN');
}

/** Resolve how the docs endpoints should be served. */
export function resolveDocsMode(): DocsMode {
  if (!docsEnabled()) {
    return 'disabled';
  }
  if (process.env.NODE_ENV === 'production') {
    return docsToken() ? 'enabled_protected' : 'disabled_no_token';
  }
  return 'enabled';
}

/**
 * Express middleware that requires `Authorization: Bearer <token>` (constant-time
 * compare). Used to gate the docs endpoints in production.
 */
export function docsBearerGuard(token: string) {
  const expected = Buffer.from(`Bearer ${token}`);
  return (req: Request, res: Response, next: NextFunction): void => {
    const got = Buffer.from(String(req.headers['authorization'] ?? ''));
    if (got.length === expected.length && timingSafeEqual(got, expected)) {
      next();
      return;
    }
    res.setHeader('WWW-Authenticate', 'Bearer realm="ledgerai-docs"');
    res.status(401).send('docs require a bearer token');
  };
}
