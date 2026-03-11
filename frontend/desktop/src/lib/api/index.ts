/**
 * API 统一导出
 * 
 * 架构说明：
 * - 聊天通信：使用 LangGraph SDK
 * - 文件操作：优先使用 Electron API，降级到 HTTP API
 * - 知识库：统一的知识库管理 API
 * - 工作区：工作区文件和配置管理
 */

export {
  HumanMessage,
  AIMessage,
  BaseMessage,
  generateThreadId,
  createMessageWithContext,
  extractUIFromMessage,
  checkBackendHealth,
} from './chat';

export type { UIContext } from './chat';

// 工作区 API
import { workspaceAPI, workspaceService } from './workspace';
export { workspaceAPI, workspaceService } from './workspace';
export type { WorkspaceInfo, FileNode, FileEntry } from './workspace';
export { configApi } from './configApi';
export { personaApi } from './personaApi';

// 知识库 API
import { knowledgeAPI } from './knowledge';
export { knowledgeAPI } from './knowledge';
export type { KBItem, KBStructure, SearchResult } from './knowledge';
export { KNOWLEDGE_SCOPES, type KnowledgeScope } from './knowledge';

// 服务层（Electron + 统一文件服务）
export {
  isElectronEnv,
  getPlatform,
  fileSystemService,
  mcpServerService,
  menuService,
  systemInfoService,
  electronService,
  sessionService,
  unifiedFileService,
} from '../services';

// 统一的 API 导出
export const api = {
  workspace: { workspaceAPI, workspaceService },
  knowledge: knowledgeAPI,
};

// 默认导出
export default api;
