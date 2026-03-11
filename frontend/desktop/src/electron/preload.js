const { contextBridge, ipcRenderer } = require('electron');

// 暴露安全的 API 到渲染进程
contextBridge.exposeInMainWorld('electron', {
  // 选择目录
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  
  // 读取目录结构
  readDirectory: (options) => ipcRenderer.invoke('read-directory', options),
  
  // 读取文件（文本）
  readFile: (options) => ipcRenderer.invoke('read-file', options),
  
  // 读取文件（二进制，返回 base64）
  readFileBinary: (options) => ipcRenderer.invoke('read-file-binary', options),
  
  // 写入文件
  writeFile: (options) => ipcRenderer.invoke('write-file', options),
  // 写入二进制文件（base64）
  writeFileBinary: (options) => ipcRenderer.invoke('write-file-binary', options),
  
  // 创建目录
  createDirectory: (options) => ipcRenderer.invoke('create-directory', options),
  
  // 删除文件或目录
  deleteFile: (options) => ipcRenderer.invoke('delete-file', options),
  
  // 重命名文件或目录
  renameFile: (options) => ipcRenderer.invoke('rename-file', options),
  
  // 检查文件是否存在
  fileExists: (options) => ipcRenderer.invoke('file-exists', options),
  
  // 获取文件信息
  getFileStats: (options) => ipcRenderer.invoke('get-file-stats', options),
  
  // 平台信息
  platform: process.platform,
  
  // 是否是 Electron 环境
  isElectron: true,

  // 全屏状态（用于 macOS 红绿灯区域适配）
  isFullScreen: () => ipcRenderer.invoke('is-fullscreen'),
  onFullScreenChange: (callback) => {
    const handler = (_event, isFullScreen) => callback(isFullScreen);
    ipcRenderer.on('fullscreen-change', handler);
    return () => ipcRenderer.removeListener('fullscreen-change', handler);
  },
  onWindowContext: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('window-context', handler);
    return () => ipcRenderer.removeListener('window-context', handler);
  },

  // 菜单事件监听（去重：先移除再注册，避免叠加）
  onMenuAction: (callback) => {
    ipcRenderer.removeAllListeners('menu-action');
    const handler = (_event, action) => callback(action);
    ipcRenderer.on('menu-action', handler);
    return () => ipcRenderer.removeListener('menu-action', handler);
  },
  removeMenuActionListener: () => ipcRenderer.removeAllListeners('menu-action'),
  
  // ============================================
  // MCP Server 管理 API
  // ============================================
  
  // 启动 MCP 服务器
  mcpStartServer: (options) => ipcRenderer.invoke('mcp-start-server', options),
  
  // 停止 MCP 服务器
  mcpStopServer: (options) => ipcRenderer.invoke('mcp-stop-server', options),
  
  // 获取 MCP 服务器状态
  mcpGetStatus: () => ipcRenderer.invoke('mcp-get-status'),
  
  // 停止所有 MCP 服务器
  mcpStopAll: () => ipcRenderer.invoke('mcp-stop-all'),

  // 安全存储（API Key 等敏感信息）
  secureStoreSet: (options) => ipcRenderer.invoke('secure-store-set', options),
  secureStoreGet: (options) => ipcRenderer.invoke('secure-store-get', options),
  secureStoreDelete: (options) => ipcRenderer.invoke('secure-store-delete', options),

  // 自动更新
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  // 多窗口
  createWorkerWindow: (options) => ipcRenderer.invoke('window-create-worker', options),
  listWindows: () => ipcRenderer.invoke('window-list'),
  focusWindow: (windowId) => ipcRenderer.invoke('window-focus', { windowId }),

  // 刷新 MCP 服务器最后使用时间
  mcpTouchServer: (options) => ipcRenderer.invoke('mcp-touch-server', options),
  onUpdateStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('update-status', handler);
    return () => ipcRenderer.removeListener('update-status', handler);
  },

  // 渲染进程上报错误到主进程并写入崩溃日志（便于窗口退出后查看）
  reportCrash: (payload) => ipcRenderer.invoke('renderer-report-crash', payload),
});

console.log('Electron preload script loaded');
// 开发环境：提示 CSP 警告与 chunk 404 的已知说明，避免误判
if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'development') {
  console.info(
    '%c[Electron 开发环境] 上方「Insecure Content-Security-Policy」属预期（Vite 热更新需要 unsafe-eval），打包后消失。若出现 chunk 404，请在 frontend/desktop 下执行: pnpm run dev:fresh 后重新启动 electron:dev。',
    'color: #666; font-size: 11px;'
  );
}
