import {
  ADO_PRESET,
  COPILOT_PRESET,
  LOCKED_PRESETS,
  defaultConnectorRange,
  formatApiError,
  isCopilotConnector,
  isoDate,
  presetFormFields,
  statusTone,
} from '@/lib/connectors-preset';
import type { Connector, Preset } from '@/types/connectors';

const connector = (over: Partial<Connector>): Connector => ({
  connectorId: 'c1',
  displayName: 'Test',
  provider: 'generic',
  category: 'provider_spend',
  status: 'healthy',
  enabled: true,
  lastSyncAt: null,
  lastSuccessAt: null,
  ...over,
});

describe('formatApiError', () => {
  it('prefers a string detail', () => {
    expect(formatApiError({ detail: 'bad key' }, 'fallback')).toBe('bad key');
  });

  it('uses a string message', () => {
    expect(formatApiError({ message: 'boom' }, 'fallback')).toBe('boom');
  });

  it('unwraps a nested message object', () => {
    expect(formatApiError({ message: { message: 'nested' } }, 'fallback')).toBe('nested');
  });

  it('joins an array message', () => {
    expect(formatApiError({ message: ['a', 'b'] }, 'fallback')).toBe('a; b');
  });

  it('falls back to a string error field', () => {
    expect(formatApiError({ error: 'oops' }, 'fallback')).toBe('oops');
  });

  it('returns the fallback when nothing matches', () => {
    expect(formatApiError({}, 'fallback')).toBe('fallback');
  });
});

describe('presetFormFields', () => {
  it('reads fields from a preset definitionJson', () => {
    const presets: Preset[] = [
      {
        definitionId: 'p1',
        name: 'Custom',
        provider: 'x',
        category: 'ai_usage',
        definitionJson: {
          baseUrl: 'https://api.x.com',
          authType: 'bearer_token',
          category: 'observability',
          endpoints: [{ path: '/v2/spend' }],
        },
      },
    ];
    expect(presetFormFields('p1', presets)).toEqual({
      presetId: 'p1',
      category: 'observability',
      baseUrl: 'https://api.x.com',
      authType: 'bearer_token',
      endpointPath: '/v2/spend',
    });
  });

  it('falls back to PRESET_DEFAULTS for a known locked preset', () => {
    expect(presetFormFields('anthropic-usage', [])).toEqual({
      presetId: 'anthropic-usage',
      baseUrl: 'https://api.anthropic.com',
      authType: 'api_key_header',
      endpointPath: '/v1/organizations/cost_report',
      category: 'provider_spend',
    });
  });

  it('returns just the presetId for an unknown preset', () => {
    expect(presetFormFields('mystery', [])).toEqual({ presetId: 'mystery' });
  });
});

describe('isCopilotConnector', () => {
  it('matches the copilot provider', () => {
    expect(isCopilotConnector(connector({ provider: 'github_copilot_business' }))).toBe(true);
  });

  it('matches the license_usage_roi category', () => {
    expect(isCopilotConnector(connector({ category: 'license_usage_roi' }))).toBe(true);
  });

  it('is false for a generic connector', () => {
    expect(isCopilotConnector(connector({}))).toBe(false);
  });
});

describe('statusTone', () => {
  it('maps healthy and connected to the positive tone', () => {
    expect(statusTone('healthy')).toBe('text-pos');
    expect(statusTone('connected')).toBe('text-pos');
  });

  it('maps auth and validation failures to the negative tone', () => {
    expect(statusTone('auth_failed')).toBe('text-neg');
    expect(statusTone('validation_failed')).toBe('text-neg');
  });

  it('maps syncing and rate_limited to the warning tone', () => {
    expect(statusTone('syncing')).toBe('text-warn');
    expect(statusTone('rate_limited')).toBe('text-warn');
  });

  it('defaults unknown statuses to muted', () => {
    expect(statusTone('whatever')).toBe('text-muted');
  });
});

describe('isoDate', () => {
  it('formats a date as a UTC yyyy-mm-dd string', () => {
    expect(isoDate(new Date('2026-03-04T18:30:00.000Z'))).toBe('2026-03-04');
  });
});

describe('defaultConnectorRange', () => {
  it('returns a 90-day inclusive window ending today', () => {
    const { from, to } = defaultConnectorRange();
    const spanDays =
      (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000;
    expect(spanDays).toBe(89);
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('LOCKED_PRESETS', () => {
  it('locks the built-in provider and outcome presets', () => {
    for (const id of [
      'anthropic-usage',
      'openai-usage',
      'cursor-usage',
      COPILOT_PRESET,
      ADO_PRESET,
    ]) {
      expect(LOCKED_PRESETS.has(id)).toBe(true);
    }
  });

  it('does not lock a generic preset', () => {
    expect(LOCKED_PRESETS.has('generic-rest-spend')).toBe(false);
  });
});
