/**
 * Enrich Cursor Enterprise /analytics/ai-code/commits metrics into canonical
 * coding_commit_attribution fields (lines_ai, ai_source, ai_share_pct).
 */

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export type CursorAiSource = 'tab' | 'composer' | 'mixed' | 'none';

export function classifyCursorAiSource(tabLines: number, composerLines: number): CursorAiSource {
  const tab = tabLines > 0;
  const composer = composerLines > 0;
  if (tab && composer) return 'mixed';
  if (tab) return 'tab';
  if (composer) return 'composer';
  return 'none';
}

/** Stamp lines_ai / ai_source / ai_share_pct from TAB + COMPOSER line counts. */
export function enrichCursorCommitAttribution(
  metrics: Record<string, unknown>,
): Record<string, unknown> {
  if (String(metrics.provider ?? '').toLowerCase() !== 'cursor') return metrics;
  if (!metrics.commit_hash && !metrics.commitHash) return metrics;

  const tabAdded = num(metrics.tab_lines_added ?? metrics.tabLinesAdded);
  const tabDeleted = num(metrics.tab_lines_deleted ?? metrics.tabLinesDeleted);
  const composerAdded = num(metrics.composer_lines_added ?? metrics.composerLinesAdded);
  const composerDeleted = num(metrics.composer_lines_deleted ?? metrics.composerLinesDeleted);
  const totalAdded = num(metrics.lines_total ?? metrics.totalLinesAdded ?? metrics.total_lines_added);
  const totalDeleted = num(metrics.totalLinesDeleted ?? metrics.total_lines_deleted);

  const tabLines = tabAdded + tabDeleted;
  const composerLines = composerAdded + composerDeleted;
  const linesAi = tabLines + composerLines;
  const linesTotal = totalAdded + totalDeleted || linesAi;
  const aiSource = classifyCursorAiSource(tabLines, composerLines);
  const aiSharePct = linesTotal > 0 ? Math.round((linesAi / linesTotal) * 10_000) / 100 : 0;

  const isPrimary =
    metrics.is_production_branch ??
    metrics.isPrimaryBranch ??
    metrics.is_primary_branch;

  return {
    ...metrics,
    lines_ai: linesAi,
    lines_total: linesTotal || num(metrics.lines_total),
    ai_source: aiSource === 'none' ? '' : aiSource,
    ai_share_pct: aiSharePct,
    is_production_branch:
      isPrimary === true || isPrimary === 1 || isPrimary === 'true' ? 1 : 0,
  };
}
