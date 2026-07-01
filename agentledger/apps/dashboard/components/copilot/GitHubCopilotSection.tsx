'use client';

import { GitHubCopilotDetail } from './GitHubCopilotDetail';

/** Standalone Copilot section (legacy). Prefer OverviewAiSourcesPanel drill-down on Overview. */
export function GitHubCopilotSection({ from, to }: { from: string; to: string }) {
  return <GitHubCopilotDetail from={from} to={to} embedded={false} />;
}
