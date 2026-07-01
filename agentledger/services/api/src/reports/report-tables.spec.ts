import { buildModelSpendTable, buildUserSpendTable, buildTopModelMap } from './report-tables';
import { UNATTRIBUTED_LABEL } from './identity-resolver';

describe('report-tables', () => {
  it('builds user table with pct and top model', () => {
    const topModel = buildTopModelMap([
      { userId: 'u1', model: 'gpt-4o', costUsd: 50 },
      { userId: 'u1', model: 'gpt-4o-mini', costUsd: 10 },
    ]);
    const rows = buildUserSpendTable(
      [{ userId: 'u1', displayName: 'Alice', teamName: 'Eng', costUsd: 60, calls: 5 }],
      topModel,
      100,
    );
    expect(rows[0].topModel).toBe('gpt-4o');
    expect(rows[0].pctOfTotal).toBe(60);
  });

  it('includes unattributed summary without Unknown user', () => {
    const rows = buildUserSpendTable(
      [
        {
          userId: '__unattributed__',
          displayName: `${UNATTRIBUTED_LABEL} (3 identifiers)`,
          teamName: '',
          costUsd: 25,
          calls: 2,
        },
      ],
      new Map(),
      100,
    );
    expect(rows[0].displayName).toContain(UNATTRIBUTED_LABEL);
    expect(rows.every((r) => !r.displayName.includes('Unknown'))).toBe(true);
  });

  it('ranks models globally', () => {
    const rows = buildModelSpendTable(
      [
        { provider: 'openai', model: 'gpt-4o', costUsd: 80, calls: 10 },
        { provider: 'anthropic', model: 'claude-3', costUsd: 40, calls: 5 },
      ],
      120,
    );
    expect(rows[0].model).toBe('gpt-4o');
    expect(rows[0].pctOfTotal).toBeCloseTo(66.67, 1);
  });
});
