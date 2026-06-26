import type { TemplateContext } from '../types/connector-definition';
import type { SyncContext } from './connector-engine';

function utcDayStart(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

function utcDayEndMs(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999);
}

function unixSec(d: Date): string {
  return String(Math.floor(d.getTime() / 1000));
}

export function buildTemplateContext(ctx: SyncContext, extra?: Partial<TemplateContext>): TemplateContext {
  const startDay = new Date(utcDayStart(ctx.syncStart));
  const endDay = new Date(utcDayStart(ctx.syncEnd));
  return {
    tenant_id: ctx.tenantId,
    connector_id: ctx.connectorId,
    sync_start: ctx.syncStart.toISOString(),
    sync_end: ctx.syncEnd.toISOString(),
    sync_start_day: utcDayStart(ctx.syncStart),
    sync_end_day: utcDayStart(ctx.syncEnd),
    sync_start_unix: unixSec(startDay),
    sync_end_unix: unixSec(endDay),
    sync_start_unix_ms: String(startDay.getTime()),
    sync_end_unix_ms: String(utcDayEndMs(ctx.syncEnd)),
    now: new Date().toISOString(),
    last_success_at: ctx.lastSuccessAt?.toISOString() ?? '',
    page_size: ctx.definition.pagination?.pageSize ?? 100,
    page: 1,
    ...extra,
  };
}
