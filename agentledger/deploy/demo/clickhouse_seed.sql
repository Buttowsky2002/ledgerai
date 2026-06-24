-- LedgerAI demo seed — analytics plane (ClickHouse).
--
-- Synthetic, content-free activity for one demo tenant across 8 named agents,
-- engineered so the LARI engine returns a FULL SPREAD of recommendations on the
-- overview — a portfolio a FinOps lead would actually have to triage — WITHOUT any
-- provider keys. Each agent is tuned (value, attribution confidence, fully-loaded
-- cost via roi_rates, and risk severity) to land on a distinct recommendation:
--   • InvoiceReviewAgent      → SCALE            (high value, low cost, deterministic attribution)
--   • CodeReviewAgent         → MAINTAIN         (confident, solid mid-range ROI)
--   • ContractSummarizerAgent → OPTIMIZE         (confident but thin margin — squeeze cost)
--   • SupportBot              → IMPROVE_EVIDENCE (profitable but attribution too weak to trust)
--   • RefundApprovalAgent     → INVESTIGATE      (loses money once human review is loaded in)
--   • DataCleanupAgent        → RETIRE           (runaway cost, ~no attributable value)
--   • SOC-TriageAgent         → PAUSE            (critical risk + negative return)
--   • SalesResearchAgent      → REQUIRE_APPROVAL (positive ROI gated behind critical risk)
--
-- Inserting llm_calls auto-populates the spend_daily / spend_hourly_by_key /
-- risk_daily materialized views; agent_runs + outcomes + roi_rates drive v_roi and
-- the LARI rollup; agent_tool_calls + risk_events + agent_risk drive the CISO view.
--
-- Idempotent: the DELETEs run synchronously (mutations_sync=2) before the INSERTs.
-- Tenant id is passed as {tenant:String} (a valid UUID — the API validates the
-- dev x-tenant-id header as a UUID).

ALTER TABLE agentledger.llm_calls           DELETE WHERE tenant_id = {tenant:String} SETTINGS mutations_sync = 2;
ALTER TABLE agentledger.spend_daily         DELETE WHERE tenant_id = {tenant:String} SETTINGS mutations_sync = 2;
ALTER TABLE agentledger.spend_hourly_by_key DELETE WHERE tenant_id = {tenant:String} SETTINGS mutations_sync = 2;
ALTER TABLE agentledger.risk_daily          DELETE WHERE tenant_id = {tenant:String} SETTINGS mutations_sync = 2;
ALTER TABLE agentledger.agent_runs          DELETE WHERE tenant_id = {tenant:String} SETTINGS mutations_sync = 2;
ALTER TABLE agentledger.outcomes            DELETE WHERE tenant_id = {tenant:String} SETTINGS mutations_sync = 2;
ALTER TABLE agentledger.roi_rates           DELETE WHERE tenant_id = {tenant:String} SETTINGS mutations_sync = 2;
ALTER TABLE agentledger.agent_tool_calls    DELETE WHERE tenant_id = {tenant:String} SETTINGS mutations_sync = 2;
ALTER TABLE agentledger.risk_events         DELETE WHERE tenant_id = {tenant:String} SETTINGS mutations_sync = 2;
ALTER TABLE agentledger.agent_risk          DELETE WHERE tenant_id = {tenant:String} SETTINGS mutations_sync = 2;

-- ── 1,000 LLM calls across the 8 agents (round-robin), last ~30 days ──────────
INSERT INTO agentledger.llm_calls
(call_id, ts, tenant_id, team_id, user_id, app_id, environment, virtual_key_id,
 agent_id, run_id, step_id, provider, request_model, response_model, operation_name,
 input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
 latency_ms, status_code, status, prompt_hash, dlp_action, risk_severity,
 dlp_findings, streamed, source)
SELECT
  concat('demo_call_', toString(number)),
  now() - toIntervalMinute(number * 43),
  {tenant:String},
  arrayElement(['Customer Support', 'Finance', 'Security', 'Engineering', 'Engineering', 'Security', 'Customer Support', 'Finance'], ai),
  concat('demo-user-', toString(number % 9)),
  arrayElement(['support-suite', 'finance-suite', 'security-suite', 'sales-suite', 'dev-suite', 'data-suite', 'support-suite', 'legal-suite'], ai),
  'prod',
  concat('vk_demo_', toString(ai)),
  agent,
  concat('call_run_', toString(number % 50)),
  '',
  arrayElement(['openai', 'openai', 'anthropic', 'openai', 'anthropic', 'openai', 'openai', 'anthropic'], ai),
  req_model,
  arrayElement(['gpt-4o-mini-2024-07-18', 'gpt-4o-2024-11-20', 'claude-3-5-sonnet-20241022', 'gpt-4o-mini-2024-07-18', 'claude-3-5-sonnet-20241022', 'gpt-4o-2024-11-20', 'gpt-4o-mini-2024-07-18', 'claude-3-5-sonnet-20241022'], ai),
  'chat',
  in_tok,
  out_tok,
  toUInt32(number % 150),
  toUInt32(0),
  round((toFloat64(in_tok) * in_rate + toFloat64(out_tok) * out_rate) / 1000000.0 * cost_mult, 6),
  toUInt32(200 + number % 1800),
  multiIf(agent = 'DataCleanupAgent' AND number % 9 = 0, toUInt16(402), number % 50 = 0, toUInt16(502), toUInt16(200)),
  multiIf(agent = 'DataCleanupAgent' AND number % 9 = 0, 'blocked_budget', number % 50 = 0, 'upstream_error', 'ok'),
  '',
  multiIf(agent = 'SOC-TriageAgent' AND number % 3 = 0, 'block',
          agent = 'SOC-TriageAgent' AND number % 3 = 1, 'redact',
          agent = 'DataCleanupAgent' AND number % 5 = 0, 'redact',
          'allow'),
  multiIf(agent = 'SOC-TriageAgent' AND number % 3 = 0, 'critical',
          agent = 'SOC-TriageAgent' AND number % 3 = 1, 'high',
          agent = 'DataCleanupAgent' AND number % 5 = 0, 'medium',
          ''),
  '[]',
  toUInt8(0),
  'gateway'
FROM (
  SELECT
    number,
    toInt32(number % 8) + 1 AS ai,
    arrayElement(['SupportBot', 'InvoiceReviewAgent', 'SOC-TriageAgent', 'SalesResearchAgent', 'CodeReviewAgent', 'DataCleanupAgent', 'RefundApprovalAgent', 'ContractSummarizerAgent'], ai) AS agent,
    arrayElement(['gpt-4o-mini', 'gpt-4o', 'claude-3-5-sonnet', 'gpt-4o-mini', 'claude-3-5-sonnet', 'gpt-4o', 'gpt-4o-mini', 'claude-3-5-sonnet'], ai) AS req_model,
    -- DataCleanupAgent runs huge contexts (the runaway-cost story).
    if(agent = 'DataCleanupAgent', toUInt32(4000 + number % 6000), toUInt32(300 + number % 900)) AS in_tok,
    if(agent = 'DataCleanupAgent', toUInt32(1500 + number % 3000), toUInt32(120 + number % 500)) AS out_tok,
    multiIf(req_model = 'gpt-4o', 2.5, req_model = 'gpt-4o-mini', 0.15, req_model = 'claude-3-5-sonnet', 3.0, 2.5) AS in_rate,
    multiIf(req_model = 'gpt-4o', 10.0, req_model = 'gpt-4o-mini', 0.6, req_model = 'claude-3-5-sonnet', 15.0, 10.0) AS out_rate,
    -- DataCleanupAgent is also priced up (18×); InvoiceReviewAgent is lean (0.6×).
    arrayElement([0.8, 0.6, 1.0, 0.9, 1.2, 18.0, 0.7, 1.1], ai) AS cost_mult
  FROM numbers(1000)
);

-- ── 40 agent runs, one outcome each, round-robin across all 8 agents (slot =
--    number % 8) so every agent has attributed outcomes the LARI engine can score.
--    Run cost is modest for the producers and runs away for DataCleanupAgent. ───
INSERT INTO agentledger.agent_runs
(run_id, tenant_id, agent_id, app_id, user_id, started_at, ended_at, status,
 objective, outcome_id, total_cost_usd, total_tokens, llm_calls, tool_calls, risk_events)
SELECT
  concat('run_', toString(number)),
  {tenant:String},
  agent,
  'demo-suite',
  concat('demo-user-', toString(number % 9)),
  now() - toIntervalHour(number * 6),
  now() - toIntervalHour(number * 6) + toIntervalSecond(30 + number % 240),
  if(number % 13 = 0, 'failed', 'completed'),
  'demo objective',
  concat('out_', toString(number)),
  run_cost,
  toUInt64(1500 + number % 6000),
  toUInt32(1 + number % 8),
  toUInt32(number % 5),
  toUInt32(if(agent IN ('SOC-TriageAgent', 'DataCleanupAgent'), 2, 0))
FROM (
  SELECT
    number,
    toInt32(number % 8) + 1 AS slot,
    arrayElement(['InvoiceReviewAgent', 'CodeReviewAgent', 'ContractSummarizerAgent', 'SupportBot',
                  'RefundApprovalAgent', 'DataCleanupAgent', 'SOC-TriageAgent', 'SalesResearchAgent'], slot) AS agent,
    -- Modest per-run cost for everyone except the runaway DataCleanupAgent. (This is
    -- the run's direct AI cost; the LARI token cost comes from spend_hourly_by_key.)
    if(agent = 'DataCleanupAgent',
       round(22.0 + (number % 20) * 1.5, 2),
       round(arrayElement([0.5, 0.9, 0.7, 0.2, 0.4, 0.0, 0.3, 0.1], slot) + (number % 5) * 0.02, 4)) AS run_cost
  FROM numbers(40)
);

-- ── 40 business outcomes, one per run (slot = number % 8 → same agent as its run).
--    value_usd, attribution_confidence, and outcome_type per slot are tuned so the
--    LARI recommendation lands where the narrative above says it should. ─────────
INSERT INTO agentledger.outcomes
(outcome_id, tenant_id, ts, source_system, outcome_type, team_id, user_id, run_id,
 business_value_usd, quality_score, attribution_confidence, completion_status)
SELECT
  concat('out_', toString(number)),
  {tenant:String},
  now() - toIntervalHour(number * 6),
  arrayElement(['erp', 'github', 'contracts', 'zendesk', 'erp', 'data', 'soc', 'crm'], slot),
  arrayElement(['invoice_processed', 'pr_merged', 'contract_summarized', 'ticket_resolved',
                'refund_approved', 'records_cleaned', 'alert_triaged', 'lead_qualified'], slot),
  arrayElement(['Finance', 'Engineering', 'Finance', 'Customer Support',
                'Finance', 'Security', 'Security', 'Customer Support'], slot),
  concat('demo-user-', toString(number % 9)),
  concat('run_', toString(number)),
  -- Gross business value per outcome (before attribution + incrementality discounting).
  arrayElement([1500.0, 380.0, 200.0, 110.0, 160.0, 0.10, 0.50, 280.0], slot),
  0.85,
  -- ≥0.99 reads as a deterministic (agent-stamped) link → high confidence; below
  -- that is probabilistic. SupportBot is deliberately weak (→ improve_evidence).
  arrayElement([1.0, 1.0, 1.0, 0.6, 0.9, 0.5, 0.8, 0.9], slot),
  'completed'
FROM (
  SELECT number, toInt32(number % 8) + 1 AS slot
  FROM numbers(40)
);

-- ── Fully-loaded cost rates per (source_system, outcome_type). Human review (QA),
--    eval/monitoring, and amortized integration are what turn a token-cheap agent
--    into a real cost — and what make MAINTAIN / OPTIMIZE / INVESTIGATE reachable.
--    Agents without a row (DataCleanup/SOC/Sales) are loaded on token cost alone. ─
INSERT INTO agentledger.roi_rates
(tenant_id, source_system, outcome_type, hourly_rate, baseline_minutes, rework_pct,
 redeployment_factor, qa_cost_per_outcome, eval_cost_per_outcome,
 integration_cost_per_outcome, platform_overhead_pct, updated_at) VALUES
  ({tenant:String}, 'erp',       'invoice_processed',    0, 0, 0, 1,   8,  1,  2, 0.10, now()),
  ({tenant:String}, 'github',    'pr_merged',            0, 0, 0, 1, 120, 15, 25, 0.15, now()),
  ({tenant:String}, 'contracts', 'contract_summarized',  0, 0, 0, 1,  90, 10, 20, 0.15, now()),
  ({tenant:String}, 'zendesk',   'ticket_resolved',      0, 0, 0, 1,  12,  2,  3, 0.10, now()),
  ({tenant:String}, 'erp',       'refund_approved',      0, 0, 0, 1,  60,  8, 15, 0.20, now());

-- ── 150 tool calls (SOC/Data heavier; feeds the governance views). ────────────
INSERT INTO agentledger.agent_tool_calls
(tenant_id, agent_id, run_id, tool_call_id, tool_name, mcp_server, ts)
SELECT
  {tenant:String},
  arrayElement(['SupportBot', 'InvoiceReviewAgent', 'SOC-TriageAgent', 'SalesResearchAgent', 'CodeReviewAgent', 'DataCleanupAgent', 'RefundApprovalAgent', 'ContractSummarizerAgent'], toInt32(number % 8) + 1),
  concat('run_', toString(number % 40)),
  concat('demo_tool_', toString(number)),
  arrayElement(['search_kb', 'read_invoice', 'run_query', 'web_search', 'fetch_pr', 'delete_records', 'issue_refund', 'read_contract'], toInt32(number % 8) + 1),
  '',
  now() - toIntervalHour(number * 4)
FROM numbers(150);

-- ── 12 risk events. SOC-Triage + Sales-Research carry CRITICAL events (those gate
--    their LARI recommendation to pause / require_approval); DataCleanup is medium
--    (so it RETIRES on economics, not pauses on risk). ──────────────────────────
INSERT INTO agentledger.risk_events
(event_id, tenant_id, agent_id, run_id, category, severity, detail, occurrences, first_seen, detected_at)
SELECT
  concat('evt_', toString(number)),
  {tenant:String},
  multiIf(number < 5, 'SOC-TriageAgent', number < 8, 'SalesResearchAgent', 'DataCleanupAgent'),
  concat('run_', toString(number % 40)),
  arrayElement(['unauthorized_tool', 'tool_spike', 'injection_suspected'], toInt32(number % 3) + 1),
  multiIf(number < 8, 'critical', 'medium'),
  concat('tool: ', arrayElement(['delete_records', 'export_csv', 'run_query', 'issue_refund'], toInt32(number % 4) + 1)),
  toUInt32(1 + number % 5),
  now() - toIntervalHour(number * 8),
  now() - toIntervalHour(number * 8) + toIntervalMinute(5)
FROM numbers(12);

-- ── Agent risk exposure (drives risk-adjusted ROI + CISO view). ───────────────
INSERT INTO agentledger.agent_risk (tenant_id, agent_id, risk_exposure_pct, updated_at) VALUES
  ({tenant:String}, 'SOC-TriageAgent', 0.45, now()),
  ({tenant:String}, 'DataCleanupAgent', 0.28, now());
