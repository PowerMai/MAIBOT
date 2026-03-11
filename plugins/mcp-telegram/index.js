#!/usr/bin/env node
/**
 * Telegram MCP server (minimal).
 * Requires: npm i @modelcontextprotocol/sdk node-fetch
 */
const fetch = require("node-fetch");

async function tg(method, payload = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_err) {
    throw new Error(`Telegram API returned invalid JSON (${resp.status}): ${text.slice(0, 200)}`);
  }
  if (!resp.ok) {
    throw new Error(`Telegram API HTTP ${resp.status}: ${JSON.stringify(data)}`);
  }
  if (data && data.ok === false) {
    throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  }
  return data;
}

async function bootstrap() {
  const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");

  const server = new Server(
    { name: "mcp-telegram", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(
    { method: "tools/list" },
    async () => ({
      tools: [
        { name: "telegram_send_message", description: "Send message to a chat.", inputSchema: { type: "object", properties: { chat_id: { type: "string" }, text: { type: "string" } }, required: ["chat_id", "text"] } },
        { name: "telegram_get_updates", description: "Fetch latest updates.", inputSchema: { type: "object", properties: { limit: { type: "number" }, timeout: { type: "number" } } } },
      ],
    }),
  );

  server.setRequestHandler(
    { method: "tools/call" },
    async (req) => {
      const { name, arguments: args = {} } = req.params || {};
      if (name === "telegram_send_message") {
        const data = await tg("sendMessage", { chat_id: String(args.chat_id), text: String(args.text) });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
      if (name === "telegram_get_updates") {
        const data = await tg("getUpdates", { limit: Number(args.limit || 20), timeout: Number(args.timeout || 0) });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
      throw new Error(`Unknown tool: ${name}`);
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

bootstrap().catch((err) => {
  process.stderr.write(`[mcp-telegram] ${String(err && err.stack ? err.stack : err)}\n`);
  process.exit(1);
});
