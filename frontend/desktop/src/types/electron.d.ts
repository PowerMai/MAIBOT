/**
 * Electron API 类型定义
 * 
 * 定义 preload.js 暴露到 window.electron 的 API 类型
 */

export interface ElectronAPI {
  // ============================================
  // 文件系统操作
  // ============================================
  
  /** 选择目录 */
  selectDirectory: () => Promise<{
    success: boolean;
    canceled?: boolean;
    path?: string;
    error?: string;
  }>;
  
  /** 读取目录结构 */
  readDirectory: (options: {
    dirPath: string;
    depth?: number;
  }) => Promise<{
    success: boolean;
    tree?: FileTreeNode;
    error?: string;
  }>;
  
  /** 读取文件（文本） */
  readFile: (options: { filePath: string }) => Promise<{
    success: boolean;
    content?: string;
    error?: string;
  }>;
  
  /** 读取文件（二进制） */
  readFileBinary: (options: { filePath: string }) => Promise<{
    success: boolean;
    base64?: string;
    size?: number;
    error?: string;
  }>;
  
  /** 写入文件 */
  writeFile: (options: {
    filePath: string;
    content: string;
  }) => Promise<{
    success: boolean;
    error?: string;
  }>;
  
  /** 写入二进制文件（base64） */
  writeFileBinary: (options: {
    filePath: string;
    base64: string;
  }) => Promise<{
    success: boolean;
    error?: string;
  }>;
  
  /** 创建目录 */
  createDirectory: (options: { dirPath: string }) => Promise<{
    success: boolean;
    error?: string;
  }>;
  
  /** 删除文件或目录 */
  deleteFile: (options: { filePath: string }) => Promise<{
    success: boolean;
    error?: string;
  }>;
  
  /** 重命名文件或目录 */
  renameFile: (options: {
    oldPath: string;
    newPath: string;
  }) => Promise<{
    success: boolean;
    error?: string;
  }>;
  
  /** 检查文件是否存在 */
  fileExists: (options: { filePath: string }) => Promise<{
    success: boolean;
    exists?: boolean;
    error?: string;
  }>;
  
  /** 获取文件信息 */
  getFileStats: (options: { filePath: string }) => Promise<{
    success: boolean;
    stats?: {
      size: number;
      isDirectory: boolean;
      isFile: boolean;
      created: Date;
      modified: Date;
    };
    error?: string;
  }>;
  
  // ============================================
  // MCP Server 管理
  // ============================================
  
  /** 启动 MCP 服务器 */
  mcpStartServer: (options: {
    type: 'filesystem' | 'puppeteer' | 'sqlite' | 'postgres' | 'custom';
    name: string;
    config: {
      workspacePath?: string;
      dbPath?: string;
      connectionString?: string;
      command?: string;
      args?: string[];
    };
  }) => Promise<{
    success: boolean;
    pid?: number;
    message?: string;
    error?: string;
  }>;
  
  /** 停止 MCP 服务器 */
  mcpStopServer: (options: { name: string }) => Promise<{
    success: boolean;
    error?: string;
  }>;
  
  /** 获取 MCP 服务器状态 */
  mcpGetStatus: () => Promise<{
    success: boolean;
    servers: Array<{
      name: string;
      type: string;
      running: boolean;
      pid?: number;
    }>;
  }>;
  
  /** 停止所有 MCP 服务器 */
  mcpStopAll: () => Promise<{
    success: boolean;
  }>;
  
  /** 刷新 MCP 服务器最后使用时间 */
  mcpTouchServer: (options: { name: string }) => Promise<{ success: boolean }>;
  
  // ============================================
  // 平台信息
  // ============================================
  
  /** 平台类型 */
  platform: 'darwin' | 'win32' | 'linux';
  
  /** 是否是 Electron 环境 */
  isElectron: true;
  /** 监听窗口上下文（roleId/threadId/windowId/primary） */
  onWindowContext: (callback: (payload: {
    roleId?: string;
    threadId?: string;
    windowId?: number;
    primary?: boolean;
  }) => void) => (() => void);
  
  // ============================================
  // 菜单事件
  // ============================================
  /** 创建数字员工窗口 */
  createWorkerWindow: (options?: {
    roleId?: string;
    threadId?: string;
  }) => Promise<{
    success: boolean;
    windowId?: number;
    roleId?: string;
    threadId?: string;
    error?: string;
  }>;
  
  /** 窗口列表 */
  listWindows: () => Promise<Array<{
    id: number;
    title: string;
    primary: boolean;
    roleId: string;
    threadId: string | null;
  }>>;
  
  /** 聚焦指定窗口 */
  focusWindow: (windowId: number) => Promise<{ success: boolean; error?: string }>;
  
  /** 监听菜单事件（返回取消订阅函数） */
  onMenuAction: (callback: (action: string) => void) => (() => void);
  
  /** 移除菜单事件监听 */
  removeMenuActionListener: () => void;

  /** 安全存储写入（可选，Electron 安全存储） */
  secureStoreSet?: (options: { key: string; value: string }) => Promise<{ success?: boolean }>;
  /** 安全存储删除 */
  secureStoreDelete?: (options: { key: string }) => Promise<{ success?: boolean }>;
  /** 安全存储读取 */
  secureStoreGet?: (options: { key: string }) => Promise<{ success?: boolean; value?: string }>;
}

/** 文件树节点 */
export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  size?: number;
  children?: FileTreeNode[];
}

// 扩展 Window 接口
declare global {
  interface Window {
    electron?: ElectronAPI;
  }
}

export {};
