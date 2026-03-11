import { EVENTS } from "./constants";
import { getItem as getStorageItem, setItem as setStorageItem } from "./safeStorage";
import { getCurrentThreadIdFromStorage as getCurrentThreadIdFromSessionUtils } from "./session/sessionUtils";
import { validServerThreadIdOrUndefined } from "./api/langserveChat";

type SessionCreatedPayload = {
  threadId: string;
  title?: string;
  roleId?: string;
  mode?: string;
  workspacePath?: string;
};

type CrossWindowEventType =
  | typeof EVENTS.SESSION_CHANGED
  | typeof EVENTS.SESSION_CREATED
  | "session_cleared"
  | typeof EVENTS.ROLE_CHANGED
  | typeof EVENTS.CHAT_MODE_CHANGED;

type CrossWindowSessionEvent = {
  type: CrossWindowEventType;
  threadId?: string;
  title?: string;
  roleId?: string;
  mode?: string;
  workspacePath?: string;
  sourceTabId: string;
  emittedAt: number;
};

const CROSS_WINDOW_CHANNEL = "maibot_session_sync_v1";
const CROSS_WINDOW_STORAGE_KEY = "__maibot_cross_window_session_event__";
const CROSS_WINDOW_TAB_ID_KEY = "__maibot_cross_window_tab_id__";
let _crossWindowBridgeInited = false;
let _crossWindowChannel: BroadcastChannel | null = null;

function _onCrossWindowStorage(evt: StorageEvent): void {
  if (evt.key !== CROSS_WINDOW_STORAGE_KEY || !evt.newValue) return;
  try {
    const payload = JSON.parse(evt.newValue) as CrossWindowSessionEvent;
    applyCrossWindowSessionEvent(payload);
  } catch {
    // ignore malformed payload
  }
}

function getCrossWindowTabId(): string {
  if (typeof window === "undefined") return "server";
  try {
    const existing = window.sessionStorage.getItem(CROSS_WINDOW_TAB_ID_KEY);
    if (existing) return existing;
    const id = `tab_${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage.setItem(CROSS_WINDOW_TAB_ID_KEY, id);
    return id;
  } catch {
    return `tab_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function _onBroadcastMessage(event: MessageEvent<CrossWindowSessionEvent>): void {
  try {
    applyCrossWindowSessionEvent(event.data);
  } catch {
    // ignore
  }
}

function ensureCrossWindowChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) return null;
  if (!_crossWindowChannel) {
    _crossWindowChannel = new BroadcastChannel(CROSS_WINDOW_CHANNEL);
    _crossWindowChannel.onmessage = _onBroadcastMessage;
  }
  return _crossWindowChannel;
}

function publishCrossWindowSessionEvent(event: Omit<CrossWindowSessionEvent, "sourceTabId" | "emittedAt">): void {
  if (typeof window === "undefined") return;
  const payload: CrossWindowSessionEvent = {
    ...event,
    sourceTabId: getCrossWindowTabId(),
    emittedAt: Date.now(),
  };
  try {
    const ch = ensureCrossWindowChannel();
    if (ch) {
      ch.postMessage(payload);
      return;
    }
  } catch {
    try {
      _crossWindowChannel?.close();
    } catch {
      /* ignore close errors */
    }
    _crossWindowChannel = null;
    // fallback to localStorage event
  }
  try {
    window.localStorage.setItem(CROSS_WINDOW_STORAGE_KEY, JSON.stringify(payload));
    window.localStorage.removeItem(CROSS_WINDOW_STORAGE_KEY);
  } catch {
    // ignore cross-window sync failures
  }
}

/** 无 workspacePath 或空串视为不按工作区过滤，应用事件；有值时仅当与当前工作区一致时应用 */
function shouldApplyCrossWindowEvent(workspacePath?: string): boolean {
  const incoming = String(workspacePath ?? "").trim();
  if (!incoming) return true;
  const current = getCurrentWorkspacePathFromStorage();
  if (!current) return true;
  return incoming === current;
}

/** 约定：仅服务端 UUID 可写入 maibot_current_thread_id / maibot_active_thread 或会话级 key（*_thread_${id}），避免占位 ID 污染 */
function applyCrossWindowSessionEvent(payload: CrossWindowSessionEvent): void {
  if (typeof window === "undefined") return;
  if (!payload || payload.sourceTabId === getCrossWindowTabId()) return;
  if (!shouldApplyCrossWindowEvent(payload.workspacePath)) return;

  const rawThreadId = String(payload.threadId || "").trim();
  const threadId = validServerThreadIdOrUndefined(rawThreadId);
  if (payload.type === "session_cleared") {
    setStorageItem("maibot_current_thread_id", "");
    setStorageItem("maibot_active_thread", "");
    window.dispatchEvent(new CustomEvent(EVENTS.SESSION_CHANGED, { detail: { threadId: "" } }));
    return;
  }
  if (payload.type === EVENTS.ROLE_CHANGED) {
    const roleId = String(payload.roleId || "").trim();
    if (!roleId) return;
    if (threadId) {
      setStorageItem(`maibot_active_role_thread_${threadId}`, roleId);
    } else if (!rawThreadId) {
      setStorageItem("maibot_active_role_default", roleId);
    }
    window.dispatchEvent(
      new CustomEvent(EVENTS.ROLE_CHANGED, {
        detail: { roleId, threadId: threadId ?? undefined, source: "cross_window" },
      }),
    );
    window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
    return;
  }
  if (payload.type === EVENTS.CHAT_MODE_CHANGED) {
    const mode = String(payload.mode || "").trim().toLowerCase();
    if (!mode) return;
    if (threadId) {
      setStorageItem(`maibot_chat_mode_thread_${threadId}`, mode);
    } else if (!rawThreadId) {
      setStorageItem("maibot_chat_mode_default", mode);
    }
    window.dispatchEvent(
      new CustomEvent(EVENTS.CHAT_MODE_CHANGED, {
        detail: { mode, threadId: threadId ?? undefined, source: "cross_window" },
      }),
    );
    window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
    return;
  }
  if (!threadId) return;

  setStorageItem("maibot_current_thread_id", threadId);
  setStorageItem("maibot_active_thread", threadId);
  const detail = {
    threadId,
    title: payload.title || threadId.slice(0, 8),
    roleId: payload.roleId,
    mode: payload.mode,
    workspacePath: payload.workspacePath,
  };
  window.dispatchEvent(new CustomEvent(payload.type === EVENTS.SESSION_CREATED ? EVENTS.SESSION_CREATED : EVENTS.SESSION_CHANGED, { detail }));
}

export function initCrossWindowSessionBridge(): void {
  if (typeof window === "undefined" || _crossWindowBridgeInited) return;
  _crossWindowBridgeInited = true;
  ensureCrossWindowChannel();
  window.addEventListener("storage", _onCrossWindowStorage);
}

/** 清理跨窗口会话桥：关闭 BroadcastChannel、移除 storage 监听器，便于 HMR/测试或单例场景下避免监听器累积。 */
export function closeCrossWindowSessionBridge(): void {
  if (typeof window === "undefined") return;
  if (_crossWindowChannel) {
    try {
      _crossWindowChannel.close();
    } catch {
      // ignore
    }
    _crossWindowChannel = null;
  }
  window.removeEventListener("storage", _onCrossWindowStorage);
  _crossWindowBridgeInited = false;
}

export function activateThreadSession(threadId: string, title?: string): void {
  const normalizedThreadId = validServerThreadIdOrUndefined(threadId);
  if (!normalizedThreadId) return;
  const workspacePath = getCurrentWorkspacePathFromStorage();
  setStorageItem("maibot_current_thread_id", normalizedThreadId);
  setStorageItem("maibot_active_thread", normalizedThreadId);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(EVENTS.SESSION_CHANGED, {
        detail: {
          threadId: normalizedThreadId,
          title: title || normalizedThreadId.slice(0, 8),
          workspacePath: workspacePath || undefined,
        },
      }),
    );
  }
  publishCrossWindowSessionEvent({
    type: EVENTS.SESSION_CHANGED,
    threadId: normalizedThreadId,
    title: title || normalizedThreadId.slice(0, 8),
    workspacePath: workspacePath || undefined,
  });
}

export function getCurrentThreadIdFromStorage(): string {
  return getCurrentThreadIdFromSessionUtils();
}

export function getCurrentWorkspacePathFromStorage(): string {
  return String(getStorageItem("maibot_workspace_path") || "").trim();
}

export function emitSessionCreated(payload: SessionCreatedPayload): void {
  const normalizedThreadId = validServerThreadIdOrUndefined(payload.threadId);
  if (!normalizedThreadId || typeof window === "undefined") return;
  setStorageItem("maibot_current_thread_id", normalizedThreadId);
  setStorageItem("maibot_active_thread", normalizedThreadId);
  const workspacePath = payload.workspacePath || getCurrentWorkspacePathFromStorage() || undefined;
  window.dispatchEvent(
    new CustomEvent(EVENTS.SESSION_CREATED, {
      detail: {
        threadId: normalizedThreadId,
        title: payload.title || normalizedThreadId.slice(0, 8),
        roleId: payload.roleId,
        mode: payload.mode,
        workspacePath,
      },
    }),
  );
  publishCrossWindowSessionEvent({
    type: EVENTS.SESSION_CREATED,
    threadId: normalizedThreadId,
    title: payload.title || normalizedThreadId.slice(0, 8),
    roleId: payload.roleId,
    mode: payload.mode,
    workspacePath,
  });
}

export function clearActiveThreadSession(): void {
  setStorageItem("maibot_current_thread_id", "");
  setStorageItem("maibot_active_thread", "");
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENTS.SESSION_CHANGED, { detail: { threadId: "" } }));
  }
  publishCrossWindowSessionEvent({
    type: "session_cleared",
    workspacePath: getCurrentWorkspacePathFromStorage() || undefined,
  });
}

export function publishRoleChangedCrossWindow(roleId: string, threadId?: string): void {
  const normalizedRoleId = String(roleId || "").trim();
  if (!normalizedRoleId) return;
  const raw = String(threadId ?? getCurrentThreadIdFromStorage() ?? "").trim();
  publishCrossWindowSessionEvent({
    type: EVENTS.ROLE_CHANGED,
    roleId: normalizedRoleId,
    threadId: validServerThreadIdOrUndefined(raw) ?? undefined,
    workspacePath: getCurrentWorkspacePathFromStorage() || undefined,
  });
}

export function publishChatModeChangedCrossWindow(mode: string, threadId?: string): void {
  const normalizedMode = String(mode || "").trim().toLowerCase();
  if (!normalizedMode) return;
  const raw = threadId !== undefined ? String(threadId).trim() : String(getCurrentThreadIdFromStorage() || "").trim();
  publishCrossWindowSessionEvent({
    type: EVENTS.CHAT_MODE_CHANGED,
    mode: normalizedMode,
    threadId: validServerThreadIdOrUndefined(raw) ?? undefined,
    workspacePath: getCurrentWorkspacePathFromStorage() || undefined,
  });
}
