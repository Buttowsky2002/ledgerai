import { BadRequestException } from '@nestjs/common';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { PrismaService } from '../prisma/prisma.service';
import { Principal, runWithTenant } from '../tenant/tenant-context';
import { ImportEventsDto } from './import.dto';
import { ImportService } from './import.service';

const principal: Principal = { tenantId: 'tenant-1', userId: 'u1', role: 'admin' };

/**
 * `reserveReturns` is the set of idempotency keys the authoritative reservation
 * (INSERT … ON CONFLICT DO NOTHING RETURNING) reports THIS transaction won — i.e.
 * keys not already taken by an earlier/concurrent import. `existingForDryRun` is
 * what the read-only dry-run existence check sees as already imported.
 */
function harness(opts: { reserveReturns?: string[]; existingForDryRun?: string[] } = {}) {
  const queryRaw = jest.fn(async () => (opts.reserveReturns ?? []).map((k) => ({ idempotency_key: k })));
  const findMany = jest.fn(async () => (opts.existingForDryRun ?? []).map((k) => ({ idempotencyKey: k })));
  const auditCreate = jest.fn(async () => ({}));
  const insertRows = jest.fn<Promise<void>, [string, Record<string, unknown>[]]>();

  const tx = {
    $queryRaw: queryRaw,
    importIdempotency: { findMany },
    auditLog: { create: auditCreate },
  };
  const prisma = {
    withTenant: jest.fn(async (_t: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  const ch = { insertRows } as unknown as ClickHouseService;

  return { svc: new ImportService(ch, prisma), queryRaw, findMany, auditCreate, insertRows };
}

const run = (svc: ImportService, dto: ImportEventsDto) => runWithTenant(principal, () => svc.importEvents(dto));

describe('ImportService.importEvents', () => {
  it('imports rows it won, grouping events per table and stamping tenant_id from the principal', async () => {
    const { svc, insertRows, queryRaw, auditCreate } = harness({ reserveReturns: ['k1', 'k2'] });
    const summary = await run(svc, {
      events: [
        { idempotency_key: 'k1', model: 'gpt-4o', input_tokens: 10, cost_usd: 0.01, tenant_id: 'ATTACKER' },
        { idempotency_key: 'k2', outcome_type: 'merged_pr', outcome_value_usd: 100 },
      ],
    });

    expect(summary).toMatchObject({ received: 2, imported: 2, skipped: 0, keyless: 0, events: 2 });
    expect(summary.byTable).toEqual({ llm_calls: 1, outcomes: 1 });
    expect(insertRows).toHaveBeenCalledTimes(2);
    expect(queryRaw).toHaveBeenCalledTimes(1); // the authoritative reservation

    const llm = insertRows.mock.calls.find((c) => c[0] === 'llm_calls');
    // tenant_id is forced to the principal's, never the attacker-supplied value.
    expect(llm![1][0]).toMatchObject({ tenant_id: 'tenant-1' });
    expect(JSON.stringify(llm)).not.toContain('ATTACKER');
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it('skips a key it lost to a concurrent/earlier import (reservation returns only the won key)', async () => {
    // Batch carries k1+k2 but the reservation only returns k2 (k1 was won elsewhere).
    const { svc, insertRows } = harness({ reserveReturns: ['k2'] });
    const summary = await run(svc, {
      events: [
        { idempotency_key: 'k1', model: 'gpt-4o', input_tokens: 10 },
        { idempotency_key: 'k2', outcome_type: 'lead', outcome_value_usd: 5 },
      ],
    });

    expect(summary).toMatchObject({ received: 2, imported: 1, skipped: 1 });
    expect(summary.byTable).toEqual({ outcomes: 1 });
    expect(insertRows).toHaveBeenCalledTimes(1);
    expect(insertRows.mock.calls[0][0]).toBe('outcomes');
  });

  it('always imports keyless rows and counts them (no de-duplication)', async () => {
    const { svc, insertRows, queryRaw } = harness();
    const summary = await run(svc, { events: [{ model: 'gpt-4o', input_tokens: 1 }] });
    expect(summary).toMatchObject({ received: 1, imported: 1, skipped: 0, keyless: 1 });
    expect(queryRaw).not.toHaveBeenCalled(); // no keys to reserve
    expect(insertRows).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates an idempotency key repeated within one batch before reserving', async () => {
    const { svc, insertRows } = harness({ reserveReturns: ['dup'] });
    const summary = await run(svc, {
      events: [
        { idempotency_key: 'dup', model: 'gpt-4o', input_tokens: 1 },
        { idempotency_key: 'dup', model: 'gpt-4o', input_tokens: 1 },
      ],
    });
    expect(summary).toMatchObject({ received: 2, imported: 1, skipped: 1 });
    expect(insertRows.mock.calls[0][1].length).toBe(1);
  });

  it('dry run uses a read-only existence check and writes nothing', async () => {
    const { svc, insertRows, queryRaw, auditCreate, findMany } = harness({ existingForDryRun: ['k1'] });
    const summary = await run(svc, {
      dryRun: true,
      events: [
        { idempotency_key: 'k1', model: 'gpt-4o', input_tokens: 1 },
        { idempotency_key: 'k2', model: 'gpt-4o', input_tokens: 1 },
      ],
    });
    expect(summary).toMatchObject({ received: 2, imported: 1, skipped: 1, dryRun: true });
    expect(findMany).toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled(); // no reservation on a dry run
    expect(insertRows).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('reserves keys BEFORE inserting to ClickHouse (rollback-safe ordering)', async () => {
    const { svc, insertRows, queryRaw } = harness({ reserveReturns: ['k1'] });
    await run(svc, { events: [{ idempotency_key: 'k1', model: 'gpt-4o', input_tokens: 1 }] });
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(insertRows.mock.invocationCallOrder[0]);
  });

  it('propagates a ClickHouse insert failure (so the transaction rolls back)', async () => {
    const { svc, insertRows } = harness();
    insertRows.mockRejectedValueOnce(new Error('clickhouse 500'));
    await expect(run(svc, { events: [{ model: 'gpt-4o', input_tokens: 1 }] })).rejects.toThrow(/clickhouse 500/);
  });

  it('rejects the whole batch with line numbers when any row is invalid', async () => {
    const { svc, insertRows, queryRaw } = harness();
    let thrown: unknown;
    try {
      await run(svc, {
        events: [
          { model: 'gpt-4o', input_tokens: 1 },
          { team_id: 't1' }, // line 2: no importable fields
        ],
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    const body = (thrown as BadRequestException).getResponse() as { errors: { line: number }[] };
    expect(body.errors[0].line).toBe(2);
    expect(insertRows).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range attribution_confidence (> 1)', async () => {
    const { svc, insertRows } = harness();
    let thrown: unknown;
    try {
      await run(svc, { events: [{ outcome_type: 'lead', attribution_confidence: 5 }] });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    const body = (thrown as BadRequestException).getResponse() as { errors: { message: string }[] };
    expect(body.errors[0].message).toMatch(/attribution_confidence/i);
    expect(insertRows).not.toHaveBeenCalled();
  });

  it('throws when there is no tenant in context', async () => {
    const { svc } = harness();
    await expect(svc.importEvents({ events: [{ model: 'gpt-4o', input_tokens: 1 }] })).rejects.toThrow(/no tenant/i);
  });
});
