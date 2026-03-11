export function getItem(key: string, fallback = ""): string {
  try {
    if (key == null || (typeof key === "string" && key === "")) return fallback;
    if (typeof window === "undefined") return fallback;
    if (isWindowScopedKey(key)) {
      const scoped = window.sessionStorage.getItem(key);
      if (scoped != null) return scoped;
      const legacy = window.localStorage.getItem(key);
      if (legacy != null) {
        // 兼容旧数据：首次读取时迁移到窗口级存储，避免多标签串扰。
        window.sessionStorage.setItem(key, legacy);
        return legacy;
      }
      return fallback;
    }
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function setItem(key: string, value: string): void {
  try {
    if (key == null || (typeof key === "string" && key === "")) return;
    if (typeof window === "undefined") return;
    if (isWindowScopedKey(key)) {
      window.sessionStorage.setItem(key, value);
      return;
    }
    window.localStorage.setItem(key, value);
  } catch {
    // ignore storage failures (private mode / quota / disabled storage)
  }
}

export function removeItem(key: string): void {
  try {
    if (key == null || (typeof key === "string" && key === "")) return;
    if (typeof window === "undefined") return;
    if (isWindowScopedKey(key)) {
      window.sessionStorage.removeItem(key);
      // 同时清理历史全局键，防止旧逻辑读到残留值。
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

const WINDOW_SCOPED_KEYS = new Set<string>([
  "maibot_current_thread_id",
  "maibot_active_thread",
  "maibot_workspace_path",
  "activeWorkspaceId",
]);

const THREAD_SCOPED_PREFIXES = [
  "maibot_active_role_thread_",
  "maibot_chat_mode_thread_",
  "maibot_session_plugins_thread_",
];
const PRUNE_MARKER_KEY = "maibot_thread_keys_pruned_at";
const PRUNE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const MAX_THREAD_KEYS = 200;

function isWindowScopedKey(key: string): boolean {
  return WINDOW_SCOPED_KEYS.has(key) || THREAD_SCOPED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * 清理过期的会话级 sessionStorage key（thread-scoped 数据存于 sessionStorage），防止无限增长。
 * 策略：每 7 天执行一次，保留最近 MAX_THREAD_KEYS 个 key；始终排除当前活跃线程的 key，避免误删。
 * @param protectedThreadId 当前活跃线程 ID，其对应 key 不参与剪枝
 */
export function pruneThreadScopedKeys(protectedThreadId?: string): void {
  try {
    if (typeof window === "undefined") return;
    const lastPruned = parseInt(window.localStorage.getItem(PRUNE_MARKER_KEY) || "0", 10);
    if (Date.now() - lastPruned < PRUNE_INTERVAL_MS) return;

    const threadKeys: string[] = [];
    const protectedId = String(protectedThreadId || "").trim();
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      if (key && THREAD_SCOPED_PREFIXES.some((p) => key.startsWith(p))) {
        if (protectedId && key.includes(protectedId)) continue;
        threadKeys.push(key);
      }
    }

    if (threadKeys.length > MAX_THREAD_KEYS) {
      threadKeys.sort();
      const toRemove = threadKeys.slice(0, threadKeys.length - MAX_THREAD_KEYS);
      for (const key of toRemove) {
        window.sessionStorage.removeItem(key);
      }
    }

    window.localStorage.setItem(PRUNE_MARKER_KEY, String(Date.now()));
  } catch {
    // ignore
  }
}
