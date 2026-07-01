param(
    [switch]$Reset
)

# Seed (or reset) the BadgerIQ demo tenant - no provider keys required.
#
# Usage (from agentledger/):
#   powershell -ExecutionPolicy Bypass -File deploy/demo/seed-demo.ps1
#   make seed-demo
#   make seed          (alias)
#
# Reset (clear, no reseed):
#   powershell -ExecutionPolicy Bypass -File deploy/demo/seed-demo.ps1 -Reset
#   make reset-demo
#
# Requires docker compose stack up (postgres + clickhouse at minimum).

$ErrorActionPreference = "Stop"
$Dir = $PSScriptRoot
$Root = Split-Path -Parent (Split-Path -Parent $Dir)
Set-Location $Root

$Tenant = if ($env:LEDGERAI_DEMO_TENANT) { $env:LEDGERAI_DEMO_TENANT } else { "00000000-0000-4000-8000-000000000001" }
if (-not $Reset -and $env:LEDGERAI_DEMO_RESET -eq "1") { $Reset = $true }

$ChTables = @(
    "llm_calls", "spend_daily", "spend_hourly_by_key", "risk_daily",
    "agent_runs", "outcomes", "roi_rates", "agent_tool_calls", "risk_events", "agent_risk"
)

function Invoke-ChClient {
    param([string[]]$ChArgs)
    docker compose exec -T clickhouse clickhouse-client @ChArgs
}

function Invoke-PgClient {
    param([string[]]$PgArgs)
    docker compose exec -T postgres psql -U agentledger -d agentledger -v ON_ERROR_STOP=1 @PgArgs
}

function Test-PgUp {
    $q = docker compose ps postgres -q 2>$null
    return [bool]$q
}

Write-Host "Waiting for ClickHouse ..."
for ($i = 0; $i -lt 60; $i++) {
    try {
        docker compose exec -T clickhouse wget -qO- http://localhost:8123/ping 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
    } catch { }
    Start-Sleep -Seconds 1
}

if ($Reset) {
    Write-Host "Resetting demo tenant $Tenant (clearing data, no reseed) ..."
    foreach ($t in $ChTables) {
        Invoke-ChClient -ChArgs @(
            "--param_tenant=$Tenant",
            "--query",
            "ALTER TABLE agentledger.$t DELETE WHERE tenant_id = {tenant:String} SETTINGS mutations_sync = 2"
        )
    }
    if (Test-PgUp) {
        $pgSql = @"
DELETE FROM attribution_edges WHERE tenant_id = '$Tenant'::uuid;
DELETE FROM attribution_baselines WHERE tenant_id = '$Tenant'::uuid;
DELETE FROM attribution_coalitions WHERE tenant_id = '$Tenant'::uuid;
DELETE FROM budgets WHERE tenant_id = '$Tenant'::uuid;
DELETE FROM agents WHERE tenant_id = '$Tenant'::uuid;
DELETE FROM identities WHERE tenant_id = '$Tenant'::uuid;
DELETE FROM teams WHERE tenant_id = '$Tenant'::uuid;
"@
        Invoke-PgClient -PgArgs @("-c", $pgSql)
    }
    Write-Host "Demo data cleared for tenant $Tenant."
    exit 0
}

Write-Host "Seeding ClickHouse analytics for tenant $Tenant ..."
Get-Content -Raw -Path (Join-Path $Dir "clickhouse_seed.sql") |
    docker compose exec -T clickhouse clickhouse-client --multiquery --param_tenant=$Tenant
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (Test-PgUp) {
    Write-Host "Seeding Postgres control plane (tenant/teams/agents/budgets) ..."
    Get-Content -Raw -Path (Join-Path $Dir "postgres_seed.sql") |
        docker compose exec -T postgres psql -U agentledger -d agentledger -v ON_ERROR_STOP=1 -v tenant=$Tenant
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
    Write-Host "(Postgres not running - skipped control-plane seed; analytics demo still works.)"
}

Write-Host ""
Write-Host "Verifying demo story:"
Invoke-ChClient -ChArgs @("--param_tenant=$Tenant", "--query",
    "SELECT count() AS spend_daily_rows, round(sum(cost_usd), 2) AS total_usd FROM agentledger.spend_daily WHERE tenant_id = {tenant:String}")
Write-Host "Top spend by agent (DataCleanupAgent should dominate - runaway cost):"
Invoke-ChClient -ChArgs @("--param_tenant=$Tenant", "--query",
    "SELECT agent_id, round(sum(cost_usd), 2) AS cost_usd FROM agentledger.spend_hourly_by_key WHERE tenant_id = {tenant:String} GROUP BY agent_id ORDER BY cost_usd DESC LIMIT 3")
