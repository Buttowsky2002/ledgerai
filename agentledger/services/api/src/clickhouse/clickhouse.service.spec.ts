import { ClickHouseService, requireTenantFilter } from './clickhouse.service';
import { Principal, runWithTenant } from '../tenant/tenant-context';

describe('requireTenantFilter', () => {
  it('accepts tenant_id = {tenant:String}', () => {
    expect(() => requireTenantFilter('SELECT 1 FROM x WHERE tenant_id = {tenant:String}')).not.toThrow();
  });

  it('accepts the no-space form tenant_id={tenant:String}', () => {
    expect(() => requireTenantFilter('SELECT 1 FROM x WHERE tenant_id={tenant:String}')).not.toThrow();
  });

  it('accepts an aliased filter alias.tenant_id = {tenant:String}', () => {
    expect(() => requireTenantFilter('SELECT 1 FROM x t WHERE t.tenant_id = {tenant:String}')).not.toThrow();
  });

  it('rejects a query with no tenant filter', () => {
    expect(() => requireTenantFilter('SELECT * FROM x WHERE day BETWEEN {from:Date} AND {to:Date}')).toThrow(
      /tenant filter/i,
    );
  });

  it('rejects a filter bound to some other param (not the principal tenant)', () => {
    expect(() => requireTenantFilter('SELECT 1 FROM x WHERE tenant_id = {evil:String}')).toThrow();
  });

  it('does not accept a join condition as the tenant filter', () => {
    // `r.tenant_id = o.tenant_id` is a join predicate, not a bound-tenant filter.
    expect(() => requireTenantFilter('SELECT 1 FROM a r JOIN b o ON r.tenant_id = o.tenant_id')).toThrow();
  });
});

describe('ClickHouseService.queryScoped', () => {
  const svc = new ClickHouseService();
  const principal: Principal = { tenantId: 'real-tenant', userId: 'u1', role: 'admin' };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('runs a query that contains the tenant filter', async () => {
    await runWithTenant(principal, async () => {
      await expect(
        svc.queryScoped('SELECT 1 FROM x WHERE tenant_id = {tenant:String}'),
      ).resolves.toEqual([]);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws (and never calls ClickHouse) on a query without a tenant filter', async () => {
    await runWithTenant(principal, async () => {
      await expect(svc.queryScoped('SELECT * FROM x')).rejects.toThrow(/tenant filter/i);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('binds the principal tenant and ignores a caller-supplied tenant param', async () => {
    await runWithTenant(principal, async () => {
      await svc.queryScoped('SELECT 1 FROM x WHERE tenant_id = {tenant:String}', { tenant: 'attacker' });
    });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('param_tenant=real-tenant');
    expect(url).not.toContain('attacker');
  });

  it('throws when there is no tenant context', async () => {
    await expect(
      svc.queryScoped('SELECT 1 FROM x WHERE tenant_id = {tenant:String}'),
    ).rejects.toThrow(/no tenant/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
