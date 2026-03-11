#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const THIS_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(THIS_FILE);
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");

function read(relPath) {
  const abs = path.join(PROJECT_ROOT, relPath);
  if (!fs.existsSync(abs)) throw new Error(`missing file: ${relPath}`);
  return fs.readFileSync(abs, "utf8");
}

function containsAll(content, needles) {
  return needles.every((n) => content.includes(n));
}

const checks = [
  {
    id: "shared-entry-resolver-exists",
    file: "frontend/desktop/src/lib/taskDispatchStage.ts",
    mustContain: [
      "export function resolveTaskPrimaryEntryAction(task: BoardTask)",
      "kind: \"open_thread\" | \"open_task_detail\"",
      "awaiting_plan_confirm",
      "waiting_human",
      "failed",
    ],
    message: "缺少统一任务主入口判定函数",
  },
  {
    id: "dashboard-uses-shared-entry-resolver",
    file: "frontend/desktop/src/components/WorkspaceDashboard.tsx",
    mustContain: [
      "resolveTaskPrimaryEntryAction",
      "const primaryEntry = resolveTaskPrimaryEntryAction(task);",
      "primaryEntry.kind === \"open_thread\"",
      "EVENTS.SWITCH_TO_THREAD",
      "EVENTS.OPEN_TASK_IN_EDITOR",
    ],
    message: "Dashboard 未使用统一任务主入口判定",
  },
  {
    id: "task-detail-uses-shared-entry-resolver",
    file: "frontend/desktop/src/components/TaskDetailView.tsx",
    mustContain: [
      "resolveTaskPrimaryEntryAction",
      "const primaryEntry = resolveTaskPrimaryEntryAction(task);",
      "推荐入口：",
      "primaryEntry.kind === \"open_thread\"",
    ],
    message: "TaskDetail 未使用统一任务主入口判定",
  },
];

function run() {
  const failed = [];
  for (const c of checks) {
    try {
      const content = read(c.file);
      if (!containsAll(content, c.mustContain)) failed.push(c);
    } catch {
      failed.push(c);
    }
  }

  if (!failed.length) {
    console.log("[check:task-entry] OK: 任务主入口判定在多视图保持一致。");
    process.exit(0);
  }

  console.error(`[check:task-entry] FAIL: ${failed.length} 项未通过`);
  for (const f of failed) {
    console.error(`- ${f.id}: ${f.message}`);
    console.error(`  file: ${f.file}`);
    console.error(`::error file=${f.file},title=Task entry consistency check failed::${f.message}`);
  }
  process.exit(1);
}

run();
