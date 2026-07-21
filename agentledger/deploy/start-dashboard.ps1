# Start the LedgerAI dashboard locally (Windows — no make required).
# Stops any stale dashboard container on :3000, then runs Next dev with demo tenant.
$ErrorActionPreference = "Stop"
# Script lives at agentledger/deploy/ — repo root for this package is one level up.
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "Stopping old dashboard containers on port 3000..."
docker ps -q --filter "publish=3000" | ForEach-Object { docker stop $_ 2>$null }

$shared = Join-Path $Root "packages\shared-types"
$dash = Join-Path $Root "apps\dashboard"

if (-not (Test-Path (Join-Path $shared "dist"))) {
    Write-Host "Building shared-types..."
    Push-Location $shared
    npm ci
    npm run build
    Pop-Location
}

$env:LEDGERAI_API_URL = "http://localhost:8094"
$env:LEDGERAI_DEV_TENANT_ID = "00000000-0000-4000-8000-000000000001"
$env:LEDGERAI_DEMO_MODE = "true"

Write-Host "Starting dashboard at http://localhost:3000"
Write-Host "  Data sources: sidebar or http://localhost:3000/settings?tab=connectors"
Push-Location $dash
if (-not (Test-Path "node_modules")) { npm ci }
npm run dev
