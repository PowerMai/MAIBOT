#!/bin/bash
set -euo pipefail

# 每日运维巡检（零重复开发，复用现有门禁命令）
#
# 用法：
#   ./scripts/ops_daily_check.sh
#   ./scripts/ops_daily_check.sh --skip-projection
#   ./scripts/ops_daily_check.sh --snapshot
#   ./scripts/ops_daily_check.sh --watcher
#   ./scripts/ops_daily_check.sh --strict-watcher
#   ./scripts/ops_daily_check.sh --strict-reliability-e2e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

OPS_WEBHOOK_URL="${OPS_WEBHOOK_URL:-}"

notify_webhook() {
  local status="$1"
  local message="$2"
  if [[ -z "$OPS_WEBHOOK_URL" ]]; then
    return 0
  fi
  python3 - "$status" "$message" "$OPS_WEBHOOK_URL" <<'PY'
import json
import sys
import urllib.request

status, message, webhook = sys.argv[1], sys.argv[2], sys.argv[3]
payload = {
    "text": f"[ops-daily-check] {status}: {message}",
    "status": status,
    "message": message,
}
data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
req = urllib.request.Request(
    webhook,
    data=data,
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    urllib.request.urlopen(req, timeout=6).read()
except Exception as e:
    print(f"[ops-daily-check] webhook notify failed: {e}")
PY
}

on_error() {
  local code="$?"
  local failed_cmd="${BASH_COMMAND:-unknown}"
  echo "[ops-daily-check] failed: exit_code=$code cmd=$failed_cmd"
  notify_webhook "failed" "exit_code=$code cmd=$failed_cmd"
  exit "$code"
}
trap on_error ERR

SKIP_PROJECTION="false"
ENABLE_SNAPSHOT="false"
ENABLE_WATCHER="false"
STRICT_WATCHER="false"
STRICT_RELIABILITY_E2E="false"
for arg in "$@"; do
  case "$arg" in
    --skip-projection)
      SKIP_PROJECTION="true"
      ;;
    --snapshot)
      ENABLE_SNAPSHOT="true"
      ;;
    --watcher)
      ENABLE_WATCHER="true"
      ;;
    --strict-watcher)
      ENABLE_WATCHER="true"
      STRICT_WATCHER="true"
      ;;
    --strict-reliability-e2e)
      STRICT_RELIABILITY_E2E="true"
      ;;
    *)
      echo "错误: 不支持参数 $arg"
      echo "可选参数:"
      echo "  --skip-projection"
      echo "  --snapshot"
      echo "  --watcher"
      echo "  --strict-watcher"
      echo "  --strict-reliability-e2e"
      notify_webhook "failed" "unknown argument: $arg"
      exit 1
      ;;
  esac
done

echo "[ops-daily-check] start"
echo "- root: $ROOT_DIR"
echo "- skip_projection: $SKIP_PROJECTION"
echo "- snapshot: $ENABLE_SNAPSHOT"
echo "- watcher: $ENABLE_WATCHER"
echo "- strict_watcher: $STRICT_WATCHER"
echo "- strict_reliability_e2e: $STRICT_RELIABILITY_E2E"

HAS_FAILURE="false"

if [[ "$SKIP_PROJECTION" != "true" ]]; then
  if ! make collect-task-status-projection-evidence; then
    echo "[ops-daily-check] error: collect-task-status-projection-evidence failed"
    HAS_FAILURE="true"
  fi
fi

if ! make check-reliability-slo-strict; then
  echo "[ops-daily-check] error: check-reliability-slo-strict failed"
  HAS_FAILURE="true"
fi
if ! make skills-semantic-gate; then
  echo "[ops-daily-check] error: skills-semantic-gate failed"
  HAS_FAILURE="true"
fi
if ! make plugin-command-conflict-gate; then
  echo "[ops-daily-check] error: plugin-command-conflict-gate failed"
  HAS_FAILURE="true"
fi
if ! make knowledge-source-compliance-gate; then
  echo "[ops-daily-check] error: knowledge-source-compliance-gate failed"
  HAS_FAILURE="true"
fi
if ! make build-release-gate-summary; then
  echo "[ops-daily-check] error: build-release-gate-summary failed"
  HAS_FAILURE="true"
fi
if ! make build-memory-scope-contract-report; then
  echo "[ops-daily-check] error: build-memory-scope-contract-report failed"
  HAS_FAILURE="true"
fi
if ! make build-memory-quality-report; then
  echo "[ops-daily-check] error: build-memory-quality-report failed"
  HAS_FAILURE="true"
fi
if ! make build-memory-quality-trend-report; then
  echo "[ops-daily-check] error: build-memory-quality-trend-report failed"
  HAS_FAILURE="true"
fi
if ! make build-unified-observability-snapshot; then
  echo "[ops-daily-check] error: build-unified-observability-snapshot failed"
  HAS_FAILURE="true"
fi
if ! make build-knowledge-pipeline-snapshot; then
  echo "[ops-daily-check] error: build-knowledge-pipeline-snapshot failed"
  HAS_FAILURE="true"
fi
if ! make build-parity-scorecard; then
  echo "[ops-daily-check] error: build-parity-scorecard failed"
  HAS_FAILURE="true"
fi
if ! make build-parity-trend-report; then
  echo "[ops-daily-check] error: build-parity-trend-report failed"
  HAS_FAILURE="true"
fi
if [[ "$STRICT_RELIABILITY_E2E" == "true" ]]; then
  if ! make test-task-execution-reliability-e2e; then
    echo "[ops-daily-check] error: task execution reliability e2e strict check failed"
    HAS_FAILURE="true"
  fi
fi

if [[ "$ENABLE_WATCHER" == "true" ]]; then
  if [[ "$STRICT_WATCHER" == "true" ]]; then
    if ! make check-watcher-observability-strict; then
      echo "[ops-daily-check] error: watcher observability strict check failed"
      HAS_FAILURE="true"
    fi
  else
    if ! make check-watcher-observability; then
      echo "[ops-daily-check] warning: watcher observability check failed (non-strict)"
      # 非严格 watcher 检查仅告警，不阻断整体验收链路。
    fi
  fi
fi

echo
echo "[ops-daily-check] summary"
if ! python3 - <<'PY'
import json
from pathlib import Path

summary_path = Path("backend/data/release_gate_summary.json")
if not summary_path.exists():
    raise SystemExit("release_gate_summary.json 不存在")

data = json.loads(summary_path.read_text(encoding="utf-8"))
overall = str(data.get("overall_status") or "unknown")
gate = str(data.get("profile_gate_status") or "unknown")
rel = (data.get("evidence") or {}).get("reliability_slo") or {}
metrics = (rel.get("snapshot") or {}).get("metrics") or {}
exec_e2e = ((data.get("evidence") or {}).get("task_execution_reliability_e2e") or {}).get("status")
knowledge_path = Path("backend/data/knowledge_pipeline_snapshot.json")
knowledge = {}
if knowledge_path.exists():
    try:
        knowledge = json.loads(knowledge_path.read_text(encoding="utf-8"))
    except Exception:
        knowledge = {}

print(f"- overall_status: {overall}")
print(f"- profile_gate_status: {gate}")
if metrics:
    print(f"- blocked_recovery_rate: {metrics.get('blocked_recovery_rate')}")
    print(f"- success_rate: {metrics.get('success_rate')}")
    print(f"- task_count: {metrics.get('task_count')}")
print(f"- task_execution_reliability_e2e: {exec_e2e}")
if isinstance(knowledge, dict) and knowledge:
    ingest = knowledge.get("ingest") if isinstance(knowledge.get("ingest"), dict) else {}
    idx = knowledge.get("index") if isinstance(knowledge.get("index"), dict) else {}
    print(f"- knowledge_uploaded_last_24h: {ingest.get('uploaded_last_24h')}")
    print(f"- knowledge_index_batches_failed: {idx.get('batches_failed')}")

if gate != "pass":
    reasons = data.get("blocking_reasons") or []
    print("- blocking_reasons:")
    for r in reasons:
        print(f"  - {r}")
    raise SystemExit(1)
PY
then
  HAS_FAILURE="true"
fi

if [[ "$ENABLE_SNAPSHOT" == "true" ]]; then
  SNAPSHOT_DIR="backend/data/ops-daily"
  mkdir -p "$SNAPSHOT_DIR"
  STAMP="$(date -u +"%Y%m%dT%H%M%SZ")"

  if [[ -f backend/data/release_gate_summary.json ]]; then
    cp backend/data/release_gate_summary.json "$SNAPSHOT_DIR/release_gate_summary_${STAMP}.json"
  fi
  if [[ -f backend/data/unified_observability_snapshot.json ]]; then
    cp backend/data/unified_observability_snapshot.json "$SNAPSHOT_DIR/unified_observability_snapshot_${STAMP}.json"
  fi
  if [[ -f backend/data/knowledge_pipeline_snapshot.json ]]; then
    cp backend/data/knowledge_pipeline_snapshot.json "$SNAPSHOT_DIR/knowledge_pipeline_snapshot_${STAMP}.json"
  fi
  if [[ -f backend/data/memory_scope_contract_report.json ]]; then
    cp backend/data/memory_scope_contract_report.json "$SNAPSHOT_DIR/memory_scope_contract_report_${STAMP}.json"
  fi
  if [[ -f backend/data/memory_quality_report.json ]]; then
    cp backend/data/memory_quality_report.json "$SNAPSHOT_DIR/memory_quality_report_${STAMP}.json"
  fi
  if [[ -f backend/data/memory_quality_trend_report.json ]]; then
    cp backend/data/memory_quality_trend_report.json "$SNAPSHOT_DIR/memory_quality_trend_report_${STAMP}.json"
  fi
  if [[ -f backend/data/skills_semantic_consistency_report.json ]]; then
    cp backend/data/skills_semantic_consistency_report.json "$SNAPSHOT_DIR/skills_semantic_consistency_report_${STAMP}.json"
  fi
  if [[ -f backend/data/plugin_command_conflicts_report.json ]]; then
    cp backend/data/plugin_command_conflicts_report.json "$SNAPSHOT_DIR/plugin_command_conflicts_report_${STAMP}.json"
  fi
  if [[ -f backend/data/knowledge_source_compliance_report.json ]]; then
    cp backend/data/knowledge_source_compliance_report.json "$SNAPSHOT_DIR/knowledge_source_compliance_report_${STAMP}.json"
  fi
  if [[ -f backend/data/parity_scorecard.json ]]; then
    cp backend/data/parity_scorecard.json "$SNAPSHOT_DIR/parity_scorecard_${STAMP}.json"
  fi
  if [[ -f backend/data/parity_trend_report.json ]]; then
    cp backend/data/parity_trend_report.json "$SNAPSHOT_DIR/parity_trend_report_${STAMP}.json"
  fi
  if [[ -f backend/data/task_status_projection_evidence.json ]]; then
    cp backend/data/task_status_projection_evidence.json "$SNAPSHOT_DIR/task_status_projection_evidence_${STAMP}.json"
  fi
  if [[ -f backend/data/task_execution_reliability_e2e_report.json ]]; then
    cp backend/data/task_execution_reliability_e2e_report.json "$SNAPSHOT_DIR/task_execution_reliability_e2e_report_${STAMP}.json"
  fi
  if [[ -f backend/data/watcher_observability_snapshot.json ]]; then
    cp backend/data/watcher_observability_snapshot.json "$SNAPSHOT_DIR/watcher_observability_snapshot_${STAMP}.json"
  fi

  if ! python3 - "$STAMP" <<'PY'
import json
import sys
from pathlib import Path

stamp = sys.argv[1]
summary_path = Path("backend/data/release_gate_summary.json")
out_path = Path(f"backend/data/ops-daily/ops_daily_summary_{stamp}.md")
data = json.loads(summary_path.read_text(encoding="utf-8"))
evidence = data.get("evidence") or {}
slo = (evidence.get("reliability_slo") or {}).get("snapshot") or {}
metrics = slo.get("metrics") or {}
knowledge = {}
knowledge_path = Path("backend/data/knowledge_pipeline_snapshot.json")
if knowledge_path.exists():
    try:
        knowledge = json.loads(knowledge_path.read_text(encoding="utf-8"))
    except Exception:
        knowledge = {}

lines = [
    f"# Ops Daily Summary ({stamp})",
    "",
    f"- overall_status: `{data.get('overall_status')}`",
    f"- profile_gate_status: `{data.get('profile_gate_status')}`",
    f"- blocked_recovery_rate: `{metrics.get('blocked_recovery_rate')}`",
    f"- success_rate: `{metrics.get('success_rate')}`",
    f"- task_count: `{metrics.get('task_count')}`",
]
if isinstance(knowledge, dict) and knowledge:
    ingest = knowledge.get("ingest") if isinstance(knowledge.get("ingest"), dict) else {}
    idx = knowledge.get("index") if isinstance(knowledge.get("index"), dict) else {}
    ontology = knowledge.get("ontology") if isinstance(knowledge.get("ontology"), dict) else {}
    lines.extend(
        [
            "",
            "## Knowledge Pipeline",
            f"- uploaded_last_24h: `{ingest.get('uploaded_last_24h')}`",
            f"- index_batches_failed: `{idx.get('batches_failed')}`",
            f"- ontology_entities: `{ontology.get('entities')}`",
            f"- ontology_relations: `{ontology.get('relations')}`",
        ]
    )
reasons = data.get("blocking_reasons") or []
if reasons:
    lines.append("")
    lines.append("## Blocking Reasons")
    for r in reasons:
        lines.append(f"- `{r}`")

watcher_path = Path("backend/data/watcher_observability_snapshot.json")
if watcher_path.exists():
    try:
        watcher = json.loads(watcher_path.read_text(encoding="utf-8"))
    except Exception:
        watcher = {}
    w_metrics = watcher.get("metrics") if isinstance(watcher.get("metrics"), dict) else {}
    lines.append("")
    lines.append("## Watcher Observability")
    lines.append(f"- generated_at: `{watcher.get('generated_at')}`")
    lines.append(f"- search_calls: `{w_metrics.get('search_calls')}`")
    lines.append(f"- fallback_calls: `{w_metrics.get('fallback_calls')}`")
    lines.append(f"- fallback_ratio: `{w_metrics.get('fallback_ratio')}`")
    lines.append(f"- loop_errors: `{w_metrics.get('loop_errors')}`")
    # watcher 严格阈值（与 check-watcher-observability-strict 默认值对齐）
    min_search_calls = 1
    max_fallback_ratio = 0.30
    max_loop_errors = 0
    search_calls = int(w_metrics.get("search_calls", 0) or 0)
    fallback_ratio = float(w_metrics.get("fallback_ratio", 0) or 0.0)
    loop_errors = int(w_metrics.get("loop_errors", 0) or 0)
    strict_violations = []
    if search_calls < min_search_calls:
        strict_violations.append(f"search_calls<{min_search_calls}")
    if fallback_ratio > max_fallback_ratio:
        strict_violations.append(f"fallback_ratio>{max_fallback_ratio}")
    if loop_errors > max_loop_errors:
        strict_violations.append(f"loop_errors>{max_loop_errors}")
    if strict_violations:
        severity = "fail" if len(strict_violations) >= 2 or loop_errors > max_loop_errors else "warn"
        lines.append(f"- strict_threshold_status: `{severity}`")
        lines.append(f"- strict_threshold_violations: `{', '.join(strict_violations)}`")
    else:
        lines.append("- strict_threshold_status: `pass`")
        lines.append("- strict_threshold_violations: `none`")
else:
    lines.append("")
    lines.append("## Watcher Observability")
    lines.append("- watcher snapshot missing")

out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"[ops-daily-check] snapshot: {out_path.as_posix()}")
PY
  then
    HAS_FAILURE="true"
  fi
fi

if [[ "$HAS_FAILURE" == "true" ]]; then
  notify_webhook "failed" "daily check has failures, see logs"
  echo "[ops-daily-check] done (with failures)"
  exit 1
fi

notify_webhook "pass" "daily check completed"
echo "[ops-daily-check] done"
