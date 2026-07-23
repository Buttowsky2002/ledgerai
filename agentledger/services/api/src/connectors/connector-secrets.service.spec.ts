import { ConnectorSecretsService } from './connector-secrets.service';
import { PrismaService } from '../prisma/prisma.service';

const KEY_NAMES = [
  'BADGERIQ_CONNECTOR_SECRET_KEY',
  'LEDGERAI_CONNECTOR_SECRET_KEY',
  'AGENTLEDGER_CONNECTOR_SECRET_KEY',
] as const;

describe('ConnectorSecretsService', () => {
  const saved: Record<string, string | undefined> = {};
  const prisma = { withTenant: jest.fn() } as unknown as PrismaService;

  beforeEach(() => {
    for (const k of KEY_NAMES) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
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

  it('does not fall back to BADGERIQ_JWT_SECRET', () => {
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
});
