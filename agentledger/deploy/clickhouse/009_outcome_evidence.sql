-- AgentLedger ClickHouse migration 009 — deterministic-link evidence
--
-- Phase 3 deepening, sub-phase 3.1 (docs/ATTRIBUTION_ENGINE_BUILD.md §3.1; ADR-040).
-- Connector-discovered HARD links between an outcome and the agent run that
-- produced it: a Co-Authored-By trailer carrying a session id, an SDK session-id
-- stamp in PR/issue/commit metadata, a direct agent-API close event. These feed
-- the deterministic resolver, which emits method=deterministic edges that double
-- as the ground-truth LABELS the probabilistic scorer (3.3) trains on.
--
-- This is SEPARATE from agent_runs.outcome_id (the SDK's own runtime assertion):
-- outcome_evidence is what a connector finds AFTER the fact in the merged artifact.
--
-- A row is only DETERMINISTIC when it concretely names a run (run_id != ''); an
-- agent-only trailer with no session id is left to the probabilistic stages.
--
-- SECURITY (CLAUDE.md rule 2; §7 — evidence not payloads): evidence_ref holds a
-- STRUCTURAL reference only (PR/issue URL, session id, trailer identity, linked
-- ticket id) — NEVER raw commit/PR/issue body or prompt/completion content.
-- tenant_id leads ORDER BY (rule 3).
--
-- Forward-only; never edit an applied migration.

CREATE TABLE IF NOT EXISTS agentledger.outcome_evidence
(
    tenant_id     LowCardinality(String),
    outcome_id    String,
    evidence_type LowCardinality(String),   -- sdk_session_link | co_authored_by | api_close
    run_id        String DEFAULT '',        -- the run the evidence names; deterministic only when set
    agent_id      String DEFAULT '',
    evidence_ref  String DEFAULT '',         -- structural reference only — never raw content (rule 2)
    ts            DateTime64(3)
)
ENGINE = ReplacingMergeTree(ts)             -- dedup on (tenant, outcome, type, run); latest ts wins
PARTITION BY toYYYYMM(ts)
ORDER BY (tenant_id, outcome_id, evidence_type, run_id);
