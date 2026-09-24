import { seatVendorsFromImportRows } from './import-seat-tiers';

describe('seatVendorsFromImportRows', () => {
  it('maps Anthropic and OpenAI expense rows to basic seat vendors by email', () => {
    const map = seatVendorsFromImportRows([
      { provider: 'anthropic', user_id: 'alice@studio.test', cost_usd: 12 },
      { provider: 'openai', user_email: 'Bob@Studio.Test', user_id: 'bob-handle' },
      { provider: 'cursor', user_id: 'cara@studio.test' },
      { provider: 'anthropic', user_id: 'Unassigned' },
    ]);
    expect([...map.get('alice@studio.test')!]).toEqual(['anthropic']);
    expect([...map.get('bob@studio.test')!]).toEqual(['openai']);
    expect(map.has('cara@studio.test')).toBe(false);
  });

  it('unions multiple providers for the same email', () => {
    const map = seatVendorsFromImportRows([
      { provider: 'anthropic', user_id: 'dana@studio.test' },
      { provider: 'openai', user_id: 'dana@studio.test' },
    ]);
    expect([...map.get('dana@studio.test')!].sort()).toEqual(['anthropic', 'openai']);
  });
});
