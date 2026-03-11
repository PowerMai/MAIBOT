"use client";

import { EVENTS } from "../../lib/constants";
import { getItem as getStorageItem, setItem as setStorageItem } from "../../lib/safeStorage";

export const TASK_TIMELINE_STORAGE_PREFIX = "maibot_task_timeline_thread_";
const RECOVERY_ACTION_STATS_KEY = "maibot_recovery_action_stats";

export const RUN_STATUS_EVENT_START = new Set([
  "stream_start",
  "tool_start",
  "python_start",
  "shell_start",
  "search_start",
  "find_definition_start",
  "find_references_start",
  "file_read_start",
  "file_write_start",
  "think_start",
  "plan_start",
  "ask_user_start",
  "record_result_start",
  "subagent_start",
  "reasoning",
  EVENTS.TASK_PROGRESS,
]);

export const RUN_STATUS_EVENT_END = new Set([
  "stream_end",
  "tool_end",
  "python_complete",
  "shell_complete",
  "search_complete",
  "find_definition_complete",
  "find_references_complete",
  "file_read_complete",
  "file_write_complete",
  "think_complete",
  "plan_complete",
  "ask_user_complete",
  "record_result_complete",
  "subagent_end",
]);

export function classifyErrorKind(raw: string): "network" | "permission" | "timeout" | "other" {
  const lowered = String(raw || "").toLowerCase();
  if (!lowered) return "other";
  if (
    lowered.includes("network") ||
    lowered.includes("fetch") ||
    lowered.includes("econnrefused") ||
    lowered.includes("connect") ||
    lowered.includes("连接")
  ) {
    return "network";
  }
  if (
    lowered.includes("permission") ||
    lowered.includes("denied") ||
    lowered.includes("forbidden") ||
    lowered.includes("401") ||
    lowered.includes("403") ||
    lowered.includes("权限")
  ) {
    return "permission";
  }
  if (lowered.includes("timeout") || lowered.includes("超时")) return "timeout";
  return "other";
}

export function summarizeFailureSeries(rows: string[]): string[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const counts = new Map<string, number>();
  for (const raw of rows) {
    const text = String(raw || "").trim();
    if (!text) continue;
    counts.set(text, (counts.get(text) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([text, count]) => (count > 1 ? `${text} ×${count}` : text))
    .slice(0, 3);
}

export function recordRecoveryAction(action: string, source: string) {
  try {
    const raw = getStorageItem(RECOVERY_ACTION_STATS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const key = `${source}:${action}`;
    const next = {
      ...(parsed && typeof parsed === "object" ? parsed : {}),
      [key]: Number((parsed as Record<string, unknown>)?.[key] || 0) + 1,
      _updated_at: Date.now(),
    };
    setStorageItem(RECOVERY_ACTION_STATS_KEY, JSON.stringify(next));
  } catch (e) {
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) console.warn('[RunTracker] recordRecoveryAction storage failed', e);
  }
}

/** 与 i18n 的 t(key, params?) 签名兼容，thread 侧传入 (k, p) => (p != null ? t(k, p) : t(k)) */
export function resolveRunPhaseLabel(
  event: {
    type?: string;
    phase?: string;
    step?: string;
    subagent_type?: string;
    message?: string;
    data?: { message?: string; phase?: string; step?: string };
  },
  tr: (key: string, params?: Record<string, string | number>) => string = (k) => k
) {
  const type = String(event.type || "");
  const msg = String(event.message || event.data?.message || "").trim();
  const phase = String(event.phase || event.data?.phase || "").toLowerCase();
  if (type === "subagent_start") {
    if (event.subagent_type === "explore-agent") return tr("status.exploringContext");
    if (event.subagent_type === "bash-agent") return tr("status.executingCommand");
    if (event.subagent_type === "browser-agent") return tr("status.operatingBrowser");
    return tr("status.executingTask");
  }
  if (type === "reasoning") {
    if (phase === "start") return tr("status.thinking");
    if (phase === "content") return tr("status.inferring");
    return msg || tr("status.thinking");
  }
  if (type === EVENTS.TASK_PROGRESS) {
    if (phase === "tool_call") return (event.data?.step ?? (event as { step?: string }).step ?? msg) || tr("status.executingToolEllipsis");
    if (phase === "prepare") return tr("status.preparing");
    if (phase === "build_ready" || phase === "stream_open") return tr("status.starting");
    if (phase === "first_visible_wait") return tr("status.waitingFirstResponse");
    if (phase === "first_token") return tr("status.generating");
    return msg || tr("status.running");
  }
  if (type === "tool_start") return tr("status.callingTool");
  if (type.endsWith("_start")) return tr("status.running");
  if (type === "tool_error" || type === "stream_error") return tr("status.executionFailed");
  return msg || "";
}

export type RunSummaryState = {
  running: boolean;
  phaseLabel: string;
  activeTool: string;
  /** 最近一次工具执行结果（Cursor 式：执行了什么、结果摘要） */
  lastToolResult?: { tool: string; result_preview: string };
  startedAt: number | null;
  elapsedSec: number;
  lastError: string;
  recentFailures: string[];
  lastUpdatedAt: number;
  /** 首 token 时间（ms），来自 execution_metrics，开发/调试用 */
  lastTtftMs?: number;
  /** 流到首 token 耗时（ms），来自 execution_metrics */
  lastStreamToFirstTokenMs?: number;
  /** 当前/最近一次 run 的 run_id（来自 onRunCreated），参与复制诊断 */
  runId?: string;
  linkedThreadId?: string;
  linkedTaskId?: string;
  linkedSubject?: string;
  linkedStatus?: string;
  recoveryMode?: string;
  recoveryPoint?: {
    step_id?: string;
    seq?: number;
    at?: string;
    reason?: string;
  } | null;
  /** Cursor 式步骤进度（当有步骤时间线时优先显示 Step k/n: label） */
  stepSummary?: { current: number; total: number; label: string };
  /** 上一轮 run 的 LLM 产出汇总（stream_end complete 时写入：工具数/失败数/变更文件；RunSummaryCard 或 Footer 单一位置展示，与消息内叙事同一上下文） */
  lastRunSummary?: { toolCount: number; errorCount?: number; filePaths?: string[] };
};
