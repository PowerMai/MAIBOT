#!/usr/bin/env node
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, "src");
const ALLOW_FILE_SUFFIXES = [".ts", ".tsx", ".js", ".jsx"];

const RULES = [
  {
    name: "thread_id_storage_write",
    allowFiles: new Set(["src/lib/sessionState.ts"]),
    patterns: [
      /setStorageItem\(\s*["'`]maibot_current_thread_id["'`]/,
      /setStorageItem\(\s*["'`]maibot_active_thread["'`]/,
      /setItem\(\s*["'`]maibot_current_thread_id["'`]/,
      /setItem\(\s*["'`]maibot_active_thread["'`]/,
      /localStorage\.setItem\(\s*["'`]maibot_current_thread_id["'`]/,
      /localStorage\.setItem\(\s*["'`]maibot_active_thread["'`]/,
    ],
    message: "Thread ID storage writes must go through sessionState.ts",
  },
  {
    name: "chat_mode_storage_write",
    // chatModeState.ts：正常写入；sessionState.ts：仅 applyCrossWindowSessionEvent(CHAT_MODE_CHANGED) 时写入
    allowFiles: new Set(["src/lib/chatModeState.ts", "src/lib/sessionState.ts"]),
    patterns: [
      /setStorageItem\(\s*["'`]maibot_chat_mode["'`]/,
      /setItem\(\s*["'`]maibot_chat_mode["'`]/,
      /localStorage\.setItem\(\s*["'`]maibot_chat_mode["'`]/,
      /setStorageItem\(\s*`maibot_chat_mode_thread_\$\{[^}]+\}`/,
      /setItem\(\s*`maibot_chat_mode_thread_\$\{[^}]+\}`/,
      /localStorage\.setItem\(\s*`maibot_chat_mode_thread_\$\{[^}]+\}`/,
    ],
    message: "Chat mode writes must go through chatModeState.ts",
  },
  {
    name: "session_plugin_storage_write",
    allowFiles: new Set(["src/components/ChatComponents/cursor-style-composer.tsx"]),
    patterns: [
      /setStorageItem\(\s*`maibot_session_plugins_thread_\$\{[^}]+\}`/,
      /setItem\(\s*`maibot_session_plugins_thread_\$\{[^}]+\}`/,
      /localStorage\.setItem\(\s*`maibot_session_plugins_thread_\$\{[^}]+\}`/,
      /setStorageItem\(\s*getThreadSessionPluginsStorageKey\(/,
      /setItem\(\s*getThreadSessionPluginsStorageKey\(/,
      /localStorage\.setItem\(\s*getThreadSessionPluginsStorageKey\(/,
    ],
    message: "Session plugin writes must go through cursor-style-composer.tsx",
  },
];

function walk(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (ALLOW_FILE_SUFFIXES.some((ext) => e.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function toRel(file) {
  return path.relative(ROOT, file).replace(/\\/g, "/");
}

function isCommentLike(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("*/");
}

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error("[check:session-state] src 目录不存在:", SRC_DIR);
    process.exit(2);
  }

  const files = walk(SRC_DIR);
  const issues = [];

  for (const file of files) {
    const rel = toRel(file);
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentLike(line)) continue;
      for (const rule of RULES) {
        if (rule.allowFiles.has(rel)) continue;
        for (const re of rule.patterns) {
          if (re.test(line)) {
            issues.push({
              file: rel,
              line: i + 1,
              rule: rule.name,
              message: rule.message,
              text: line.trim().slice(0, 200),
            });
          }
        }
      }
    }
  }

  if (!issues.length) {
    console.log("[check:session-state] OK: 会话/模式写入已收敛。");
    process.exit(0);
  }

  console.error(`[check:session-state] FAIL: 发现 ${issues.length} 处违规写入`);
  for (const it of issues) {
    console.error(`- ${it.file}:L${it.line} [${it.rule}]`);
    console.error(`  ${it.text}`);
    console.error(`::error file=${it.file},line=${it.line},title=Session state wiring violation::${it.message}`);
  }
  process.exit(1);
}

main();
