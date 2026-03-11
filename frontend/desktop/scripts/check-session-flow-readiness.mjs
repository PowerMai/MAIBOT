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
    id: "session_plugin_thread_scoped_key",
    file: "frontend/desktop/src/components/ChatComponents/cursor-style-composer.tsx",
    mustContain: [
      "THREAD_SESSION_PLUGINS_KEY_PREFIX = \"maibot_session_plugins_thread_\"",
      "getThreadSessionPluginsStorageKey(",
      "setStorageItem(storageKey, JSON.stringify(next));",
    ],
    message: "会话插件开关必须使用线程级 key 存储",
  },
  {
    id: "plan_confirm_switch_config",
    file: "frontend/desktop/src/components/SettingsView.tsx",
    mustContain: [
      "maibot_plan_confirm_switch_to_agent",
      "planConfirmSwitchToAgent",
    ],
    message: "设置页必须暴露 Plan 确认后是否切回 Agent 的开关",
  },
  {
    id: "plan_confirm_emit_thread_scoped",
    file: "frontend/desktop/src/components/ChatComponents/tool-fallback.tsx",
    mustContain: [
      "maibot_plan_confirmed_thread_",
      "EVENTS.PLAN_CONFIRMED",
      "shouldSwitchToAgent",
    ],
    message: "Plan 确认事件必须携带线程级标记与流转开关",
  },
  {
    id: "plan_confirm_consume_flow",
    file: "frontend/desktop/src/components/ChatComponents/thread.tsx",
    mustContain: [
      "handlePlanConfirmed",
      "maibot_plan_confirmed_thread_",
      "if (shouldSwitchToAgent)",
    ],
    message: "Thread 层必须消费 Plan 确认事件并按开关决定模式流转",
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
    console.log("[check:session-flow] OK: 会话插件隔离与 Plan 确认流转链路已就绪。");
    process.exit(0);
  }

  console.error(`[check:session-flow] FAIL: ${failed.length} 项未通过`);
  for (const f of failed) {
    console.error(`- ${f.id}: ${f.message}`);
    console.error(`  file: ${f.file}`);
    console.error(`::error file=${f.file},title=Session flow readiness check failed::${f.message}`);
  }
  process.exit(1);
}

run();
