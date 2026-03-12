"use client";

import React from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useLangGraphRuntime, LangChainMessage, type LangGraphMessagesEvent } from "@assistant-ui/react-langgraph";
import { createThread, getThreadState, sendMessageWithRetry, streamRun, cancelRun, updateThreadTitle, getApiBase, isThreadNotFoundError, isValidServerThreadId, checkHealth, getCachedHealthStatus, waitForBackend } from "../../lib/api/langserveChat";
import { resolveTaskRefByTaskOrThread } from "../../lib/api/taskIdentityResolver";
import { boardApi } from "../../lib/api/boardApi";
import { filesApi } from "../../lib/api/filesApi";
import { getUserContext } from "../../lib/hooks/useUserContext";
import { useWorkspacePath } from "../../lib/hooks/useWorkspacePath";
import { EVENTS } from "../../lib/constants";
import { formatApiErrorMessage, isUserAbort } from "../../lib/utils/formatApiError";
import { toast } from "sonner";
import { ModelContext, ThreadLoadErrorContext } from "./thread";
import { fileEventBus } from "../../lib/events/fileEvents";
import { toolStreamEventBus, type ToolStreamEvent, type ExecutionStep, type ExecutionStepStatus, getStepsForThread, clearStepsForThread, emitStepsUpdated, parseRunErrorPayload, parseSessionContextPayload, appendCurrentRunReasoning, clearCurrentRunReasoning } from "../../lib/events/toolStreamEvents";
import { getPlatform, isElectronEnv } from "../../lib/services/electronService";
import { executeSlashCommand, postUiStreamMetricsSample } from "../../lib/api/systemApi";
import { CancelContext } from "./cancelContext";
import { getItem as getStorageItem, setItem as setStorageItem, removeItem as removeStorageItem } from "../../lib/safeStorage";
import { getScopedActiveRoleIdFromStorage, normalizeRoleId, setScopedActiveRoleIdInStorage } from "../../lib/roleIdentity";
import { resolveScopedChatMode, setScopedChatMode } from "../../lib/chatModeState";
import { activateThreadSession, clearActiveThreadSession, emitSessionCreated, getCurrentWorkspacePathFromStorage } from "../../lib/sessionState";
import { getCurrentThreadIdFromStorage } from "../../lib/session/sessionUtils";
import { getFileTreeByPath, flattenFileTreeToFiles } from "../../lib/api/workspace";
import { normalizeToolCallsInMessages } from "../../lib/utils/normalizeToolCalls";
import { normalizeLangChainMessages, normalizeMessageContent, type MessageLike } from "../../lib/utils/normalizeLangChainMessages";
import { getToolDisplayName } from "./tool-fallback";
import { useThreadStateLoader } from "./useThreadStateLoader";
import type { ContextItem } from "../../types/context";
import { OpenFilesContext } from "./openFilesContext";
import { t } from "../../lib/i18n";

const VALID_SKILL_PROFILES = ['full', 'office', 'report', 'research', 'analyst', 'analytics', 'general'] as const;
const _PROFILE_ALIAS: Record<string, string> = {
  document: 'office',
  dev: 'full',
  analytics: 'analyst',
  community: 'full',
};

const _AGENT_PROGRESS_TYPES = new Set(['subagent_start', 'subagent_end', EVENTS.TASK_PROGRESS, 'tool_result', 'artifact', 'context_stats', 'execution_metrics']);
/** 发送前单条消息内容最大长度，与 Composer 输入上限一致，避免超长导致请求/上下文问题（Cursor 风格） */
const MAX_MESSAGE_CONTENT_LENGTH = 80_000;
/** 流式消息事件中允许传给 UI 的消息类型（过滤 system/human）；大小写不敏感，避免后端小写 type 被误滤 */
const ALLOWED_MSG_TYPES = new Set(['ai', 'aimessage', 'aimessagechunk', 'tool', 'toolmessage']);
function isAllowedMessageType(type: string | undefined): boolean {
  if (!type) return true;
  return ALLOWED_MSG_TYPES.has(String(type).toLowerCase());
}

/** 流式 partial 中单条消息形状（partialAiToChunkDeltas / preparePartialChunkPayload 单源，避免多处重复定义） */
type StreamPartialAiMessage = { type?: string; id?: string; content?: unknown; tool_call_chunks?: unknown[] };

/** Cursor 一致：将 ToolMessage 合并进上一条 AI 消息的 tool-call part.result，按后端/LLM 执行顺序展示（思考→工具1+结果→工具2+结果→…→正文），不重排、不合并 content。
 * @param omitContentParts 为 true 时（流式 partial）不写入 content_parts，避免 SDK 走替换分支；complete 时传 false/不传以保留。 */
function mergeToolResultsIntoAiMessages(
  messages: Array<{ type?: string; id?: string; content?: unknown; tool_calls?: Array<{ id?: string; name?: string; args?: unknown }>; tool_call_id?: string; name?: string }>,
  opts?: { omitContentParts?: boolean }
): typeof messages {
  const out: typeof messages = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    const msgType = String(msg?.type ?? "").toLowerCase();
    const isAi = msgType === "ai" || msgType === "aimessage" || msgType === "aimessagechunk" || (msg as { role?: string })?.role === "assistant";
    if (isAi) {
      const toolMessages: Array<{ tool_call_id?: string; toolCallId?: string; content?: unknown }> = [];
      let j = i + 1;
      while (j < messages.length) {
        const t = messages[j];
        const tType = String(t?.type ?? "").toLowerCase();
        const isTool = tType === "tool" || tType === "toolmessage" || (t as { role?: string })?.role === "tool";
        if (isTool) {
          toolMessages.push(t);
          j++;
        } else break;
      }
      const toolResultById: Record<string, string> = {};
      for (const tm of toolMessages) {
        const tid = (tm.tool_call_id ?? (tm as { toolCallId?: string }).toolCallId ?? "").toString().trim();
        if (tid) {
          const c = tm.content;
          toolResultById[tid] = typeof c === "string" ? c : c != null ? String(c) : "";
        }
      }
      const content = msg.content;
      const toolCalls = msg.tool_calls ?? [];
      let contentParts: Array<{ type: string; text?: string; id?: string; name?: string; args?: unknown; result?: string }>;
      const backendContentParts = (msg as { content_parts?: unknown }).content_parts;
      const hasBackendContentParts = Array.isArray(backendContentParts) && backendContentParts.length > 0;
      if (hasBackendContentParts) {
        contentParts = (backendContentParts as Array<{ type?: string; text?: string; id?: string; name?: string; args?: unknown; result?: string }>).map((p) => {
          if (p?.type === "reasoning") return { type: "reasoning", text: p.text ?? "" };
          if (p?.type === "text") return { type: "text", text: p.text ?? "" };
          if (p?.type === "tool-call") {
            const id = p.id ?? "";
            return {
              type: "tool-call",
              id,
              name: p.name ?? "",
              args: p.args ?? {},
              result: p.result ?? toolResultById[id],
            };
          }
          return null;
        }).filter(Boolean) as typeof contentParts;
      } else {
        const hasContentParts = Array.isArray(content) && content.some((p: { type?: string }) => p?.type === "tool-call");
        if (hasContentParts && Array.isArray(content)) {
          contentParts = content.map((p: { type?: string; text?: string; id?: string; name?: string; args?: unknown; result?: string }) => {
            if (p?.type === "reasoning") return { type: "reasoning", text: p.text ?? "" };
            if (p?.type === "text") return { type: "text", text: p.text ?? "" };
            if (p?.type === "tool-call") {
              const id = p.id ?? "";
              return {
                type: "tool-call",
                id,
                name: p.name ?? "",
                args: p.args ?? {},
                result: p.result ?? toolResultById[id],
              };
            }
            return null;
          }).filter(Boolean) as typeof contentParts;
        } else {
          const textContent = typeof content === "string" ? content : "";
          contentParts = [];
          for (const tc of toolCalls) {
            const id = (tc as { id?: string }).id ?? "";
            contentParts.push({
              type: "tool-call",
              id,
              name: (tc as { name?: string }).name ?? "",
              args: (tc as { args?: unknown }).args ?? {},
              result: toolResultById[id],
            });
          }
          contentParts.push({ type: "text", text: textContent });
        }
      }
      if (
        (typeof import.meta !== "undefined" && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) &&
        toolMessages.length > 0
      ) {
        const partIds = new Set(
          contentParts
            .filter((x): x is { type: string; id?: string } => (x as { type?: string })?.type === "tool-call")
            .map((x) => x.id ?? "")
        );
        for (const tm of toolMessages) {
          const tid = (tm.tool_call_id ?? (tm as { toolCallId?: string }).toolCallId ?? "").toString().trim();
          if (tid && !partIds.has(tid)) {
            console.warn("[mergeToolResults] tool_call_id 与 content 中 part.id 不一致，可能导致依据区错位", {
              tool_call_id: tid,
            });
          }
        }
      }
      const omitContentParts = opts?.omitContentParts === true;
      out.push({
        ...msg,
        content: contentParts,
        ...(omitContentParts ? {} : { content_parts: contentParts }),
      } as (typeof messages)[0]);
      i = j;
    } else {
      const tType = String(msg?.type ?? "").toLowerCase();
      const isOrphanTool = tType === "tool" || tType === "toolmessage" || (msg as { role?: string })?.role === "tool";
      if (isOrphanTool) {
        i++;
        continue;
      }
      out.push(normalizeMessageContent(msg as MessageLike) as (typeof messages)[0]);
      i++;
    }
  }
  return out;
}

/** 确保每条 AI 消息都有 content_parts，避免 complete/load 以纯 string content 交给 SDK 导致断行或错位 */
function ensureAiMessagesHaveContentParts<T extends { type?: string; content?: unknown; content_parts?: unknown }>(messages: T[]): T[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  for (const msg of messages) {
    const t = String(msg?.type ?? "").toLowerCase();
    if (t !== "ai" && t !== "aimessage" && t !== "aimessagechunk") continue;
    const c = msg.content;
    const parts = msg.content_parts;
    const hasParts = Array.isArray(parts) && parts.length > 0;
    if (typeof c === "string" && !hasParts) {
      (msg as { content: unknown }).content = [{ type: "text" as const, text: c }];
      (msg as { content_parts: unknown }).content_parts = (msg as { content: unknown }).content;
    } else if (Array.isArray(c) && !hasParts) {
      (msg as { content_parts: unknown }).content_parts = c.length > 0 ? c : [{ type: "text" as const, text: "" }];
      if (c.length === 0) (msg as { content: unknown }).content = (msg as { content_parts: unknown }).content_parts;
    }
  }
  return messages;
}

/** DEV：load 返回前打 log，确认交给 SDK 的消息均为带 content_parts 的形状 */
function logLoadReturnIfDev(messages: unknown[], label: string): void {
  if (!import.meta.env?.DEV || !Array.isArray(messages)) return;
  const firstAi = messages.find((m: unknown) => { const t = String((m as { type?: string })?.type ?? "").toLowerCase(); return t === "ai" || t === "aimessage" || t === "aimessagechunk"; });
  const c = firstAi ? (firstAi as { content?: unknown }).content : undefined;
  const parts = firstAi ? (firstAi as { content_parts?: unknown }).content_parts : undefined;
  console.log('[MyRuntimeProvider] load 返回', label, { count: messages.length, firstAiContentType: c != null ? typeof c : null, firstAiIsArray: Array.isArray(c), hasContentParts: Array.isArray(parts) && (parts as unknown[]).length > 0 });
}

/** 主通道与 resume 共用：对 partial 消息数组做 content_parts + stable id，避免 delta-only 导致断行。就地修改 arr。 */
function ensurePartialPayloadContentParts(
  arr: Array<{ type?: string; id?: string; content?: unknown; content_parts?: unknown }>,
  getOrCreateStableAiId: (hintId: string) => string,
  getStableIdForIndex: (aiOrd: number) => string | undefined,
  setStableIdForIndex: (aiOrd: number, id: string) => void,
  lastContentPartsByMessageIdRef: { current: Record<string, Array<{ type: string; text?: string; id?: string; name?: string; args?: unknown; result?: string }>> },
  onMultipleAi?: () => void
): void {
  const aiCount = arr.filter((m) => { const t = String(m?.type ?? "").toLowerCase(); return t === "ai" || t === "aimessage" || t === "aimessagechunk"; }).length;
  if (aiCount > 1 && onMultipleAi) onMultipleAi();
  let lastAiIdx = -1;
  for (let i = arr.length - 1; i >= 0; i--) {
    const t = String(arr[i]?.type ?? "").toLowerCase();
    if (t === "ai" || t === "aimessage" || t === "aimessagechunk") {
      lastAiIdx = i;
      break;
    }
  }
  const partialOrdinalByIndex: number[] = [];
  let ord = 0;
  for (let i = 0; i < arr.length; i++) {
    const t = String(arr[i]?.type ?? "").toLowerCase();
    if (t === "ai" || t === "aimessage" || t === "aimessagechunk") partialOrdinalByIndex[i] = ord++;
  }
  for (let i = 0; i < arr.length; i++) {
    const msg = arr[i];
    const mt = String(msg?.type ?? "").toLowerCase();
    if (mt !== "ai" && mt !== "aimessage" && mt !== "aimessagechunk") continue;
    const isLastAi = i === lastAiIdx;
    const aiOrd = partialOrdinalByIndex[i] ?? 0;
    const hintId = String(msg?.id ?? "").trim();
    const stableId = isLastAi ? getOrCreateStableAiId(hintId) : (getStableIdForIndex(aiOrd) ?? (hintId || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `ai-${aiOrd}-${Date.now()}`)));
    if (isLastAi) setStableIdForIndex(aiOrd, stableId);
    (msg as { id?: string }).id = stableId;
    const c = msg.content;
    const parts = msg.content_parts;
    const hasParts = Array.isArray(parts) && parts.length > 0;
    if (typeof c === "string" && !hasParts) {
      const single = [{ type: "text" as const, text: c }];
      (msg as { content: unknown }).content = single;
      (msg as { content_parts: unknown }).content_parts = single;
    } else if (Array.isArray(c) && !hasParts) {
      (msg as { content_parts: unknown }).content_parts = c.length > 0 ? c : [{ type: "text" as const, text: "" }];
      if (c.length === 0) (msg as { content: unknown }).content = (msg as { content_parts: unknown }).content_parts;
    } else if (hasParts) {
      (msg as { content: unknown }).content = parts;
    }
    const finalParts = (Array.isArray(msg.content) ? msg.content : []) as Array<{ type: string; text?: string; id?: string; name?: string; args?: unknown; result?: string }>;
    lastContentPartsByMessageIdRef.current[stableId] = finalParts;
    (msg as { type?: string }).type = "AIMessageChunk";
  }
}

/** 从消息 content 中提取纯文本（string 或 content parts 中的 text/text_delta 拼接） */
function extractMessageText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let s = "";
  for (const part of content as Array<{ type?: string; text?: string }>) {
    if (typeof part?.text !== "string") continue;
    const t = String(part.type ?? "").toLowerCase();
    if (t === "text" || t === "text_delta") s += part.text;
  }
  return s;
}

/**
 * 将 messages/partial 中的 type="ai" 转为 AIMessageChunk + delta，使 SDK 的 appendLangChainChunk 生效（追加而非替换），
 * 并用稳定 id 保证同一条回复的多个 chunk 被 SDK 合并为一条消息，避免「一行一个字」再整合。
 * @param messages 当前要 yield 的消息列表
 * @param accumulatedById 本 run 内按 id 累积的全文
 * @param getOrCreateStableAiId 仅用于「本批最后一条」AI，生成并固定 id（同一 run 内多批时会在每批多 AI 时重置，避免多条 AI 共用一个 id）
 * @param getStableIdForIndex 本 run 内按 AI 序号取已分配的稳定 id（非最后一条 AI 跨批复用，避免重复气泡）
 * @param setStableIdForIndex 分配稳定 id 后回写序号，供下批 getStableIdForIndex 使用
 * @returns 新数组：ai 消息变为 AIMessageChunk（content=delta，id=稳定 id），其余不变
 */
function partialAiToChunkDeltas<T extends StreamPartialAiMessage>(
  messages: T[],
  accumulatedById: Map<string, string>,
  getOrCreateStableAiId: (hintId: string) => string,
  getStableIdForIndex: (aiIndex: number) => string | undefined,
  setStableIdForIndex: (aiIndex: number, id: string) => void
): T[] {
  if (!messages.length) return messages;
  let lastAiIndex = -1;
  const aiIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const t = String(messages[i]?.type ?? "").toLowerCase();
    if (t === "ai" || t === "aimessage" || t === "aimessagechunk") {
      aiIndices.push(i);
      lastAiIndex = i;
    }
  }
  if (lastAiIndex < 0) return messages;
  const out: T[] = [];
  let aiOrdinal = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const type = String(msg?.type ?? "").toLowerCase();
    const isAi = type === "ai" || type === "aimessage" || type === "aimessagechunk";
    if (!isAi) {
      out.push(msg);
      continue;
    }
    const isLastAi = i === lastAiIndex;
    const hintId = String(msg.id ?? "").trim();
    let id: string;
    if (isLastAi) {
      id = getOrCreateStableAiId(hintId);
      setStableIdForIndex(aiOrdinal, id);
    } else {
      id = getStableIdForIndex(aiOrdinal) ?? (hintId || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `ai-${aiOrdinal}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`));
    }
    aiOrdinal += 1;
    const currText = extractMessageText(msg.content);
    let delta: string;
    if (isLastAi) {
      const prev = accumulatedById.get(id);
      if (prev === undefined) {
        delta = currText;
        accumulatedById.set(id, currText);
      } else {
        if (currText.length >= prev.length && currText.startsWith(prev)) {
          delta = currText.slice(prev.length);
          accumulatedById.set(id, currText);
        } else {
          delta = currText;
          accumulatedById.set(id, prev + currText);
        }
      }
    } else {
      delta = currText;
    }
    out.push({
      ...msg,
      id,
      type: "AIMessageChunk",
      content: delta,
      tool_call_chunks: msg.tool_call_chunks,
    } as T);
  }
  return out;
}

/** 单一路径：partial 转 AIMessageChunk+delta 并规范化，供 custom/主通道/resume 三处 yield 前复用。
 * 保留 content_parts，使 SDK appendLangChainChunk 走 content_parts 替换分支，顺序由 contentPartsToMerged 保序，推理与工具按步展示。 */
function preparePartialChunkPayload(
  messages: StreamPartialAiMessage[],
  accumulatedById: Map<string, string>,
  getOrCreateStableAiId: (hintId: string) => string,
  getStableIdForIndex: (aiIndex: number) => string | undefined,
  setStableIdForIndex: (aiIndex: number, id: string) => void
) {
  const normalized = normalizeLangChainMessages(partialAiToChunkDeltas(messages, accumulatedById, getOrCreateStableAiId, getStableIdForIndex, setStableIdForIndex));
  if (!Array.isArray(normalized)) return normalized;
  return normalized;
}

const UI_STREAM_METRICS_STORAGE_KEY = 'maibot_ui_stream_metrics_v1';
const UI_STREAM_METRICS_MAX_SAMPLES = 240;
const _REPORTED_UI_METRICS_MAX_IDS = 600;

export type UiStreamMetricsState = {
  loaded: boolean;
  saveCounter: number;
  samples: Array<Record<string, unknown>>;
  reportedIds: Set<string>;
};

function _createUiStreamMetricsState(): UiStreamMetricsState {
  return { loaded: false, saveCounter: 0, samples: [], reportedIds: new Set<string>() };
}

function _isUiMetricsDebugEnabled(): boolean {
  if (Boolean(import.meta.env?.DEV)) return true;
  try {
    const raw = getStorageItem("maibot_metrics_debug");
    if (!raw) return false;
    const val = String(raw).trim().toLowerCase();
    return val === "1" || val === "true" || val === "on";
  } catch {
    return false;
  }
}

function _toFiniteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function _quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const w = pos - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function _loadUiMetricsOnce(state: UiStreamMetricsState) {
  if (state.loaded) return;
  state.loaded = true;
  try {
    const raw = getStorageItem(UI_STREAM_METRICS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const row of parsed.slice(-UI_STREAM_METRICS_MAX_SAMPLES)) {
      if (row && typeof row === 'object') state.samples.push(row as Record<string, unknown>);
    }
  } catch {
    // ignore corrupted metrics cache
  }
}

function _persistUiMetricsMaybe(force: boolean, state: UiStreamMetricsState) {
  state.saveCounter++;
  if (!force && state.saveCounter % 5 !== 0) return;
  try {
    setStorageItem(UI_STREAM_METRICS_STORAGE_KEY, JSON.stringify(state.samples.slice(-UI_STREAM_METRICS_MAX_SAMPLES)));
  } catch {
    // ignore storage quota / parse errors
  }
}

function _recordUiMetricsAndEmitSummary(sample: Record<string, unknown>, state: UiStreamMetricsState) {
  _loadUiMetricsOnce(state);
  state.samples.push(sample);
  if (state.samples.length > UI_STREAM_METRICS_MAX_SAMPLES) {
    state.samples.splice(0, state.samples.length - UI_STREAM_METRICS_MAX_SAMPLES);
  }
  _persistUiMetricsMaybe(false, state);

  const targets = [
    'ttft_ms',
    'stream_to_first_token_ms',
    'lmstudio_gap_overhead_ms',
    'max_inter_token_gap_ms',
    'partial_suppressed_count',
    'frontend_first_payload_ms',
    'frontend_first_ui_yield_ms',
    'total_ms',
    'stream_tokens_per_second_peak',
  ] as const;
  const summary: Record<string, unknown> = {
    samples: state.samples.length,
    window_size: UI_STREAM_METRICS_MAX_SAMPLES,
    updated_at: Date.now(),
  };
  const adaptiveOnSamples = state.samples.filter(
    (s) => String(s.adaptive_hotpath_active ?? '').toLowerCase() === 'true'
  );
  const adaptiveOffSamples = state.samples.filter(
    (s) => String(s.adaptive_hotpath_active ?? '').toLowerCase() !== 'true'
  );
  summary.adaptive_hotpath_hit_count = adaptiveOnSamples.length;
  summary.adaptive_hotpath_hit_rate = state.samples.length
    ? Number((adaptiveOnSamples.length / state.samples.length).toFixed(4))
    : 0;

  for (const key of targets) {
    const nums = state.samples
      .map((s) => _toFiniteNumber(s[key]))
      .filter((n): n is number => n != null)
      .sort((a, b) => a - b);
    if (!nums.length) continue;
    summary[`${key}_p50`] = Math.round(_quantile(nums, 0.5));
    summary[`${key}_p95`] = Math.round(_quantile(nums, 0.95));

    const onNums = adaptiveOnSamples
      .map((s) => _toFiniteNumber(s[key]))
      .filter((n): n is number => n != null)
      .sort((a, b) => a - b);
    const offNums = adaptiveOffSamples
      .map((s) => _toFiniteNumber(s[key]))
      .filter((n): n is number => n != null)
      .sort((a, b) => a - b);
    if (onNums.length) {
      summary[`adaptive_on_${key}_p50`] = Math.round(_quantile(onNums, 0.5));
      summary[`adaptive_on_${key}_p95`] = Math.round(_quantile(onNums, 0.95));
    }
    if (offNums.length) {
      summary[`adaptive_off_${key}_p50`] = Math.round(_quantile(offNums, 0.5));
      summary[`adaptive_off_${key}_p95`] = Math.round(_quantile(offNums, 0.95));
    }
    if (onNums.length && offNums.length) {
      summary[`adaptive_delta_${key}_p50`] =
        Math.round(_quantile(onNums, 0.5)) - Math.round(_quantile(offNums, 0.5));
      summary[`adaptive_delta_${key}_p95`] =
        Math.round(_quantile(onNums, 0.95)) - Math.round(_quantile(offNums, 0.95));
    }
  }
  window.dispatchEvent(new CustomEvent(EVENTS.UI_STREAM_METRICS_SUMMARY, { detail: summary }));
  void _reportUiMetricsSampleMaybe(sample, state);
}

async function _reportUiMetricsSampleMaybe(sample: Record<string, unknown>, state: UiStreamMetricsState) {
  try {
    const requestId = String(sample.request_id ?? '').trim();
    const dedupeKey = requestId || `${String(sample.model_id ?? '')}|${String(sample.ts ?? '')}`;
    if (!dedupeKey) return;
    if (state.reportedIds.has(dedupeKey)) return;
    state.reportedIds.add(dedupeKey);
    if (state.reportedIds.size > _REPORTED_UI_METRICS_MAX_IDS) {
      const first = state.reportedIds.values().next().value;
      if (first) state.reportedIds.delete(first);
    }
    await postUiStreamMetricsSample({
      request_id: requestId || undefined,
      model_id: String(sample.model_id ?? '') || undefined,
      ttft_ms: _toFiniteNumber(sample.ttft_ms) ?? undefined,
      stream_to_first_token_ms: _toFiniteNumber(sample.stream_to_first_token_ms) ?? undefined,
      lmstudio_gap_overhead_ms: _toFiniteNumber(sample.lmstudio_gap_overhead_ms) ?? undefined,
      max_inter_token_gap_ms: _toFiniteNumber(sample.max_inter_token_gap_ms) ?? undefined,
      partial_suppressed_count: _toFiniteNumber(sample.partial_suppressed_count) ?? undefined,
      frontend_first_payload_ms: _toFiniteNumber(sample.frontend_first_payload_ms) ?? undefined,
      frontend_first_ui_yield_ms: _toFiniteNumber(sample.frontend_first_ui_yield_ms) ?? undefined,
      frontend_max_inter_payload_gap_ms: _toFiniteNumber(sample.frontend_max_inter_payload_gap_ms) ?? undefined,
      total_ms: _toFiniteNumber(sample.total_ms) ?? undefined,
      ts: _toFiniteNumber(sample.ts) ?? undefined,
    });
  } catch {
    // 上报失败不影响主链路
  }
}

function buildSendFailureGuidance(error: unknown): string {
  const friendly = formatApiErrorMessage(error) || t("composer.receiveReplyFailed");
  const normalized = friendly.toLowerCase();
  let nextStep = t("composer.checkNetworkBackend");
  if (
    normalized.includes("failed to fetch") ||
    normalized.includes("network error") ||
    normalized.includes("connection refused") ||
    normalized.includes("econnrefused")
  ) {
    nextStep = t("runtime.nextStep.langgraph");
  } else if (normalized.includes("thread") && normalized.includes("not found")) {
    nextStep = t("runtime.nextStep.threadInvalid");
  } else if (normalized.includes("timeout") || normalized.includes("timed out")) {
    nextStep = t("runtime.nextStep.timeout");
  } else if (
    normalized.includes("failed to load model") ||
    normalized.includes("insufficient system resources") ||
    normalized.includes("显存/内存不足") ||
    normalized.includes("model loading was stopped")
  ) {
    nextStep = t("runtime.nextStep.modelResource");
  }
  return t("runtime.errorFormat", { cause: friendly, next: nextStep });
}

/**
 * MyRuntimeProvider - 基于 assistant-ui 官方 useLangGraphRuntime 实现
 * 
 * 关键修复：
 * 当没有配置 cloud 参数时，InMemoryThreadListAdapter.initialize() 
 * 会返回 externalId: undefined。我们需要在 stream 函数中手动创建 Thread。
 * 
 * Thread 只在第一次发送消息时创建，后续消息复用同一个 Thread。
 */

interface MyRuntimeProviderProps {
  children: React.ReactNode;
  editorContext?: {
    editorContent?: string;
    editorPath?: string;
    selectedText?: string;
    cursorLine?: number;
    linterErrors?: Array<{ path: string; line: number; col: number; severity: number; message: string }>;
    workspaceFiles?: string[];
    workspacePath?: string;
    workspaceId?: string;
  };
  selectedModel?: string | null;
  onThreadChange?: (threadId: string | null) => void;
  onFileAction?: (action: { type: "open" | "refresh" | "close"; filePath: string; content?: string }) => void;
  openFiles?: Array<{ path: string; totalLines?: number; cursorLine?: number }>; // ✅ 当前打开的文件
  recentlyViewedFiles?: string[]; // ✅ 最近查看的文件
  /** 工作区根路径；有值时 @ 文件候选 = 打开文件（优先） + 工作区文件列表 */
  workspacePath?: string;
  /** 工作区内的文件列表（由父级传入则直接使用，否则按 workspacePath 拉取） */
  workspaceFiles?: Array<{ path: string; name: string }>;
}

export function MyRuntimeProvider({
  children,
  editorContext,
  selectedModel: selectedModelProp,
  onThreadChange,
  onFileAction,
  openFiles,
  recentlyViewedFiles,
  workspacePath,
  workspaceFiles,
}: MyRuntimeProviderProps) {
  const { resolveWorkspacePath } = useWorkspacePath();
  // 使用 ref 存储 editorContext（避免 stream 闭包问题）
  const editorContextRef = React.useRef(editorContext);
  React.useEffect(() => {
    editorContextRef.current = editorContext;
  }, [editorContext]);

  // ✅ 存储 onFileAction，供流式处理中文件操作时通知编辑器
  const onFileActionRef = React.useRef(onFileAction);
  React.useEffect(() => {
    onFileActionRef.current = onFileAction;
  }, [onFileAction]);

  // ✅ 存储打开文件和最近文件（Cursor 风格环境感知）
  const openFilesRef = React.useRef(openFiles);
  const recentlyViewedFilesRef = React.useRef(recentlyViewedFiles);
  React.useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);
  React.useEffect(() => {
    recentlyViewedFilesRef.current = recentlyViewedFiles;
  }, [recentlyViewedFiles]);

  // ✅ 工作区文件列表：仅当 workspaceFiles 未传且存在 workspacePath 时按需拉取（缓存 key = workspacePath）
  const [fetchedWorkspaceFiles, setFetchedWorkspaceFiles] = React.useState<Array<{ path: string; name: string }>>([]);
  const lastFetchedWorkspacePathRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!workspacePath?.trim()) {
      setFetchedWorkspaceFiles([]);
      lastFetchedWorkspacePathRef.current = null;
      return;
    }
    if (workspaceFiles !== undefined) {
      setFetchedWorkspaceFiles([]);
      lastFetchedWorkspacePathRef.current = null;
      return;
    }
    const path = workspacePath.trim();
    if (lastFetchedWorkspacePathRef.current === path) return;
    lastFetchedWorkspacePathRef.current = path;
    let cancelled = false;
    getFileTreeByPath(path, 4)
      .then((tree) => {
        if (cancelled) return;
        setFetchedWorkspaceFiles(flattenFileTreeToFiles(tree, 200));
      })
      .catch(() => {
        if (!cancelled) {
          setFetchedWorkspaceFiles([]);
          lastFetchedWorkspacePathRef.current = null;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath, workspaceFiles]);
  
  // ✅ 存储上下文项（文件/文件夹/代码/URL）
  const contextItemsRef = React.useRef<ContextItem[]>([]);

  // ✅ UI 流式指标状态（每实例独立，避免多窗口/HMR 污染）
  const uiMetricsStateRef = React.useRef<UiStreamMetricsState>(_createUiStreamMetricsState());
  
  // 监听上下文项变化事件
  React.useEffect(() => {
    const handleContextItemsChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ contextItems?: unknown }>).detail;
      if (detail?.contextItems != null) contextItemsRef.current = detail.contextItems as typeof contextItemsRef.current;
    };
    window.addEventListener(EVENTS.CONTEXT_ITEMS_CHANGED, handleContextItemsChanged);
    return () => {
      window.removeEventListener(EVENTS.CONTEXT_ITEMS_CHANGED, handleContextItemsChanged);
    };
  }, []);

  // ✅ 获取系统环境信息（Cursor 风格）
  const getSystemEnvironment = React.useCallback(() => {
    const platform = getPlatform();
    // 映射平台到 OS 版本格式
    const osVersionMap: Record<string, string> = {
      'darwin': 'macOS',
      'win32': 'Windows',
      'linux': 'Linux',
      'web': 'Web Browser',
    };
    // 默认 shell 配置
    const defaultShellMap: Record<string, string> = {
      'darwin': '/bin/zsh',
      'win32': 'cmd.exe',
      'linux': '/bin/bash',
      'web': '',
    };
    return {
      os_version: osVersionMap[platform] || platform,
      shell: defaultShellMap[platform] || '',
      platform: platform,
      is_electron: isElectronEnv(),
    };
  }, []);

  // ✅ 从 Context 或 props 获取选择的模型
  const modelContext = React.useContext(ModelContext);
  const selectedModel = selectedModelProp ?? modelContext.selectedModel;
  
  // ✅ 使用 ref 存储选择的模型（避免 stream 闭包问题）
  // 关键：初始值从 localStorage 获取，确保首次发送时能使用正确的模型
  const MODEL_STORAGE_KEY = "maibot_selected_model";
  const MODEL_SUPPORTS_IMAGES_KEY = "maibot_selected_model_supports_images";
  const NO_MODELS_SENTINEL = "__no_models__";
  const getInitialModel = (): string | null => {
    if (typeof window !== 'undefined') {
      const v = getStorageItem(MODEL_STORAGE_KEY);
      if (v === NO_MODELS_SENTINEL) return null;
      return v || null;
    }
    return null;
  };
  const selectedModelRef = React.useRef<string | null>(getInitialModel());
  
  // 当 selectedModel 变化时更新 ref（含清空时同步重置）
  React.useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);
  
  // ✅ 监听 localStorage 变化（跨组件同步）
  React.useEffect(() => {
    const handleStorageChange = (e?: StorageEvent) => {
      if (e && e.key !== MODEL_STORAGE_KEY) return;
      
      const storedModel = getStorageItem(MODEL_STORAGE_KEY) || null;
      if (storedModel === NO_MODELS_SENTINEL) {
        if (selectedModelRef.current === NO_MODELS_SENTINEL) selectedModelRef.current = null;
        return;
      }
      if (storedModel && storedModel !== selectedModelRef.current) {
        selectedModelRef.current = storedModel;
      }
    };
    
    // 监听 storage 事件（跨标签页）
    window.addEventListener('storage', handleStorageChange);
    
    // 监听自定义事件（同一标签页内的变化）
    const handleModelChange = (evt?: Event) => {
      const detail = (evt as CustomEvent<{ supportsImages?: boolean }> | undefined)?.detail;
      if (detail && typeof detail.supportsImages === "boolean") {
        setStorageItem(MODEL_SUPPORTS_IMAGES_KEY, String(detail.supportsImages));
      }
      handleStorageChange();
    };
    window.addEventListener('model_changed', handleModelChange as EventListener);
    
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('model_changed', handleModelChange as EventListener);
    };
  }, []);
  
  // 确保 ref 有值（从 localStorage 或 Context）
  React.useEffect(() => {
    if (!selectedModelRef.current && typeof window !== 'undefined') {
      const storedModel = getStorageItem(MODEL_STORAGE_KEY) || null;
      if (storedModel && storedModel !== NO_MODELS_SENTINEL) {
        selectedModelRef.current = storedModel;
      }
    }
  }, []);

  // VALID_SKILL_PROFILES / _PROFILE_ALIAS 已提升至模块顶部

  // ✅ Thread ID 单一真源：state 为源，effect 同步到 ref 与 storage，ref 仅作只读镜像供回调/stream 使用
  const currentThreadIdRef = React.useRef<string | null>(null);
  const [currentThreadId, setCurrentThreadId] = React.useState<string | null>(null);
  const setCurrentThreadIdRef = React.useRef(setCurrentThreadId);
  const hasMountedRef = React.useRef(false);
  const isMountedRef = React.useRef(true);
  React.useEffect(() => {
    setCurrentThreadIdRef.current = setCurrentThreadId;
  }, [setCurrentThreadId]);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    currentThreadIdRef.current = currentThreadId;
    if (currentThreadId) {
      activateThreadSession(currentThreadId, currentThreadId.slice(0, 8));
    } else if (hasMountedRef.current) {
      clearActiveThreadSession();
    }
  }, [currentThreadId]);

  React.useEffect(() => {
    hasMountedRef.current = true;
    const fromStorage = getCurrentThreadIdFromStorage();
    if (fromStorage.trim()) {
      // 仅当为服务端 UUID 时恢复，避免沿用 thread-1 / thread-{timestamp} 等无效 ID
      if (isValidServerThreadId(fromStorage)) {
        setCurrentThreadId(fromStorage);
      } else {
        if (import.meta.env?.DEV) console.debug("[MyRuntimeProvider] 存储中的 threadId 非服务端 UUID，清除", fromStorage.slice(0, 24));
        clearActiveThreadSession();
      }
    }
  }, []);

  const resolveActiveRoleId = (): string => {
    const roleId = getScopedActiveRoleIdFromStorage();
    return roleId || normalizeRoleId(getStorageItem("maibot_active_role"));
  };

  const resolveActiveChatMode = (): "agent" | "plan" | "ask" | "debug" | "review" => {
    const threadId = currentThreadIdRef.current || undefined;
    return resolveScopedChatMode(threadId);
  };

  type RuntimeLocalSettings = {
    workspaceDomain: string;
    taskType: string;
    skillProfile: string;
    licenseTier: string;
    webSearchEnabled: boolean;
    researchMode: boolean;
    reviewPolicy: string;
    reviewTemplate: string;
    toolToggles: Record<string, boolean>;
    sessionPlugins: string[];
  };

  const runtimeLocalSettingsRef = React.useRef<RuntimeLocalSettings | null>(null);
  const invalidateRuntimeLocalSettings = React.useCallback(() => {
    runtimeLocalSettingsRef.current = null;
  }, []);
  const readRuntimeLocalSettings = React.useCallback((): RuntimeLocalSettings => {
    const workspaceDomain = getStorageItem('maibot_workspace_domain') || 'general';
    const taskType = getStorageItem('maibot_task_type') || '';
    let rawSkillProfile = getStorageItem('maibot_skill_profile') || 'full';
    const normalizedSkillProfile = _PROFILE_ALIAS[rawSkillProfile] || rawSkillProfile;
    if (normalizedSkillProfile !== rawSkillProfile) {
      rawSkillProfile = normalizedSkillProfile;
      setStorageItem('maibot_skill_profile', normalizedSkillProfile);
    }
    const skillProfile = VALID_SKILL_PROFILES.includes(rawSkillProfile as any) ? rawSkillProfile : 'full';
    const licenseTier = (getStorageItem('maibot_license_tier') || 'free').trim().toLowerCase() || 'free';
    const webSearchEnabled = getStorageItem('maibot_web_search') === 'true';
    const researchMode = getStorageItem('maibot_research_mode') === 'true';
    const reviewPolicy = getStorageItem('maibot_review_policy') || 'notify';
    const reviewTemplate = getStorageItem('maibot_review_template') || 'standard';
    const threadId = currentThreadIdRef.current || getCurrentThreadIdFromStorage() || "";
    let sessionPlugins: string[] = [];
    if (threadId) {
      try {
        const rawSession = getStorageItem(`maibot_session_plugins_thread_${threadId}`) || "[]";
        const parsed = JSON.parse(rawSession);
        if (Array.isArray(parsed)) {
          sessionPlugins = parsed
            .map((x) => String(x || "").trim())
            .filter(Boolean);
        }
      } catch {
        sessionPlugins = [];
      }
    }
    let toolToggles: Record<string, boolean> = {};
    try {
      const raw = getStorageItem('maibot_tool_toggles');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          toolToggles = parsed as Record<string, boolean>;
        }
      }
    } catch {
      toolToggles = {};
    }
    return {
      workspaceDomain,
      taskType,
      skillProfile,
      licenseTier,
      webSearchEnabled,
      researchMode,
      reviewPolicy,
      reviewTemplate,
      toolToggles,
      sessionPlugins,
    };
  }, []);
  const getRuntimeLocalSettings = React.useCallback((): RuntimeLocalSettings => {
    if (runtimeLocalSettingsRef.current) return runtimeLocalSettingsRef.current;
    const next = readRuntimeLocalSettings();
    runtimeLocalSettingsRef.current = next;
    return next;
  }, [readRuntimeLocalSettings]);

  React.useEffect(() => {
    const onStorage = () => invalidateRuntimeLocalSettings();
    window.addEventListener('storage', onStorage);
    window.addEventListener(EVENTS.SESSION_CHANGED, onStorage as EventListener);
    window.addEventListener(EVENTS.SESSION_CREATED, onStorage as EventListener);
    window.addEventListener(EVENTS.CHAT_MODE_CHANGED, onStorage as EventListener);
    window.addEventListener(EVENTS.ROLE_CHANGED, onStorage as EventListener);
    window.addEventListener(EVENTS.COMPOSER_PREFS_CHANGED, onStorage as EventListener);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(EVENTS.SESSION_CHANGED, onStorage as EventListener);
      window.removeEventListener(EVENTS.SESSION_CREATED, onStorage as EventListener);
      window.removeEventListener(EVENTS.CHAT_MODE_CHANGED, onStorage as EventListener);
      window.removeEventListener(EVENTS.ROLE_CHANGED, onStorage as EventListener);
      window.removeEventListener(EVENTS.COMPOSER_PREFS_CHANGED, onStorage as EventListener);
    };
  }, [invalidateRuntimeLocalSettings]);

  // 同一会话内：工具/计划确认后 run 继续；派发 INTERRUPT_RESOLVED 携带 run_id；若有 generator 在等接流则 resolve 并接流续显
  React.useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ threadId?: string; run_id?: string }>).detail;
      const runId = detail?.run_id;
      if (typeof runId !== 'string') return;
      const tid = detail?.threadId;
      if (!tid || !isValidServerThreadId(tid)) return;
      const current = currentThreadIdRef.current || getCurrentThreadIdFromStorage() || '';
      if (tid === current) {
        currentRunIdRef.current = runId;
        toolStreamEventBus.handleStreamEvent({ type: 'run_id', run_id: runId, threadId: tid });
        const r = resumeRunResolverRef.current;
        if (r && tid === r.threadId) {
          r.resolve(runId);
          resumeRunResolverRef.current = null;
        }
      }
    };
    window.addEventListener(EVENTS.INTERRUPT_RESOLVED, handler);
    return () => window.removeEventListener(EVENTS.INTERRUPT_RESOLVED, handler);
  }, []);

  const resolveThreadTitle = React.useCallback((state: Awaited<ReturnType<typeof getThreadState>> | undefined, threadId: string): string => {
    const metadataTitle = String((state?.metadata as { title?: string } | undefined)?.title ?? "").trim();
    if (metadataTitle) return metadataTitle.slice(0, 40);
    const values = state?.values as { messages?: Array<{ type?: string; content?: unknown }> } | undefined;
    const rawMessages = values?.messages;
    const messages = Array.isArray(rawMessages) ? rawMessages : [];
    const lastHuman = [...messages].reverse().find((m) => m?.type === "human");
    const content = typeof lastHuman?.content === "string" ? lastHuman.content.trim() : "";
    if (content) return content.slice(0, 40);
    return threadId.slice(0, 8);
  }, []);

  const activateThread = React.useCallback((threadId: string, title?: string) => {
    setCurrentThreadId(threadId);
    try {
      activateThreadSession(threadId, title);
    } catch (e) {
      if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] activateThreadSession failed', e);
    }
    onThreadChange?.(threadId);
  }, [onThreadChange]);

  const createAndActivateThread = React.useCallback(
    async (titleHint?: string, preResolvedWorkspacePath?: string): Promise<string> => {
      await checkHealth(true);
      if (!getCachedHealthStatus().healthy) {
        await waitForBackend(3, 2000).catch(() => {
          toast.error(t("connection.serviceError"), { description: t("modelSelector.cannotConnectBackend") });
        });
      }
      const userContext = getUserContext();
      const parentThreadId = currentThreadIdRef.current || getCurrentThreadIdFromStorage() || "";
      const inheritedRoleId = resolveActiveRoleId();
      const inheritedMode = resolveActiveChatMode();
      const resolvedWorkspacePath = preResolvedWorkspacePath || await resolveWorkspacePath(editorContextRef.current?.workspacePath);
      const { thread_id } = await createThread({
        user_id: userContext.userId,
        team_id: userContext.teamId,
        user_name: userContext.userName,
        team_name: userContext.teamName,
        ...(resolvedWorkspacePath ? { workspace_path: resolvedWorkspacePath } : {}),
        ...(inheritedRoleId ? { active_role_id: inheritedRoleId, role_id: inheritedRoleId } : {}),
        mode: inheritedMode,
        parent_thread_id: parentThreadId || undefined,
      });
      if (inheritedRoleId) {
        setScopedActiveRoleIdInStorage(inheritedRoleId, thread_id);
      }
      setScopedChatMode(inheritedMode, thread_id);
      const initialTitle = thread_id.slice(0, 8);
      activateThread(thread_id, initialTitle);
      emitSessionCreated({
        threadId: thread_id,
        title: initialTitle,
        roleId: inheritedRoleId,
        mode: inheritedMode,
        workspacePath: resolvedWorkspacePath,
      });
      if (titleHint) {
        const titleToSave = titleHint.trim().slice(0, 80) || "新对话";
        updateThreadTitle(thread_id, titleToSave)
          .then(() => {
            if (!isMountedRef.current) return;
            window.dispatchEvent(
              new CustomEvent(EVENTS.SESSION_CHANGED, { detail: { threadId: thread_id, title: titleToSave } })
            );
          })
          .catch((e) => {
            if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] updateThreadTitle failed', e);
          });
      }
      return thread_id;
    },
    [activateThread, resolveWorkspacePath]
  );

  const latestLoadIdRef = React.useRef<string | null>(null);
  const { loadThreadState } = useThreadStateLoader({
    activateThread,
    createAndActivateThread,
    resolveThreadTitle,
    getLatestRequestedThreadId: () => latestLoadIdRef.current,
  });

  const [threadLoadError, setThreadLoadError] = React.useState<string | null>(null);
  const [failedThreadIdForRetry, setFailedThreadIdForRetry] = React.useState<string | null>(null);
  /** run 结束后 SDK 的 useEffect 可能再次调用 load(id) 并用返回值 setMessages；若服务端返回未包含刚生成消息的状态会清空会话。流中 yield 的 messages 会记入此 ref，load 时若服务端条数少于流中条数且流结果在有效期内则沿用流结果。 */
  const lastStreamMessagesByThreadRef = React.useRef<Record<string, { messages: LangChainMessage[]; at: number }>>({});
  const lastLoadByThreadRef = React.useRef<Record<string, { messages: LangChainMessage[]; at: number }>>({});
  /** custom messages_partial 下发的 content_parts（含 reasoning）缓存；messages/complete 时若主通道消息无 reasoning 则用此恢复，避免终态被覆盖丢失思考块。 */
  const lastContentPartsByMessageIdRef = React.useRef<Record<string, Array<{ type: string; text?: string; id?: string; name?: string; args?: unknown; result?: string }>>>({});
  const LOAD_STALE_GUARD_MS = 10000;
  const loadWrapped = React.useCallback(
    async (externalId: string) => {
      latestLoadIdRef.current = externalId;
      try {
        setThreadLoadError(null);
        const result = await loadThreadState(externalId);
        if ((result as { __stale?: boolean }).__stale) {
          const currentId = latestLoadIdRef.current;
          const forCurrent = (currentId && lastStreamMessagesByThreadRef.current[currentId]?.messages) || (currentId && lastLoadByThreadRef.current[currentId]?.messages) || [];
          const msgs = normalizeLangChainMessages(forCurrent) as LangChainMessage[];
          ensureAiMessagesHaveContentParts(msgs);
          logLoadReturnIfDev(msgs, 'stale');
          return { messages: msgs, interrupts: [] };
        }
        const createdThreadId = (result as { createdThreadId?: string }).createdThreadId;
        const raw = Array.isArray(result.messages) ? result.messages : [];
        const messages = raw.map((m: { type?: string; role?: string; tool_call_id?: string; toolCallId?: string; [k: string]: unknown }) => {
          const type = m?.type ?? (m?.role === "assistant" ? "ai" : m?.role === "user" ? "human" : m?.role === "tool" ? "tool" : m?.role);
          const toolCallId = m?.tool_call_id ?? m?.toolCallId;
          return { ...m, type, ...(toolCallId != null && { tool_call_id: toolCallId }) };
        }) as Array<{ type?: string; id?: string; content?: unknown; tool_calls?: Array<{ id?: string; name?: string; args?: unknown }>; tool_call_id?: string; name?: string }>;
        const merged = messages.length > 0 ? mergeToolResultsIntoAiMessages(messages) : messages;
        const outMessages = normalizeLangChainMessages(merged) as LangChainMessage[];
        const now = Date.now();
        const streamCached = lastStreamMessagesByThreadRef.current[externalId];
        const loadCached = lastLoadByThreadRef.current[externalId];
        if (streamCached && streamCached.messages.length > outMessages.length && (now - streamCached.at) < LOAD_STALE_GUARD_MS) {
          if (import.meta.env?.DEV) {
            console.warn("[MyRuntimeProvider] load 防抖：服务端条数少于流中已下发，沿用流结果避免清空会话", { threadId: externalId.slice(0, 8), server: outMessages.length, stream: streamCached.messages.length });
          }
          const cached = normalizeLangChainMessages(streamCached.messages) as LangChainMessage[];
          ensureAiMessagesHaveContentParts(cached);
          logLoadReturnIfDev(cached, 'streamCached');
          lastLoadByThreadRef.current[externalId] = { messages: cached, at: now };
          return { ...result, messages: cached };
        }
        if (loadCached && loadCached.messages.length > outMessages.length && (now - loadCached.at) < LOAD_STALE_GUARD_MS) {
          if (import.meta.env?.DEV) {
            console.warn("[MyRuntimeProvider] load 防抖：服务端条数少于近期 load 缓存，沿用缓存", { threadId: externalId.slice(0, 8), server: outMessages.length, cached: loadCached.messages.length });
          }
          const msgs = normalizeLangChainMessages(loadCached.messages) as LangChainMessage[];
          ensureAiMessagesHaveContentParts(msgs);
          logLoadReturnIfDev(msgs, 'loadCached');
          return { ...result, messages: msgs };
        }
        const cacheKey = createdThreadId && isValidServerThreadId(createdThreadId) ? createdThreadId : externalId;
        ensureAiMessagesHaveContentParts(outMessages);
        logLoadReturnIfDev(outMessages, 'outMessages');
        lastLoadByThreadRef.current[cacheKey] = { messages: outMessages, at: now };
        return { ...result, messages: outMessages };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const streamCached = lastStreamMessagesByThreadRef.current[externalId];
        const loadCached = lastLoadByThreadRef.current[externalId];
        const fallback = streamCached?.messages?.length
          ? streamCached.messages
          : loadCached?.messages?.length
            ? loadCached.messages
            : [];
        if (fallback.length > 0) {
          setThreadLoadError(null);
          const msgs = normalizeLangChainMessages(fallback) as LangChainMessage[];
          ensureAiMessagesHaveContentParts(msgs);
          logLoadReturnIfDev(msgs, 'fallback');
          return { messages: msgs, interrupts: [] };
        }
        setThreadLoadError(msg);
        setFailedThreadIdForRetry(externalId);
        return { messages: [], interrupts: [] };
      }
    },
    [loadThreadState]
  );

  // ✅ 防止重复发送：存储最近处理的消息信息（messageId 2s 去重 + content 500ms 去重，避免双触）
  const lastProcessedRef = React.useRef<{
    messageId: string | null;
    timestamp: number;
    contentKey?: string;
    contentTimestamp?: number;
  }>({ messageId: null, timestamp: 0 });
  
  // ✅ 防止并发执行
  const isStreamingRef = React.useRef(false);
  // ✅ 流版本号：每次进入 stream 自增，finally 中仅当版本匹配时才清除 isStreamingRef，避免旧流覆盖新流标志
  const streamVersionRef = React.useRef(0);
  // ✅ 当前运行的 run_id（流式开始时由 SDK onRunCreated 设置，用于停止按钮调用 cancel）
  const currentRunIdRef = React.useRef<string | null>(null);
  // ✅ 本 run 内 session_context 是否已应用（仅应用一次，避免重复写存储与派发 EVENTS）
  const sessionContextAppliedForRunRef = React.useRef(false);
  // ✅ 当前流的 AbortController（停止时 abort 以立即中断 fetch，配合 cancelRun 服务端取消）
  const streamAbortControllerRef = React.useRef<AbortController | null>(null);
  // ✅ 流会话代号：中途注入后，旧流事件即使迟到也会被丢弃，避免串流污染
  const activeStreamTokenRef = React.useRef(0);
  // ✅ 互斥：同一时刻只允许一个 stream 执行 initialize()，防止并发双重创建线程
  const initializingRef = React.useRef(false);
  // ✅ 互斥：同一时刻只允许一个 stream 执行「创建/校验线程」，避免多路并发导致挂起或重复创建
  const threadEnsureInProgressRef = React.useRef(false);
  // ✅ 串行化 stream：后进入的调用等待前一轮完成后才执行，避免多路并发导致「被废弃」与 running 状态混乱
  const streamSerialPromiseRef = React.useRef<Promise<void>>(Promise.resolve());
  const streamSerialResolveRef = React.useRef<(() => void) | null>(null);
  /** 工具/计划确认后接流：stream_paused 时由 generator 等待，INTERRUPT_RESOLVED 时 resolve 并传入 run_id */
  const resumeRunResolverRef = React.useRef<{ resolve: (runId: string) => void; reject: (err: Error) => void; threadId: string } | null>(null);

  // 不传 cloud：assistant-ui 的 cloud 需完整 AssistantCloud 接口（threads.list/create/update/delete 等），
  // 与 LangGraph API 形状不一致，传错会导致 "Cannot read properties of undefined (reading 'list')"。使用内存线程列表，仪表盘「继续」失败时由下方 toast 提示。
  // ✅ 完全按照官方示例使用 useLangGraphRuntime（同对象内已有 load，切换线程时从 API 拉消息）
  const runtime = useLangGraphRuntime({
    // ✅ 启用取消功能
    unstable_allowCancellation: true,
    // ✅ 附件适配器 - 支持文件上传
    adapters: {
      attachments: {
        accept: "*/*",
        
        // ✅ 添加附件（用户选择文件时调用）
        async add({ file }) {
          
          
          // ✅ 使用文件名作为 key（LangGraph Store 会自动去重：相同 key 会覆盖）
          // 这样同一文件不会重复存储
          const fileId = file.name;
          
          return {
            id: fileId,
            type: file.type.startsWith("image/") ? "image" : "file",
            name: file.name,
            file,
            contentType: file.type,
            content: [],
            status: { type: "requires-action", reason: "composer-send" },
          };
        },
        
        // ✅ 发送附件（上传到服务器文件系统）
        // 标准做法：通过 HTTP API 上传文件，返回文件路径给 LLM
        async send(attachment) {
          try {
            // ✅ 通过 HTTP API 上传文件到服务器
            const uploadResult = await filesApi.uploadFile(attachment.file);
            if (!uploadResult.ok || !uploadResult.data?.path) {
              throw new Error(uploadResult.error || t("runtime.uploadFailed", { url: getApiBase() }));
            }
            const result = uploadResult.data;
            const filePath = result.path; // 服务器返回的绝对路径
            
            // ✅ 同步到 contextItemsRef，确保 Agent 能通过 context_items 获取附件路径
            const newContextItem = {
              id: attachment.id,
              type: (attachment.type === "image" ? "image" : "file") as "file" | "folder" | "code" | "url" | "image",
              name: attachment.name,
              path: filePath,
            };
            
            // 检查是否已存在（避免重复添加）
            const existingIndex = contextItemsRef.current.findIndex(item => item.id === attachment.id);
            if (existingIndex >= 0) {
              // 更新已存在的项
              contextItemsRef.current[existingIndex] = newContextItem;
            } else {
              // 添加新项
              contextItemsRef.current = [...contextItemsRef.current, newContextItem];
            }
            
            // 触发事件通知其他组件
            window.dispatchEvent(new CustomEvent(EVENTS.CONTEXT_ITEMS_CHANGED, {
              detail: { contextItems: contextItemsRef.current }
            }));
            
            // ✅ 精简文件信息（避免冗余干扰 LLM 判断）
            const fileInfoText = attachment.type === "image"
              ? `[附件] ${attachment.name} (${filePath})\n[提示] 可直接输入“分析这张图”让我读取并分析该图片。`
              : `[附件] ${attachment.name} (${filePath})`;
            
            return {
              ...attachment,
              status: { type: "complete" },
              content: [
                {
                  type: "text",
                  text: fileInfoText,
                },
              ],
            };
          } catch (error) {
            console.error('[MyRuntimeProvider] ❌ 文件上传失败:', error);
            const friendlyMsg = formatApiErrorMessage(error);
            if (friendlyMsg) toast.error(t('composer.uploadFileError'), { description: friendlyMsg });
            throw error;
          }
        },
        
        // ✅ 移除附件（可选）
        async remove(attachment) {
          // 从 contextItemsRef 中移除
          contextItemsRef.current = contextItemsRef.current.filter(item => item.id !== attachment.id);
          
          // 触发事件通知其他组件
          window.dispatchEvent(new CustomEvent(EVENTS.CONTEXT_ITEMS_CHANGED, {
            detail: { contextItems: contextItemsRef.current }
          }));
          
          // 注意：LangGraph Server 可能不会自动删除文件
          // 如果需要删除，可以调用 DELETE /files/{id}
        },
      },
    },

    // ✅ stream 函数 - 发送消息到 LangGraph Server
    stream: async function* (messages, { initialize }) {
      if (import.meta.env?.DEV) console.log('[MyRuntimeProvider] stream() 进入', { messagesLength: messages?.length, isStreamingBefore: isStreamingRef.current });
      // ✅ 串行化：等待上一轮 stream 完全结束后再执行，避免多路并发导致废弃 run 与 running 状态错乱
      const waitForPrevious = streamSerialPromiseRef.current;
      streamSerialPromiseRef.current = new Promise<void>((r) => { streamSerialResolveRef.current = r; });
      await waitForPrevious;
      if (import.meta.env?.DEV) console.log('[MyRuntimeProvider] stream: 串行锁已获取');
      try {
      // ✅ 工具调用参数缓存（用于在工具完成时再次检测文件操作），限制 300 条防止泄漏
      const MAX_TOOL_CALL_CACHE = 300;
      const toolCallArgsCache = new Map<string, { toolName: string; args: Record<string, any> }>();
      
      // ✅ 防止并发执行：先占位再检查，避免两条消息同时通过后都创建线程
      if (isStreamingRef.current) {
        // 支持“中途注入”：中断当前流，通过 token 让旧 generator 在下一轮 for-await 自然退出，无需忙等。
        try {
          streamAbortControllerRef.current?.abort();
        } catch {
          // ignore
        }
        activeStreamTokenRef.current++;
        try {
          const runningThreadId = currentThreadIdRef.current;
          const runningRunId = currentRunIdRef.current;
          if (runningThreadId) {
            await cancelRun(runningThreadId, runningRunId ?? undefined);
          }
        } catch {
          // ignore
        }
      }
      isStreamingRef.current = true;

      // ✅ 只发送最后一条消息（用户新发送的消息）
      const lastMessage = messages[messages.length - 1];
      if (!lastMessage) {
        isStreamingRef.current = false;
        if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] ⚠️ 没有消息可发送');
        return;
      }

      // ✅ 防重：优先使用 messageId；内容指纹只做短窗保护（避免双触、重试导致重复请求）
      const messageId = lastMessage.id;
      const now = Date.now();
      const contentStr = typeof lastMessage.content === 'string'
        ? lastMessage.content
        : Array.isArray(lastMessage.content)
          ? (lastMessage.content as Array<{ type?: string; text?: string } | null | undefined>).map(b => (b && typeof b === 'object' ? (b as { text?: string }).text : undefined) ?? '').join('')
          : String(lastMessage.content ?? '');
      const contentHash = (() => {
        if (!contentStr) return '';
        let hash = 2166136261;
        for (let i = 0; i < contentStr.length; i++) {
          hash ^= contentStr.charCodeAt(i);
          hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
        }
        return `${contentStr.length}:${(hash >>> 0).toString(16)}`;
      })();
      if (
        messageId &&
        lastProcessedRef.current.messageId === messageId &&
        now - lastProcessedRef.current.timestamp < 2000
      ) {
        isStreamingRef.current = false;
        streamAbortControllerRef.current = null;
        currentRunIdRef.current = null;
        if (import.meta.env?.DEV) console.log('[MyRuntimeProvider] 消息已处理过，跳过:', messageId);
        return;
      }
      if (
        contentHash &&
        lastProcessedRef.current.contentKey === contentHash &&
        lastProcessedRef.current.contentTimestamp != null &&
        now - lastProcessedRef.current.contentTimestamp < 500
      ) {
        isStreamingRef.current = false;
        streamAbortControllerRef.current = null;
        currentRunIdRef.current = null;
        if (import.meta.env?.DEV) console.log('[MyRuntimeProvider] 同内容 500ms 内已发送，跳过');
        return;
      }
      lastProcessedRef.current = {
        messageId: messageId ?? null,
        timestamp: now,
        contentKey: contentHash,
        contentTimestamp: contentHash ? now : undefined,
      };
      const streamToken = ++activeStreamTokenRef.current;
      const myStreamVersion = ++streamVersionRef.current;
      try {
        window.dispatchEvent(new CustomEvent('task_running', { detail: { running: true } }));
      } catch { /* ignore */ }

      // 与 finally 及两处 isUserAbort 分支共用，保证 abort 时也释放串行锁并清理状态，避免下次发送卡住
      const runStreamCleanup = (version: number, reason?: 'complete' | 'abort' | 'error', runThreadId?: string) => {
        if (streamVersionRef.current === version) {
          isStreamingRef.current = false;
          currentRunIdRef.current = null;
          streamAbortControllerRef.current = null;
          const tidForEvent = runThreadId || (currentThreadIdRef.current ?? getCurrentThreadIdFromStorage() ?? "");
          toolStreamEventBus.handleStreamEvent({ type: 'stream_end', threadId: tidForEvent || undefined, ...(reason && { reason }) });
          const emitStopped = () => {
            try {
              window.dispatchEvent(new CustomEvent('task_running', { detail: { running: false } }));
            } catch { /* ignore */ }
          };
          emitStopped();
          setTimeout(emitStopped, 150);
          const tidToClear = runThreadId || (currentThreadIdRef.current ?? getCurrentThreadIdFromStorage() ?? "");
          if (tidToClear) {
            // 不再在 stream 结束时清空思考流，会话内容长期保留；下次 run 的 reasoning phase=start 时再清空
            clearStepsForThread(tidToClear);
            emitStepsUpdated(tidToClear, []);
          }
          toolCallArgsCache.clear();
          toolStreamEventBus.reset();
        }
        try {
          streamSerialResolveRef.current?.();
          streamSerialResolveRef.current = null;
        } catch { /* ignore */ }
      };

      const ctx = editorContextRef.current;
      // 互斥：同一时刻只允许一个 stream 执行 initialize()
      if (import.meta.env?.DEV) console.log('[MyRuntimeProvider] stream: 进入 initialize 区', { initializing: initializingRef.current });
      while (initializingRef.current) {
        await new Promise((r) => setTimeout(r, 50));
      }
      initializingRef.current = true;
      if (import.meta.env?.DEV) console.log('[MyRuntimeProvider] stream: 调用 initialize()');
      const INIT_TIMEOUT_MS = 12000;
      let initResult: Awaited<ReturnType<typeof initialize>>;
      let resolvedWorkspacePath: string | undefined;
      try {
        const initPromise = Promise.all([
          initialize(),
          resolveWorkspacePath(ctx?.workspacePath),
        ]);
        const timeoutPromise = new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('INIT_TIMEOUT')), INIT_TIMEOUT_MS)
        );
        [initResult, resolvedWorkspacePath] = await Promise.race([initPromise, timeoutPromise]) as [Awaited<ReturnType<typeof initialize>>, string | undefined];
      } catch (e) {
        if (e instanceof Error && e.message === 'INIT_TIMEOUT') {
          if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] initialize 超时(12s)，使用无 externalId 继续');
          initResult = { externalId: undefined } as Awaited<ReturnType<typeof initialize>>;
          resolvedWorkspacePath = await resolveWorkspacePath(ctx?.workspacePath).catch(() => undefined);
        } else {
          throw e;
        }
      } finally {
        initializingRef.current = false;
      }
      if (import.meta.env?.DEV) console.log('[MyRuntimeProvider] initialize 完成', { hasExternalId: !!initResult?.externalId });
      let { externalId } = initResult;
      // 生产环境：组件已卸载则不再发送。开发环境：HMR 会触发短暂 unmount 导致误判，此处不中断以允许发送继续
      if (!isMountedRef.current) {
        if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] stream: 检测到组件已卸载，开发环境继续发送');
        if (!import.meta.env?.DEV) {
          isStreamingRef.current = false;
          try {
            window.dispatchEvent(new CustomEvent('task_running', { detail: { running: false } }));
          } catch { /* ignore */ }
          return;
        }
      }
      const firstContent =
        typeof lastMessage.content === "string"
          ? lastMessage.content.trim().slice(0, 40)
          : "";

      // 串行化「创建/校验线程」，避免多路并发导致挂起或重复创建（如 React 多次进入 stream 时）；整体超时防止无限挂起
      const THREAD_ENSURE_TIMEOUT_MS = 25000;
      if (import.meta.env?.DEV) console.log('[MyRuntimeProvider] stream: 线程创建/校验开始', { hasExternalId: !!externalId });
      while (threadEnsureInProgressRef.current) {
        await new Promise((r) => setTimeout(r, 50));
      }
      threadEnsureInProgressRef.current = true;
      let createdThreadInThisSend = false;
      try {
        const ensureDone = (async (): Promise<void> => {
          if (!externalId) {
            if (currentThreadIdRef.current) {
              externalId = currentThreadIdRef.current;
            } else {
              externalId = await createAndActivateThread(firstContent || undefined, resolvedWorkspacePath);
              createdThreadInThisSend = true;
            }
          }
          // 当前会话 ID 若非服务端 UUID（如 thread-1、thread-1773052129303），后端不认，必须新建服务端线程
          if (externalId && !isValidServerThreadId(externalId)) {
            if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] 当前 threadId 非服务端 UUID，新建会话', externalId.slice(0, 20));
            externalId = await createAndActivateThread(firstContent || undefined, resolvedWorkspacePath);
            createdThreadInThisSend = true;
          }
          if (externalId && !createdThreadInThisSend) {
            activateThread(externalId, externalId.slice(0, 8));
          }
          if (!createdThreadInThisSend && externalId) {
            if (import.meta.env?.DEV) console.log('[MyRuntimeProvider] getThreadState 开始', externalId?.slice(0, 8));
            try {
              await getThreadState(externalId);
              if (import.meta.env?.DEV) console.log('[MyRuntimeProvider] getThreadState 完成');
            } catch (e) {
              if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] getThreadState failed, creating new thread', e);
              externalId = await createAndActivateThread(firstContent || undefined, resolvedWorkspacePath);
              createdThreadInThisSend = true;
            }
          }
        })();
        const timeoutPromise = new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("THREAD_ENSURE_TIMEOUT")), THREAD_ENSURE_TIMEOUT_MS)
        );
        await Promise.race([ensureDone, timeoutPromise]);
      } catch (e) {
        if (e instanceof Error && e.message === "THREAD_ENSURE_TIMEOUT") {
          if (import.meta.env?.DEV) console.warn("[MyRuntimeProvider] 线程创建/校验超时", THREAD_ENSURE_TIMEOUT_MS);
          toast.error(t("errors.createSessionTimeout") || "创建会话超时", {
            description: t("errors.checkBackendAndRetry") || "请检查后端是否可用或稍后重试",
          });
          if (streamVersionRef.current === myStreamVersion) {
            isStreamingRef.current = false;
            try {
              window.dispatchEvent(new CustomEvent("task_running", { detail: { running: false } }));
            } catch { /* ignore */ }
          }
          return;
        }
        throw e;
      } finally {
        threadEnsureInProgressRef.current = false;
      }
      if (import.meta.env?.DEV) console.log('[MyRuntimeProvider] 线程就绪，准备发送', { externalId: externalId?.slice(0, 8), messagesLength: messages?.length });
      if (!externalId) {
        toast.error(t("errors.createSessionTimeout") || "创建会话失败", {
          description: t("errors.checkBackendAndRetry") || "请检查后端是否可用或稍后重试",
        });
        if (streamVersionRef.current === myStreamVersion) {
          isStreamingRef.current = false;
          try {
            window.dispatchEvent(new CustomEvent("task_running", { detail: { running: false } }));
          } catch { /* ignore */ }
        }
        return;
      }

      // ✅ 从 localStorage 读取一次，供 additional_kwargs 与 config 复用（单一数据源）
      const chatMode = resolveActiveChatMode();
      const activeRoleId = resolveActiveRoleId();
      const runtimeLocalSettings = getRuntimeLocalSettings();
      const {
        workspaceDomain,
        taskType,
        skillProfile,
        licenseTier,
        webSearchEnabled,
        researchMode,
        reviewPolicy,
        reviewTemplate,
        toolToggles,
        sessionPlugins,
      } = runtimeLocalSettings;
      // ✅ 单次读取，复用于 messageToSend 与 config（避免重复调用）
      const userContext = getUserContext();
      const systemEnv = getSystemEnvironment();
      // 每次发送前读取最新模型（避免流式期间用户切换模型后重试仍用旧值）

      // ✅ 打开文件：与后端约定一致 [{ path, total_lines?, cursor_line? }]（Claude/Cursor 顺序：open files 先于 recently）
      const normalizedOpenFiles = (openFilesRef.current || []).map((f) => ({
        path: f.path,
        ...(f.totalLines != null && { total_lines: f.totalLines }),
        ...(f.cursorLine != null && { cursor_line: f.cursorLine }),
      }));
      const editorCursorLine = (ctx as { cursorLine?: number } | undefined)?.cursorLine;
      if (ctx?.editorPath && normalizedOpenFiles.every((o) => o.path !== ctx.editorPath)) {
        normalizedOpenFiles.unshift({
          path: ctx.editorPath,
          ...(typeof editorCursorLine === "number" && { cursor_line: editorCursorLine }),
        });
      } else if (ctx?.editorPath && typeof editorCursorLine === "number") {
        const idx = normalizedOpenFiles.findIndex((o) => o.path === ctx.editorPath);
        if (idx >= 0 && (normalizedOpenFiles[idx] as { cursor_line?: number }).cursor_line == null) {
          (normalizedOpenFiles[idx] as { cursor_line?: number }).cursor_line = editorCursorLine;
        }
      }
      // ✅ 仅传有 path 或 code+content 的附件，且排除上传中/失败项，避免后端收到未就绪或错误附件
      const contextSnapshot = (contextItemsRef.current || []).slice();
      const validContextItems = contextSnapshot.filter(
        (item) => {
          if (item.status === "uploading" || item.status === "error") return false;
          return (
            (typeof item.path === "string" && item.path.length > 0) ||
            (item.type === "code" && item.content)
          );
        }
      );
      const isFastPath = taskType === "fast" || chatMode === "ask";
      const maxOpenFiles = isFastPath ? 8 : 20;
      const maxRecentFiles = isFastPath ? 12 : 30;
      const maxContextItems = isFastPath ? 8 : 20;
      // Cursor 风格：No Context by Default — 开启后不自动附带打开/最近文件，仅发送用户显式 @ 的附件
      const noContextByDefault = getStorageItem("maibot_no_context_by_default") === "true";
      const uploadOpenFiles = noContextByDefault ? [] : normalizedOpenFiles.slice(0, maxOpenFiles);
      const uploadRecentFiles = noContextByDefault ? [] : (recentlyViewedFilesRef.current || []).slice(0, maxRecentFiles);
      const uploadContextItems = validContextItems.slice(0, maxContextItems);

      // 只处理最后一条消息（新消息）；后端仅从 config.configurable 读取上下文，additional_kwargs 只保留与消息行为相关的字段
      let messageToSend = lastMessage;
      let effectiveTaskType = taskType;
      let requestMode = chatMode;
      if (lastMessage.type === 'human') {
        const existingKwargs = (lastMessage as { additional_kwargs?: Record<string, unknown> }).additional_kwargs ?? {};
        const source = ctx?.editorPath ? "editor" : "chatarea";
        const requestType = source === "editor" ? "complex_operation" : "agent_chat";
        const rawContent =
          typeof lastMessage.content === "string"
            ? lastMessage.content
            : Array.isArray(lastMessage.content)
              ? (lastMessage.content as Array<{ type?: string; text?: string }>)
                  .map((b) => b.text ?? "")
                  .join("")
              : String(lastMessage.content ?? "");
        const trimmedContent = rawContent.trim();
        const imageIntentPattern =
          /(分析这张图|分析图片|看图分析|图像分析|分析该图|analyze\s+(this\s+)?image|describe\s+(this\s+)?image)/i;
        const hasImageIntent = imageIntentPattern.test(trimmedContent);
        const latestImageContext = [...(contextItemsRef.current || [])]
          .reverse()
          .find((item) => item.type === "image" && typeof item.path === "string" && item.path.length > 0);
        const effectiveModel = (selectedModelRef.current && selectedModelRef.current !== NO_MODELS_SENTINEL) ? selectedModelRef.current : "auto";
        const currentModelId = String(effectiveModel);
        const supportsImageFlag = getStorageItem(MODEL_SUPPORTS_IMAGES_KEY);
        const supportsImages = supportsImageFlag == null ? true : supportsImageFlag === "true";
        if (hasImageIntent && latestImageContext?.path && currentModelId !== "auto" && !supportsImages) {
          toast.error(t("runtime.modelNotSupportImage"), {
            description: "请切换到支持图片的模型或使用 auto 自动选择。",
          });
          if (streamVersionRef.current === myStreamVersion) {
            isStreamingRef.current = false;
            try {
              window.dispatchEvent(new CustomEvent('task_running', { detail: { running: false } }));
            } catch { /* ignore */ }
          }
          return;
        }

        // 聊天快捷命令（前端拦截，避免新增按钮）
        let commandExpandedContent = rawContent;
        const switchModeFromSlash = (nextMode: "plan" | "ask" | "debug" | "review") => {
          const activeThreadId = externalId || currentThreadIdRef.current || getCurrentThreadIdFromStorage() || "";
          setScopedChatMode(nextMode, activeThreadId || undefined);
          requestMode = nextMode;
          const label = nextMode === "plan" ? "Plan" : nextMode === "ask" ? "Ask" : nextMode === "debug" ? "Debug" : "Review";
          toast.success(`已切换到 ${label} 模式`);
        };
        const executeBackendSlash = async (commandText: string): Promise<string | null> => {
          const slashRes = await executeSlashCommand(commandText, externalId || currentThreadIdRef.current || undefined);
          if (
            slashRes.ok &&
            slashRes.type === "switch_mode" &&
            (slashRes.mode === "plan" || slashRes.mode === "ask" || slashRes.mode === "debug" || slashRes.mode === "review")
          ) {
            switchModeFromSlash(slashRes.mode);
          }
          if (slashRes.ok && typeof slashRes.prompt === "string" && slashRes.prompt.trim()) {
            return slashRes.prompt.trim();
          }
          if (slashRes.ok && slashRes.type === "plugins_list") {
            const plugins = Array.isArray(slashRes.plugins) ? slashRes.plugins : [];
            const installed = plugins.filter((p) => p.loaded);
            const lines = installed
              .slice(0, 20)
              .map((p) => `- ${p.name}@${p.version || "unknown"}${p.source_label ? ` (${p.source_label})` : ""}`);
            toast.info(t("runtime.pluginListRead"));
            return installed.length > 0
              ? `当前已安装插件如下：\n${lines.join("\n")}\n\n请基于这些插件给我 3 个可直接执行的下一步建议。`
              : "当前尚未安装插件。请先给出推荐的基础插件清单（按优先级）以及安装理由。";
          }
          if (slashRes.ok && slashRes.type === "plugins_install") {
            const installed = Array.isArray(slashRes.installed) ? slashRes.installed : [];
            const pluginName = commandText.replace(/^\/install\s*/i, "").trim();
            if (pluginName) toast.success(`插件 ${pluginName} 安装成功`);
            return `插件 ${pluginName || "unknown"} 安装成功。当前已安装：${installed.join(", ") || "无"}。请简要介绍可直接执行的典型任务。`;
          }
          if (!slashRes.ok && slashRes.error) {
            toast.error(t("runtime.commandFailed"), { description: slashRes.error });
            return `命令执行失败：${slashRes.error}。请给出纠正后的可执行命令。`;
          }
          return null;
        };
        if (trimmedContent.startsWith("/plan")) {
          const backendPrompt = await executeBackendSlash(trimmedContent);
          if (backendPrompt) {
            commandExpandedContent = backendPrompt;
          } else {
            switchModeFromSlash("plan");
            const payload = trimmedContent.replace(/^\/plan\s*/i, "").trim();
            commandExpandedContent = payload
              ? `请在 Plan 模式下输出可执行计划：\n${payload}`
              : "请在 Plan 模式下输出可执行计划，并明确目标、约束、里程碑、风险与验收标准。";
          }
        } else if (trimmedContent.startsWith("/ask")) {
          const backendPrompt = await executeBackendSlash(trimmedContent);
          if (backendPrompt) {
            commandExpandedContent = backendPrompt;
          } else {
            switchModeFromSlash("ask");
            const payload = trimmedContent.replace(/^\/ask\s*/i, "").trim();
            commandExpandedContent = payload
              ? `请在 Ask 模式下只读分析、回答疑问并给出建议（不修改文件）：\n${payload}`
              : "请在 Ask 模式下只读分析当前上下文，回答疑问并给出建议，不修改任何文件。";
          }
        } else if (trimmedContent.startsWith("/debug")) {
          const backendPrompt = await executeBackendSlash(trimmedContent);
          if (backendPrompt) {
            commandExpandedContent = backendPrompt;
          } else {
            switchModeFromSlash("debug");
            const payload = trimmedContent.replace(/^\/debug\s*/i, "").trim();
            commandExpandedContent = payload
              ? `请在 Debug 模式下排查并定位根因：\n${payload}`
              : "请在 Debug 模式下给出：复现路径、根因、修复方案、回归验证步骤。";
          }
        } else if (trimmedContent.startsWith("/review")) {
          const backendPrompt = await executeBackendSlash(trimmedContent);
          if (backendPrompt) {
            commandExpandedContent = backendPrompt;
          } else {
            switchModeFromSlash("review");
            const payload = trimmedContent.replace(/^\/review\s*/i, "").trim();
            commandExpandedContent = payload
              ? `请在 Review 模式下执行审查并按严重级别输出问题：\n${payload}`
              : "请在 Review 模式下执行代码/方案审查，按严重级别列出问题、风险和建议。";
          }
        } else if (trimmedContent.startsWith("/")) {
          const backendPrompt = await executeBackendSlash(trimmedContent);
          if (backendPrompt) {
            commandExpandedContent = backendPrompt;
            if (trimmedContent.startsWith("/research")) {
              effectiveTaskType = "deep_research";
            }
          }
        } else if (hasImageIntent && latestImageContext?.path) {
          // 无需新按钮：自然语言“分析这张图”自动绑定最新图片附件路径
          commandExpandedContent = [
            "请分析最新上传图片，并返回结构化结论：",
            `- 图片路径：${latestImageContext.path}`,
            "- 输出字段：summary、key_objects、scene_or_chart_type、risk_or_issue、next_actions",
            "- 若无法读取图片，请明确失败原因并给出下一步建议。",
          ].join("\n");
        }
        messageToSend = {
          ...lastMessage,
          content: commandExpandedContent,
          additional_kwargs: {
            ...existingKwargs,
            source,
            request_type: requestType,
            skill_profile: skillProfile,
            license_tier: licenseTier,
            ...(activeRoleId ? { active_role_id: activeRoleId } : {}),
            ...(effectiveTaskType ? { task_type: effectiveTaskType } : {}),
            mode: requestMode,
            workspace_domain: workspaceDomain,
            system_environment: systemEnv,
            user_context: {
              user_id: userContext.userId,
              team_id: userContext.teamId,
              user_name: userContext.userName,
              team_name: userContext.teamName,
            },
          },
        };
      }

      // ✅ 构建 LangGraph Config（与 additional_kwargs 一致：open_files / context_items 已在上方统一规范化）
      // 发送时以 ref 为主、localStorage 为回退，避免 ref 被陈旧 context 覆盖后误用 auto/本地模型
      const refModel = (selectedModelRef.current && selectedModelRef.current !== NO_MODELS_SENTINEL) ? selectedModelRef.current : null;
      const storedModel = typeof window !== 'undefined' ? (getStorageItem(MODEL_STORAGE_KEY) || null) : null;
      const effectiveModel = (refModel && refModel !== NO_MODELS_SENTINEL) ? refModel : (storedModel && storedModel !== NO_MODELS_SENTINEL ? storedModel : 'auto');
      const config: Record<string, unknown> = {
        // ✅ 模型配置 - 后端同时读 model / model_id，显式选择优先于会话绑定（选哪个就走哪个）
        model: effectiveModel,
        model_id: effectiveModel,
        
        // ✅ 聊天模式（agent/ask/plan/review/debug）
        mode: requestMode,
        
        // ✅ 工作区领域（由当前能力档位与插件态决定）
        workspace_domain: workspaceDomain,
        
        // ✅ Skill Profile（full/general/office/research/...）- 后端按此加载 Skills 子集
        skill_profile: skillProfile,
        license_tier: licenseTier,
        // ✅ 云端模型确认：后端据此放行选中的云端模型（避免 license 未配置时误判为不可用）
        allow_cloud_without_confirm: typeof getStorageItem === 'function' ? getStorageItem('maibot_allow_cloud_without_confirm') === 'true' : false,
        ...(effectiveModel && String(effectiveModel).startsWith('cloud/') ? { cloud_consented: true } : {}),
        ...(activeRoleId ? { active_role_id: activeRoleId } : {}),
        
        // ✅ 任务类型（可选）- 供后端 task_context 优先选择工具与 SubAgent
        ...(effectiveTaskType ? { task_type: effectiveTaskType } : {}),
        
        // ✅ 联网搜索开关；深度研究模式（与 task_type=deep_research 区分：仅联网 vs 深研）
        web_search_enabled: webSearchEnabled,
        research_mode: researchMode,
        review_policy: reviewPolicy,
        review_template: reviewTemplate,
        tool_toggles: toolToggles,
        ...(sessionPlugins.length > 0 ? { session_plugins: sessionPlugins } : {}),
        
        // ✅ 系统环境信息（Cursor/Claude 风格 - 后端 user_info + 运行环境策略）
        os_version: systemEnv.os_version,
        shell: systemEnv.shell,
        ...(systemEnv.platform ? { platform: systemEnv.platform } : {}),
        // 运行环境描述：Electron 下为 "Electron (macOS)" 等，供 LLM 选择策略与工具
        ...(systemEnv.is_electron && systemEnv.os_version
          ? { app_runtime: `Electron (${systemEnv.os_version})` }
          : systemEnv.platform
            ? { app_runtime: systemEnv.os_version || systemEnv.platform }
            : {}),
        
        // ✅ 打开的文件和最近文件（Claude/Cursor 顺序，与 agent_prompts _format_user_context 一致）
        open_files: uploadOpenFiles,
        recently_viewed_files: uploadRecentFiles,

        // ✅ 上下文项（仅含 path 或 code+content，与 user_attachments 过滤一致）
        context_items: uploadContextItems,
        
        // Claude/Cursor 约定：linter_errors 来自编辑器诊断，edit_history 暂无数据源
        linter_errors: ctx?.linterErrors ?? [],
        edit_history: [],
        
        // 编辑器上下文（通过 config 传递；后端仅从此处读取）；No Context by Default 时不附带当前文件
        ...(!noContextByDefault && ctx?.editorPath ? { editor_path: ctx.editorPath } : {}),
        ...(!noContextByDefault && ctx?.selectedText ? { selected_text: ctx.selectedText } : {}),
        ...(!noContextByDefault && ctx?.editorContent && typeof ctx.editorContent === 'string' && ctx.editorContent.length > 0
          ? { editor_content: ctx.editorContent.length > 8000 ? ctx.editorContent.slice(0, 8000) + '\n... (truncated)' : ctx.editorContent }
          : {}),
        // 工作区根：单一真源（编辑器上下文 > localStorage > 后端 /config/list）
        ...(resolvedWorkspacePath ? { workspace_path: resolvedWorkspacePath, workspace_id: resolvedWorkspacePath } : {}),
        
        // MCP Server 配置（Cursor 风格架构）
        // 云端模式下，后端通过 MCP 协议调用本地工具
        // 本地模式下，后端直接使用 FilesystemBackend
        mcp_server_url: 'http://127.0.0.1:3000',  // 本地 MCP Server
        deployment_mode: 'local',  // 'local' | 'cloud'
        // 会话级策略（Phase 4 S-P1-1）：仅对服务端 UUID 读 scoped 存储，供后端 MAX_PARALLEL_* / 云端路由使用
        ...(externalId && isValidServerThreadId(externalId) && getStorageItem(`maibot_run_strategy_thread_${externalId}`)
          ? { run_strategy: getStorageItem(`maibot_run_strategy_thread_${externalId}`) }
          : {}),
        ...(externalId && isValidServerThreadId(externalId) && getStorageItem(`maibot_parallel_level_thread_${externalId}`)
          ? { parallel_level: getStorageItem(`maibot_parallel_level_thread_${externalId}`) }
          : {}),
        
        // 用户上下文（从 thread metadata 自动传递，这里作为备用）
        ...(userContext.userId ? { user_id: userContext.userId } : {}),
        ...(userContext.teamId ? { team_id: userContext.teamId } : {}),
        
        // 调试配置（开发环境）
        ...(import.meta.env?.DEV || import.meta.env?.MODE === 'development'
          ? {
              debug_mode: true,
              trace_id: `trace-${Date.now()}`,
            }
          : {}),
      };

      if (import.meta.env?.DEV) {
        console.log('[MyRuntimeProvider] 发送消息到 Thread:', externalId, 'model:', config.model);
        console.log('[context_verify] config 关键字段:', {
          editor_path: !!config.editor_path,
          workspace_path: !!config.workspace_path,
          open_files: (config.open_files as unknown[] | undefined)?.length ?? 0,
          editor_content_len: typeof config.editor_content === 'string' ? config.editor_content.length : 0,
        });
      }

      const isRetryableNetworkError = (e: unknown): boolean => {
        if (isUserAbort(e)) return false;
        const err = e as Error;
        const msg = (err?.message || '').toLowerCase();
        return (
          (err?.name === 'TypeError' && (msg.includes('fetch') || msg.includes('network'))) ||
          msg.includes('failed to fetch') ||
          msg.includes('network error') ||
          msg.includes('connection refused') ||
          msg.includes('econnrefused')
        );
      };

      const lastMessageContent = typeof messageToSend.content === 'string'
        ? messageToSend.content
        : Array.isArray(messageToSend.content)
          ? (messageToSend.content as Array<{ type?: string; text?: string }>).map((b) => b.text ?? '').join('')
          : String(messageToSend.content ?? '');

      // 仅在本轮新建的会话且为首条用户消息时自动生成标题（避免覆盖已有会话的用户自定义标题）
      if (createdThreadInThisSend && messages.length === 1 && lastMessageContent.trim()) {
        const autoTitle = lastMessageContent.trim().slice(0, 50).replace(/\s+/g, ' ').trim() || '新对话';
        updateThreadTitle(externalId, autoTitle)
          .then(() => {
            if (!isMountedRef.current) return;
            window.dispatchEvent(new CustomEvent(EVENTS.SESSION_CHANGED, { detail: { threadId: externalId, title: autoTitle } }));
          })
          .catch((e) => { if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] updateThreadTitle failed', e); });
      }

      let streamDone = false;
      /** 因 stream_paused 退出循环时为 true，用于后续等待 resume 并接流 */
      let pausedForResume = false;
      const MAX_PROCESSED_IDS = 500;
      const processedMessageIds = new Set<string>();
      const partialMessageProgress = new Map<string, { fp: string; score: number }>();
      const getMessageProgressFingerprint = (msg: {
        id?: string;
        type?: string;
        content?: unknown;
        tool_calls?: Array<unknown>;
        tool_call_chunks?: Array<unknown>;
      }): string => {
        const msgType = String(msg?.type || "");
        const tcLen = Array.isArray(msg?.tool_calls) ? msg.tool_calls.length : 0;
        const tccLen = Array.isArray(msg?.tool_call_chunks) ? msg.tool_call_chunks.length : 0;
        let contentLen = 0;
        const raw = msg?.content;
        if (typeof raw === "string") {
          contentLen = raw.length;
        } else if (Array.isArray(raw)) {
          for (const x of raw) {
            if (typeof x === "string") {
              contentLen += x.length;
            } else if (x && typeof x === "object" && "text" in (x as Record<string, unknown>)) {
              contentLen += String((x as Record<string, unknown>).text ?? "").length;
            }
          }
        } else if (raw != null) {
          contentLen = String(raw).length;
        }
        return `${msgType}|${contentLen}|${tcLen}|${tccLen}`;
      };
      const getMessageProgressScore = (msg: {
        content?: unknown;
        tool_calls?: Array<unknown>;
        tool_call_chunks?: Array<unknown>;
      }): number => {
        let contentLen = 0;
        const raw = msg?.content;
        if (typeof raw === "string") {
          contentLen = raw.length;
        } else if (Array.isArray(raw)) {
          for (const x of raw) {
            if (typeof x === "string") {
              contentLen += x.length;
            } else if (x && typeof x === "object" && "text" in (x as Record<string, unknown>)) {
              contentLen += String((x as Record<string, unknown>).text ?? "").length;
            }
          }
        } else if (raw != null) {
          contentLen = String(raw).length;
        }
        const tcLen = Array.isArray(msg?.tool_calls) ? msg.tool_calls.length : 0;
        const tccLen = Array.isArray(msg?.tool_call_chunks) ? msg.tool_call_chunks.length : 0;
        // run 级单调分数：优先内容长度，其次工具调用增量，减少双通道重复/回退包抖动。
        return (contentLen * 100) + (tcLen * 10) + tccLen;
      };

      const isCloudModelId = (modelId: string): boolean => {
        const id = (modelId || "").toLowerCase();
        if (!id || id === "auto") return false;
        return id.includes("cloud") || id.includes("72b") || id.includes("api/");
      };

      const ensureCloudModelConsent = async (modelId: string): Promise<boolean> => {
        if (!isCloudModelId(modelId)) return true;
        if (getStorageItem("maibot_allow_cloud_without_confirm") === "true") return true;
        const key = "maibot_cloud_model_consented";
        const legacyKey = "maibot_cloud_model_consent_v1";
        const raw = getStorageItem(key);
        let accepted: string[] = [];
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            accepted = Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
          } catch {
            accepted = [];
          }
        }
        if (accepted.length === 0 && getStorageItem(legacyKey) === "true") {
          accepted = [modelId];
          removeStorageItem(legacyKey);
          setStorageItem(key, JSON.stringify(accepted));
        }
        if (accepted.includes(modelId)) return true;
        const previewPayload = {
          model: modelId,
          mode: config.mode,
          workspace_path: config.workspace_path || "",
          user_prompt_preview: (lastMessageContent || "").slice(0, 300),
          context_items_count: Array.isArray(config.context_items) ? config.context_items.length : 0,
          context_item_paths: Array.isArray(config.context_items)
            ? config.context_items
                .map((it: any) => String(it?.path || "").trim())
                .filter(Boolean)
                .slice(0, 8)
            : [],
          open_files_count: Array.isArray(config.open_files) ? config.open_files.length : 0,
          tool_toggles: config.tool_toggles || {},
        };
        const previewText = JSON.stringify(previewPayload, null, 2);
        const CONFIRM_TIMEOUT_MS = 30_000;
        let confirmTimeoutId: ReturnType<typeof setTimeout> | null = null;
        const ok = await Promise.race([
          new Promise<boolean>((resolve) => {
            window.dispatchEvent(
              new CustomEvent(EVENTS.CONFIRM_CLOUD_MODEL, {
                detail: { modelId, previewText: previewText.slice(0, 900), resolve, threadId: externalId ?? undefined },
              })
            );
          }),
          new Promise<boolean>((_, reject) => {
            confirmTimeoutId = setTimeout(
              () => reject(new Error('云端模型确认超时，请稍后重试')),
              CONFIRM_TIMEOUT_MS
            );
          }),
        ]).catch((err) => {
          toast.error(t('runtime.cloudConfirmTimeout'), { description: err?.message });
          return false;
        }).finally(() => {
          if (confirmTimeoutId != null) {
            clearTimeout(confirmTimeoutId);
            confirmTimeoutId = null;
          }
        });
        if (!ok) return false;
        accepted.push(modelId);
        setStorageItem(key, JSON.stringify(Array.from(new Set(accepted))));
        return true;
      };
      /** 用于 finally 中 runStreamCleanup 区分正常结束(complete)/取消(abort)/异常(error)，以便本轮完成提示仅正常结束时展示 */
      let streamExitReason: 'complete' | 'abort' | 'error' | undefined;
      try {
      let attempt = 0;
      let threadRebuildCount = 0;
      /** 线程未找到时最多重建次数；超过后 toast 并抛错 */
      const MAX_THREAD_REBUILDS = 3;
      let metricsBatchTimer: ReturnType<typeof setTimeout> | null = null;
      let fileEventDetectTimer: ReturnType<typeof setTimeout> | null = null;
      /** 本轮流内云端确认只做一次，重试时不再弹窗，避免 HMR/重试时误判为「用户取消」 */
      let cloudConsentGrantedForThisStream = false;
      /** attempt 0,1,2 => 共 3 次发送尝试；finally 中 attempt++，第三次失败后退出循环 */
      while (!streamDone && attempt <= 2) {
        if (attempt > 0) {
          toast.info(t('runtime.reconnecting'));
          await new Promise((r) => setTimeout(r, attempt === 1 ? 300 : 800));
        }
        // ✅ 每次尝试前读取最新模型（ref + localStorage 回退），避免重试时仍用旧值或误用 auto
        const refModelLoop = (selectedModelRef.current && selectedModelRef.current !== NO_MODELS_SENTINEL) ? selectedModelRef.current : null;
        const storedModelLoop = typeof window !== 'undefined' ? (getStorageItem(MODEL_STORAGE_KEY) || null) : null;
        const effectiveModel = (refModelLoop && refModelLoop !== NO_MODELS_SENTINEL) ? refModelLoop : (storedModelLoop && storedModelLoop !== NO_MODELS_SENTINEL ? storedModelLoop : 'auto');
        config.model = effectiveModel;
        if (!cloudConsentGrantedForThisStream && !(await ensureCloudModelConsent(String(effectiveModel)))) {
          throw new Error("用户取消云端模型调用");
        }
        cloudConsentGrantedForThisStream = true;
        // ✅ 为本轮流创建 AbortController，停止时 abort 可立即中断 fetch
        const streamController = new AbortController();
        streamAbortControllerRef.current = streamController;
        currentRunIdRef.current = null;
        if (import.meta.env?.DEV) console.log('[MyRuntimeProvider] 创建 generator 开始流式请求', { threadId: externalId?.slice(0, 8), model: config.model, attempt });
        const msgContent = messageToSend.content;
        if (typeof msgContent === "string" && msgContent.length > MAX_MESSAGE_CONTENT_LENGTH) {
          if (import.meta.env?.DEV) console.warn("[MyRuntimeProvider] 消息内容超长已截断", msgContent.length, MAX_MESSAGE_CONTENT_LENGTH);
          messageToSend = { ...messageToSend, content: msgContent.slice(0, MAX_MESSAGE_CONTENT_LENGTH) };
        }
        const generator = sendMessageWithRetry({
          threadId: externalId,
          messages: [messageToSend],
          config: Object.keys(config).length > 0 ? config : undefined,
          onRunCreated: (meta) => {
            currentRunIdRef.current = meta.run_id;
            sessionContextAppliedForRunRef.current = false;
            const tid = externalId ?? currentThreadIdRef.current ?? getCurrentThreadIdFromStorage() ?? "";
            toolStreamEventBus.handleStreamEvent({ type: 'run_id', run_id: meta.run_id, threadId: tid || undefined });
          },
          signal: streamController.signal,
        }, {
          maxRetries: 1,
          retryDelay: 800,
          onRetry: () => {
            toast.info(t('runtime.retryingStream'));
          },
        });

        // ============================================================
        // 流式事件处理 - Cursor/Claude 风格简化版
      // 
      // 设计原则：
      // 1. 只 yield 主图消息给 assistant-ui（用于聊天显示）
      // 2. 子图消息不 yield（避免重复显示）
      // 3. 文件事件只触发文件树刷新（不在聊天中显示）
      // 4. 不使用复杂的执行状态栏（Cursor 也没有）
      // ============================================================
      let seenValidPayload = false;
      const LONG_WAIT_MS = 95000;
      let longWaitToastShown = false;
      const longWaitTimer = setTimeout(() => {
        if (!seenValidPayload && !longWaitToastShown) {
          longWaitToastShown = true;
          toast.warning(t('runtime.responseWaitLong'), {
            description: t('runtime.responseWaitLongDesc'),
          });
        }
      }, LONG_WAIT_MS);
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        const streamStartedAt = Date.now();
        const metricsDebugEnabled = _isUiMetricsDebugEnabled();
        let firstPayloadReceivedAt = 0;
        let firstUiYieldAt = 0;
        let lastPayloadReceivedAt = 0;
        let maxInterPayloadGapMs = 0;
        const CONTEXT_STATS_MIN_INTERVAL_MS = 150;
        const REASONING_EMIT_WARMUP_MS = 1000;
        const REASONING_EMIT_WARMUP_INTERVAL_MS = 28;
        const REASONING_EMIT_MIN_INTERVAL_MS = 90;
        const TASK_PROGRESS_EMIT_MIN_INTERVAL_MS = 100;
        const AGENT_PROGRESS_DEDUP_WINDOW_MS = 300;
        const METRICS_DEDUP_WINDOW_MS = 500;
        const METRICS_EVENT_BATCH_WINDOW_MS = 120;
        let lastContextStatsEmitAt = 0;
        let pendingContextStats: unknown = null;
        let lastContextStatsFingerprint = '';
        let lastReasoningEmitAt = 0;
        let reasoningFirstChunkSeen = false;
        const pendingReasoningByMsgId = new Map<string, string>();
        const lastReasoningChunkByMsgId = new Map<string, { content: string; ts: number }>();
        let lastTaskProgressEmitAt = 0;
        let lastTaskProgressFingerprint = '';
        let lastAgentProgressFingerprint = '';
        let lastAgentProgressEmitAt = 0;
        let lastExecutionMetricsFingerprint = '';
        let lastExecutionMetricsEmitAt = 0;
        let pendingTaskProgressEvent: ToolStreamEvent | null = null;
        // 单主通道：custom 优先（推理流 content_parts 仅 custom 下发）；main 仅在没有 custom 且连续 2+ partial 时锁定
        let primaryMessageChannel: "auto" | "custom" | "messages" = "auto";
        let hasSeenCustomPartialInRun = false;
        let mainPartialCount = 0;
        let firstMainPartialLogged = false;
        let seenYieldFromMessagesChannel = false;
        let lastCustomMessageAt = 0;
        let partialSuppressedCount = 0;
        // 优先消费 runtime_stats；若同一轮已收到 runtime_stats，后续独立 context/execution 事件视为冗余。
        let runtimeStatsPreferred = false;
        let pendingMetricsEvents: Array<{ type: 'context_stats' | 'execution_metrics' | 'ui_stream_metrics'; detail: unknown }> = [];
        const markPayloadReceived = () => {
          const now = Date.now();
          if (firstPayloadReceivedAt === 0) firstPayloadReceivedAt = now;
          if (lastPayloadReceivedAt > 0) {
            const gap = Math.max(0, now - lastPayloadReceivedAt);
            if (gap > maxInterPayloadGapMs) maxInterPayloadGapMs = gap;
          }
          lastPayloadReceivedAt = now;
        };
        const markUiYield = () => {
          if (firstUiYieldAt === 0) firstUiYieldAt = Date.now();
        };
        const metricsFingerprint = (detail: unknown): string => {
          if (detail == null) return '';
          if (typeof detail !== 'object') return String(detail);
          try {
            const d = detail as Record<string, unknown>;
            return [
              String(d.request_id ?? ''),
              String(d.session_id ?? ''),
              String(d.model_id ?? ''),
              String(d.task_type ?? ''),
              String(d.total_ms ?? ''),
              String(d.ttft_ms ?? ''),
              String(d.stream_to_first_token_ms ?? ''),
              String(d.retry_count ?? ''),
            ].join('|');
          } catch {
            return '';
          }
        };
        const flushMetricsEvents = (force = false) => {
          if (!metricsDebugEnabled) return;
          if (!force && pendingMetricsEvents.length === 0) return;
          if (metricsBatchTimer) {
            clearTimeout(metricsBatchTimer);
            metricsBatchTimer = null;
          }
          if (pendingMetricsEvents.length === 0) return;
          const batch = pendingMetricsEvents;
          pendingMetricsEvents = [];
          for (const evt of batch) {
            window.dispatchEvent(new CustomEvent(evt.type, { detail: evt.detail }));
          }
        };
        const enqueueMetricsEvent = (
          type: 'context_stats' | 'execution_metrics' | 'ui_stream_metrics',
          detail: unknown,
          force = false
        ) => {
          if (!metricsDebugEnabled) return;
          if (force) {
            flushMetricsEvents(true);
            window.dispatchEvent(new CustomEvent(type, { detail }));
            return;
          }
          pendingMetricsEvents.push({ type, detail });
          if (!metricsBatchTimer) {
            metricsBatchTimer = setTimeout(() => {
              metricsBatchTimer = null;
              flushMetricsEvents(true);
            }, METRICS_EVENT_BATCH_WINDOW_MS);
          }
        };
        const emitContextStats = (detail: unknown, force = false) => {
          if (!metricsDebugEnabled) return;
          const fp = metricsFingerprint(detail);
          if (fp && fp === lastContextStatsFingerprint) {
            return;
          }
          pendingContextStats = detail;
          const now = Date.now();
          if (force || (now - lastContextStatsEmitAt) >= CONTEXT_STATS_MIN_INTERVAL_MS) {
            lastContextStatsEmitAt = now;
            const payload = pendingContextStats;
            pendingContextStats = null;
            if (fp) lastContextStatsFingerprint = fp;
            enqueueMetricsEvent('context_stats', payload, force);
          }
        };
        const emitExecutionMetrics = (detail: unknown) => {
          if (!metricsDebugEnabled) return;
          const now = Date.now();
          const fp = metricsFingerprint(detail);
          if (
            fp &&
            fp === lastExecutionMetricsFingerprint &&
            (now - lastExecutionMetricsEmitAt) < METRICS_DEDUP_WINDOW_MS
          ) {
            return;
          }
          if (fp) lastExecutionMetricsFingerprint = fp;
          lastExecutionMetricsEmitAt = now;
          const baseDetail =
            detail && typeof detail === 'object'
              ? { ...(detail as Record<string, unknown>) }
              : { raw: detail };
          const mergedDetail = {
            ...baseDetail,
            frontend_first_payload_ms:
              firstPayloadReceivedAt > 0 ? Math.max(0, firstPayloadReceivedAt - streamStartedAt) : undefined,
            frontend_first_ui_yield_ms:
              firstUiYieldAt > 0 ? Math.max(0, firstUiYieldAt - streamStartedAt) : undefined,
            frontend_max_inter_payload_gap_ms: maxInterPayloadGapMs,
            partial_suppressed_count: partialSuppressedCount,
          };
          enqueueMetricsEvent('execution_metrics', mergedDetail);
          // 统一对外发一个轻量 UI 侧流式指标事件，便于与 LM Studio 原生对照采样。
          enqueueMetricsEvent('ui_stream_metrics', {
              request_id: (mergedDetail as Record<string, unknown>).request_id,
              model_id: (mergedDetail as Record<string, unknown>).model_id,
              ttft_ms: (mergedDetail as Record<string, unknown>).ttft_ms,
              stream_to_first_token_ms: (mergedDetail as Record<string, unknown>).stream_to_first_token_ms,
              lmstudio_gap_overhead_ms: (mergedDetail as Record<string, unknown>).lmstudio_gap_overhead_ms,
              max_inter_token_gap_ms:
                (mergedDetail as Record<string, unknown>).max_inter_token_gap_ms
                ?? (mergedDetail as Record<string, unknown>).frontend_max_inter_payload_gap_ms,
              stream_tokens_per_second_peak: (mergedDetail as Record<string, unknown>).stream_tokens_per_second_peak,
              frontend_first_payload_ms: (mergedDetail as Record<string, unknown>).frontend_first_payload_ms,
              frontend_first_ui_yield_ms: (mergedDetail as Record<string, unknown>).frontend_first_ui_yield_ms,
              frontend_max_inter_payload_gap_ms: (mergedDetail as Record<string, unknown>).frontend_max_inter_payload_gap_ms,
              partial_suppressed_count: (mergedDetail as Record<string, unknown>).partial_suppressed_count,
              total_ms: (mergedDetail as Record<string, unknown>).total_ms,
              adaptive_hotpath_active: (mergedDetail as Record<string, unknown>).adaptive_hotpath_active,
              adaptive_hotpath_reason: (mergedDetail as Record<string, unknown>).adaptive_hotpath_reason,
            });
          _recordUiMetricsAndEmitSummary({
            request_id: (mergedDetail as Record<string, unknown>).request_id,
            model_id: (mergedDetail as Record<string, unknown>).model_id,
            ttft_ms: (mergedDetail as Record<string, unknown>).ttft_ms,
            stream_to_first_token_ms: (mergedDetail as Record<string, unknown>).stream_to_first_token_ms,
            lmstudio_gap_overhead_ms: (mergedDetail as Record<string, unknown>).lmstudio_gap_overhead_ms,
            max_inter_token_gap_ms:
              (mergedDetail as Record<string, unknown>).max_inter_token_gap_ms
              ?? (mergedDetail as Record<string, unknown>).frontend_max_inter_payload_gap_ms,
            stream_tokens_per_second_peak: (mergedDetail as Record<string, unknown>).stream_tokens_per_second_peak,
            frontend_first_payload_ms: (mergedDetail as Record<string, unknown>).frontend_first_payload_ms,
            frontend_first_ui_yield_ms: (mergedDetail as Record<string, unknown>).frontend_first_ui_yield_ms,
            frontend_max_inter_payload_gap_ms: (mergedDetail as Record<string, unknown>).frontend_max_inter_payload_gap_ms,
            partial_suppressed_count: (mergedDetail as Record<string, unknown>).partial_suppressed_count,
            total_ms: (mergedDetail as Record<string, unknown>).total_ms,
            adaptive_hotpath_active: (mergedDetail as Record<string, unknown>).adaptive_hotpath_active,
            adaptive_hotpath_reason: (mergedDetail as Record<string, unknown>).adaptive_hotpath_reason,
            ts: Date.now(),
          }, uiMetricsStateRef.current);
        };
        const flushReasoningContent = (force = false) => {
          if (pendingReasoningByMsgId.size === 0) return;
          const now = Date.now();
          const elapsed = now - streamStartedAt;
          const minInterval = elapsed < REASONING_EMIT_WARMUP_MS
            ? REASONING_EMIT_WARMUP_INTERVAL_MS
            : REASONING_EMIT_MIN_INTERVAL_MS;
          if (!force && (now - lastReasoningEmitAt) < minInterval) {
            return;
          }
          lastReasoningEmitAt = now;
          for (const [msgId, content] of pendingReasoningByMsgId) {
            if (!content) continue;
            toolStreamEventBus.handleStreamEvent({
              type: 'reasoning',
              phase: 'content',
              msg_id: msgId,
              content,
              timestamp: Date.now(),
            } as ToolStreamEvent);
          }
          pendingReasoningByMsgId.clear();
        };
        const enqueueReasoningChunk = (msgId: string, content: string) => {
          if (!content) return;
          // 兼容后端双协议并发发包时，避免相同 chunk 被重复拼接。
          const now = Date.now();
          const prev = lastReasoningChunkByMsgId.get(msgId);
          if (prev && prev.content === content && (now - prev.ts) < 220) return;
          lastReasoningChunkByMsgId.set(msgId, { content, ts: now });
          pendingReasoningByMsgId.set(msgId, (pendingReasoningByMsgId.get(msgId) || '') + content);
          // 与 reasoning 分支 clear 使用同一 threadId 解析顺序，保证 append/clear 键一致
          const tid = externalId ?? currentThreadIdRef.current ?? getCurrentThreadIdFromStorage() ?? lastSessionContextThreadId ?? "";
          if (tid) appendCurrentRunReasoning(tid, content);
          if (!reasoningFirstChunkSeen) {
            reasoningFirstChunkSeen = true;
            flushReasoningContent(true);
          } else {
            flushReasoningContent(false);
          }
        };
        const flushTaskProgress = (force = false) => {
          if (!pendingTaskProgressEvent) return;
          const now = Date.now();
          if (!force && (now - lastTaskProgressEmitAt) < TASK_PROGRESS_EMIT_MIN_INTERVAL_MS) {
            return;
          }
          const p = pendingTaskProgressEvent as { type?: string; message?: string; phase?: string; step?: string; todos?: Array<{ id?: string; status?: string }> };
          const baseFp = `${String(p.type || '')}|${String(p.message || '')}|${String(p.phase || '')}|${String(p.step || '')}`;
          const taskProgressFp = Array.isArray(p.todos) && p.todos.length > 0
            ? `${baseFp}|todos:${p.todos.length}:${p.todos.map((t) => `${String(t?.id ?? '')}:${String(t?.status ?? '')}`).join(',')}`
            : baseFp;
          if (taskProgressFp === lastTaskProgressFingerprint) {
            pendingTaskProgressEvent = null;
            return;
          }
          lastTaskProgressEmitAt = now;
          lastTaskProgressFingerprint = taskProgressFp;
          emitStreamEvent(pendingTaskProgressEvent as unknown as Record<string, unknown>);
          try {
            const threadId = streamThreadId || (currentThreadIdRef.current ?? getCurrentThreadIdFromStorage() ?? "");
            window.dispatchEvent(new CustomEvent(EVENTS.TASK_PROGRESS, { detail: { ...pendingTaskProgressEvent, threadId } }));
          } catch (e) {
            if (import.meta.env?.DEV) console.warn("[MyRuntimeProvider] TASK_PROGRESS dispatch:", e);
          }
          pendingTaskProgressEvent = null;
        };
        const shouldSkipAgentProgress = (payload: ToolStreamEvent): boolean => {
          const now = Date.now();
          const fp = `${String((payload as { type?: string }).type || '')}|${String((payload as { status?: string }).status || '')}|${String((payload as { phase?: string }).phase || '')}|${String((payload as { subagent_type?: string }).subagent_type || '')}|${String((payload as { message?: string }).message || '')}`;
          if (fp === lastAgentProgressFingerprint && (now - lastAgentProgressEmitAt) < AGENT_PROGRESS_DEDUP_WINDOW_MS) {
            return true;
          }
          lastAgentProgressFingerprint = fp;
          lastAgentProgressEmitAt = now;
          return false;
        };
        // 进入流循环即视为运行中，便于 UI 立即显示「停止」且便于打点；带 threadId 供 Thread 按会话过滤 runSummary（Cursor 一致：仅当前会话显示 run 状态）
        const streamLoopStartedAt = Date.now();
        const streamThreadId = externalId ?? currentThreadIdRef.current ?? getCurrentThreadIdFromStorage() ?? "";
        /** 本 run 有效 threadId：收到 session_context 时更新，供 task_progress/tool_result 优先使用，避免步骤落在空 thread */
        const runThreadIdRef = { current: streamThreadId };
        /** partial 时把 type=ai 转为 AIMessageChunk+delta，供 SDK append 而非 replace，避免碎片式显示 */
        const streamAiAccumulatedById = new Map<string, string>();
        /** 本 run 内按 AI 序号（0,1,2…）缓存已分配的稳定 id，非最后一条 AI 跨批复用，避免重复气泡 */
        const streamAiStableIdByIndex = new Map<number, string>();
        /** 仅用于「本批最后一条」AI 的稳定 id；同一 run 内若本批有多条 AI 则重置，使本批最后一条得到新 id，避免多条 AI 共用一个 id 导致断行/覆盖 */
        let streamStableAiMessageIdFallback: string | null = null;
        const getOrCreateStableAiId = (hintId: string): string => {
          if (streamStableAiMessageIdFallback) return streamStableAiMessageIdFallback;
          const trimmed = String(hintId ?? "").trim();
          if (trimmed) {
            streamStableAiMessageIdFallback = trimmed;
            return trimmed;
          }
          streamStableAiMessageIdFallback = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `ai-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          return streamStableAiMessageIdFallback;
        };
        const getStableIdForIndex = (aiIndex: number): string | undefined => streamAiStableIdByIndex.get(aiIndex);
        const setStableIdForIndex = (aiIndex: number, id: string): void => { streamAiStableIdByIndex.set(aiIndex, id); };
        toolStreamEventBus.handleStreamEvent({ type: "stream_start", threadId: streamThreadId || undefined });
        const emitStreamEvent = (p: Record<string, unknown>) => {
          toolStreamEventBus.handleStreamEvent({ ...p, threadId: streamThreadId || undefined } as ToolStreamEvent);
        };
        // 与 stream_start 同源：本 run 所属会话，避免 ref 未及时更新时清错会话的 steps
        if (streamThreadId) {
          clearStepsForThread(streamThreadId);
          emitStepsUpdated(streamThreadId, []);
          // 不在流开始时清空思考区，保留上轮内容长期显示；仅在本轮收到 reasoning phase=start 时再清空
        }
        if (import.meta.env?.DEV) {
          console.log('[MyRuntimeProvider] 流循环已进入，等待首包 (T0)', streamLoopStartedAt);
        }
        let firstEventAt = 0;
        let firstMessagesPartialLogged = false;
        let firstReasoningContentLogged = false;
        /** 本 run 是否已收到过 reasoning phase=content；仅首次 phase=start 时清空思考区，避免重复/滞后 phase=start 清空已显示内容（如子图或重试导致） */
        let reasoningContentReceivedThisRun = false;
        /** DEV：messages_partial 日志节流，避免控制台刷屏 */
        let messagesPartialLogCount = 0;
        /** 最近一次 session_context 的 threadId，供 reasoning 早于 ref 时兜底 */
        let lastSessionContextThreadId = "";
        const STREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
        const idleFired = { current: false };
        const scheduleIdleCheck = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            idleFired.current = true;
          }, STREAM_IDLE_TIMEOUT_MS);
        };
        scheduleIdleCheck();
        EVENT_LOOP: for await (const event of generator) {
          if (idleFired.current) {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = null;
            if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] 流空闲超时，结束消费');
            toast.warning(t('runtime.responseTimeout'), { description: t('runtime.responseTimeoutDesc') });
            streamDone = true;
            break EVENT_LOOP;
          }
          if (streamToken !== activeStreamTokenRef.current) {
            if (metricsBatchTimer) {
              clearTimeout(metricsBatchTimer);
              metricsBatchTimer = null;
            }
            if (fileEventDetectTimer) {
              clearTimeout(fileEventDetectTimer);
              fileEventDetectTimer = null;
            }
            pendingTaskProgressEvent = null;
            pendingReasoningByMsgId.clear();
            seenValidPayload = true;
            break EVENT_LOOP;
          }
          // 跳过空事件（心跳）
          if (!event.event || (typeof event.event === 'string' && event.event.trim() === '')) {
            continue;
          }
          scheduleIdleCheck();
          if (firstEventAt === 0) {
            firstEventAt = Date.now();
            if (import.meta.env?.DEV) {
              console.log('[MyRuntimeProvider] 首包到达 +' + (firstEventAt - streamLoopStartedAt) + 'ms', event.event);
            }
          }

          // 调试：仅打印有效载荷事件，避免 "no data" 噪音刷屏
          if (import.meta.env?.DEV) {
            const hasData = event.data !== undefined && event.data !== null && (!Array.isArray(event.data) || event.data.length > 0);
            if (hasData) {
              markPayloadReceived();
              console.log(
                '[MyRuntimeProvider] 📨 收到事件:',
                event.event,
                Array.isArray(event.data) ? `[${event.data.length} items]` : typeof event.data
              );
            }
          }

          // 处理 metadata 事件 - 提取上下文统计，并转为 "metadata" 让 @assistant-ui/react-langgraph 识别（避免控制台 Unhandled event received）
          if (event.event === 'messages/metadata' || event.event === 'metadata') {
            if (event.data?.context_stats) {
              markPayloadReceived();
              emitContextStats(event.data.context_stats);
            }
            markUiYield();
            yield { ...event, event: 'metadata' as const, data: event.data };
            continue;
          }
          
          // 处理上下文统计事件（后端通过 custom 事件发送）
          if (event.event === 'context_stats') {
            if (runtimeStatsPreferred) continue;
            if (event.data != null) emitContextStats(event.data);
            continue;
          }
          if (event.event === 'execution_metrics') {
            if (runtimeStatsPreferred) continue;
            if (event.data != null) emitExecutionMetrics(event.data);
            continue;
          }
          if (event.event === 'runtime_stats') {
            runtimeStatsPreferred = true;
            const stats = (event.data || {}) as { context_stats?: unknown; execution_metrics?: unknown };
            if (stats.context_stats) emitContextStats(stats.context_stats);
            if (stats.execution_metrics) emitExecutionMetrics(stats.execution_metrics);
            continue;
          }
          
          // custom：后端 get_stream_writer() 发送的 token 流（messages_partial）与进度事件；支持 event.data 为单对象或数组（LangGraph 可能批量为数组）
          if (event.event === 'custom' || (typeof event.event === 'string' && event.event.startsWith('custom|'))) {
            try {
              const rawCustom = event.data;
              const customItems = Array.isArray(rawCustom)
                ? rawCustom
                : rawCustom != null && typeof rawCustom === 'object' && !Array.isArray(rawCustom)
                  ? [rawCustom]
                  : [];
              for (const d of customItems) {
                if (!d || typeof d !== 'object') continue;
              const dType = String((d as { type?: string }).type || '');
              // 诊断：DEV 下打印 custom 事件类型（messages_partial 由下方专用 log 节流输出，此处跳过避免重复刷屏）
              if (import.meta.env?.DEV && dType && dType !== 'messages_partial') {
                console.log('[MyRuntimeProvider] custom event type:', dType);
              }
              // P1：DEV 下打一次子图 custom 的 event.data 顶层结构，便于确认与根 custom 一致
              if (import.meta.env?.DEV && typeof event.event === 'string' && event.event.startsWith('custom|') && d != null) {
                const dataKeys = typeof d === 'object' && d !== null ? Object.keys(d) : [];
                const dataPreview = Array.isArray((d as { data?: unknown }).data)
                  ? `data[${(d as { data: unknown[] }).data.length}]`
                  : typeof (d as { data?: unknown }).data;
                console.log('[MyRuntimeProvider] 子图 custom event.data 结构:', event.event, { type: dType, keys: dataKeys, data: dataPreview });
              }
              if (d?.type === 'session_context') {
                const parsed = parseSessionContextPayload(d);
                const tid = parsed?.threadId;
                if (typeof tid === 'string' && tid && isValidServerThreadId(tid)) {
                  lastSessionContextThreadId = tid;
                  runThreadIdRef.current = tid;
                  const threadId = tid;
                  const isCurrentSession = currentThreadIdRef.current === threadId;
                  const notYetApplied = !sessionContextAppliedForRunRef.current;
                  if (isCurrentSession && notYetApplied) {
                    sessionContextAppliedForRunRef.current = true;
                    const mode = (parsed?.mode != null && String(parsed.mode).trim()) ? String(parsed.mode).trim() : 'agent';
                    const roleId = parsed?.roleId != null ? String(parsed.roleId).trim() : '';
                    setScopedChatMode(mode, threadId);
                    setScopedActiveRoleIdInStorage(roleId || '', threadId);
                    window.dispatchEvent(new CustomEvent(EVENTS.CHAT_MODE_CHANGED, { detail: { mode, threadId } }));
                    window.dispatchEvent(new CustomEvent(EVENTS.ROLE_CHANGED, { detail: { roleId: roleId || undefined, threadId } }));
                    if (parsed?.modelId != null && String(parsed.modelId).trim()) {
                      window.dispatchEvent(new CustomEvent(EVENTS.RUN_MODEL_RESOLVED, { detail: { threadId, modelId: String(parsed.modelId).trim() } }));
                    }
                  }
                } else if (import.meta.env?.DEV && d?.type === 'session_context') {
                  if (typeof tid === 'string' && tid) {
                    console.warn('[MyRuntimeProvider] session_context threadId 非服务端 UUID，忽略', tid.slice(0, 20));
                  } else {
                    console.warn('[MyRuntimeProvider] session_context payload missing or invalid threadId', d);
                  }
                }
                continue;
              }
              if (
                !metricsDebugEnabled &&
                (dType === 'context_stats' || dType === 'execution_metrics' || dType === 'runtime_stats')
              ) {
                continue;
              }
              if (d?.type === 'messages_partial' && Array.isArray(d.data) && d.data.length > 0) {
                hasSeenCustomPartialInRun = true;
                type StreamMsg = { type?: string; tool_calls?: unknown[]; tool_call_chunks?: unknown[]; content_parts?: unknown };
                const raw = d.data as StreamMsg[];
                let hasValid = false;
                let hasToolCalls = false;
                let hasToolOrToolMessage = false;
                let hasContentParts = false;
                for (const m of raw) {
                  const msgType = String(m?.type || '');
                  const hasTc = Array.isArray(m?.tool_calls) && m.tool_calls.length > 0;
                  const hasTcc = Array.isArray(m?.tool_call_chunks) && m.tool_call_chunks.length > 0;
                  const cp = (m as { content_parts?: unknown }).content_parts;
                  if (Array.isArray(cp) && cp.length > 0) hasContentParts = true;
                  if (msgType === 'tool' || msgType === 'ToolMessage') hasToolOrToolMessage = true;
                  if (
                    msgType === 'ai' ||
                    msgType === 'AIMessage' ||
                    msgType === 'AIMessageChunk' ||
                    msgType === 'tool' ||
                    msgType === 'ToolMessage' ||
                    hasTc ||
                    hasTcc
                  ) {
                    hasValid = true;
                  }
                  if (hasTc || hasTcc) hasToolCalls = true;
                }
                // 单源：主通道已定为 messages 时不再 yield root custom partial，与「主通道为 custom 时跳过 main partial」对称，避免双写
                const wouldSkipRootCustom = primaryMessageChannel === "messages" && !(typeof event.event === "string" && event.event.startsWith("custom|"));
                if (wouldSkipRootCustom) continue;
                if (import.meta.env?.DEV) {
                  messagesPartialLogCount += 1;
                  if (messagesPartialLogCount <= 2 || messagesPartialLogCount % 50 === 0) {
                    console.log('[MyRuntimeProvider] 收到 custom messages_partial', messagesPartialLogCount <= 2 ? `data.length=${d.data.length}` : `#${messagesPartialLogCount} data.length=${d.data.length}`);
                  }
                }
                markPayloadReceived();
                lastCustomMessageAt = Date.now();
                type ToolCallMsg = { type?: string; tool_calls?: Array<{ id?: string; name?: string | null; [k: string]: unknown }>; tool_call_chunks?: Array<{ id?: string; name?: string | null; [k: string]: unknown }> };
                const normalized = hasToolCalls ? normalizeToolCallsInMessages(raw as ToolCallMsg[]) : raw;
                const filteredNormalized = (normalized as Array<{ type?: string }>).filter(
                  msg => isAllowedMessageType(msg?.type)
                );
                if (filteredNormalized.length === 0) continue;
                if (hasValid) {
                  seenValidPayload = true;
                  primaryMessageChannel = "custom";
                }
                markUiYield();
                if (import.meta.env?.DEV && !firstMessagesPartialLogged) {
                  firstMessagesPartialLogged = true;
                  const firstPartialMs = Date.now() - streamLoopStartedAt;
                  const firstMsgContent = (filteredNormalized as Array<{ content?: unknown }>)[0]?.content;
                  const firstContentLen = firstMsgContent == null ? 0 : typeof firstMsgContent === 'string' ? firstMsgContent.length : Array.isArray(firstMsgContent) ? firstMsgContent.length : 0;
                  console.log('[MyRuntimeProvider] 首条 messages/partial 已 yield，距流开始 +' + firstPartialMs + 'ms', 'contentLen=' + firstContentLen);
                }
                // 后端 custom messages_partial 保留 content_parts，使 SDK 走 contentPartsToMerged 分支，得到「思考 → 正文 → 工具」按步展示；不调用 preparePartialChunkPayload 避免剥离 content_parts
                const customMerged = mergeToolResultsIntoAiMessages(filteredNormalized as Array<{ type?: string; id?: string; content?: unknown; content_parts?: unknown; tool_calls?: Array<{ id?: string; name?: string; args?: unknown }>; tool_call_id?: string; name?: string }>, { omitContentParts: false });
                // 与 main 统一：多 AI 时重置 run 级 stableId；按 AI 序号用 getStableIdForIndex/setStableIdForIndex，最后一条用 getOrCreateStableAiId 并回写序号
                const customAiCount = customMerged.filter((m) => { const t = String(m?.type ?? "").toLowerCase(); return t === "ai" || t === "aimessage" || t === "aimessagechunk"; }).length;
                if (customAiCount > 1) streamStableAiMessageIdFallback = null;
                let customLastAiIndex = -1;
                for (let ci = customMerged.length - 1; ci >= 0; ci--) {
                  const tt = String(customMerged[ci]?.type ?? "").toLowerCase();
                  if (tt === "ai" || tt === "aimessage" || tt === "aimessagechunk") {
                    customLastAiIndex = ci;
                    break;
                  }
                }
                const customAiOrdinalByIndex: number[] = [];
                let customOrd = 0;
                for (let ci = 0; ci < customMerged.length; ci++) {
                  const tt = String(customMerged[ci]?.type ?? "").toLowerCase();
                  if (tt === "ai" || tt === "aimessage" || tt === "aimessagechunk") customAiOrdinalByIndex[ci] = customOrd++;
                }
                const customMergedWithStableId = customMerged.map((m, ci) => {
                  const mt = String(m?.type ?? "").toLowerCase();
                  if (mt !== "ai" && mt !== "aimessage" && mt !== "aimessagechunk") return m;
                  const aiOrdinal = customAiOrdinalByIndex[ci] ?? 0;
                  const isLastAi = ci === customLastAiIndex;
                  const hintId = String(m?.id ?? "").trim();
                  let id: string;
                  if (isLastAi) {
                    id = getOrCreateStableAiId(hintId);
                    setStableIdForIndex(aiOrdinal, id);
                  } else {
                    id = getStableIdForIndex(aiOrdinal) ?? (hintId || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `ai-custom-${aiOrdinal}-${Date.now()}`));
                  }
                  return { ...m, id };
                }) as typeof customMerged;
                // content_parts 含 type "reasoning" 时 UI 展示推理块；仅 custom 通道保留 content_parts，complete 时据此回写
                for (const m of customMergedWithStableId as Array<{ type?: string; id?: string; content_parts?: unknown }>) {
                  const mt = String(m?.type ?? "").toLowerCase();
                  if ((mt === "ai" || mt === "aimessagechunk") && m?.id && Array.isArray((m as { content_parts?: unknown }).content_parts) && (m as { content_parts: unknown[] }).content_parts.length > 0) {
                    lastContentPartsByMessageIdRef.current[m.id] = (m as { content_parts: Array<{ type: string; text?: string; id?: string; name?: string; args?: unknown; result?: string }> }).content_parts;
                  }
                }
                const customYieldData = normalizeLangChainMessages(customMergedWithStableId) as LangChainMessage[];
                const streamTidForCustom = externalId ?? currentThreadIdRef.current ?? getCurrentThreadIdFromStorage() ?? "";
                if (streamTidForCustom && customYieldData.length > 0) {
                  lastStreamMessagesByThreadRef.current[streamTidForCustom] = { messages: customYieldData, at: Date.now() };
                }
                yield { ...event, event: 'messages/partial' as const, data: customYieldData as typeof filteredNormalized };
                continue;
              }
              if (d?.type === 'context_stats' && (d as { data?: Record<string, unknown> })?.data) {
                if (runtimeStatsPreferred) continue;
                emitContextStats((d as { data: Record<string, unknown> }).data);
                continue;
              }
              if (d?.type === 'execution_metrics' && (d as { data?: Record<string, unknown> })?.data) {
                if (runtimeStatsPreferred) continue;
                emitExecutionMetrics((d as { data: Record<string, unknown> }).data);
                continue;
              }
              if (d?.type === 'runtime_stats' && (d as { data?: Record<string, unknown> })?.data) {
                runtimeStatsPreferred = true;
                const stats = (d as { data: Record<string, unknown> }).data as {
                  context_stats?: unknown;
                  execution_metrics?: unknown;
                };
                if (stats.context_stats) emitContextStats(stats.context_stats);
                if (stats.execution_metrics) emitExecutionMetrics(stats.execution_metrics);
                continue;
              }
              if (d?.type === 'loop_detected') {
                const payload = (d as { data?: { reason?: string; suggested_strategy?: string } })?.data || {};
                const reason = String(payload?.reason || '').trim() || t("runTracker.loopStoppedReason");
                toast.warning(t("runTracker.loopStopped"), {
                  description: reason,
                  duration: 6000,
                });
                window.dispatchEvent(
                  new CustomEvent("loop_detected", { detail: payload })
                );
                continue;
              }
              // 后端在 interrupt（如 plan 确认 / 工具审批）前发送，前端退出流循环；若为工具审批则等待 resume 后接流续显
              if (d?.type === 'stream_paused') {
                streamDone = true;
                pausedForResume = true;
                seenValidPayload = true;
                if (import.meta.env?.DEV) console.log('[MyRuntimeProvider] stream_paused → break EVENT_LOOP，等待 resume 后接流');
                break EVENT_LOOP;
              }
              if (d?.type === 'run_error') {
                const payload = parseRunErrorPayload(d);
                if (!payload && import.meta.env?.DEV) {
                  console.warn('[MyRuntimeProvider] run_error payload missing or malformed', d);
                }
                const errorCode = String(payload?.error_code ?? '').toLowerCase();
                const message = String(payload?.message ?? '').trim();
                if (errorCode === 'context_exceeded') {
                  toast.error(t("errors.contextExceeded"), {
                    description: message && message.length > 2 ? message : t("errors.contextExceededDescription"),
                    action: {
                      label: t("thread.newSession") || "新开会话",
                      onClick: () => window.dispatchEvent(new CustomEvent(EVENTS.NEW_THREAD_REQUEST)),
                    },
                  });
                } else if (errorCode === '502') {
                  toast.error(t('errors.gateway502'), {
                    description: message && message.trim() ? message : t('errors.gateway502Description'),
                  });
                } else if (errorCode === '400' && (/资源包|不支持该模型/i.test(message))) {
                  toast.error(t('errors.cloudQuotaTitle'), {
                    description: message || t('errors.cloudQuotaDesc'),
                  });
                } else if (errorCode === 'bad_request' || errorCode === '400' || /400|bad request/i.test(message)) {
                  toast.error(t('errors.badRequest400'), {
                    description: message && message.length <= 200 ? message : t('errors.badRequest400Desc'),
                  });
                } else if (message) {
                  toast.error(message);
                } else {
                  toast.error(t("errors.generic"));
                }
                // 收到 run_error 后结束消费循环；结束逻辑由 finally 统一执行（stream_end + task_running）
                if (import.meta.env?.DEV) {
                  console.warn('[MyRuntimeProvider] run_error 详情:', { errorCode, message: message.slice(0, 300) });
                  console.log('[MyRuntimeProvider] run_error → break EVENT_LOOP，finally 将统一发 stream_end');
                }
                // 先 yield error 事件给 SDK，便于其更新最后一条 AI 消息状态并正确结束 run
                yield { event: 'error' as const, data: { error_code: errorCode, message } };
                // #region agent log（仅当配置了 VITE_AGENT_LOG_INGEST_URL 时上报，避免 ERR_CONNECTION_REFUSED）
                const _ingestUrl = (import.meta as { env?: { VITE_AGENT_LOG_INGEST_URL?: string } }).env?.VITE_AGENT_LOG_INGEST_URL;
                if (_ingestUrl) {
                  fetch(_ingestUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'b9e101' },
                    body: JSON.stringify({
                      sessionId: 'b9e101',
                      location: 'MyRuntimeProvider.tsx:run_error',
                      message: 'run_error received, breaking EVENT_LOOP',
                      data: { errorCode, streamDone: true },
                      timestamp: Date.now(),
                      hypothesisId: 'A',
                    }),
                  }).catch((err) => { if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] ingest run_error failed', err); });
                }
                // #endregion
                streamDone = true;
                seenValidPayload = true;
                break EVENT_LOOP;
              }
              if (d?.type === 'reasoning') {
                const payload = (d as { data?: Record<string, unknown> })?.data || {};
                const phase = String((payload as { phase?: string }).phase || '').toLowerCase();
                if (import.meta.env?.DEV && phase) {
                  const contentLen = typeof (payload as { content?: string }).content === 'string' ? (payload as { content: string }).content.length : 0;
                  console.log('[MyRuntimeProvider] reasoning 事件', { phase, contentLen });
                }
                if (phase === 'content') {
                  const msgId = String((payload as { msg_id?: string }).msg_id || '');
                  const content = String((payload as { content?: string }).content || '');
                  // 本次 run 的 threadId 优先用 externalId（stream 开始时已确定），避免会话切换导致 reasoning 错绑
                  const reasoningTid = externalId ?? currentThreadIdRef.current ?? getCurrentThreadIdFromStorage() ?? lastSessionContextThreadId ?? "";
                  if (import.meta.env?.DEV) {
                    console.log('[MyRuntimeProvider] reasoning phase=content', { msgId, contentLen: content?.length ?? 0, empty: !content?.trim(), tid: reasoningTid || '(empty)' });
                  }
                  if (!firstReasoningContentLogged && typeof content === 'string' && content.length > 0) {
                    firstReasoningContentLogged = true;
                  }
                  // Cursor 一致：仅在收到本轮首条思考内容时清空上轮内容，避免 phase=start 时清空导致内容闪没
                  if (!reasoningContentReceivedThisRun && reasoningTid) {
                    clearCurrentRunReasoning(reasoningTid, "reasoning_first_content");
                  }
                  reasoningContentReceivedThisRun = true;
                  enqueueReasoningChunk(msgId, content);
                } else {
                  const tid = externalId ?? currentThreadIdRef.current ?? getCurrentThreadIdFromStorage() ?? lastSessionContextThreadId ?? "";
                  if (tid) {
                    if (phase === 'start') {
                      // 不再在 phase=start 清空，改为在首条 phase=content 时清空，避免思考区闪没
                    }
                    const steps = getStepsForThread(tid);
                    if (phase === 'start') {
                      if (!steps.some((s) => s.id === 'thinking')) {
                        steps.push({ id: 'thinking', label: '思考', status: 'running' });
                        emitStepsUpdated(tid, steps);
                      }
                    } else if (phase === 'end') {
                      const thinkingStep = steps.find((s) => s.id === 'thinking');
                      if (thinkingStep) (thinkingStep as { status: ExecutionStepStatus }).status = 'done';
                      emitStepsUpdated(tid, steps);
                    }
                  }
                  const progressEvent = {
                    type: 'reasoning',
                    phase,
                    timestamp: Date.now(),
                  } as ToolStreamEvent;
                  if (shouldSkipAgentProgress(progressEvent)) {
                    continue;
                  }
                  flushTaskProgress(true);
                  emitStreamEvent(progressEvent as unknown as Record<string, unknown>);
                }
                continue;
              }
              if (d?.type && _AGENT_PROGRESS_TYPES.has(d.type)) {
                const data = (d != null && typeof d === 'object' && (d as { data?: unknown }).data != null && typeof (d as { data?: Record<string, unknown> }).data === 'object')
                  ? (d as { data: Record<string, unknown> }).data
                  : {};
                const payload = {
                  type: d.type,
                  ...data,
                  timestamp: Date.now(),
                } as ToolStreamEvent;
                if (d.type === EVENTS.TASK_PROGRESS) {
                  const payloadPhase = String((payload as { phase?: string }).phase || '').toLowerCase();
                  if (payloadPhase === 'tool_call') {
                    const runTidForProgress = runThreadIdRef.current || streamThreadId || lastSessionContextThreadId || (currentThreadIdRef.current ?? getCurrentThreadIdFromStorage() ?? "");
                    if (runTidForProgress) {
                      const steps = getStepsForThread(runTidForProgress);
                      const prevRunning = steps.find((s) => s.status === 'running');
                      if (prevRunning) (prevRunning as { status: ExecutionStepStatus }).status = 'done';
                      const rawStep = String((payload as { step?: string }).step || (payload as { message?: string }).message || '').trim();
                      const toolName = (payload as { tool?: string }).tool;
                      const stepLabel = rawStep && rawStep !== toolName ? rawStep : (toolName ? getToolDisplayName(toolName) : "执行");
                      const tcId = String((payload as { tool_call_id?: string }).tool_call_id || '').trim() || `tc_${Date.now()}`;
                      steps.push({ id: tcId, label: stepLabel, status: 'running', tool: toolName, tool_call_id: tcId });
                      emitStepsUpdated(runTidForProgress, steps);
                    }
                  }
                  const todos = (payload as { todos?: Array<{ id?: string; status?: string }> }).todos;
                  const baseFp = `${d.type || ''}|${(payload as { message?: string }).message || ''}|${(payload as { phase?: string }).phase || ''}|${(payload as { step?: string }).step || ''}`;
                  const msgFp = Array.isArray(todos) && todos.length > 0
                    ? `${baseFp}|todos:${todos.length}:${todos.map((t) => `${String(t?.id ?? '')}:${String(t?.status ?? '')}`).join(',')}`
                    : baseFp;
                  if (msgFp && msgFp === lastTaskProgressFingerprint) {
                    continue;
                  }
                  lastTaskProgressFingerprint = msgFp;
                  pendingTaskProgressEvent = payload;
                  flushTaskProgress(false);
                } else if (d.type === 'tool_result') {
                  // 使用本 run 所属会话 ID（runThreadIdRef/streamThreadId），与 stream_start 一致，避免用户中途切换会话时把工具结果/步骤记到错误会话（Cursor/Claude 行为）
                  const runTid = runThreadIdRef.current || streamThreadId || lastSessionContextThreadId || (currentThreadIdRef.current ?? getCurrentThreadIdFromStorage() ?? "");
                  const tcid = (payload as { tool_call_id?: string }).tool_call_id;
                  const resultPreview = (payload as { result_preview?: string }).result_preview;
                  if (runTid && tcid) {
                    const steps = getStepsForThread(runTid);
                    const step = steps.find((s) => s.tool_call_id === tcid || s.id === tcid);
                    if (step) {
                      (step as { status: ExecutionStepStatus }).status = 'done';
                      if (resultPreview != null) (step as { result_preview?: string }).result_preview = resultPreview;
                      emitStepsUpdated(runTid, steps);
                    }
                    // 工具结果即时推送到 UI：供工具卡片在 messages 合并前展示（解决「信息已到但未显示」）
                    const streamMsgs = lastStreamMessagesByThreadRef.current[runTid]?.messages ?? [];
                    const lastAi = [...streamMsgs].reverse().find((m: { type?: string; role?: string; id?: string }) =>
                      (m?.type === 'ai' || m?.type === 'AIMessage' || (m as { role?: string })?.role === 'assistant') && m?.id
                    );
                    const messageId = lastAi ? (lastAi as { id?: string }).id : undefined;
                    if (messageId && resultPreview != null) {
                      try {
                        window.dispatchEvent(new CustomEvent(EVENTS.TOOL_RESULT_FOR_UI, {
                          detail: { threadId: runTid, messageId, tool_call_id: tcid, result_preview: resultPreview },
                        }));
                      } catch (e) {
                        if (typeof import.meta !== "undefined" && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
                          console.warn("[MyRuntimeProvider] TOOL_RESULT_FOR_UI dispatch failed:", e);
                        }
                      }
                      // 工具逐步：把 result 写回当前流式消息的 content_parts 缓存，后续 partial/complete 合并时即可展示
                      const parts = lastContentPartsByMessageIdRef.current[messageId];
                      if (Array.isArray(parts)) {
                        const next = parts.map((p: { type?: string; id?: string; result?: string }) => {
                          if (p?.type === 'tool-call' && (p.id === tcid || String(p.id) === String(tcid))) {
                            return { ...p, result: typeof resultPreview === 'string' ? resultPreview : String(resultPreview ?? '') };
                          }
                          return p;
                        }) as Array<{ type: string; text?: string; id?: string; name?: string; args?: unknown; result?: string }>;
                        lastContentPartsByMessageIdRef.current[messageId] = next;
                      }
                    }
                  }
                  if (shouldSkipAgentProgress(payload)) {
                    continue;
                  }
                  flushTaskProgress(true);
                  emitStreamEvent(payload as unknown as Record<string, unknown>);
                } else {
                  if (shouldSkipAgentProgress(payload)) {
                    continue;
                  }
                  flushTaskProgress(true);
                  emitStreamEvent(payload as unknown as Record<string, unknown>);
                }
              }
              } // end for (const d of customItems)
            } catch (e) {
              if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] custom 事件处理异常:', e);
            }
            continue;
          }
          
          // 处理文件事件 - 只刷新文件树，并通知编辑器 onFileAction
          if (event.event === 'file_created' || event.event === 'file_modified' || event.event === 'file_deleted') {
            const path = event.data?.path || '';
            fileEventBus.handleStreamEvent({
              type: event.event,
              path,
              size: event.data?.size,
            });
            const cb = onFileActionRef.current;
            if (cb && path) {
              try {
                if (event.event === 'file_modified' || event.event === 'file_created') {
                  cb({ type: 'refresh', filePath: path });
                } else if (event.event === 'file_deleted') {
                  cb({ type: 'close', filePath: path });
                }
              } catch (e) {
                if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] onFileAction error:', e);
              }
            }
            continue;
          }
          
          // 检测工具调用中的文件操作（用于刷新文件树）
          if (Array.isArray(event.data)) {
            for (const msg of event.data) {
              // 工具调用开始 - 缓存参数
              if (msg?.tool_calls && Array.isArray(msg.tool_calls)) {
                for (const toolCall of msg.tool_calls) {
                  const toolCallId = toolCall.id;
                  if (toolCallId) {
                    if (toolCallArgsCache.size >= MAX_TOOL_CALL_CACHE) {
                      const keysToDrop = [...toolCallArgsCache.keys()].slice(0, 100);
                      keysToDrop.forEach((k) => toolCallArgsCache.delete(k));
                    }
                    toolCallArgsCache.set(toolCallId, {
                      toolName: toolCall.name || toolCall.type,
                      args: toolCall.args || {},
                    });
                  }
                }
              }
              
              // 工具调用完成 - 刷新文件树、通知编辑器 onFileAction，并发出 tool_end（供结果汇总计数与文件路径收集；每条 ToolMessage 均派发以保计数与前后端对接一致）
              if (msg?.type === 'tool' && msg?.tool_call_id) {
                const cached = toolCallArgsCache.get(msg.tool_call_id);
                const filePath = cached ? (cached.args?.file_path || cached.args?.path || cached.args?.target_path || '') : '';
                if (cached) {
                  if (fileEventDetectTimer) clearTimeout(fileEventDetectTimer);
                  fileEventDetectTimer = setTimeout(() => {
                    fileEventDetectTimer = null;
                    fileEventBus.detectFromToolCall(cached.toolName, cached.args);
                  }, 100);
                  const cb = onFileActionRef.current;
                  if (cb && filePath) {
                    try {
                      const name = (cached.toolName || '').toLowerCase();
                      if (name === 'read_file') {
                        cb({ type: 'open', filePath });
                      } else if (name === 'write_file' || name === 'edit_file' || name === 'create_file') {
                        cb({ type: 'open', filePath });
                      } else if (name === 'delete_file' || name === 'remove_file') {
                        cb({ type: 'close', filePath });
                      }
                    } catch (e) {
                      if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] onFileAction error:', e);
                    }
                  }
                  toolCallArgsCache.delete(msg.tool_call_id);
                }
                emitStreamEvent({
                  type: 'tool_end',
                  ...(filePath ? { path: filePath } : {}),
                  ...(cached?.toolName ? { toolName: cached.toolName } : {}),
                });
              }
            }
          }
          
          // 消息事件（主图 + 子图）：streamSubgraphs 时子图事件带命名空间，取 base 类型透传
          const baseEventType = (event?.event ?? '').split('|')[0];
          const isMessageEvent =
            baseEventType === 'messages/partial' ||
            baseEventType === 'messages/complete' ||
            baseEventType === 'messages';

          if (isMessageEvent) {
            // 主通道为 custom 时，partial 只认 custom 单源，避免与 main messages/partial 双写导致重复句子、多光标、变慢；工具/正文均由 custom content_parts 展示
            if (baseEventType === 'messages/partial' && primaryMessageChannel === "custom") continue;
            let data = event.data;
            let allMsgIds: string[] = [];
            if (Array.isArray(data) && data.length > 0) {
              const arr = data as Array<{
                id?: string;
                type?: string;
                tool_calls?: Array<{ id?: string; name?: string | null }>;
                tool_call_chunks?: Array<{ id?: string; name?: string | null }>;
              }>;
              let hasValid = false;
              let needsNormalize = false;
              allMsgIds = [];
              let partialHasDelta = false;
              const nextPartialProgressFingerprints: Array<[string, string, number]> = [];
              for (const msg of arr) {
                if (msg?.id) allMsgIds.push(msg.id);
                const msgType = msg?.type;
                const hasTc = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
                const hasTcc = Array.isArray(msg?.tool_call_chunks) && msg.tool_call_chunks.length > 0;
                if (
                  msgType === 'ai' ||
                  msgType === 'AIMessage' ||
                  msgType === 'AIMessageChunk' ||
                  msgType === 'tool' ||
                  msgType === 'ToolMessage' ||
                  hasTc ||
                  hasTcc
                ) {
                  hasValid = true;
                }
                if (hasTc || hasTcc) {
                  needsNormalize = true;
                }
                if (baseEventType === 'messages/partial' && msg?.id) {
                  const progressFp = getMessageProgressFingerprint(msg as {
                    id?: string;
                    type?: string;
                    content?: unknown;
                    tool_calls?: Array<unknown>;
                    tool_call_chunks?: Array<unknown>;
                  });
                  const progressScore = getMessageProgressScore(msg as {
                    content?: unknown;
                    tool_calls?: Array<unknown>;
                    tool_call_chunks?: Array<unknown>;
                  });
                  nextPartialProgressFingerprints.push([msg.id, progressFp, progressScore]);
                  const prevProgress = partialMessageProgress.get(msg.id);
                  const isMonotonicAdvance = !prevProgress || progressScore > prevProgress.score;
                  const isFingerprintChanged = !prevProgress || prevProgress.fp !== progressFp;
                  if (isMonotonicAdvance && isFingerprintChanged) {
                    partialHasDelta = true;
                  }
                }
              }
              if (hasValid) {
                seenValidPayload = true;
              }
              if (baseEventType === 'messages/partial' && allMsgIds.length > 0 && !partialHasDelta) {
                partialSuppressedCount += 1;
                continue;
              }
              // 避免重复展示：若本条 complete 的 allMsgIds 已全部在 processedMessageIds 中（子集），则跳过
              if (baseEventType === 'messages/complete' && allMsgIds.length > 0 && allMsgIds.every(id => processedMessageIds.has(id))) {
                continue;
              }
              if (baseEventType === 'messages/partial') {
                for (const [msgId, fp, score] of nextPartialProgressFingerprints) {
                  const prev = partialMessageProgress.get(msgId);
                  if (!prev || score >= prev.score) {
                    partialMessageProgress.set(msgId, { fp, score });
                  }
                }
                if (partialMessageProgress.size >= MAX_PROCESSED_IDS) {
                  const toDelete = partialMessageProgress.size - MAX_PROCESSED_IDS;
                  let removed = 0;
                  for (const id of partialMessageProgress.keys()) {
                    if (removed >= toDelete) break;
                    partialMessageProgress.delete(id);
                    removed++;
                  }
                }
              }
              if (baseEventType === 'messages/complete' && processedMessageIds.size >= MAX_PROCESSED_IDS) {
                const toDelete = processedMessageIds.size - MAX_PROCESSED_IDS;
                let removed = 0;
                for (const id of processedMessageIds) {
                  if (removed >= toDelete) break;
                  processedMessageIds.delete(id);
                  removed++;
                }
              }
              if (needsNormalize) data = normalizeToolCallsInMessages(arr);
            }
            // 过滤掉 system/human 消息，仅将 ai/tool 消息传给 UI（type 大小写不敏感）
            const filteredData = Array.isArray(data)
              ? (data as Array<{ type?: string }>).filter(
                  msg => isAllowedMessageType(msg?.type)
                )
              : data;
            if (Array.isArray(filteredData) && filteredData.length === 0) continue;
            if (baseEventType === 'messages/partial') mainPartialCount += 1;
            // 方案 A：首条 main partial 也 yield，保证仅 main 无 custom 时 SDK 从第一包即收到 content_parts，避免断行
            const hasMeaningfulContent = Array.isArray(filteredData) && filteredData.some((m: { type?: string; content?: unknown; tool_calls?: unknown[] }) => {
              const hasToolCalls = Array.isArray((m as { tool_calls?: unknown[] }).tool_calls) && (m as { tool_calls: unknown[] }).tool_calls.length > 0;
              const c = (m as { content?: unknown }).content;
              const hasContent = c != null && (typeof c === 'string' ? c.length > 0 : Array.isArray(c) ? c.length > 0 : true);
              return hasToolCalls || hasContent;
            });
            // 仅在 complete 时锁定主通道，流式期间始终接纳 custom partial（推理 + 工具步骤），避免无推理、只显示「已执行 N 个工具」
            const mayLockMessages = !hasSeenCustomPartialInRun && baseEventType === "messages/complete";
            if (primaryMessageChannel === "auto" && hasMeaningfulContent && (baseEventType === "messages/partial" || baseEventType === "messages/complete") && mayLockMessages) {
              primaryMessageChannel = "messages";
            }
            markPayloadReceived();
            if (baseEventType === 'messages/complete' && allMsgIds.length > 0) {
              for (const msgId of allMsgIds) {
                processedMessageIds.add(msgId);
              }
              if (processedMessageIds.size >= MAX_PROCESSED_IDS) {
                const toDelete = processedMessageIds.size - MAX_PROCESSED_IDS;
                let removed = 0;
                for (const id of processedMessageIds) {
                  if (removed >= toDelete) break;
                  processedMessageIds.delete(id);
                  removed++;
                }
              }
            }
            markUiYield();
            if (baseEventType === "messages/partial" || baseEventType === "messages/complete") {
              seenYieldFromMessagesChannel = true;
            }
            const dataToYield = Array.isArray(filteredData) && filteredData.length > 0
              ? mergeToolResultsIntoAiMessages(filteredData as Array<{ type?: string; id?: string; content?: unknown; tool_calls?: Array<{ id?: string; name?: string; args?: unknown }>; tool_call_id?: string; name?: string }>, { omitContentParts: false })
              : filteredData;
            const completeToolResultById: Record<string, string> = {};
            if (baseEventType === 'messages/complete') {
              if (Array.isArray(filteredData)) {
                for (const m of filteredData as Array<{ type?: string; tool_call_id?: string; toolCallId?: string; content?: unknown }>) {
                  const t = String(m?.type ?? "").toLowerCase();
                  if (t !== "tool" && t !== "toolmessage") continue;
                  const tid = (m.tool_call_id ?? (m as { toolCallId?: string }).toolCallId ?? "").toString().trim();
                  if (!tid) continue;
                  const c = m.content;
                  completeToolResultById[tid] = typeof c === "string" ? c : c != null ? String(c) : "";
                }
              }
              const runTid = externalId ?? currentThreadIdRef.current ?? getCurrentThreadIdFromStorage() ?? "";
              const steps = getStepsForThread(runTid || null);
              for (const step of steps) {
                const tid = (step.tool_call_id ?? (step as { id?: string }).id ?? "").toString().trim();
                if (!tid || completeToolResultById[tid] != null) continue;
                const preview = (step as { result_preview?: string }).result_preview;
                if (typeof preview === "string" && preview.trim().length > 0) completeToolResultById[tid] = preview.trim();
              }
            }
            if (baseEventType === 'messages/complete' && Array.isArray(dataToYield)) {
              const arr = dataToYield as Array<{ type?: string; id?: string; content?: unknown; content_parts?: unknown }>;
              const isAiType = (t: string) => t === "ai" || t === "aimessage" || t === "aimessagechunk";
              let lastAiIndex = -1;
              for (let i = arr.length - 1; i >= 0; i--) {
                const t = String(arr[i]?.type ?? "").toLowerCase();
                if (isAiType(t)) {
                  lastAiIndex = i;
                  break;
                }
              }
              const completeAiOrdinalByIndex: number[] = [];
              let completeOrd = 0;
              for (let i = 0; i < arr.length; i++) {
                const t = String(arr[i]?.type ?? "").toLowerCase();
                if (isAiType(t)) completeAiOrdinalByIndex[i] = completeOrd++;
              }
              for (let i = 0; i < arr.length; i++) {
                const msg = arr[i];
                const mt = String(msg?.type ?? "").toLowerCase();
                if (!isAiType(mt)) continue;
                const isLastAi = i === lastAiIndex;
                const aiOrdinal = completeAiOrdinalByIndex[i] ?? 0;
                if (!isLastAi) {
                  const id = getStableIdForIndex(aiOrdinal) ?? (msg.id && String(msg.id).trim() !== "" ? msg.id : null) ?? (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `ai-${aiOrdinal}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
                  (msg as { id?: string }).id = id;
                  const c = msg.content;
                  let parts: Array<{ type: string; text?: string; id?: string; name?: string; args?: unknown; result?: string }>;
                  if (Array.isArray(c) && c.some((p: { type?: string }) => p?.type === "tool-call" || p?.type === "reasoning")) {
                    parts = (c as Array<{ type?: string; text?: string; id?: string; name?: string; args?: unknown; result?: string }>).map((p) => {
                      if (p?.type === "text") return { type: "text", text: p.text ?? "" };
                      if (p?.type === "reasoning") return { type: "reasoning", text: p.text ?? "" };
                      if (p?.type === "tool-call") return { type: "tool-call", id: p.id ?? "", name: p.name ?? "", args: p.args ?? {}, result: p.result };
                      return null;
                    }).filter(Boolean) as typeof parts;
                  } else {
                    const textStr = typeof c === "string" ? c : (Array.isArray(c) ? (c as Array<{ type?: string; text?: string }>).map((p) => p?.type === "text" ? p.text ?? "" : "").filter(Boolean).join("") : "");
                    parts = textStr ? [{ type: "text", text: textStr }] : [];
                  }
                  if (parts.length) {
                    (msg as { content?: unknown; content_parts?: unknown }).content = parts;
                    (msg as { content_parts?: unknown }).content_parts = parts;
                  }
                  continue;
                }
                const content = msg.content;
                const stableId = getOrCreateStableAiId(String(msg?.id ?? "").trim());
                const cached = lastContentPartsByMessageIdRef.current[stableId] ?? (msg.id && msg.id !== stableId ? lastContentPartsByMessageIdRef.current[msg.id] : undefined);
                const hasCachedReasoning = cached?.some((p: { type?: string }) => p?.type === "reasoning");

                // content 为 string（后端归一化后）：用 cached 恢复 reasoning + 正文 + 工具结果；无 cache 时也转为 content_parts 单段，避免 complete 以 string 收尾导致「先断行再被整理到一行」
                if (!Array.isArray(content)) {
                  const mainText = typeof content === "string" ? content : "";
                  const hasCachedToolCalls = cached?.some((p: { type?: string }) => p?.type === "tool-call");
                  if (cached?.length && (hasCachedReasoning || hasCachedToolCalls)) {
                    const reasoningParts = cached.filter((p: { type?: string }) => p?.type === "reasoning");
                    const toolCallParts = cached.filter((p: { type?: string }) => p?.type === "tool-call").map((p: { type?: string; id?: string; name?: string; args?: unknown; result?: string }) => {
                      if (p.type !== "tool-call" || !p.id) return p;
                      const result = p.result ?? completeToolResultById[p.id];
                      const hasResult = result != null && String(result).trim().length > 0;
                      return hasResult ? { ...p, result: String(result).trim() } : p;
                    });
                    const cachedText = cached.find((p: { type?: string; text?: string }) => p?.type === "text");
                    const finalText = (mainText || (cachedText as { text?: string })?.text || "").trim();
                    const mergedParts = [
                      ...reasoningParts,
                      ...(finalText ? [{ type: "text" as const, text: finalText }] : []),
                      ...toolCallParts,
                    ];
                    (msg as { content: unknown; content_parts?: unknown }).content = mergedParts;
                    (msg as { content_parts?: unknown }).content_parts = mergedParts;
                    (msg as { id?: string }).id = stableId;
                    if (stableId) delete lastContentPartsByMessageIdRef.current[stableId];
                    if (msg.id && msg.id !== stableId) delete lastContentPartsByMessageIdRef.current[msg.id];
                  } else {
                    const singleTextPart = [{ type: "text" as const, text: mainText }];
                    (msg as { content: unknown; content_parts?: unknown }).content = singleTextPart;
                    (msg as { content_parts?: unknown }).content_parts = singleTextPart;
                    (msg as { id?: string }).id = stableId;
                  }
                  continue;
                }

                const currentContent = content as Array<{ type?: string; id?: string; name?: string; args?: unknown; result?: string; text?: string }>;
                const currentToolCount = currentContent.filter((p: { type?: string }) => p?.type === "tool-call").length;
                const cachedToolCount = cached ? cached.filter((p: { type?: string }) => p?.type === "tool-call").length : 0;
                const buildPartsFromCurrent = () =>
                  currentContent.map((p) => {
                    if (p?.type === "text") return { type: "text" as const, text: p.text ?? "" };
                    if (p?.type === "reasoning") return { type: "reasoning" as const, text: p.text ?? "" };
                    if (p?.type === "tool-call") return { type: "tool-call" as const, id: p.id ?? "", name: p.name ?? "", args: p.args ?? {}, result: (p.result ?? completeToolResultById[p.id ?? ""]) || undefined };
                    return null;
                  }).filter(Boolean) as Array<{ type: string; text?: string; id?: string; name?: string; args?: unknown; result?: string }>;
                if (currentToolCount > 0 && (!cached?.length || cachedToolCount === 0)) {
                  if (stableId) delete lastContentPartsByMessageIdRef.current[stableId];
                  if (msg.id && msg.id !== stableId) delete lastContentPartsByMessageIdRef.current[msg.id];
                  (msg as { id?: string }).id = stableId;
                  const parts = buildPartsFromCurrent();
                  if (parts.length) {
                    (msg as { content?: unknown; content_parts?: unknown }).content = parts;
                    (msg as { content_parts?: unknown }).content_parts = parts;
                  }
                  continue;
                }
                if (cached && cachedToolCount < currentToolCount) {
                  if (stableId) delete lastContentPartsByMessageIdRef.current[stableId];
                  if (msg.id && msg.id !== stableId) delete lastContentPartsByMessageIdRef.current[msg.id];
                  (msg as { id?: string }).id = stableId;
                  const parts = buildPartsFromCurrent();
                  if (parts.length) {
                    (msg as { content?: unknown; content_parts?: unknown }).content = parts;
                    (msg as { content_parts?: unknown }).content_parts = parts;
                  }
                  continue;
                }
                if (!cached?.length || content.some((p: { type?: string }) => p?.type === "reasoning")) {
                  if (stableId && content.some((p: { type?: string }) => p?.type === "reasoning")) delete lastContentPartsByMessageIdRef.current[stableId];
                  if (msg.id && msg.id !== stableId) delete lastContentPartsByMessageIdRef.current[msg.id];
                  (msg as { id?: string }).id = stableId;
                  const parts = buildPartsFromCurrent();
                  if (parts.length) {
                    (msg as { content?: unknown; content_parts?: unknown }).content = parts;
                    (msg as { content_parts?: unknown }).content_parts = parts;
                  }
                  continue;
                }
                const mergedParts = cached.map((p) => {
                  if (p.type === 'tool-call' && p.id) {
                    const fromCurrent = currentContent.find((x: { type?: string; id?: string }) => x?.type === 'tool-call' && x?.id === p.id);
                    return { ...p, result: (fromCurrent as { result?: string })?.result ?? p.result };
                  }
                  return p;
                });
                (msg as { content: unknown; content_parts?: unknown }).content = mergedParts;
                (msg as { content_parts?: unknown }).content_parts = mergedParts;
                const oldId = msg.id;
                if (stableId) delete lastContentPartsByMessageIdRef.current[stableId];
                if (oldId && oldId !== stableId) delete lastContentPartsByMessageIdRef.current[oldId];
                (msg as { id?: string }).id = stableId;
              }
            }
            let normalizedYield = normalizeLangChainMessages(dataToYield);
            if (baseEventType === 'messages/complete' && Array.isArray(normalizedYield)) {
              ensureAiMessagesHaveContentParts(normalizedYield as Array<{ type?: string; content?: unknown; content_parts?: unknown }>);
            }
            // 主通道 partial 不再转为 delta：始终发 content_parts，让 SDK 走「替换」分支，避免按字符追加导致断行
            if (baseEventType === 'messages/partial' && Array.isArray(normalizedYield)) {
              const arr = normalizedYield as Array<{ type?: string; id?: string; content?: unknown; content_parts?: unknown }>;
              ensurePartialPayloadContentParts(arr, getOrCreateStableAiId, getStableIdForIndex, setStableIdForIndex, lastContentPartsByMessageIdRef, () => { streamStableAiMessageIdFallback = null; });
              normalizedYield = normalizeLangChainMessages(arr) as typeof normalizedYield;
              if (import.meta.env?.DEV && !firstMainPartialLogged) {
                firstMainPartialLogged = true;
                const firstAi = (normalizedYield as unknown[]).find((m: unknown) => { const t = String((m as { type?: string })?.type ?? "").toLowerCase(); return t === "ai" || t === "aimessage" || t === "aimessagechunk"; });
                if (firstAi) {
                  const c = (firstAi as { content?: unknown }).content;
                  const parts = (firstAi as { content_parts?: unknown }).content_parts;
                  console.log('[MyRuntimeProvider] 主通道首条 yield 的 messages/partial', { contentType: typeof c, isArray: Array.isArray(c), hasContentParts: Array.isArray(parts) && parts.length > 0, contentPartsLen: Array.isArray(parts) ? parts.length : 0 });
                }
              }
            }
            if (baseEventType === 'messages/complete' && Array.isArray(normalizedYield)) {
              streamStableAiMessageIdFallback = null;
              for (const m of normalizedYield as Array<{ type?: string; id?: string }>) {
                const tid = String(m?.id ?? "").trim();
                if (tid) streamAiAccumulatedById.delete(tid);
              }
            }
            const streamTid = externalId ?? currentThreadIdRef.current ?? "";
            if (streamTid && Array.isArray(normalizedYield) && normalizedYield.length > 0) {
              lastStreamMessagesByThreadRef.current[streamTid] = { messages: normalizedYield as LangChainMessage[], at: Date.now() };
            }
            // yield 前加固：DEV 下检查每条 AI 消息均有 content_parts，便于排查断行
            if (import.meta.env?.DEV && baseEventType === 'messages/partial' && Array.isArray(normalizedYield)) {
              for (const m of normalizedYield as Array<{ type?: string; content?: unknown; content_parts?: unknown }>) {
                const t = String(m?.type ?? "").toLowerCase();
                if (t !== "ai" && t !== "aimessage" && t !== "aimessagechunk") continue;
                const hasParts = Array.isArray(m.content_parts) && (m.content_parts as unknown[]).length > 0;
                const contentIsArray = Array.isArray(m.content);
                if (!hasParts || !contentIsArray) {
                  console.warn('[MyRuntimeProvider] messages/partial yield 前 AI 消息缺 content_parts 或 content 非数组', { hasParts, contentIsArray, id: (m as { id?: string }).id });
                }
              }
            }
            // 先写入 stream 缓存再 yield，避免 run 结束后 SDK 调用 load(id) 时读到旧状态导致会话被清空
            yield { ...event, event: baseEventType, data: normalizedYield };
          } else if (event.event === 'updates') {
            markPayloadReceived();
            const updatesData = (event.data as { messages?: unknown[]; __interrupt__?: unknown; [k: string]: unknown } | undefined) ?? {};
            // SDK 对 updates 会 replaceMessages，任意条数都会整体替换会话；后端/LangGraph 常在下发 delta 或不全量，导致历史被清空。不再通过 updates 传 messages，仅保留 __interrupt__ 等字段，消息仅由 messages/partial 与 messages/complete 维护。
            const payload = { ...updatesData };
            delete payload.messages;
            if (import.meta.env?.DEV && Array.isArray(updatesData.messages)) {
              console.warn("[MyRuntimeProvider] updates 的 messages 已剥离，避免 replaceMessages 清空会话", { hadMessages: updatesData.messages.length });
            }
            yield { ...event, data: payload };
          } else if (event.event === 'error') {
            markPayloadReceived();
            console.error(`[MyRuntimeProvider] ❌ 后端错误:`, event.data);
            const errorData = event.data as { error?: string; message?: string; [k: string]: unknown };
            const rawMsg = (typeof errorData?.message === 'string' ? errorData.message : null)
              || (typeof errorData?.error === 'string' ? errorData.error : null)
              || (typeof event.data === 'string' ? event.data : JSON.stringify(event.data ?? ''));
            const errMsg = (rawMsg && rawMsg.length > 200 ? rawMsg.slice(0, 200) + '…' : rawMsg) || t("runtime.unknownError");
            const isModelResource = /failed to load model|insufficient system resources|invalid_request_error|显存|内存不足/i.test(errMsg);
            toast.error(
              isModelResource ? t("runtime.modelLoadFailed") : t("runtime.backendError"),
              { description: isModelResource ? t("runtime.modelResourceDesc") : errMsg }
            );
            window.dispatchEvent(new CustomEvent(EVENTS.BACKEND_ERROR, {
              detail: {
                error: errorData?.error || 'UnknownError',
                message: errMsg,
                timestamp: Date.now(),
                request_id: typeof errorData?.request_id === 'string' ? errorData.request_id : undefined,
              }
            }));
            // 若此前未 yield 过任何可展示内容，SDK 侧无“最后一条 AI 消息”可挂错误状态，聊天区会空白；先 yield 一条占位 AI 消息再 yield error，保证聊天区有错误信息可看
            if (!seenValidPayload) {
              const placeholderId = `error-${Date.now()}`;
              const errorPayload = event.data as Record<string, unknown> | undefined;
              const requestId = typeof errorPayload?.request_id === 'string' ? errorPayload.request_id : undefined;
              const statusError = requestId ? { ...errorPayload, request_id: requestId } : event.data;
              const placeholderMessage = {
                id: placeholderId,
                type: 'ai' as const,
                content: isModelResource ? `${t("runtime.modelLoadFailed")}：${t("runtime.modelResourceDesc")}` : errMsg,
                status: { type: 'incomplete' as const, reason: 'error' as const, error: statusError },
              };
              markUiYield();
              yield { event: 'messages/complete' as const, data: normalizeLangChainMessages([placeholderMessage]) as typeof placeholderMessage[] };
              seenValidPayload = true;
            }
            streamDone = true;
            break EVENT_LOOP;
          }
        }
        if (import.meta.env?.DEV) console.log('[MyRuntimeProvider] EVENT_LOOP 已退出', { streamDone, seenValidPayload });
        // #region agent log（仅当配置了 VITE_AGENT_LOG_INGEST_URL 时上报）
        const _ingestUrlB = (import.meta as { env?: { VITE_AGENT_LOG_INGEST_URL?: string } }).env?.VITE_AGENT_LOG_INGEST_URL;
        if (_ingestUrlB) {
          fetch(_ingestUrlB, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'b9e101' },
            body: JSON.stringify({
              sessionId: 'b9e101',
              location: 'MyRuntimeProvider.tsx:after_event_loop',
              message: 'for-await EVENT_LOOP exited',
              data: { streamDone, seenValidPayload },
              timestamp: Date.now(),
              hypothesisId: 'B',
            }),
          }).catch((err) => { if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] ingest after_event_loop failed', err); });
        }
        // #endregion
        try {
          generator.return?.(undefined);
        } catch {
          /* 忽略关闭旧流时的异常 */
        }

        if (!streamDone && !seenValidPayload) {
          const noPayloadId = `no-payload-${Date.now()}`;
          yield {
            event: 'messages/complete' as const,
            data: [{
              id: noPayloadId,
              type: 'ai' as const,
              content: '本次运行未返回可展示的回复，请稍后重试。',
              status: { type: 'incomplete' as const, reason: 'error' as const },
            }],
          };
          streamDone = true;
          return;
        }
        // 工具/计划确认后同一 run 接流续显（会话内连续）
        if (pausedForResume && externalId) {
          const RESUME_WAIT_MS = 5 * 60 * 1000;
          let runId: string | undefined;
          try {
            runId = await new Promise<string>((resolve, reject) => {
              const t = setTimeout(() => {
                const r = resumeRunResolverRef.current;
                if (r && r.threadId === externalId) {
                  r.reject(new Error('Resume timeout'));
                  resumeRunResolverRef.current = null;
                }
              }, RESUME_WAIT_MS);
              resumeRunResolverRef.current = {
                resolve: (id: string) => { clearTimeout(t); resumeRunResolverRef.current = null; resolve(id); },
                reject: (err: Error) => { clearTimeout(t); resumeRunResolverRef.current = null; reject(err); },
                threadId: externalId as string,
              };
            });
          } catch (e) {
            if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] resume 等待超时或取消', e);
            return;
          }
          if (typeof runId !== 'string' || streamVersionRef.current !== myStreamVersion) return;
          const resumeRunId = runId;
          try {
            for await (const ev of streamRun(externalId, resumeRunId, { signal: streamController.signal })) {
              if (streamVersionRef.current !== myStreamVersion) break;
              const baseEvType = String((ev as { event?: string }).event ?? "").split("|")[0];
              if (baseEvType === "messages/partial" && Array.isArray((ev as { data?: unknown }).data)) {
                const arr = (ev as { data: unknown[] }).data as StreamPartialAiMessage[];
                const merged = mergeToolResultsIntoAiMessages(arr as Array<{ type?: string; id?: string; content?: unknown; tool_calls?: Array<{ id?: string; name?: string; args?: unknown }>; tool_call_id?: string; name?: string }>, { omitContentParts: false });
                const normalized = normalizeLangChainMessages(merged) as Array<{ type?: string; id?: string; content?: unknown; content_parts?: unknown }>;
                ensurePartialPayloadContentParts(normalized, getOrCreateStableAiId, getStableIdForIndex, setStableIdForIndex, lastContentPartsByMessageIdRef, () => { streamStableAiMessageIdFallback = null; });
                const final = normalizeLangChainMessages(normalized);
                yield { ...ev, event: "messages/partial" as const, data: final } as LangGraphMessagesEvent<LangChainMessage>;
              } else {
                yield ev as LangGraphMessagesEvent<LangChainMessage>;
              }
            }
          } catch (e) {
            if (!isUserAbort(e) && import.meta.env?.DEV) console.warn('[MyRuntimeProvider] resume 接流异常', e);
          }
        }
        const wasAbandoned = streamToken !== activeStreamTokenRef.current;
        if (!wasAbandoned) {
          flushTaskProgress(true);
          flushReasoningContent(true);
          flushMetricsEvents(true);
          if (pendingContextStats !== null) {
            emitContextStats(pendingContextStats, true);
          }
          window.dispatchEvent(new CustomEvent(EVENTS.MESSAGE_SENT));
          if (import.meta.env?.DEV) {
            const frontendMetrics = {
              frontend_first_payload_ms:
                firstPayloadReceivedAt > 0 ? Math.max(0, firstPayloadReceivedAt - streamStartedAt) : null,
              frontend_first_ui_yield_ms:
                firstUiYieldAt > 0 ? Math.max(0, firstUiYieldAt - streamStartedAt) : null,
              frontend_payload_to_ui_ms:
                firstPayloadReceivedAt > 0 && firstUiYieldAt > 0
                  ? Math.max(0, firstUiYieldAt - firstPayloadReceivedAt)
                  : null,
              frontend_max_inter_payload_gap_ms: maxInterPayloadGapMs,
            };
            window.dispatchEvent(new CustomEvent('frontend_stream_metrics', { detail: frontendMetrics }));
            console.info('[MyRuntimeProvider] 前端流式指标:', frontendMetrics);
          }
          const threadId = externalId ?? currentThreadIdRef.current ?? getCurrentThreadIdFromStorage() ?? "";
          const steps = getStepsForThread(threadId);
          const runningCount = steps.filter((s) => s.status === "running").length;
          if (runningCount > 0) {
            const next = steps.map((s) =>
              s.status === "running" ? ({ ...s, status: "done" as ExecutionStepStatus }) : s
            );
            emitStepsUpdated(threadId, next);
          }
        }
        streamExitReason = 'complete';
        streamDone = true;
      } catch (innerErr) {
        if (isUserAbort(innerErr)) {
          streamExitReason = 'abort';
          runStreamCleanup(myStreamVersion, 'abort', externalId ?? undefined);
          return;
        }
        if (isThreadNotFoundError(innerErr)) {
          if (threadRebuildCount >= MAX_THREAD_REBUILDS) {
            if (!seenValidPayload) {
              toast.error(t('runtime.sendFailed'), { description: t('runtime.sendFailedThreadLimit') });
              (innerErr as { _toasted?: boolean })._toasted = true;
            }
            throw innerErr;
          }
          streamAbortControllerRef.current = null;
          externalId = await createAndActivateThread(firstContent || undefined, resolvedWorkspacePath);
          threadRebuildCount++;
          attempt = -1;
          continue;
        }
        if (attempt < 2 && isRetryableNetworkError(innerErr)) {
          if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] 网络错误，将重试:', innerErr);
          continue;
        }
        if (!seenValidPayload) {
          toast.error(t('runtime.sendFailed'), {
            description: buildSendFailureGuidance(innerErr),
            ...(isThreadNotFoundError(innerErr)
              ? {
                  action: {
                    label: t("thread.newSession"),
                    onClick: () => window.dispatchEvent(new CustomEvent(EVENTS.NEW_THREAD_REQUEST)),
                  },
                }
              : {}),
          });
          (innerErr as { _toasted?: boolean })._toasted = true;
        }
        throw innerErr;
      } finally {
        if (longWaitTimer) clearTimeout(longWaitTimer);
        if (idleTimer) clearTimeout(idleTimer);
        if (metricsBatchTimer) {
          clearTimeout(metricsBatchTimer);
          metricsBatchTimer = null;
        }
        if (fileEventDetectTimer) {
          clearTimeout(fileEventDetectTimer);
          fileEventDetectTimer = null;
        }
        attempt++;
      }
      }
      }
      catch (err) {
        if (isUserAbort(err)) {
          streamExitReason = 'abort';
          runStreamCleanup(myStreamVersion, 'abort', externalId ?? undefined);
          return;
        }
        streamExitReason = 'error';
        if (!(err as { _toasted?: boolean })._toasted) {
          toast.error(t('runtime.sendFailed'), {
            description: buildSendFailureGuidance(err),
            ...(isThreadNotFoundError(err)
              ? {
                  action: {
                    label: t("thread.newSession"),
                    onClick: () => window.dispatchEvent(new CustomEvent(EVENTS.NEW_THREAD_REQUEST)),
                  },
                }
              : {}),
          });
        }
        // 不再 rethrow：避免 async generator 向消费者抛错导致 unhandled rejection 进而引发渲染进程崩溃；cleanup 由 finally 执行
      } finally {
        if (import.meta.env?.DEV) console.log('[MyRuntimeProvider] stream() finally 执行', { myStreamVersion, currentVersion: streamVersionRef.current });
        // #region agent log（仅当配置了 VITE_AGENT_LOG_INGEST_URL 时上报）
        const _ingestUrlC = (import.meta as { env?: { VITE_AGENT_LOG_INGEST_URL?: string } }).env?.VITE_AGENT_LOG_INGEST_URL;
        if (_ingestUrlC) {
          fetch(_ingestUrlC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'b9e101' },
            body: JSON.stringify({
              sessionId: 'b9e101',
              location: 'MyRuntimeProvider.tsx:stream_finally',
              message: 'stream() finally, clearing isStreamingRef',
              data: { myStreamVersion, currentVersion: streamVersionRef.current },
              timestamp: Date.now(),
              hypothesisId: 'C',
            }),
          }).catch((err) => { if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] ingest stream_finally failed', err); });
        }
        // #endregion
        runStreamCleanup(myStreamVersion, streamExitReason, externalId ?? undefined);
      }
      } finally {
        // 兜底：确保串行锁一定被释放（正常/abort 路径已由 runStreamCleanup 释放，此处应对未走 runStreamCleanup 的异常退出）
        try { streamSerialResolveRef.current?.(); streamSerialResolveRef.current = null; } catch { /* ignore */ }
      }
    },

    // ✅ create 函数 - ThreadList 点击"新建"时调用
    create: async () => {
      setCurrentThreadId(null);

      const userContext = getUserContext();
      const inheritedRoleId = resolveActiveRoleId();
      const inheritedMode = resolveActiveChatMode();
      const resolvedWorkspacePath = await resolveWorkspacePath(editorContextRef.current?.workspacePath);
      let thread_id: string;
      try {
        const res = await createThread({
          user_id: userContext.userId,
          team_id: userContext.teamId,
          user_name: userContext.userName,
          team_name: userContext.teamName,
          ...(resolvedWorkspacePath ? { workspace_path: resolvedWorkspacePath } : {}),
          ...(inheritedRoleId ? { active_role_id: inheritedRoleId, role_id: inheritedRoleId } : {}),
          mode: inheritedMode,
        });
        thread_id = res.thread_id;
      } catch (err) {
        toast.error(t("runtime.createThreadFailed"));
        throw err;
      }
      if (!isMountedRef.current) return { externalId: "" };
      setCurrentThreadId(thread_id);
      try {
        activateThreadSession(thread_id, thread_id.slice(0, 8));
        if (inheritedRoleId) setScopedActiveRoleIdInStorage(inheritedRoleId, thread_id);
        setScopedChatMode(inheritedMode, thread_id);
        emitSessionCreated({
          threadId: thread_id,
          title: thread_id.slice(0, 8),
          roleId: inheritedRoleId,
          mode: inheritedMode,
          workspacePath: resolvedWorkspacePath,
        });
      } catch (e) {
        if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] initialize session sync failed', e);
      }
      onThreadChange?.(thread_id);
      return { externalId: thread_id };
    },

    // ✅ load 函数 - 切换到已有 Thread 时调用（失败时设 threadLoadError 并返回空，由 Thread 展示重试条）
    load: loadWrapped,

    // ✅ onSwitchToThread 函数 - 支持线程切换和"重新生成"功能
    onSwitchToThread: async (externalId: string) => loadThreadState(externalId),
  });

  const retryLoad = React.useCallback(() => {
    if (!failedThreadIdForRetry) return;
    setThreadLoadError(null);
    runtime?.switchToThread?.(failedThreadIdForRetry);
    setFailedThreadIdForRetry(null);
  }, [failedThreadIdForRetry, runtime]);

  const threadLoadErrorValue = React.useMemo(
    () => ({ loadError: threadLoadError, retry: retryLoad }),
    [threadLoadError, retryLoad]
  );

  // ✅ 取消运行的处理函数：先 abort 当前流（前端立即停止消费），再调 API 取消服务端 run
  const handleCancel = React.useCallback(async () => {
    const threadId = currentThreadIdRef.current;
    const runId = currentRunIdRef.current;
    if (!threadId || (!runId && !streamAbortControllerRef.current)) {
      toast.info(t("composer.noActiveRun"));
      return;
    }
    if (streamAbortControllerRef.current) {
      streamAbortControllerRef.current.abort();
      streamAbortControllerRef.current = null;
    }
    const tidForCancel = currentThreadIdRef.current ?? getCurrentThreadIdFromStorage() ?? "";
    // 用户取消时此处立即清理以便 UI 即时反馈；stream() 因 abort 退出后 finally 会再次执行相同逻辑，二者幂等，文档单点仍为 stream() finally
    try {
      const success = await cancelRun(threadId, runId ?? undefined);
      if (success) {
        toast.success(t("composer.stopSuccess"));
        isStreamingRef.current = false;
        currentRunIdRef.current = null;
        toolStreamEventBus.handleStreamEvent({ type: "stream_end", reason: "abort", threadId: tidForCancel || undefined });
      } else {
        isStreamingRef.current = false;
        currentRunIdRef.current = null;
        toast.info(t("composer.noActiveRun"));
        toolStreamEventBus.handleStreamEvent({ type: "stream_end", threadId: tidForCancel || undefined });
      }
    } catch (error) {
      console.error('[MyRuntimeProvider] ❌ 取消运行出错:', error);
      toast.error(t("composer.stopFailed"));
      isStreamingRef.current = false;
      currentRunIdRef.current = null;
      toolStreamEventBus.handleStreamEvent({ type: "stream_end", reason: "error", threadId: tidForCancel || undefined });
    }
  }, []);

  // ✅ 监听 switch_to_thread：仪表盘/命令面板「继续」时切换到指定线程。乐观更新 session 存储并派发 SESSION_CHANGED；若 switchToThread 失败则回滚 session，避免 UI 与 SDK 当前线程不一致。
  React.useEffect(() => {
    const handleSwitchToThread = (e: CustomEvent<{ threadId?: string }>) => {
      const threadId = e.detail?.threadId;
      if (!threadId) return;
      const previousId = currentThreadIdRef.current || getCurrentThreadIdFromStorage() || "";
      // 仅当为服务端 UUID 时做乐观激活并写存储；非 UUID（如占位/新会话）仍调用 switchToThread 触发 load，load 内会创建新线程
      if (isValidServerThreadId(threadId)) {
        try {
          activateThread(threadId, threadId.slice(0, 8));
        } catch (e) {
          if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] activateThread on SWITCH_TO_THREAD failed', e);
        }
      }
      const p = runtime?.switchToThread?.(threadId) as Promise<unknown> | undefined;
      if (p != null && typeof p.catch === 'function') {
        p.catch((err: unknown) => {
          if (!isMountedRef.current) return;
          const msg = err instanceof Error ? err.message : String(err);
          if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] switchToThread failed:', msg);
          if (currentThreadIdRef.current === threadId) {
            if (previousId && isValidServerThreadId(previousId)) {
              try { activateThread(previousId, previousId.slice(0, 8)); } catch (e) {
                if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] activateThread rollback failed', e);
              }
            } else {
              setCurrentThreadId(null);
              clearActiveThreadSession();
            }
          }
          if (msg.includes('Thread not found') || msg.includes('not found')) {
            (async () => {
              const resolved = await resolveTaskRefByTaskOrThread({ threadId });
              if (!isMountedRef.current) return;
              if (resolved?.task) {
                window.dispatchEvent(
                  new CustomEvent(EVENTS.OPEN_TASK_IN_EDITOR, {
                    detail: { taskId: resolved.task.id, subject: resolved.task.subject || "任务" },
                  })
                );
                toast.info(t("runtime.threadFallback"), {
                  description: t("runtime.threadFallbackTask", { subject: resolved.task.subject || resolved.task.id }),
                });
                return;
              }
              toast.warning(t("runtime.threadNotInSession"), {
                description: t("runtime.threadNotInSessionDesc"),
              });
            })().catch((resolveErr) => {
              if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] resolveTaskRefByTaskOrThread:', resolveErr);
              if (isMountedRef.current) {
                toast.warning(t("runtime.threadNotInSession"), {
                  description: t("runtime.threadNotInSessionDesc"),
                });
              }
            });
          } else {
            toast.error(t('runTracker.switchThreadFailed'), { description: msg });
          }
        });
      }
    };
    window.addEventListener(EVENTS.SWITCH_TO_THREAD, handleSwitchToThread);
    return () => window.removeEventListener(EVENTS.SWITCH_TO_THREAD, handleSwitchToThread);
  }, [runtime, activateThread]);

  // 工作区切换后仅清空上下文并提示；不自动新建会话，仅用户点击「新建会话」时创建。当前工作区路径优先从事件 detail 读取，与协议一致。
  React.useEffect(() => {
    const handleWorkspaceChanged = (e: Event) => {
      try {
        const workspacePath = (e as CustomEvent<{ workspacePath?: string }>).detail?.workspacePath ?? getCurrentWorkspacePathFromStorage() ?? '';
        window.dispatchEvent(new CustomEvent(EVENTS.CONTEXT_ITEMS_CHANGED, { detail: { contextItems: [] } }));
        toast.info(t('workspace.workspaceSwitched'), {
          description: workspacePath ? `${t('workspace.workspaceSwitchedDesc')} (${workspacePath})` : t('workspace.workspaceSwitchedDesc'),
          action: {
            label: t('workspace.newChatAction'),
            onClick: () => window.dispatchEvent(new CustomEvent(EVENTS.NEW_THREAD_REQUEST)),
          },
        });
      } catch (err) {
        if (import.meta.env?.DEV) console.warn('[MyRuntimeProvider] handleWorkspaceChanged:', err);
      }
    };
    window.addEventListener(EVENTS.WORKSPACE_CONTEXT_CHANGED, handleWorkspaceChanged);
    return () => window.removeEventListener(EVENTS.WORKSPACE_CONTEXT_CHANGED, handleWorkspaceChanged);
  }, []);

  // 组织化：消费后端孵化请求并自动创建 worker 窗口（仅 Electron）
  React.useEffect(() => {
    if (!isElectronEnv()) return;
    let cancelled = false;
    let pollingInFlight = false;
    const timer = window.setInterval(async () => {
      if (pollingInFlight) return;
      pollingInFlight = true;
      try {
        const spawnResult = await boardApi.consumeSpawnRequests({ limit: 2, consume: true });
        if (cancelled) return;
        if (!spawnResult.ok) return;
        const rows = Array.isArray(spawnResult.rows) ? spawnResult.rows : [];
        if (!rows.length) return;
        for (const row of rows) {
          if (cancelled) return;
          const roleId = String(row?.role || "digital_worker");
          const threadId = String(row?.child_agent_id || `thread-${Date.now()}`);
          const created = await window.electron?.createWorkerWindow?.({ roleId, threadId });
          if (cancelled) return;
          if (created?.success) {
            const linkedTaskId = String(row?.task_id || "").trim();
            if (linkedTaskId) {
              try {
                await boardApi.updateTask(linkedTaskId, {
                  scope: "personal",
                  thread_id: threadId,
                  claimed_by: roleId,
                  status: "claimed",
                });
              } catch {
                // 绑定失败不影响窗口拉起
              }
            }
            if (cancelled) return;
            window.dispatchEvent(
              new CustomEvent("autonomy-evolution", {
                detail: {
                  title: "已孵化数字员工窗口",
                  description: linkedTaskId
                    ? `角色：${roleId}，线程：${threadId}，任务：${linkedTaskId}`
                    : `角色：${roleId}，线程：${threadId}`,
                  threadId,
                },
              })
            );
          }
        }
      } catch {
        // 非关键链路：静默降级
      } finally {
        pollingInFlight = false;
      }
    }, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // 接收 Electron 主进程窗口上下文，确保子窗口会话绑定到指定 threadId
  React.useEffect(() => {
    const electron = window.electron;
    if (!electron?.onWindowContext) return;
    const off = electron.onWindowContext((payload: any) => {
      try {
        const threadId = String(payload?.threadId || "").trim();
        const roleId = String(payload?.roleId || "").trim();
        if (threadId) {
          activateThreadSession(threadId, threadId.slice(0, 8));
          onThreadChange?.(threadId);
        }
        if (roleId) {
          setScopedActiveRoleIdInStorage(roleId, threadId || undefined);
          window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
        }
      } catch {
        // noop
      }
    });
    return () => {
      try {
        off?.();
      } catch {
        // noop
      }
    };
  }, [onThreadChange]);

  // ✅ 暴露取消函数给子组件（threadId 用 state 保证切换线程后消费者拿到最新值）
  const contextValue = React.useMemo(() => ({
    cancelRun: handleCancel,
    threadId: currentThreadId,
  }), [handleCancel, currentThreadId]);

  const openFilesForMention = React.useMemo(() => {
    const openList = (openFiles ?? []).map((f) => ({ path: f.path, name: f.path.split("/").pop() || f.path }));
    const wsList = workspaceFiles ?? fetchedWorkspaceFiles;
    const seen = new Set<string>();
    const out: Array<{ path: string; name: string }> = [];
    for (const f of openList) {
      if (!seen.has(f.path)) {
        seen.add(f.path);
        out.push(f);
      }
    }
    for (const f of wsList) {
      if (!seen.has(f.path)) {
        seen.add(f.path);
        out.push(f);
      }
    }
    return out.slice(0, 50);
  }, [openFiles, workspaceFiles, fetchedWorkspaceFiles]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadLoadErrorContext.Provider value={threadLoadErrorValue}>
        <OpenFilesContext.Provider value={openFilesForMention}>
          <CancelContext.Provider value={contextValue}>
            {children}
          </CancelContext.Provider>
        </OpenFilesContext.Provider>
      </ThreadLoadErrorContext.Provider>
    </AssistantRuntimeProvider>
  );
}

// 兼容：部分模块或 Vite 预构建仍从本文件解析 CancelContext，保持再导出避免运行时报错
export { CancelContext } from "./cancelContext";
