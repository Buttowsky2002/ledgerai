import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { env } from '../env';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-context';
import { ConnectorsService } from './connectors.service';
import { resolveConnectorSyncRange } from './sync-handoff';
import { incrementalSyncWindow } from './sync-range';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 15_000;

interface ScheduledConnector {
  connector_id: string;
  tenant_id: string;
}

/** Background auto-sync for enabled API connectors (Anthropic, Cursor, OpenAI, custom). */
@Injectable()
export class ConnectorSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConnectorSchedulerService.name);
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private initialHandle: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit(): void {
    if (!schedulerEnabled()) {
      this.logger.log('connector auto-sync scheduler disabled (BADGERIQ_CONNECTOR_SCHEDULER_ENABLED=false)');
      return;
    }
    const intervalMs = schedulerIntervalMs();
    this.logger.log({ intervalMs }, 'connector auto-sync scheduler starting');
    this.initialHandle = setTimeout(() => {
      void this.runScheduledSync();
      this.intervalHandle = setInterval(() => void this.runScheduledSync(), intervalMs);
    }, INITIAL_DELAY_MS);
  }

  onModuleDestroy(): void {
    if (this.initialHandle) clearTimeout(this.initialHandle);
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  async runScheduledSync(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.prisma.$queryRaw<ScheduledConnector[]>`
        SELECT connector_id, tenant_id FROM connector_scheduled_sync()
      `;
      for (const row of rows) {
        try {
          await runWithTenant(
            { tenantId: row.tenant_id, userId: null, role: 'admin' },
            async () => {
              const connector = await this.prisma.withTenant(row.tenant_id, (tx) =>
                tx.connector.findUnique({ where: { connectorId: row.connector_id } }),
              );
              if (!connector?.enabled) return;

              const cfg = (connector.config ?? {}) as Record<string, unknown>;
              const window = incrementalSyncWindow();
              const range = resolveConnectorSyncRange(window, cfg);

              const result = await this.connectors.sync(row.connector_id, range);
              this.logger.log(
                {
                  event: 'connector_scheduled_sync_ok',
                  connectorId: row.connector_id,
                  tenantId: row.tenant_id,
                  imported: result.recordsImported,
                },
                'scheduled connector sync complete',
              );
            },
          );
        } catch (err) {
          this.logger.warn(
            {
              event: 'connector_scheduled_sync_failed',
              connectorId: row.connector_id,
              tenantId: row.tenant_id,
              err: safeMsg(err),
            },
            'scheduled connector sync failed',
          );
        }
      }
    } catch (err) {
      this.logger.warn(`scheduled connector listing failed: ${safeMsg(err)}`);
    } finally {
      this.running = false;
    }
  }
}

function schedulerEnabled(): boolean {
  const v = env('BADGERIQ_CONNECTOR_SCHEDULER_ENABLED');
  return v !== 'false' && v !== '0';
}

function schedulerIntervalMs(): number {
  const raw = env('BADGERIQ_CONNECTOR_SCHEDULER_INTERVAL_MS');
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 60_000 ? n : DEFAULT_INTERVAL_MS; // floor: 1 minute
}

function safeMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}
