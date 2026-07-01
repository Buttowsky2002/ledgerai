-- Bootstrap outcome graph — control plane (Postgres).
-- Adds three named agents for the tenant. Idempotent (skips existing names).
-- Does NOT touch connectors, identities, or billing data.

INSERT INTO agents (tenant_id, name, runtime_type, approval_status, risk_posture)
SELECT :'tenant'::uuid, v.name, v.runtime_type, 'approved', v.risk_posture
FROM (VALUES
  ('CodeReviewAgent',     'claude_code', 'medium'),
  ('InvoiceReviewAgent',  'sdk',         'low'),
  ('SupportBot',          'sdk',         'low')
) AS v(name, runtime_type, risk_posture)
WHERE NOT EXISTS (
  SELECT 1 FROM agents a
  WHERE a.tenant_id = :'tenant'::uuid AND a.name = v.name
);
