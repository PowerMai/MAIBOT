#!/usr/bin/env node
import fs from "fs";
import path from "path";

const ROOT = process.cwd();

function read(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`文件不存在: ${relPath}`);
  }
  return fs.readFileSync(abs, "utf8");
}

function ensure(pattern, content, message) {
  if (!pattern.test(content)) {
    throw new Error(message);
  }
}

function main() {
  const constants = read("src/lib/constants.ts");
  const app = read("src/App.tsx");
  const fullEditor = read("src/components/FullEditorV2Enhanced.tsx");
  const composer = read("src/components/ChatComponents/cursor-style-composer.tsx");
  const monacoEditor = read("src/components/MonacoEditorEnhanced.tsx");
  const shortcuts = read("src/lib/hooks/useKeyboardShortcuts.ts");

  ensure(
    /STOP_GENERATION_REQUEST:\s*['"]stop_generation_request['"]/,
    constants,
    "缺少 EVENTS.STOP_GENERATION_REQUEST 常量定义"
  );

  ensure(
    /case\s*["']chat\.stop["']/,
    app,
    "App 命令分发缺少 chat.stop"
  );
  ensure(
    /case\s*["']stop-generation["'][\s\S]*STOP_GENERATION_REQUEST/,
    app,
    "App Electron 菜单动作未映射到 STOP_GENERATION_REQUEST"
  );

  ensure(
    /case\s*['"]chat\.stop['"][\s\S]*STOP_GENERATION_REQUEST/,
    fullEditor,
    "FullEditorV2Enhanced 未处理 chat.stop -> STOP_GENERATION_REQUEST"
  );

  ensure(
    /addEventListener\(EVENTS\.STOP_GENERATION_REQUEST/,
    composer,
    "Cursor composer 未监听 STOP_GENERATION_REQUEST"
  );

  ensure(
    /addCommand\(\s*monaco\.KeyCode\.UpArrow[\s\S]*?suggestWidgetVisible'\)/,
    monacoEditor,
    "MonacoEditorEnhanced 缺少 UpArrow 补全导航绑定"
  );
  ensure(
    /addCommand\(\s*monaco\.KeyCode\.DownArrow[\s\S]*?suggestWidgetVisible'\)/,
    monacoEditor,
    "MonacoEditorEnhanced 缺少 DownArrow 补全导航绑定"
  );
  ensure(
    /addCommand\(\s*monaco\.KeyCode\.Escape[\s\S]*?suggestWidgetVisible'\)/,
    monacoEditor,
    "MonacoEditorEnhanced 缺少 Escape 关闭补全绑定"
  );

  ensure(
    /suggestWidgetVisible[\s\S]*monacoFocused[\s\S]*return;/,
    shortcuts,
    "useKeyboardShortcuts 缺少 Monaco 补全可见时放行逻辑"
  );

  console.log("[check:editor-keys] OK: 编辑区键位与停止生成链路检查通过。");
}

try {
  main();
} catch (error) {
  console.error(`[check:editor-keys] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
