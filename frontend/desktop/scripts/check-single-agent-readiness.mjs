#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const THIS_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(THIS_FILE);
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");

function read(relPath) {
  const abs = path.join(PROJECT_ROOT, relPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`missing file: ${relPath}`);
  }
  return fs.readFileSync(abs, "utf8");
}

function containsAll(content, needles) {
  return needles.every((n) => content.includes(n));
}

const checks = [
  {
    id: "plan_graph_interrupt",
    file: "backend/engine/core/main_graph.py",
    mustContain: [
      '"type": "plan_confirmation"',
      "sync_board_task_by_thread_id(thread_id, \"awaiting_plan_confirm\"",
      "Plan 阶段完成后图级中断",
    ],
    message: "Plan 模式应使用图级 interrupt + awaiting_plan_confirm 状态",
  },
  {
    id: "langserve_interrupt_types",
    file: "frontend/desktop/src/lib/api/langserveChat.ts",
    mustContain: [
      "interruptType === 'plan_confirmation'",
      "normalized === 'delegate'",
      "normalized === 'skip'",
    ],
    message: "前端中断 API 需支持 plan_confirmation / delegate / skip",
  },
  {
    id: "interrupt_dialog_actions",
    file: "frontend/desktop/src/components/ChatComponents/InterruptDialog.tsx",
    mustContain: [
      "plan_confirmation",
      "handleDelegate",
      "handleSkip",
      "确认执行",
    ],
    message: "InterruptDialog 需支持计划确认与扩展决策",
  },
  {
    id: "board_tools_governance",
    file: "backend/tools/base/task_board_tools.py",
    mustContain: [
      "def report_blocked(",
      "def report_artifacts(",
      "\"awaiting_plan_confirm\"",
      "\"blocked\"",
    ],
    message: "看板工具需具备阻塞/成果物治理能力",
  },
  {
    id: "board_api_endpoints",
    file: "backend/api/app.py",
    mustContain: [
      "@app.post(\"/board/tasks/{task_id}/blocked\")",
      "@app.post(\"/board/tasks/{task_id}/artifacts\")",
      "@app.get(\"/board/metrics/reliability\")",
      "\"awaiting_plan_confirm\"",
      "\"blocked\"",
    ],
    message: "后端需暴露 blocked/artifacts/metrics 端点并支持新状态",
  },
  {
    id: "watcher_dispatch_guard",
    file: "backend/engine/tasks/task_watcher.py",
    mustContain: [
      "dispatch_awaiting_plan_confirm",
      "dispatch_blocked",
      'if status in {"running", "completed", "failed", "cancelled", "paused", "waiting_human", "awaiting_plan_confirm", "blocked"}',
    ],
    message: "调度器需跳过 awaiting_plan_confirm / blocked",
  },
  {
    id: "dispatch_stage_ui",
    file: "frontend/desktop/src/lib/taskDispatchStage.ts",
    mustContain: [
      "\"awaiting_plan_confirm\"",
      "\"blocked\"",
      "等待计划确认",
      "任务阻塞",
    ],
    message: "任务状态与分发阶段 UI 需支持新状态",
  },
  {
    id: "task_detail_artifacts_blocked",
    file: "frontend/desktop/src/components/TaskDetailView.tsx",
    mustContain: [
      "task.blocked_reason",
      "task.missing_information",
      "task.changed_files",
      "task.rollback_hint",
      "\"delegate\"",
      "\"skip\"",
    ],
    message: "任务详情需展示阻塞/变更文件/回滚建议并支持扩展审核动作",
  },
];

function run() {
  const failed = [];
  for (const c of checks) {
    try {
      const content = read(c.file);
      const ok = containsAll(content, c.mustContain);
      if (!ok) {
        failed.push(c);
      }
    } catch (e) {
      failed.push(c);
    }
  }

  if (failed.length === 0) {
    console.log("[check:single-agent] OK: 单体 Agent 关键链路已就绪。");
    process.exit(0);
  }

  console.error(`[check:single-agent] FAIL: ${failed.length} 项未通过`);
  for (const f of failed) {
    console.error(`- ${f.id}: ${f.message}`);
    console.error(`  file: ${f.file}`);
    console.error(`::error file=${f.file},title=Single agent readiness check failed::${f.message}`);
  }
  process.exit(1);
}

run();

