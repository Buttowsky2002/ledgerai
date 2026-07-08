import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { env } from '../env';
import { PrismaService } from '../prisma/prisma.service';
import { GitHubCopilotSyncService } from './github-copilot-sync.service';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 15_000;

interface ScheduledConnection {
  connection_id: string;
  tenant_id: string;
}

/** Runs auto-sync for GitHub Copilot connections with scheduling enabled. */
@Injectable()
export class GitHubCopilotSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GitHubCopilotSchedulerService.name);
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private initialHandle: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: GitHubCopilotSyncService,
  ) {}

  onModuleInit(): void {
    if (!schedulerEnabled()) {
      this.logger.log('copilot auto-sync scheduler disabled (BADGERIQ_COPILOT_SCHEDULER_ENABLED=false)');
      return;
    }
    const intervalMs = schedulerIntervalMs();
    this.logger.log({ intervalMs }, 'copilot auto-sync scheduler starting');
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
      const rows = await this.prisma.$queryRaw<ScheduledConnection[]>`
        SELECT connection_id, tenant_id FROM copilot_scheduled_connections()
      `;
      for (const row of rows) {
        try {
          const result = await this.sync.syncConnection(row.connection_id, row.tenant_id);
          if (result.ok) {
            this.logger.log(
              `scheduled sync ok connection=${row.connection_id} seats=${result.seatsImported} memberSpend=${result.memberSpendRowsComputed}`,
            );
          } else {
            this.logger.warn(
              `scheduled sync failed connection=${row.connection_id} code=${result.errorCode}`,
            );
          }
        } catch (err) {
          this.logger.warn(`scheduled sync error connection=${row.connection_id}: ${safeMsg(err)}`);
        }
      }
    } catch (err) {
      this.logger.warn(`scheduled sync listing failed: ${safeMsg(err)}`);
    } finally {
      this.running = false;
    }
  }
}

function schedulerEnabled(): boolean {
  const v = env('BADGERIQ_COPILOT_SCHEDULER_ENABLED');
  return v !== 'false' && v !== '0';
}

function schedulerIntervalMs(): number {
  const raw = env('BADGERIQ_COPILOT_SCHEDULER_INTERVAL_MS');
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 60_000 ? n : DEFAULT_INTERVAL_MS;
}

function safeMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}
