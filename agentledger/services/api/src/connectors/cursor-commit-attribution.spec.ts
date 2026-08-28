import { classifyCursorAiSource, enrichCursorCommitAttribution } from './cursor-commit-attribution';

describe('enrichCursorCommitAttribution', () => {
  it('computes lines_ai, ai_source, and ai_share_pct from TAB + COMPOSER', () => {
    const out = enrichCursorCommitAttribution({
      provider: 'cursor',
      commit_hash: 'a1b2c3d4',
      tabLinesAdded: 50,
      tabLinesDeleted: 10,
      composerLinesAdded: 40,
      composerLinesDeleted: 5,
      totalLinesAdded: 120,
      totalLinesDeleted: 30,
      isPrimaryBranch: true,
    });
    expect(out.lines_ai).toBe(105);
    expect(out.lines_total).toBe(150);
    expect(out.ai_source).toBe('mixed');
    expect(out.ai_share_pct).toBe(70);
    expect(out.is_production_branch).toBe(1);
  });

  it('classifies tab-only and composer-only', () => {
    expect(classifyCursorAiSource(10, 0)).toBe('tab');
    expect(classifyCursorAiSource(0, 5)).toBe('composer');
    expect(classifyCursorAiSource(0, 0)).toBe('none');
  });
});
