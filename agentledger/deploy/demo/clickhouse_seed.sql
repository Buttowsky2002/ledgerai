-- LedgerAI demo seed — analytics plane (ClickHouse).
--
-- Synthetic, content-free activity for one demo tenant across 8 named agents,
-- engineered to tell a coherent story on the dashboard WITHOUT any provider keys:
--   • InvoiceReviewAgent (Finance) — STRONG ROI: low cost, high-value outcomes.
--   • DataCleanupAgent (Security)  — RUNAWAY COST: dominates spend, no outcomes.
--   • SOC-TriageAgent (Security)   — HIGH RISK: blocked/redacted calls + risk events.
--
-- Inserting llm_calls auto-populates the spend_daily / spend_hourly_by_key /
-- risk_daily materialized views; agent_runs + outcomes drive unit economics and
-- v_roi; agent_tool_calls + risk_events + agent_risk drive the CISO risk view.
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

-- ── 50 agent runs. Runs 0–29 are ROI producers (low cost, linked to outcomes);
--    runs 30–49 are the cost/risk problem agents (high cost, no outcomes). ─────
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
  if(number < 30, concat('out_', toString(number)), ''),
  cost,
  toUInt64(1500 + number % 6000),
  toUInt32(1 + number % 8),
  toUInt32(number % 5),
  toUInt32(if(agent = 'SOC-TriageAgent', 2, 0))
FROM (
  SELECT
    number,
    if(number < 30,
       arrayElement(['InvoiceReviewAgent', 'SupportBot', 'CodeReviewAgent', 'RefundApprovalAgent', 'ContractSummarizerAgent'], toInt32(number % 5) + 1),
       arrayElement(['DataCleanupAgent', 'SOC-TriageAgent'], toInt32(number % 2) + 1)) AS agent,
    if(number < 30,
       round(arrayElement([0.45, 0.20, 0.90, 0.30, 0.65], toInt32(number % 5) + 1) + (number % 5) * 0.03, 4),
       if(agent = 'DataCleanupAgent', round(25.0 + (number % 20) * 1.8, 2), round(4.0 + (number % 10) * 0.5, 2))) AS cost
  FROM numbers(50)
);

-- ── 30 business outcomes, linked to the ROI runs (runs 0–29). ─────────────────
INSERT INTO agentledger.outcomes
(outcome_id, tenant_id, ts, source_system, outcome_type, team_id, user_id, run_id,
 business_value_usd, quality_score, attribution_confidence, completion_status)
SELECT
  concat('out_', toString(number)),
  {tenant:String},
  now() - toIntervalHour(number * 6),
  arrayElement(['erp', 'zendesk', 'github', 'zendesk', 'contracts'], idx),
  multiIf(agent = 'InvoiceReviewAgent', 'invoice_processed',
          agent = 'SupportBot', 'ticket_resolved',
          agent = 'CodeReviewAgent', 'pr_merged',
          agent = 'RefundApprovalAgent', 'refund_approved',
          'contract_summarized'),
  arrayElement(['Finance', 'Customer Support', 'Engineering', 'Customer Support', 'Finance'], idx),
  concat('demo-user-', toString(number % 9)),
  concat('run_', toString(number)),
  multiIf(agent = 'InvoiceReviewAgent', round(1500.0 + (number % 5) * 120, 2),
          agent = 'ContractSummarizerAgent', round(600.0 + (number % 4) * 40, 2),
          agent = 'CodeReviewAgent', round(250.0 + (number % 5) * 30, 2),
          agent = 'RefundApprovalAgent', round(120.0 + (number % 4) * 10, 2),
          round(80.0 + (number % 6) * 5, 2)),
  0.85,
  multiIf(agent = 'InvoiceReviewAgent', 0.95, agent = 'CodeReviewAgent', 0.88, agent = 'ContractSummarizerAgent', 0.82, 0.75),
  'completed'
FROM (
  SELECT
    number,
    toInt32(number % 5) + 1 AS idx,
    arrayElement(['InvoiceReviewAgent', 'SupportBot', 'CodeReviewAgent', 'RefundApprovalAgent', 'ContractSummarizerAgent'], idx) AS agent
  FROM numbers(30)
);

-- ── 150 tool calls (SOC/Data heavier; feeds the governance views). ────────────
INSERT INTO agentledger.agent_tool_calls
(tenant_id, agent_id, run_id, tool_call_id, tool_name, mcp_server, ts)
SELECT
  {tenant:String},
  arrayElement(['SupportBot', 'InvoiceReviewAgent', 'SOC-TriageAgent', 'SalesResearchAgent', 'CodeReviewAgent', 'DataCleanupAgent', 'RefundApprovalAgent', 'ContractSummarizerAgent'], toInt32(number % 8) + 1),
  concat('run_', toString(number % 50)),
  concat('demo_tool_', toString(number)),
  arrayElement(['search_kb', 'read_invoice', 'run_query', 'web_search', 'fetch_pr', 'delete_records', 'issue_refund', 'read_contract'], toInt32(number % 8) + 1),
  '',
  now() - toIntervalHour(number * 4)
FROM numbers(150);

-- ── 12 risk events (SOC high, DataCleanup medium). ────────────────────────────
INSERT INTO agentledger.risk_events
(event_id, tenant_id, agent_id, run_id, category, severity, detail, occurrences, first_seen, detected_at)
SELECT
  concat('evt_', toString(number)),
  {tenant:String},
  if(number < 8, 'SOC-TriageAgent', 'DataCleanupAgent'),
  concat('run_', toString(30 + number % 20)),
  arrayElement(['unauthorized_tool', 'tool_spike', 'injection_suspected'], toInt32(number % 3) + 1),
  if(number < 8, 'high', 'medium'),
  concat('tool: ', arrayElement(['delete_records', 'export_csv', 'run_query', 'issue_refund'], toInt32(number % 4) + 1)),
  toUInt32(1 + number % 5),
  now() - toIntervalHour(number * 8),
  now() - toIntervalHour(number * 8) + toIntervalMinute(5)
FROM numbers(12);

-- ── Agent risk exposure (drives risk-adjusted ROI + CISO view). ───────────────
INSERT INTO agentledger.agent_risk (tenant_id, agent_id, risk_exposure_pct, updated_at) VALUES
  ({tenant:String}, 'SOC-TriageAgent', 0.45, now()),
  ({tenant:String}, 'DataCleanupAgent', 0.28, now());
