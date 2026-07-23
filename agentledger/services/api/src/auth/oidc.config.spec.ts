import { loadOidcProviders, microsoftDefaultIssuer } from './oidc.config';

describe('microsoftDefaultIssuer', () => {
  const prevAgent = process.env.AGENTLEDGER_OIDC_MICROSOFT_TENANT_ID;
  const prevBadger = process.env.BADGERIQ_OIDC_MICROSOFT_TENANT_ID;

  afterEach(() => {
    if (prevAgent === undefined) delete process.env.AGENTLEDGER_OIDC_MICROSOFT_TENANT_ID;
    else process.env.AGENTLEDGER_OIDC_MICROSOFT_TENANT_ID = prevAgent;
    if (prevBadger === undefined) delete process.env.BADGERIQ_OIDC_MICROSOFT_TENANT_ID;
    else process.env.BADGERIQ_OIDC_MICROSOFT_TENANT_ID = prevBadger;
  });

  it('uses /common/ when no tenant id is set', () => {
    delete process.env.AGENTLEDGER_OIDC_MICROSOFT_TENANT_ID;
    delete process.env.BADGERIQ_OIDC_MICROSOFT_TENANT_ID;
    expect(microsoftDefaultIssuer()).toBe('https://login.microsoftonline.com/common/v2.0');
  });

  it('locks issuer to the Entra tenant id', () => {
    process.env.AGENTLEDGER_OIDC_MICROSOFT_TENANT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    delete process.env.BADGERIQ_OIDC_MICROSOFT_TENANT_ID;
    expect(microsoftDefaultIssuer()).toBe(
      'https://login.microsoftonline.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/v2.0',
    );
  });
});

describe('loadOidcProviders microsoft tenant lock', () => {
  const keys = [
    'AGENTLEDGER_OIDC_MICROSOFT_CLIENT_ID',
    'AGENTLEDGER_OIDC_MICROSOFT_CLIENT_SECRET',
    'AGENTLEDGER_OIDC_MICROSOFT_ISSUER',
    'AGENTLEDGER_OIDC_MICROSOFT_TENANT_ID',
    'AGENTLEDGER_OIDC_GOOGLE_CLIENT_ID',
    'AGENTLEDGER_OIDC_GOOGLE_CLIENT_SECRET',
  ] as const;
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of keys) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  it('applies tenant-locked issuer when client credentials are present', () => {
    process.env.AGENTLEDGER_OIDC_MICROSOFT_CLIENT_ID = 'cid';
    process.env.AGENTLEDGER_OIDC_MICROSOFT_CLIENT_SECRET = 'csecret';
    process.env.AGENTLEDGER_OIDC_MICROSOFT_TENANT_ID = 'tid-1';
    const ms = loadOidcProviders().find((p) => p.name === 'microsoft');
    expect(ms?.issuer).toBe('https://login.microsoftonline.com/tid-1/v2.0');
  });

  it('prefers an explicit issuer env over the tenant default', () => {
    process.env.AGENTLEDGER_OIDC_MICROSOFT_CLIENT_ID = 'cid';
    process.env.AGENTLEDGER_OIDC_MICROSOFT_CLIENT_SECRET = 'csecret';
    process.env.AGENTLEDGER_OIDC_MICROSOFT_TENANT_ID = 'tid-1';
    process.env.AGENTLEDGER_OIDC_MICROSOFT_ISSUER = 'https://login.microsoftonline.com/other/v2.0';
    const ms = loadOidcProviders().find((p) => p.name === 'microsoft');
    expect(ms?.issuer).toBe('https://login.microsoftonline.com/other/v2.0');
  });
});
