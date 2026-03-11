/**
 * 运行摘要与当前会话同步（单源逻辑，避免 WorkspaceDashboard / FullEditorV2Enhanced 重复实现）
 * 订阅 RUN_SUMMARY_UPDATED、SESSION_CHANGED，可选 storage；按当前 threadId 过滤后归一化并回调
 */
import { useEffect, useRef } from "react";
import { EVENTS } from "../constants";
import {
  getCurrentThreadIdFromStorage,
  readRunSummary,
  normalizeRunSummaryDetail,
  type RunSummaryDisplay,
} from "../runSummaryState";

export type RunSummarySyncOptions = {
  /** 是否同时监听 storage 事件（多标签同步） */
  listenStorage?: boolean;
};

/**
 * @param onSync 收到有效摘要或会话切换时调用 (normalized, rawDetail)。rawDetail 为事件/存储原始对象，便于扩展字段（如 statusText、recoveryPriority）
 */
export function useRunSummarySync(
  onSync: (normalized: RunSummaryDisplay | null, rawDetail?: Record<string, unknown> | null) => void,
  options: RunSummarySyncOptions = {}
): void {
  const { listenStorage = false } = options;
  const onSyncRef = useRef(onSync);
  onSyncRef.current = onSync;

  useEffect(() => {
    const sync = (payload?: Record<string, unknown> | null) => {
      const raw =
        payload ??
        (() => {
          try {
            return readRunSummary(getCurrentThreadIdFromStorage());
          } catch {
            return null;
          }
        })();
      const normalized = normalizeRunSummaryDetail(raw ?? null);
      onSyncRef.current(normalized, raw ?? undefined);
    };

    const onRunSummary = (ev: Event) => {
      const detail = (ev as CustomEvent<Record<string, unknown> | undefined>).detail;
      if (detail != null && typeof detail === "object" && detail.threadId != null) {
        const current = getCurrentThreadIdFromStorage();
        if (String(detail.threadId).trim() !== current) return;
      }
      sync(detail ?? null);
    };

    const onSessionChanged = () => sync(null);

    sync();
    window.addEventListener(EVENTS.RUN_SUMMARY_UPDATED, onRunSummary);
    window.addEventListener(EVENTS.SESSION_CHANGED, onSessionChanged);
    if (listenStorage) window.addEventListener("storage", onSessionChanged);

    return () => {
      window.removeEventListener(EVENTS.RUN_SUMMARY_UPDATED, onRunSummary);
      window.removeEventListener(EVENTS.SESSION_CHANGED, onSessionChanged);
      if (listenStorage) window.removeEventListener("storage", onSessionChanged);
    };
  }, [listenStorage]);
}
