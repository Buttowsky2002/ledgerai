-- Bootstrap outcome graph — analytics plane (ClickHouse).
-- SDK-stamped runs + matching outcomes so attribution V2 (cutover) can stamp
-- run_id/confidence and v_roi / agent economics populate. Does NOT touch llm_calls
-- or connector spend. Dates sit inside the default CFO window (Apr–Jun 2026).

ALTER TABLE agentledger.agent_runs DELETE
  WHERE tenant_id = {tenant:String}
    AND run_id LIKE 'bootstrap_%'
  SETTINGS mutations_sync = 2;

ALTER TABLE agentledger.outcomes DELETE
  WHERE tenant_id = {tenant:String}
    AND outcome_id LIKE 'bootstrap:%'
  SETTINGS mutations_sync = 2;

ALTER TABLE agentledger.outcome_evidence DELETE
  WHERE tenant_id = {tenant:String}
    AND outcome_id LIKE 'bootstrap:%'
  SETTINGS mutations_sync = 2;

INSERT INTO agentledger.agent_runs
(run_id, tenant_id, agent_id, app_id, user_id, started_at, ended_at, status,
 objective, outcome_id, total_cost_usd, total_tokens, llm_calls, tool_calls, risk_events)
VALUES
  ('bootstrap_run_1', {tenant:String}, 'CodeReviewAgent', 'studio-app', 'brandon.balams@studiodesigner.com',
   '2026-06-08 14:00:00', '2026-06-08 14:12:00', 'completed', 'Review PR #101',
   'bootstrap:github:studio/pr-101', 18.5, 4200, 6, 1, 0),
  ('bootstrap_run_2', {tenant:String}, 'InvoiceReviewAgent', 'finance-app', 'david.jeong@studiodesigner.com',
   '2026-06-12 09:30:00', '2026-06-12 09:38:00', 'completed', 'Process vendor invoice',
   'bootstrap:erp:inv-202', 7.2, 1800, 3, 0, 0),
  ('bootstrap_run_3', {tenant:String}, 'SupportBot', 'support-app', 'tim.bedow@studiodesigner.com',
   '2026-06-18 16:00:00', '2026-06-18 16:08:00', 'completed', 'Resolve support ticket',
   'bootstrap:zendesk:ticket-303', 5.4, 1500, 4, 2, 0);

INSERT INTO agentledger.outcomes
(outcome_id, tenant_id, ts, source_system, outcome_type, team_id, user_id, run_id,
 business_value_usd, quality_score, attribution_confidence, completion_status)
VALUES
  ('bootstrap:github:studio/pr-101', {tenant:String}, '2026-06-08 14:15:00', 'github', 'pr_merged',
   'Engineering', 'brandon.balams@studiodesigner.com', '', 420, 0.9, 0, 'merged'),
  ('bootstrap:erp:inv-202', {tenant:String}, '2026-06-12 09:40:00', 'erp', 'invoice_processed',
   'Finance', 'david.jeong@studiodesigner.com', '', 850, 0.95, 0, 'completed'),
  ('bootstrap:zendesk:ticket-303', {tenant:String}, '2026-06-18 16:10:00', 'zendesk', 'ticket_resolved',
   'Customer Support', 'tim.bedow@studiodesigner.com', '', 95, 0.8, 0, 'resolved');

INSERT INTO agentledger.roi_rates
(tenant_id, source_system, outcome_type, hourly_rate, baseline_minutes, rework_pct,
 redeployment_factor, qa_cost_per_outcome, eval_cost_per_outcome,
 integration_cost_per_outcome, platform_overhead_pct, updated_at)
VALUES
  ({tenant:String}, 'github',  'pr_merged',         0, 0, 0, 1, 45.0, 8.0, 12.0, 0.12, now()),
  ({tenant:String}, 'erp',     'invoice_processed', 0, 0, 0, 1,  6.0, 1.0,  2.0, 0.10, now()),
  ({tenant:String}, 'zendesk', 'ticket_resolved',   0, 0, 0, 1,  3.0, 0.5,  1.0, 0.08, now());
