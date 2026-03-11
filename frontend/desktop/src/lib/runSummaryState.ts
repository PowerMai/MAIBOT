import { getItem as getStorageItem, setItem as setStorageItem } from "./safeStorage";
import { validServerThreadIdOrUndefined } from "./api/langserveChat";
import { getCurrentThreadIdFromStorage } from "./sessionState";

export { getCurrentThreadIdFromStorage };

const RUN_SUMMARY_GLOBAL_KEY = "maibot_last_run_summary";
const RUN_SUMMARY_THREAD_PREFIX = "maibot_run_summary_thread_";
const THREAD_HEALTH_MAP_KEY = "maibot_thread_health_map";

/** 运行摘要存储结构（与 writeRunSummary 写入字段一致） */
export interface RunSummaryParsed {
  lastError?: string;
  linkedTaskId?: string;
  linkedThreadId?: string;
  linkedSubject?: string;
  threadId?: string;
  [key: string]: unknown;
}

function getThreadRunSummaryKey(threadId: string): string {
  return `${RUN_SUMMARY_THREAD_PREFIX}${threadId}`;
}

export function readRunSummary(
  preferredThreadId?: string
): Record<string, unknown> | null {
  const rawTarget = String(preferredThreadId ?? "").trim() || getCurrentThreadIdFromStorage();
  const validTid = validServerThreadIdOrUndefined(rawTarget);
  const targetThreadId = validTid || rawTarget;
  if (validTid) {
    try {
      const rawThread = getStorageItem(getThreadRunSummaryKey(validTid));
      if (rawThread) {
        const parsed = JSON.parse(rawThread);
        if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
  }
  try {
    const rawGlobal = getStorageItem(RUN_SUMMARY_GLOBAL_KEY);
    if (!rawGlobal) return null;
    const parsed = JSON.parse(rawGlobal);
    if (!parsed || typeof parsed !== "object") return null;
    if (targetThreadId) {
      const p = parsed as RunSummaryParsed;
      const payloadThreadId = String(p.threadId ?? "").trim();
      if (payloadThreadId && payloadThreadId !== targetThreadId) return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 单条 run summary 最大序列化长度，避免占满 localStorage（Cursor 风格：限制单条体积） */
const RUN_SUMMARY_MAX_BYTES = 32 * 1024;

export function writeRunSummary(
  payload: Record<string, unknown>,
  preferredThreadId?: string
): void {
  const targetThreadId =
    String(preferredThreadId || "").trim() ||
    String(payload.threadId || "").trim() ||
    getCurrentThreadIdFromStorage();
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return;
  }
  if (serialized.length > RUN_SUMMARY_MAX_BYTES) {
    const trimmed: Record<string, unknown> = { ...payload };
    if (Array.isArray(trimmed.recentFailures) && trimmed.recentFailures.length > 10) {
      trimmed.recentFailures = (trimmed.recentFailures as string[]).slice(0, 10);
    }
    if (typeof trimmed.lastToolResult === "object" && trimmed.lastToolResult !== null) {
      const r = trimmed.lastToolResult as { result_preview?: string };
      if (typeof r.result_preview === "string" && r.result_preview.length > 500) {
        trimmed.lastToolResult = { ...r, result_preview: r.result_preview.slice(0, 500) + "…" };
      }
    }
    if (typeof trimmed.lastError === "string" && trimmed.lastError.length > 1000) {
      trimmed.lastError = (trimmed.lastError as string).slice(0, 1000) + "…";
    }
    try {
      serialized = JSON.stringify(trimmed);
    } catch {
      return;
    }
    if (serialized.length > RUN_SUMMARY_MAX_BYTES) {
      return;
    }
  }
  try {
    setStorageItem(RUN_SUMMARY_GLOBAL_KEY, serialized);
    const validTid = validServerThreadIdOrUndefined(targetThreadId);
    if (validTid) setStorageItem(getThreadRunSummaryKey(validTid), serialized);
  } catch {
    // quota exceeded or storage disabled: skip write
  }
}

/** 供 UI 展示的 run summary 通用形状（单源归一化，避免多处重复解析） */
export type RunSummaryDisplay = {
  running: boolean;
  phaseLabel: string;
  activeTool: string;
  elapsedSec: number;
  lastError: string;
  recentFailures: string[];
  linkedTaskId?: string;
  linkedThreadId?: string;
  linkedSubject?: string;
};

/** 将存储或事件中的 detail 归一化为 RunSummaryDisplay，null 表示无有效数据 */
export function normalizeRunSummaryDetail(detail: Record<string, unknown> | null): RunSummaryDisplay | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  return {
    running: Boolean(d.running),
    phaseLabel: String(d.phaseLabel ?? ""),
    activeTool: String(d.activeTool ?? ""),
    elapsedSec: Number(d.elapsedSec ?? 0),
    lastError: String(d.lastError ?? ""),
    recentFailures: Array.isArray(d.recentFailures)
      ? (d.recentFailures as unknown[]).map((x: unknown) => String(x ?? "")).filter(Boolean).slice(0, 3)
      : [],
    linkedTaskId: (d.linkedTaskId != null && String(d.linkedTaskId).trim()) ? String(d.linkedTaskId) : undefined,
    linkedThreadId: (d.linkedThreadId != null && String(d.linkedThreadId).trim()) ? String(d.linkedThreadId) : undefined,
    linkedSubject: (d.linkedSubject != null && String(d.linkedSubject).trim()) ? String(d.linkedSubject) : undefined,
  };
}

export type ThreadHealthEntry = {
  lastError?: string;
  recentFailures?: string[];
  failureCount?: number;
  phaseLabel?: string;
  updatedAt?: number;
};

export function readThreadHealthMap(): Record<string, ThreadHealthEntry> {
  try {
    const raw = getStorageItem(THREAD_HEALTH_MAP_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, ThreadHealthEntry>) : {};
  } catch {
    return {};
  }
}

export function writeThreadHealthEntry(
  threadId: string,
  patch: ThreadHealthEntry
): void {
  const id = String(threadId || "").trim();
  if (!id) return;
  const prevMap = readThreadHealthMap();
  const prevEntry =
    prevMap[id] && typeof prevMap[id] === "object"
      ? (prevMap[id] as ThreadHealthEntry)
      : {};
  const nextMap: Record<string, ThreadHealthEntry> = {
    ...prevMap,
    [id]: {
      ...prevEntry,
      ...patch,
    },
  };
  setStorageItem(THREAD_HEALTH_MAP_KEY, JSON.stringify(nextMap));
}

