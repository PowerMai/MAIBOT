#!/usr/bin/env node
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, "src");

const EVENT_LITERALS = [
  "composer_prefs_changed",
  "role_changed",
  "chat_mode_changed",
  "skill_profile_changed",
  "license_tier_changed",
  "task_progress",
  "switch_left_panel",
];

const ALLOW_FILE_SUFFIXES = [".ts", ".tsx", ".js", ".jsx"];
const IGNORE_FILES = new Set([
  "src/lib/constants.ts",
]);

// 协议层类型联合中保留字面量是合理的，这里按行白名单。
const ALLOW_LINE_PATTERNS = [
  {
    file: "src/lib/events/toolStreamEvents.ts",
    pattern: /'\s*task_progress\s*'/,
  },
];

function walk(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, out);
    } else if (ALLOW_FILE_SUFFIXES.some((ext) => e.name.endsWith(ext))) {
      out.push(full);
    }
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

function isAllowed(fileRel, lineText) {
  return ALLOW_LINE_PATTERNS.some((rule) => rule.file === fileRel && rule.pattern.test(lineText));
}

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error("[check:events] src 目录不存在:", SRC_DIR);
    process.exit(2);
  }

  const files = walk(SRC_DIR);
  const issues = [];

  for (const file of files) {
    const rel = toRel(file);
    if (IGNORE_FILES.has(rel)) continue;

    const content = fs.readFileSync(file, "utf8");
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentLike(line)) continue;
      if (isAllowed(rel, line)) continue;

      for (const eventName of EVENT_LITERALS) {
        const single = `'${eventName}'`;
        const double = `"${eventName}"`;
        if (line.includes(single) || line.includes(double)) {
          issues.push({
            file: rel,
            line: i + 1,
            eventName,
            text: line.trim().slice(0, 180),
          });
        }
      }
    }
  }

  if (!issues.length) {
    console.log("[check:events] OK: 未发现事件硬编码。");
    process.exit(0);
  }

  const grouped = new Map();
  for (const it of issues) {
    if (!grouped.has(it.file)) grouped.set(it.file, []);
    grouped.get(it.file).push(it);
  }

  console.error(`[check:events] FAIL: 发现 ${issues.length} 处事件硬编码（${grouped.size} 个文件）`);
  for (const [file, list] of grouped.entries()) {
    console.error(`\n[file] ${file} (${list.length})`);
    for (const it of list) {
      console.error(`- L${it.line} -> ${it.eventName}`);
      console.error(`  ${it.text}`);
      // GitHub Actions annotation (in CI UI)
      console.error(`::error file=${it.file},line=${it.line},title=Event literal violation::Use EVENTS constant instead of '${it.eventName}'`);
    }
  }
  process.exit(1);
}

main();
