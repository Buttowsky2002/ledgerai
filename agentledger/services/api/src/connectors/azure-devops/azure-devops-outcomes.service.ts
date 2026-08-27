import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ImportService } from '../../import/import.service';
import {
  fetchAzureDevOpsOutcomes,
  parseAdoConfig,
  type AdoCredentials,
} from './azure-devops-client';

export const AZURE_DEVOPS_PRESET_ID = 'azure-devops-outcomes';

@Injectable()
export class AzureDevOpsOutcomesService {
  private readonly logger = new Logger(AzureDevOpsOutcomesService.name);

  constructor(private readonly importService: ImportService) {}

  /**
   * Pull merged PRs + completed work items and import as Postgres outcomes.
   * Returns counts for the connector sync run.
   */
  async sync(opts: {
    connectorId: string;
    config: Record<string, unknown>;
    pat: string;
  }): Promise<{ recordsFetched: number; recordsImported: number; warnings?: string[] }> {
    if (!opts.pat?.trim()) {
      throw new BadRequestException('Azure DevOps connector requires a Personal Access Token');
    }
    let cfg;
    try {
      cfg = parseAdoConfig(opts.config);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : String(err));
    }

    const creds: AdoCredentials = { pat: opts.pat.trim() };
    this.logger.log(
      `ADO sync connector=${opts.connectorId} org=${cfg.organization} project=${cfg.project} lookback=${cfg.lookbackDays}d`,
    );

    const { rows, skippedRepos } = await fetchAzureDevOpsOutcomes(creds, cfg);
    const warnings: string[] = [];
    if (skippedRepos.length > 0) {
      warnings.push(
        `Skipped ${skippedRepos.length} repo(s) without PR access: ${skippedRepos.slice(0, 3).join(', ')}` +
          (skippedRepos.length > 3 ? '…' : '') +
          '. Work items still sync. Remove stale repo IDs from connector config or grant Code (read).',
      );
      this.logger.warn(`ADO sync skipped repos: ${skippedRepos.join(', ')}`);
    }
    if (rows.length === 0) {
      return { recordsFetched: 0, recordsImported: 0, warnings: warnings.length ? warnings : undefined };
    }

    const summary = await this.importService.importEvents({
      events: rows as unknown as Record<string, unknown>[],
    });

    return {
      recordsFetched: rows.length,
      recordsImported: summary.imported,
      warnings: warnings.length ? warnings : undefined,
    };
  }
}
