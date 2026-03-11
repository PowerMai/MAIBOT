/**
 * 规范化消息中的 tool_calls，确保每条 tool_call 有 name（空时用 id 或空串）。
 * 不用 "unknown_tool"：流式时首包 name 空会被填成 unknown_tool，后续包带真实 name 时 SDK 会报 "Tool call name does not match existing tool call"。
 * 从 MyRuntimeProvider 抽离，供 useThreadStateLoader 与流式处理共用。
 */

function ensureToolCallName<T extends { id?: string; name?: string | null; [k: string]: unknown }>(
  tc: T,
  idToName?: Map<string, string>
): T {
  let name: string | null = typeof tc.name === "string" && tc.name ? tc.name : null;
  const id = tc.id != null ? String(tc.id) : undefined;
  if (!name && id && idToName) name = idToName.get(id) ?? null;
  if (!name) name = id ?? "";
  if (name === tc.name && (id === undefined ? tc.id == null : id === tc.id)) return tc;
  return { ...tc, id: id ?? tc.id, name };
}

export function normalizeToolCallsInMessages<
  T extends {
    tool_calls?: Array<{ id?: string; name?: string | null; [k: string]: unknown }>;
    tool_call_chunks?: Array<{ id?: string; name?: string | null; [k: string]: unknown }>;
  }
>(messages: T[] | null | undefined): T[] {
  if (messages == null || !Array.isArray(messages) || messages.length === 0) return [];
  const idToName = new Map<string, string>();
  let anyChanged = false;
  const result: T[] = new Array(messages.length);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    let tcChanged = false;
    let tccChanged = false;
    let newToolCalls: (typeof msg)["tool_calls"] | undefined;
    let newChunks: (typeof msg)["tool_call_chunks"] | undefined;

    if (msg?.tool_calls && Array.isArray(msg.tool_calls)) {
      const tcs = msg.tool_calls;
      const arr: typeof tcs = new Array(tcs.length);
      for (let j = 0; j < tcs.length; j++) {
        const tc = tcs[j];
        const fixed = ensureToolCallName(tc, idToName);
        if (fixed.id != null && fixed.name) idToName.set(String(fixed.id), fixed.name);
        arr[j] = fixed;
        if (fixed !== tc) tcChanged = true;
      }
      if (tcChanged) newToolCalls = arr;
    }

    if (msg?.tool_call_chunks && Array.isArray(msg.tool_call_chunks)) {
      const chunks = msg.tool_call_chunks;
      const arr: typeof chunks = new Array(chunks.length);
      for (let j = 0; j < chunks.length; j++) {
        const tc = chunks[j];
        const id = tc.id != null ? String(tc.id) : undefined;
        const fixed = ensureToolCallName(tc, idToName);
        if (fixed !== tc) tccChanged = true;
        const name = typeof fixed.name === "string" && fixed.name ? fixed.name : null;
        if (id && name) idToName.set(id, name);
        arr[j] = fixed;
      }
      if (tccChanged) newChunks = arr;
    }

    if (tcChanged || tccChanged) {
      const patched = { ...msg } as T;
      if (newToolCalls) (patched as { tool_calls?: typeof newToolCalls }).tool_calls = newToolCalls;
      if (newChunks) (patched as { tool_call_chunks?: typeof newChunks }).tool_call_chunks = newChunks;
      result[i] = patched;
      anyChanged = true;
    } else {
      result[i] = msg;
    }
  }
  return anyChanged ? result : messages;
}
