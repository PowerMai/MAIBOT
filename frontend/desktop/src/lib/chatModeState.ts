import { EVENTS } from "./constants";
import { validServerThreadIdOrUndefined } from "./api/langserveChat";
import { getCurrentThreadIdFromStorage } from "./roleIdentity";
import { getItem as getStorageItem, setItem as setStorageItem, removeItem as removeStorageItem } from "./safeStorage";
import { publishChatModeChangedCrossWindow } from "./sessionState";

export type ChatMode = "agent" | "plan" | "ask" | "debug" | "review";
export const CHAT_MODE_DEFAULT_STORAGE_KEY = "maibot_chat_mode_default";

/** 底部栏 border-t 颜色（与 thread 模式角标一致） */
export const MODE_STATUSBAR_BORDER: Record<ChatMode, string> = {
  agent: "border-t-blue-500/40",
  plan: "border-t-violet-500/40",
  ask: "border-t-emerald-500/40",
  debug: "border-t-amber-500/40",
  review: "border-t-teal-500/40",
};

/** 模式角标样式（与 thread 消息头一致） */
export const MODE_BADGE_STYLES: Record<ChatMode, string> = {
  agent: "bg-blue-500/10 text-blue-600 border border-blue-500/20",
  plan: "bg-violet-500/10 text-violet-600 border border-violet-500/20",
  ask: "bg-emerald-500/10 text-emerald-600 border border-emerald-500/20",
  debug: "bg-amber-500/10 text-amber-600 border border-amber-500/20",
  review: "bg-teal-500/10 text-teal-600 border border-teal-500/20",
};

/** Composer 发送按钮底色（Cursor 风格，按模式区分） */
export const MODE_SEND_BUTTON_BG: Record<ChatMode, string> = {
  agent: "bg-blue-500 hover:bg-blue-600 text-white",
  plan: "bg-violet-500 hover:bg-violet-600 text-white",
  ask: "bg-emerald-500 hover:bg-emerald-600 text-white",
  debug: "bg-amber-500 hover:bg-amber-600 text-white",
  review: "bg-teal-500 hover:bg-teal-600 text-white",
};

/** 模式角标文案 */
export const MODE_BADGE_LABELS: Record<ChatMode, string> = {
  agent: "Agent",
  plan: "Plan · 仅规划",
  ask: "Ask",
  debug: "Debug",
  review: "Review",
};

const VALID_CHAT_MODES: ReadonlyArray<ChatMode> = ["agent", "plan", "ask", "debug", "review"];

function isChatMode(mode: string): mode is ChatMode {
  return VALID_CHAT_MODES.includes(mode as ChatMode);
}

export function normalizeChatMode(mode: string | null | undefined, fallback: ChatMode = "agent"): ChatMode {
  const normalized = String(mode || "").trim().toLowerCase();
  return isChatMode(normalized) ? normalized : fallback;
}

const LEGACY_CHAT_MODE_KEY = "maibot_chat_mode";

/** 一次性将遗留 key "maibot_chat_mode" 迁移到 CHAT_MODE_DEFAULT_STORAGE_KEY，应在应用初始化时调用一次。依赖 storage 中旧 key 是否存在，避免模块级标志跨测试/SSR 污染。 */
export function migrateLegacyChatMode(): void {
  const legacyRaw = getStorageItem(LEGACY_CHAT_MODE_KEY);
  if (legacyRaw == null || legacyRaw === "") return;
  const legacyGlobal = normalizeChatMode(legacyRaw, "agent");
  setStorageItem(CHAT_MODE_DEFAULT_STORAGE_KEY, legacyGlobal);
  const written = getStorageItem(CHAT_MODE_DEFAULT_STORAGE_KEY);
  if (written) removeStorageItem(LEGACY_CHAT_MODE_KEY);
}

export function resolveScopedChatMode(preferredThreadId?: string): ChatMode {
  const raw = String(preferredThreadId ?? getCurrentThreadIdFromStorage() ?? "").trim();
  const threadId = validServerThreadIdOrUndefined(raw);
  if (threadId) {
    const scopedRaw = String(getStorageItem(`maibot_chat_mode_thread_${threadId}`) || "").trim().toLowerCase();
    if (isChatMode(scopedRaw)) return scopedRaw;
  }
  const globalDefault = String(getStorageItem(CHAT_MODE_DEFAULT_STORAGE_KEY) || "").trim().toLowerCase();
  if (isChatMode(globalDefault)) return globalDefault;
  return "agent";
}

export function setScopedChatMode(mode: string, preferredThreadId?: string): { mode: ChatMode; threadId: string } {
  const nextMode = normalizeChatMode(mode, "agent");
  const raw = String(preferredThreadId ?? getCurrentThreadIdFromStorage() ?? "").trim();
  const threadId = validServerThreadIdOrUndefined(raw);
  if (threadId) {
    setStorageItem(`maibot_chat_mode_thread_${threadId}`, nextMode);
  } else {
    setStorageItem(CHAT_MODE_DEFAULT_STORAGE_KEY, nextMode);
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
    window.dispatchEvent(new CustomEvent(EVENTS.CHAT_MODE_CHANGED, { detail: { mode: nextMode, threadId: threadId ?? undefined } }));
  }
  publishChatModeChangedCrossWindow(nextMode, threadId ?? undefined);
  return { mode: nextMode, threadId: threadId ?? "" };
}

export function setGlobalDefaultChatMode(mode: string): ChatMode {
  const nextMode = normalizeChatMode(mode, "agent");
  if (typeof window !== "undefined") {
    setStorageItem(CHAT_MODE_DEFAULT_STORAGE_KEY, nextMode);
    window.dispatchEvent(new CustomEvent(EVENTS.CHAT_MODE_CHANGED, { detail: { mode: nextMode, threadId: undefined } }));
  }
  publishChatModeChangedCrossWindow(nextMode, undefined);
  return nextMode;
}
