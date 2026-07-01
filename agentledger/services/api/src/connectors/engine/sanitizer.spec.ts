import { sanitizeForPreview, safeErrorMessage, stripBlockedFields } from './sanitizer';

describe('sanitizer', () => {
  it('redacts secret fields in preview', () => {
    const out = sanitizeForPreview({ api_key: 'sk-secret', model: 'gpt-4o' }) as Record<string, unknown>;
    expect(out.api_key).toBe('[redacted]');
    expect(out.model).toBe('gpt-4o');
  });

  it('strips prompt/completion content', () => {
    const out = stripBlockedFields({ prompt: 'secret prompt', model: 'x' });
    expect(out).not.toHaveProperty('prompt');
    expect(out.model).toBe('x');
  });

  it('redacts bearer tokens in error messages', () => {
    expect(safeErrorMessage('Auth failed Bearer sk-abc123xyz')).not.toContain('sk-abc123xyz');
  });
});
