import { getItem as getStorageItem, setItem as setStorageItem, removeItem as removeStorageItem } from "./safeStorage";
import { EVENTS } from "./constants";
import { validServerThreadIdOrUndefined } from "./api/langserveChat";
import { publishRoleChangedCrossWindow } from "./sessionState";
import { getCurrentThreadIdFromStorage as getCurrentThreadIdFromSessionUtils } from "./session/sessionUtils";

export const DEFAULT_ROLE_ID = "default";
export const ROLE_DEFAULT_STORAGE_KEY = "maibot_active_role_default";

const LEGACY_ROLE_ALIAS_MAP: Record<string, string> = {
  assistant: "default",
  analyst: "default",
  engineer: "default",
  strategist: "default",
  solution_expert: "default",
  contract_specialist: "default",
  bidding_specialist: "default",
  technical_consultant: "default",
  commercial_analyst: "default",
  solution_architect: "default",
  data_analyst: "default",
  resource_manager: "default",
  executive_assistant: "default",
  office_assistant: "default",
  knowledge_manager: "default",
  workflow_designer: "default",
};

export function normalizeRoleId(roleId: string | null | undefined): string {
  const raw = String(roleId || "").trim();
  if (!raw) return DEFAULT_ROLE_ID;
  return LEGACY_ROLE_ALIAS_MAP[raw] || raw;
}

export function getCurrentThreadIdFromStorage(): string {
  return getCurrentThreadIdFromSessionUtils();
}

export function getThreadScopedRoleStorageKey(threadId: string): string {
  return `maibot_active_role_thread_${threadId}`;
}

/** 一次性迁移：将旧 key maibot_active_role 写入 ROLE_DEFAULT_STORAGE_KEY 并删除旧 key。应在应用启动时调用。 */
export function migrateLegacyRoleStorage(): void {
  if (typeof window === "undefined") return;
  const legacy = String(getStorageItem("maibot_active_role") || "").trim();
  if (!legacy) return;
  const normalized = normalizeRoleId(legacy);
  setStorageItem(ROLE_DEFAULT_STORAGE_KEY, normalized);
  removeStorageItem("maibot_active_role");
}

export function getScopedActiveRoleIdFromStorage(): string {
  if (typeof window === "undefined") return DEFAULT_ROLE_ID;
  const raw = getCurrentThreadIdFromStorage();
  const threadId = validServerThreadIdOrUndefined(raw);
  if (threadId) {
    const scoped = String(getStorageItem(getThreadScopedRoleStorageKey(threadId)) || "").trim();
    if (scoped) return normalizeRoleId(scoped);
  }
  const globalDefault = String(getStorageItem(ROLE_DEFAULT_STORAGE_KEY) || "").trim();
  if (globalDefault) return normalizeRoleId(globalDefault);
  return normalizeRoleId(getStorageItem("maibot_active_role"));
}

export function setScopedActiveRoleIdInStorage(roleId: string, threadId?: string): string {
  if (typeof window === "undefined") return normalizeRoleId(roleId);
  const normalized = normalizeRoleId(roleId);
  const raw = String(threadId ?? getCurrentThreadIdFromStorage()).trim();
  const scopedThreadId = validServerThreadIdOrUndefined(raw);
  if (scopedThreadId) {
    setStorageItem(getThreadScopedRoleStorageKey(scopedThreadId), normalized);
  } else {
    setStorageItem(ROLE_DEFAULT_STORAGE_KEY, normalized);
  }
  window.dispatchEvent(
    new CustomEvent(EVENTS.ROLE_CHANGED, {
      detail: { roleId: normalized, threadId: scopedThreadId ?? undefined, source: "local" },
    }),
  );
  window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
  publishRoleChangedCrossWindow(normalized, scopedThreadId ?? undefined);
  return normalized;
}

export function setGlobalDefaultRoleIdInStorage(roleId: string): string {
  const normalized = normalizeRoleId(roleId);
  if (typeof window !== "undefined") {
    setStorageItem(ROLE_DEFAULT_STORAGE_KEY, normalized);
    window.dispatchEvent(
      new CustomEvent(EVENTS.ROLE_CHANGED, {
        detail: { roleId: normalized, threadId: undefined, source: "local" },
      }),
    );
    window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
    publishRoleChangedCrossWindow(normalized, undefined);
  }
  return normalized;
}
