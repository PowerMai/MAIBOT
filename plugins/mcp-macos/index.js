#!/usr/bin/env node
/**
 macOS automation MCP server.
 * Requires: npm i @modelcontextprotocol/sdk
 */
const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const execFileAsync = promisify(execFile);

async function run(command, args = []) {
  const { stdout, stderr } = await execFileAsync(command, args, { timeout: 20000 });
  return { stdout: String(stdout || ""), stderr: String(stderr || "") };
}

function ensureDarwin() {
  if (process.platform !== "darwin") {
    throw new Error("macos-automation only supports darwin");
  }
}

function toolText(payload) {
  return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }] };
}

async function requireCli(command, installTip) {
  try {
    await run("which", [command]);
  } catch (_) {
    throw new Error(`${command} not found. ${installTip}`);
  }
}

async function screenshotTo(path) {
  const file = String(path || `/tmp/mcp-shot-${Date.now()}.png`);
  await run("screencapture", ["-x", file]);
  if (!fs.existsSync(file)) {
    throw new Error(`Screenshot failed: file not found at ${file}`);
  }
  return file;
}

async function ocrPath(file, lang) {
  if (!file || !fs.existsSync(file)) {
    throw new Error(`OCR input file not found: ${file}`);
  }
  try {
    const out = await run("tesseract", [file, "stdout", "-l", lang || "eng+chi_sim"]);
    return out.stdout || out.stderr;
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (msg.toLowerCase().includes("tesseract")) {
      throw new Error(`OCR failed: ${msg}. Please install tesseract via 'brew install tesseract'.`);
    }
    throw err;
  }
}

async function bootstrap() {
  const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");

  const server = new Server(
    { name: "mcp-macos", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler({ method: "tools/list" }, async () => ({
    tools: [
      { name: "run_applescript", description: "Run AppleScript.", inputSchema: { type: "object", properties: { script: { type: "string" } }, required: ["script"] } },
      { name: "run_shortcut", description: "Run macOS shortcut by name.", inputSchema: { type: "object", properties: { name: { type: "string" }, input: { type: "string" } }, required: ["name"] } },
      { name: "get_system_info", description: "Get macOS system info.", inputSchema: { type: "object", properties: {} } },
      { name: "get_running_apps", description: "List running app names.", inputSchema: { type: "object", properties: {} } },
      { name: "get_frontmost_app", description: "Get frontmost app.", inputSchema: { type: "object", properties: {} } },
      { name: "list_windows", description: "List visible windows.", inputSchema: { type: "object", properties: { app_name: { type: "string" } } } },
      { name: "get_clipboard", description: "Read clipboard text.", inputSchema: { type: "object", properties: {} } },
      { name: "get_wifi_info", description: "Get Wi-Fi status info.", inputSchema: { type: "object", properties: { device: { type: "string" } } } },
      { name: "get_battery_info", description: "Get battery status.", inputSchema: { type: "object", properties: {} } },
      { name: "get_display_info", description: "Get display adapter info.", inputSchema: { type: "object", properties: {} } },
      { name: "get_screen_text", description: "Take screenshot and OCR it.", inputSchema: { type: "object", properties: { path: { type: "string" }, lang: { type: "string" } } } },
      { name: "get_selected_text", description: "Capture selected text via Cmd+C.", inputSchema: { type: "object", properties: {} } },
      { name: "set_clipboard", description: "Write clipboard text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      { name: "manage_window", description: "Window action: minimize|zoom|fullscreen|close.", inputSchema: { type: "object", properties: { app_name: { type: "string" }, action: { type: "string" } }, required: ["app_name", "action"] } },
      { name: "send_keystroke", description: "Send keyboard shortcut/keystroke.", inputSchema: { type: "object", properties: { key: { type: "string" }, modifiers: { type: "array", items: { type: "string" } } }, required: ["key"] } },
      { name: "open_url", description: "Open URL in default browser.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
      { name: "open_app", description: "Open application by name.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
      { name: "manage_notification", description: "Show macOS notification.", inputSchema: { type: "object", properties: { title: { type: "string" }, message: { type: "string" }, subtitle: { type: "string" } }, required: ["title", "message"] } },
      { name: "toggle_dark_mode", description: "Toggle/Set dark mode.", inputSchema: { type: "object", properties: { enabled: { type: "boolean" } } } },
      { name: "manage_volume", description: "Volume action: set|up|down|mute|unmute.", inputSchema: { type: "object", properties: { action: { type: "string" }, level: { type: "number" } } } },
      { name: "computer_use_screenshot", description: "Computer-use screenshot.", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "computer_use_click", description: "Computer-use click at coordinates.", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, button: { type: "string" }, double: { type: "boolean" } }, required: ["x", "y"] } },
      { name: "computer_use_type", description: "Computer-use type text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      { name: "computer_use_scroll", description: "Computer-use scroll by amount.", inputSchema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] } },
      { name: "computer_use_drag", description: "Computer-use drag from A to B.", inputSchema: { type: "object", properties: { from_x: { type: "number" }, from_y: { type: "number" }, to_x: { type: "number" }, to_y: { type: "number" } }, required: ["from_x", "from_y", "to_x", "to_y"] } },
      { name: "screenshot", description: "Take screenshot to temp file.", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "ocr_image", description: "OCR text from image path (requires tesseract).", inputSchema: { type: "object", properties: { path: { type: "string" }, lang: { type: "string" } }, required: ["path"] } },
      { name: "list_running_apps", description: "Alias of get_running_apps.", inputSchema: { type: "object", properties: {} } },
    ],
  }));

  server.setRequestHandler({ method: "tools/call" }, async (req) => {
    ensureDarwin();
    const { name, arguments: args = {} } = req.params || {};
    if (name === "run_applescript") {
      const out = await run("osascript", ["-e", String(args.script || "")]);
      return toolText(out.stdout || out.stderr);
    }
    if (name === "run_shortcut") {
      const runArgs = ["run", String(args.name || "")];
      if (args.input) runArgs.push("--input", String(args.input));
      const out = await run("shortcuts", runArgs);
      return toolText(out.stdout || out.stderr);
    }
    if (name === "get_system_info") {
      const sw = await run("sw_vers", []);
      const uname = await run("uname", ["-a"]);
      const host = await run("scutil", ["--get", "ComputerName"]).catch(() => ({ stdout: "" }));
      return toolText({ computer_name: host.stdout.trim(), sw_vers: sw.stdout.trim(), uname: uname.stdout.trim() });
    }
    if (name === "get_running_apps" || name === "list_running_apps") {
      const out = await run("osascript", ["-e", 'tell application "System Events" to get name of (processes where background only is false)']);
      const apps = out.stdout.split(",").map((x) => x.trim()).filter(Boolean);
      return toolText({ apps });
    }
    if (name === "get_frontmost_app") {
      const out = await run("osascript", ["-e", 'tell application "System Events" to get name of first process whose frontmost is true']);
      return toolText({ app: out.stdout.trim() });
    }
    if (name === "list_windows") {
      const appName = String(args.app_name || "");
      const script = appName
        ? `tell application "System Events" to get {name, position, size} of every window of process "${appName.replace(/"/g, '\\"')}"`
        : 'tell application "System Events" to get {name, position, size} of every window of (every process whose background only is false)';
      const out = await run("osascript", ["-e", script]);
      return toolText({ raw: out.stdout.trim() });
    }
    if (name === "get_clipboard") {
      const out = await run("osascript", ["-e", "the clipboard as text"]);
      return toolText({ text: out.stdout.trim() });
    }
    if (name === "get_wifi_info") {
      const device = String(args.device || "en0");
      const airport = await run("networksetup", ["-getairportnetwork", device]).catch(() => ({ stdout: "", stderr: "" }));
      const ip = await run("ipconfig", ["getifaddr", device]).catch(() => ({ stdout: "", stderr: "" }));
      return toolText({ device, network: airport.stdout.trim() || airport.stderr.trim(), ip: ip.stdout.trim() });
    }
    if (name === "get_battery_info") {
      const out = await run("pmset", ["-g", "batt"]);
      return toolText({ raw: out.stdout.trim() });
    }
    if (name === "get_display_info") {
      const out = await run("system_profiler", ["SPDisplaysDataType"]);
      return toolText({ raw: out.stdout.trim() });
    }
    if (name === "get_selected_text") {
      const previous = await run("osascript", ["-e", "the clipboard as text"]).catch(() => ({ stdout: "" }));
      await run("osascript", ["-e", 'tell application "System Events" to keystroke "c" using command down']);
      await new Promise((resolve) => setTimeout(resolve, 120));
      const current = await run("osascript", ["-e", "the clipboard as text"]);
      return toolText({ text: current.stdout.trim(), clipboard_changed: current.stdout.trim() !== previous.stdout.trim() });
    }
    if (name === "set_clipboard") {
      const text = String(args.text || "").replace(/"/g, '\\"');
      await run("osascript", ["-e", `set the clipboard to "${text}"`]);
      return toolText({ ok: true });
    }
    if (name === "manage_window") {
      const appName = String(args.app_name || "").replace(/"/g, '\\"');
      const action = String(args.action || "").toLowerCase();
      if (action === "minimize") {
        await run("osascript", ["-e", `tell application "System Events" to tell process "${appName}" to set miniaturized of front window to true`]);
      } else if (action === "zoom") {
        await run("osascript", ["-e", `tell application "System Events" to tell process "${appName}" to set zoomed of front window to true`]);
      } else if (action === "fullscreen") {
        await run("osascript", ["-e", `tell application "System Events" to tell process "${appName}" to set value of attribute "AXFullScreen" of front window to true`]);
      } else if (action === "close") {
        await run("osascript", ["-e", `tell application "System Events" to tell process "${appName}" to click button 1 of front window`]);
      } else {
        throw new Error("action must be one of: minimize|zoom|fullscreen|close");
      }
      return toolText({ ok: true, action, app_name: appName });
    }
    if (name === "send_keystroke") {
      const key = String(args.key || "").replace(/"/g, '\\"');
      const modifiers = Array.isArray(args.modifiers) ? args.modifiers : [];
      const modScript = modifiers.length ? ` using {${modifiers.map((m) => `${String(m).toLowerCase()} down`).join(", ")}}` : "";
      await run("osascript", ["-e", `tell application "System Events" to keystroke "${key}"${modScript}`]);
      return toolText({ ok: true });
    }
    if (name === "open_url") {
      const url = String(args.url || "");
      await run("open", [url]);
      return toolText({ ok: true, url });
    }
    if (name === "open_app") {
      const appName = String(args.name || "");
      await run("open", ["-a", appName]);
      return toolText({ ok: true, app_name: appName });
    }
    if (name === "manage_notification") {
      const title = String(args.title || "").replace(/"/g, '\\"');
      const message = String(args.message || "").replace(/"/g, '\\"');
      const subtitle = String(args.subtitle || "").replace(/"/g, '\\"');
      const script = subtitle
        ? `display notification "${message}" with title "${title}" subtitle "${subtitle}"`
        : `display notification "${message}" with title "${title}"`;
      await run("osascript", ["-e", script]);
      return toolText({ ok: true });
    }
    if (name === "toggle_dark_mode") {
      if (typeof args.enabled === "boolean") {
        await run("osascript", ["-e", `tell application "System Events" to tell appearance preferences to set dark mode to ${args.enabled ? "true" : "false"}`]);
        return toolText({ ok: true, dark_mode: args.enabled });
      }
      const current = await run("osascript", ["-e", 'tell application "System Events" to tell appearance preferences to get dark mode']);
      const next = String(current.stdout || "").trim().toLowerCase() !== "true";
      await run("osascript", ["-e", `tell application "System Events" to tell appearance preferences to set dark mode to ${next ? "true" : "false"}`]);
      return toolText({ ok: true, dark_mode: next });
    }
    if (name === "manage_volume") {
      const action = String(args.action || "set").toLowerCase();
      const level = Number.isFinite(Number(args.level)) ? Number(args.level) : 50;
      if (action === "set") {
        await run("osascript", ["-e", `set volume output volume ${Math.max(0, Math.min(100, Math.round(level)))}`]);
      } else if (action === "mute") {
        await run("osascript", ["-e", "set volume with output muted"]);
      } else if (action === "unmute") {
        await run("osascript", ["-e", "set volume without output muted"]);
      } else if (action === "up" || action === "down") {
        const current = await run("osascript", ["-e", "output volume of (get volume settings)"]);
        const raw = Number(current.stdout.trim() || "0");
        const next = Math.max(0, Math.min(100, raw + (action === "up" ? 10 : -10)));
        await run("osascript", ["-e", `set volume output volume ${next}`]);
      } else {
        throw new Error("action must be one of: set|up|down|mute|unmute");
      }
      return toolText({ ok: true, action });
    }
    if (name === "computer_use_screenshot") {
      const file = await screenshotTo(args.path || `/tmp/mcp-computer-use-${Date.now()}.png`);
      return toolText({ path: file });
    }
    if (name === "computer_use_click") {
      await requireCli("cliclick", "Install with: brew install cliclick");
      const x = Math.round(Number(args.x || 0));
      const y = Math.round(Number(args.y || 0));
      const button = String(args.button || "left").toLowerCase();
      const isDouble = Boolean(args.double);
      const clickToken = button === "right" ? "rc" : "c";
      if (isDouble) {
        await run("cliclick", [`${clickToken}:${x},${y}`, `${clickToken}:${x},${y}`]);
      } else {
        await run("cliclick", [`${clickToken}:${x},${y}`]);
      }
      return toolText({ ok: true, x, y, button, double: isDouble });
    }
    if (name === "computer_use_type") {
      const text = String(args.text || "").replace(/"/g, '\\"');
      await run("osascript", ["-e", `tell application "System Events" to keystroke "${text}"`]);
      return toolText({ ok: true });
    }
    if (name === "computer_use_scroll") {
      await requireCli("cliclick", "Install with: brew install cliclick");
      const amount = Math.round(Number(args.amount || 0));
      await run("cliclick", [`w:${amount}`]);
      return toolText({ ok: true, amount });
    }
    if (name === "computer_use_drag") {
      await requireCli("cliclick", "Install with: brew install cliclick");
      const fromX = Math.round(Number(args.from_x || 0));
      const fromY = Math.round(Number(args.from_y || 0));
      const toX = Math.round(Number(args.to_x || 0));
      const toY = Math.round(Number(args.to_y || 0));
      await run("cliclick", [`dd:${fromX},${fromY}`, `du:${toX},${toY}`]);
      return toolText({ ok: true, from_x: fromX, from_y: fromY, to_x: toX, to_y: toY });
    }
    if (name === "screenshot") {
      const file = await screenshotTo(args.path);
      return toolText({ path: file });
    }
    if (name === "ocr_image") {
      const text = await ocrPath(String(args.path || ""), String(args.lang || "eng+chi_sim"));
      return toolText({ text });
    }
    if (name === "get_screen_text") {
      const file = await screenshotTo(args.path || `/tmp/mcp-screen-text-${Date.now()}.png`);
      const text = await ocrPath(file, String(args.lang || "eng+chi_sim"));
      return toolText({ path: file, text });
    }
    throw new Error(`Unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

bootstrap().catch((err) => {
  process.stderr.write(`[mcp-macos] ${String(err && err.stack ? err.stack : err)}\n`);
  process.exit(1);
});
