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
  }): Promise<{ recordsFetched: number; recordsImported: number }> {
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

    const rows = await fetchAzureDevOpsOutcomes(creds, cfg);
    if (rows.length === 0) {
      return { recordsFetched: 0, recordsImported: 0 };
    }

    const summary = await this.importService.importEvents({
      events: rows as unknown as Record<string, unknown>[],
    });

    return {
      recordsFetched: rows.length,
      recordsImported: summary.imported,
    };
  }
}
