/**
 * LangGraph API 兼容层
 *
 * 说明：
 * - 历史上此文件曾直接实现 runs/stream 与线程生命周期。
 * - 现统一收敛到 `api/langserveChat.ts` 作为主通道，本文件仅保留兼容壳，
 *   以避免上层调用点大面积改造。
 */

import { AIMessage } from '@langchain/core/messages';
import { unifiedFileService } from './services/unifiedFileService';
import { fileSystemService } from './services/electronService';
import {
  getItem as getStorageItem,
  setItem as setStorageItem,
  removeItem as removeStorageItem,
} from './safeStorage';
import { getCurrentWorkspacePathFromStorage } from './sessionState';
import {
  createThread as createThreadFromSDK,
  touchThread,
  sendMessageWithRetry,
  checkHealth,
  waitForBackend,
  validServerThreadIdOrUndefined,
} from './api/langserveChat';
import type { LangChainMessage, LangGraphMessagesEvent } from '@assistant-ui/react-langgraph';

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in (part as Record<string, unknown>)) {
          return String((part as Record<string, unknown>).text ?? '');
        }
        return '';
      })
      .join('');
  }
  return String(content ?? '');
}

// ============================================================================
// 线程管理（复用 langserveChat 的实现，避免重复）
// ============================================================================

// 线程状态按工作区分桶持久化，避免跨工作区串会话
const THREAD_STORAGE_KEY_PREFIX = 'langgraph_thread_state';

let currentThreadId: string | null = null;
let currentThreadWorkspacePath: string | null = null;
/** 按工作区串行创建，避免并发 getCurrentThread 时创建多个孤立线程 */
let createThreadInflight: Promise<string> | null = null;
let createThreadInflightWorkspace: string | null = null;

function getCurrentWorkspacePath(): string {
  return getCurrentWorkspacePathFromStorage();
}

function getThreadStorageKey(workspacePath: string): string {
  return `${THREAD_STORAGE_KEY_PREFIX}:${workspacePath || "__global__"}`;
}

// 从 localStorage 恢复 thread_id
function loadThreadFromStorage(workspacePath: string): string | null {
  try {
    const key = getThreadStorageKey(workspacePath);
    const raw = getStorageItem(key);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { threadId?: unknown; workspacePath?: unknown };
      if (parsed && typeof parsed === 'object' && typeof parsed.threadId === 'string') {
        const savedWorkspace = String(parsed.workspacePath ?? '').trim();
        if (savedWorkspace && savedWorkspace !== workspacePath) return null;
        return parsed.threadId;
      }
    } catch {
      // 兼容历史纯字符串格式
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

// 保存 thread_id 到 localStorage
function saveThreadToStorage(threadId: string, workspacePath: string): void {
  try {
    const key = getThreadStorageKey(workspacePath);
    setStorageItem(key, JSON.stringify({ threadId, workspacePath }));
  } catch (e) {
    console.warn('[LangGraph] 无法保存 thread_id 到 localStorage:', e);
  }
}

// 清除 localStorage 中的 thread_id
function clearThreadFromStorage(workspacePath: string): void {
  try {
    const key = getThreadStorageKey(workspacePath);
    removeStorageItem(key);
    // 清理历史 key，避免旧值干扰
    removeStorageItem('langgraph_thread_id');
  } catch (e) {
    if (typeof import.meta !== "undefined" && import.meta.env?.DEV) console.warn("[LangGraph] clearThreadFromStorage failed:", e);
  }
}

function isAssistantMessage(msg: unknown): msg is Record<string, unknown> {
  if (!msg || typeof msg !== 'object') return false;
  const rec = msg as Record<string, unknown>;
  const role = String(rec.type ?? rec.role ?? '').toLowerCase();
  return role === 'ai' || role === 'assistant';
}

function extractLastAssistantMessage(messages: unknown[]): Record<string, unknown> | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (isAssistantMessage(candidate)) {
      return candidate;
    }
  }
  return null;
}

// ✅ 使用 langserveChat 的 SDK 创建线程（避免重复实现）
async function createThread(metadata: Record<string, any> = {}): Promise<string> {
  const thread = await createThreadFromSDK({
    type: 'chat',
    ...metadata,
  });
  return thread.thread_id;
}

async function getCurrentThread(): Promise<string> {
  const workspacePath = getCurrentWorkspacePath();
  // 优先从内存获取
  if (currentThreadId && currentThreadWorkspacePath === workspacePath) {
    // 更新活跃时间（异步，不阻塞）
    touchThread(currentThreadId).catch((err) => { if (import.meta.env?.DEV) console.warn('[LangGraph] touchThread failed', err); });
    return currentThreadId;
  }
  
  if (currentThreadWorkspacePath !== workspacePath) {
    currentThreadId = null;
  }

  // 尝试从 localStorage 恢复（按工作区）；仅当为服务端 UUID 时复用，否则丢弃并新建
  const savedThreadId = loadThreadFromStorage(workspacePath);
  const validTid = validServerThreadIdOrUndefined(savedThreadId);
  if (validTid) {
    currentThreadId = validTid;
    currentThreadWorkspacePath = workspacePath;
    console.log(`[LangGraph] 恢复线程: ${currentThreadId}`);
    touchThread(currentThreadId).catch((err) => { if (import.meta.env?.DEV) console.warn('[LangGraph] touchThread failed', err); });
    return currentThreadId;
  }
  if (savedThreadId) {
    currentThreadWorkspacePath = workspacePath;
    clearThreadFromStorage(workspacePath);
  }

  // 并发保护：同一工作区多次调用共享同一次创建，避免创建多个孤立线程
  if (createThreadInflight && createThreadInflightWorkspace === workspacePath) {
    const tid = await createThreadInflight;
    if (currentThreadWorkspacePath === workspacePath && currentThreadId) return currentThreadId;
    return tid;
  }
  const createPromise = (async (): Promise<string> => {
    const health = await checkHealth(true);
    if (!health.healthy) {
      await waitForBackend(3, 2000);
    }
    const newId = await createThread({
      created_at: new Date().toISOString(),
      ...(workspacePath ? { workspace_path: workspacePath } : {}),
    });
    return newId;
  })();
  createThreadInflight = createPromise;
  createThreadInflightWorkspace = workspacePath;
  try {
    currentThreadId = await createPromise;
    currentThreadWorkspacePath = workspacePath;
    saveThreadToStorage(currentThreadId, workspacePath);
    console.log(`[LangGraph] 新线程: ${currentThreadId}`);
    return currentThreadId;
  } finally {
    if (createThreadInflight === createPromise) {
      createThreadInflight = null;
      createThreadInflightWorkspace = null;
    }
  }
}

function resetThread(): void {
  const workspacePath = currentThreadWorkspacePath ?? getCurrentWorkspacePath();
  currentThreadId = null;
  currentThreadWorkspacePath = null;
  createThreadInflight = null;
  createThreadInflightWorkspace = null;
  clearThreadFromStorage(workspacePath);
  console.log('[LangGraph] 线程已重置');
}

function toHumanMessage(content: string, additionalKwargs: Record<string, unknown>): LangChainMessage {
  return {
    type: 'human',
    content,
    additional_kwargs: additionalKwargs,
  } as unknown as LangChainMessage;
}

async function streamAssistantText(
  threadId: string,
  message: LangChainMessage,
  config: Record<string, unknown> | undefined,
  onChunk: (content: string, done: boolean) => void
): Promise<AIMessage> {
  let lastContent = '';
  let completed = false;
  const signalComplete = (content: string) => {
    if (!completed) {
      completed = true;
      try {
        onChunk(content, true);
      } catch (_) { /* 避免 onChunk 抛错掩盖原始异常 */ }
    }
  };
  try {
    for await (const event of sendMessageWithRetry({
      threadId,
      messages: [message],
      config,
      streamModes: ['messages', 'custom'],
    })) {
      const e = event as LangGraphMessagesEvent<LangChainMessage>;
      const baseType = String((e as { event?: string }).event || '').split('|')[0];
      if (baseType !== 'messages/partial' && baseType !== 'messages/complete' && baseType !== 'messages') {
        continue;
      }
      const data = (e as { data?: unknown }).data;
      if (!Array.isArray(data) || data.length === 0) continue;
      const assistantMessage = extractLastAssistantMessage(data);
      if (!assistantMessage || !('content' in assistantMessage)) continue;
      const content = contentToText((assistantMessage as Record<string, unknown>).content);
      if (content !== lastContent) {
        lastContent = content;
        onChunk(content, false);
      }
    }
  } catch (err) {
    signalComplete(lastContent);
    throw err;
  }
  signalComplete(lastContent);
  if (!lastContent) {
    throw new Error('No response from agent');
  }
  return new AIMessage({ content: lastContent, additional_kwargs: {} });
}

// ============================================================================
// API 接口
// ============================================================================

const langgraphApi = {
  getCurrentThreadId: async (): Promise<string> => {
    return getCurrentThread();
  },

  resetThread: (): void => {
    resetThread();
  },

  sendChatMessageStream: async (
    message: string,
    context: {
      workspaceId?: string;
      editorContent?: string;
      editorPath?: string;
      selectedText?: string;
      workspaceFiles?: string[];
      workspacePath?: string;
    } = {},
    onChunk: (content: string, isComplete: boolean) => void
  ): Promise<AIMessage> => {
    const threadId = await getCurrentThread();
    const additionalKwargs = {
      source: 'chatarea',
      request_type: 'agent_chat',
      workspace_id: context.workspaceId,
      file_path: context.editorPath,
      file_content: context.editorContent,
      selected_text: context.selectedText,
    };
    const humanMessage = toHumanMessage(message, additionalKwargs);
    return streamAssistantText(threadId, humanMessage, undefined, onChunk);
  },

  sendChatMessage: async (
    message: string,
    context: {
      workspaceId?: string;
      editorContent?: string;
      editorPath?: string;
      selectedText?: string;
      workspaceFiles?: string[];
      workspacePath?: string;
    } = {}
  ): Promise<AIMessage> => {
    const threadId = await getCurrentThread();
    const additionalKwargs = {
      source: 'chatarea',
      request_type: 'agent_chat',
      workspace_id: context.workspaceId,
      file_path: context.editorPath,
      file_content: context.editorContent,
      selected_text: context.selectedText,
    };
    const humanMessage = toHumanMessage(message, additionalKwargs);
    let final = '';
    await streamAssistantText(threadId, humanMessage, undefined, (content) => {
      final = content;
    });
    return new AIMessage({ content: final, additional_kwargs: {} });
  },

  // ============================================================
  // 文件操作（代理到 unifiedFileService，避免重复实现）
  // ✅ 优先使用 Electron 本地 API，降级到 HTTP API
  // ============================================================
  
  readFile: async (filePath: string, _workspaceId?: string): Promise<string> => {
    // 代理到 unifiedFileService（优先 Electron，降级 HTTP）
    const content = await unifiedFileService.readFile(filePath);
    if (content === null) {
      throw new Error(`读取文件失败: ${filePath}`);
    }
    return content;
  },

  writeFile: async (filePath: string, content: string, _workspaceId?: string): Promise<void> => {
    // 代理到 unifiedFileService（优先 Electron，降级 HTTP）
    const success = await unifiedFileService.writeFile(filePath, content);
    if (!success) {
      throw new Error(`写入文件失败: ${filePath}`);
    }
    console.log(`[LangGraph] 文件已写入: ${filePath}`);
  },

  performEditorAction: async (
    actionType: 'expand' | 'explain' | 'refactor',
    filePath: string,
    fileContent: string,
    selectedText: string,
    workspaceId?: string
  ): Promise<AIMessage> => {
    const prompts = {
      expand: `扩展代码:\n\n${selectedText}`,
      explain: `解释代码:\n\n${selectedText}`,
      refactor: `重构代码:\n\n${selectedText}`,
    };
    return langgraphApi.sendChatMessage(prompts[actionType], {
      workspaceId,
      editorPath: filePath,
      editorContent: fileContent,
      selectedText,
    });
  },

  listDirectory: async (dirPath: string, _workspaceId?: string): Promise<any[]> => {
    // 仅工作区目录树使用；知识库由 knowledgeAPI.listDirectory 走 /knowledge/list
    const result = await fileSystemService.readDirectory(dirPath, 1);
    if (!result.success || !result.data) {
      throw new Error(`列出目录失败: ${dirPath}`);
    }
    
    // 转换为统一格式
    const tree = result.data;
    if (tree.children) {
      return tree.children.map((item: any) => ({
        name: item.name,
        path: item.path,
        type: item.type,
        isDirectory: item.type === 'folder' || item.type === 'directory',
        size: item.size || 0,
      }));
    }
    
    return [];
  },

  createFile: async (filePath: string, content: string, workspaceId?: string): Promise<void> => {
    return langgraphApi.writeFile(filePath, content, workspaceId);
  },

  createDirectory: async (dirPath: string, _workspaceId?: string): Promise<void> => {
    // 代理到 fileSystemService（优先 Electron，降级 HTTP）
    const result = await fileSystemService.createDirectory(dirPath);
    if (!result.success) {
      throw new Error(result.error || `创建目录失败: ${dirPath}`);
    }
  },

  deleteFile: async (filePath: string, _workspaceId?: string): Promise<void> => {
    // 代理到 fileSystemService（优先 Electron，降级 HTTP）
    const result = await fileSystemService.deleteFile(filePath);
    if (!result.success) {
      throw new Error(result.error || `删除文件失败: ${filePath}`);
    }
  },

  renameFile: async (oldPath: string, newPath: string, _workspaceId?: string): Promise<void> => {
    // 代理到 fileSystemService（优先 Electron，降级 HTTP）
    const result = await fileSystemService.renameFile(oldPath, newPath);
    if (!result.success) {
      throw new Error(result.error || `重命名失败: ${oldPath} -> ${newPath}`);
    }
  },

  checkBackendHealth: async (): Promise<boolean> => {
    const status = await checkHealth(true);
    return status.healthy;
  },
};

export default langgraphApi;
