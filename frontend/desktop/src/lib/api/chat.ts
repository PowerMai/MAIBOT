/**
 * Chat API - LangChain 标准消息类型和 UI 上下文
 * 
 * 注意：实际的 API 调用现在通过 LangGraph SDK (@langchain/langgraph-sdk) 进行
 * MyRuntimeProvider 和 Thread 组件处理所有通信
 */

import { HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';

/**
 * UI 上下文类型 - 传递给后端的编辑器和工作区信息
 */
export interface UIContext {
  // 编辑器信息
  editorContent?: string;
  editorPath?: string;
  cursorPosition?: number;
  selection?: string;
  selectedText?: string;
  
  // 工作区信息
  workspaceFiles?: string[];
  workspacePath?: string;
  workspaceId?: string;
  
  // 上传的文件
  uploadedFiles?: Array<{
    name: string;
    content: string;
    type: string;
  }>;
  
  // 其他上下文
  focusedElement?: string;
  [key: string]: any;
}

// 重新导出 LangChain 消息类型
export {
  HumanMessage,
  AIMessage,
  BaseMessage,
};

/**
 * 生成线程 ID
 */
export function generateThreadId(): string {
  return `thread_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 创建带有 UI 上下文的消息
 */
export function createMessageWithContext(
  content: string,
  uiContext?: UIContext
): HumanMessage {
  const message = new HumanMessage({
    content,
    additional_kwargs: {
      ui_context: uiContext,
    },
  });
  
  return message;
}

/**
 * 从消息中提取 UI 信息
 */
export function extractUIFromMessage(message: BaseMessage): UIContext | null {
  if ('additional_kwargs' in message && message.additional_kwargs?.ui_context) {
    return message.additional_kwargs.ui_context as UIContext;
  }
  return null;
}

/**
 * LangGraph 服务器配置（与 langserveChat 一致）
 * API 地址建议通过 langserveChat.getApiUrl() 获取以包含设置页 baseURL
 */
export const LANGGRAPH_CONFIG = {
  // API 地址（仅作默认值；实际请求以 langserveChat.getApiUrl() 为准）
  apiUrl: (import.meta.env?.VITE_LANGGRAPH_API_URL || 'http://127.0.0.1:2024'),
  // Assistant ID（与 langserveChat 及后端图名一致）
  assistantId: 'agent',
  timeout: 30000,
  retries: 2,
};

/**
 * 检查后端连接（复用 langserveChat.checkHealth，避免重复实现）
 */
export async function checkBackendHealth(): Promise<boolean> {
  const { checkHealth } = await import('./langserveChat');
  const status = await checkHealth(true);
  return status.healthy;
}
