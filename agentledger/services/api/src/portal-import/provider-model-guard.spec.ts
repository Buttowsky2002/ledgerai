import {
  cursorOnlyModelReason,
  detectProviderModelConflicts,
  providerModelConflictMessage,
} from './provider-model-guard';

describe('cursorOnlyModelReason', () => {
  it('flags Cursor-exclusive model families', () => {
    expect(cursorOnlyModelReason('composer-2.5-fast')).toBe('sold only by Cursor');
    expect(cursorOnlyModelReason('composer-2.5')).toBe('sold only by Cursor');
    expect(cursorOnlyModelReason('agent_review')).toBe('sold only by Cursor');
    expect(cursorOnlyModelReason('premium')).toBe('sold only by Cursor');
    expect(cursorOnlyModelReason('default')).toBe('sold only by Cursor');
  });

  it("flags Cursor's reasoning-effort annotations", () => {
    expect(cursorOnlyModelReason('claude-opus-4-8-thinking-high')).toBe(
      "carries Cursor's reasoning-effort annotation",
    );
    expect(cursorOnlyModelReason('claude-4.5-sonnet-thinking')).toBe(
      "carries Cursor's reasoning-effort annotation",
    );
    expect(cursorOnlyModelReason('grok-4.5-fast-xhigh')).toBe(
      "carries Cursor's reasoning-effort annotation",
    );
  });

  it('accepts genuine provider API model ids', () => {
    expect(cursorOnlyModelReason('claude-sonnet-4-20250514')).toBeNull();
    expect(cursorOnlyModelReason('claude-3-5-haiku-20241022')).toBeNull();
    expect(cursorOnlyModelReason('gpt-4o-2024-08-06')).toBeNull();
    expect(cursorOnlyModelReason('gemini-1.5-pro')).toBeNull();
  });

  it('does not treat a reseller-shared family name as proof of origin', () => {
    // Cursor resells Claude, so "claude" alone must never trigger a conflict.
    expect(cursorOnlyModelReason('claude-opus-4')).toBeNull();
  });

  it('ignores blank and non-string models', () => {
    expect(cursorOnlyModelReason('')).toBeNull();
    expect(cursorOnlyModelReason('   ')).toBeNull();
    expect(cursorOnlyModelReason(undefined)).toBeNull();
    expect(cursorOnlyModelReason(null)).toBeNull();
  });
});

describe('detectProviderModelConflicts', () => {
  it('rejects the pilot incident: a Cursor export stamped anthropic', () => {
    const models = [
      'claude-opus-4-8-thinking-high',
      'claude-fable-5-thinking-high',
      'claude-sonnet-5-thinking-high',
      'composer-2.5-fast',
      'claude-4.5-sonnet-thinking',
    ];
    const conflicts = detectProviderModelConflicts('anthropic', models);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.map((c) => c.model)).toContain('composer-2.5-fast');
  });

  it('never flags anything when the selected provider is Cursor', () => {
    expect(detectProviderModelConflicts('cursor', ['composer-2.5-fast', 'premium'])).toEqual([]);
  });

  it('passes a genuine Anthropic console export', () => {
    expect(
      detectProviderModelConflicts('anthropic', [
        'claude-sonnet-4-20250514',
        'claude-3-5-haiku-20241022',
      ]),
    ).toEqual([]);
  });

  it('deduplicates repeated models and caps the list', () => {
    const models = Array(50).fill('composer-2.5-fast');
    expect(detectProviderModelConflicts('anthropic', models)).toEqual([
      { model: 'composer-2.5-fast', reason: 'sold only by Cursor' },
    ]);

    const many = ['composer-1', 'agent_review', 'premium', 'default', 'auto', 'composer-9'];
    expect(detectProviderModelConflicts('anthropic', many, 3)).toHaveLength(3);
  });

  it('returns nothing when no provider was selected', () => {
    expect(detectProviderModelConflicts('', ['composer-2.5-fast'])).toEqual([]);
  });
});

describe('providerModelConflictMessage', () => {
  it('names the provider, the offending models, and the remedy', () => {
    const msg = providerModelConflictMessage('anthropic', [
      { model: 'composer-2.5-fast', reason: 'sold only by Cursor' },
    ]);
    expect(msg).toContain('anthropic');
    expect(msg).toContain('composer-2.5-fast');
    expect(msg).toContain('sold only by Cursor');
    expect(msg).toContain('Cursor as the billing provider');
  });
});
