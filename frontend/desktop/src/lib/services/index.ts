/**
 * 统一服务导出
 * 
 * 所有前端服务的统一入口，避免循环依赖
 */

// Electron 服务（本地能力）
export {
  isElectronEnv,
  getPlatform,
  fileSystemService,
  mcpServerService,
  menuService,
  systemInfoService,
  electronService,
} from './electronService';

// 会话服务
export { sessionService, type SessionInfo } from './sessionService';

// 统一文件服务
export { unifiedFileService, UnifiedFileService, type UploadResult, type ProcessedFile, type ProcessOptions } from './unifiedFileService';
