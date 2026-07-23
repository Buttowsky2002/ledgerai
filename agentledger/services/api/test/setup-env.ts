/**
 * Default secrets required for Nest to construct security-critical providers
 * during unit and e2e tests. Specs that assert missing-key failures must
 * unset these in their own beforeEach.
 */
process.env.BADGERIQ_CONNECTOR_SECRET_KEY =
  process.env.BADGERIQ_CONNECTOR_SECRET_KEY ??
  'test-only-connector-secret-key-32chars!!';

process.env.AGENTLEDGER_JWT_SECRET =
  process.env.AGENTLEDGER_JWT_SECRET ?? 'test-secret';
