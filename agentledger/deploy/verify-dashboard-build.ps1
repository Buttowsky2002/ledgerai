# Fast local check before `docker compose build dashboard` (catches TS/import errors in ~1 min).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

$shared = Join-Path $Root "packages\shared-types"
$dash = Join-Path $Root "apps\dashboard"

Write-Host "==> shared-types build"
Push-Location $shared
if (-not (Test-Path "node_modules")) { npm ci }
npm run build
Pop-Location

Write-Host "==> dashboard typecheck + production build"
Push-Location $dash
if (-not (Test-Path "node_modules")) { npm ci }
npm run typecheck
npm run build
Pop-Location

Write-Host "OK — dashboard is ready for Docker build"
