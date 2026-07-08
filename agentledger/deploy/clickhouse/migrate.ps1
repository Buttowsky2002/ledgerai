# Applies forward-only SQL migrations to a running ClickHouse (existing volumes).
# Fresh docker volumes run deploy/clickhouse/*.sql on first init — this script
# is for upgrades when new numbered migrations are added.
#
# Usage (from agentledger/):
#   powershell -ExecutionPolicy Bypass -File deploy/clickhouse/migrate.ps1
#   make migrate

$ErrorActionPreference = "Stop"
$Dir = $PSScriptRoot
$Root = Split-Path -Parent (Split-Path -Parent $Dir)
Set-Location $Root

function Invoke-ClickHouse([string]$Sql) {
    docker compose exec -T clickhouse clickhouse-client --multiquery --query $Sql 2>&1 | Out-Null
}

function Invoke-ClickHouseFile([string]$Path) {
    Get-Content -Raw -Path $Path | docker compose exec -T clickhouse clickhouse-client --multiquery 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "clickhouse-client exited $LASTEXITCODE" }
}

function Query-ClickHouse([string]$Sql) {
    $raw = docker compose exec -T clickhouse clickhouse-client --query $Sql 2>&1
    if ($LASTEXITCODE -ne 0) { throw $raw }
    if ($null -eq $raw) { return "" }
    return ([string]$raw).Trim()
}

function Migration-Applied([string]$Version) {
    try {
        return (Query-ClickHouse "SELECT count() FROM agentledger.schema_migrations FINAL WHERE version = '$Version'") -eq "1"
    } catch {
        return $false
    }
}

function Mark-Applied([string]$Version) {
    Invoke-ClickHouse "INSERT INTO agentledger.schema_migrations (version) VALUES ('$Version')"
}

$chRunning = docker compose ps clickhouse --status running -q 2>$null
if (-not $chRunning) {
    Write-Host "ClickHouse is not running. Starting clickhouse..."
    docker compose up -d clickhouse
    for ($i = 0; $i -lt 60; $i++) {
        try {
            if ((Query-ClickHouse "SELECT 1") -eq "1") { break }
        } catch { }
        Start-Sleep -Seconds 1
    }
}

Write-Host "==> ClickHouse migrations"
Invoke-ClickHouse @"
CREATE TABLE IF NOT EXISTS agentledger.schema_migrations
(
    version String,
    applied_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(applied_at)
ORDER BY version;
"@

# Bootstrap tracking for DBs created before schema_migrations existed.
$bootstrapChecks = @(
    @{ Version = "012_fixed_costs"; Check = "EXISTS TABLE agentledger.fixed_costs" }
    @{ Version = "013_spend_daily_by_user"; Check = "EXISTS TABLE agentledger.spend_daily_by_user" }
    @{ Version = "014_spend_daily_by_user_unassigned"; Check = "EXISTS VIEW agentledger.mv_spend_daily_by_user" }
    @{ Version = "015_lari_cfo_costs"; Check = "EXISTS TABLE agentledger.coding_agent_daily" }
    @{ Version = "016_cursor_billing_split"; Check = "SELECT hasColumnInTable('agentledger', 'llm_calls', 'usage_value_usd')" }
    @{ Version = "017_metered_cost"; Check = "SELECT hasColumnInTable('agentledger', 'llm_calls', 'metered_cost_usd')" }
    @{ Version = "018_cost_basis"; Check = "EXISTS VIEW agentledger.v_cost_basis_daily" }
)
foreach ($item in $bootstrapChecks) {
    if (Migration-Applied $item.Version) { continue }
    try {
        if ((Query-ClickHouse $item.Check) -eq "1") {
            Write-Host "  bootstrap mark $($item.Version)"
            Mark-Applied $item.Version
        }
    } catch { }
}

# Mark legacy migrations (001-011) as applied when core tables exist.
if (-not (Migration-Applied "001_events")) {
    try {
        if ((Query-ClickHouse "EXISTS TABLE agentledger.llm_calls") -eq "1") {
            Get-ChildItem "$Dir\*.sql" | Sort-Object Name | ForEach-Object {
                $ver = $_.BaseName
                $num = [int](($ver -split '_')[0])
                if ($num -le 11) { Mark-Applied $ver }
            }
            Write-Host "  bootstrapped migrations 001-011"
        }
    } catch { }
}

Get-ChildItem "$Dir\*.sql" | Sort-Object Name | ForEach-Object {
    $ver = $_.BaseName
    if (Migration-Applied $ver) {
        Write-Host "  skip $ver"
        return
    }
    Write-Host "  apply $ver"
    Invoke-ClickHouseFile $_.FullName
    Mark-Applied $ver
    Write-Host "  ok $ver"
}

Write-Host "ClickHouse migrations complete."
