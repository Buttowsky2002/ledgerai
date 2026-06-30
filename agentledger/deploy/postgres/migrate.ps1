# Applies forward-only SQL migrations to a running Postgres (existing volumes).
# Fresh docker volumes already run deploy/postgres/*.sql on first init — this
# script is for upgrades when new numbered migrations are added.
#
# Usage (from agentledger/):
#   powershell -ExecutionPolicy Bypass -File deploy/postgres/migrate.ps1
#   make migrate

$ErrorActionPreference = "Stop"
$Dir = $PSScriptRoot
$Root = Split-Path -Parent (Split-Path -Parent $Dir)
Set-Location $Root

function Invoke-Psql([string]$Sql) {
    docker compose exec -T postgres psql -U agentledger -d agentledger -v ON_ERROR_STOP=1 -c $Sql
}

function Invoke-PsqlFile([string]$Path) {
    Get-Content -Raw -Path $Path | docker compose exec -T postgres psql -U agentledger -d agentledger -v ON_ERROR_STOP=1
}

function Query-Psql([string]$Sql) {
    $raw = docker compose exec -T postgres psql -U agentledger -d agentledger -tAc $Sql
    if ($null -eq $raw) { return "" }
    return ([string]$raw).Trim()
}

$pgRunning = docker compose ps postgres --status running -q 2>$null
if (-not $pgRunning) {
    Write-Host "Postgres is not running. Starting postgres + pg-dev-init..."
    docker compose up -d postgres pg-dev-init
    for ($i = 0; $i -lt 60; $i++) {
        try {
            if ((Query-Psql "SELECT 1") -eq "1") { break }
        } catch { }
        Start-Sleep -Seconds 1
    }
}

Write-Host "==> Postgres migrations"
Invoke-Psql "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());"

# Bootstrap: existing DBs created before schema_migrations tracking
$count = Query-Psql "SELECT COUNT(*)::text FROM schema_migrations"
if ($count -eq "0") {
    $hasTenants = Query-Psql "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='tenants')"
    if ($hasTenants -eq "t") {
        Write-Host "Bootstrapping schema_migrations for existing database..."
        Get-ChildItem "$Dir\*.sql" | Sort-Object Name | ForEach-Object {
            $ver = $_.BaseName
            $num = ($ver -split '_')[0]
            if ([int]$num -le 11) {
                Invoke-Psql "INSERT INTO schema_migrations (version) VALUES ('$ver') ON CONFLICT DO NOTHING"
            }
        }
        if ((Query-Psql "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='import_jobs')") -eq "t") {
            Invoke-Psql "INSERT INTO schema_migrations (version) VALUES ('012_import_jobs') ON CONFLICT DO NOTHING"
        }
        if ((Query-Psql "SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_name='import_jobs' AND column_name='net_spend_imported_usd')") -eq "t") {
            Invoke-Psql "INSERT INTO schema_migrations (version) VALUES ('013_import_job_summary') ON CONFLICT DO NOTHING"
        }
        if ((Query-Psql "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='connector_definitions')") -eq "t") {
            Invoke-Psql "INSERT INTO schema_migrations (version) VALUES ('012_api_connector_framework') ON CONFLICT DO NOTHING"
            Invoke-Psql "INSERT INTO schema_migrations (version) VALUES ('014_api_connector_framework') ON CONFLICT DO NOTHING"
        }
    }
}

Get-ChildItem "$Dir\*.sql" | Sort-Object Name | ForEach-Object {
    $ver = $_.BaseName
    $applied = Query-Psql "SELECT 1 FROM schema_migrations WHERE version='$ver'"
    if ($applied -eq "1") {
        Write-Host "  skip $ver"
        return
    }
    Write-Host "  apply $ver"
    try {
        Invoke-PsqlFile $_.FullName
        Invoke-Psql "INSERT INTO schema_migrations (version) VALUES ('$ver')"
        Write-Host "  ok $ver"
    } catch {
        Write-Error "Migration $ver failed: $_"
    }
}

Write-Host "Postgres migrations complete."
