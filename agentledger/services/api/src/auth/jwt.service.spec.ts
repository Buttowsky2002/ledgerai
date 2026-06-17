import { JwtService } from './jwt.service';

describe('JwtService', () => {
  let jwt: JwtService;

  beforeAll(() => {
    process.env.AGENTLEDGER_JWT_SECRET = 'unit-test-secret';
    jwt = new JwtService();
  });

  const claims = { userId: 'u-1', tenantId: 't-1', role: 'analyst' };

  it('round-trips an access token to a principal', async () => {
    const token = await jwt.mintAccess(claims);
    const principal = await jwt.verifyAccess(token);
    expect(principal).toEqual({ userId: 'u-1', tenantId: 't-1', role: 'analyst' });
  });

  it('rejects a refresh token used as an access token', async () => {
    const refresh = await jwt.mintRefresh(claims);
    await expect(jwt.verifyAccess(refresh)).rejects.toThrow();
  });

  it('rejects an access token used as a refresh token', async () => {
    const access = await jwt.mintAccess(claims);
    await expect(jwt.verifyRefresh(access)).rejects.toThrow();
  });

  it('rejects a garbage / tampered token', async () => {
    await expect(jwt.verifyAccess('not.a.jwt')).rejects.toThrow();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await jwt.mintAccess(claims);
    process.env.AGENTLEDGER_JWT_SECRET = 'a-different-secret';
    const other = new JwtService();
    await expect(other.verifyAccess(token)).rejects.toThrow();
    process.env.AGENTLEDGER_JWT_SECRET = 'unit-test-secret';
  });
});
