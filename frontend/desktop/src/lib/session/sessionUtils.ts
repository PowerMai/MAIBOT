/**
 * 会话相关工具（单一真源）
 * 与 domain-model.mdc 约定一致：会话键 > 全局键
 */
import { getItem as getStorageItem } from "../safeStorage";

export function getCurrentThreadIdFromStorage(): string {
  return String(
    getStorageItem("maibot_current_thread_id") || getStorageItem("maibot_active_thread") || ""
  ).trim();
}
