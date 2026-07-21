#!/usr/bin/env bash
# Run deploy/ops/purge_acme_demo_clickhouse.sql against local compose or AWS.
#
# Local:
#   bash deploy/ops/purge-acme-demo-clickhouse.sh
#
# AWS pilot (requires aws CLI + clickhouse-client; same secrets as migrate.sh):
#   bash deploy/ops/purge-acme-demo-clickhouse.sh --env pilot
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
TENANT="${BADGERIQ_DEMO_TENANT:-${LEDGERAI_DEMO_TENANT:-00000000-0000-4000-8000-000000000001}}"
ENV=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV="$2"; shift 2;;
    --tenant) TENANT="$2"; shift 2;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

SQL_FILE="$DIR/purge_acme_demo_clickhouse.sql"

if [[ -n "$ENV" ]]; then
  SECRET_PREFIX="badgeriq/${ENV}"
  secret_json=$(aws secretsmanager get-secret-value \
    --secret-id "${SECRET_PREFIX}/clickhouse" \
    --query SecretString --output text)
  ch_url=$(echo "$secret_json" | jq -r '.url')
  ch_user=$(echo "$secret_json" | jq -r '.user')
  ch_password=$(echo "$secret_json" | jq -r '.password')
  ch_host=$(echo "$ch_url" | sed -E 's|https?://||; s|:.*||')
  ch_port=$(echo "$ch_url" | sed -E 's|.*:([0-9]+).*|\1|')
  echo "==> Purging Acme/demo ClickHouse rows (env=$ENV tenant=$TENANT) ..."
  clickhouse-client \
    --host "$ch_host" \
    --port "$ch_port" \
    --secure \
    --user "$ch_user" \
    --password "$ch_password" \
    --multiquery \
    --param_tenant="$TENANT" \
    < "$SQL_FILE"
else
  echo "==> Purging Acme/demo ClickHouse rows (local compose tenant=$TENANT) ..."
  docker compose exec -T clickhouse clickhouse-client --multiquery \
    --param_tenant="$TENANT" \
    < "$SQL_FILE"
fi

echo "==> Done. Verify: SELECT count() FROM agentledger.llm_calls WHERE startsWith(user_id, 'demo-user-')"
