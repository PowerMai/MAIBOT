/**
 * Electron 服务层 - 统一的本地能力封装
 * 
 * 充分利用 Electron 的能力：
 * 1. 本地文件系统操作（避免 HTTP 开销）
 * 2. MCP Server 管理（本地进程管理）
 * 3. 系统信息获取
 * 4. 性能优化（直接 IPC 调用）
 * 
 * 设计原则：
 * - 在 Electron 环境中使用本地 API
 * - 在 Web 环境中降级到 HTTP API
 * - 统一接口，调用方无感知
 */

import type { ElectronAPI, FileTreeNode } from '../../types/electron.d';
import { getApiBase } from '../api/langserveChat';
import { getInternalAuthHeaders } from '../api/internalAuth';

// ============================================================
// 环境检测
// ============================================================

/**
 * 检测是否在 Electron 环境中
 */
export function isElectronEnv(): boolean {
  return typeof window !== 'undefined' && 
         window.electron !== undefined && 
         window.electron.isElectron === true;
}

/**
 * 获取 Electron API（如果可用）
 */
function getElectronAPI(): ElectronAPI | null {
  if (isElectronEnv()) {
    return window.electron!;
  }
  return null;
}

/**
 * 获取平台类型
 */
export function getPlatform(): 'darwin' | 'win32' | 'linux' | 'web' {
  const api = getElectronAPI();
  if (api) {
    return api.platform;
  }
  // Web 环境下通过 navigator 检测
  const platform = navigator.platform.toLowerCase();
  if (platform.includes('mac')) return 'darwin';
  if (platform.includes('win')) return 'win32';
  if (platform.includes('linux')) return 'linux';
  return 'web';
}

/**
 * 后端 API Base URL（与 LangGraph 同机）
 * 统一使用 getApiBase，与 Composer 上传、聊天、unifiedFileService、workspace 一致
 */
function getBackendBaseUrl(): string {
  return getApiBase();
}

const FETCH_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  if (init?.signal) {
    if (init.signal.aborted) {
      controller.abort();
    } else {
      init.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================
// 文件系统服务
// ============================================================

export interface FileSystemResult<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}

/** 判断是否为本地绝对路径（Unix / 或 Windows C:\） */
function isLocalAbsolutePath(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false;
  const trimmed = filePath.trim();
  if (trimmed.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  return false;
}

/**
 * 统一文件系统服务（仅工作区/本地文件；知识库由 knowledgeAPI 专属处理）
 * Electron：本地 IPC；Web：后端 /files/* API
 */
export const fileSystemService = {
  /**
   * 选择目录（打开对话框）
   */
  async selectDirectory(): Promise<FileSystemResult<string>> {
    const api = getElectronAPI();
    
    if (api) {
      // Electron: 使用本地对话框
      const result = await api.selectDirectory();
      if (result.canceled) {
        return { success: false, error: 'User canceled' };
      }
      return { success: result.success, data: result.path, error: result.error };
    }
    
    // Web: 不支持目录选择，返回错误
    return { success: false, error: 'Directory selection not supported in web browser' };
  },

  /**
   * 读取目录结构
   */
  async readDirectory(
    dirPath: string,
    depth: number = 3
  ): Promise<FileSystemResult<FileTreeNode>> {
    const api = getElectronAPI();

    if (api) {
      const result = await api.readDirectory({ dirPath, depth });
      return { success: result.success, data: result.tree, error: result.error };
    }

    // Web: 走后端 /files/tree
    try {
      const base = getBackendBaseUrl();
      const response = await fetchWithTimeout(`${base}/files/tree?path=${encodeURIComponent(dirPath)}&max_depth=${depth}`, {
        headers: getInternalAuthHeaders(),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return { success: false, error: (err as any).detail || `HTTP ${response.status}` };
      }
      const data = await response.json();
      return { success: true, data: data as FileTreeNode };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },

  /**
   * 读取文件内容
   * 
   * 对于 DOCX/PDF/XLSX 等二进制格式，始终调用后端解析 API
   */
  async readFile(filePath: string): Promise<FileSystemResult<string>> {
    const api = getElectronAPI();
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    // 需要后端解析的二进制格式
    const BINARY_FORMATS = ['docx', 'doc', 'pdf', 'xlsx', 'xls'];
    const needsBackendParsing = BINARY_FORMATS.includes(ext);
    
    // 二进制格式始终走后端解析
    if (needsBackendParsing) {
      try {
        const base = getBackendBaseUrl();
        const url = `${base}/files/read?path=${encodeURIComponent(filePath)}`;
        const response = await fetchWithTimeout(url, { headers: getInternalAuthHeaders() });
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          return { success: false, error: (err as any).detail || `HTTP ${response.status}` };
        }
        const data = await response.json();
        const content = (data as { content?: string }).content;
        return { success: true, data: content != null ? String(content) : '' };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    }

    if (api) {
      const result = await api.readFile({ filePath });
      return { success: result.success, data: result.content, error: result.error };
    }

    // Web: 通过后端 /files/read
    try {
      const base = getBackendBaseUrl();
      const response = await fetchWithTimeout(`${base}/files/read?path=${encodeURIComponent(filePath)}`, {
        headers: getInternalAuthHeaders(),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return { success: false, error: (err as any).detail || `HTTP ${response.status}` };
      }
      const data = await response.json();
      const content = (data as { content?: string }).content;
      return { success: true, data: content != null ? String(content) : '' };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },

  /**
   * 判断是否为本地绝对路径（Electron 下仅对本地路径走 IPC，否则走后端 HTTP）
   */
  isLocalAbsolutePath(filePath: string): boolean {
    return isLocalAbsolutePath(filePath);
  },

  /**
   * 读取二进制文件
   * Electron：本地绝对路径用 IPC，否则（如 workspace/xxx）走后端 /files/read
   */
  async readFileBinary(filePath: string): Promise<FileSystemResult<{ base64: string; size: number }>> {
    const api = getElectronAPI();
    const isLocal = isLocalAbsolutePath(filePath);

    if (api && isLocal) {
      const result = await api.readFileBinary({ filePath });
      if (result.success && result.base64) {
        return { success: true, data: { base64: result.base64, size: result.size || 0 } };
      }
      return { success: false, error: result.error };
    }

    // Web 或 Electron 下非本地路径：通过后端 /files/read（返回 JSON：content base64, size）
    try {
      const base = getBackendBaseUrl();
      const response = await fetchWithTimeout(`${base}/files/read?path=${encodeURIComponent(filePath)}`, {
        headers: getInternalAuthHeaders(),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return { success: false, error: (err as any).detail || `HTTP ${response.status}` };
      }
      const data = await response.json();
      const payload = data as { content?: string; size?: number };
      if (payload.content != null) {
        return { success: true, data: { base64: payload.content, size: payload.size ?? 0 } };
      }
      return { success: false, error: 'No binary content in response' };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },

  /**
   * 写入文件
   */
  async writeFile(filePath: string, content: string): Promise<FileSystemResult> {
    const api = getElectronAPI();

    if (api) {
      const result = await api.writeFile({ filePath, content });
      return { success: result.success, error: result.error };
    }

    // Web: 通过后端 POST /files/write
    try {
      const base = getBackendBaseUrl();
      const response = await fetchWithTimeout(`${base}/files/write?path=${encodeURIComponent(filePath)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getInternalAuthHeaders() },
        body: JSON.stringify({ content }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return { success: false, error: (err as any).detail || `HTTP ${response.status}` };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },

  /**
   * 写入二进制文件（base64）
   * Electron：本地绝对路径用 IPC；否则走后端 POST /files/write-binary
   */
  async writeFileBinary(filePath: string, contentBase64: string): Promise<FileSystemResult> {
    const api = getElectronAPI();
    const isLocal = isLocalAbsolutePath(filePath);

    if (api && isLocal) {
      const result = await api.writeFileBinary({ filePath, base64: contentBase64 });
      return { success: result.success, error: result.error };
    }

    try {
      const base = getBackendBaseUrl();
      const response = await fetchWithTimeout(`${base}/files/write-binary?path=${encodeURIComponent(filePath)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getInternalAuthHeaders() },
        body: JSON.stringify({ content: contentBase64 }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return { success: false, error: (err as any).detail || `HTTP ${response.status}` };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },

  /**
   * 创建目录
   */
  async createDirectory(dirPath: string): Promise<FileSystemResult> {
    const api = getElectronAPI();

    if (api) {
      const result = await api.createDirectory({ dirPath });
      return { success: result.success, error: result.error };
    }

    // Web: 通过后端 POST /files/mkdir
    try {
      const base = getBackendBaseUrl();
      const response = await fetchWithTimeout(`${base}/files/mkdir?path=${encodeURIComponent(dirPath)}`, {
        method: 'POST',
        headers: getInternalAuthHeaders(),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return { success: false, error: (err as any).detail || `HTTP ${response.status}` };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },

  /**
   * 删除文件或目录
   */
  async deleteFile(filePath: string): Promise<FileSystemResult> {
    const api = getElectronAPI();

    if (api) {
      const result = await api.deleteFile({ filePath });
      return { success: result.success, error: result.error };
    }

    // Web: 通过后端 DELETE /files/delete
    try {
      const base = getBackendBaseUrl();
      const response = await fetchWithTimeout(`${base}/files/delete?path=${encodeURIComponent(filePath)}`, {
        method: 'DELETE',
        headers: getInternalAuthHeaders(),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return { success: false, error: (err as any).detail || `HTTP ${response.status}` };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },

  /**
   * 重命名文件或目录
   */
  async renameFile(oldPath: string, newPath: string): Promise<FileSystemResult> {
    const api = getElectronAPI();

    if (api) {
      const result = await api.renameFile({ oldPath, newPath });
      return { success: result.success, error: result.error };
    }

    // Web: 通过后端 POST /files/rename
    try {
      const base = getBackendBaseUrl();
      const response = await fetchWithTimeout(
        `${base}/files/rename?old_path=${encodeURIComponent(oldPath)}&new_path=${encodeURIComponent(newPath)}`,
        { method: 'POST', headers: getInternalAuthHeaders() }
      );
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return { success: false, error: (err as any).detail || `HTTP ${response.status}` };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },

  /**
   * 检查文件是否存在
   */
  async fileExists(filePath: string): Promise<FileSystemResult<boolean>> {
    const api = getElectronAPI();

    if (api) {
      const result = await api.fileExists({ filePath });
      return { success: result.success, data: result.exists, error: result.error };
    }

    // Web: 通过 GET /files/read 判断存在
    try {
      const base = getBackendBaseUrl();
      const response = await fetchWithTimeout(`${base}/files/read?path=${encodeURIComponent(filePath)}`, {
        headers: getInternalAuthHeaders(),
      });
      if (response.status === 404) {
        return { success: true, data: false };
      }
      if (!response.ok) {
        const err = await response.json().catch(() => ({} as any));
        return { success: false, error: (err as any).detail || (err as any).error || `HTTP ${response.status}` };
      }
      return { success: true, data: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },

  /**
   * 获取文件信息
   */
  async getFileStats(filePath: string): Promise<FileSystemResult<{
    size: number;
    isDirectory: boolean;
    isFile: boolean;
    created: Date;
    modified: Date;
  }>> {
    const api = getElectronAPI();

    if (api) {
      const result = await api.getFileStats({ filePath });
      return { success: result.success, data: result.stats, error: result.error };
    }

    // Web: 后端用 /files/read 返回 size 等
    try {
      const base = getBackendBaseUrl();
      const response = await fetchWithTimeout(`${base}/files/read?path=${encodeURIComponent(filePath)}`, {
        headers: getInternalAuthHeaders(),
      });
      if (!response.ok) return { success: false, error: `HTTP ${response.status}` };
      const data = await response.json();
      const payload = data as { size?: number };
      const size = payload.size ?? 0;
      return {
        success: true,
        data: {
          size,
          isDirectory: false,
          isFile: true,
          created: new Date(),
          modified: new Date(),
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
};

// ============================================================
// MCP Server 管理服务
// ============================================================

export interface MCPServerConfig {
  type: 'filesystem' | 'puppeteer' | 'sqlite' | 'postgres' | 'custom';
  name: string;
  config: {
    workspacePath?: string;
    dbPath?: string;
    connectionString?: string;
    command?: string;
    args?: string[];
  };
}

export interface MCPServerStatus {
  name: string;
  type: string;
  running: boolean;
  pid?: number;
}

/**
 * MCP Server 管理服务
 * 
 * 只在 Electron 环境下可用
 */
export const mcpServerService = {
  /**
   * 检查 MCP 服务是否可用
   */
  isAvailable(): boolean {
    return isElectronEnv();
  },

  /**
   * 启动 MCP 服务器
   */
  async startServer(config: MCPServerConfig): Promise<FileSystemResult<{ pid: number }>> {
    const api = getElectronAPI();
    
    if (!api) {
      return { success: false, error: 'MCP Server management requires Electron environment' };
    }
    
    const result = await api.mcpStartServer(config);
    if (result.success && result.pid) {
      return { success: true, data: { pid: result.pid } };
    }
    return { success: false, error: result.error || result.message };
  },

  /**
   * 停止 MCP 服务器
   */
  async stopServer(name: string): Promise<FileSystemResult> {
    const api = getElectronAPI();
    
    if (!api) {
      return { success: false, error: 'MCP Server management requires Electron environment' };
    }
    
    const result = await api.mcpStopServer({ name });
    return { success: result.success, error: result.error };
  },

  /**
   * 获取所有 MCP 服务器状态
   */
  async getStatus(): Promise<FileSystemResult<MCPServerStatus[]>> {
    const api = getElectronAPI();
    
    if (!api) {
      return { success: false, error: 'MCP Server management requires Electron environment' };
    }
    
    const result = await api.mcpGetStatus();
    return { success: result.success, data: result.servers };
  },

  /**
   * 停止所有 MCP 服务器
   */
  async stopAll(): Promise<FileSystemResult> {
    const api = getElectronAPI();
    
    if (!api) {
      return { success: false, error: 'MCP Server management requires Electron environment' };
    }
    
    const result = await api.mcpStopAll();
    return { success: result.success };
  },
};

// ============================================================
// 菜单事件服务
// ============================================================

type MenuActionCallback = (action: string) => void;
let menuActionCallback: MenuActionCallback | null = null;

/**
 * 菜单事件服务
 */
export const menuService = {
  /**
   * 监听菜单事件
   */
  onMenuAction(callback: MenuActionCallback): void {
    const api = getElectronAPI();
    
    if (api) {
      menuActionCallback = callback;
      api.onMenuAction(callback);
    }
  },

  /**
   * 移除菜单事件监听
   */
  removeMenuActionListener(): void {
    const api = getElectronAPI();
    
    if (api) {
      api.removeMenuActionListener();
      menuActionCallback = null;
    }
  },
};

// ============================================================
// 性能监控服务
// ============================================================

export interface SystemInfo {
  platform: string;
  isElectron: boolean;
  memory?: {
    total: number;
    free: number;
    used: number;
    usagePercent: number;
  };
}

/**
 * 系统信息服务
 */
export const systemInfoService = {
  /**
   * 获取系统信息
   */
  getSystemInfo(): SystemInfo {
    const isElectron = isElectronEnv();
    const platform = getPlatform();
    
    const info: SystemInfo = {
      platform,
      isElectron,
    };
    
    // 如果支持 Performance API，获取内存信息
    if (typeof performance !== 'undefined' && 'memory' in performance) {
      const memory = (performance as any).memory;
      info.memory = {
        total: memory.jsHeapSizeLimit,
        free: memory.jsHeapSizeLimit - memory.usedJSHeapSize,
        used: memory.usedJSHeapSize,
        usagePercent: (memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100,
      };
    }
    
    return info;
  },

  /**
   * 获取渲染进程内存使用情况
   */
  getMemoryUsage(): { heapUsed: number; heapTotal: number } | null {
    if (typeof performance !== 'undefined' && 'memory' in performance) {
      const memory = (performance as any).memory;
      return {
        heapUsed: memory.usedJSHeapSize,
        heapTotal: memory.jsHeapSizeLimit,
      };
    }
    return null;
  },
};

// ============================================================
// 导出统一服务
// ============================================================

export const electronService = {
  isElectronEnv,
  getPlatform,
  fileSystem: fileSystemService,
  mcpServer: mcpServerService,
  menu: menuService,
  systemInfo: systemInfoService,
};

export default electronService;
