-- LedgerAI demo seed — control plane (Postgres).
--
-- Seeds the demo tenant, 4 teams, the 8 named demo agents, and 5 budgets (one of
-- which — DataCleanupAgent — is deliberately tiny so its runaway spend is "over
-- budget", the budget-alert story). Run as the bootstrap `agentledger` superuser
-- (compose), which bypasses RLS. Idempotent: children are cleared then reinserted.
--
-- Pass the tenant id with `psql -v tenant=<uuid>` (a valid UUID; matches the
-- ClickHouse seed and the dashboard's dev x-tenant-id).

INSERT INTO tenants (tenant_id, name, plan)
VALUES (:'tenant', 'Acme Demo Co', 'enterprise')
ON CONFLICT (tenant_id) DO UPDATE SET name = EXCLUDED.name, plan = EXCLUDED.plan;

DELETE FROM budgets WHERE tenant_id = :'tenant';
DELETE FROM agents  WHERE tenant_id = :'tenant';
DELETE FROM teams   WHERE tenant_id = :'tenant';

INSERT INTO teams (tenant_id, name, cost_center) VALUES
  (:'tenant', 'Customer Support', 'CS-100'),
  (:'tenant', 'Finance',          'FIN-200'),
  (:'tenant', 'Security',         'SEC-300'),
  (:'tenant', 'Engineering',      'ENG-400');

-- 8 demo agents. risk_posture/approval_status sketch the story.
INSERT INTO agents (tenant_id, name, runtime_type, approval_status, risk_posture) VALUES
  (:'tenant', 'SupportBot',              'sdk',         'approved', 'low'),
  (:'tenant', 'InvoiceReviewAgent',      'sdk',         'approved', 'low'),
  (:'tenant', 'SOC-TriageAgent',         'mcp',         'approved', 'high'),
  (:'tenant', 'SalesResearchAgent',      'sdk',         'approved', 'low'),
  (:'tenant', 'CodeReviewAgent',         'claude_code', 'approved', 'medium'),
  (:'tenant', 'DataCleanupAgent',        'custom',      'approved', 'high'),
  (:'tenant', 'RefundApprovalAgent',     'sdk',         'approved', 'medium'),
  (:'tenant', 'ContractSummarizerAgent', 'sdk',         'approved', 'low');

-- 5 budgets (showback). DataCleanupAgent's tiny cap is the "alert" — its runaway
-- spend blows past it.
INSERT INTO budgets (tenant_id, scope_type, scope_id, period, amount_usd, alert_pcts, hard_limit) VALUES
  (:'tenant', 'tenant', :'tenant',            'monthly', 1000.00, '{50,80,100}', false),
  (:'tenant', 'agent',  'DataCleanupAgent',   'monthly',   50.00, '{50,80,100}', false),
  (:'tenant', 'agent',  'SupportBot',         'monthly',  200.00, '{50,80,100}', false),
  (:'tenant', 'agent',  'InvoiceReviewAgent', 'monthly',  100.00, '{50,80,100}', false),
  (:'tenant', 'agent',  'SOC-TriageAgent',    'monthly',   75.00, '{50,80,100}', true);
