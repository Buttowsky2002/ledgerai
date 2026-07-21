# BadgerIQ pilot status check - run this anytime to see the real, current
# state of the deployment in one shot, instead of re-deriving it command
# by command. Safe to run repeatedly; makes no changes.

$region = "us-east-1"
$cluster = "badgeriq-pilot-cluster"
$services = @("api", "gateway", "dashboard")

Write-Host ""
Write-Host "=== AWS identity ===" -ForegroundColor Cyan
aws sts get-caller-identity --region $region --query "{Account:Account,Arn:Arn}" --output table

Write-Host ""
Write-Host "=== ECS service health ===" -ForegroundColor Cyan
$svcNames = $services | ForEach-Object { "badgeriq-pilot-$_" }
aws ecs describe-services --cluster $cluster --services $svcNames --region $region --query "services[].{name:serviceName,running:runningCount,desired:desiredCount,taskDef:taskDefinition}" --output table

Write-Host ""
Write-Host "=== Deployed image per service ===" -ForegroundColor Cyan
foreach ($svc in $services) {
    $taskDef = aws ecs describe-services --cluster $cluster --services "badgeriq-pilot-$svc" --region $region --query "services[0].taskDefinition" --output text
    $image = aws ecs describe-task-definition --task-definition $taskDef --region $region --query "taskDefinition.containerDefinitions[0].image" --output text
    Write-Host "$svc : $image"
}

Write-Host ""
Write-Host "=== Dashboard environment variables ===" -ForegroundColor Cyan
aws ecs describe-task-definition --task-definition badgeriq-pilot-dashboard --region $region --query "taskDefinition.containerDefinitions[0].environment" --output table

Write-Host ""
Write-Host "=== Secrets parse check ===" -ForegroundColor Cyan
$secrets = @("postgres", "clickhouse", "jwt", "oidc-microsoft", "ghcr", "anthropic", "github")
foreach ($s in $secrets) {
    $raw = aws secretsmanager get-secret-value --secret-id "badgeriq/pilot/$s" --query SecretString --output text --region $region 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "$s : NOT FOUND" -ForegroundColor Red
        continue
    }
    try {
        $null = $raw | ConvertFrom-Json -ErrorAction Stop
        Write-Host "$s : OK" -ForegroundColor Green
    } catch {
        Write-Host "$s : BROKEN, invalid JSON" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "=== ALB target group health ===" -ForegroundColor Cyan
$tgArns = aws elbv2 describe-target-groups --region $region --query "TargetGroups[?contains(TargetGroupName,'badgeriq-pilot')].TargetGroupArn" --output text
$tgList = $tgArns -split "\s+"
foreach ($tg in $tgList) {
    if ($tg) {
        $parts = $tg -split "/"
        $name = $parts[-2]
        $health = aws elbv2 describe-target-health --target-group-arn $tg --region $region --query "TargetHealthDescriptions[0].TargetHealth.State" --output text
        Write-Host "$name : $health"
    }
}

Write-Host ""
Write-Host "=== CloudFront health check ===" -ForegroundColor Cyan
$cfDomain = "d1e2lzkoizqhk6.cloudfront.net"
Write-Host "Domain: $cfDomain"
try {
    $resp = Invoke-WebRequest -Uri "https://$cfDomain/api/health" -UseBasicParsing -TimeoutSec 10
    Write-Host "api/health status: $($resp.StatusCode)" -ForegroundColor Green
} catch {
    Write-Host "api/health FAILED" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== Recent stopped tasks, last 10 minutes ===" -ForegroundColor Cyan
foreach ($svc in $services) {
    $tasksJson = aws ecs list-tasks --cluster $cluster --service-name "badgeriq-pilot-$svc" --desired-status STOPPED --region $region --query "taskArns" --output json
    $tasks = $tasksJson | ConvertFrom-Json
    if ($tasks.Count -gt 0) {
        $lastTask = $tasks[$tasks.Count - 1]
        $detailJson = aws ecs describe-tasks --cluster $cluster --tasks $lastTask --region $region --query "tasks[0].{stoppedAt:stoppedAt,reason:stoppedReason}" --output json
        $detail = $detailJson | ConvertFrom-Json
        if ([string]::IsNullOrEmpty($detail.stoppedAt)) {
            Write-Host "$svc : task still stopping, no timestamp yet, skip" -ForegroundColor DarkGray
            continue
        }
        $isNormalDeploy = $detail.reason -match "Scaling activity initiated by"
        $stoppedTime = [datetime]$detail.stoppedAt
        $ageMinutes = ((Get-Date) - $stoppedTime).TotalMinutes
        $ageRounded = [math]::Round($ageMinutes, 1)
        if ($isNormalDeploy) {
            Write-Host "$svc : normal deployment cycling, $ageRounded minutes ago, not a failure" -ForegroundColor Green
        } elseif ($ageMinutes -lt 10) {
            Write-Host "$svc : RECENT FAILURE, $ageRounded minutes ago" -ForegroundColor Red
            Write-Host "  reason: $($detail.reason)" -ForegroundColor Red
        } else {
            Write-Host "$svc : last failure $ageRounded minutes ago, stale, likely fine" -ForegroundColor DarkGray
        }
    } else {
        Write-Host "$svc : no stopped tasks found" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Cyan
Write-Host ""
