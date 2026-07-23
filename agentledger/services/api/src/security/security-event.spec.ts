import { logSecurityEvent, type SecurityEvent } from './security-event';

describe('logSecurityEvent', () => {
  it('accepts the SecurityEvent shape without throwing', () => {
    const event: SecurityEvent = {
      type: 'auth.login_failure',
      tenantId: null,
      userId: null,
      ip: '127.0.0.1',
      userAgent: 'jest',
      detail: { reason: 'no_identity' },
    };
    expect(() => logSecurityEvent(event)).not.toThrow();
  });

  it('does not require detail', () => {
    expect(() =>
      logSecurityEvent({
        type: 'auth.logout',
        tenantId: 't1',
        userId: 'u1',
        ip: '10.0.0.1',
        userAgent: 'curl/8',
      }),
    ).not.toThrow();
  });
});
