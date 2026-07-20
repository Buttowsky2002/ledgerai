#!/bin/sh
# Applies pending ClickHouse migrations on existing docker volumes.
# Fresh volumes run deploy/clickhouse/*.sql via docker-entrypoint-initdb.d;
# this script is for upgrades only.
#
# IMPORTANT: keep this OUT of deploy/clickhouse/ — that directory is mounted
# as initdb.d. If migrate.sh lives there, first-boot hangs forever waiting on
# host `clickhouse` while the init server only listens on 127.0.0.1, and host
# inserts fail with SocketError: other side closed.
#
# Usage (from agentledger/, with compose clickhouse up):
#   docker compose exec -T clickhouse sh < deploy/clickhouse-migrate/migrate.sh
#   # or mount SQL at /migrations and run inside a client container
set -e

CH_HOST="${CH_HOST:-127.0.0.1}"
CH="clickhouse-client --host ${CH_HOST}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"

# Cap wait so a misconfigured host cannot hang CI forever.
i=0
until $CH --query 'SELECT 1' >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "clickhouse at ${CH_HOST} not ready after 60s" >&2
    exit 1
  fi
  echo "waiting for clickhouse at ${CH_HOST}..."
  sleep 1
done

if ! ls "${MIGRATIONS_DIR}"/*.sql >/dev/null 2>&1; then
  echo "no *.sql under ${MIGRATIONS_DIR} — nothing to apply (fresh init uses deploy/clickhouse/*.sql)"
  exit 0
fi

$CH --multiquery <<'SQL'
CREATE TABLE IF NOT EXISTS agentledger.schema_migrations
(
    version String,
    applied_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(applied_at)
ORDER BY version;
SQL

migration_applied() {
  $CH --query "SELECT count() FROM agentledger.schema_migrations FINAL WHERE version = '$1'" 2>/dev/null || echo 0
}

mark_applied() {
  $CH --query "INSERT INTO agentledger.schema_migrations (version) VALUES ('$1')"
}

# Bootstrap: DBs created before schema_migrations existed — mark 001–017 when objects exist.
if [ "$(migration_applied 001_events)" != "1" ]; then
  if [ "$($CH --query "EXISTS TABLE agentledger.llm_calls" 2>/dev/null || echo 0)" = "1" ]; then
    for f in $(ls "${MIGRATIONS_DIR}"/*.sql 2>/dev/null | sort); do
      ver=$(basename "$f" .sql)
      num=$(echo "$ver" | cut -d_ -f1)
      if [ "$num" -le 17 ] && [ "$(migration_applied "$ver")" != "1" ]; then
        echo "bootstrap mark ${ver}"
        mark_applied "$ver"
      fi
    done
  fi
fi

# Bootstrap 018 when view already exists (manual apply).
if [ "$(migration_applied 018_cost_basis)" != "1" ]; then
  if [ "$($CH --query "EXISTS VIEW agentledger.v_cost_basis_daily" 2>/dev/null || echo 0)" = "1" ]; then
    echo "bootstrap mark 018_cost_basis"
    mark_applied 018_cost_basis
  fi
fi

for f in $(ls "${MIGRATIONS_DIR}"/*.sql 2>/dev/null | sort); do
  ver=$(basename "$f" .sql)
  if [ "$(migration_applied "$ver")" = "1" ]; then
    echo "skip ${ver}"
    continue
  fi
  echo "apply ${ver}"
  $CH --multiquery < "$f"
  mark_applied "$ver"
  echo "ok ${ver}"
done

echo "ClickHouse migrations complete."
