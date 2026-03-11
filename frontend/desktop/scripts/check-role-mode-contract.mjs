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
    id: "backend_roles_api_contract",
    file: "backend/api/app.py",
    mustContain: [
      "\"preferred_fourth_mode\"",
      "\"debug\"",
      "\"review\"",
    ],
    message: "后端 roles API 必须输出 preferred_fourth_mode 契约字段",
  },
  {
    id: "frontend_role_type_contract",
    file: "frontend/desktop/src/lib/api/boardApi.ts",
    mustContain: [
      "preferred_fourth_mode?: \"debug\" | \"review\" | null;",
    ],
    message: "前端 RoleDefinition 必须声明 preferred_fourth_mode 类型",
  },
  {
    id: "frontend_mode_resolution_contract",
    file: "frontend/desktop/src/components/ChatComponents/cursor-style-composer.tsx",
    mustContain: [
      "normalizeRoleModes(modes?: string[], roleId?: string, preferredFourthMode?: string | null)",
      "activeRole?.preferred_fourth_mode",
      "r.preferred_fourth_mode",
    ],
    message: "前端模式归一化必须优先使用后端 preferred_fourth_mode",
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
    console.log("[check:role-mode-contract] OK: 第四模式前后端契约已闭环。");
    process.exit(0);
  }

  console.error(`[check:role-mode-contract] FAIL: ${failed.length} 项未通过`);
  for (const f of failed) {
    console.error(`- ${f.id}: ${f.message}`);
    console.error(`  file: ${f.file}`);
    console.error(`::error file=${f.file},title=Role mode contract check failed::${f.message}`);
  }
  process.exit(1);
}

run();
