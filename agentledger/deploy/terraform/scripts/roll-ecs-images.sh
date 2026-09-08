#!/usr/bin/env bash
# Roll BadgerIQ ECS Fargate services to a new GHCR image tag without a full
# terraform apply. Registers a new task definition revision (image only) and
# updates the service. Keeps other container settings intact.
#
# Usage:
#   ./roll-ecs-images.sh --env pilot --tag 0.1.62-pilot --services api,dashboard
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ENV=""
TAG=""
SERVICES="api,dashboard"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --services) SERVICES="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$ENV" || -z "$TAG" ]]; then
  echo "Usage: $0 --env pilot|prod --tag 0.1.62-pilot [--services api,dashboard]" >&2
  exit 2
fi

# Release workflow publishes semver tags without a leading "v".
if [[ "$TAG" == v* ]]; then
  TAG="${TAG#v}"
fi

CLUSTER="badgeriq-${ENV}-cluster"
OWNER_LC="buttowsky2002"

IFS=',' read -r -a SVC_LIST <<<"$SERVICES"

echo "==> Cluster: $CLUSTER"
echo "==> Tag: $TAG"
echo "==> Services: ${SVC_LIST[*]}"

for svc in "${SVC_LIST[@]}"; do
  svc="$(echo "$svc" | xargs)"
  [[ -z "$svc" ]] && continue
  SERVICE_NAME="badgeriq-${ENV}-${svc}"
  IMAGE="ghcr.io/${OWNER_LC}/ledgerai-${svc}:${TAG}"

  echo ""
  echo "==> $SERVICE_NAME → $IMAGE"

  TASK_DEF_ARN=$(aws ecs describe-services \
    --region "$REGION" \
    --cluster "$CLUSTER" \
    --services "$SERVICE_NAME" \
    --query 'services[0].taskDefinition' \
    --output text)

  if [[ -z "$TASK_DEF_ARN" || "$TASK_DEF_ARN" == "None" ]]; then
    echo "ERROR: service not found: $SERVICE_NAME" >&2
    exit 1
  fi

  echo "    current task def: $TASK_DEF_ARN"

  TMP=$(mktemp)
  aws ecs describe-task-definition \
    --region "$REGION" \
    --task-definition "$TASK_DEF_ARN" \
    --query 'taskDefinition' \
    --output json >"$TMP"

  # Rewrite container image(s); preserve everything else ECS accepts on register.
  NEW_TD=$(python3 - "$TMP" "$IMAGE" <<'PY'
import json, sys
path, image = sys.argv[1], sys.argv[2]
td = json.load(open(path))
for c in td.get("containerDefinitions", []):
    c["image"] = image
keep = [
    "family", "taskRoleArn", "executionRoleArn", "networkMode",
    "containerDefinitions", "volumes", "placementConstraints",
    "requiresCompatibilities", "cpu", "memory", "memoryReservation",
    "runtimePlatform", "proxyConfiguration", "ipcMode", "pidMode",
    "ephemeralStorage", "inferenceAccelerators",
]
out = {k: td[k] for k in keep if k in td and td[k] is not None}
# Drop empty lists that confuse register-task-definition
for k in list(out.keys()):
    if out[k] == [] and k in ("volumes", "placementConstraints", "inferenceAccelerators"):
        del out[k]
json.dump(out, sys.stdout)
PY
)

  NEW_ARN=$(aws ecs register-task-definition \
    --region "$REGION" \
    --cli-input-json "$NEW_TD" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)

  echo "    registered: $NEW_ARN"

  aws ecs update-service \
    --region "$REGION" \
    --cluster "$CLUSTER" \
    --service "$SERVICE_NAME" \
    --task-definition "$NEW_ARN" \
    --force-new-deployment \
    --query 'service.{name:serviceName,taskDef:taskDefinition,desired:desiredCount}' \
    --output table

  rm -f "$TMP"
done

echo ""
echo "==> Waiting for services to stabilize (up to 10m each)…"
for svc in "${SVC_LIST[@]}"; do
  svc="$(echo "$svc" | xargs)"
  [[ -z "$svc" ]] && continue
  SERVICE_NAME="badgeriq-${ENV}-${svc}"
  aws ecs wait services-stable \
    --region "$REGION" \
    --cluster "$CLUSTER" \
    --services "$SERVICE_NAME" && echo "    $SERVICE_NAME stable" || {
      echo "WARN: $SERVICE_NAME did not report stable in time" >&2
    }
done

echo "==> Done"
