#!/usr/bin/env bash
# BadgerIQ demo-mode launcher. No make required.
#
# Usage:
#   ./bin/demo.sh           — start stack + seed demo tenant
#   ./bin/demo.sh seed      — re-seed only (stack already up)
#   ./bin/demo.sh reset     — clear demo data (no reseed)
#
# Env:
#   LEDGERAI_DEMO_TENANT    override demo tenant UUID

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TENANT="${LEDGERAI_DEMO_TENANT:-00000000-0000-4000-8000-000000000001}"
SHARED="$SCRIPT_DIR/packages/shared-types"
DASH="$SCRIPT_DIR/apps/dashboard"

case "${1:-start}" in
  reset)
    LEDGERAI_DEMO_TENANT="$TENANT" LEDGERAI_DEMO_RESET=1 \
      bash "$SCRIPT_DIR/deploy/demo/seed-demo.sh"
    echo "Demo data cleared. Run ./bin/demo.sh seed to reseed."
    ;;

  seed)
    LEDGERAI_DEMO_TENANT="$TENANT" bash "$SCRIPT_DIR/deploy/demo/seed-demo.sh"
    ;;

  start|*)
    cd "$SCRIPT_DIR"
    docker compose up -d postgres pg-dev-init clickhouse api
    echo "Waiting for API ..."
    for _ in $(seq 1 60); do
      curl -fsS http://localhost:8094/healthz >/dev/null 2>&1 && break
      sleep 2
    done
    LEDGERAI_DEMO_TENANT="$TENANT" bash deploy/demo/seed-demo.sh
    cat <<EOF

================================================================
  BadgerIQ demo backend is live  (tenant $TENANT)
  No provider keys needed — all data is synthetic.

  Start the dashboard (new terminal):
    cd $SHARED && npm ci && npm run build
    cd $DASH && npm ci && npm install $SHARED
    LEDGERAI_API_URL=http://localhost:8094 \\
    LEDGERAI_DEV_TENANT_ID=$TENANT \\
    LEDGERAI_DEMO_MODE=true npm run dev

  → http://localhost:3000
    Amber banner at top confirms demo mode.

  Stop:       docker compose down
  Reset data: ./bin/demo.sh reset
================================================================
EOF
    ;;
esac
