// Outcomes — the ROI differentiator. Attribute a business result to the run that
// produced it, with a confidence the attribution engine can weight.
import { LedgerAI } from '../src/index';

const ledger = new LedgerAI({ apiKey: process.env.BADGERIQ_KEY, baseUrl: process.env.BADGERIQ_URL });

export async function recordMergedPR(runId: string, prNumber: string): Promise<void> {
  ledger.outcome({
    type: 'pr_merged',
    sourceSystem: 'github',
    ref: prNumber,
    valueUsd: 250, // value this outcome delivered (drives ROI)
    attributionConfidence: 0.95, // 0..1; agent-stamped PR ⇒ high confidence
    agentId: 'code-review-agent',
    runId,
  });
  await ledger.flush();
}
