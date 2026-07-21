-- Purge Acme/demo ClickHouse analytics artifacts for the well-known demo tenant.
-- Keeps real connector/portal spend (real emails / non-demo agent_ids).
--
-- Usage (local compose):
--   docker compose exec -T clickhouse clickhouse-client --multiquery \
--     --param_tenant=00000000-0000-4000-8000-000000000001 \
--     < deploy/ops/purge_acme_demo_clickhouse.sql
--
-- Usage (AWS pilot — via migrate.sh secrets / clickhouse-client --secure):
--   clickhouse-client --host … --secure --user … --password … --multiquery \
--     --param_tenant=00000000-0000-4000-8000-000000000001 \
--     < deploy/ops/purge_acme_demo_clickhouse.sql
--
-- Default tenant matches LEDGERAI_DEV_TENANT_ID / migration 015 Acme Demo Co.

-- Event-level + run/outcome rows keyed by demo-user-* or demo agent names.
ALTER TABLE agentledger.llm_calls DELETE
WHERE tenant_id = {tenant:String}
  AND (
    startsWith(user_id, 'demo-user-')
    OR agent_id IN (
      'SupportBot', 'InvoiceReviewAgent', 'SOC-TriageAgent', 'SalesResearchAgent',
      'CodeReviewAgent', 'DataCleanupAgent', 'RefundApprovalAgent', 'ContractSummarizerAgent'
    )
    OR startsWith(virtual_key_id, 'vk_demo_')
    OR startsWith(call_id, 'demo_call_')
  )
SETTINGS mutations_sync = 2;

ALTER TABLE agentledger.spend_hourly_by_key DELETE
WHERE tenant_id = {tenant:String}
  AND (
    agent_id IN (
      'SupportBot', 'InvoiceReviewAgent', 'SOC-TriageAgent', 'SalesResearchAgent',
      'CodeReviewAgent', 'DataCleanupAgent', 'RefundApprovalAgent', 'ContractSummarizerAgent'
    )
    OR startsWith(virtual_key_id, 'vk_demo_')
  )
SETTINGS mutations_sync = 2;

ALTER TABLE agentledger.risk_daily DELETE
WHERE tenant_id = {tenant:String}
  AND startsWith(user_id, 'demo-user-')
SETTINGS mutations_sync = 2;

ALTER TABLE agentledger.agent_runs DELETE
WHERE tenant_id = {tenant:String}
  AND (
    startsWith(user_id, 'demo-user-')
    OR agent_id IN (
      'SupportBot', 'InvoiceReviewAgent', 'SOC-TriageAgent', 'SalesResearchAgent',
      'CodeReviewAgent', 'DataCleanupAgent', 'RefundApprovalAgent', 'ContractSummarizerAgent'
    )
  )
SETTINGS mutations_sync = 2;

ALTER TABLE agentledger.outcomes DELETE
WHERE tenant_id = {tenant:String}
  AND startsWith(user_id, 'demo-user-')
SETTINGS mutations_sync = 2;

ALTER TABLE agentledger.agent_tool_calls DELETE
WHERE tenant_id = {tenant:String}
  AND agent_id IN (
    'SupportBot', 'InvoiceReviewAgent', 'SOC-TriageAgent', 'SalesResearchAgent',
    'CodeReviewAgent', 'DataCleanupAgent', 'RefundApprovalAgent', 'ContractSummarizerAgent'
  )
SETTINGS mutations_sync = 2;

ALTER TABLE agentledger.risk_events DELETE
WHERE tenant_id = {tenant:String}
  AND agent_id IN (
    'SupportBot', 'InvoiceReviewAgent', 'SOC-TriageAgent', 'SalesResearchAgent',
    'CodeReviewAgent', 'DataCleanupAgent', 'RefundApprovalAgent', 'ContractSummarizerAgent'
  )
SETTINGS mutations_sync = 2;

ALTER TABLE agentledger.agent_risk DELETE
WHERE tenant_id = {tenant:String}
  AND agent_id IN (
    'SupportBot', 'InvoiceReviewAgent', 'SOC-TriageAgent', 'SalesResearchAgent',
    'CodeReviewAgent', 'DataCleanupAgent', 'RefundApprovalAgent', 'ContractSummarizerAgent'
  )
SETTINGS mutations_sync = 2;

-- Demo seed rates (tenant-scoped templates from clickhouse_seed.sql).
ALTER TABLE agentledger.roi_rates DELETE
WHERE tenant_id = {tenant:String}
SETTINGS mutations_sync = 2;

-- MV aggregates from demo llm_calls (no agent_id — match demo app_id labels).
ALTER TABLE agentledger.spend_daily DELETE
WHERE tenant_id = {tenant:String}
  AND app_id IN (
    'support-suite', 'finance-suite', 'security-suite', 'sales-suite',
    'dev-suite', 'data-suite', 'legal-suite'
  )
SETTINGS mutations_sync = 2;

-- User rollups for synthetic demo-user-* handles (if present).
ALTER TABLE agentledger.spend_daily_by_user DELETE
WHERE tenant_id = {tenant:String}
  AND startsWith(user_id, 'demo-user-')
SETTINGS mutations_sync = 2;

ALTER TABLE agentledger.coding_agent_daily DELETE
WHERE tenant_id = {tenant:String}
  AND (
    startsWith(user_id, 'demo-user-')
    OR agent_id IN (
      'SupportBot', 'InvoiceReviewAgent', 'SOC-TriageAgent', 'SalesResearchAgent',
      'CodeReviewAgent', 'DataCleanupAgent', 'RefundApprovalAgent', 'ContractSummarizerAgent'
    )
  )
SETTINGS mutations_sync = 2;
