import { _clearSecretCache, resolveSecret } from './secret-resolver';

/**
 * Unit coverage for the secret-ref resolver (no AWS calls). The env path must resolve
 * without touching Secrets Manager; the SM path must be opt-in. The AWS SDK is mocked
 * so nothing hits the network and so we can assert the env path never constructs a client.
 */
const send = jest.fn();
const SecretsManagerClient = jest.fn(() => ({ send }));
const GetSecretValueCommand = jest.fn((args: unknown) => args);

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient,
  GetSecretValueCommand,
}));

const ENV_KEYS = ['ACME_OIDC_SECRET', 'BADGERIQ_SM_ENABLED', 'AWS_REGION'];

describe('resolveSecret', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    _clearSecretCache();
    send.mockReset();
    SecretsManagerClient.mockClear();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('resolves from the environment without touching Secrets Manager', async () => {
    process.env.ACME_OIDC_SECRET = 'shhh';
    await expect(resolveSecret('ACME_OIDC_SECRET')).resolves.toBe('shhh');
    expect(SecretsManagerClient).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('throws when the ref is absent and SM is disabled (opt-in)', async () => {
    await expect(resolveSecret('MISSING_REF')).rejects.toThrow(/SM is disabled/);
    expect(SecretsManagerClient).not.toHaveBeenCalled();
  });

  it('falls back to Secrets Manager when enabled, and caches the result', async () => {
    process.env.BADGERIQ_SM_ENABLED = 'true';
    send.mockResolvedValue({ SecretString: 'from-sm' });

    await expect(resolveSecret('acme/oidc-secret')).resolves.toBe('from-sm');
    // Second call within the TTL is served from cache — no second SM round-trip.
    await expect(resolveSecret('acme/oidc-secret')).resolves.toBe('from-sm');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
