import { providerForFormat, resolvePortalProvider } from './portal-providers';

describe('portal-providers', () => {
  it('maps known formats to providers', () => {
    expect(providerForFormat('anthropic_spend_report')).toBe('anthropic');
    expect(providerForFormat('anthropic_console')).toBe('anthropic');
    expect(providerForFormat('cursor_analytics')).toBe('cursor');
    expect(providerForFormat('unknown')).toBeNull();
  });

  it('prefers explicit override over format detection', () => {
    expect(resolvePortalProvider('unknown', 'openai')).toBe('openai');
    expect(resolvePortalProvider('anthropic_console', 'cursor')).toBe('cursor');
  });
});
