import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { ConnectorSecretsService } from './connector-secrets.service';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-context';

const KEY_NAMES = [
  'BADGERIQ_CONNECTOR_SECRET_KEY',
  'LEDGERAI_CONNECTOR_SECRET_KEY',
  'AGENTLEDGER_CONNECTOR_SECRET_KEY',
  'AGENTLEDGER_JWT_SECRET',
  'BADGERIQ_JWT_SECRET',
] as const;

function encryptWithRawKey(rawKey: string, plaintext: string): string {
  const key = createHash('sha256').update(rawKey).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

describe('ConnectorSecretsService', () => {
  const saved: Record<string, string | undefined> = {};
  const update = jest.fn(async () => ({}));
  const findUnique = jest.fn();
  const withTenant = jest.fn(
    async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ connectorSecret: { findUnique, update, create: jest.fn(), deleteMany: jest.fn() } }),
  );
  const prisma = { withTenant } as unknown as PrismaService;

  beforeEach(() => {
    for (const k of KEY_NAMES) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    findUnique.mockReset();
    update.mockReset();
    withTenant.mockClear();
  });

  afterEach(() => {
    for (const k of KEY_NAMES) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  it('throws when BADGERIQ_CONNECTOR_SECRET_KEY is missing', () => {
    expect(() => new ConnectorSecretsService(prisma)).toThrow(
      /BADGERIQ_CONNECTOR_SECRET_KEY must be set/,
    );
  });

  it('throws when the key is shorter than 32 characters', () => {
    process.env.BADGERIQ_CONNECTOR_SECRET_KEY = 'too-short';
    expect(() => new ConnectorSecretsService(prisma)).toThrow(
      /BADGERIQ_CONNECTOR_SECRET_KEY must be set/,
    );
  });

  it('does not construct when only JWT is set (no dedicated key)', () => {
    process.env.BADGERIQ_JWT_SECRET = 'x'.repeat(40);
    process.env.AGENTLEDGER_JWT_SECRET = 'y'.repeat(40);
    expect(() => new ConnectorSecretsService(prisma)).toThrow(
      /BADGERIQ_CONNECTOR_SECRET_KEY must be set/,
    );
  });

  it('accepts a 32+ character key via BADGERIQ_ prefix', () => {
    process.env.BADGERIQ_CONNECTOR_SECRET_KEY = 'a'.repeat(32);
    expect(() => new ConnectorSecretsService(prisma)).not.toThrow();
  });

  it('accepts AGENTLEDGER_CONNECTOR_SECRET_KEY alias', () => {
    process.env.AGENTLEDGER_CONNECTOR_SECRET_KEY = 'b'.repeat(32);
    expect(() => new ConnectorSecretsService(prisma)).not.toThrow();
  });

  it('re-encrypts JWT-legacy ciphertext onto the dedicated key on resolve', async () => {
    const dedicated = 'd'.repeat(32);
    const jwt = 'j'.repeat(40);
    process.env.BADGERIQ_CONNECTOR_SECRET_KEY = dedicated;
    process.env.AGENTLEDGER_JWT_SECRET = jwt;

    const plaintext = JSON.stringify({ api_key: 'cursor-test-key' });
    const legacyCipher = encryptWithRawKey(jwt, plaintext);
    findUnique.mockResolvedValue({ secretId: 'sec-1', ciphertext: legacyCipher });

    const svc = new ConnectorSecretsService(prisma);
    const principal = { tenantId: 'tenant-1', userId: 'u', role: 'admin' as const };
    const out = await runWithTenant(principal, () => svc.resolveSecret('sec-1'));
    expect(out).toBe(plaintext);
    expect(update).toHaveBeenCalledTimes(1);
    const updateArg = update.mock.calls[0][0];
    const nextCipher = updateArg.data.ciphertext;
    expect(nextCipher).not.toBe(legacyCipher);

    // Second resolve uses dedicated key only (no further rekey).
    findUnique.mockResolvedValue({ secretId: 'sec-1', ciphertext: nextCipher });
    update.mockClear();
    const out2 = await runWithTenant(principal, () => svc.resolveSecret('sec-1'));
    expect(out2).toBe(plaintext);
    expect(update).not.toHaveBeenCalled();
  });
});
