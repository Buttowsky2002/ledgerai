#!/usr/bin/env bash
# Applies pending Postgres and/or ClickHouse migrations to AWS-managed instances.
# Reads connection details from AWS Secrets Manager (no long-lived credentials).
#
# Usage:
#   ./migrate.sh --env pilot --target postgres
#   ./migrate.sh --env pilot --target clickhouse
#   ./migrate.sh --env pilot --target both
#
# Prerequisites: aws CLI configured, psql, clickhouse-client

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PG_MIGRATIONS="$REPO_ROOT/deploy/postgres"
CH_MIGRATIONS="$REPO_ROOT/deploy/clickhouse"

ENV=""
TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)    ENV="$2"; shift 2;;
    --target) TARGET="$2"; shift 2;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

if [[ -z "$ENV" || -z "$TARGET" ]]; then
  echo "Usage: $0 --env pilot|prod --target postgres|clickhouse|both"
  exit 1
fi

if [[ "$TARGET" != "postgres" && "$TARGET" != "clickhouse" && "$TARGET" != "both" ]]; then
  echo "Error: --target must be postgres, clickhouse, or both"
  exit 1
fi

SECRET_PREFIX="badgeriq/${ENV}"
APPLIED=0
SKIPPED=0

# ── Postgres migrations ──────────────────────────────────────────────────────

run_pg_migrations() {
  echo "==> Reading Postgres DSN from Secrets Manager (${SECRET_PREFIX}/postgres)..."
  local secret_json
  secret_json=$(aws secretsmanager get-secret-value \
    --secret-id "${SECRET_PREFIX}/postgres" \
    --query SecretString --output text)

  local dsn
  dsn=$(echo "$secret_json" | jq -r '.dsn')

  echo "==> Verifying Postgres connectivity..."
  psql "$dsn" -c "SELECT 1" >/dev/null

  echo "==> Ensuring schema_migrations table exists..."
  psql "$dsn" -v ON_ERROR_STOP=1 -c \
    "CREATE TABLE IF NOT EXISTS schema_migrations (
       version    TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     );"

  echo "==> Applying Postgres migrations..."
  for f in $(ls "$PG_MIGRATIONS"/*.sql 2>/dev/null | sort); do
    local ver
    ver=$(basename "$f" .sql)

    local already
    already=$(psql "$dsn" -tAc \
      "SELECT 1 FROM schema_migrations WHERE version = '$ver'" 2>/dev/null || echo "")

    if [[ "$already" == "1" ]]; then
      echo "  skip $ver"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    echo "  apply $ver"
    psql "$dsn" -v ON_ERROR_STOP=1 -f "$f"
    psql "$dsn" -v ON_ERROR_STOP=1 -c \
      "INSERT INTO schema_migrations (version) VALUES ('$ver')"
    APPLIED=$((APPLIED + 1))
    echo "  ok $ver"
  done

  echo "==> Postgres: $APPLIED applied, $SKIPPED skipped."
}

# ── ClickHouse migrations ────────────────────────────────────────────────────

run_ch_migrations() {
  local ch_applied=0
  local ch_skipped=0

  echo "==> Reading ClickHouse credentials from Secrets Manager (${SECRET_PREFIX}/clickhouse)..."
  local secret_json
  secret_json=$(aws secretsmanager get-secret-value \
    --secret-id "${SECRET_PREFIX}/clickhouse" \
    --query SecretString --output text)

  local ch_url ch_user ch_password ch_database
  ch_url=$(echo "$secret_json" | jq -r '.url')
  ch_user=$(echo "$secret_json" | jq -r '.user')
  ch_password=$(echo "$secret_json" | jq -r '.password')
  ch_database=$(echo "$secret_json" | jq -r '.database // "agentledger"')

  # Extract host and port from URL (https://host:port)
  local ch_host ch_port
  ch_host=$(echo "$ch_url" | sed -E 's|https?://||; s|:.*||')
  ch_port=$(echo "$ch_url" | sed -E 's|.*:([0-9]+).*|\1|')

  ch_cmd() {
    clickhouse-client \
      --host "$ch_host" \
      --port "$ch_port" \
      --secure \
      --user "$ch_user" \
      --password "$ch_password" \
      "$@"
  }

  echo "==> Verifying ClickHouse connectivity..."
  ch_cmd --query "SELECT 1" >/dev/null

  echo "==> Ensuring schema_migrations table exists..."
  ch_cmd --multiquery <<'SQL'
CREATE DATABASE IF NOT EXISTS agentledger;
CREATE TABLE IF NOT EXISTS agentledger.schema_migrations
(
    version    String,
    applied_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(applied_at)
ORDER BY version;
SQL

  echo "==> Applying ClickHouse migrations..."
  for f in $(ls "$CH_MIGRATIONS"/*.sql 2>/dev/null | sort); do
    local ver
    ver=$(basename "$f" .sql)

    # Skip the local docker migration runners (not SQL migrations)
    case "$ver" in
      migrate|migrate.ps1) continue;;
    esac

    local count
    count=$(ch_cmd --query \
      "SELECT count() FROM agentledger.schema_migrations FINAL WHERE version = '$ver'" 2>/dev/null || echo "0")

    if [[ "$count" == "1" ]]; then
      echo "  skip $ver"
      ch_skipped=$((ch_skipped + 1))
      continue
    fi

    echo "  apply $ver"
    ch_cmd --multiquery < "$f"
    ch_cmd --query \
      "INSERT INTO agentledger.schema_migrations (version) VALUES ('$ver')"
    ch_applied=$((ch_applied + 1))
    echo "  ok $ver"
  done

  echo "==> ClickHouse: $ch_applied applied, $ch_skipped skipped."
  APPLIED=$((APPLIED + ch_applied))
  SKIPPED=$((SKIPPED + ch_skipped))
}

# ── Main ──────────────────────────────────────────────────────────────────────

echo "BadgerIQ migration runner — env=$ENV target=$TARGET"
echo ""

if [[ "$TARGET" == "postgres" || "$TARGET" == "both" ]]; then
  run_pg_migrations
  echo ""
fi

if [[ "$TARGET" == "clickhouse" || "$TARGET" == "both" ]]; then
  run_ch_migrations
  echo ""
fi

echo "==> Done. Total: $APPLIED applied, $SKIPPED skipped."
