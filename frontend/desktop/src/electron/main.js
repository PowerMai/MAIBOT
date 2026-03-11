const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, shell, safeStorage, powerMonitor, globalShortcut, nativeImage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

// 开发模式检测
const isDev = process.env.NODE_ENV === 'development';

// CSP：生产禁用 unsafe-eval；开发环境为配合 Vite HMR 必须允许 unsafe-eval，Electron 会打印安全警告，打包后不再出现
function setupProductionCSP() {
  if (isDev) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; connect-src 'self' http: https: ws: wss:; font-src 'self' data: https://fonts.gstatic.com;";
    const headers = { ...details.responseHeaders };
    headers['Content-Security-Policy'] = [csp];
    callback({ responseHeaders: headers });
  });
}

// 开发环境：显式设置宽松 CSP（Vite HMR 需要 unsafe-eval/ws），Electron 仍会提示 Insecure CSP，属预期行为
function setupDevCSP() {
  if (!isDev) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; connect-src 'self' http: https: ws: wss: localhost:*; font-src 'self' data: https://fonts.gstatic.com;";
    const headers = { ...details.responseHeaders };
    headers['Content-Security-Policy'] = [csp];
    callback({ responseHeaders: headers });
  });
}

let mainWindow;
const workerWindows = new Map();
let updateState = { status: 'idle', message: '' };
let tray = null;
let idleMonitorTimer = null;
/** 每窗口崩溃后自动 reload 次数，超过后不再自动刷新，避免「打开文件夹后反复重启」 */
const windowReloadAfterCrashCount = new Map();
const MAX_RELOAD_AFTER_CRASH = 1;

function getTargetWindow() {
  return BrowserWindow.getFocusedWindow() || mainWindow;
}

// 崩溃/错误日志：写入 userData，便于用户事后查看（窗口退出太快时）
function getCrashLogPath() {
  return path.join(app.getPath('userData'), 'crash-log.txt');
}

function appendCrashLog(header, body) {
  try {
    const logPath = getCrashLogPath();
    const ts = new Date().toISOString();
    const block = `\n${'='.repeat(60)}\n[${ts}] ${header}\n${'-'.repeat(40)}\n${body}\n`;
    fs.appendFileSync(logPath, block, 'utf-8');
    return logPath;
  } catch (e) {
    console.error('[Electron] 写入崩溃日志失败:', e);
    return null;
  }
}

function showCrashDialog(logPath, shortMessage) {
  const msg = logPath
    ? `${shortMessage}\n\n错误详情已保存到：\n${logPath}\n\n请用记事本打开该文件查看完整信息，或发给开发者排查。`
    : shortMessage;
  dialog.showMessageBox(getTargetWindow() || null, {
    type: 'error',
    title: '应用错误',
    message: '应用遇到错误',
    detail: msg,
    noLink: true,
  }).catch((e) => { if (process.env.NODE_ENV !== 'production') console.warn('[main] showMessageBox failed', e); });
}

function readSecrets() {
  const secretsPath = path.join(app.getPath('userData'), 'secure-secrets.json');
  if (!fs.existsSync(secretsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(secretsPath, 'utf-8')) || {};
  } catch {
    return {};
  }
}

function writeSecrets(data) {
  const secretsPath = path.join(app.getPath('userData'), 'secure-secrets.json');
  fs.writeFileSync(secretsPath, JSON.stringify(data, null, 2), 'utf-8');
}

function encryptText(plain) {
  if (!safeStorage.isEncryptionAvailable()) return plain;
  return safeStorage.encryptString(plain).toString('base64');
}

function decryptText(cipher) {
  if (!cipher) return '';
  if (!safeStorage.isEncryptionAvailable()) return cipher;
  try {
    const buffer = Buffer.from(cipher, 'base64');
    return safeStorage.decryptString(buffer);
  } catch {
    return '';
  }
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.on('checking-for-update', () => {
    updateState = { status: 'checking', message: '正在检查更新' };
    mainWindow?.webContents.send('update-status', updateState);
  });
  autoUpdater.on('update-available', (info) => {
    updateState = { status: 'available', message: `发现新版本 ${info?.version || ''}`.trim() };
    mainWindow?.webContents.send('update-status', updateState);
  });
  autoUpdater.on('update-not-available', () => {
    updateState = { status: 'latest', message: '当前已是最新版本' };
    mainWindow?.webContents.send('update-status', updateState);
  });
  autoUpdater.on('download-progress', (progress) => {
    updateState = { status: 'downloading', message: `下载中 ${Math.round(progress?.percent || 0)}%` };
    mainWindow?.webContents.send('update-status', updateState);
  });
  autoUpdater.on('update-downloaded', () => {
    updateState = { status: 'downloaded', message: '更新已下载，重启后生效' };
    mainWindow?.webContents.send('update-status', updateState);
  });
  autoUpdater.on('error', (error) => {
    updateState = { status: 'error', message: String(error?.message || error || '更新失败') };
    mainWindow?.webContents.send('update-status', updateState);
  });
}

// ============================================
// macOS 菜单配置
// ============================================
function createMenu() {
  const isMac = process.platform === 'darwin';
  
  const template = [
    // macOS 应用菜单
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: '关于 DeepAgent' },
        { type: 'separator' },
        {
          label: '设置...',
          accelerator: 'CmdOrCtrl+,',
          click: () => getTargetWindow()?.webContents.send('menu-action', 'open-settings'),
        },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 DeepAgent' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出 DeepAgent' },
      ],
    }] : []),
    
    // 文件菜单
    {
      label: '文件',
      submenu: [
        {
          label: '新建对话',
          accelerator: 'CmdOrCtrl+N',
          click: () => getTargetWindow()?.webContents.send('menu-action', 'new-chat'),
        },
        {
          label: '新建数字员工窗口',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: async () => {
            await createWindow({ primary: false, roleId: 'digital_worker', threadId: `thread-${Date.now()}` });
          },
        },
        {
          label: '打开文件夹...',
          accelerator: 'CmdOrCtrl+O',
          click: () => getTargetWindow()?.webContents.send('menu-action', 'open-folder'),
        },
        { type: 'separator' },
        {
          label: '保存',
          accelerator: 'CmdOrCtrl+S',
          click: () => getTargetWindow()?.webContents.send('menu-action', 'save'),
        },
        {
          label: '全部保存',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => getTargetWindow()?.webContents.send('menu-action', 'save-all'),
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
      ],
    },
    
    // 编辑菜单
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        ...(isMac ? [
          { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
          { role: 'delete', label: '删除' },
          { role: 'selectAll', label: '全选' },
        ] : [
          { role: 'delete', label: '删除' },
          { type: 'separator' },
          { role: 'selectAll', label: '全选' },
        ]),
        { type: 'separator' },
        {
          label: '查找',
          accelerator: 'CmdOrCtrl+F',
          click: () => getTargetWindow()?.webContents.send('menu-action', 'find'),
        },
        {
          label: '替换',
          accelerator: 'CmdOrCtrl+H',
          click: () => getTargetWindow()?.webContents.send('menu-action', 'replace'),
        },
      ],
    },
    
    // 视图菜单
    {
      label: '视图',
      submenu: [
        {
          label: '切换侧边栏',
          accelerator: 'CmdOrCtrl+B',
          click: () => getTargetWindow()?.webContents.send('menu-action', 'toggle-sidebar'),
        },
        {
          label: '切换聊天面板',
          accelerator: 'CmdOrCtrl+J',
          click: () => getTargetWindow()?.webContents.send('menu-action', 'toggle-chat'),
        },
        { type: 'separator' },
        {
          label: '命令面板',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => getTargetWindow()?.webContents.send('menu-action', 'command-palette'),
        },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' },
      ],
    },
    
    // 对话菜单
    {
      label: '对话',
      submenu: [
        {
          label: '新建对话',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => getTargetWindow()?.webContents.send('menu-action', 'new-chat'),
        },
        {
          label: '停止生成',
          accelerator: 'Escape',
          click: () => getTargetWindow()?.webContents.send('menu-action', 'stop-generation'),
        },
        { type: 'separator' },
        {
          label: '清除对话历史',
          click: () => getTargetWindow()?.webContents.send('menu-action', 'clear-history'),
        },
      ],
    },
    
    // 窗口菜单
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front', label: '全部置于顶层' },
          { type: 'separator' },
          { role: 'window', label: '窗口' },
        ] : [
          { role: 'close', label: '关闭' },
        ]),
      ],
    },
    
    // 帮助菜单
    {
      label: '帮助',
      submenu: [
        {
          label: '文档',
          click: async () => {
            await shell.openExternal('https://docs.ccb.ai');
          },
        },
        {
          label: '快捷键参考',
          accelerator: 'CmdOrCtrl+/',
          click: () => getTargetWindow()?.webContents.send('menu-action', 'show-shortcuts'),
        },
        { type: 'separator' },
        {
          label: '检查更新...',
          click: () => getTargetWindow()?.webContents.send('menu-action', 'check-updates'),
        },
      ],
    },
  ];
  
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createTray() {
  if (tray) return tray;
  const iconCandidates = [
    path.join(__dirname, 'iconTemplate.png'),
    path.join(__dirname, 'icon.png'),
    path.join(__dirname, '../../public/icon.png'),
  ];
  let image = nativeImage.createEmpty();
  for (const p of iconCandidates) {
    if (fs.existsSync(p)) {
      image = nativeImage.createFromPath(p);
      break;
    }
  }
  tray = new Tray(image);
  tray.setToolTip('CCB 智能体');
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: '隐藏主窗口',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.hide();
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => app.quit(),
    },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  return tray;
}

function broadcastPowerEvent(event, detail = {}) {
  const windows = BrowserWindow.getAllWindows();
  windows.forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send('power-event', { event, ...detail });
  });
}

function setupPowerMonitorAndShortcuts() {
  powerMonitor.on('suspend', () => broadcastPowerEvent('suspend'));
  powerMonitor.on('resume', () => broadcastPowerEvent('resume'));
  powerMonitor.on('lock-screen', () => broadcastPowerEvent('lock-screen'));
  powerMonitor.on('unlock-screen', () => broadcastPowerEvent('unlock-screen'));

  if (idleMonitorTimer) clearInterval(idleMonitorTimer);
  idleMonitorTimer = setInterval(() => {
    try {
      const idleSeconds = powerMonitor.getSystemIdleTime();
      const state = powerMonitor.getSystemIdleState(60);
      broadcastPowerEvent('idle-state', { idleSeconds, state });
    } catch (error) {
      console.warn('[Electron] idle monitor error:', String(error?.message || error));
    }
  }, 5000);

  globalShortcut.register('CommandOrControl+Shift+Y', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('menu-action', 'open-settings');
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// 获取 Vite 开发服务器端口
const VITE_DEV_PORT = process.env.VITE_DEV_PORT || 3000;
const IS_MAC = process.platform === 'darwin';
// hiddenInset + 38px 标题栏：x/y 为红绿灯左上角坐标（像素校准）
const MAC_TRAFFIC_LIGHT_POSITION = { x: 13, y: 12 };

const WINDOW_STATE_PATH = path.join(app.getPath('userData'), 'window-state.json');
function readWindowState() {
  try {
    if (fs.existsSync(WINDOW_STATE_PATH)) {
      const raw = fs.readFileSync(WINDOW_STATE_PATH, 'utf-8');
      const state = JSON.parse(raw);
      if (state && typeof state.width === 'number' && typeof state.height === 'number') return state;
    }
  } catch (e) {
    console.warn('[Electron] readWindowState:', e?.message);
  }
  return null;
}
function writeWindowState(bounds) {
  try {
    fs.writeFileSync(WINDOW_STATE_PATH, JSON.stringify(bounds), 'utf-8');
  } catch (e) {
    console.warn('[Electron] writeWindowState:', e?.message);
  }
}

async function createWindow(options = {}) {
  const roleId = options.roleId || 'default';
  const threadId = options.threadId || `thread-${Date.now()}`;
  const isPrimary = !!options.primary;
  const savedState = isPrimary ? readWindowState() : null;
  const win = new BrowserWindow({
    width: savedState?.width ?? 1400,
    height: savedState?.height ?? 900,
    x: savedState?.x,
    y: savedState?.y,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
    },
    // macOS 标题栏样式 + 红绿灯对齐（与前端 38px 标题栏基线一致）
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: IS_MAC ? MAC_TRAFFIC_LIGHT_POSITION : undefined,
    // macOS 使用透明底色以承接 vibrancy，其它平台保持深色底
    backgroundColor: IS_MAC ? '#00000000' : '#0a0a0a',
    vibrancy: IS_MAC ? 'sidebar' : undefined,
    visualEffectState: IS_MAC ? 'active' : undefined,
    show: false,
    // 注：不使用私有 API，避免 macOS 26+ 渲染兼容问题
  });

  // 加载应用
  if (isPrimary) {
    mainWindow = win;
  } else {
    workerWindows.set(win.id, { roleId, threadId });
  }

  if (isDev) {
    // 开发模式直接使用 localhost:3000（Vite 默认端口）
    const devUrl = `http://localhost:${VITE_DEV_PORT}`;
    const http = require('http');
    
    // 等待 Vite 服务器就绪（最多等待 10 秒）
    let serverReady = false;
    for (let i = 0; i < 20; i++) {
      try {
        serverReady = await new Promise((resolve) => {
          const req = http.get(devUrl, (res) => {
            // 只要有响应就认为服务器就绪（状态码 200 或 304）
            resolve(res.statusCode === 200 || res.statusCode === 304);
            res.resume(); // 消耗响应体
          });
          req.on('error', () => resolve(false));
          req.setTimeout(500, () => {
            req.destroy();
            resolve(false);
          });
        });
        
        if (serverReady) {
          console.log(`[Electron] ✅ Vite 开发服务器就绪: ${devUrl}`);
          break;
        }
        
        console.log(`[Electron] ⏳ 等待 Vite 服务器... (${i + 1}/20)`);
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.log(`[Electron] 检测失败:`, e.message);
        await new Promise(r => setTimeout(r, 500));
      }
    }
    
    if (serverReady) {
      try {
        await win.loadURL(devUrl);
        console.log(`[Electron] ✅ 页面加载成功: ${devUrl}`);
      } catch (loadError) {
        console.error('[Electron] ❌ 页面加载失败:', loadError);
        win.loadURL(`data:text/html,<h1>页面加载失败</h1><p>${loadError.message}</p>`);
      }
    } else {
      console.error('[Electron] ❌ Vite 开发服务器未响应');
      win.loadURL(`data:text/html,
        <html>
          <head><style>body{font-family:system-ui;padding:40px;background:#1a1a1a;color:#fff;}</style></head>
          <body>
            <h1>⚠️ 无法连接到开发服务器</h1>
            <p>请确保 Vite 正在运行（npm run dev）</p>
            <p>尝试的地址: ${devUrl}</p>
          </body>
        </html>
      `);
    }
    
    // 开发模式下打开 DevTools（使用 bottom 模式，不影响右键菜单）
    win.webContents.openDevTools({ mode: 'bottom' });
    
    // 启用右键菜单（开发者工具中的 Inspect Element）
    win.webContents.on('context-menu', (event, params) => {
      const { Menu, MenuItem } = require('electron');
      const contextMenu = new Menu();
      
      // 如果选中了文本，添加复制选项
      if (params.selectionText) {
        contextMenu.append(new MenuItem({
          label: '复制',
          role: 'copy',
        }));
        contextMenu.append(new MenuItem({ type: 'separator' }));
      }
      
      // 如果是可编辑区域，添加粘贴选项
      if (params.isEditable) {
        contextMenu.append(new MenuItem({
          label: '粘贴',
          role: 'paste',
        }));
        contextMenu.append(new MenuItem({ type: 'separator' }));
      }
      
      // 开发模式下添加检查元素选项
      contextMenu.append(new MenuItem({
        label: '检查元素',
        click: () => {
          win.webContents.inspectElement(params.x, params.y);
        },
      }));
      
      contextMenu.popup();
    });
  } else {
    win.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  // 处理渲染进程退出（替代已弃用的 'crashed' 事件）
  win.webContents.on('render-process-gone', (event, details) => {
    const reason = details.reason || 'unknown';
    const exitCode = details.exitCode != null ? details.exitCode : '?';
    console.error('[Electron] 渲染进程退出:', reason, exitCode);
    const body = `reason: ${reason}\nexitCode: ${exitCode}\n`;
    const logPath = appendCrashLog('渲染进程退出 (render-process-gone)', body);
    const reloadCount = windowReloadAfterCrashCount.get(win.id) ?? 0;
    const willReload = (reason === 'crashed' || reason === 'killed') && reloadCount < MAX_RELOAD_AFTER_CRASH;
    showCrashDialog(logPath, willReload
      ? `渲染进程异常退出（${reason}），错误已写入日志。关闭本弹窗后窗口将尝试自动刷新。`
      : `渲染进程异常退出（${reason}），错误已写入日志。为避免反复重启，请手动关闭本窗口或重启应用。`);
    if (willReload) {
      windowReloadAfterCrashCount.set(win.id, reloadCount + 1);
      setTimeout(() => {
        if (win && !win.isDestroyed()) {
          win.reload();
        }
      }, 500);
    }
  });
  // 处理页面无响应
  win.webContents.on('unresponsive', () => {
    console.warn('[Electron] 页面无响应');
  });

  // 处理页面恢复响应
  win.webContents.on('responsive', () => {
    console.log('[Electron] 页面恢复响应');
  });

  // 处理页面加载失败
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('[Electron] 页面加载失败:', errorCode, errorDescription, validatedURL);
    // 加载失败时也显示窗口，让用户看到错误
    if (!win.isVisible()) {
      win.show();
    }
  });

  // 页面加载完成后显示（不在此重置崩溃计数，避免「崩溃 → reload → 加载完成重置 → 再崩溃又 reload」的死循环）
  win.webContents.on('did-finish-load', () => {
    console.log('[Electron] 页面加载完成');
    if (!win.isVisible()) {
      win.show();
      win.focus();
    }
    win.webContents.send('window-context', { roleId, threadId, windowId: win.id, primary: isPrimary });
  });
  // 将渲染进程 console 输出透传到主进程日志（便于无 DevTools 场景排查）
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const levelMap = { 0: 'debug', 1: 'info', 2: 'warn', 3: 'error' };
    const lvl = levelMap[level] || `level-${String(level)}`;
    const src = sourceId ? `${sourceId}:${line}` : `line:${line}`;
    console.log(`[Renderer:${lvl}] ${src} ${message}`);
  });

  // 窗口准备好后显示（备用）
  win.once('ready-to-show', () => {
    console.log('[Electron] 窗口准备就绪');
    if (!win.isVisible()) {
      win.show();
      win.focus();
    }
  });

  // 如果 3 秒后窗口还没显示，强制显示
  setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) {
      console.log('[Electron] 强制显示窗口');
      win.show();
      win.focus();
    }
  }, 3000);

  win.on('closed', () => {
    workerWindows.delete(win.id);
    windowReloadAfterCrashCount.delete(win.id);
    if (mainWindow && mainWindow.id === win.id) {
      mainWindow = null;
    }
  });

  if (isPrimary) {
    const saveState = () => {
      if (win.isDestroyed()) return;
      const b = win.getBounds();
      writeWindowState({ x: b.x, y: b.y, width: b.width, height: b.height });
    };
    win.on('move', saveState);
    win.on('resize', saveState);
  }

  // 全屏状态变化时通知渲染进程（用于 macOS 红绿灯区域适配）
  win.on('enter-full-screen', () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('fullscreen-change', true);
    }
  });
  win.on('leave-full-screen', () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('fullscreen-change', false);
    }
  });
  return win;
}

// 应用准备就绪
app.whenReady().then(async () => {
  setupProductionCSP();
  setupDevCSP();
  // 禁用 macOS 的一些警告
  if (process.platform === 'darwin') {
    // 禁用 GPU 加速可以解决一些 macOS 兼容性问题
    // app.disableHardwareAcceleration();
  }
  
  createMenu();
  createTray();
  if (IS_MAC) {
    app.dock.setMenu(Menu.buildFromTemplate([
      { label: '新建对话', click: () => mainWindow?.webContents.send('menu-action', 'new-chat') },
      { label: '新建数字员工窗口', click: () => createWindow({ primary: false, roleId: 'digital_worker' }) },
    ]));
  }
  setupPowerMonitorAndShortcuts();
  setupAutoUpdater();
  await createWindow({ primary: true, roleId: 'main_assistant', threadId: `thread-${Date.now()}` });

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow({ primary: true, roleId: 'main_assistant', threadId: `thread-${Date.now()}` });
    }
  });
});

ipcMain.handle('window-create-worker', async (_event, payload = {}) => {
  try {
    const roleId = String(payload.roleId || 'digital_worker');
    const threadId = String(payload.threadId || `thread-${Date.now()}`);
    const win = await createWindow({ primary: false, roleId, threadId });
    return { success: true, windowId: win.id, roleId, threadId };
  } catch (error) {
    return { success: false, error: String(error?.message || error) };
  }
});

ipcMain.handle('window-list', async () => {
  const list = [];
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const meta = mainWindow && win.id === mainWindow.id
      ? { primary: true, roleId: 'main_assistant', threadId: null }
      : workerWindows.get(win.id) || { primary: false, roleId: 'default', threadId: null };
    list.push({
      id: win.id,
      title: win.getTitle(),
      primary: !!meta.primary,
      roleId: meta.roleId || 'default',
      threadId: meta.threadId || null,
    });
  }
  return list;
});

ipcMain.handle('window-focus', async (_event, { windowId }) => {
  const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.id === windowId);
  if (win) {
    win.focus();
    return { success: true };
  }
  return { success: false, error: 'Window not found' };
});

ipcMain.handle('secure-store-set', async (_event, { key, value }) => {
  const data = readSecrets();
  data[String(key)] = encryptText(String(value || ''));
  writeSecrets(data);
  return { success: true };
});

ipcMain.handle('secure-store-get', async (_event, { key }) => {
  const data = readSecrets();
  const value = decryptText(String(data[String(key)] || ''));
  return { success: true, value };
});

ipcMain.handle('secure-store-delete', async (_event, { key }) => {
  const data = readSecrets();
  delete data[String(key)];
  writeSecrets(data);
  return { success: true };
});

ipcMain.handle('check-for-updates', async () => {
  try {
    await autoUpdater.checkForUpdates();
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error?.message || error) };
  }
});

ipcMain.handle('download-update', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error?.message || error) };
  }
});

ipcMain.handle('install-update', async () => {
  autoUpdater.quitAndInstall();
  return { success: true };
});

ipcMain.handle('get-update-status', async () => ({ success: true, ...updateState }));

// 所有窗口关闭时退出（macOS 除外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 应用退出前清理
app.on('before-quit', () => {
  console.log('[Electron] 应用即将退出，清理资源...');
  // 确保所有窗口都被正确关闭
  const windows = BrowserWindow.getAllWindows();
  windows.forEach(win => {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  });
});

// 应用退出时的最终清理
app.on('will-quit', (event) => {
  console.log('[Electron] 应用退出');
  if (idleMonitorTimer) {
    clearInterval(idleMonitorTimer);
    idleMonitorTimer = null;
  }
  globalShortcut.unregisterAll();
});

// 未捕获异常/未处理拒绝后延迟退出，便于用户查看弹窗并复制日志路径（Node 注册 listener 后不会自动退出，需显式 exit）
const CRASH_EXIT_DELAY_MS = 5000;
function scheduleCrashExit() {
  setTimeout(() => {
    try {
      process.exit(1);
    } catch {
      process.exit(1);
    }
  }, CRASH_EXIT_DELAY_MS);
}

// 处理未捕获的异常（写入日志并弹窗，便于用户抓取报错）
process.on('uncaughtException', (error) => {
  console.error('[Electron] 未捕获的异常:', error);
  const message = error?.message ?? String(error);
  const stack = error?.stack ?? '';
  const logPath = appendCrashLog('主进程未捕获异常 (uncaughtException)', `${message}\n\n${stack}`);
  showCrashDialog(logPath, `主进程发生未捕获异常：${message.slice(0, 200)}${message.length > 200 ? '…' : ''}`);
  scheduleCrashExit();
});

// 处理未处理的 Promise 拒绝（写入日志并弹窗）
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Electron] 未处理的 Promise 拒绝:', reason);
  const text = reason instanceof Error ? `${reason.message}\n\n${reason.stack || ''}` : String(reason);
  const logPath = appendCrashLog('主进程未处理 Promise 拒绝 (unhandledRejection)', text);
  showCrashDialog(logPath, `未处理的 Promise 错误：${text.slice(0, 200)}${text.length > 200 ? '…' : ''}`);
  scheduleCrashExit();
});

// ============================================
// IPC 处理器 - 窗口状态
// ============================================

// 渲染进程上报错误到主进程并写入崩溃日志（窗口退出前可先持久化，便于用户事后查看）
ipcMain.handle('renderer-report-crash', (_event, { message = '', stack = '', source = 'renderer' }) => {
  const body = `${message}\n\n${stack || '(无堆栈)'}`;
  const logPath = appendCrashLog(`渲染进程错误 (${source})`, body);
  return { logPath };
});

// 查询是否全屏（渲染进程用于 macOS 红绿灯 padding 适配）
ipcMain.handle('is-fullscreen', (event) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  return w ? w.isFullScreen() : false;
});

// ============================================
// IPC 处理器 - 文件系统操作
// ============================================

// 选择目录（使用发起请求的窗口作为对话框父窗口，避免新建窗口/主窗口已关时错用 mainWindow 导致异常或“重启”感）
ipcMain.handle('select-directory', async (event) => {
  try {
    const parentWin = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const result = await dialog.showOpenDialog(parentWin, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择工作区文件夹',
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    return { success: true, path: result.filePaths[0] };
  } catch (error) {
    console.error('select-directory error:', error);
    return { success: false, error: error.message };
  }
});

// 读取目录结构（主进程侧限制最大深度，避免大仓库 OOM 或长时间阻塞）
const READ_DIRECTORY_MAX_DEPTH = 5;
ipcMain.handle('read-directory', async (event, opts = {}) => {
  const dirPath = opts && typeof opts.dirPath === 'string' ? opts.dirPath : null;
  if (!dirPath) {
    return { success: false, error: 'Invalid or missing dirPath' };
  }
  const requested = typeof opts.depth === 'number' && opts.depth >= 0 ? opts.depth : 3;
  const depth = Math.min(requested, READ_DIRECTORY_MAX_DEPTH);
  try {
    const tree = await readDirectoryRecursive(dirPath, depth);
    return { success: true, tree };
  } catch (error) {
    console.error('read-directory error:', error);
    return { success: false, error: error.message };
  }
});

// 递归读取目录
async function readDirectoryRecursive(dirPath, maxDepth, currentDepth = 0) {
  const stats = fs.statSync(dirPath);
  const name = path.basename(dirPath);
  
  // 注意：前端期望 type 为 'folder' 而不是 'directory'
  const node = {
    name,
    path: dirPath,
    type: stats.isDirectory() ? 'folder' : 'file',
    size: stats.size,
  };

  if (stats.isDirectory() && currentDepth < maxDepth) {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      // 过滤隐藏文件和 node_modules
      const filtered = entries.filter(entry => 
        !entry.name.startsWith('.') && 
        entry.name !== 'node_modules' &&
        entry.name !== '__pycache__' &&
        entry.name !== '.git'
      );
      
      // 排序：目录在前，文件在后
      filtered.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

      node.children = await Promise.all(
        filtered.map(entry => 
          readDirectoryRecursive(
            path.join(dirPath, entry.name), 
            maxDepth, 
            currentDepth + 1
          )
        )
      );
    } catch (err) {
      console.warn(`Cannot read directory ${dirPath}:`, err.message);
      node.children = [];
    }
  }

  return node;
}

// 读取文件内容（文本）
ipcMain.handle('read-file', async (event, opts = {}) => {
  const filePath = opts && typeof opts.filePath === 'string' ? opts.filePath : null;
  if (!filePath) {
    return { success: false, error: 'Invalid or missing filePath' };
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { success: true, content };
  } catch (error) {
    console.error('read-file error:', error);
    return { success: false, error: error.message };
  }
});

// 读取文件内容（二进制，返回 base64）
ipcMain.handle('read-file-binary', async (event, opts = {}) => {
  const filePath = opts && typeof opts.filePath === 'string' ? opts.filePath : null;
  if (!filePath) {
    return { success: false, error: 'Invalid or missing filePath' };
  }
  try {
    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString('base64');
    return { success: true, base64, size: buffer.length };
  } catch (error) {
    console.error('read-file-binary error:', error);
    return { success: false, error: error.message };
  }
});

// 写入文件
ipcMain.handle('write-file', async (event, opts = {}) => {
  const filePath = opts && typeof opts.filePath === 'string' ? opts.filePath : null;
  if (!filePath) {
    return { success: false, error: 'Invalid or missing filePath' };
  }
  const content = opts.content;
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  } catch (error) {
    console.error('write-file error:', error);
    const msg = (error && error.message) || String(error);
    return { success: false, error: msg };
  }
});

// 写入二进制文件（base64）
ipcMain.handle('write-file-binary', async (event, opts = {}) => {
  const filePath = opts && typeof opts.filePath === 'string' ? opts.filePath : null;
  if (!filePath) {
    return { success: false, error: 'Invalid or missing filePath' };
  }
  const contentBase64 = opts && typeof opts.base64 === 'string' ? opts.base64 : '';
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const buf = Buffer.from(contentBase64, 'base64');
    fs.writeFileSync(filePath, buf);
    return { success: true };
  } catch (error) {
    console.error('write-file-binary error:', error);
    const msg = (error && error.message) || String(error);
    return { success: false, error: msg };
  }
});

// 创建目录
ipcMain.handle('create-directory', async (event, opts = {}) => {
  const dirPath = opts && typeof opts.dirPath === 'string' ? opts.dirPath : null;
  if (!dirPath) {
    return { success: false, error: 'Invalid or missing dirPath' };
  }
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    return { success: true };
  } catch (error) {
    console.error('create-directory error:', error);
    return { success: false, error: error.message };
  }
});

// 删除文件或目录
ipcMain.handle('delete-file', async (event, opts = {}) => {
  const filePath = opts && typeof opts.filePath === 'string' ? opts.filePath : null;
  if (!filePath) {
    return { success: false, error: 'Invalid or missing filePath' };
  }
  try {
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      fs.rmSync(filePath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(filePath);
    }
    return { success: true };
  } catch (error) {
    console.error('delete-file error:', error);
    return { success: false, error: error.message };
  }
});

// 重命名文件或目录
ipcMain.handle('rename-file', async (event, opts = {}) => {
  const oldPath = opts && typeof opts.oldPath === 'string' ? opts.oldPath : null;
  const newPath = opts && typeof opts.newPath === 'string' ? opts.newPath : null;
  if (!oldPath || !newPath) {
    return { success: false, error: 'Invalid or missing oldPath/newPath' };
  }
  try {
    fs.renameSync(oldPath, newPath);
    return { success: true };
  } catch (error) {
    console.error('rename-file error:', error);
    return { success: false, error: error.message };
  }
});

// 检查文件是否存在
ipcMain.handle('file-exists', async (event, opts = {}) => {
  const filePath = opts && typeof opts.filePath === 'string' ? opts.filePath : null;
  if (!filePath) {
    return { success: false, error: 'Invalid or missing filePath' };
  }
  try {
    return { success: true, exists: fs.existsSync(filePath) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 获取文件信息
ipcMain.handle('get-file-stats', async (event, opts = {}) => {
  const filePath = opts && typeof opts.filePath === 'string' ? opts.filePath : null;
  if (!filePath) {
    return { success: false, error: 'Invalid or missing filePath' };
  }
  try {
    const stats = fs.statSync(filePath);
    return {
      success: true,
      stats: {
        size: stats.size,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        created: stats.birthtime,
        modified: stats.mtime,
      },
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ============================================
// MCP Server 管理（可选，用于云端部署模式）
// ============================================

const MAX_MCP_SERVERS = parseInt(process.env.MAX_MCP_SERVERS || '3', 10);
const MCP_IDLE_CLOSE_MS = 5 * 60 * 1000; // 5 分钟无活动自动关闭
const MCP_IDLE_CHECK_INTERVAL_MS = 60 * 1000; // 每分钟检查一次

const mcpServers = new Map(); // name -> { process, type, config, lastUsedAt }

function closeMcpServer(name) {
  const server = mcpServers.get(name);
  if (server && !server.process.killed) {
    server.process.kill('SIGTERM');
    mcpServers.delete(name);
    console.log(`[MCP] Stopped idle server: ${name}`);
  }
}

function closeOldestMcpServer() {
  let oldestName = null;
  let oldestAt = Infinity;
  for (const [n, s] of mcpServers) {
    if (s.lastUsedAt < oldestAt) {
      oldestAt = s.lastUsedAt;
      oldestName = n;
    }
  }
  if (oldestName != null) closeMcpServer(oldestName);
}

// 启动 MCP 服务器
ipcMain.handle('mcp-start-server', async (event, { type, name, config }) => {
  try {
    if (mcpServers.has(name)) {
      const s = mcpServers.get(name);
      s.lastUsedAt = Date.now();
      return { success: true, message: `Server ${name} already running` };
    }
    if (mcpServers.size >= MAX_MCP_SERVERS) {
      closeOldestMcpServer();
      if (mcpServers.size >= MAX_MCP_SERVERS) {
        return { success: false, error: `Max MCP servers reached (${MAX_MCP_SERVERS}). Stop one before starting another.` };
      }
    }

    let command, args;

    switch (type) {
      case 'filesystem':
        command = 'npx';
        args = ['-y', '@modelcontextprotocol/server-filesystem', config.workspacePath || '.'];
        break;
      case 'puppeteer':
        command = 'npx';
        args = ['-y', '@modelcontextprotocol/server-puppeteer'];
        break;
      case 'sqlite':
        command = 'npx';
        args = ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', config.dbPath || ':memory:'];
        break;
      default:
        return { success: false, error: `Unknown server type: ${type}` };
    }

    const { spawn } = require('child_process');
    const serverProcess = spawn(command, args, {
      stdio: 'pipe',
      shell: true,
    });

    const now = Date.now();
    mcpServers.set(name, { process: serverProcess, type, config, lastUsedAt: now });

    serverProcess.on('error', (error) => {
      console.error(`[MCP] Server ${name} error:`, error);
      mcpServers.delete(name);
    });

    serverProcess.on('exit', (code) => {
      console.log(`[MCP] Server ${name} exited with code ${code}`);
      mcpServers.delete(name);
    });

    console.log(`[MCP] Started ${type} server: ${name}`);
    return { success: true, pid: serverProcess.pid };
  } catch (error) {
    console.error('mcp-start-server error:', error);
    return { success: false, error: error.message };
  }
});

// 刷新 MCP 服务器“最后使用”时间，避免被空闲关闭
ipcMain.handle('mcp-touch-server', async (event, { name }) => {
  const s = mcpServers.get(name);
  if (s) s.lastUsedAt = Date.now();
  return { success: true };
});

// 停止 MCP 服务器
ipcMain.handle('mcp-stop-server', async (event, { name }) => {
  try {
    const server = mcpServers.get(name);
    if (server) {
      server.process.kill('SIGTERM');
      mcpServers.delete(name);
      console.log(`[MCP] Stopped server: ${name}`);
      return { success: true };
    }
    return { success: false, error: `Server ${name} not found` };
  } catch (error) {
    console.error('mcp-stop-server error:', error);
    return { success: false, error: error.message };
  }
});

// 空闲超过 5 分钟自动关闭
const mcpIdleTimer = setInterval(() => {
  const now = Date.now();
  for (const [name, server] of mcpServers) {
    if (server.process.killed) continue;
    if (now - server.lastUsedAt >= MCP_IDLE_CLOSE_MS) {
      closeMcpServer(name);
      break; // 一次只关一个，避免并发问题
    }
  }
}, MCP_IDLE_CHECK_INTERVAL_MS);
mcpIdleTimer.unref();

// 获取 MCP 服务器状态
ipcMain.handle('mcp-get-status', async () => {
  const status = [];
  for (const [name, server] of mcpServers) {
    status.push({
      name,
      type: server.type,
      running: !server.process.killed,
      pid: server.process.pid,
    });
  }
  return { success: true, servers: status };
});

// 停止所有 MCP 服务器
ipcMain.handle('mcp-stop-all', async () => {
  for (const [name, server] of mcpServers) {
    server.process.kill('SIGTERM');
    console.log(`[MCP] Stopped server: ${name}`);
  }
  mcpServers.clear();
  return { success: true };
});

// 应用退出时停止所有 MCP 服务器
app.on('before-quit', () => {
  clearInterval(mcpIdleTimer);
  for (const [name, server] of mcpServers) {
    server.process.kill('SIGTERM');
  }
  mcpServers.clear();
});

console.log('Electron main process started');
