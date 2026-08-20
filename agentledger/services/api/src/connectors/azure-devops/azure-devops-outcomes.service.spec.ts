import { AzureDevOpsOutcomesService } from './azure-devops-outcomes.service';
import * as client from './azure-devops-client';

describe('AzureDevOpsOutcomesService', () => {
  it('imports fetched outcome rows via ImportService', async () => {
    const importEvents = jest.fn().mockResolvedValue({
      imported: 2,
      skipped: 0,
      byTable: { outcomes: 2 },
    });
    const svc = new AzureDevOpsOutcomesService({ importEvents } as never);

    jest.spyOn(client, 'fetchAzureDevOpsOutcomes').mockResolvedValue([
      {
        idempotency_key: 'azure_devops:o/p/r#1',
        timestamp: '2026-08-10T00:00:00.000Z',
        outcome_id: 'azure_devops:o/p/r#1',
        outcome_type: 'pr_merged',
        source_system: 'azure_devops',
        source: 'api',
        user_id: 'a@b.com',
        attribution_confidence: 0,
      },
      {
        idempotency_key: 'azure_devops:o/p#2',
        timestamp: '2026-08-11T00:00:00.000Z',
        outcome_id: 'azure_devops:o/p#2',
        outcome_type: 'work_item_closed',
        source_system: 'azure_devops',
        source: 'api',
        user_id: 'c@d.com',
        attribution_confidence: 0,
      },
    ]);

    const result = await svc.sync({
      connectorId: 'conn-1',
      config: { organization: 'o', project: 'p', lookback_days: 30 },
      pat: 'pat-value',
    });

    expect(result).toEqual({ recordsFetched: 2, recordsImported: 2 });
    expect(importEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({ outcome_type: 'pr_merged', source_system: 'azure_devops' }),
        ]),
      }),
    );
  });

  it('rejects missing PAT and incomplete config', async () => {
    const svc = new AzureDevOpsOutcomesService({ importEvents: jest.fn() } as never);
    await expect(
      svc.sync({ connectorId: 'c', config: { organization: 'o', project: 'p' }, pat: '' }),
    ).rejects.toThrow(/Personal Access Token/);
    await expect(
      svc.sync({ connectorId: 'c', config: { organization: 'o' }, pat: 'x' }),
    ).rejects.toThrow(/project/);
  });
});
