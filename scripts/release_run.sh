#!/bin/bash
set -euo pipefail

# release-readiness 触发脚本（GitHub Actions）
#
# 用法：
#   ./scripts/release_run.sh staging
#   ./scripts/release_run.sh production
#   ./scripts/release_run.sh production --dry-run
#
# 说明：
# - workflow 文件名固定为 ci.yml
# - strict 门禁由 workflow 固定执行，不支持命令行覆盖

SUMMARY_PATH="backend/data/release_gate_summary.json"
DRILL_REPORT_PATH="docs/release_drill_report_$(date +%Y-%m-%d).md"
TIGHTEN_GUARD_PATH="backend/data/slo_tightening_guard_report.json"
POSTCHECK_REPORT_PATH="backend/data/release_postcheck_report.json"
TASK_EXEC_RELIABILITY_E2E_REPORT_PATH="backend/data/task_execution_reliability_e2e_report.json"
ARTIFACT_DIR="tmp/release-readiness-artifacts/latest"

PROFILE="${1:-staging}"
if [[ "$PROFILE" != "staging" && "$PROFILE" != "production" ]]; then
  echo "错误: release_profile 仅支持 staging 或 production"
  echo "示例: ./scripts/release_run.sh staging"
  exit 1
fi

shift || true

DRY_RUN="false"

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN="true"
      ;;
    *)
      echo "错误: 不支持参数 $arg"
      echo "可选参数:"
      echo "  --dry-run"
      exit 1
      ;;
  esac
done

CMD=(gh workflow run ci.yml -f "release_profile=$PROFILE")

echo "即将触发 release-readiness:"
echo "  release_profile=$PROFILE"
echo "  strict gates=fixed by workflow"
echo "  dry_run=$DRY_RUN"
echo "  expected summary=$SUMMARY_PATH"
echo "  expected drill_report=$DRILL_REPORT_PATH"
echo "  expected tightening_guard=$TIGHTEN_GUARD_PATH"
echo "  expected postcheck=$POSTCHECK_REPORT_PATH"
echo "  expected task_exec_reliability_e2e=$TASK_EXEC_RELIABILITY_E2E_REPORT_PATH"
echo "  expected artifact_dir=$ARTIFACT_DIR"
echo

if [[ "$DRY_RUN" == "true" ]]; then
  printf 'DRY RUN: '
  printf '%q ' "${CMD[@]}"
  echo
  echo
  echo "建议触发后核对："
  echo "  1) make release-postcheck"
  echo "  2) jq '.overall_status,.profile_gate_status' \"$SUMMARY_PATH\""
  echo "  3) rg 'slo_tightening_guard|profile_gate_status' \"$DRILL_REPORT_PATH\""
  echo "  4) jq '.status,.failures' \"$TIGHTEN_GUARD_PATH\""
  echo "  5) jq '.evidence.task_execution_reliability_e2e.status' \"$SUMMARY_PATH\""
  echo "  6) gh run download <run_id> -n release-readiness-artifacts -D \"$ARTIFACT_DIR\""
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "错误: 未检测到 gh，请先安装 GitHub CLI"
  exit 1
fi

"${CMD[@]}"
echo "已触发。可用以下命令查看运行："
echo "  gh run list --workflow ci.yml --limit 5"
echo "运行完成后建议检查："
echo "  make release-postcheck"
echo "  jq '.overall_status,.profile_gate_status' \"$SUMMARY_PATH\""
echo "  rg 'slo_tightening_guard|profile_gate_status' \"$DRILL_REPORT_PATH\""
echo "  jq '.evidence.task_execution_reliability_e2e.status' \"$SUMMARY_PATH\""
echo
echo "开始执行本地快照后置核查（不阻断触发结果）..."
set +e
make release-postcheck
POSTCHECK_EXIT=$?
set -e
if [[ $POSTCHECK_EXIT -ne 0 ]]; then
  echo "提示: release-postcheck 返回非 0（可能是本地工件仍是上一轮结果或存在失败项）。"
fi
echo "后置核查报告: $POSTCHECK_REPORT_PATH"

echo
echo "尝试等待远端 run 完成并下载 artifacts（若失败仅告警）..."
set +e
RUN_ID="$(gh run list --workflow ci.yml --limit 20 --json databaseId,event,status,createdAt --jq 'map(select(.event=="workflow_dispatch")) | sort_by(.createdAt) | reverse | .[0].databaseId')"
if [[ -n "${RUN_ID:-}" && "$RUN_ID" != "null" ]]; then
  echo "检测到 run_id=$RUN_ID，等待完成..."
  gh run watch "$RUN_ID" --exit-status
  WATCH_EXIT=$?
  mkdir -p "$ARTIFACT_DIR"
  gh run download "$RUN_ID" -n release-readiness-artifacts -D "$ARTIFACT_DIR"
  DL_EXIT=$?
  if [[ $WATCH_EXIT -eq 0 && $DL_EXIT -eq 0 ]]; then
    echo "已下载远端 artifacts: $ARTIFACT_DIR"
    if [[ -x backend/.venv/bin/python ]]; then
      backend/.venv/bin/python backend/scripts/release_postcheck.py \
        --summary-json "$ARTIFACT_DIR/release_gate_summary.json" \
        --tightening-guard-json "$ARTIFACT_DIR/slo_tightening_guard_report.json" \
        --output-json backend/data/release_postcheck_remote_report.json
    else
      python3 backend/scripts/release_postcheck.py \
        --summary-json "$ARTIFACT_DIR/release_gate_summary.json" \
        --tightening-guard-json "$ARTIFACT_DIR/slo_tightening_guard_report.json" \
        --output-json backend/data/release_postcheck_remote_report.json
    fi
    echo "远端后置核查报告: backend/data/release_postcheck_remote_report.json"
  else
    echo "告警: run 结束状态或 artifacts 下载失败（watch_exit=$WATCH_EXIT download_exit=$DL_EXIT）"
  fi
else
  echo "告警: 未能解析最新 workflow_dispatch run_id，跳过远端 artifacts 核查。"
fi
set -e
