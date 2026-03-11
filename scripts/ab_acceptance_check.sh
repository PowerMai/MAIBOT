#!/bin/bash
set -euo pipefail

# A/B 双机验收检查（只读）
# 可通过环境变量覆盖：
#   A_HOST=192.168.2.10 B_HOST=192.168.2.11 B_PORT=2024 ./scripts/ab_acceptance_check.sh

A_HOST="${A_HOST:-192.168.2.10}"
B_HOST="${B_HOST:-192.168.2.11}"
B_PORT="${B_PORT:-2024}"
B_BACKEND_URL="${B_BACKEND_URL:-http://$B_HOST:$B_PORT}"
A_LM_MODELS_URL="${A_LM_MODELS_URL:-http://$A_HOST:1234/v1/models}"

ok=true

check_url() {
  local label="$1"
  local url="$2"
  echo -n "$label ... "
  if curl -fsS "$url" >/dev/null 2>&1; then
    echo "OK"
  else
    echo "FAIL ($url)"
    ok=false
  fi
}

echo "== A/B 双机验收 =="
echo "A_HOST=$A_HOST  B_BACKEND_URL=$B_BACKEND_URL"
echo "A_LM_MODELS_URL=$A_LM_MODELS_URL"
echo

check_url "B /ok" "$B_BACKEND_URL/ok"
check_url "B /health" "$B_BACKEND_URL/health"
check_url "B /memory/health" "$B_BACKEND_URL/memory/health"
check_url "A LM Studio /v1/models" "$A_LM_MODELS_URL"

echo
echo "== 阈值检查 =="
MEM_STATUS="$(curl -s "$B_BACKEND_URL/memory/health" | python3 -c 'import sys,json; 
try:
 d=json.load(sys.stdin); print(d.get("status","unknown"))
except Exception: print("unknown")')"
echo "memory_status=$MEM_STATUS"
if [[ "$MEM_STATUS" == "critical" ]]; then
  ok=false
fi

DISK_USAGE="$(df -h . | tail -1 | awk '{print $5}' | tr -d '%')"
echo "runner_disk_usage=${DISK_USAGE}% (仅脚本执行机参考)"
if [[ "$DISK_USAGE" -ge 90 ]]; then
  ok=false
fi

echo
if [[ "$ok" == "true" ]]; then
  echo "验收通过"
  exit 0
else
  echo "验收未通过（请按输出修复）"
  exit 1
fi

