import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { validServerThreadIdOrUndefined } from './lib/api/langserveChat';
import { pruneThreadScopedKeys } from './lib/safeStorage';
import { getCurrentThreadIdFromStorage } from './lib/sessionState';
import { migrateLegacyRoleStorage } from './lib/roleIdentity';
import './styles/globals.css';

// 在开发模式下禁用 StrictMode 以避免双重渲染问题
// StrictMode 会导致 useEffect 执行两次，可能导致 WebSocket 连接问题
const isDev = import.meta.env?.DEV;

// 开发环境：最近 N 条错误供控制台查看（便于出问题后及时修复）
const DEV_ERROR_LOG_MAX = 50;
declare global {
  interface Window {
    __DEV_ERRORS__?: Array<{ t: number; message: string; source?: string; stack?: string }>;
  }
}

function devErrorPush(message: string, source?: string, stack?: string) {
  if (!isDev || typeof window === 'undefined') return;
  const msg = String(message ?? '').slice(0, 500);
  if (!window.__DEV_ERRORS__) window.__DEV_ERRORS__ = [];
  const entry = {
    t: Date.now(),
    message: msg,
    source: source?.slice(0, 200),
    stack: stack?.slice(0, 1000),
  };
  window.__DEV_ERRORS__.push(entry);
  if (window.__DEV_ERRORS__.length > DEV_ERROR_LOG_MAX) window.__DEV_ERRORS__.shift();
}

/** 获取当前会话/线程 ID（用于崩溃日志关联）；仅返回服务端 UUID，避免占位 ID 写入日志 */
function getCurrentThreadIdForLog(): string {
  try {
    if (typeof window === 'undefined') return '';
    const tid = validServerThreadIdOrUndefined(getCurrentThreadIdFromStorage());
    return tid ? tid.slice(0, 36) : '';
  } catch {
    return '';
  }
}

/** 前端错误上报：开发环境也 POST 到后端 .cursor/frontend-error.log 便于排查；生产环境同。崩溃后可根据 thread_id、stack 定位。 */
function reportFrontendError(detail: { message: string; source?: string; lineno?: number; colno?: number; stack?: string; thread_id?: string }) {
  if (isDev) devErrorPush(detail.message, detail.source, detail.stack);
  try {
    if (!isDev) console.warn('[FrontendError]', detail.message, detail.source || '', detail.lineno ?? '', detail.colno ?? '', detail.thread_id ?? '');
    const payload = {
      message: detail.message.slice(0, 500),
      source: (detail.source || '').slice(0, 200),
      lineno: detail.lineno,
      colno: detail.colno,
      stack: (detail.stack || '').slice(0, 2000),
      thread_id: detail.thread_id || getCurrentThreadIdForLog(),
      ts: Date.now(),
    };
    let apiBase = '';
    try {
      if (typeof window !== 'undefined') {
        apiBase = String((window as any).__LANGGRAPH_API_URL__ || localStorage.getItem('maibot_settings_baseURL') || 'http://127.0.0.1:2024').trim().replace(/\/$/, '');
      }
    } catch {
      apiBase = 'http://127.0.0.1:2024';
    }
    if (apiBase) {
      fetch(`${apiBase}/log/frontend-error`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch((err) => { if (import.meta.env?.DEV) console.warn('[main] frontend-error report failed', err); });
    }
  } catch {
    // ignore
  }
}

// ============================================================
// 全局错误处理（生产级健壮性）
// ============================================================

// 未捕获的 JavaScript 错误（多次会话后崩溃时可从 .cursor/frontend-error.log 查 thread_id、stack）
window.onerror = (message, source, lineno, colno, error) => {
  const detail = {
    message: String(message ?? error?.message ?? '未知前端错误'),
    source: source ? String(source) : '',
    lineno,
    colno,
    stack: (error && typeof error === 'object' && 'stack' in error) ? String((error as Error).stack) : undefined,
    thread_id: getCurrentThreadIdForLog(),
  };
  console.error('[Global] 未捕获错误:', { message, source, lineno, colno, thread_id: detail.thread_id });
  if (isDev && detail.stack) devErrorPush(detail.message, detail.source, detail.stack);
  try {
    window.dispatchEvent(new CustomEvent('renderer_runtime_error', { detail }));
    reportFrontendError(detail);
    const body = `${detail.message}\n${detail.source ? `  at ${detail.source}:${lineno}:${colno}\n` : ''}${detail.stack ?? ''}`;
    (window as unknown as { electron?: { reportCrash?: (p: { message: string; stack?: string; source: string }) => void } }).electron?.reportCrash?.({ message: detail.message, stack: body, source: 'onerror' });
  } catch {
    // ignore
  }
  
  // 检测内存相关错误
  const errorMsg = String(message).toLowerCase();
  if (errorMsg.includes('out of memory') || errorMsg.includes('allocation failed')) {
    console.warn('[Global] 检测到内存问题，尝试清理...');
    cleanupMemory();
  }
  
  // 返回 true 阻止默认处理（避免控制台重复报错）
  return false;
};

// 未处理的 Promise 拒绝
window.onunhandledrejection = (event) => {
  const reason = event.reason;
  const message =
    (reason && typeof reason === 'object' && 'message' in reason && typeof reason.message === 'string')
      ? reason.message
      : String(reason ?? '未知 Promise 错误');
  // assistant-ui 在流式/热更后可能触发 reload，当前 runtime 不支持，静默处理避免刷屏
  if (/Runtime does not support reloading messages|does not support reloading/i.test(message)) {
    event.preventDefault();
    if (isDev) console.warn('[Global] 已忽略不支持的 reload 请求:', message);
    return;
  }
  const stack = (event.reason && typeof event.reason === 'object' && 'stack' in event.reason) ? String((event.reason as Error).stack) : undefined;
  console.error('[Global] 未处理的 Promise 拒绝:', event.reason);
  if (isDev) devErrorPush(message, undefined, stack);
  try {
    window.dispatchEvent(new CustomEvent('renderer_runtime_error', { detail: { message, stack } }));
    reportFrontendError({ message, stack, thread_id: getCurrentThreadIdForLog() });
    // Electron：在窗口可能退出前写入崩溃日志，便于用户事后查看
    (window as unknown as { electron?: { reportCrash?: (p: { message: string; stack?: string; source: string }) => void } }).electron?.reportCrash?.({ message, stack: stack ?? '', source: 'unhandledrejection' });
  } catch {
    // ignore
  }
  
  // 网络错误不需要特殊处理
  if (event.reason?.name === 'AbortError' || event.reason?.message?.includes('fetch')) {
    return;
  }
  
  // 阻止默认处理
  event.preventDefault();
};

// 内存清理函数
function cleanupMemory() {
  try {
    // 清理大型 localStorage 缓存
    const keysToCheck = ['chat_sessions', 'file_cache', 'maibot_thread_history', 'editor_content'];
    keysToCheck.forEach(key => {
      try {
        const item = localStorage.getItem(key);
        if (item && item.length > 100000) { // >100KB
          localStorage.removeItem(key);
          console.log(`[Global] 已清理 localStorage: ${key}`);
        }
      } catch (e) {
        // 忽略
      }
    });
    
    // 触发 GC（如果可用）
    if ((window as any).gc) {
      (window as any).gc();
    }
  } catch (e) {
    console.warn('[Global] 内存清理失败:', e);
  }
}

// 本地存储键迁移：ccb_ -> maibot_
function migrateLegacyStorageKeys() {
  try {
    const migrationKey = 'maibot_storage_migrated_v1';
    if (localStorage.getItem(migrationKey) === 'true') return;

    const keysToMigrate: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith('ccb_')) keysToMigrate.push(key);
    }

    keysToMigrate.forEach((oldKey) => {
      const newKey = oldKey.replace(/^ccb_/, 'maibot_');
      if (!localStorage.getItem(newKey)) {
        const value = localStorage.getItem(oldKey);
        if (value !== null) localStorage.setItem(newKey, value);
      }
      localStorage.removeItem(oldKey);
    });

    localStorage.setItem(migrationKey, 'true');
  } catch (e) {
    console.warn('[Global] localStorage 迁移失败:', e);
  }
}

// 页面可见性变化时清理（用户切换标签页回来时）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // 页面重新可见，检查内存
    if ((performance as any).memory) {
      const mem = (performance as any).memory;
      const usedMB = Math.round(mem.usedJSHeapSize / 1024 / 1024);
      const limitMB = Math.round(mem.jsHeapSizeLimit / 1024 / 1024);
      
      // 如果使用超过 80% 的堆内存，执行清理
      if (usedMB / limitMB > 0.8) {
        console.warn(`[Global] 内存使用较高 (${usedMB}MB/${limitMB}MB)，执行清理`);
        cleanupMemory();
      }
    }
  }
});

migrateLegacyStorageKeys();
migrateLegacyRoleStorage();
pruneThreadScopedKeys(validServerThreadIdOrUndefined(getCurrentThreadIdFromStorage()) ?? undefined);

// ============================================================
// 渲染应用（深色模式由 index.html 内联脚本在首屏前恢复，避免 FOUC）
// ============================================================

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary
    onError={(error, errorInfo) => {
      console.error('[App] 全局错误:', error.message);
      if (isDev) {
        console.error('[App] 组件堆栈:', errorInfo?.componentStack?.slice(0, 500));
        devErrorPush(
          error.message,
          'ErrorBoundary',
          [error.stack, errorInfo?.componentStack].filter(Boolean).join('\n'),
        );
      }
      reportFrontendError({
        message: error.message,
        source: `ErrorBoundary: ${(errorInfo?.componentStack ?? '').slice(0, 150)}`,
      });
    }}
  >
    {isDev ? (
      <App />
    ) : (
      <React.StrictMode>
        <App />
      </React.StrictMode>
    )}
  </ErrorBoundary>
);

