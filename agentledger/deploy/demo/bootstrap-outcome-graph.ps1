param(
    [string]$Tenant = $(if ($env:BADGERIQ_DEV_TENANT_ID) { $env:BADGERIQ_DEV_TENANT_ID } elseif ($env:BADGERIQ_DEMO_TENANT) { $env:BADGERIQ_DEMO_TENANT } else { "00000000-0000-4000-8000-000000000001" }),
    [string]$ApiUrl = $(if ($env:BADGERIQ_API_URL) { $env:BADGERIQ_API_URL } else { "http://localhost:8094" }),
    [string]$Preset = "studio-live"
)

# Bootstrap a minimal agent outcome graph for a live tenant via the Design Partner API.
# Keeps connector spend (llm_calls) intact; adds agents + runs + outcomes so
# attribution V2 can stamp links and agent economics / LARI highlights populate.
#
# Usage (from agentledger/):
#   powershell -ExecutionPolicy Bypass -File deploy/demo/bootstrap-outcome-graph.ps1
#   make bootstrap-graph
#
# Requires docker compose stack up (api + attribution + postgres + clickhouse).

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

Write-Host "Design partner onboard (preset=$Preset, tenant=$Tenant) ..."

$body = @{ preset = $Preset } | ConvertTo-Json -Compress
try {
    $resp = Invoke-RestMethod -Method Post -Uri "$ApiUrl/v1/design-partner/onboard" `
        -Headers @{ "x-tenant-id" = $Tenant; "Content-Type" = "application/json" } `
        -Body $body
} catch {
    Write-Host "Onboard request failed. Ensure the API is up and BADGERIQ_DESIGN_PARTNER_ONBOARD_ENABLED=true."
    throw
}

Write-Host ""
Write-Host "Bootstrap complete."
Write-Host "  Agents registered:     $($resp.agentsRegistered)"
Write-Host "  Runs seeded:           $($resp.runsSeeded)"
Write-Host "  Outcomes seeded:       $($resp.outcomesSeeded)"
Write-Host "  Stamped with run_id:   $($resp.outcomesStamped)"
Write-Host "  v_roi rows:            $($resp.vRoiRows)"
Write-Host "  Attribution edges:     $($resp.attributionEdges)"
Write-Host "  LARI ready:            $($resp.ready)"
Write-Host ""
Write-Host $($resp.presentation.dashboardHint)
if ($resp.lari) {
    Write-Host ""
    Write-Host "Per-agent LARI:"
    foreach ($a in $resp.lari) {
        Write-Host "  $($a.agentId): LARI=$([math]::Round($a.lari, 2)) recommendation=$($a.recommendation)"
    }
}
