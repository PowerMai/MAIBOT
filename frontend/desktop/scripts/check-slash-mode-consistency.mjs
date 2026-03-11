#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const THIS_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(THIS_FILE);
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const TARGET = "frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx";

function read(relPath) {
  const abs = path.join(PROJECT_ROOT, relPath);
  if (!fs.existsSync(abs)) throw new Error(`missing file: ${relPath}`);
  return fs.readFileSync(abs, "utf8");
}

function fail(msg) {
  console.error(`[check:slash-mode] FAIL: ${msg}`);
  console.error(`::error file=${TARGET},title=Slash mode consistency check failed::${msg}`);
  process.exit(1);
}

function run() {
  const content = read(TARGET);
  const required = [
    "let requestMode = chatMode;",
    "const executeBackendSlash = async (commandText: string): Promise<string | null> => {",
    "requestMode = nextMode;",
    "mode: requestMode,",
    "const backendPrompt = await executeBackendSlash(trimmedContent);",
    "trimmedContent.startsWith(\"/\")",
    "slashRes.type === \"plugins_list\"",
    "slashRes.type === \"plugins_install\"",
  ];
  for (const token of required) {
    if (!content.includes(token)) fail(`缺少关键标记: ${token}`);
  }

  // 通配 slash 兜底必须在具体命令之后，避免后续分支不可达。
  const idxPlan = content.indexOf("trimmedContent.startsWith(\"/plan\")");
  const idxDebug = content.indexOf("trimmedContent.startsWith(\"/debug\")");
  const idxReview = content.indexOf("trimmedContent.startsWith(\"/review\")");
  const idxSlashCatchAll = content.indexOf("trimmedContent.startsWith(\"/\")");
  if (idxSlashCatchAll < 0 || idxPlan < 0 || idxDebug < 0 || idxReview < 0) {
    fail("未检测到 /plan|/debug|/review 或通配 slash 分支");
  }
  if (idxSlashCatchAll < idxReview || idxSlashCatchAll < idxDebug || idxSlashCatchAll < idxPlan) {
    fail("通配 slash 分支位置错误，可能导致具体命令分支不可达");
  }

  const idxAdditionalKw = content.indexOf("additional_kwargs:");
  const idxConfigMode = content.indexOf("// ✅ 聊天模式（agent/ask/plan/review/debug）");
  if (idxAdditionalKw < 0 || idxConfigMode < 0) {
    fail("未找到 additional_kwargs 或 config.mode 关键块");
  }

  const idxBackendCall = content.indexOf("const backendPrompt = await executeBackendSlash(trimmedContent);");
  if (idxBackendCall < 0) {
    fail("未检测到 /plan|/debug|/review 分支或后端单通道调用");
  }
  if (!(idxBackendCall > idxPlan && idxBackendCall < idxSlashCatchAll)) {
    fail("后端单通道调用未在模式分支区间内，可能出现多实现分叉");
  }

  console.log("[check:slash-mode] OK: slash 模式透传与分支可达性已收敛。");
}

run();
