#!/bin/bash
set -euo pipefail

# watcher invites 观测快检脚本
#
# 用法:
#   ./scripts/watcher_observability_check.sh
#   ./scripts/watcher_observability_check.sh --window-seconds 180
#   ./scripts/watcher_observability_check.sh --base-url http://127.0.0.1:2024 --skip-reset
#   ./scripts/watcher_observability_check.sh --output-json backend/data/watcher_observability_snapshot.json
#   ./scripts/watcher_observability_check.sh --strict --min-search-calls 1 --max-fallback-ratio 0.30 --max-loop-errors 0
#   ./scripts/watcher_observability_check.sh --strict --seed-tasks 1 --seed-scope personal
#
# 说明:
# - 默认请求后端: http://127.0.0.1:2024
# - 默认先 reset 观测计数，再等待窗口期后读取快照

BASE_URL="${LANGGRAPH_API_URL:-http://127.0.0.1:2024}"
WINDOW_SECONDS=300
SKIP_RESET="false"
OUTPUT_JSON="backend/data/watcher_observability_snapshot.json"
STRICT_MODE="false"
MIN_SEARCH_CALLS=""
MAX_FALLBACK_RATIO=""
MAX_LOOP_ERRORS=""
SEED_TASKS=0
SEED_SCOPE="personal"
GOVERNANCE_THRESHOLDS_FILE="${GOVERNANCE_THRESHOLDS_FILE:-backend/config/governance_thresholds.json}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)
      BASE_URL="${2:-}"
      shift 2
      ;;
    --window-seconds)
      WINDOW_SECONDS="${2:-}"
      shift 2
      ;;
    --skip-reset)
      SKIP_RESET="true"
      shift
      ;;
    --output-json)
      OUTPUT_JSON="${2:-}"
      shift 2
      ;;
    --strict)
      STRICT_MODE="true"
      shift
      ;;
    --min-search-calls)
      MIN_SEARCH_CALLS="${2:-}"
      shift 2
      ;;
    --max-fallback-ratio)
      MAX_FALLBACK_RATIO="${2:-}"
      shift 2
      ;;
    --max-loop-errors)
      MAX_LOOP_ERRORS="${2:-}"
      shift 2
      ;;
    --seed-tasks)
      SEED_TASKS="${2:-}"
      shift 2
      ;;
    --seed-scope)
      SEED_SCOPE="${2:-}"
      shift 2
      ;;
    *)
      echo "错误: 不支持参数 $1"
      echo "可选参数: --base-url <url> --window-seconds <seconds> --skip-reset --output-json <path> --strict --min-search-calls <n> --max-fallback-ratio <float> --max-loop-errors <n> --seed-tasks <n> --seed-scope <scope>"
      exit 1
      ;;
  esac
done

# 在 CLI 解析之后从治理配置补充 strict 默认阈值（参数解析顺序：先 CLI，再 JSON 默认）
if [[ "$STRICT_MODE" == "true" ]] && { [[ -z "$MIN_SEARCH_CALLS" ]] || [[ -z "$MAX_FALLBACK_RATIO" ]] || [[ -z "$MAX_LOOP_ERRORS" ]]; }; then
  if [[ -r "$GOVERNANCE_THRESHOLDS_FILE" ]]; then
    _thresh_vals=$(python3 - "$GOVERNANCE_THRESHOLDS_FILE" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as f:
        d = json.load(f)
except Exception:
    sys.exit(1)
wo = (d or {}).get("watcher_observability") or {}
st = (wo.get("strict") or {})
print(int(st.get("min_search_calls", 1)))
print(float(st.get("max_fallback_ratio", 0.3)))
print(int(st.get("max_loop_errors", 0)))
PY
) || true
    if [[ -n "$_thresh_vals" ]]; then
      _min=$(echo "$_thresh_vals" | sed -n '1p')
      _max_fb=$(echo "$_thresh_vals" | sed -n '2p')
      _max_loop=$(echo "$_thresh_vals" | sed -n '3p')
      [[ -z "$MIN_SEARCH_CALLS" ]] && MIN_SEARCH_CALLS="$_min"
      [[ -z "$MAX_FALLBACK_RATIO" ]] && MAX_FALLBACK_RATIO="$_max_fb"
      [[ -z "$MAX_LOOP_ERRORS" ]] && MAX_LOOP_ERRORS="$_max_loop"
    fi
  fi
fi
if [[ "$STRICT_MODE" == "true" ]] && { [[ -z "$MIN_SEARCH_CALLS" ]] || [[ -z "$MAX_FALLBACK_RATIO" ]] || [[ -z "$MAX_LOOP_ERRORS" ]]; }; then
  echo "错误: strict 模式需要 --min-search-calls / --max-fallback-ratio / --max-loop-errors 或有效 governance_thresholds.json"
  exit 1
fi

if ! [[ "$WINDOW_SECONDS" =~ ^[0-9]+$ ]] || [[ "$WINDOW_SECONDS" -lt 1 ]]; then
  echo "错误: --window-seconds 必须为正整数"
  exit 1
fi
if [[ -n "$MIN_SEARCH_CALLS" ]] && ! [[ "$MIN_SEARCH_CALLS" =~ ^[0-9]+$ ]]; then
  echo "错误: --min-search-calls 必须为非负整数"
  exit 1
fi
if [[ -n "$MAX_LOOP_ERRORS" ]] && ! [[ "$MAX_LOOP_ERRORS" =~ ^[0-9]+$ ]]; then
  echo "错误: --max-loop-errors 必须为非负整数"
  exit 1
fi
if ! [[ "$SEED_TASKS" =~ ^[0-9]+$ ]]; then
  echo "错误: --seed-tasks 必须为非负整数"
  exit 1
fi
if [[ -n "$MAX_FALLBACK_RATIO" ]]; then
  if ! python3 - "$MAX_FALLBACK_RATIO" <<'PY'
import sys
try:
    v = float(sys.argv[1])
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if 0.0 <= v <= 1.0 else 1)
PY
  then
    echo "错误: --max-fallback-ratio 必须在 [0,1] 区间"
    exit 1
  fi
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "错误: 未检测到 curl"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "错误: 未检测到 python3"
  exit 1
fi

fetch_config() {
  curl -sS --fail "${BASE_URL}/autonomous/watcher/config"
}

post_reset() {
  curl -sS --fail -X POST "${BASE_URL}/autonomous/watcher/observability/reset"
}

rearm_watcher_scheduler() {
  local base_url="$1"
  python3 - "$base_url" <<'PY'
import json
import sys
import urllib.request

base_url = sys.argv[1].rstrip("/")
payload = {"enabled": True, "role_id": ""}
req = urllib.request.Request(
    f"{base_url}/autonomous/watcher/config",
    data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=12) as resp:
        body = json.loads(resp.read().decode("utf-8"))
except Exception as e:
    # rearm 仅用于提升 seeded 场景命中率；失败不应中断主流程。
    print("rearm_ok=False")
    print(f"rearm_error={str(e)}")
    raise SystemExit(0)

runtime = body.get("runtime") if isinstance(body, dict) else {}
print(f"rearm_ok={bool((body or {}).get('ok', False))}")
print(f"rearm_enabled={bool((runtime or {}).get('enabled', False))}")
print(f"rearm_scheduler_running={bool((runtime or {}).get('scheduler_running', False))}")
print(f"rearm_role_id={str(((body or {}).get('config') or {}).get('role_id') or '')}")
PY
}

seed_available_tasks() {
  local base_url="$1"
  local scope="$2"
  local count="$3"
  python3 - "$base_url" "$scope" "$count" <<'PY'
import json
import sys
import urllib.request
import time
from datetime import datetime, timezone

base_url = sys.argv[1].rstrip("/")
scope = str(sys.argv[2] or "personal").strip() or "personal"
count = int(sys.argv[3])
created = []
failed = 0

for i in range(count):
    seed_id = f"watcher-seed-{datetime.now(timezone.utc).strftime('%H%M%S')}-{i}"
    payload = {
        "task_id": seed_id,
        "subject": f"watcher-observability-seed-{seed_id}",
        "description": f"自动注入的 watcher invite 观测负载（scope={scope}）",
        "required_skills": [],
        "callback_url": base_url,
    }
    req = urllib.request.Request(
        f"{base_url}/board/task-invite",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    invite_id = ""
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            invite = body.get("invite") if isinstance(body, dict) else {}
            invite_id = str((invite or {}).get("invite_id") or "")
            break
        except Exception:
            if attempt < 2:
                time.sleep(0.6 * (attempt + 1))
            else:
                failed += 1
    created.append(invite_id)

print(f"seed_count={len([x for x in created if x])}")
print(f"seed_failed={failed}")
for invite_id in created:
    if invite_id:
        print(f"seed_invite_id={invite_id}")
PY
}

wait_for_backend_ready() {
  local timeout_seconds="${1:-30}"
  local waited=0
  while [[ "$waited" -lt "$timeout_seconds" ]]; do
    if curl -sS --fail "${BASE_URL}/autonomous/watcher/config" > /dev/null 2>&1; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

extract_summary() {
  local payload="$1"
  python3 - "$payload" <<'PY'
import json
import sys

raw = sys.argv[1]
try:
    data = json.loads(raw)
except Exception:
    print("parse_error=true")
    sys.exit(0)

runtime = data.get("runtime") if isinstance(data, dict) else {}
runtime = runtime if isinstance(runtime, dict) else {}
obs = runtime.get("invites_observability") if isinstance(runtime.get("invites_observability"), dict) else {}

search_calls = int(obs.get("scan_search_calls", 0) or 0)
fallback_calls = int(obs.get("scan_fallback_calls", 0) or 0)
scan_total = search_calls + fallback_calls
fallback_ratio = (fallback_calls / scan_total) if scan_total > 0 else 0.0

print(f"watcher_enabled={bool(runtime.get('enabled', False))}")
print(f"scheduler_running={bool(runtime.get('scheduler_running', False))}")
print(f"executing_tasks={int(runtime.get('executing_tasks', 0) or 0)}")
print(f"search_calls={search_calls}")
print(f"fallback_calls={fallback_calls}")
print(f"fallback_ratio={fallback_ratio:.4f}")
print(f"search_rows={int(obs.get('scan_search_rows', 0) or 0)}")
print(f"fallback_rows={int(obs.get('scan_fallback_rows', 0) or 0)}")
print(f"search_errors={int(obs.get('scan_search_errors', 0) or 0)}")
print(f"rows_seen={int(obs.get('rows_seen', 0) or 0)}")
print(f"processable_rows={int(obs.get('processable_rows', 0) or 0)}")
print(f"bid_submitted={int(obs.get('bid_submitted', 0) or 0)}")
print(f"bid_failed={int(obs.get('bid_failed', 0) or 0)}")
print(f"loop_errors={int(obs.get('loop_errors', 0) or 0)}")
print(f"last_scan_path={obs.get('last_scan_path', '')}")
print(f"last_scan_at={obs.get('last_scan_at', '')}")
print(f"last_error={obs.get('last_error', '')}")
PY
}

write_snapshot_json() {
  local payload="$1"
  local output_json="$2"
  local seeded_tasks="$3"
  python3 - "$payload" "$output_json" "$BASE_URL" "$WINDOW_SECONDS" "$SKIP_RESET" "$seeded_tasks" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

raw = sys.argv[1]
out_path = Path(sys.argv[2])
base_url = sys.argv[3]
window_seconds = int(sys.argv[4])
skip_reset = str(sys.argv[5]).lower() == "true"
seeded_tasks = int(sys.argv[6])

data = {}
try:
    parsed = json.loads(raw)
    if isinstance(parsed, dict):
        data = parsed
except Exception:
    data = {}

runtime = data.get("runtime") if isinstance(data.get("runtime"), dict) else {}
obs = runtime.get("invites_observability") if isinstance(runtime.get("invites_observability"), dict) else {}
search_calls = int(obs.get("scan_search_calls", 0) or 0)
fallback_calls = int(obs.get("scan_fallback_calls", 0) or 0)
scan_total = search_calls + fallback_calls
fallback_ratio = (fallback_calls / scan_total) if scan_total > 0 else 0.0

snapshot = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "base_url": base_url,
    "window_seconds": window_seconds,
    "skip_reset": skip_reset,
    "seeded_tasks": seeded_tasks,
    "runtime": runtime,
    "invites_observability": obs,
    "metrics": {
        "scan_total_calls": scan_total,
        "search_calls": search_calls,
        "fallback_calls": fallback_calls,
        "fallback_ratio": round(fallback_ratio, 6),
        "search_errors": int(obs.get("scan_search_errors", 0) or 0),
        "loop_errors": int(obs.get("loop_errors", 0) or 0),
        "rows_seen": int(obs.get("rows_seen", 0) or 0),
        "processable_rows": int(obs.get("processable_rows", 0) or 0),
        "bid_submitted": int(obs.get("bid_submitted", 0) or 0),
        "bid_failed": int(obs.get("bid_failed", 0) or 0),
    },
}
out_path.parent.mkdir(parents=True, exist_ok=True)
out_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"snapshot_json={out_path.as_posix()}")
PY
}

strict_evaluate() {
  local payload="$1"
  local min_search_calls="$2"
  local max_fallback_ratio="$3"
  local max_loop_errors="$4"
  local seeded_tasks="$5"
  python3 - "$payload" "$min_search_calls" "$max_fallback_ratio" "$max_loop_errors" "$seeded_tasks" <<'PY'
import json
import sys

raw = sys.argv[1]
min_search_calls = int(sys.argv[2])
max_fallback_ratio = float(sys.argv[3])
max_loop_errors = int(sys.argv[4])
seeded_tasks = int(sys.argv[5])

try:
    data = json.loads(raw)
except Exception:
    print("strict_status=fail")
    print("strict_reason=parse_error")
    raise SystemExit(1)

runtime = data.get("runtime") if isinstance(data, dict) else {}
runtime = runtime if isinstance(runtime, dict) else {}
obs = runtime.get("invites_observability") if isinstance(runtime.get("invites_observability"), dict) else {}
watcher_enabled = bool(runtime.get("enabled", False))
scheduler_running = bool(runtime.get("scheduler_running", False))
search_calls = int(obs.get("scan_search_calls", 0) or 0)
fallback_calls = int(obs.get("scan_fallback_calls", 0) or 0)
loop_errors = int(obs.get("loop_errors", 0) or 0)
rows_seen = int(obs.get("rows_seen", 0) or 0)
processable_rows = int(obs.get("processable_rows", 0) or 0)
scan_total = search_calls + fallback_calls
fallback_ratio = (fallback_calls / scan_total) if scan_total > 0 else 0.0

violations = []
if not watcher_enabled:
    violations.append("watcher_enabled=false")
if not scheduler_running:
    violations.append("scheduler_running=false")

# 无负载窗口豁免：观测窗口内没有可处理任务时，不强制要求 search_calls。
idle_window = (
    watcher_enabled
    and scheduler_running
    and rows_seen == 0
    and processable_rows == 0
)
if search_calls < min_search_calls and not (idle_window and seeded_tasks <= 0):
    violations.append(f"search_calls({search_calls}) < min_search_calls({min_search_calls})")
if fallback_ratio > max_fallback_ratio:
    violations.append(f"fallback_ratio({fallback_ratio:.4f}) > max_fallback_ratio({max_fallback_ratio:.4f})")
if loop_errors > max_loop_errors:
    violations.append(f"loop_errors({loop_errors}) > max_loop_errors({max_loop_errors})")

if violations:
    print("strict_status=fail")
    for row in violations:
        print(f"strict_violation={row}")
    raise SystemExit(1)

print("strict_status=pass")
if idle_window and search_calls < min_search_calls and seeded_tasks <= 0:
    print("strict_reason=idle_window_no_processable_rows")
else:
    print("strict_reason=all_thresholds_satisfied")
PY
}

echo "watcher observability check"
echo "- base_url: ${BASE_URL}"
echo "- window_seconds: ${WINDOW_SECONDS}"
echo "- skip_reset: ${SKIP_RESET}"
echo "- output_json: ${OUTPUT_JSON}"
echo "- strict_mode: ${STRICT_MODE}"
echo "- min_search_calls: ${MIN_SEARCH_CALLS}"
echo "- max_fallback_ratio: ${MAX_FALLBACK_RATIO}"
echo "- max_loop_errors: ${MAX_LOOP_ERRORS}"
echo "- seed_tasks: ${SEED_TASKS}"
echo "- seed_scope: ${SEED_SCOPE}"

echo
echo "[0/3] wait backend ready..."
if wait_for_backend_ready 45; then
  echo "backend_ready=true"
else
  echo "backend_ready=false"
  echo "错误: ${BASE_URL} 未就绪，无法执行 watcher 观测。"
  exit 2
fi

if [[ "$SKIP_RESET" != "true" ]]; then
  echo
  echo "[1/3] reset invites observability..."
  reset_raw="$(post_reset)"
  python3 - "$reset_raw" <<'PY'
import json
import sys
raw = sys.argv[1]
try:
    data = json.loads(raw)
except Exception:
    print("reset_status=parse_error")
    print(f"reset_raw_preview={raw[:200]}")
    raise SystemExit(0)
print(f"reset_ok={bool(data.get('ok', False))}")
PY
fi

if [[ "$SEED_TASKS" -gt 0 ]]; then
  echo
  echo "[seed] rearm watcher scheduler (reset idle backoff)..."
  rearm_watcher_scheduler "$BASE_URL"
  echo
  echo "[seed] creating ${SEED_TASKS} available task(s) for watcher window..."
  seed_available_tasks "$BASE_URL" "$SEED_SCOPE" "$SEED_TASKS"
fi

echo
echo "[2/3] waiting ${WINDOW_SECONDS}s observation window..."
sleep "$WINDOW_SECONDS"

echo
echo "[3/3] fetch watcher runtime snapshot..."
cfg_raw="$(fetch_config)"
extract_summary "$cfg_raw"
write_snapshot_json "$cfg_raw" "$OUTPUT_JSON" "$SEED_TASKS"

echo
echo "建议判定:"
echo "- search_calls > 0"
echo "- fallback_ratio < ${MAX_FALLBACK_RATIO:-0.30} (按环境基线可调整)"
echo "- loop_errors == 0"

if [[ "$STRICT_MODE" == "true" ]]; then
  echo
  echo "[strict] evaluating thresholds..."
  strict_evaluate "$cfg_raw" "$MIN_SEARCH_CALLS" "$MAX_FALLBACK_RATIO" "$MAX_LOOP_ERRORS" "$SEED_TASKS"
fi
