#!/usr/bin/env bash
# Run Acme/demo ClickHouse purge against local compose or AWS.
#
# Local:
#   bash deploy/ops/purge-acme-demo-clickhouse.sh
#
# AWS pilot (requires aws CLI + clickhouse-client; same secrets as migrate.sh):
#   bash deploy/ops/purge-acme-demo-clickhouse.sh --env pilot
#
# Prefer this wrapper over piping the .sql file alone — it skips tables that
# are not present yet (partial CH migration history).
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

DEMO_AGENTS="('SupportBot','InvoiceReviewAgent','SOC-TriageAgent','SalesResearchAgent','CodeReviewAgent','DataCleanupAgent','RefundApprovalAgent','ContractSummarizerAgent')"
DEMO_APPS="('support-suite','finance-suite','security-suite','sales-suite','dev-suite','data-suite','legal-suite')"

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
  ch() {
    clickhouse-client \
      --host "$ch_host" --port "$ch_port" --secure \
      --user "$ch_user" --password "$ch_password" "$@"
  }
  echo "==> Purging Acme/demo ClickHouse rows (env=$ENV tenant=$TENANT) ..."
else
  ch() { docker compose exec -T clickhouse clickhouse-client "$@"; }
  echo "==> Purging Acme/demo ClickHouse rows (local compose tenant=$TENANT) ..."
fi

table_exists() {
  local t="$1"
  local n
  n=$(ch --query "SELECT count() FROM system.tables WHERE database = 'agentledger' AND name = '${t}'" 2>/dev/null || echo 0)
  [[ "$n" == "1" ]]
}

run_delete() {
  local table="$1"
  local where="$2"
  if ! table_exists "$table"; then
    echo "  skip $table (missing)"
    return 0
  fi
  echo "  purge $table"
  ch --query \
    "ALTER TABLE agentledger.${table} DELETE WHERE tenant_id = '${TENANT}' AND (${where}) SETTINGS mutations_sync = 2"
}

run_delete llm_calls \
  "startsWith(user_id, 'demo-user-') OR agent_id IN ${DEMO_AGENTS} OR startsWith(virtual_key_id, 'vk_demo_') OR startsWith(call_id, 'demo_call_')"
run_delete spend_hourly_by_key \
  "agent_id IN ${DEMO_AGENTS} OR startsWith(virtual_key_id, 'vk_demo_')"
run_delete risk_daily "startsWith(user_id, 'demo-user-')"
run_delete agent_runs \
  "startsWith(user_id, 'demo-user-') OR agent_id IN ${DEMO_AGENTS}"
run_delete outcomes "startsWith(user_id, 'demo-user-')"
run_delete agent_tool_calls "agent_id IN ${DEMO_AGENTS}"
run_delete risk_events "agent_id IN ${DEMO_AGENTS}"
run_delete agent_risk "agent_id IN ${DEMO_AGENTS}"
run_delete roi_rates "1"
run_delete spend_daily "app_id IN ${DEMO_APPS}"
run_delete spend_daily_by_user "startsWith(user_id, 'demo-user-')"
run_delete coding_agent_daily \
  "startsWith(user_id, 'demo-user-') OR agent_id IN ${DEMO_AGENTS}"

echo "==> Done."
echo "Verify: SELECT count() FROM agentledger.llm_calls WHERE startsWith(user_id, 'demo-user-')"
echo "(Canonical SQL mirror: $DIR/purge_acme_demo_clickhouse.sql)"
