-- BadgerIQ demo seed — control plane (Postgres).
--
-- Seeds the demo tenant, 4 teams, 9 human identities (with Cursor/demo aliases),
-- the 8 named demo agents, and 5 budgets (one of which — DataCleanupAgent — is
-- deliberately tiny so its runaway spend is "over budget", the budget-alert
-- story). Run as the bootstrap `agentledger` superuser (compose), which bypasses
-- RLS. Idempotent: children are cleared then reinserted.
--
-- Pass the tenant id with `psql -v tenant=<uuid>` (a valid UUID; matches the
-- ClickHouse seed and the dashboard's dev x-tenant-id).

INSERT INTO tenants (tenant_id, name, plan)
VALUES (:'tenant', 'Acme Demo Co', 'enterprise')
ON CONFLICT (tenant_id) DO UPDATE SET name = EXCLUDED.name, plan = EXCLUDED.plan;

DELETE FROM budgets    WHERE tenant_id = :'tenant';
DELETE FROM agents     WHERE tenant_id = :'tenant';
DELETE FROM identities WHERE tenant_id = :'tenant';
DELETE FROM teams      WHERE tenant_id = :'tenant';

INSERT INTO teams (tenant_id, name, cost_center) VALUES
  (:'tenant', 'Customer Support', 'CS-100'),
  (:'tenant', 'Finance',          'FIN-200'),
  (:'tenant', 'Security',         'SEC-300'),
  (:'tenant', 'Engineering',      'ENG-400');

-- Human identities mapped to ClickHouse demo-user-0..8 handles (see clickhouse_seed.sql).
INSERT INTO identities (tenant_id, email, display_name, team_id, aliases) VALUES
  (
    :'tenant',
    'alice.chen@acme.test',
    'Alice Chen',
    (SELECT team_id FROM teams WHERE tenant_id = :'tenant' AND name = 'Engineering'),
    '["demo-user-0"]'::jsonb
  ),
  (
    :'tenant',
    'bob.patel@acme.test',
    'Bob Patel',
    (SELECT team_id FROM teams WHERE tenant_id = :'tenant' AND name = 'Engineering'),
    '["demo-user-1"]'::jsonb
  ),
  (
    :'tenant',
    'carla.nguyen@acme.test',
    'Carla Nguyen',
    (SELECT team_id FROM teams WHERE tenant_id = :'tenant' AND name = 'Engineering'),
    '["demo-user-2"]'::jsonb
  ),
  (
    :'tenant',
    'daniel.ross@acme.test',
    'Daniel Ross',
    (SELECT team_id FROM teams WHERE tenant_id = :'tenant' AND name = 'Finance'),
    '["demo-user-3"]'::jsonb
  ),
  (
    :'tenant',
    'elena.martinez@acme.test',
    'Elena Martinez',
    (SELECT team_id FROM teams WHERE tenant_id = :'tenant' AND name = 'Finance'),
    '["demo-user-4"]'::jsonb
  ),
  (
    :'tenant',
    'frank.okonkwo@acme.test',
    'Frank Okonkwo',
    (SELECT team_id FROM teams WHERE tenant_id = :'tenant' AND name = 'Security'),
    '["demo-user-5"]'::jsonb
  ),
  (
    :'tenant',
    'grace.kim@acme.test',
    'Grace Kim',
    (SELECT team_id FROM teams WHERE tenant_id = :'tenant' AND name = 'Security'),
    '["demo-user-6"]'::jsonb
  ),
  (
    :'tenant',
    'henry.walsh@acme.test',
    'Henry Walsh',
    (SELECT team_id FROM teams WHERE tenant_id = :'tenant' AND name = 'Customer Support'),
    '["demo-user-7"]'::jsonb
  ),
  (
    :'tenant',
    'iris.johansson@acme.test',
    'Iris Johansson',
    (SELECT team_id FROM teams WHERE tenant_id = :'tenant' AND name = 'Customer Support'),
    '["demo-user-8"]'::jsonb
  );

-- Cursor billing import handles (user_id in spend_daily_by_user is the provider email).
-- Keeps the executive report resolvable when the demo tenant has real Cursor imports.
INSERT INTO identities (tenant_id, email, display_name, team_id, aliases) VALUES
  (:'tenant', 'carl.miller@studiodesigner.com', 'Carl Miller', (SELECT team_id FROM teams WHERE tenant_id = :'tenant' AND name = 'Engineering'), '["carl.miller@studiodesigner.com"]'::jsonb),
  (:'tenant', 'josh.bosley@studiodesigner.com', 'Josh Bosley', (SELECT team_id FROM teams WHERE tenant_id = :'tenant' AND name = 'Engineering'), '["josh.bosley@studiodesigner.com"]'::jsonb),
  (:'tenant', 'duncan.blue@studiodesigner.com', 'Duncan Blue', (SELECT team_id FROM teams WHERE tenant_id = :'tenant' AND name = 'Engineering'), '["duncan.blue@studiodesigner.com"]'::jsonb),
  (:'tenant', 'owen.ditore@studiodesigner.com', 'Owen Ditore', (SELECT team_id FROM teams WHERE tenant_id = :'tenant' AND name = 'Security'), '["owen.ditore@studiodesigner.com"]'::jsonb),
  (:'tenant', 'russ.mcclelland@smartobjx.com', 'Russ McClelland', (SELECT team_id FROM teams WHERE tenant_id = :'tenant' AND name = 'Finance'), '["russ.mcclelland@smartobjx.com"]'::jsonb),
  (:'tenant', 'brandon.balams@studiodesigner.com', 'Brandon Balams', (SELECT team_id FROM teams WHERE tenant_id = :'tenant' AND name = 'Engineering'), '["brandon.balams@studiodesigner.com"]'::jsonb),
  (:'tenant', 'tim.bedow@studiodesigner.com', 'Tim Bedow', (SELECT team_id FROM teams WHERE tenant_id = :'tenant' AND name = 'Customer Support'), '["tim.bedow@studiodesigner.com"]'::jsonb),
  (:'tenant', 'john@studiodesigner.com', 'John', (SELECT team_id FROM teams WHERE tenant_id = :'tenant' AND name = 'Customer Support'), '["john@studiodesigner.com"]'::jsonb),
  (:'tenant', 'brandon@studiodesigner.com', 'Brandon', (SELECT team_id FROM teams WHERE tenant_id = :'tenant' AND name = 'Engineering'), '["brandon@studiodesigner.com"]'::jsonb),
  (:'tenant', 'christian.allard@studiodesigner.com', 'Christian Allard', (SELECT team_id FROM teams WHERE tenant_id = :'tenant' AND name = 'Security'), '["christian.allard@studiodesigner.com"]'::jsonb),
  (:'tenant', 'david.jeong@studiodesigner.com', 'David Jeong', (SELECT team_id FROM teams WHERE tenant_id = :'tenant' AND name = 'Finance'), '["david.jeong@studiodesigner.com"]'::jsonb);

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
