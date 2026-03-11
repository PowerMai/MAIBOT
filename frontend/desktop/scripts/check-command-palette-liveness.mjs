#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const THIS_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(THIS_FILE);
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");

const COMMAND_PALETTE = "frontend/desktop/src/components/CommandPalette.tsx";
const APP = "frontend/desktop/src/App.tsx";
const EDITOR = "frontend/desktop/src/components/FullEditorV2Enhanced.tsx";

function read(relPath) {
  const abs = path.join(PROJECT_ROOT, relPath);
  if (!fs.existsSync(abs)) throw new Error(`missing file: ${relPath}`);
  return fs.readFileSync(abs, "utf8");
}

function extractAll(re, text) {
  const set = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) set.add(m[1]);
  }
  return set;
}

/** 从 COMMAND_STATIC_DISABLED_REASON 对象中提取禁用命令 ID 列表，避免宽泛 regex 误判 */
function extractStaticDisabledIds(text) {
  const set = new Set();
  const marker = "COMMAND_STATIC_DISABLED_REASON";
  const idx = text.indexOf(marker);
  if (idx === -1) return set;
  const blockStart = text.indexOf("{", idx);
  if (blockStart === -1) return set;
  const blockEnd = text.indexOf("};", blockStart);
  if (blockEnd === -1) return set;
  const block = text.slice(blockStart, blockEnd);
  const keyRe = /'([^']+)':\s*'[^']*'/g;
  let m;
  while ((m = keyRe.exec(block)) !== null) {
    if (m[1]) set.add(m[1]);
  }
  return set;
}

function fail(msg) {
  console.error(`[check:command-palette] FAIL: ${msg}`);
  console.error(`::error file=${COMMAND_PALETTE},title=Command palette liveness check failed::${msg}`);
  process.exit(1);
}

function run() {
  const palette = read(COMMAND_PALETTE);
  const app = read(APP);
  const editor = read(EDITOR);

  const builtinIds = extractAll(/id:\s*'([^']+)'/g, palette);
  const disabledIds = extractStaticDisabledIds(palette);
  const appHandledIds = extractAll(/case\s+"([^"]+)":/g, app);
  const editorHandledIds = extractAll(/case\s+'([^']+)':/g, editor);

  const executable = new Set([...appHandledIds, ...editorHandledIds]);
  const unaccounted = [...builtinIds].filter((id) => !disabledIds.has(id) && !executable.has(id));

  if (unaccounted.length > 0) {
    fail(`以下命令既未执行也未显式禁用: ${unaccounted.join(", ")}`);
  }

  console.log("[check:command-palette] OK: 命令面板命令均可执行或已显式禁用。");
}

run();
