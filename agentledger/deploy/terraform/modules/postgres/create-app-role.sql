-- create-app-role.sql
-- Run ONCE after the RDS instance is provisioned.
--
-- The previous Terraform local-exec provisioner was removed because:
--   1. It used bash heredoc syntax that fails on Windows/PowerShell.
--   2. The RDS instance is in a private subnet, unreachable from the
--      machine running terraform apply without an SSM tunnel.
--
-- Usage (via SSM port-forward to the private RDS instance):
--
--   aws ssm start-session \
--     --target <bastion-instance-id> \
--     --document-name AWS-StartPortForwardingSessionToRemoteHost \
--     --parameters '{"host":["<rds-endpoint>"],"portNumber":["5432"],"localPortNumber":["15432"]}'
--
--   psql -h 127.0.0.1 -p 15432 -U badgeriq -d agentledger \
--     -v ON_ERROR_STOP=1 \
--     -v app_password='<password-from-secrets-manager>' \
--     -f create-app-role.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw WITH LOGIN NOINHERIT;
  END IF;
END $$;

ALTER ROLE app_rw WITH PASSWORD :'app_password';

GRANT CONNECT ON DATABASE agentledger TO app_rw;
GRANT USAGE ON SCHEMA public TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO app_rw;
