import {
  applyAttributionToMetrics,
  isUnmapped,
  resolveAttribution,
} from './attribution-resolver';
import { UNASSIGNED_USER } from '../types/normalized-usage-event';

describe('attribution-resolver', () => {
  it('uses direct provider user ID first', () => {
    const result = resolveAttribution({ user_id: 'user-123' }, []);
    expect(result.userId).toBe('user-123');
    expect(result.method).toBe('provider_user_id');
  });

  it('falls back to user email', () => {
    const result = resolveAttribution({ user_email: 'dev@example.com' }, []);
    expect(result.userId).toBe('dev@example.com');
    expect(result.method).toBe('user_email');
  });

  it('resolves via API key mapping', () => {
    const result = resolveAttribution(
      { api_key_id: 'key-abc' },
      [{ mappingType: 'api_key', providerKey: 'key-abc', targetUserId: 'user-mapped' }],
    );
    expect(result.userId).toBe('user-mapped');
    expect(result.method).toBe('api_key_mapping');
  });

  it('resolves via project mapping', () => {
    const result = resolveAttribution(
      { project_id: 'proj-1' },
      [{ mappingType: 'project', providerKey: 'proj-1', targetUserId: 'user-proj' }],
    );
    expect(result.userId).toBe('user-proj');
    expect(result.method).toBe('project_mapping');
  });

  it('assigns Unassigned when no match', () => {
    const result = resolveAttribution({ model: 'gpt-4o', cost_usd: 1.5 }, []);
    expect(result.userId).toBe(UNASSIGNED_USER);
    expect(isUnmapped(result)).toBe(true);
  });

  it('applies attribution to metrics before import', () => {
    const metrics = applyAttributionToMetrics(
      { api_key_id: 'k1', cost_usd: 2 },
      [{ mappingType: 'api_key', providerKey: 'k1', targetUserId: 'alice' }],
      [],
    );
    expect(metrics.user_id).toBe('alice');
    expect(metrics.attribution_method).toBe('api_key_mapping');
  });

  it('prefers email and name for dashboard user labels', () => {
    const metrics = applyAttributionToMetrics(
      {
        user_id: 'user_01AbCdEfGhIjKlMnOpQrSt',
        user_email: 'jane@example.com',
        user_name: 'Jane Smith',
        cost_usd: 1,
      },
      [],
      [],
    );
    expect(metrics.user_id).toBe('Jane Smith (jane@example.com)');
  });
});
