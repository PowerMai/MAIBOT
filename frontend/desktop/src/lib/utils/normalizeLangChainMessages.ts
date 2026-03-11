/**
 * 规范化 LangChain 消息，避免传入 @assistant-ui/react-langgraph 时因 undefined 导致崩溃。
 * 使用场景：流式 yield、load 返回、merge 后、任何将消息交给 useExternalMessageConverter 前。
 */

/** 规范化 content 数组内的 part，避免 SDK contentToParts 内 part.summary.map 等访问 undefined 崩溃 */
function normalizeContentParts(content: unknown): unknown {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;
  return content.map((part: Record<string, unknown>) => {
    if (part == null || typeof part !== 'object') return part;
    const type = String(part.type ?? '').toLowerCase();
    if (type === 'reasoning' && (part.summary == null || !Array.isArray(part.summary))) {
      return { ...part, summary: [] };
    }
    if (type === 'image_url') {
      const img = part.image_url;
      if (img == null) return { ...part, image_url: '' };
      if (typeof img === 'object' && (img as { url?: unknown }).url == null) return { ...part, image_url: { ...(img as object), url: '' } };
    }
    if (type === 'file' && (part.file == null || typeof part.file !== 'object')) {
      return { ...part, file: { filename: '', file_data: '', mime_type: '' } };
    }
    return part;
  });
}

export type MessageLike = { type?: string; content?: unknown; additional_kwargs?: { reasoning?: Record<string, unknown>; tool_outputs?: unknown[] }; [k: string]: unknown };

/** 单条消息 content 规范化，供 merge 等单条场景使用 */
export function normalizeMessageContent<T extends MessageLike>(msg: T): T {
  if (msg == null) return msg;
  const type = String(msg.type ?? '').toLowerCase();
  let content = msg.content;
  if ((type === 'human' || type === 'ai' || type === 'system' || type === 'aimessage' || type === 'aimessagechunk') && (content === undefined || content === null)) {
    return { ...msg, content: '' } as T;
  }
  if (type === 'tool' && (content === undefined || content === null)) {
    return { ...msg, content: '' } as T;
  }
  if ((type === 'ai' || type === 'aimessage' || type === 'aimessagechunk') && (content != null && Array.isArray(content))) {
    content = normalizeContentParts(content);
    const kwargs = msg.additional_kwargs;
    if (kwargs) {
      const newKwargs = { ...kwargs };
      if (newKwargs.reasoning != null && typeof newKwargs.reasoning === 'object') {
        const r = newKwargs.reasoning as { type?: string; summary?: unknown };
        if (String(r.type ?? '').toLowerCase() === 'reasoning' && (r.summary == null || !Array.isArray(r.summary))) {
          newKwargs.reasoning = { ...r, summary: [] };
        }
      }
      if (Array.isArray(newKwargs.tool_outputs)) {
        newKwargs.tool_outputs = normalizeContentParts(newKwargs.tool_outputs) as unknown[];
      }
      return { ...msg, content, additional_kwargs: newKwargs } as T;
    }
    return { ...msg, content } as T;
  }
  if ((type === 'human' || type === 'system') && Array.isArray(content)) {
    content = normalizeContentParts(content);
    return { ...msg, content } as T;
  }
  return msg;
}

/** 消息数组规范化，所有交给 SDK 的消息数组应经此处理 */
export function normalizeLangChainMessages<T>(data: T): T {
  if (!Array.isArray(data)) return data;
  return data.map((m) => normalizeMessageContent(m as MessageLike)) as T;
}
