<#
.SYNOPSIS
    Applies forward-only SQL migrations to AWS-managed Postgres and/or ClickHouse.

.DESCRIPTION
    Reads connection credentials from AWS Secrets Manager, verifies connectivity,
    iterates numbered *.sql files, and tracks applied migrations in a
    schema_migrations table (Postgres) or ReplacingMergeTree (ClickHouse).

    For ClickHouse, uses the HTTPS interface via Invoke-RestMethod instead of
    clickhouse-client (spotty native Windows support).

.PARAMETER Environment
    Deployment environment: pilot or prod.

.PARAMETER Target
    Which database(s) to migrate: postgres, clickhouse, or both.

.PARAMETER PgHost
    Hostname psql connects to (default: localhost). The DSN in Secrets Manager
    points at the private RDS endpoint, which is not resolvable from outside
    the VPC. This parameter lets you override it with the local end of an SSM
    port-forward tunnel.

.PARAMETER PgPort
    Port psql connects to (default: 5432). Must match the localPortNumber of
    the active SSM port-forward tunnel.

.EXAMPLE
    .\migrate.ps1 -Environment pilot -Target postgres
    .\migrate.ps1 -Environment pilot -Target both
    .\migrate.ps1 -Environment pilot -Target postgres -PgHost 127.0.0.1 -PgPort 15432
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('pilot', 'prod')]
    [string]$Environment,

    [Parameter(Mandatory)]
    [ValidateSet('postgres', 'clickhouse', 'both')]
    [string]$Target,

    # The RDS instance is in a private subnet and its hostname is not publicly
    # resolvable. An SSM port-forward tunnel must already be open before running
    # this script, forwarding the RDS endpoint to PgHost:PgPort on this machine.
    [string]$PgHost = 'localhost',

    [int]$PgPort = 5432
)

$ErrorActionPreference = 'Stop'

$ScriptDir   = $PSScriptRoot
$RepoRoot    = (Resolve-Path (Join-Path $ScriptDir '..\..\..'))
$PgDir       = Join-Path $RepoRoot 'deploy\postgres'
$ChDir       = Join-Path $RepoRoot 'deploy\clickhouse'
$SecretPrefix = "badgeriq/$Environment"
$Region       = 'us-east-1'

$TotalApplied = 0
$TotalSkipped = 0

# ── Helpers ──────────────────────────────────────────────────────────────────

function Get-SecretJson([string]$SecretId) {
    $raw = aws secretsmanager get-secret-value `
        --secret-id $SecretId `
        --query SecretString `
        --output text `
        --region $Region
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to read secret '$SecretId' from Secrets Manager."
    }
    return ($raw | ConvertFrom-Json)
}

function Get-SqlFiles([string]$Dir) {
    Get-ChildItem -Path $Dir -Filter '*.sql' |
        Where-Object { $_.Name -match '^\d' } |
        Sort-Object Name
}

# ── Postgres ─────────────────────────────────────────────────────────────────

function Invoke-PostgresMigrations {
    Write-Host "`n==> Reading Postgres credentials from Secrets Manager ($SecretPrefix/postgres)..."
    $secret = Get-SecretJson "$SecretPrefix/postgres"

    # The DSN in Secrets Manager points at the private RDS endpoint
    # (e.g. badgeriq-pilot-postgres.xxx.us-east-1.rds.amazonaws.com), which is
    # not resolvable from outside the VPC. We parse username, password, and
    # database from it, then rebuild the connection string using PgHost:PgPort
    # — the local end of an SSM port-forward tunnel.
    $smDsn = $secret.dsn
    $uri   = [System.Uri]::new($smDsn)
    $pgUser = $uri.UserInfo.Split(':')[0]
    $pgPass = $uri.UserInfo.Split(':')[1]
    $pgDb   = $uri.AbsolutePath.TrimStart('/')
    $pgQuery = $uri.Query

    $dsn = "postgres://${pgUser}:${pgPass}@${PgHost}:${PgPort}/${pgDb}${pgQuery}"

    Write-Host "==> Testing ${PgHost}:${PgPort} connectivity (SSM tunnel check)..."
    $tcp = Test-NetConnection -ComputerName $PgHost -Port $PgPort -WarningAction SilentlyContinue
    if (-not $tcp.TcpTestSucceeded) {
        Write-Host @"

  ERROR: ${PgHost}:${PgPort} is not reachable.

  The RDS instance is in a private subnet. You must open an SSM
  port-forward tunnel before running migrations:

    aws ssm start-session ``
      --target <bastion-instance-id> ``
      --document-name AWS-StartPortForwardingSessionToRemoteHost ``
      --parameters '{"host":["<rds-endpoint>"],"portNumber":["5432"],"localPortNumber":["${PgPort}"]}'

  Then re-run this script.

"@ -ForegroundColor Red
        exit 1
    }
    Write-Host "  OK - ${PgHost}:${PgPort} is open."

    Write-Host '==> Ensuring schema_migrations table exists...'
    $createTable = @"
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
"@
    psql $dsn -v ON_ERROR_STOP=1 -c $createTable
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create schema_migrations table.' }

    Write-Host '==> Applying Postgres migrations...'
    $applied = 0
    $skipped = 0

    foreach ($f in (Get-SqlFiles $PgDir)) {
        $ver = $f.BaseName

        $already = psql $dsn -tAc "SELECT 1 FROM schema_migrations WHERE version = '$ver'" 2>$null
        if ($already -and $already.Trim() -eq '1') {
            Write-Host "  skip $ver"
            $skipped++
            continue
        }

        Write-Host "  Applying $ver..." -NoNewline
        psql $dsn -v ON_ERROR_STOP=1 -f $f.FullName
        if ($LASTEXITCODE -ne 0) { throw "Migration $ver failed." }

        psql $dsn -v ON_ERROR_STOP=1 -c "INSERT INTO schema_migrations (version) VALUES ('$ver')"
        if ($LASTEXITCODE -ne 0) { throw "Failed to record $ver in schema_migrations." }

        Write-Host ' OK'
        $applied++
    }

    Write-Host "==> Postgres: $applied applied, $skipped skipped."
    $script:TotalApplied += $applied
    $script:TotalSkipped += $skipped
}

# ── ClickHouse ───────────────────────────────────────────────────────────────

function Invoke-ClickHouseQuery([string]$Url, [string]$User, [string]$Password, [string]$Sql) {
    $secPass = ConvertTo-SecureString $Password -AsPlainText -Force
    $cred    = [System.Management.Automation.PSCredential]::new($User, $secPass)

    $params = @{
        Uri             = $Url
        Method          = 'POST'
        Body            = $Sql
        Credential      = $cred
        ContentType     = 'text/plain; charset=utf-8'
        UseBasicParsing = $true
    }
    $response = Invoke-RestMethod @params
    return $response
}

function Invoke-ClickHouseMigrations {
    Write-Host "`n==> Reading ClickHouse credentials from Secrets Manager ($SecretPrefix/clickhouse)..."
    $secret = Get-SecretJson "$SecretPrefix/clickhouse"

    $chUrl  = $secret.url.TrimEnd('/')
    $chUser = $secret.user
    $chPass = $secret.password

    # Verify connectivity
    Write-Host '==> Verifying ClickHouse connectivity...'
    try {
        $ping = Invoke-ClickHouseQuery $chUrl $chUser $chPass 'SELECT 1'
        Write-Host '  OK - ClickHouse reachable.'
    }
    catch {
        Write-Host "  ERROR: Cannot reach ClickHouse at $chUrl" -ForegroundColor Red
        Write-Host "  $_" -ForegroundColor Red
        exit 1
    }

    # Ensure migration tracking table
    Write-Host '==> Ensuring schema_migrations table exists...'
    $createMigTable = @"
CREATE DATABASE IF NOT EXISTS agentledger;
CREATE TABLE IF NOT EXISTS agentledger.schema_migrations
(
    version    String,
    applied_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(applied_at)
ORDER BY version;
"@
    Invoke-ClickHouseQuery $chUrl $chUser $chPass $createMigTable | Out-Null

    Write-Host '==> Applying ClickHouse migrations...'
    $applied = 0
    $skipped = 0

    foreach ($f in (Get-SqlFiles $ChDir)) {
        $ver = $f.BaseName

        $countQuery = "SELECT count() FROM agentledger.schema_migrations FINAL WHERE version = '$ver'"
        $count = (Invoke-ClickHouseQuery $chUrl $chUser $chPass $countQuery).Trim()

        if ($count -eq '1') {
            Write-Host "  skip $ver"
            $skipped++
            continue
        }

        Write-Host "  Applying $ver..." -NoNewline
        $sql = Get-Content -Raw -Path $f.FullName
        try {
            Invoke-ClickHouseQuery $chUrl $chUser $chPass $sql | Out-Null
        }
        catch {
            Write-Host ' FAILED' -ForegroundColor Red
            throw "ClickHouse migration $ver failed: $_"
        }

        $record = "INSERT INTO agentledger.schema_migrations (version) VALUES ('$ver')"
        Invoke-ClickHouseQuery $chUrl $chUser $chPass $record | Out-Null

        Write-Host ' OK'
        $applied++
    }

    Write-Host "==> ClickHouse: $applied applied, $skipped skipped."
    $script:TotalApplied += $applied
    $script:TotalSkipped += $skipped
}

# ── Main ─────────────────────────────────────────────────────────────────────

Write-Host "BadgerIQ migration runner - env=$Environment target=$Target"

if ($Target -eq 'postgres' -or $Target -eq 'both') {
    Write-Host "`n  NOTE: Postgres migrations require an active SSM port-forward tunnel" -ForegroundColor Yellow
    Write-Host "        to the private RDS instance (connecting via ${PgHost}:${PgPort}).`n" -ForegroundColor Yellow
}

if ($Target -eq 'postgres' -or $Target -eq 'both') {
    Invoke-PostgresMigrations
}

if ($Target -eq 'clickhouse' -or $Target -eq 'both') {
    Invoke-ClickHouseMigrations
}

Write-Host "`n==> Done. Total: $TotalApplied applied, $TotalSkipped skipped."
