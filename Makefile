PYTHON_BACKEND ?= $(shell [ -x backend/.venv/bin/python ] && echo backend/.venv/bin/python || echo python3)
REGRESSION_SCRIPT := backend/scripts/test_system_improvements.py
RELEASE_GATE_SCRIPT := backend/scripts/release_gate.py
BACKEND_CORE_TESTS := backend/tests/test_task_watcher_schedule.py backend/tests/test_scheduling_guard_middleware.py backend/tests/test_model_manager_auto.py backend/tests/test_main_graph_metrics_helpers.py backend/tests/test_task_bidding_status_projection.py backend/tests/test_task_status_single_source_enforcement.py backend/tests/test_plan_confirmation_routing.py backend/tests/test_accept_bid_concurrency.py backend/tests/test_plugin_manifest_schema.py
SINGLE_AGENT_API_ACCEPTANCE := backend/scripts/test_single_agent_api_acceptance.py
FRONTEND_BACKEND_INTEGRATION := backend/scripts/test_frontend_backend_integration.py
E2E_SMOKE := backend/scripts/e2e_smoke.py
TASK_STATUS_PROJECTION_E2E := backend/scripts/test_task_status_projection_e2e.py
TASK_STATUS_PROJECTION_GUARD_OFF_E2E := backend/scripts/test_task_status_projection_guard_off_e2e.py
TASK_EXECUTION_RELIABILITY_E2E := backend/scripts/test_task_execution_reliability_e2e.py
TASK_STATUS_PROJECTION_EVIDENCE := backend/scripts/collect_task_status_projection_evidence.py
TASK_STATUS_SINGLE_SOURCE_TEST := backend/tests/test_task_status_single_source_enforcement.py
BOARD_CONTRACT_CHECK := backend/scripts/check_board_contracts.py
RELIABILITY_SLO_CHECK := backend/scripts/check_reliability_slo.py
PLUGINS_COMPAT_SMOKE := backend/scripts/plugins_compat_smoke.py
PLUGIN_COMMAND_CONFLICT_GATE := backend/scripts/check_plugin_command_conflicts.py
PLUGIN_RUNTIME_COMPAT_SMOKE := backend/scripts/plugin_runtime_compat_smoke.py
SKILLS_COMPAT_SMOKE := backend/scripts/skills_compat_smoke.py
SKILLS_SEMANTIC_GATE := backend/scripts/skills_semantic_consistency_gate.py
KNOWLEDGE_SOURCE_COMPLIANCE_GATE := backend/scripts/check_knowledge_source_compliance.py
LEGACY_TERMS_SCAN := backend/scripts/scan_legacy_bidding_terms.py
TASK_STATUS_WIRING_CHECK := backend/scripts/check_task_status_wiring.py
RELEASE_GATE_SUMMARY := backend/scripts/build_release_gate_summary.py
RELEASE_DRILL_REPORT := backend/scripts/build_release_drill_report.py
RELEASE_DRILL_SCRIPT := backend/scripts/release_drill.py
RELEASE_POSTCHECK_SCRIPT := backend/scripts/release_postcheck.py
DISTILLATION_EXPORT := backend/scripts/export_distillation_samples.py
DISTILLATION_EVAL := backend/scripts/evaluate_distillation_loop.py
RELEASE_SIGNOFF_CHECK := backend/scripts/check_release_signoff.py
UNIFIED_OBSERVABILITY_SNAPSHOT := backend/scripts/build_unified_observability_snapshot.py
POLICY_DECISION_REPORT := backend/scripts/build_policy_decision_report.py
KNOWLEDGE_PIPELINE_SNAPSHOT := backend/scripts/build_knowledge_pipeline_snapshot.py
PARITY_SCORECARD := backend/scripts/build_parity_scorecard.py
PARITY_TREND_REPORT := backend/scripts/build_parity_trend_report.py
MEMORY_SCOPE_CONTRACT_REPORT := backend/scripts/build_memory_scope_contract_report.py
MEMORY_QUALITY_REPORT := backend/scripts/build_memory_quality_report.py
MEMORY_QUALITY_TREND_REPORT := backend/scripts/build_memory_quality_trend_report.py
SLO_TIGHTENING_GUARD := backend/scripts/check_slo_tightening_guard.py
SLO_TIGHTENING_GUARD_REPORT := backend/data/slo_tightening_guard_report.json
OPS_DAILY_CHECK_SCRIPT := scripts/ops_daily_check.sh
WATCHER_OBSERVABILITY_CHECK_SCRIPT := scripts/watcher_observability_check.sh

.PHONY: check-session-state check-task-status-wiring test-frontend-backend-integration e2e-smoke check-task-status-single-source-strict collect-task-status-projection-evidence test-quick test-full gate-release release-check release-readiness-strict release-drill release-postcheck test-backend-core-regression test-single-agent-api test-task-status-projection test-task-status-projection-guard-off test-task-execution-reliability-e2e check-board-contract check-reliability-slo check-reliability-slo-strict check-slo-tightening-ready plugins-compat-smoke plugin-command-conflict-gate plugin-runtime-compat-smoke skills-compat-smoke skills-semantic-gate knowledge-source-compliance-gate scan-legacy-terms scan-legacy-terms-strict build-release-gate-summary build-release-drill-report build-policy-decision-report build-unified-observability-snapshot build-knowledge-pipeline-snapshot build-parity-scorecard build-parity-trend-report build-memory-scope-contract-report build-memory-quality-report build-memory-quality-trend-report export-distillation-samples evaluate-distillation-loop check-release-signoff ops-daily-check ops-daily-check-watcher ops-daily-check-strict-watcher ops-daily-check-strict-reliability-e2e ops-daily-check-release-window check-watcher-observability check-watcher-observability-strict check-watcher-observability-strict-seeded

check-session-state:
	pnpm --dir frontend/desktop check:session-state

check-task-status-wiring:
	$(PYTHON_BACKEND) $(TASK_STATUS_WIRING_CHECK)

check-task-status-single-source-strict:
	$(PYTHON_BACKEND) -m pytest $(TASK_STATUS_SINGLE_SOURCE_TEST) -q

collect-task-status-projection-evidence:
	$(PYTHON_BACKEND) $(TASK_STATUS_PROJECTION_EVIDENCE)

test-quick:
	$(PYTHON_BACKEND) $(REGRESSION_SCRIPT) --mode quick

test-full:
	$(PYTHON_BACKEND) $(REGRESSION_SCRIPT) --mode full

test-backend-core-regression:
	$(PYTHON_BACKEND) -m pytest $(BACKEND_CORE_TESTS) -q

test-single-agent-api:
	$(PYTHON_BACKEND) $(SINGLE_AGENT_API_ACCEPTANCE)

test-frontend-backend-integration:
	$(PYTHON_BACKEND) $(FRONTEND_BACKEND_INTEGRATION)

# E2E 烟雾：需先启动后端 (./scripts/start.sh dev)，再执行。可选 --require-cloud35 校验云 35B
e2e-smoke:
	$(PYTHON_BACKEND) $(E2E_SMOKE)

test-task-status-projection:
	$(PYTHON_BACKEND) $(TASK_STATUS_PROJECTION_E2E)

test-task-status-projection-guard-off:
	$(PYTHON_BACKEND) $(TASK_STATUS_PROJECTION_GUARD_OFF_E2E)

test-task-execution-reliability-e2e:
	$(PYTHON_BACKEND) $(TASK_EXECUTION_RELIABILITY_E2E)

check-board-contract:
	$(PYTHON_BACKEND) $(BOARD_CONTRACT_CHECK)

check-reliability-slo:
	$(PYTHON_BACKEND) $(RELIABILITY_SLO_CHECK)

check-reliability-slo-strict:
	$(PYTHON_BACKEND) $(RELIABILITY_SLO_CHECK) --env production --strict

check-slo-tightening-ready:
	$(PYTHON_BACKEND) $(SLO_TIGHTENING_GUARD) --env production --metric min_blocked_recovery_rate --target 0.30 --required-pass-runs 3 --report-json $(SLO_TIGHTENING_GUARD_REPORT)

plugins-compat-smoke:
	$(PYTHON_BACKEND) $(PLUGINS_COMPAT_SMOKE)

plugin-command-conflict-gate:
	$(PYTHON_BACKEND) $(PLUGIN_COMMAND_CONFLICT_GATE)

plugin-runtime-compat-smoke:
	$(PYTHON_BACKEND) $(PLUGIN_RUNTIME_COMPAT_SMOKE)

skills-compat-smoke:
	$(PYTHON_BACKEND) $(SKILLS_COMPAT_SMOKE)

skills-semantic-gate:
	$(PYTHON_BACKEND) $(SKILLS_SEMANTIC_GATE)

knowledge-source-compliance-gate:
	$(PYTHON_BACKEND) $(KNOWLEDGE_SOURCE_COMPLIANCE_GATE)

scan-legacy-terms:
	$(PYTHON_BACKEND) $(LEGACY_TERMS_SCAN)

scan-legacy-terms-strict:
	$(PYTHON_BACKEND) $(LEGACY_TERMS_SCAN) --strict

build-release-gate-summary: collect-task-status-projection-evidence
	$(PYTHON_BACKEND) $(RELEASE_GATE_SUMMARY) --release-profile production --projection-evidence-report backend/data/task_status_projection_evidence.json --strict-required

build-release-drill-report:
	$(PYTHON_BACKEND) $(RELEASE_DRILL_REPORT) --release-profile production

build-policy-decision-report:
	PYTHONPATH=. $(PYTHON_BACKEND) $(POLICY_DECISION_REPORT)

build-unified-observability-snapshot: build-policy-decision-report
	$(PYTHON_BACKEND) $(UNIFIED_OBSERVABILITY_SNAPSHOT)

build-knowledge-pipeline-snapshot:
	$(PYTHON_BACKEND) $(KNOWLEDGE_PIPELINE_SNAPSHOT)

build-parity-scorecard:
	$(PYTHON_BACKEND) $(PARITY_SCORECARD)

build-parity-trend-report:
	$(PYTHON_BACKEND) $(PARITY_TREND_REPORT)

build-memory-scope-contract-report:
	$(PYTHON_BACKEND) $(MEMORY_SCOPE_CONTRACT_REPORT)

build-memory-quality-report:
	$(PYTHON_BACKEND) $(MEMORY_QUALITY_REPORT)

build-memory-quality-trend-report:
	$(PYTHON_BACKEND) $(MEMORY_QUALITY_TREND_REPORT)

export-distillation-samples:
	$(PYTHON_BACKEND) $(DISTILLATION_EXPORT)

evaluate-distillation-loop:
	$(PYTHON_BACKEND) $(DISTILLATION_EVAL)

check-release-signoff:
	$(PYTHON_BACKEND) $(RELEASE_SIGNOFF_CHECK) --strict

gate-release:
	$(PYTHON_BACKEND) $(RELEASE_GATE_SCRIPT) --report backend/data/regression_report.json --min-pass-rate 1.0 --max-failed-items 0 --allow-status pass

release-check: check-session-state check-task-status-wiring check-task-status-single-source-strict test-full gate-release

release-readiness-strict: check-session-state test-full test-backend-core-regression test-single-agent-api test-task-status-projection test-task-execution-reliability-e2e check-task-status-single-source-strict check-task-status-wiring collect-task-status-projection-evidence check-board-contract plugins-compat-smoke plugin-command-conflict-gate plugin-runtime-compat-smoke skills-compat-smoke skills-semantic-gate check-reliability-slo-strict check-watcher-observability-strict scan-legacy-terms-strict check-release-signoff build-release-gate-summary gate-release

release-drill:
	$(PYTHON_BACKEND) $(RELEASE_DRILL_SCRIPT) --release-profile production --strict-required

release-postcheck:
	$(PYTHON_BACKEND) $(RELEASE_POSTCHECK_SCRIPT)

ops-daily-check:
	bash $(OPS_DAILY_CHECK_SCRIPT)

ops-daily-check-watcher:
	bash $(OPS_DAILY_CHECK_SCRIPT) --watcher

ops-daily-check-strict-watcher:
	bash $(OPS_DAILY_CHECK_SCRIPT) --strict-watcher

ops-daily-check-strict-reliability-e2e:
	bash $(OPS_DAILY_CHECK_SCRIPT) --strict-reliability-e2e

ops-daily-check-release-window:
	bash $(OPS_DAILY_CHECK_SCRIPT) --snapshot --strict-watcher --strict-reliability-e2e

check-watcher-observability:
	bash $(WATCHER_OBSERVABILITY_CHECK_SCRIPT)

check-watcher-observability-strict:
	bash $(WATCHER_OBSERVABILITY_CHECK_SCRIPT) --strict --window-seconds 60

check-watcher-observability-strict-seeded:
	bash $(WATCHER_OBSERVABILITY_CHECK_SCRIPT) --strict --window-seconds 120 --seed-tasks 1 --seed-scope personal

# 从 pyproject.toml 重新生成 backend/requirements.txt（需安装 uv）
backend-requirements:
	cd backend && uv export --no-dev -o requirements.txt
