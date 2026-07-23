import { Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request } from 'express';
import { getPrincipal, getTenantId } from '../tenant/tenant-context';

/**
 * Structured security audit events for incident response (Phase 9).
 * Emitted via nestjs-pino / Nest Logger — never log raw credentials or PII.
 */
export type SecurityEventType =
  | 'auth.login_success'
  | 'auth.login_failure'
  | 'auth.token_refresh'
  | 'auth.logout'
  | 'authz.denied'
  | 'authz.bola_attempt'
  | 'dlp.finding'
  | 'prompt_injection'
  | 'budget.threshold'
  | 'connector.secret_access';

export interface SecurityEvent {
  type: SecurityEventType;
  tenantId: string | null;
  userId: string | null;
  ip: string;
  userAgent: string;
  /** NEVER include raw credentials, tokens, emails, or prompt content. */
  detail?: Record<string, unknown>;
}

/** Per-request client metadata (set by AuthMiddleware). */
export interface RequestClientMeta {
  ip: string;
  userAgent: string;
}

const clientStorage = new AsyncLocalStorage<RequestClientMeta>();
const log = new Logger('SecurityAudit');

const ERROR_TYPES: ReadonlySet<SecurityEventType> = new Set([
  'auth.login_failure',
  'authz.denied',
  'authz.bola_attempt',
  'prompt_injection',
]);

/** Bind client IP / UA for the rest of the request (nest under runWithTenant). */
export function runWithRequestClient<T>(meta: RequestClientMeta, fn: () => T): T {
  return clientStorage.run(meta, fn);
}

export function getRequestClientMeta(): RequestClientMeta {
  return clientStorage.getStore() ?? { ip: '', userAgent: '' };
}

/** Extract client meta from an Express request (proxy-aware IP when trust proxy is set). */
export function clientMetaFromRequest(req: Request): RequestClientMeta {
  const xf = req.headers['x-forwarded-for'];
  const forwarded = typeof xf === 'string' ? xf.split(',')[0]?.trim() : '';
  const ip = forwarded || req.ip || req.socket?.remoteAddress || '';
  const ua = req.headers['user-agent'];
  return {
    ip,
    userAgent: typeof ua === 'string' ? ua.slice(0, 256) : '',
  };
}

/**
 * Emit a structured security audit log line (pino via nestjs-pino).
 * Failures and authz denials use `error`; other events use `warn`.
 */
export function logSecurityEvent(event: SecurityEvent): void {
  const payload = {
    event: 'security_audit',
    type: event.type,
    tenantId: event.tenantId,
    userId: event.userId,
    ip: event.ip,
    userAgent: event.userAgent,
    ...(event.detail ? { detail: event.detail } : {}),
  };
  if (ERROR_TYPES.has(event.type)) {
    log.error(payload, `security_event:${event.type}`);
  } else {
    log.warn(payload, `security_event:${event.type}`);
  }
}

/** Fill tenant/user/ip/ua from ALS when the caller only has type + optional detail. */
export function logSecurityEventFromContext(
  type: SecurityEventType,
  detail?: Record<string, unknown>,
): void {
  const principal = getPrincipal();
  const meta = getRequestClientMeta();
  logSecurityEvent({
    type,
    tenantId: principal?.tenantId ?? getTenantId(),
    userId: principal?.userId ?? null,
    ip: meta.ip,
    userAgent: meta.userAgent,
    detail,
  });
}
