# Rebuild and restart the dashboard container (Windows — no make required).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

Write-Host "Stopping dashboard..."
docker compose stop dashboard 2>$null

Write-Host "Building dashboard image (includes shared-types + next build)..."
docker compose build --no-cache dashboard
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Starting dashboard..."
docker compose up -d dashboard
docker compose ps dashboard
