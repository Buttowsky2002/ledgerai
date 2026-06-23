#!/usr/bin/env bash
# Seed (or reset) the LedgerAI demo tenant — no provider keys required.
#
#   Seed:  bash deploy/demo/seed-demo.sh
#   Reset: LEDGERAI_DEMO_RESET=1 bash deploy/demo/seed-demo.sh   (clear, no reseed)
#
# Seeds ClickHouse analytics (always) and the Postgres control plane (tenant /
# teams / agents / budgets) when Postgres is running. The stack must be up:
# `make demo` brings it up first.
set -euo pipefail

# A valid UUID — the API validates the dev x-tenant-id header as a UUID.
TENANT="${LEDGERAI_DEMO_TENANT:-00000000-0000-4000-8000-000000000001}"
RESET="${LEDGERAI_DEMO_RESET:-0}"
DIR="$(cd "$(dirname "$0")" && pwd)"

ch() { docker compose exec -T clickhouse clickhouse-client "$@"; }
pg() { docker compose exec -T postgres psql -U agentledger -d agentledger -v ON_ERROR_STOP=1 "$@"; }
pg_up() { [ -n "$(docker compose ps -q postgres 2>/dev/null)" ]; }

CH_TABLES="llm_calls spend_daily spend_hourly_by_key risk_daily agent_runs outcomes agent_tool_calls risk_events agent_risk"

echo "Waiting for ClickHouse ..."
for _ in $(seq 1 60); do
  if docker compose exec -T clickhouse wget -qO- http://localhost:8123/ping >/dev/null 2>&1; then break; fi
  sleep 1
done

if [ "$RESET" = "1" ]; then
  echo "Resetting demo tenant ${TENANT} (clearing data, no reseed) ..."
  for t in $CH_TABLES; do
    ch --param_tenant="$TENANT" --query \
      "ALTER TABLE agentledger.$t DELETE WHERE tenant_id = {tenant:String} SETTINGS mutations_sync = 2"
  done
  if pg_up; then
    pg -v tenant="$TENANT" -c \
      "DELETE FROM budgets WHERE tenant_id = :'tenant'; DELETE FROM agents WHERE tenant_id = :'tenant'; DELETE FROM teams WHERE tenant_id = :'tenant';"
  fi
  echo "Demo data cleared for tenant ${TENANT}."
  exit 0
fi

echo "Seeding ClickHouse analytics for tenant ${TENANT} ..."
ch --multiquery --param_tenant="$TENANT" < "$DIR/clickhouse_seed.sql"

if pg_up; then
  echo "Seeding Postgres control plane (tenant/teams/agents/budgets) ..."
  pg -v tenant="$TENANT" -f - < "$DIR/postgres_seed.sql"
else
  echo "(Postgres not running — skipped control-plane seed; the analytics demo still works.)"
fi

echo ""
echo "Verifying demo story:"
ch --param_tenant="$TENANT" --query \
  "SELECT count() AS spend_daily_rows, round(sum(cost_usd), 2) AS total_usd
   FROM agentledger.spend_daily WHERE tenant_id = {tenant:String}"
echo "Top spend by agent (DataCleanupAgent should dominate — runaway cost):"
ch --param_tenant="$TENANT" --query \
  "SELECT agent_id, round(sum(cost_usd), 2) AS cost_usd FROM agentledger.spend_hourly_by_key
   WHERE tenant_id = {tenant:String} GROUP BY agent_id ORDER BY cost_usd DESC LIMIT 3"
