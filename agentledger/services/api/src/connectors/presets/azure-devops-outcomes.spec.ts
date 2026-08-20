import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectorDefinition } from '../types/connector-definition';

describe('azure-devops-outcomes preset', () => {
  const preset = JSON.parse(
    readFileSync(join(__dirname, 'azure-devops-outcomes.json'), 'utf8'),
  ) as ConnectorDefinition;

  it('is an outcome_system preset for Azure DevOps', () => {
    expect(preset.provider).toBe('azure_devops');
    expect(preset.category).toBe('outcome_system');
    expect(preset.authType).toBe('basic_auth');
    expect(preset.destinationRecordType).toBe('outcome_record');
    expect(preset.baseUrl).toBe('https://dev.azure.com');
  });
});
