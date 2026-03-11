"use client";

import React from "react";
import { EVENTS, type SessionChangedDetail } from "../constants";
import { getCurrentThreadIdFromStorage, getCurrentWorkspacePathFromStorage } from "../sessionState";
import { getScopedActiveRoleIdFromStorage, setScopedActiveRoleIdInStorage, normalizeRoleId } from "../roleIdentity";
import {
  resolveScopedChatMode,
  setScopedChatMode,
  type ChatMode,
} from "../chatModeState";

export interface SessionContextValue {
  threadId: string;
  roleId: string;
  chatMode: ChatMode;
  workspacePath: string;
  setRole: (roleId: string) => void;
  setMode: (mode: string) => void;
}

const SessionContext = React.createContext<SessionContextValue | null>(null);

const SESSION_STORAGE_KEYS = new Set([
  "maibot_current_thread_id",
  "maibot_active_thread",
  "maibot_workspace_path",
  "maibot_chat_mode_default",
]);

function isSessionStorageKey(key: string | null): boolean {
  return key != null && (SESSION_STORAGE_KEYS.has(key) || key.startsWith("maibot_active_role_thread_") || key.startsWith("maibot_chat_mode_thread_"));
}

function readSessionFromStorage(): Omit<SessionContextValue, "setRole" | "setMode"> {
  const threadId = getCurrentThreadIdFromStorage();
  const roleId = getScopedActiveRoleIdFromStorage();
  const chatMode = resolveScopedChatMode(threadId || undefined);
  const workspacePath = getCurrentWorkspacePathFromStorage();
  return { threadId: threadId || "", roleId, chatMode, workspacePath };
}

export function SessionContextProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState(readSessionFromStorage);

  const syncFromStorage = React.useCallback(() => {
    try {
      setSession(readSessionFromStorage());
    } catch (e) {
      if (import.meta.env?.DEV) console.warn('[SessionContext] syncFromStorage failed:', e);
    }
  }, []);

  React.useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (isSessionStorageKey(e.key)) syncFromStorage();
    };
    // 领域模型约定：仅当 event.detail.threadId 与当前激活会话一致时更新存储/UI，避免跨会话污染
    const onSessionChanged = (e: Event) => {
      const detail = (e as CustomEvent<SessionChangedDetail>).detail;
      const eventThreadId = String(detail?.threadId || "").trim();
      const activeThreadId = getCurrentThreadIdFromStorage();
      if (eventThreadId && activeThreadId && eventThreadId !== activeThreadId) return;
      syncFromStorage();
    };
    const onSessionCreated = () => {
      syncFromStorage();
    };
    const onRoleChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ threadId?: string }>).detail;
      const eventThreadId = String(detail?.threadId || "").trim();
      const activeThreadId = getCurrentThreadIdFromStorage();
      if (eventThreadId && activeThreadId && eventThreadId !== activeThreadId) return;
      syncFromStorage();
    };
    const onModeChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ threadId?: string }>).detail;
      const eventThreadId = String(detail?.threadId || "").trim();
      const activeThreadId = getCurrentThreadIdFromStorage();
      if (eventThreadId && activeThreadId && eventThreadId !== activeThreadId) return;
      syncFromStorage();
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener(EVENTS.SESSION_CHANGED, onSessionChanged as EventListener);
    window.addEventListener(EVENTS.SESSION_CREATED, onSessionCreated);
    window.addEventListener(EVENTS.ROLE_CHANGED, onRoleChanged as EventListener);
    window.addEventListener(EVENTS.CHAT_MODE_CHANGED, onModeChanged as EventListener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(EVENTS.SESSION_CHANGED, onSessionChanged as EventListener);
      window.removeEventListener(EVENTS.SESSION_CREATED, onSessionCreated);
      window.removeEventListener(EVENTS.ROLE_CHANGED, onRoleChanged as EventListener);
      window.removeEventListener(EVENTS.CHAT_MODE_CHANGED, onModeChanged as EventListener);
    };
  }, [syncFromStorage]);

  const setRole = React.useCallback((roleId: string) => {
    const threadId = getCurrentThreadIdFromStorage();
    setScopedActiveRoleIdInStorage(roleId, threadId || undefined);
    syncFromStorage();
  }, [syncFromStorage]);

  const setMode = React.useCallback((mode: string) => {
    const threadId = getCurrentThreadIdFromStorage();
    setScopedChatMode(mode, threadId || undefined);
    syncFromStorage();
  }, [syncFromStorage]);

  const value: SessionContextValue = React.useMemo(
    () => ({
      ...session,
      setRole,
      setMode,
    }),
    [session, setRole, setMode]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSessionContext(): SessionContextValue {
  const ctx = React.useContext(SessionContext);
  if (ctx === null) {
    throw new Error("useSessionContext must be used within SessionContextProvider");
  }
  return ctx;
}
