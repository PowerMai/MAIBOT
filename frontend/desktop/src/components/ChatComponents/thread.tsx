import React, { useCallback, useEffect, useMemo, useRef, useState, memo, lazy, Suspense } from "react";
import type { FC, PropsWithChildren } from "react";
import {
  UserMessageAttachments,
} from "./attachment";
import ReactMarkdown from "react-markdown";
import { remarkPluginsWithMath, rehypePluginsMath } from "../../lib/markdownRender";
import { MarkdownText, parseThinkingContent } from "./markdown-text";
import {
  ToolFallback,
  getToolTier,
  getPartKeyInfo,
  getToolDisplayName,
  extractResultSummary,
  extractResultPreview,
  ReadFileToolUI,
  BatchReadFilesToolUI,
  WriteFileToolUI,
  EditFileToolUI,
  WriteFileBinaryToolUI,
  AnalyzeDocumentToolUI,
  CodeExecutionToolUI,
  PythonRunToolUI,
  ShellRunToolUI,
  ShellRunUI,
  SearchToolUI,
  GrepSearchToolUI,
  FileSearchToolUI,
  WebSearchToolUI,
  ThinkToolUI,
  PlanToolUI,
  ExtendedThinkingToolUI,
  TaskToolUI,
  WriteTodosToolUI,
  RecordResultToolUI,
  ReportTaskResultToolUI,
  RecordFailureToolUI,
  AskUserToolUI,
  GetLibrariesToolUI,
  SearchKnowledgeToolUI,
  KnowledgeGraphToolUI,
  ExtractEntitiesToolUI,
  QueryKGToolUI,
  GetLearningStatsToolUI,
  CriticReviewToolUI,
} from "./tool-fallback";
import { GenerativeUI, GenerativeUIMessagePart } from "./generative-ui";
import { TooltipIconButton } from "./tooltip-icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { cn } from "../ui/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { CursorStyleComposer, ChatMode } from "./cursor-style-composer";
import { ChatModeContext, TurnModeContext } from "./threadContexts";
import { ThreadWelcomeInline } from "./ThreadWelcomeInline";
import { useAgentProgress, useNativeReasoningBlocks } from "./thread/useThreadStreamState";
import { MODE_BADGE_STYLES } from "../../lib/chatModeState";
const ArtifactPanel = lazy(() => import("./ArtifactPanel").then((m) => ({ default: m.ArtifactPanel })));
import {
  RunTodoListCard,
  RunTodoSummaryButton,
  AutonomousRunsStrip,
} from "./RunTracker";
import {
  TASK_TIMELINE_STORAGE_PREFIX,
  RUN_STATUS_EVENT_START,
  resolveRunPhaseLabel,
  summarizeFailureSeries,
  recordRecoveryAction,
  classifyErrorKind,
  type RunSummaryState,
} from "./runTrackerConstants";
import { formatDiagnosticsClipboard } from "../../lib/diagnosticsClipboard";
import { AssistantActionBar, extractMessageText as _extractMessageText } from "./AssistantActionBar";
import { InterruptDialogGuard } from "./InterruptDialogGuard";
import { ErrorBoundary } from "../common/ErrorBoundary";
import {
  ActionBarPrimitive,
  AssistantIf,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useMessage,
  useThread,
  useMessagePartReasoning,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { useLangGraphSend } from "@assistant-ui/react-langgraph";
import {
  ArrowDownIcon,
  BarChart,
  BookOpen,
  Brain,
  Bug,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CodeIcon,
  CopyIcon,
  Download,
  ExternalLinkIcon,
  Eye,
  FileTextIcon,
  PencilIcon,
  QuoteIcon,
  RefreshCwIcon,
  Loader2Icon,
  LoaderIcon,
  CheckCircleIcon,
  Search,
  Send,
  WrenchIcon,
  ThumbsUpIcon,
  ThumbsDownIcon,
  MoreHorizontal,
  Star,
  Share2,
  Sparkles,
} from "lucide-react";
import { toolStreamEventBus, getStepsForThread, type ExecutionStep } from "../../lib/events/toolStreamEvents";
import { fileEventBus } from "../../lib/events/fileEvents";
import { subscribeAutonomousScheduleEvent } from "../../lib/events/autonomousScheduleEvent";
import { toast } from "sonner";
import { EVENTS } from "../../lib/constants";
import { t } from "../../lib/i18n";
import {
  analyzeVisionImage,
  type VisionAnalyzeResult,
} from "../../lib/api/systemApi";
import { getApiBase, validServerThreadIdOrUndefined } from "../../lib/api/langserveChat";
import { getItem as getStorageItem, setItem as setStorageItem, removeItem as removeStorageItem } from "../../lib/safeStorage";
import { useSessionContext } from "../../lib/contexts/SessionContext";
import { useShallow } from "zustand/react/shallow";
import { useTaskStore } from "../../store/taskStore";
import { readRunSummary, writeRunSummary, writeThreadHealthEntry, normalizeRunSummaryDetail } from "../../lib/runSummaryState";
import { getCurrentThreadIdFromStorage, getCurrentWorkspacePathFromStorage } from "../../lib/sessionState";
import { rolesApi } from "../../lib/api/rolesApi";
import { boardApi, type BoardTask } from "../../lib/api/boardApi";
import { personaApi } from "../../lib/api/personaApi";

/** 线程加载失败时展示错误条 + 重试，由 MyRuntimeProvider 提供 */
export const ThreadLoadErrorContext = React.createContext<{ loadError: string | null; retry: () => void }>({
  loadError: null,
  retry: () => {},
});

/** Cursor 式步骤时间线：当前 run 的步骤列表，由 thread 订阅 steps_updated 写入 */
export const ExecutionStepsContext = React.createContext<ExecutionStep[]>([]);

function getLastAssistantMessageText(messages: readonly unknown[] | undefined): string {
  if (!messages || messages.length === 0) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; type?: string; content?: string | unknown[] } | null;
    if (!m) continue;
    if (m.role !== "assistant" && m.type !== "ai") continue;
    const c = m.content;
    if (typeof c === "string") return c.trim();
    if (Array.isArray(c)) {
      const text = c
        .map((p: unknown) => {
          const part = p as { content?: string; text?: string } | null;
          return typeof part?.content === "string" ? part.content : typeof part?.text === "string" ? part.text : "";
        })
        .join("");
      return text.trim();
    }
    break;
  }
  return "";
}

/** 是否已有 plan 工具结果（有则主入口用 PlanToolUI 确认执行，不显示 PlanExecuteBar 兜底） */
function threadHasPlanToolResult(messages: readonly unknown[] | undefined): boolean {
  if (!messages || messages.length === 0) return false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as { role?: string; type?: string; content?: unknown[] } | null;
    if (!m || (m.role !== "assistant" && m.type !== "ai")) continue;
    const c = m.content;
    if (!Array.isArray(c)) continue;
    for (const p of c) {
      const part = p as { type?: string; toolCall?: { name?: string }; toolName?: string; name?: string };
      if (part.type !== "tool-call") continue;
      const name = part.toolName ?? part.name ?? part.toolCall?.name;
      if (name === "plan_next_moves") return true;
    }
  }
  return false;
}

// Plan 模式：仅当最后一条助手消息为纯文本且无 plan 工具卡片时展示「以 Agent 模式执行此计划」兜底按钮（主入口为 PlanToolUI 确认执行）
const PlanExecuteBar: FC = memo(function PlanExecuteBar() {
  const messages = useThread((s) => (Array.isArray(s?.messages) ? s.messages : []));
  const isRunning = useThread((s) => (s as { status?: { type?: string } })?.status?.type === "running");
  const sendMessage = useLangGraphSend();
  const { chatMode: mode, setMode } = useSessionContext();
  const lastText = React.useMemo(() => getLastAssistantMessageText(messages), [messages]);
  const hasPlanCard = React.useMemo(() => threadHasPlanToolResult(messages), [messages]);
  const [executing, setExecuting] = React.useState(false);
  const timerRef = React.useRef<number | null>(null);
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);
  const handleExecute = useCallback(() => {
    if (!lastText) return;
    setExecuting(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    const content = `请按以下计划执行：\n\n${lastText}`;
    const run = () => {
      timerRef.current = null;
      setMode("agent");
      sendMessage([{ type: "human", content }], {}).catch((err) => {
        console.error("[PlanExecuteBar] send failed:", err);
        toast.error(t("thread.sendFailedRetry"));
      }).finally(() => {
        if (mountedRef.current) setExecuting(false);
      });
    };
    timerRef.current = window.setTimeout(run, 200);
  }, [lastText, setMode, sendMessage]);
  if (mode !== "plan" || !lastText || isRunning || hasPlanCard) return null;
  return (
    <div className="mx-auto w-full max-w-(--thread-max-width) px-4 py-1.5 space-y-0.5">
      {lastText.length > 200 && (
        <p className="text-[10px] text-muted-foreground/60 px-1">{t("thread.planExecuteHint")}</p>
      )}
      <button
        type="button"
        onClick={handleExecute}
        disabled={executing}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-all",
          executing ? "border-violet-500/40 bg-violet-500/10 text-violet-600" : "border-violet-500/40 bg-violet-500/10 text-violet-600 hover:bg-violet-500/20"
        )}
      >
        {executing ? <Loader2Icon className="size-3.5 animate-spin" /> : <WrenchIcon className="size-3.5" />}
        {executing ? t("thread.switchToAgent") : t("thread.executeAsAgent")}
      </button>
    </div>
  );
});

// ✅ 使用 Context 存储选择的模型，供 MyRuntimeProvider 使用
export const ModelContext = React.createContext<{
  selectedModel: string | null;
  setSelectedModel: (modelId: string) => void;
}>({
  selectedModel: null,
  setSelectedModel: () => {},
});

// localStorage key（与 model-selector.tsx 保持一致）
const MODEL_STORAGE_KEY = "maibot_selected_model";

// 聊天模式 / 本轮模式 Context 统一从 threadContexts 导入，避免与组件混合导出导致 Fast Refresh 失效
const TurnModeByMessageIdContext = React.createContext<Map<string, ChatMode> | null>(null);

/** 消息日期分隔线：messageId -> 日期文案（今天/昨天/M月D日） */
function getDateLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const other = new Date(d);
  other.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((today.getTime() - other.getTime()) / 86400000);
  if (diffDays === 0) return t("thread.dateToday");
  if (diffDays === 1) return t("thread.dateYesterday");
  return t("thread.dateShort", {
    month: d.getMonth() + 1,
    day: d.getDate(),
    monthShort: d.toLocaleDateString(undefined, { month: "short" }),
  });
}

export const DateDividerContext = React.createContext<Map<string, string>>(new Map());

/** 本消息依据 result 兜底：assistant messageId -> { toolCallId -> result }，从同 thread 的后续 tool 消息解析，与 Cursor 一致 */
export const ToolResultsByMessageIdContext = React.createContext<Map<string, Record<string, string>>>(new Map());

/** 工具卡「运行/再次执行」统一入口，供 PythonRunToolUI、ShellRunToolUI、GrepSearch 等调用 */
export const ToolActionContext = React.createContext<{
  runCode: (code: string) => Promise<void>;
  runShellAgain: (command: string) => Promise<void>;
  retryTool: (toolName: string, args: Record<string, unknown>) => Promise<void>;
}>({
  runCode: async () => {},
  runShellAgain: async () => {},
  retryTool: async () => {},
});

import { InterruptStateContext, type InterruptState, type InterruptStateContextValue } from "./InterruptStateContext";
export type { InterruptState, InterruptStateContextValue } from "./InterruptStateContext";
export { InterruptStateContext } from "./InterruptStateContext";

const INITIAL_RENDERED_MESSAGES = 80;
const LOAD_MORE_MESSAGES_STEP = 80;
const AUTO_LOAD_MORE_THRESHOLD_PX = 140;
const AUTO_LOAD_MORE_COOLDOWN_MS = 280;
const USER_SCROLL_INTENT_WINDOW_MS = 1200;

type ThreadMessageComponents = React.ComponentProps<typeof ThreadPrimitive.Messages>["components"];

const VIRTUAL_LIST_MESSAGE_THRESHOLD = 30;

/** 消息列表：消息数达到阈值时用虚拟列表，否则用普通列表以降低风险 */
const ThreadMessagesWithFallback: FC<{
  components: ThreadMessageComponents;
  resetKey?: string;
}> = memo(function ThreadMessagesWithFallback({ components, resetKey }) {
  const messageCount = useThread((s) => {
    const messages = (s as { messages?: readonly unknown[] }).messages;
    return Array.isArray(messages) ? messages.length : 0;
  });
  const useVirtual = messageCount >= VIRTUAL_LIST_MESSAGE_THRESHOLD;
  if (useVirtual) {
    return <ProgressiveThreadMessages components={components} resetKey={resetKey} />;
  }
  return <ThreadPrimitive.Messages components={components} />;
});

/** 虚拟化消息列表：仅渲染最近 N 条 + 上滑加载更早，用于长对话性能优化 */
const ProgressiveThreadMessages: FC<{
  components: ThreadMessageComponents;
  resetKey?: string;
}> = memo(function ProgressiveThreadMessages({ components, resetKey }) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const topSentinelRef = React.useRef<HTMLDivElement | null>(null);
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const viewportCleanupRef = React.useRef<(() => void) | null>(null);
  const pendingScrollAdjustRef = React.useRef<{ prevHeight: number; prevTop: number } | null>(null);
  const lastAutoLoadAtRef = React.useRef(0);
  const lastScrollTopRef = React.useRef<number | null>(null);
  const lastUserIntentAtRef = React.useRef(0);
  const messageCount = useThread((s) => {
    const messages = (s as { messages?: readonly unknown[] }).messages;
    return Array.isArray(messages) ? messages.length : 0;
  });
  const [visibleCount, setVisibleCount] = React.useState(INITIAL_RENDERED_MESSAGES);

  React.useEffect(() => {
    setVisibleCount(INITIAL_RENDERED_MESSAGES);
    pendingScrollAdjustRef.current = null;
    lastScrollTopRef.current = null;
    lastUserIntentAtRef.current = 0;
  }, [resetKey]);

  const startIndex = Math.max(0, messageCount - visibleCount);
  const hiddenCount = startIndex;
  const visibleLength = Math.max(0, messageCount - startIndex);

  const visibleIndexes = React.useMemo(
    () => Array.from({ length: visibleLength }, (_, i) => startIndex + i),
    [startIndex, visibleLength]
  );

  const expandVisibleRange = useCallback(
    (preserveViewportOffset: boolean) => {
      if (hiddenCount <= 0) return;
      const viewport = viewportRef.current;
      if (preserveViewportOffset && viewport) {
        pendingScrollAdjustRef.current = {
          prevHeight: viewport.scrollHeight,
          prevTop: viewport.scrollTop,
        };
      }
      setVisibleCount((prev) => Math.min(messageCount, prev + LOAD_MORE_MESSAGES_STEP));
    },
    [hiddenCount, messageCount]
  );

  React.useLayoutEffect(() => {
    const pending = pendingScrollAdjustRef.current;
    const viewport = viewportRef.current;
    if (!pending || !viewport) return;
    const heightDiff = viewport.scrollHeight - pending.prevHeight;
    if (heightDiff > 0) {
      viewport.scrollTop = viewport.scrollTop + heightDiff;
    }
    pendingScrollAdjustRef.current = null;
  }, [visibleCount]);

  React.useEffect(() => {
    let rafId: number | null = null;
    viewportCleanupRef.current?.();
    viewportCleanupRef.current = null;

    const attach = (el: HTMLDivElement) => {
      viewportRef.current = el;
      const pending = pendingScrollAdjustRef.current;
      if (pending) {
        const heightDiff = el.scrollHeight - pending.prevHeight;
        if (heightDiff > 0) el.scrollTop = el.scrollTop + heightDiff;
        pendingScrollAdjustRef.current = null;
      }
      const onScroll = () => {
        const currentTop = el.scrollTop;
        const prevTop = lastScrollTopRef.current ?? currentTop;
        lastScrollTopRef.current = currentTop;

        if (hiddenCount <= 0) return;
        const now = Date.now();
        if (now - lastUserIntentAtRef.current > USER_SCROLL_INTENT_WINDOW_MS) return;
        if (currentTop >= prevTop) return;
        if (el.scrollTop > AUTO_LOAD_MORE_THRESHOLD_PX) return;
        if (now - lastAutoLoadAtRef.current < AUTO_LOAD_MORE_COOLDOWN_MS) return;
        lastAutoLoadAtRef.current = now;
        expandVisibleRange(true);
      };
      const markUserIntent = () => {
        lastUserIntentAtRef.current = Date.now();
      };
      const markUserIntentByKey = (event: KeyboardEvent) => {
        const key = event.key;
        const target = event.target as HTMLElement | null;
        const isTypingTarget = !!target && (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable
        );
        if (isTypingTarget) return;
        const active = document.activeElement;
        const keyInScope = el.contains(active) || el.matches(":hover");
        if (!keyInScope) return;
        if (
          key === "ArrowUp" ||
          key === "PageUp" ||
          key === "Home" ||
          (key === " " && event.shiftKey)
        ) {
          lastUserIntentAtRef.current = Date.now();
        }
      };
      el.addEventListener("scroll", onScroll, { passive: true });
      el.addEventListener("wheel", markUserIntent, { passive: true });
      el.addEventListener("touchmove", markUserIntent, { passive: true });
      el.addEventListener("pointerdown", markUserIntent, { passive: true });
      window.addEventListener("keydown", markUserIntentByKey);

      const sentinel = topSentinelRef.current;
      let observerCleanup: (() => void) | null = null;
      if (sentinel && hiddenCount > 0) {
        const observer = new IntersectionObserver(
          (entries) => {
            const entry = entries[0];
            if (!entry?.isIntersecting) return;
            const now = Date.now();
            if (now - lastUserIntentAtRef.current > USER_SCROLL_INTENT_WINDOW_MS) return;
            if (now - lastAutoLoadAtRef.current < AUTO_LOAD_MORE_COOLDOWN_MS) return;
            lastAutoLoadAtRef.current = now;
            expandVisibleRange(true);
          },
          { root: el, threshold: 0.9 }
        );
        observer.observe(sentinel);
        observerCleanup = () => observer.disconnect();
      }

      return () => {
        viewportRef.current = null;
        observerCleanup?.();
        el.removeEventListener("scroll", onScroll);
        el.removeEventListener("wheel", markUserIntent);
        el.removeEventListener("touchmove", markUserIntent);
        el.removeEventListener("pointerdown", markUserIntent);
        window.removeEventListener("keydown", markUserIntentByKey);
      };
    };

    const run = (): (() => void) | null => {
      const root = rootRef.current;
      if (!root) return null;
      const viewport = root.closest(".aui-thread-viewport");
      if (viewport instanceof HTMLDivElement) return attach(viewport);
      return null;
    };

    const cleanup = run();
    if (cleanup) {
      viewportCleanupRef.current = cleanup;
      return () => {
        viewportCleanupRef.current?.();
        viewportCleanupRef.current = null;
      };
    }

    rafId = requestAnimationFrame(() => {
      rafId = null;
      const lateCleanup = run();
      if (lateCleanup) viewportCleanupRef.current = lateCleanup;
    });
    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
      viewportCleanupRef.current?.();
      viewportCleanupRef.current = null;
    };
  }, [hiddenCount, expandVisibleRange]);

  return (
    <div ref={rootRef}>
      <div ref={topSentinelRef} className="h-px w-full" aria-hidden="true" />
      {hiddenCount > 0 && (
        <div className="mx-auto mb-1.5 w-full max-w-(--thread-max-width) px-4 text-center">
          <span className="inline-flex rounded-md border border-border/40 bg-muted/20 px-2 py-1 text-[11px] text-muted-foreground">
            {t("thread.loadMoreMessagesHint", { count: hiddenCount })}
          </span>
          <button
            type="button"
            onClick={() => expandVisibleRange(true)}
            className="sr-only focus:not-sr-only mt-2 inline-flex rounded-md border border-border/50 bg-background px-2 py-1 text-xs text-foreground"
            aria-label={t("thread.loadMoreMessagesAria")}
          >
            {t("thread.loadMoreMessagesAria")}
          </button>
        </div>
      )}
      {visibleIndexes.map((index) => (
        <ThreadPrimitive.MessageByIndex key={`msg-${index}`} index={index} components={components} />
      ))}
    </div>
  );
});

const DevStreamMetricsBadge: FC = memo(function DevStreamMetricsBadge() {
  const isDev = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  const forceDebug = React.useMemo(() => {
    if (isDev) return true;
    const raw = String(getStorageItem("maibot_metrics_debug") || "").trim().toLowerCase();
    return raw === "1" || raw === "true" || raw === "on";
  }, [isDev]);
  const enabled = isDev || forceDebug;
  const [summary, setSummary] = React.useState<Record<string, unknown> | null>(null);
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    if (!enabled) return;
    const onSummary = (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      if (detail && typeof detail === "object") {
        setSummary(detail as Record<string, unknown>);
      }
    };
    window.addEventListener(EVENTS.UI_STREAM_METRICS_SUMMARY, onSummary as EventListener);
    return () => window.removeEventListener(EVENTS.UI_STREAM_METRICS_SUMMARY, onSummary as EventListener);
  }, [enabled]);

  if (!enabled || !summary) return null;
  const samples = Number(summary.samples || 0);
  const p50 = Number(summary.ttft_ms_p50 || 0);
  const p95 = Number(summary.ttft_ms_p95 || 0);
  const gapP50 = Number(summary.lmstudio_gap_overhead_ms_p50 || 0);
  const hitRate = Math.round(Number(summary.adaptive_hotpath_hit_rate || 0) * 100);

  return (
    <div className="pointer-events-none sticky top-2 z-40 ml-auto mr-3 w-fit">
      {!expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 shadow-sm backdrop-blur transition-colors hover:bg-amber-500/15"
          title={t("thread.expandDevMetrics")}
          aria-label={t("a11y.expandDevMetrics")}
        >
          <span className="size-1.5 rounded-full bg-amber-500" />
          <span>DEV</span>
          <span className="text-amber-800/80">n={samples}</span>
        </button>
      ) : (
        <div className="pointer-events-auto rounded-lg border border-amber-500/35 bg-amber-500/8 px-2 py-1 text-[11px] text-amber-700 shadow-sm backdrop-blur">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">DEV 指标</span>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="rounded px-1 text-[10px] text-amber-800/80 hover:bg-amber-500/15"
              title={t("thread.collapseDevMetrics")}
              aria-label={t("a11y.collapseDevMetrics")}
            >
              收起
            </button>
          </div>
          <div className="mt-0.5">
            n={samples} · TTFT p50/p95 {p50}/{p95}ms · gap p50 {gapP50}ms · adaptive {hitRate}%
          </div>
        </div>
      )}
    </div>
  );
});

type ThreadHintItem = {
  id: string;
  hint_key: string;
  message: string;
  thread_id?: string;
  task_id?: string;
  subject?: string;
  status?: string;
  created_at: number;
};

/** Cursor 一致：Footer 状态行/任务仅以 runtime 的 running 为准，与 Composer 按钮形态同源 */
function useRuntimeRunning(): boolean {
  return useThread((s) => (s as { status?: { type?: string } })?.status?.type === "running");
}

export const Thread: FC<{ connectionHealthy?: boolean }> = React.memo(function Thread({ connectionHealthy = true }) {
  const threadLoadErrorContext = React.useContext(ThreadLoadErrorContext);
  const threadMessages = useThread((s) => (Array.isArray(s?.messages) ? s.messages : []));
  /** 流式阶段工具结果即时推送（tool_result 事件），在 messages 合并前即可展示 */
  const [liveToolResultsByMessageId, setLiveToolResultsByMessageId] = React.useState<Map<string, Record<string, string>>>(() => new Map());
  /** 本消息依据 result 兜底：从同 thread 的 assistant 后紧跟的 tool 消息按 tool_call_id 填入；并合并 liveToolResultsByMessageId 供 evidenceItems 使用 */
  const toolResultsByMessageId = React.useMemo(() => {
    const map = new Map<string, Record<string, string>>();
    const list = Array.from(threadMessages ?? []) as Array<{ type?: string; role?: string; id?: string; toolCallId?: string; tool_call_id?: string; result?: unknown; content?: unknown }>;
    for (let i = 0; i < list.length; i++) {
      const msg = list[i];
      if (!msg?.id || (msg?.role !== "assistant" && msg?.type !== "ai")) continue;
      const record: Record<string, string> = {};
      for (let j = i + 1; j < list.length; j++) {
        const next = list[j];
        if (next?.role !== "tool" && next?.type !== "tool") break;
        const tid = next.toolCallId ?? next.tool_call_id;
        if (tid) {
          const r = next.result ?? next.content;
          record[tid] = typeof r === "string" ? r : (r != null ? String(r) : "");
        }
      }
      if (Object.keys(record).length) map.set(msg.id, record);
    }
    for (const [msgId, rec] of liveToolResultsByMessageId) {
      const existing = map.get(msgId) ?? {};
      for (const [tcId, val] of Object.entries(rec)) {
        if (val != null && val !== "" && (existing[tcId] == null || existing[tcId] === "")) existing[tcId] = val;
      }
      if (Object.keys(existing).length) map.set(msgId, existing);
    }
    return map;
  }, [threadMessages, liveToolResultsByMessageId]);
  const runtimeRunning = useRuntimeRunning();
  const [autonomousRuns, setAutonomousRuns] = React.useState<Array<{
    task_id?: string;
    subject?: string;
    slot?: string;
    triggered_at?: string;
    thread_id?: string;
    run_id?: string;
    matched_task_id?: string;
  }>>([]);
  const [taskPanelHints, setTaskPanelHints] = React.useState<ThreadHintItem[]>([]);
  const [taskPanelTimeline, setTaskPanelTimeline] = React.useState<ThreadHintItem[]>([]);
  const [runSummary, setRunSummary] = React.useState<RunSummaryState>({
    running: false,
    phaseLabel: "",
    activeTool: "",
    startedAt: null,
    elapsedSec: 0,
    lastError: "",
    recentFailures: [],
    lastUpdatedAt: 0,
  });
  /** 当前会话展示的任务列表（Cursor 风格 Todo），来自 TASK_PROGRESS；按会话独立，切换会话时从 todosByThreadIdRef 恢复 */
  const [currentRunTodos, setCurrentRunTodos] = React.useState<Array<{ id?: string; content: string; status: string }> | null>(null);
  /** 各会话遗留的 todo 列表，切换会话时恢复对应列表而非清空 */
  const todosByThreadIdRef = React.useRef<Record<string, Array<{ id?: string; content: string; status: string }>>>({});
  /** Cursor 式步骤时间线：当前 run 的步骤列表，供 Footer stripLabel 使用；消息体以思考块 + 工具卡片 + 正文为唯一时间线，不单独渲染步骤列表 */
  const [executionSteps, setExecutionSteps] = React.useState<ExecutionStep[]>(() =>
    getStepsForThread(getCurrentThreadIdFromStorage() || null)
  );
  /** HITL 中断状态单源：由 InterruptDialog 轮询写回，工具卡与 Footer 只读，避免双轮询 */
  const [interruptState, setInterruptState] = React.useState<InterruptState>({ hasInterrupt: false });
  /** Composer 排队消息：运行中用户再次输入并点击发送时入队，run 结束时自动 drain 队首并发送 */
  const [messageQueue, setMessageQueue] = React.useState<Array<{ content: string }>>([]);
  const messageQueueRef = React.useRef<Array<{ content: string }>>([]);
  messageQueueRef.current = messageQueue;
  /** 防止 runtimeRunning 与 task_running 两处 drain 重复发送同一条 */
  const drainInProgressRef = React.useRef(false);
  /** Cursor 式：任务列表与运行状态同一行时的展开状态，run 结束时重置 */
  const [todoExpanded, setTodoExpanded] = React.useState(false);
  /** 防御性：task_running 事件与 runtimeRunning 取 AND，避免 SDK 未及时清除 running 时空闲仍显示运行 */
  const [taskRunningFromEvent, setTaskRunningFromEvent] = React.useState<boolean | null>(null);
  const prevRunningRef = React.useRef(runSummary.running);
  const hintToastRef = React.useRef<Record<string, string>>({});
  /** 当前 run 内工具调用数，用于 stream_end 时结果汇总提示 */
  const runToolCountRef = React.useRef(0);
  /** 当前 run 内工具失败数（来自 tool_error），用于 lastRunSummary.errorCount */
  const runToolErrorCountRef = React.useRef(0);
  /** 当前 run 内涉及的文件路径（来自 tool_end.path），用于 lastRunSummary.filePaths */
  const runFilePathsRef = React.useRef<string[]>([]);
  /** 本轮结果汇总自动收起定时器（约 10s 后清除 lastRunSummary，避免 Footer 长期占位） */
  const lastRunSummaryClearTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // ✅ 从 localStorage 获取当前 Thread ID（用于 Token 统计）；声明必须在 activeThreadIdRef 之前，避免 TDZ
  const [activeThreadId, setActiveThreadId] = React.useState<string | undefined>(() => {
    return getCurrentThreadIdFromStorage() || undefined;
  });
  const activeThreadIdRef = React.useRef<string | undefined>(activeThreadId);
  /** 防止卸载后事件/定时器回调中 setState 导致崩溃（React 报错或白屏） */
  const mountedRef = React.useRef(true);
  const effectiveThreadId = activeThreadId ?? getCurrentThreadIdFromStorage() ?? "";
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (lastRunSummaryClearTimerRef.current) {
        clearTimeout(lastRunSummaryClearTimerRef.current);
        lastRunSummaryClearTimerRef.current = null;
      }
    };
  }, []);
  React.useEffect(() => {
    setInterruptState({ hasInterrupt: false });
    setRunSummary((prev) => (prev.lastRunSummary ? { ...prev, lastRunSummary: undefined } : prev));
    setMessageQueue([]);
    setTaskRunningFromEvent(null);
    setExecutionSteps(getStepsForThread(effectiveThreadId || null));
    setLiveToolResultsByMessageId(() => new Map());
    if (lastRunSummaryClearTimerRef.current) {
      clearTimeout(lastRunSummaryClearTimerRef.current);
      lastRunSummaryClearTimerRef.current = null;
    }
  }, [effectiveThreadId]);
  const lastRunSummaryFlushAtRef = React.useRef<number>(0);
  const RUN_SUMMARY_FLUSH_THROTTLE_MS = 1500;
  const [cloudConfirmPending, setCloudConfirmPending] = React.useState<{
    modelId: string;
    previewText: string;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const cloudConfirmPendingRef = React.useRef(cloudConfirmPending);
  cloudConfirmPendingRef.current = cloudConfirmPending;
  const cloudConfirmBlockRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    return () => {
      cloudConfirmPendingRef.current?.resolve(false);
    };
  }, []);
  React.useEffect(() => {
    if (cloudConfirmPending && cloudConfirmBlockRef.current) {
      cloudConfirmBlockRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [cloudConfirmPending]);
  React.useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  /** stream_end 已收到时置 true，用于立即隐藏运行条/Todo，不依赖 SDK 的 runtimeRunning 更新时机 */
  const [streamJustEnded, setStreamJustEnded] = React.useState(false);
  const streamJustEndedRef = React.useRef(false);
  React.useEffect(() => {
    streamJustEndedRef.current = streamJustEnded;
  }, [streamJustEnded]);
  React.useEffect(() => {
    const handler = (e: Event) => {
      if (!mountedRef.current) return;
      const detail = (e as CustomEvent<{ running?: boolean }>).detail;
      const running = detail?.running ?? false;
      setTaskRunningFromEvent(running);
      if (running) {
        streamJustEndedRef.current = false;
        setStreamJustEnded(false);
      } else {
        setTodoExpanded(false);
        streamJustEndedRef.current = true;
        setStreamJustEnded(true);
        /* 不清空 currentRunTodos：run 结束时从 ref 恢复当前会话的 todo 列表，使未运行时的可折叠任务列表正确展示 */
        const tid = activeThreadIdRef.current ?? getCurrentThreadIdFromStorage() ?? "";
        if (tid && todosByThreadIdRef.current[tid]?.length) {
          setCurrentRunTodos(todosByThreadIdRef.current[tid]);
        }
      }
    };
    window.addEventListener("task_running", handler);
    return () => window.removeEventListener("task_running", handler);
  }, []);

  // Run 正常结束时轻量提示 + 结果汇总（工具数、失败数、文件路径列表）
  React.useEffect(() => {
    const unsubStart = toolStreamEventBus.on("stream_start", () => {
      if (!mountedRef.current) return;
      runToolCountRef.current = 0;
      runToolErrorCountRef.current = 0;
      runFilePathsRef.current = [];
      setRunSummary((prev) => (prev.lastRunSummary ? { ...prev, lastRunSummary: undefined } : prev));
    });
    const unsubToolEnd = toolStreamEventBus.on("tool_end", (ev) => {
      runToolCountRef.current = (runToolCountRef.current || 0) + 1;
      const path = (ev as { path?: string }).path;
      if (path && typeof path === "string") {
        runFilePathsRef.current = [...runFilePathsRef.current, path];
      }
    });
    const unsubToolError = toolStreamEventBus.on("tool_error", () => {
      runToolErrorCountRef.current = (runToolErrorCountRef.current || 0) + 1;
    });
    const unsubEnd = toolStreamEventBus.on("stream_end", (ev) => {
      if (!mountedRef.current) return;
      if ((ev as { reason?: string }).reason === "complete") {
        const n = runToolCountRef.current || 0;
        const errCount = runToolErrorCountRef.current || 0;
        const filePaths = runFilePathsRef.current?.length ? [...runFilePathsRef.current] : [];
        const msg = n > 0
          ? (t("runTracker.roundCompleteWithTools", { count: String(n) }) || `本轮完成，共 ${n} 个工具`)
          : (t("runTracker.roundComplete") || "本轮完成");
        toast.success(msg, { duration: 2500 });
        if (lastRunSummaryClearTimerRef.current) clearTimeout(lastRunSummaryClearTimerRef.current);
        setRunSummary((prev) => ({
          ...prev,
          lastRunSummary: { toolCount: n, errorCount: errCount > 0 ? errCount : undefined, filePaths },
        }));
        lastRunSummaryClearTimerRef.current = setTimeout(() => {
          lastRunSummaryClearTimerRef.current = null;
          if (mountedRef.current) setRunSummary((prev) => (prev.lastRunSummary ? { ...prev, lastRunSummary: undefined } : prev));
        }, 10000);
      }
    });
    return () => {
      unsubStart();
      unsubToolEnd();
      unsubToolError();
      unsubEnd();
      if (lastRunSummaryClearTimerRef.current) {
        clearTimeout(lastRunSummaryClearTimerRef.current);
        lastRunSummaryClearTimerRef.current = null;
      }
    };
  }, []);

  // 步骤时间线：订阅 steps_updated，切换会话时从 getStepsForThread 恢复（与 Cursor 一致：steps/todos 按 threadId 绑定，无串线）
  React.useEffect(() => {
    const tid = activeThreadId ?? getCurrentThreadIdFromStorage() ?? null;
    const steps = getStepsForThread(tid);
    setExecutionSteps(steps);
    setRunSummary((prev) => {
      if (steps.length === 0) return { ...prev, stepSummary: undefined };
      const runningIdx = steps.findIndex((s) => s.status === "running");
      const current = runningIdx >= 0 ? runningIdx + 1 : steps.length;
      const label = steps[runningIdx >= 0 ? runningIdx : steps.length - 1]?.label ?? "";
      return { ...prev, stepSummary: { current, total: steps.length, label } };
    });
  }, [activeThreadId]);
  React.useEffect(() => {
    let rafId = 0;
    const unsub = toolStreamEventBus.on("steps_updated", (ev) => {
      if (!mountedRef.current) return;
      const threadId = (ev as { threadId?: string | null }).threadId;
      const steps = (ev as { steps?: ExecutionStep[] }).steps;
      if (threadId == null || steps == null || threadId !== (activeThreadIdRef.current ?? getCurrentThreadIdFromStorage() ?? "")) return;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (!mountedRef.current) return;
        const currentId = activeThreadIdRef.current ?? getCurrentThreadIdFromStorage() ?? "";
        if (threadId !== currentId) return;
        const latestSteps = getStepsForThread(currentId || null);
        setExecutionSteps(latestSteps);
        setRunSummary((prev) => {
          if (latestSteps.length === 0) return { ...prev, stepSummary: undefined };
          const runningIdx = latestSteps.findIndex((s) => s.status === "running");
          const current = runningIdx >= 0 ? runningIdx + 1 : latestSteps.length;
          const label = latestSteps[runningIdx >= 0 ? runningIdx : latestSteps.length - 1]?.label ?? "";
          return { ...prev, stepSummary: { current, total: latestSteps.length, label } };
        });
      });
    });
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      unsub();
    };
  }, []);

  // 切换会话时从存储恢复该会话的 runSummary，使任务栏按会话展示（单源：normalizeRunSummaryDetail + raw 扩展字段）
  React.useEffect(() => {
    const emptySummary = {
      running: false,
      phaseLabel: "",
      activeTool: "",
      startedAt: null,
      elapsedSec: 0,
      lastError: "",
      recentFailures: [],
      lastUpdatedAt: 0,
    };
    const effectiveThreadId = validServerThreadIdOrUndefined(activeThreadId ?? "");
    if (!effectiveThreadId) {
      setRunSummary(emptySummary);
      return;
    }
    const raw = readRunSummary(effectiveThreadId);
    const norm = normalizeRunSummaryDetail(raw && typeof raw === "object" ? raw : null);
    if (!norm) {
      setRunSummary(emptySummary);
      return;
    }
    const p = (raw || {}) as Record<string, unknown>;
    const threadIdStored = String(p.threadId || "").trim();
    if (threadIdStored && threadIdStored !== effectiveThreadId) {
      setRunSummary(emptySummary);
      return;
    }
    const stepSummaryRaw = p.stepSummary;
    const stepSummary =
      stepSummaryRaw &&
      typeof stepSummaryRaw === "object" &&
      "current" in stepSummaryRaw &&
      "total" in stepSummaryRaw
        ? {
            current: Number((stepSummaryRaw as Record<string, unknown>).current),
            total: Number((stepSummaryRaw as Record<string, unknown>).total),
            label: String((stepSummaryRaw as Record<string, unknown>).label ?? ""),
          }
        : undefined;
    setRunSummary({
      ...norm,
      startedAt: typeof p.startedAt === "number" ? p.startedAt : null,
      runId: p.runId != null ? String(p.runId) : undefined,
      lastUpdatedAt: Number(p.lastUpdatedAt) || 0,
      linkedStatus: p.linkedStatus != null ? String(p.linkedStatus) : undefined,
      recoveryPoint: (p.recoveryPoint as RunSummaryState["recoveryPoint"]) ?? undefined,
      recoveryMode: p.recoveryMode != null ? String(p.recoveryMode) : undefined,
      stepSummary,
    });
  }, [activeThreadId]);

  const activeTimelineStorageKey = React.useMemo(
    () => `${TASK_TIMELINE_STORAGE_PREFIX}${activeThreadId || "default"}`,
    [activeThreadId]
  );
  const prevTimelineKeyRef = React.useRef<string>("");

  React.useEffect(() => {
    hintToastRef.current = {};
  }, [activeThreadId]);

  // 监听 localStorage 变化（其他组件可能会更新 thread）
  React.useEffect(() => {
    const handleStorageChange = () => {
      if (!mountedRef.current) return;
      const newThreadId = getCurrentThreadIdFromStorage() || undefined;
      setActiveThreadId(newThreadId);
    };

    window.addEventListener('storage', handleStorageChange);
    // 也监听自定义事件（同一窗口内的变化）
    window.addEventListener(EVENTS.SESSION_CHANGED, handleStorageChange as EventListener);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener(EVENTS.SESSION_CHANGED, handleStorageChange as EventListener);
    };
  }, []);

  React.useEffect(() => {
    let rafId = 0;
    const pendingRef = { current: null as typeof ev0 | null };
    const ev0 = {} as { type?: string; run_id?: string; toolName?: string; tool?: string; result_preview?: string; ttft_ms?: number; stream_to_first_token_ms?: number; command?: string; error?: string; message?: string; phase?: string; subagent_type?: string; data?: { message?: string; phase?: string; ttft_ms?: number; stream_to_first_token_ms?: number } };
    const unsub = toolStreamEventBus.onAll((ev) => {
      const event = ev as typeof ev0;
      pendingRef.current = event;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (!mountedRef.current) return;
        const e = pendingRef.current;
        if (e == null) return;
        pendingRef.current = null;
        // Cursor 一致：仅当事件属于当前会话时更新 runSummary/streamJustEnded，避免切换会话后仍显示它会话的 run 状态
        const eventThreadId = (e as { threadId?: string }).threadId;
        const currentId = activeThreadIdRef.current ?? getCurrentThreadIdFromStorage() ?? "";
        if (eventThreadId != null && eventThreadId !== "" && eventThreadId !== currentId) return;
        const type = String(e.type || "");
        setRunSummary((prev) => {
          const now = Date.now();
          const next: RunSummaryState = { ...prev };
          const phaseLabel = resolveRunPhaseLabel(e, (k, p) => (p != null ? t(k, p) : t(k)));
          if (phaseLabel) next.phaseLabel = phaseLabel;
          if (e.toolName) next.activeTool = String(e.toolName);
          if (!next.activeTool && e.command && type.startsWith("shell_")) next.activeTool = "shell_run";
          if (type === "tool_result" && e.tool) {
            next.lastToolResult = { tool: String(e.tool), result_preview: String(e.result_preview ?? "").slice(0, 200) };
          }
          if (type === "execution_metrics") {
            const ttft = e.ttft_ms ?? (e.data as { ttft_ms?: number } | undefined)?.ttft_ms;
            const s2ft = e.stream_to_first_token_ms ?? (e.data as { stream_to_first_token_ms?: number } | undefined)?.stream_to_first_token_ms;
            if (typeof ttft === "number" && !Number.isNaN(ttft)) next.lastTtftMs = ttft;
            if (typeof s2ft === "number" && !Number.isNaN(s2ft)) next.lastStreamToFirstTokenMs = s2ft;
          }
          if (RUN_STATUS_EVENT_START.has(type)) {
            next.running = true;
            if (!next.startedAt) next.startedAt = now;
          }
          /* run 结束仅以 stream_end / stream_error 为准，不用 tool_end 等单步结束，避免中途把 running 置 false 导致 Todo/状态条闪烁或残留 */
          if (type === "stream_end" || type === "stream_error") {
            next.running = false;
            if (next.startedAt) next.elapsedSec = Math.max(next.elapsedSec, Math.floor((now - next.startedAt) / 1000));
          }
          if (type === "stream_start" || type === "tool_start") {
            next.lastError = "";
            next.startedAt = now;
            next.elapsedSec = 0;
          }
          if (type === "run_id" && e.run_id) next.runId = String(e.run_id);
          const err = String(e.error || e.message || "").trim();
          if ((type === "tool_error" || type === "stream_error" || type.endsWith("_error")) && err) {
            next.lastError = err;
            next.recentFailures = [err, ...(prev.recentFailures || [])].slice(0, 12);
          }
          next.lastUpdatedAt = now;
          return next;
        });
        if (type === "stream_start") {
          setTodoExpanded(false);
          streamJustEndedRef.current = false;
          setStreamJustEnded(false);
          /* 不清空 currentRunTodos：各会话按 ref 独立保留，新 run 的 write_todos 会覆盖 */
        }
        if (type === "stream_end" || type === "stream_error") {
          setTodoExpanded(false);
          streamJustEndedRef.current = true;
          setStreamJustEnded(true);
          setLiveToolResultsByMessageId(() => new Map());
          /* 不清空 currentRunTodos：run 结束后保留列表，未运行时可折叠展示 */
        }
      });
    });
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      unsub();
    };
  }, []);

  // runSummary.running 仅用于展示与历史错误，保持 prevRunningRef 同步供它处读取
  React.useEffect(() => {
    prevRunningRef.current = runSummary.running;
  }, [runSummary.running]);

  const prevRuntimeRunningRef = React.useRef(runtimeRunning);
  // Run 结束：running 由 true→false 时仅收起 Todo 展开状态，不清空 currentRunTodos（遗留任务保留供用户查看/下次继续）；未在运行且队列非空则 drain 队首并发送
  React.useEffect(() => {
    const wasRunning = prevRuntimeRunningRef.current;
    prevRuntimeRunningRef.current = runtimeRunning;
    if (wasRunning && !runtimeRunning) {
      setTodoExpanded(false);
    }
    if (!runtimeRunning && messageQueueRef.current.length > 0 && !drainInProgressRef.current) {
      const first = messageQueueRef.current[0];
      const send = sendMessageRef.current;
      if (send && first) {
        drainInProgressRef.current = true;
        send([{ type: "human", content: first.content }], {})
          .then(() => { if (mountedRef.current) setMessageQueue((prev) => (prev.length > 0 ? prev.slice(1) : prev)); })
          .catch(() => { if (mountedRef.current) toast.error(t("thread.queuedMessageSendFailed")); })
          .finally(() => { drainInProgressRef.current = false; });
      } else if (!send) {
        toast.error(t("thread.queuedMessageSendFailed"));
      }
    }
  }, [runtimeRunning, t]);

  // 双保险：task_running 已置 false 且队列非空时，短延迟后也 drain 一次（与 cursor_alignment_checklist 约定 300ms 一致）
  React.useEffect(() => {
    if (taskRunningFromEvent !== false || messageQueueRef.current.length === 0 || drainInProgressRef.current) return;
    const tId = window.setTimeout(() => {
      if (!mountedRef.current || messageQueueRef.current.length === 0 || drainInProgressRef.current) return;
      const first = messageQueueRef.current[0];
      const send = sendMessageRef.current;
      if (send && first) {
        drainInProgressRef.current = true;
        send([{ type: "human", content: first.content }], {})
          .then(() => { if (mountedRef.current) setMessageQueue((prev) => (prev.length > 0 ? prev.slice(1) : prev)); })
          .catch(() => { if (mountedRef.current) toast.error(t("thread.queuedMessageSendFailed")); })
          .finally(() => { drainInProgressRef.current = false; });
      }
    }, 300);
    return () => clearTimeout(tId);
  }, [taskRunningFromEvent, t]);

  React.useEffect(() => {
    if (!runSummary.lastUpdatedAt) return;
    const timeoutId = window.setTimeout(() => {
      if (!mountedRef.current) return;
      const now = Date.now();
      if (now - lastRunSummaryFlushAtRef.current < RUN_SUMMARY_FLUSH_THROTTLE_MS) return;
      lastRunSummaryFlushAtRef.current = now;
      const recoveryPriority = runSummary.running
        ? "waiting"
        : runSummary.lastError && runSummary.linkedTaskId
          ? "high"
          : runSummary.lastError
            ? "medium"
            : "low";
      const preview = runSummary.lastToolResult?.result_preview != null ? String(runSummary.lastToolResult.result_preview) : "";
      const statusText = runSummary.running
        ? `${runSummary.phaseLabel || t("thread.running")}${runSummary.activeTool ? ` · ${runSummary.activeTool}` : ""}${preview ? ` · ${t("thread.resultPrefix")}${preview.replace(/\n/g, " ").slice(0, 80)}${preview.length > 80 ? "…" : ""}` : ""}`
        : runSummary.lastError
          ? `${t("thread.failurePrefix")}${runSummary.lastError}`
          : runSummary.linkedTaskId
            ? `${t("thread.recentTask")}${runSummary.linkedSubject || t("thread.task")}`
            : t("thread.idle");
      const effectiveThreadId = activeThreadId || getCurrentThreadIdFromStorage() || "";
      const payload = {
        ...runSummary,
        threadId: effectiveThreadId,
        statusText,
        recoveryPriority,
        storageScope: "thread",
        todos: currentRunTodos ?? undefined,
      };
      try {
        writeRunSummary(payload as unknown as Record<string, unknown>, effectiveThreadId || undefined);
      } catch {
        // ignore storage errors
      }
      if (activeThreadId) {
        try {
          const failureCount = (runSummary.recentFailures || []).length;
          const nextEntry = {
            lastError: runSummary.lastError || "",
            recentFailures: summarizeFailureSeries(runSummary.recentFailures || []),
            failureCount,
            phaseLabel: runSummary.phaseLabel || "",
            updatedAt: Date.now(),
          };
          writeThreadHealthEntry(activeThreadId, nextEntry);
        } catch {
          // ignore health map write errors
        }
      }
      window.dispatchEvent(new CustomEvent(EVENTS.RUN_SUMMARY_UPDATED, { detail: payload }));
    }, 300);
    return () => window.clearTimeout(timeoutId);
  }, [runSummary, activeThreadId, currentRunTodos, t]);

  const prevActiveThreadIdRef = React.useRef<string | undefined>(activeThreadId);
  // 切换会话时按会话独立：把当前会话的 todo 写入 ref，再恢复目标会话的 todo，各会话互不串
  React.useEffect(() => {
    const prev = prevActiveThreadIdRef.current;
    if (prev != null && prev !== "" && prev !== activeThreadId && currentRunTodos && currentRunTodos.length > 0) {
      todosByThreadIdRef.current[prev] = currentRunTodos;
    }
    prevActiveThreadIdRef.current = activeThreadId;
    const nextTodos = (activeThreadId != null && activeThreadId !== "")
      ? (todosByThreadIdRef.current[activeThreadId] ?? null)
      : null;
    setCurrentRunTodos(nextTodos);
    setTodoExpanded(false);
  }, [activeThreadId]);

  const [viewportOpacity, setViewportOpacity] = React.useState(1);
  const prevThreadIdForTransitionRef = React.useRef<string | undefined>(activeThreadId);
  React.useEffect(() => {
    const prev = prevThreadIdForTransitionRef.current;
    const hasPrev = prev != null && prev !== "";
    const hasNext = activeThreadId != null && activeThreadId !== "";
    if (hasPrev && hasNext && prev !== activeThreadId) setViewportOpacity(0);
    prevThreadIdForTransitionRef.current = activeThreadId;
  }, [activeThreadId]);
  const mountedForTransitionRef = React.useRef(true);
  React.useEffect(() => {
    mountedForTransitionRef.current = true;
    return () => {
      mountedForTransitionRef.current = false;
    };
  }, []);
  React.useEffect(() => {
    if (viewportOpacity !== 0) return;
    const t = window.setTimeout(() => {
      if (!mountedForTransitionRef.current) return;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (mountedForTransitionRef.current) setViewportOpacity(1);
        });
      });
    }, 120);
    return () => window.clearTimeout(t);
  }, [viewportOpacity]);

  React.useEffect(() => {
    if (activeTimelineStorageKey !== prevTimelineKeyRef.current) {
      prevTimelineKeyRef.current = activeTimelineStorageKey;
      const raw = getStorageItem(activeTimelineStorageKey);
      if (!raw) {
        setTaskPanelTimeline([]);
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          setTaskPanelTimeline([]);
          return;
        }
        const next = parsed
          .filter((item): item is Record<string, unknown> => item != null && typeof item === "object")
          .map((item) => ({
            id: String(item.id ?? ""),
            hint_key: String(item.hint_key ?? ""),
            message: String(item.message ?? ""),
            thread_id: (item.thread_id != null && String(item.thread_id).trim()) ? String(item.thread_id) : undefined,
            task_id: (item.task_id != null && String(item.task_id).trim()) ? String(item.task_id) : undefined,
            subject: (item.subject != null && String(item.subject).trim()) ? String(item.subject) : undefined,
            status: (item.status != null && String(item.status).trim()) ? String(item.status) : undefined,
            created_at: Number(item.created_at) || 0,
          }))
          .filter((item) => item.id && item.message)
          .slice(0, 80);
        setTaskPanelTimeline(next);
      } catch {
        setTaskPanelTimeline([]);
      }
      return;
    }
    try {
      setStorageItem(activeTimelineStorageKey, JSON.stringify(taskPanelTimeline.slice(0, 80)));
    } catch {
      // ignore storage errors
    }
  }, [taskPanelTimeline, activeTimelineStorageKey]);

  // 文件创建/修改时在聊天中显示简短通知（path 空时仅类型提示，避免 "已创建：undefined"）
  React.useEffect(() => {
    const unsub = fileEventBus.subscribe((ev) => {
      const pathLabel = (ev.path && String(ev.path).trim()) || "";
      if (ev.type === "file_created") toast.success(pathLabel ? `已创建：${pathLabel}` : "已创建文件");
      if (ev.type === "file_modified") toast.info(pathLabel ? `已更新：${pathLabel}` : "已更新文件");
    });
    return unsub;
  }, []);

  // 任务面板 -> 聊天区联动提示（打开线程/自治触发）
  React.useEffect(() => {
    const onTaskPanelHint = (ev: Event) => {
      if (!mountedRef.current) return;
      const detail = (ev as CustomEvent<{
        message?: string;
        threadId?: string;
        taskId?: string;
        subject?: string;
        status?: string;
      }>).detail;
      const msg = String(detail?.message || "").trim();
      if (!msg) return;
      const hintKey =
        String(detail?.taskId || "").trim() ||
        String(detail?.threadId || "").trim() ||
        String(detail?.subject || "").trim() ||
        msg.slice(0, 48);
      const id = `${hintKey}|${Date.now()}`;
      const toastSig = `${String(detail?.status || "")}|${msg}`;
      setTaskPanelHints((prev) => {
        const deduped = prev.filter((x) => x.hint_key !== hintKey);
        const next = [
          {
            id,
            hint_key: hintKey,
            message: msg,
            thread_id: detail?.threadId,
            task_id: detail?.taskId,
            subject: detail?.subject,
            status: detail?.status,
            created_at: Date.now(),
          },
          ...deduped,
        ];
        return next.slice(0, 5);
      });
      setTaskPanelTimeline((prev) => {
        const deduped = prev.filter((x) => x.hint_key !== hintKey);
        const next = [
          {
            id,
            hint_key: hintKey,
            message: msg,
            thread_id: detail?.threadId,
            task_id: detail?.taskId,
            subject: detail?.subject,
            status: detail?.status,
            created_at: Date.now(),
          },
          ...deduped,
        ];
        return next.slice(0, 80);
      });
      setRunSummary((prev) => ({
        ...prev,
        linkedThreadId: detail?.threadId || prev.linkedThreadId,
        linkedTaskId: detail?.taskId || prev.linkedTaskId,
        linkedSubject: detail?.subject || prev.linkedSubject,
        linkedStatus: detail?.status || prev.linkedStatus,
        lastUpdatedAt: Date.now(),
      }));
      const refKey = `${activeThreadIdRef.current ?? "default"}:${hintKey}`;
      if (hintToastRef.current[refKey] !== toastSig) {
        hintToastRef.current[refKey] = toastSig;
        toast.info(msg);
      }
    };
    window.addEventListener(EVENTS.TASK_PANEL_THREAD_HINT, onTaskPanelHint as EventListener);
    return () => window.removeEventListener(EVENTS.TASK_PANEL_THREAD_HINT, onTaskPanelHint as EventListener);
  }, []);

  // TOOL_RESULT_FOR_UI：工具结果即时推送，在 messages 合并前即可在工具卡片中展示（解决「信息已到但未显示」）
  React.useEffect(() => {
    const onToolResultForUi = (ev: Event) => {
      if (!mountedRef.current) return;
      const detail = (ev as CustomEvent<{ threadId?: string; messageId?: string; tool_call_id?: string; result_preview?: string }>).detail;
      const currentId = activeThreadIdRef.current ?? getCurrentThreadIdFromStorage() ?? "";
      if (!detail?.threadId || detail.threadId !== currentId) return;
      const { messageId, tool_call_id, result_preview } = detail;
      if (!messageId || !tool_call_id || result_preview == null) return;
      setLiveToolResultsByMessageId((prev) => {
        const next = new Map(prev);
        const rec = next.get(messageId) ?? {};
        next.set(messageId, { ...rec, [tool_call_id]: result_preview });
        return next;
      });
    };
    window.addEventListener(EVENTS.TOOL_RESULT_FOR_UI, onToolResultForUi as EventListener);
    return () => window.removeEventListener(EVENTS.TOOL_RESULT_FOR_UI, onToolResultForUi as EventListener);
  }, []);

  // TASK_PROGRESS：后端推送完整 todo 列表；始终按 threadId 写入 ref，属当前会话时更新展示（含流结束后迟到的推送）
  React.useEffect(() => {
    const onTaskProgress = (ev: Event) => {
      if (!mountedRef.current) return;
      const detail = (ev as CustomEvent<{ threadId?: string; todos?: Array<{ id?: string; content?: string; status?: string }> | Record<string, { id?: string; content?: string; status?: string }> }>).detail;
      if (detail == null) return;
      const eventThreadId = detail.threadId;
      const raw = detail?.todos;
      const rawList = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? Object.values(raw) : []);
      if (rawList.length === 0) return;
      const list: Array<{ id?: string; content: string; status: string }> = [];
      for (const t of rawList) {
        if (!t || typeof t !== "object") continue;
        const content = String((t as { content?: string }).content ?? "").trim();
        const status = String((t as { status?: string }).status ?? "pending").toLowerCase();
        if (!content && status === "pending") continue;
        list.push({ id: (t as { id?: string }).id, content: content || "—", status: status || "pending" });
      }
      if (list.length === 0) return;
      const currentId = activeThreadIdRef.current ?? getCurrentThreadIdFromStorage() ?? "";
      const threadKey = (eventThreadId != null && eventThreadId !== "") ? eventThreadId : currentId;
      if (threadKey) todosByThreadIdRef.current[threadKey] = list;
      // 仅当事件明确属于其他会话时跳过更新展示；threadId 缺失时视为当前会话（与 MyRuntimeProvider 派发时必带 threadId 兼容）
      if (typeof eventThreadId === "string" && eventThreadId !== "" && eventThreadId !== currentId) return;
      setCurrentRunTodos(list);
    };
    window.addEventListener(EVENTS.TASK_PROGRESS, onTaskProgress as EventListener);
    return () => window.removeEventListener(EVENTS.TASK_PROGRESS, onTaskProgress as EventListener);
  }, [activeThreadId]);

  const hintExpiryAtRef = React.useRef<number>(0);
  const hintTimerRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (taskPanelHints.length === 0) return;
    const now = Date.now();
    const earliestExpiry = Math.min(...taskPanelHints.map((h) => h.created_at + 15000));
    const nextExpireIn = Math.max(100, earliestExpiry - now);
    if (hintExpiryAtRef.current > 0 && earliestExpiry >= hintExpiryAtRef.current) return;
    if (hintTimerRef.current) {
      window.clearTimeout(hintTimerRef.current);
      hintTimerRef.current = null;
    }
    hintExpiryAtRef.current = earliestExpiry;
    hintTimerRef.current = window.setTimeout(() => {
      hintExpiryAtRef.current = 0;
      hintTimerRef.current = null;
      if (!mountedRef.current) return;
      const tick = Date.now();
      setTaskPanelHints((prev) => prev.filter((h) => tick - h.created_at <= 15000));
    }, nextExpireIn);
    return () => {
      if (hintTimerRef.current) {
        window.clearTimeout(hintTimerRef.current);
        hintTimerRef.current = null;
      }
      if (hintExpiryAtRef.current === earliestExpiry) hintExpiryAtRef.current = 0;
    };
  }, [taskPanelHints]);
  
  // ✅ 从 localStorage 初始化，确保与 ModelSelector 同步；占位符 __no_models__ 视为无效，用 null（运行时按 auto 处理）
  const [selectedModel, setSelectedModel] = React.useState<string | null>(() => {
    const v = getStorageItem(MODEL_STORAGE_KEY);
    if (v === '__no_models__') return null;
    return v || null;
  });

  // ✅ 同步 ModelSelector 选择到会话状态，避免 MyRuntimeProvider 的 ref 被陈旧 context 覆盖导致发送错误模型
  React.useEffect(() => {
    const handler = (e: Event) => {
      if (!mountedRef.current) return;
      const d = (e as CustomEvent<{ modelId?: string }>).detail;
      if (d?.modelId != null && typeof d.modelId === 'string') setSelectedModel(d.modelId);
    };
    window.addEventListener('model_changed', handler);
    return () => window.removeEventListener('model_changed', handler);
  }, []);

  // 聊天模式：统一来自 SessionContext（会话键 > 全局键，跨窗口一致）
  const { chatMode, setMode } = useSessionContext();

  const handleModeChange = useCallback((mode: ChatMode) => {
    setMode(mode);
  }, [setMode]);

  // ✅ 处理上下文项变化 - 通过事件传递给 MyRuntimeProvider；仅在实际变化时派发，避免与 Composer 形成循环
  const lastContextItemsRef = React.useRef<Array<{ id: string; path?: string; status?: string }>>([]);
  const handleContextChange = useCallback((contextItems: Array<{
    id: string;
    type: "file" | "folder" | "code" | "url" | "image";
    name: string;
    path?: string;
    content?: string;
    status?: string;
  }>) => {
    const prev = lastContextItemsRef.current;
    const same = prev.length === contextItems.length && contextItems.every(
      (c, i) => prev[i] && prev[i].id === c.id && prev[i].path === c.path && (prev[i] as { status?: string }).status === c.status
    );
    if (same) return;
    lastContextItemsRef.current = contextItems.map((c) => ({ id: c.id, path: c.path, status: c.status }));
    window.dispatchEvent(new CustomEvent(EVENTS.CONTEXT_ITEMS_CHANGED, { detail: { contextItems } }));
  }, []);

  const sendMessage = useLangGraphSend();
  const sendMessageRef = React.useRef(sendMessage);
  sendMessageRef.current = sendMessage;
  const setModeRef = React.useRef(setMode);
  setModeRef.current = setMode;

  /** 立即执行队列第一条：未运行时发送队首，仅发送成功后再从队列移除（与 Cursor/Cowork 一致，避免发送失败丢消息） */
  const sendFirstInQueue = useCallback(() => {
    if (runtimeRunning) {
      toast.info(t("thread.sendFirstInQueueDisabled"));
      return;
    }
    const current = messageQueueRef.current;
    if (!current.length) return;
    const first = current[0];
    const send = sendMessageRef.current;
    if (!send) {
      toast.error(t("thread.queuedMessageSendFailed"));
      return;
    }
    send([{ type: "human", content: first.content }], {})
      .then(() => {
        if (mountedRef.current) setMessageQueue((q) => (q.length > 0 ? q.slice(1) : q));
      })
      .catch(() => {
        if (mountedRef.current) toast.error(t("thread.queuedMessageSendFailed"));
      });
  }, [runtimeRunning, t]);

  const runCode = useCallback(
    async (code: string) => {
      await sendMessage(
        [{ type: "human", content: `请运行以下代码，并返回执行结果与风险提示：\n${JSON.stringify({ code }, null, 2)}` }],
        {}
      );
      toast.success(t("thread.sentToAssistant"));
    },
    [sendMessage]
  );
  const runShellAgain = useCallback(
    async (command: string) => {
      await sendMessage([{ type: "human", content: `请再次执行以下命令：\n${command}` }], {});
      toast.success(t("thread.sentToAssistant"));
    },
    [sendMessage]
  );
  const retryTool = useCallback(
    async (toolName: string, args: Record<string, unknown>) => {
      const content = `请用相同参数再次执行以下工具，仅返回执行结果，不要重复解释。\n工具：${toolName}\n参数：${JSON.stringify(args ?? {}, null, 2)}`;
      await sendMessage([{ type: "human", content }], {});
      toast.success(t("toolCard.retryRequestSent"));
    },
    [sendMessage]
  );
  const toolActionValue = React.useMemo(
    () => ({ runCode, runShellAgain, retryTool }),
    [runCode, runShellAgain, retryTool]
  );

  const planConfirmedCancelledRef = React.useRef(false);
  React.useEffect(() => {
    planConfirmedCancelledRef.current = false;
    const handlePlanConfirmed = (e: CustomEvent<{ message?: string; goal?: string; steps?: Array<{ id?: number; description?: string }>; threadId?: string; planConfirmed?: boolean; shouldSwitchToAgent?: boolean }>) => {
      const { message, goal, steps, threadId: eventThreadId, planConfirmed, shouldSwitchToAgent } = e.detail || {};
      const activeThreadId = getCurrentThreadIdFromStorage();
      const threadId = String(eventThreadId || activeThreadId || '').trim();
      if (eventThreadId && activeThreadId && eventThreadId !== activeThreadId) {
        return;
      }
      const shouldConsumePlanConfirm = Boolean(planConfirmed) || Boolean(goal) || (Array.isArray(steps) && steps.length > 0);
      const clearPlanConfirmedFlag = () => {
        if (!shouldConsumePlanConfirm) return;
        try {
          const validTid = validServerThreadIdOrUndefined(threadId);
          if (validTid) removeStorageItem(`maibot_plan_confirmed_thread_${validTid}`);
          window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
        } catch {
          // ignore
        }
      };
      const parts: string[] = [message || t("thread.confirmExecutePlan")];
      if (goal) parts.push(`\n\n【计划目标】${goal}`);
      if (Array.isArray(steps) && steps.length > 0) {
        parts.push("\n【执行步骤】");
        steps.forEach((s, i) => parts.push(`${i + 1}. ${s.description ?? ""}`));
      }
      // 先切到 agent 再发送，使后端路由进入 deepagent_execute 而非 deepagent_plan
      if (shouldSwitchToAgent) setModeRef.current?.("agent");
      const send = sendMessageRef.current;
      if (!send) {
        toast.error(t("thread.planConfirmFailed"));
        return;
      }
      send([{ type: "human", content: parts.join("\n") }], {})
        .then(() => {
          if (!mountedRef.current || planConfirmedCancelledRef.current) return;
          clearPlanConfirmedFlag();
          if (shouldSwitchToAgent) setModeRef.current?.("agent");
        })
        .catch((err) => {
          if (mountedRef.current && !planConfirmedCancelledRef.current) {
            console.error("[Thread] plan_confirmed 发送失败:", err);
            toast.error(t("thread.planConfirmFailed"));
          }
        });
    };
    window.addEventListener(EVENTS.PLAN_CONFIRMED, handlePlanConfirmed as EventListener);
    return () => {
      planConfirmedCancelledRef.current = true;
      window.removeEventListener(EVENTS.PLAN_CONFIRMED, handlePlanConfirmed as EventListener);
    };
  }, []);

  React.useEffect(() => {
    const handleFollowupMessage = (e: CustomEvent<{ message?: string; threadId?: string }>) => {
      const eventThreadId = String(e.detail?.threadId || "").trim();
      const activeThreadId = getCurrentThreadIdFromStorage();
      if (eventThreadId && activeThreadId && eventThreadId !== activeThreadId) {
        // 线程不匹配时忽略，避免跨线程发送普通跟进消息
        return;
      }
      const text = String(e.detail?.message || "").trim();
      if (!text) return;
      const send = sendMessageRef.current;
      if (!send) {
        toast.error(t("thread.followFailed"));
        return;
      }
      send([{ type: "human", content: text }], {}).catch((err) => {
        console.error("[Thread] followup_message 发送失败:", err);
        if (mountedRef.current) toast.error(t("thread.followFailed"));
      });
    };
    window.addEventListener(EVENTS.FOLLOWUP_MESSAGE, handleFollowupMessage as EventListener);
    return () => window.removeEventListener(EVENTS.FOLLOWUP_MESSAGE, handleFollowupMessage as EventListener);
  }, []);

  React.useEffect(() => {
    const handlePlanEditRequest = (e: CustomEvent<{ goal?: string; steps?: Array<{ id?: number; description?: string }>; threadId?: string }>) => {
      const { goal, steps } = e.detail || {};
      const eventThreadId = String(e.detail?.threadId || "").trim();
      const activeThreadId = getCurrentThreadIdFromStorage();
      if (eventThreadId && activeThreadId && eventThreadId !== activeThreadId) {
        return;
      }
      const parts: string[] = [t("thread.editPlanPrompt")];
      if (goal) parts.push(`\n【目标】${goal}`);
      if (Array.isArray(steps) && steps.length > 0) {
        parts.push("\n【步骤】");
        steps.forEach((s, i) => {
          parts.push(`\n${i + 1}. ${s.description ?? ""}`);
        });
      }
      const send = sendMessageRef.current;
      if (!send) {
        toast.error(t("thread.planEditFailed"));
        return;
      }
      send([{ type: "human", content: parts.join("") }], {}).catch((err) => {
        console.error("[Thread] plan_edit_request 发送失败:", err);
        if (mountedRef.current) toast.error(t("thread.planEditFailed"));
      });
    };
    window.addEventListener(EVENTS.PLAN_EDIT_REQUEST, handlePlanEditRequest as EventListener);
    return () => window.removeEventListener(EVENTS.PLAN_EDIT_REQUEST, handlePlanEditRequest as EventListener);
  }, []);

  React.useEffect(() => {
    const handlePlanRevert = (e: CustomEvent<{ message?: string; threadId?: string }>) => {
      const eventThreadId = String(e.detail?.threadId || "").trim();
      const activeThreadId = getCurrentThreadIdFromStorage();
      if (eventThreadId && activeThreadId && eventThreadId !== activeThreadId) {
        return;
      }
      const text = e.detail?.message ?? t("thread.cancelPlan");
      const send = sendMessageRef.current;
      if (!send) {
        toast.error(t("thread.planRevertFailed"));
        return;
      }
      send([{ type: "human", content: text }], {}).catch((err) => {
        console.error("[Thread] plan_revert_request 发送失败:", err);
        if (mountedRef.current) toast.error(t("thread.planRevertFailed"));
      });
    };
    window.addEventListener(EVENTS.PLAN_REVERT_REQUEST, handlePlanRevert as EventListener);
    return () => window.removeEventListener(EVENTS.PLAN_REVERT_REQUEST, handlePlanRevert as EventListener);
  }, []);

  React.useEffect(() => {
    const unsub = subscribeAutonomousScheduleEvent(({ run }) => {
      if (!mountedRef.current || !run) return;
      setAutonomousRuns((prev) => {
        const keyOf = (r: { thread_id?: string; triggered_at?: string; slot?: string }) => `${r.thread_id || ""}|${r.triggered_at || ""}|${r.slot || ""}`;
        const key = keyOf(run);
        const filtered = prev.filter((x) => keyOf(x) !== key);
        return [run, ...filtered].slice(0, 5);
      });
    });
    return unsub;
  }, []);

  React.useEffect(() => {
    const onFocusMessage = (ev: Event) => {
      const detail = (ev as CustomEvent<{ messageId?: string }>).detail;
      const messageId = String(detail?.messageId || "").trim();
      if (!messageId) return;
      const encoded = (typeof CSS !== "undefined" && CSS.escape) ? CSS.escape(messageId) : messageId.replace(/"/g, '\\"');
      const target = document.querySelector(`[data-message-id="${encoded}"]`);
      if (target instanceof HTMLElement) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    };
    window.addEventListener(EVENTS.MESSAGE_FOCUS_REQUEST, onFocusMessage);
    return () => window.removeEventListener(EVENTS.MESSAGE_FOCUS_REQUEST, onFocusMessage);
  }, []);

  React.useEffect(() => {
    const handler = (e: Event) => {
      if (!mountedRef.current) return;
      const d = (e as CustomEvent<{ modelId: string; previewText: string; resolve: (ok: boolean) => void; threadId?: string }>).detail;
      if (!d?.resolve) return;
      const currentId = activeThreadIdRef.current ?? getCurrentThreadIdFromStorage() ?? "";
      if (d.threadId != null && d.threadId !== currentId) return;
      setCloudConfirmPending({ modelId: d.modelId, previewText: d.previewText, resolve: d.resolve });
    };
    window.addEventListener(EVENTS.CONFIRM_CLOUD_MODEL, handler);
    return () => window.removeEventListener(EVENTS.CONFIRM_CLOUD_MODEL, handler);
  }, []);

  const modelContextValue = useMemo(
    () => ({ selectedModel, setSelectedModel }),
    [selectedModel]
  );
  const chatModeContextValue = useMemo(
    () => ({ mode: chatMode, setMode }),
    [chatMode, setMode]
  );
  const _turnModeRef = useRef<{ map: Map<string, ChatMode>; len: number; mode: ChatMode }>({ map: new Map(), len: 0, mode: chatMode });
  const turnModeByMessageId = useMemo(() => {
    const prev = _turnModeRef.current;
    if (!Array.isArray(threadMessages)) {
      return prev.len === 0 ? prev.map : new Map<string, ChatMode>();
    }
    const msgs = threadMessages as Array<{ id?: string; type?: string; additional_kwargs?: { mode?: string } }>;
    if (msgs.length === prev.len && chatMode === prev.mode) return prev.map;
    const canIncrement = msgs.length >= prev.len && chatMode === prev.mode;
    if (canIncrement && prev.len > 0) {
      const map = new Map(prev.map);
      let currentMode = prev.mode;
      if (prev.len > 0) {
        const lastId = msgs[prev.len - 1]?.id;
        if (lastId) currentMode = map.get(lastId) || chatMode;
      }
      for (let i = prev.len; i < msgs.length; i++) {
        const msg = msgs[i];
        const nextMode = msg?.type === "human" ? msg?.additional_kwargs?.mode : undefined;
        if (nextMode === "agent" || nextMode === "plan" || nextMode === "ask" || nextMode === "debug" || nextMode === "review") {
          currentMode = nextMode;
        }
        if (msg?.id) map.set(msg.id, currentMode);
      }
      return map;
    }
    const map = new Map<string, ChatMode>();
    let currentMode: ChatMode = chatMode;
    for (const msg of msgs) {
      const nextMode = msg?.type === "human" ? msg?.additional_kwargs?.mode : undefined;
      if (nextMode === "agent" || nextMode === "plan" || nextMode === "ask" || nextMode === "debug" || nextMode === "review") {
        currentMode = nextMode;
      }
      if (msg?.id) map.set(msg.id, currentMode);
    }
    return map;
  }, [threadMessages, chatMode]);
  useEffect(() => {
    const len = Array.isArray(threadMessages) ? threadMessages.length : 0;
    _turnModeRef.current = { map: turnModeByMessageId, len, mode: chatMode };
  }, [threadMessages, chatMode, turnModeByMessageId]);
  const threadRootStyle = useMemo(
    () => ({ ["--thread-max-width" as string]: "100%", ["--font-size" as string]: "14px" }),
    []
  );
  const viewportStyle = useMemo(
    () => ({
      scrollbarWidth: "thin" as const,
      scrollbarColor: "hsl(var(--muted-foreground) / 0.25) transparent",
      WebkitOverflowScrolling: "touch" as const,
      transition: "opacity 0.06s ease-out",
    }),
    []
  );
  const threadMessageComponents = useMemo<ThreadMessageComponents>(
    () => ({
      UserMessage,
      EditComposer,
      AssistantMessage,
      ToolMessage: AssistantMessage,
    }),
    []
  );

  const dateDividerMap = useMemo(() => {
    const map = new Map<string, string>();
    const list = (threadMessages as unknown) as Array<{ id?: string; createdAt?: number | Date; timestamp?: number }> | undefined;
    if (!Array.isArray(list) || list.length === 0) return map;
    let prevDateKey: string | null = null;
    for (const msg of list) {
      const raw = msg?.createdAt ?? msg?.timestamp;
      if (raw == null) continue;
      const ms = typeof raw === "number" ? raw : (raw instanceof Date ? raw : new Date(raw)).getTime();
      if (Number.isNaN(ms)) continue;
      const label = getDateLabel(ms);
      const dateKey = label;
      if (dateKey !== prevDateKey && msg.id) {
        map.set(msg.id, label);
        prevDateKey = dateKey;
      }
    }
    return map;
  }, [threadMessages]);
  const handleOpenThread = useCallback((threadId: string) => {
    window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_TO_THREAD, { detail: { threadId } }));
  }, []);
  const handleOpenTask = useCallback((taskId: string, subject: string, focusSection?: "result") => {
    window.dispatchEvent(new CustomEvent(EVENTS.OPEN_TASK_IN_EDITOR, { detail: { taskId, subject, focusSection } }));
    window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_LEFT_PANEL, { detail: { tab: "tasks" as const } }));
  }, []);
  const handleRunRetry = useCallback(() => {
    const onlyRetryFailed =
      "仅重试失败或未完成的步骤，不要重复已成功步骤；若任务曾 report_blocked，请针对阻塞原因补齐后继续。";
    const recoveryPrompt = runSummary.lastError
      ? `请从恢复点继续上一轮任务，并优先修复该错误：${runSummary.lastError}\n\n${onlyRetryFailed}`
      : `请优先从恢复点继续上一轮任务并补齐未完成步骤。\n\n${onlyRetryFailed}`;
    const message =
      runSummary.linkedTaskId
        ? `[task_id: ${runSummary.linkedTaskId}]\n${recoveryPrompt}`
        : recoveryPrompt;
    recordRecoveryAction("retry", "run_summary");
    window.dispatchEvent(new CustomEvent(EVENTS.FOLLOWUP_MESSAGE, { detail: { message, threadId: activeThreadId } }));
  }, [runSummary.lastError, runSummary.linkedTaskId, activeThreadId]);
  const handleRunAskDiagnose = useCallback(() => {
    const prompt = `请先诊断上一轮失败根因，再给出可执行重试方案：\n${runSummary.lastError || "（无错误详情）"}`;
    setMode("ask");
    recordRecoveryAction("ask_diagnose", "run_summary");
    window.dispatchEvent(new CustomEvent(EVENTS.FOLLOWUP_MESSAGE, { detail: { message: prompt, threadId: activeThreadId } }));
  }, [runSummary.lastError, activeThreadId, setMode]);
  const handleRetryRunSummary = useCallback(() => {
    const effectiveThreadId = validServerThreadIdOrUndefined(activeThreadId ?? "");
    if (!effectiveThreadId) return;
    const raw = readRunSummary(effectiveThreadId);
    const norm = normalizeRunSummaryDetail(raw && typeof raw === "object" ? raw : null);
    if (!norm) {
      setRunSummary((prev) => ({ ...prev, lastUpdatedAt: 0 }));
      return;
    }
    const p = (raw || {}) as Record<string, unknown>;
    const threadIdStored = String(p.threadId || "").trim();
    if (threadIdStored && threadIdStored !== effectiveThreadId) return;
    setRunSummary({
      ...norm,
      startedAt: typeof p.startedAt === "number" ? p.startedAt : null,
      runId: p.runId != null ? String(p.runId) : undefined,
      lastUpdatedAt: Number(p.lastUpdatedAt) || 0,
      linkedStatus: p.linkedStatus != null ? String(p.linkedStatus) : undefined,
      recoveryPoint: (p.recoveryPoint as RunSummaryState["recoveryPoint"]) ?? undefined,
      recoveryMode: p.recoveryMode != null ? String(p.recoveryMode) : undefined,
    });
  }, [activeThreadId]);

  const handleCopyDiagnostics = useCallback(() => {
    const text = formatDiagnosticsClipboard({
      threadId: activeThreadId || runSummary.linkedThreadId,
      runId: runSummary.runId,
      taskId: runSummary.linkedTaskId,
      lastError: runSummary.lastError,
      recentFailures: summarizeFailureSeries(runSummary.recentFailures || []),
      mode: chatMode,
      workspacePath: getCurrentWorkspacePathFromStorage() || undefined,
      phaseLabel: runSummary.phaseLabel,
      activeTool: runSummary.activeTool,
      elapsedSec: runSummary.elapsedSec,
    });
    recordRecoveryAction("copy_diagnostics", "run_summary");
    navigator.clipboard.writeText(text).then(() => toast.success(t("runTracker.diagnosticsCopied"))).catch(() => toast.error(t("runTracker.diagnosticsCopyFailed")));
  }, [activeThreadId, runSummary, chatMode]);

  const deferredExecutionSteps = React.useDeferredValue(executionSteps);

  return (
    <ModelContext.Provider value={modelContextValue}>
    <ChatModeContext.Provider value={chatModeContextValue}>
    <TurnModeByMessageIdContext.Provider value={turnModeByMessageId}>
    <DateDividerContext.Provider value={dateDividerMap}>
    <ToolResultsByMessageIdContext.Provider value={toolResultsByMessageId}>
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root @container relative flex h-full flex-col bg-background font-sans antialiased"
      style={threadRootStyle}
    >
      <ExecutionStepsContext.Provider value={deferredExecutionSteps}>
      <ToolActionContext.Provider value={toolActionValue}>
      {/* 注册专业工具 UI 组件 */}
      <ReadFileToolUI />
      <BatchReadFilesToolUI />
      <WriteFileToolUI />
      <EditFileToolUI />
      <WriteFileBinaryToolUI />
      <AnalyzeDocumentToolUI />
      <CodeExecutionToolUI />
      <PythonRunToolUI />
      <ShellRunToolUI />
      <SearchToolUI />
      <GrepSearchToolUI />
      <FileSearchToolUI />
      <WebSearchToolUI />
      <ThinkToolUI />
      <PlanToolUI />
      <ExtendedThinkingToolUI />
      <TaskToolUI />
      <WriteTodosToolUI />
      <RecordResultToolUI />
      <ReportTaskResultToolUI />
      <RecordFailureToolUI />
      <AskUserToolUI />
      <GetLibrariesToolUI />
      <SearchKnowledgeToolUI />
      <KnowledgeGraphToolUI />
      <ExtractEntitiesToolUI />
      <QueryKGToolUI />
      <GetLearningStatsToolUI />
      <CriticReviewToolUI />
      <ShellRunUI />
      <DevStreamMetricsBadge />
      <InterruptStateContext.Provider value={{ state: interruptState, setState: setInterruptState }}>
      <div className="flex flex-1 min-h-0 min-w-0 flex-row">
      <ThreadPrimitive.Viewport
        turnAnchor="bottom"
        className="aui-thread-viewport relative flex flex-1 min-w-0 flex-col overflow-x-hidden overflow-y-auto pt-1.5 min-h-0 transition-opacity duration-200 ease-out"
        style={{ ...viewportStyle, opacity: viewportOpacity }}
      >
        {threadLoadErrorContext.loadError ? (
          <div
            className="shrink-0 flex items-center justify-between gap-2 mx-4 mb-1.5 px-2.5 py-1.5 rounded-lg border border-destructive/30 bg-destructive/5 text-sm text-destructive"
            role="alert"
            aria-live="polite"
          >
            <span>{t("thread.messagesLoadErrorWithDetail", { message: t("thread.messagesLoadError"), detail: threadLoadErrorContext.loadError })}</span>
            <Button type="button" variant="outline" size="sm" onClick={threadLoadErrorContext.retry} aria-label={t("common.retry")}>
              <RefreshCwIcon className="size-3.5 mr-1" />
              {t("common.retry")}
            </Button>
          </div>
        ) : null}
        <AssistantIf condition={({ thread }) => thread.isEmpty}>
          <ThreadWelcomeInline />
        </AssistantIf>
        {taskPanelHints.length > 0 && (
          <TaskPanelHintStrip
            hints={taskPanelHints}
            timeline={taskPanelTimeline}
            onOpenThread={handleOpenThread}
            onOpenTask={handleOpenTask}
          />
        )}
        {autonomousRuns.length > 0 && (
          <AutonomousRunsStrip
            runs={autonomousRuns}
            onOpenThread={handleOpenThread}
            onOpenTask={handleOpenTask}
          />
        )}

        <ErrorBoundary
          fallback={
            <div className="mx-auto w-full max-w-(--thread-max-width) px-4 py-2 text-xs text-destructive">
              消息列表渲染异常，已自动隔离。请刷新或新建对话继续。
            </div>
          }
        >
          <ThreadMessagesWithFallback
            components={threadMessageComponents}
            resetKey={activeThreadId ?? getCurrentThreadIdFromStorage() ?? ""}
          />
        </ErrorBoundary>

        <PlanExecuteBar />

        {/* 整体视觉与信息层次（Cursor 式）：消息区 px/mx、正文字号/行高、Footer 条件见 cursor_alignment_checklist §2.1–2.3，不改双源与 drain 逻辑 */}
        <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer sticky bottom-0 mx-auto mt-auto flex w-full max-w-(--thread-max-width) flex-col overflow-visible bg-background px-3 pb-1.5 pt-0.5">
          <ThreadScrollToBottom />
          {/* Cursor 式：中断在聊天区内联展示（human_checkpoint / plan_confirmation / input_required） */}
          <InterruptDialogGuard
            threadId={activeThreadId ?? getCurrentThreadIdFromStorage() ?? ""}
            variant="inline"
            onResolved={(result) => {
              if (result?.run_id) {
                window.dispatchEvent(
                  new CustomEvent(EVENTS.INTERRUPT_RESOLVED, {
                    detail: { threadId: activeThreadId ?? getCurrentThreadIdFromStorage() ?? "", run_id: result.run_id },
                  })
                );
              }
            }}
          />
          {/* 云端模型确认：聊天区内联可交互确认块（非弹窗），出现时自动滚动到可见区域 */}
          {cloudConfirmPending && (
            <div ref={cloudConfirmBlockRef} className="w-full mb-2 rounded-lg border border-border shadow-lg bg-blue-500/5 dark:bg-blue-500/10 p-4 flex flex-col gap-3">
              <h3 className="font-medium text-blue-600 dark:text-blue-400 text-sm">{t("cloudConfirm.inlineTitle")}</h3>
              <p className="text-sm text-muted-foreground">{t("cloudConfirm.inlineDesc", { modelId: cloudConfirmPending.modelId })}</p>
              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    cloudConfirmPending.resolve(false);
                    setCloudConfirmPending(null);
                  }}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    cloudConfirmPending.resolve(true);
                    setCloudConfirmPending(null);
                  }}
                >
                  {t("common.confirm")}
                </Button>
              </div>
            </div>
          )}
          {/* Cursor 一致：run 开始即显示状态行；runtime + task_running 取 AND；无 steps 时显示 phaseLabel 或「执行中」 */}
          <div className="rounded-lg border border-border/50 bg-muted/5 shadow-sm overflow-hidden flex flex-col min-w-0">
            {(() => {
              const hasTodos = Boolean(currentRunTodos?.length);
              const hasSteps = Array.isArray(executionSteps) && executionSteps.length > 0;
              /* Cursor 一致：run 结束即不再 showRunStrip；streamJustEnded 或 task_running false 后立即隐藏，不依赖 SDK 的 runtimeRunning */
              const showRunStrip = !streamJustEnded && runtimeRunning && taskRunningFromEvent !== false && (hasSteps || hasTodos || runSummary.running);
              const stripLabel = hasSteps
                ? (() => {
                    const steps = executionSteps;
                    const runningIdx = steps.findIndex((s) => s?.status === "running");
                    const current = runningIdx >= 0 ? runningIdx + 1 : steps.length;
                    const currentStep = steps[runningIdx >= 0 ? runningIdx : steps.length - 1];
                    const stage = currentStep?.label ?? "";
                    const isThinkingStep = currentStep?.id === "thinking" || stage === "思考";
                    if (isThinkingStep) return runSummary.phaseLabel?.trim() || t("status.running");
                    return t("thread.stepStrip.stepLabel", { current: String(current), total: String(steps.length), stage });
                  })()
                : (runSummary.phaseLabel?.trim() || t("status.running"));
              /* Footer 步骤条仅作「当前步骤/运行中」提示，不重复消息内叙事（消息体以思考块+工具卡+正文为唯一时间线） */
              return showRunStrip ? (
              <div className="flex items-center justify-between gap-2 border-b border-border/20 px-2 py-0.5 min-h-6 bg-transparent transition-opacity duration-200" role="status" aria-live="polite" aria-label={stripLabel}>
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0">
                  <LoaderIcon className="size-3 shrink-0 animate-spin text-violet-500" aria-hidden />
                  <span className="truncate">
                    {stripLabel}
                  </span>
                </div>
                {/* Todo = LLM 的计划（write_todos），与消息内工具卡/正文同属一条 run，不重复展示计划 */}
                {hasTodos && (
                  <RunTodoSummaryButton
                    todos={currentRunTodos!}
                    expanded={todoExpanded}
                    onToggle={() => setTodoExpanded((e) => !e)}
                  />
                )}
              </div>
              ) : null;
            })()}
            {runtimeRunning && taskRunningFromEvent !== false && currentRunTodos && currentRunTodos.length > 0 && (
              <div className="grid transition-[grid-template-rows] duration-200 ease-out overflow-hidden" style={{ gridTemplateRows: todoExpanded ? "1fr" : "0fr" }}>
                <div className="min-h-0">
                  <RunTodoListCard todos={currentRunTodos} isRunning={true} onlyList />
                </div>
              </div>
            )}
            {/* 未在运行但有遗留 todo 时展示可折叠任务列表，用户可看到未完成任务并下次继续 */}
            {(!runtimeRunning || taskRunningFromEvent === false) && currentRunTodos && currentRunTodos.length > 0 && (
              <div className="border-t border-border/20 px-2 py-1 min-w-0">
                <RunTodoListCard
                  todos={currentRunTodos}
                  isRunning={false}
                  variant="nested"
                  expanded={todoExpanded}
                  onExpandToggle={() => setTodoExpanded((e) => !e)}
                />
              </div>
            )}
            {messageQueue.length > 0 && (
              <div
                className="flex items-center gap-2 px-3 py-1.5 border-b border-border/30 min-h-8 text-[11px] text-muted-foreground bg-muted/20 select-none"
                role="status"
                aria-live="polite"
                aria-label={t("thread.queueStrip", { count: messageQueue.length })}
                tabIndex={-1}
              >
                <span className="shrink-0 font-medium text-foreground/80">{t("thread.queueStrip", { count: messageQueue.length })}</span>
                <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto scrollbar-thin">
                  {messageQueue.slice(0, 5).map((item, i) => {
                    const raw = item.content.replace(/\s+/g, " ").trim();
                    const preview = raw.slice(0, 28) || t("thread.queuePreviewEmpty");
                    const showEllipsis = raw.length > 28;
                    return (
                      <span key={i} className="shrink-0 truncate max-w-[160px] px-2 py-0.5 rounded-md bg-muted/50 text-[10px] border border-border/40" title={item.content || undefined}>
                        {preview}{showEllipsis ? "…" : ""}
                      </span>
                    );
                  })}
                  {messageQueue.length > 5 && <span className="shrink-0 text-muted-foreground/80">+{messageQueue.length - 5}</span>}
                </div>
                <button
                  type="button"
                  onClick={sendFirstInQueue}
                  disabled={runtimeRunning}
                  className="shrink-0 px-2 py-1 text-[10px] font-medium rounded-md border border-border/50 bg-background hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed"
                  title={runtimeRunning ? t("thread.sendFirstInQueueDisabled") : t("thread.sendFirstInQueue")}
                >
                  {t("thread.sendFirstInQueue")}
                </button>
              </div>
            )}
            <CursorStyleComposer
              onModeChange={handleModeChange}
              onContextChange={handleContextChange}
              connectionHealthy={connectionHealthy}
              isStreaming={runtimeRunning}
              queueLength={messageQueue.length}
              onEnqueue={(content) => setMessageQueue((q) => [...q, { content }])}
              nestedInCard={true}
            />
          </div>
        </ThreadPrimitive.ViewportFooter>
    </ThreadPrimitive.Viewport>
    <ErrorBoundary fallback={null}>
      <Suspense fallback={null}>
        <ArtifactPanel />
      </Suspense>
    </ErrorBoundary>
      </div>
      </InterruptStateContext.Provider>
      </ToolActionContext.Provider>
      </ExecutionStepsContext.Provider>
    </ThreadPrimitive.Root>
    </ToolResultsByMessageIdContext.Provider>
    </DateDividerContext.Provider>
    </TurnModeByMessageIdContext.Provider>
    </ChatModeContext.Provider>
    </ModelContext.Provider>
  );
});

const TaskPanelHintStrip: FC<{
  hints: ThreadHintItem[];
  timeline: ThreadHintItem[];
  onOpenThread: (threadId: string) => void;
  onOpenTask: (taskId: string, subject: string, focusSection?: "result") => void;
}> = ({ hints, timeline, onOpenThread, onOpenTask }) => {
  const [timelineOpen, setTimelineOpen] = React.useState(false);
  const getStatusLabel = (status?: string) => {
    const s = String(status || "").toLowerCase();
    if (s === "completed") return t("thread.stepCompleted");
    if (s === "failed") return t("thread.stepFailed");
    if (s === "running") return t("thread.stepRunning");
    if (s === "claimed") return t("thread.stepClaimed");
    return s ? s : t("thread.stepInProgress");
  };
  const getStatusTone = (status?: string) => {
    const s = String(status || "").toLowerCase();
    if (s === "completed") {
      return {
        row: "border-emerald-500/30 bg-emerald-500/5",
        dot: "bg-emerald-500",
        badge: "text-emerald-600 border-emerald-500/30 bg-emerald-500/10",
      };
    }
    if (s === "failed") {
      return {
        row: "border-destructive/30 bg-destructive/5",
        dot: "bg-destructive",
        badge: "text-destructive border-destructive/30 bg-destructive/10",
      };
    }
    return {
      row: "border-primary/30 bg-primary/5",
      dot: "bg-primary",
      badge: "text-primary border-primary/30 bg-primary/10",
    };
  };
  const openHintPrimary = (h: {
    task_id?: string;
    thread_id?: string;
    subject?: string;
    status?: string;
  }) => {
    if (h.task_id) {
      onOpenTask(
        h.task_id,
        h.subject || t("thread.task"),
        String(h.status || "").toLowerCase() === "failed" ? "result" : undefined
      );
      return;
    }
    if (h.thread_id) {
      onOpenThread(h.thread_id);
    }
  };
  return (
    <div className="mx-auto mb-1.5 w-full max-w-(--thread-max-width) px-4">
      <div className="rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-1.5">
        <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="inline-block size-1.5 rounded-full bg-primary" />
            <span>{t("thread.taskLink")}</span>
            <span>·</span>
            <span>{t("thread.hintsCount", { n: hints.length })}</span>
          </div>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setTimelineOpen((v) => !v)}>
            {timelineOpen ? t("thread.collapseTimeline") : t("thread.historyCount", { n: timeline.length })}
          </Button>
        </div>
        {timelineOpen && (
          <div className="mb-1.5 max-h-44 overflow-auto rounded-md border border-border/45 bg-background/65 p-1.5">
            <div className="space-y-1">
              {timeline.length === 0 ? (
                <div className="px-1 py-1.5 text-[11px] text-muted-foreground/80 text-center space-y-1">
                  <p>{t("thread.noHistory")}</p>
                  <p className="text-[10px]">{t("thread.startConversation")}</p>
                  <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => window.dispatchEvent(new CustomEvent(EVENTS.FOCUS_COMPOSER))} aria-label={t("a11y.focusComposer")}>{t("thread.goToChat")}</Button>
                </div>
              ) : timeline.map((item) => (
                <button
                  key={`timeline-${item.id}`}
                  type="button"
                  className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-[11px] hover:bg-muted/45"
                  onClick={() => openHintPrimary(item)}
                >
                  <span className="min-w-0 truncate text-foreground/90">{item.message}</span>
                  <span className="shrink-0 text-muted-foreground/80">
                    {item.created_at ? new Date(item.created_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : t("common.timeUnknown")}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="space-y-1.5">
          {hints.map((h) => (
            (() => {
              const tone = getStatusTone(h.status);
              return (
            <div
              key={h.id}
              className={cn(
                "group flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-[11px]",
                tone.row
              )}
            >
              <div className="min-w-0 truncate text-muted-foreground flex items-center gap-1.5">
                <span className={cn("inline-block size-1.5 rounded-full shrink-0", tone.dot)} />
                <span className="text-foreground/90">{h.message}</span>
                <span className={cn("text-[11px] px-1 py-0.5 rounded border shrink-0", tone.badge)}>
                  {getStatusLabel(h.status)}
                </span>
              </div>
              <div className="shrink-0 flex items-center gap-1">
                {String(h.status || "").toLowerCase() === "failed" && (h.task_id || h.thread_id) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px] text-destructive border-destructive/30 hover:bg-destructive/10"
                    onClick={(e) => {
                      e.stopPropagation();
                      openHintPrimary(h);
                    }}
                  >
                    去排查
                  </Button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0 shrink-0 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100"
                      aria-label={t("thread.taskLinkAria")}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    {h.task_id ? (
                      <DropdownMenuItem
                        onClick={() =>
                          onOpenTask(
                            h.task_id!,
                            h.subject || t("thread.task"),
                            String(h.status || "").toLowerCase() === "failed" ? "result" : undefined
                          )
                        }
                      >
                        {t("thread.openTaskDetail")}
                      </DropdownMenuItem>
                    ) : null}
                    {h.thread_id ? (
                      <DropdownMenuItem onClick={() => onOpenThread(h.thread_id!)}>
                        {t("thread.backToThread")}
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
              );
            })()
          ))}
        </div>
      </div>
    </div>
  );
};

const ThreadScrollToBottom: FC = () => {
  const messageCount = useThread((s) => (s.messages?.length ?? 0) as number);
  const [countWhenAtBottom, setCountWhenAtBottom] = React.useState(messageCount);
  const badgeCount = Math.max(0, messageCount - countWhenAtBottom);
  React.useEffect(() => {
    if (messageCount < countWhenAtBottom) setCountWhenAtBottom(messageCount);
  }, [messageCount, countWhenAtBottom]);
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip={t("thread.backToBottom")}
        variant="outline"
        className="aui-thread-scroll-to-bottom absolute -top-12 z-10 self-center rounded-full p-2.5 transition-opacity duration-200 disabled:opacity-0 disabled:pointer-events-none dark:bg-background dark:hover:bg-accent"
        aria-label={t("a11y.backToBottom")}
        onClick={() => setCountWhenAtBottom(messageCount)}
      >
        <span className="relative inline-flex">
          <ArrowDownIcon />
          {badgeCount > 0 && (
            <span className="absolute -top-1 -right-1 h-4 min-w-4 flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-medium animate-in fade-in-0 zoom-in-95 duration-200">
              {badgeCount > 99 ? "99+" : badgeCount}
            </span>
          )}
        </span>
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

/** 与 Cursor 一致：消息内错误 inline、可展开详情、复制、重试/诊断；见 cursor_alignment_checklist.md 2.5 */
const MessageError: FC = () => {
  const [expanded, setExpanded] = React.useState(false);
  const { chatMode, setMode } = useSessionContext();
  const threadId = useThread((s) => (s as { threadId?: string; id?: string })?.threadId ?? (s as { threadId?: string; id?: string })?.id ?? "");
  const errorTextRaw = useMessage((s) => {
    const st = (s as unknown as { status?: { type?: string; reason?: string; error?: unknown } }).status;
    if (st?.type !== "incomplete" || st?.reason !== "error") return "";
    const err = st.error as { message?: string } | string | undefined;
    if (typeof err === "string") return err;
    if (err && typeof err === "object" && typeof err.message === "string") return err.message;
    return "";
  });
  const errorRequestId = useMessage((s) => {
    const st = (s as unknown as { status?: { type?: string; reason?: string; error?: unknown } }).status;
    if (st?.type !== "incomplete" || st?.reason !== "error") return undefined as string | undefined;
    const err = st.error as { request_id?: string } | undefined;
    if (err && typeof err === "object" && typeof err.request_id === "string") return err.request_id;
    return undefined;
  });
  const displayText = (errorTextRaw || "").trim();
  const recoveryHint = React.useMemo(() => {
    const lowered = displayText.toLowerCase();
    if (!lowered) return "";
    if (lowered.includes("network") || lowered.includes("fetch") || lowered.includes("timeout")) {
      return t("error.recoveryHint.network");
    }
    if (lowered.includes("permission") || lowered.includes("denied") || lowered.includes("forbidden")) {
      return t("error.recoveryHint.permission");
    }
    return t("error.recoveryHint.generic");
  }, [displayText, t]);
  const errorKind = React.useMemo(() => classifyErrorKind(displayText), [displayText]);
  const recoveryActionOrder = React.useMemo(() => {
    if (errorKind === "permission") return ["ask", "retry", "step"] as const;
    if (errorKind === "timeout") return ["step", "retry", "ask"] as const;
    if (errorKind === "network") return ["retry", "ask", "step"] as const;
    return ["retry", "ask", "step"] as const;
  }, [errorKind]);
  const handleAskDiagnosis = React.useCallback(() => {
    setMode("ask");
    recordRecoveryAction("ask_diagnose", "message_error");
    window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, {
      detail: {
        prompt: `请先诊断本轮失败根因，再给出重试方案：\n${displayText || "（无错误详情）"}`,
        threadId: threadId || undefined,
      },
    }));
  }, [displayText, threadId, setMode]);
  const handleRetryFailedStep = React.useCallback(() => {
    recordRecoveryAction("retry_failed_step", "message_error");
    window.dispatchEvent(new CustomEvent(EVENTS.FOLLOWUP_MESSAGE, {
      detail: {
        message: `请仅重试失败步骤，并说明修复策略：\n${displayText || "（无错误详情）"}`,
        threadId: threadId || undefined,
      },
    }));
  }, [displayText, threadId]);
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root
        className="aui-message-error-root mt-1.5 rounded-md border border-destructive bg-destructive/10 p-2.5 text-destructive text-sm dark:bg-destructive/5 dark:text-red-200"
        role="alert"
        aria-live="assertive"
      >
        {displayText ? (
          <div className="space-y-1">
            <p className={cn("aui-message-error-message whitespace-pre-wrap wrap-break-word", !expanded && "line-clamp-2")}>
              {displayText}
            </p>
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    className="text-[11px] underline underline-offset-2 hover:opacity-80"
                    aria-expanded={expanded}
                    aria-label={expanded ? t("error.collapseDetail") : t("error.expandDetail")}
                  >
                    {expanded ? t("error.collapseDetail") : t("error.expandDetail")}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>{expanded ? t("error.collapseDetail") : t("error.expandDetail")}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => {
                      const textToCopy = formatDiagnosticsClipboard({
                        threadId: threadId || undefined,
                        runId: errorRequestId,
                        lastError: displayText,
                        mode: chatMode,
                        workspacePath: getCurrentWorkspacePathFromStorage() || undefined,
                      });
                      navigator.clipboard.writeText(textToCopy).then(() => toast.success(t("runTracker.diagnosticsCopied"))).catch(() => toast.error(t("runTracker.diagnosticsCopyFailed")));
                    }}
                    className="text-[11px] underline underline-offset-2 hover:opacity-80"
                    aria-label={t("error.copyError")}
                  >
                    {t("error.copyError")}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>{t("error.copyError")}</TooltipContent>
              </Tooltip>
              {recoveryActionOrder.map((actionId) => {
                if (actionId === "retry") {
                  return (
                    <Tooltip key="retry">
                      <TooltipTrigger asChild>
                        <ActionBarPrimitive.Reload asChild>
                          <button
                            type="button"
                            className="text-[11px] underline underline-offset-2 hover:opacity-80"
                            aria-label={t("error.retryRegenerate")}
                          >
                            {t("error.retryRegenerate")}
                          </button>
                        </ActionBarPrimitive.Reload>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={4}>{t("error.retryRegenerate")}</TooltipContent>
                    </Tooltip>
                  );
                }
                if (actionId === "ask") {
                  return (
                    <Tooltip key="ask">
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={handleAskDiagnosis}
                          className="text-[11px] underline underline-offset-2 hover:opacity-80"
                          aria-label={t("runTracker.askDiagnose")}
                        >
                          {t("error.askDiagnoseRetry")}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={4}>{t("runTracker.askDiagnose")}</TooltipContent>
                    </Tooltip>
                  );
                }
                return (
                  <Tooltip key="step">
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={handleRetryFailedStep}
                        className="text-[11px] underline underline-offset-2 hover:opacity-80"
                        aria-label={t("error.retryStep")}
                      >
                        {t("error.retryStep")}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={4}>{t("error.retryStep")}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
            {recoveryHint && (
              <p className="text-[11px] text-destructive/80">{recoveryHint}</p>
            )}
            <p className="text-[11px] text-muted-foreground/90">{t("error.partialOutputHint")}</p>
          </div>
        ) : (
          <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
        )}
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

// ============================================================================
// Cursor 风格消息显示 - 高密度、无头像、无气泡
// ============================================================================
type MessageStatus = 'idle' | 'thinking' | 'streaming' | 'complete';

// 工具名到中文显示名的映射（用于状态栏）
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  read_file: "读取文件",
  write_file: "写入文件",
  edit_file: "编辑文件",
  list_directory: "列出目录",
  ls: "列出目录",
  glob_file_search: "查找文件",
  grep_search: "搜索",
  python_run: "Python",
  shell_run: "Shell",
  write_todos: "任务列表",
  task: "执行任务",
  search_knowledge: "知识库检索",
  think_tool: "思考",
  plan_next_moves: "规划",
  record_result: "记录结果",
  ask_user: "询问用户",
  delete_file: "删除文件",
};

/** Cursor 一致：思考块结束后保留展开一段时间供阅读，再自动折叠（单常量，InlineThinkingBlock / ReasoningBlock 共用） */
const REASONING_COLLAPSE_DELAY_MS = 8000;

// Cursor 风格思考内容折叠组件（兼容后端仅发 text 内 <think> 的情况）
const InlineThinkingBlock: FC<{ blocks: string[]; isThinking: boolean; tokenCount?: number }> = memo(function InlineThinkingBlock({ blocks, isThinking, tokenCount = 0 }) {
  const [isExpanded, setIsExpanded] = React.useState(() => isThinking);
  const [thinkingSeconds, setThinkingSeconds] = React.useState(0);
  const thinkingStartRef = React.useRef<number | null>(null);
  const userExpandedRef = React.useRef(false);
  const showTokenMeta = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);

  const combinedText = React.useMemo(() => blocks.join('\n\n'), [blocks]);
  const formattedText = React.useMemo(() => {
    if (!combinedText) return "";
    if (!/^\s*[\d\-*]/m.test(combinedText)) return combinedText;
    return combinedText.replace(
      /^(\s*(?:\d+[\.\)]|[-*])\s*)(.+)$/gm,
      (_m, p1, p2) => `${p1}${p2.trim()}`
    );
  }, [combinedText]);
  const collapseTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (isThinking) {
      if (collapseTimerRef.current) {
        clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
      userExpandedRef.current = false;
      setIsExpanded(true);
      if (thinkingStartRef.current == null) thinkingStartRef.current = Date.now();
      const timer = setInterval(() => {
        if (thinkingStartRef.current != null) {
          setThinkingSeconds(Math.max(1, Math.floor((Date.now() - thinkingStartRef.current) / 1000)));
        }
      }, 1000);
      return () => clearInterval(timer);
    }
    if (thinkingStartRef.current != null) {
      const finalSeconds = Math.max(1, Math.floor((Date.now() - thinkingStartRef.current) / 1000));
      setThinkingSeconds(finalSeconds);
      thinkingStartRef.current = null;
    }
    if (!userExpandedRef.current) {
      collapseTimerRef.current = setTimeout(() => {
        if (!userExpandedRef.current) setIsExpanded(false);
      }, REASONING_COLLAPSE_DELAY_MS);
    }
    userExpandedRef.current = false;
    return () => {
      if (collapseTimerRef.current) {
        clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
    };
  }, [isThinking]);

  if (blocks.length === 0 && !isThinking) return null;
  const canExpand = !isThinking && formattedText.length > 0;
  /** Cursor 一致：思考中且有流式内容时也展开内容区，实时展示 LLM 思考流 */
  const showContent = (canExpand && isExpanded) || (isThinking && formattedText.length > 0);

  const containerClass = "mb-1.5 rounded-r-lg border-l-2 border-muted-foreground/20 bg-muted/10 overflow-hidden";
  return (
    <div className={containerClass}>
      <button
        type="button"
        onClick={() => {
          if (!canExpand) return;
          userExpandedRef.current = true;
          setIsExpanded(!isExpanded);
        }}
        aria-label={isThinking ? t("status.thinkingEllipsis") : (isExpanded ? t("thread.reasoningLabel") : t("thread.reasoningDone"))}
        aria-expanded={canExpand ? isExpanded : undefined}
        className="w-full inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted/20 transition-colors text-left"
      >
        <span
          className={cn(
            "shrink-0 transition-transform duration-200 ease-out",
            canExpand ? "opacity-100" : "opacity-40",
            canExpand && isExpanded && "rotate-90"
          )}
        >
          <ChevronRightIcon className="size-3" />
        </span>
        {isThinking ? (
          <>
            <Loader2Icon className="size-3 animate-spin text-violet-500" />
            <span className="italic">{t("status.thinkingEllipsis")}</span>
            {thinkingSeconds > 0 && (
              <span className="text-[11px] text-muted-foreground/80 tabular-nums font-medium">· 已思考 {thinkingSeconds} 秒</span>
            )}
            {tokenCount > 0 && (
              <span className="text-[11px] text-muted-foreground/80 tabular-nums">· 约 {tokenCount} tokens</span>
            )}
          </>
        ) : (
          <span className="inline-flex items-center gap-1">
            <span className="text-[11px] rounded border border-muted-foreground/25 bg-muted/20 px-1 py-0.5 text-muted-foreground">
              {t("status.thinking")}
            </span>
            {isExpanded ? t("thread.reasoningLabel") : t("thread.reasoningDone")}
            {thinkingSeconds > 0 && <span className="text-[11px] text-muted-foreground/70"> · 已思考 {thinkingSeconds} 秒</span>}
            {tokenCount > 0 && <span className="text-[11px] text-muted-foreground/70"> · 约 {tokenCount} tokens</span>}
          </span>
        )}
      </button>

      <div className="grid transition-[grid-template-rows,opacity] duration-200 ease-out" style={{ gridTemplateRows: showContent ? "1fr" : "0fr" }}>
        <div className="overflow-hidden">
          <div className="px-2.5 pb-2 pt-0 pl-2.5 text-[12px] text-muted-foreground/90 leading-relaxed max-h-[320px] overflow-y-auto prose prose-sm dark:prose-invert max-w-none prose-p:leading-[1.65] prose-p:my-0.5 prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-foreground/90 prose-blockquote:border-l-primary prose-blockquote:bg-muted/20 prose-blockquote:py-0.5 prose-code:rounded prose-code:bg-muted/60 prose-code:px-1 prose-code:py-0.5 prose-code:text-[11px] [&_pre]:whitespace-pre-wrap [&_ul]:list-disc [&_ol]:list-decimal [&_li]:my-0.5">
            {showTokenMeta && tokenCount > 0 && (
              <div className="mb-1 text-[11px] text-muted-foreground/65 tabular-nums">约 {tokenCount} tokens</div>
            )}
            {formattedText ? (
              <ReactMarkdown
                remarkPlugins={[...remarkPluginsWithMath]} rehypePlugins={[...rehypePluginsMath]}
                components={{
                  pre: ({ children, ...props }) => {
                    const first = React.Children.toArray(children)[0];
                    const text = typeof first === "string" ? first : (React.isValidElement(first) && typeof (first as React.ReactElement<{ children?: unknown }>).props?.children === "string" ? (first as React.ReactElement<{ children: string }>).props.children : "");
                    return (
                      <div className="relative group">
                        {text && (
                          <button
                            type="button"
                            className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity rounded p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/50 text-[11px]"
                            onClick={() => {
                              navigator.clipboard.writeText(text).then(() => toast.success(t("common.copied"))).catch(() => toast.error(t("common.copyFailed")));
                            }}
                            aria-label={t("a11y.copyCode")}
                          >
                            <CopyIcon className="size-3.5" />
                          </button>
                        )}
                        <pre {...props}>{children}</pre>
                      </div>
                    );
                  },
                }}
              >
                {formattedText}
              </ReactMarkdown>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
});

// 原生 reasoning part 折叠块（assistant-ui Reasoning 类型），与 InlineThinkingBlock 统一 border-l 样式与折叠延迟
const ReasoningBlock: FC = memo(function ReasoningBlock() {
  const part = useMessagePartReasoning();
  const [isExpanded, setIsExpanded] = useState(false);
  const [thinkingSeconds, setThinkingSeconds] = useState(0);
  const thinkingStartRef = React.useRef<number | null>(null);
  const userToggledRef = React.useRef(false);
  const collapseTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRunning = part.status?.type === "running";
  const text = part.text || "";
  const preview = React.useMemo(() => text.slice(0, 60).replace(/\n/g, " "), [text]);

  React.useEffect(() => {
    if (isRunning) {
      if (collapseTimerRef.current) {
        clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
      userToggledRef.current = false;
      setIsExpanded(true);
      if (thinkingStartRef.current == null) thinkingStartRef.current = Date.now();
      const timer = setInterval(() => {
        if (thinkingStartRef.current != null) {
          setThinkingSeconds(Math.max(1, Math.floor((Date.now() - thinkingStartRef.current) / 1000)));
        }
      }, 1000);
      return () => clearInterval(timer);
    }
    if (thinkingStartRef.current != null) {
      setThinkingSeconds(Math.max(1, Math.floor((Date.now() - thinkingStartRef.current) / 1000)));
      thinkingStartRef.current = null;
    }
    if (!userToggledRef.current) {
      collapseTimerRef.current = setTimeout(() => {
        if (!userToggledRef.current) setIsExpanded(false);
      }, REASONING_COLLAPSE_DELAY_MS);
    }
    userToggledRef.current = false;
    return () => {
      if (collapseTimerRef.current) {
        clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
    };
  }, [isRunning]);

  const containerClass = "mb-1.5 rounded-r-lg border-l-2 border-muted-foreground/20 bg-muted/10 overflow-hidden";
  return (
    <div className={containerClass}>
      <button
        type="button"
        onClick={() => {
          userToggledRef.current = true;
          setIsExpanded((v) => !v);
        }}
        aria-expanded={isExpanded}
        aria-label={isRunning && !text ? t("status.thinkingEllipsis") : (isExpanded ? t("thread.reasoningLabel") : t("thread.reasoningDone"))}
        className="w-full inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted/20 transition-colors text-left"
      >
        <span className={cn("shrink-0 transition-transform duration-200 ease-out", isExpanded && "rotate-90")}>
          <ChevronRightIcon className="size-3" />
        </span>
        {isRunning && !text ? (
          <>
            <Loader2Icon className="size-3 animate-spin text-violet-500" aria-hidden />
            <span className="italic">{t("status.thinkingEllipsis")}</span>
            {thinkingSeconds > 0 && <span className="text-[11px] text-muted-foreground/60 tabular-nums">· 已思考 {thinkingSeconds} 秒</span>}
          </>
        ) : (
          <span>{isExpanded ? t("thread.reasoningLabel") : preview}{!isExpanded && text.length > 60 ? "…" : ""}{thinkingSeconds > 0 && !isRunning && <span className="text-[11px] text-muted-foreground/60"> · 已思考 {thinkingSeconds} 秒</span>}</span>
        )}
      </button>
      <div className="grid transition-[grid-template-rows,opacity] duration-200 ease-out" style={{ gridTemplateRows: isExpanded && text ? "1fr" : "0fr" }}>
        <div className="overflow-hidden">
          <div className="px-2.5 pb-2 pt-0 pl-2.5 text-[12px] text-muted-foreground/80 leading-relaxed max-h-[320px] overflow-y-auto prose prose-sm dark:prose-invert max-w-none prose-p:leading-[1.65] prose-p:my-0.5 prose-headings:font-semibold prose-headings:tracking-tight prose-blockquote:border-l-primary prose-blockquote:bg-muted/20 prose-code:rounded prose-code:bg-muted/60 prose-code:px-1 prose-code:py-0.5 [&_strong]:font-semibold [&_strong]:text-foreground [&_ul]:list-disc [&_ol]:list-decimal [&_li]:my-0.5 [&_pre]:whitespace-pre-wrap">
            {text ? (
              <ReactMarkdown remarkPlugins={[...remarkPluginsWithMath]} rehypePlugins={[...rehypePluginsMath]}>
                {text}
              </ReactMarkdown>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
});

// 连续 reasoning 分组容器，与 InlineThinkingBlock / ReasoningBlock 统一 border-l 样式
const ReasoningGroupBlock: FC<PropsWithChildren<{ startIndex: number; endIndex: number }>> = memo(function ReasoningGroupBlock({ startIndex, endIndex, children }) {
  const n = endIndex - startIndex + 1;
  const [isExpanded, setIsExpanded] = useState(false);
  const label = n > 1 ? t("thread.reasoningSteps", { n }) : t("thread.reasoningLabel");
  const containerClass = "mb-1.5 rounded-r-lg border-l-2 border-muted-foreground/20 bg-muted/10 overflow-hidden";
  return (
    <div className={containerClass} role="region" aria-label={label}>
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        aria-label={isExpanded ? t("thread.reasoningLabel") : label}
        className="w-full inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted/20 transition-colors text-left"
      >
        <span className={cn("shrink-0 transition-transform duration-200 ease-out", isExpanded && "rotate-90")}>
          <ChevronRightIcon className="size-3" />
        </span>
        <span>{label}</span>
      </button>
      <div className="grid transition-[grid-template-rows,opacity] duration-200 ease-out" style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}>
        <div className="overflow-hidden">
          <div className="px-2.5 pb-2 pt-0 pl-2.5 space-y-1">{children}</div>
        </div>
      </div>
    </div>
  );
});

/** 从步骤时间线或 part 信息取单步标题（Cursor 式：每步一行） */
function getStepLabelForPart(
  part: { toolCall?: { id?: string; name?: string }; [k: string]: unknown },
  executionSteps: ExecutionStep[]
): string {
  const tcId = part.toolCall?.id ?? (part as { tool_call_id?: string }).tool_call_id;
  if (tcId && executionSteps.length > 0) {
    const step = executionSteps.find((s) => s.tool_call_id === tcId || s.id === tcId);
    if (step?.label) return step.label;
  }
  const name = part.toolCall?.name ?? (part as { name?: string }).name ?? "";
  const keyInfo = getPartKeyInfo({ toolCall: { name }, args: (part as { args?: Record<string, unknown> }).args });
  const display = getToolDisplayName(name);
  return keyInfo ? `${display} · ${keyInfo}` : display;
}

// 工具调用分组：Cursor 式按 part 顺序逐条展示（每步一行标题 + 工具卡片），不再折叠 process
const ToolGroupBlock: FC<PropsWithChildren<{ startIndex: number; endIndex: number }>> = memo(function ToolGroupBlock({ startIndex, endIndex, children }) {
  const executionStepsFromContext = React.useContext(ExecutionStepsContext);
  const content = useMessage((s) => s.content);
  const parts = React.useMemo(() => Array.isArray(content) ? content.slice(startIndex, endIndex + 1) : [], [content, startIndex, endIndex]);
  const { visibleIndices, runningAskUserIndex } = React.useMemo(() => {
    const visible: number[] = [];
    let runningAskUser: number | null = null;
    parts.forEach((p, i) => {
      if (!p || (p as { type?: string }).type !== "tool-call") return;
      const name = (p as { toolCall?: { name?: string }; name?: string }).toolCall?.name ?? (p as { name?: string }).name ?? "";
      if (getToolTier(name) === "hidden") return;
      visible.push(i);
      if (name === "ask_user" && (p as { status?: { type?: string } }).status?.type === "running" && runningAskUser === null) {
        runningAskUser = i;
      }
    });
    return { visibleIndices: visible, runningAskUserIndex: runningAskUser };
  }, [parts]);
  const childrenArray = React.useMemo(() => React.Children.toArray(children), [children]);

  const { trailingEmptyCount, firstTrailingEmptyIndex } = React.useMemo(() => {
    let count = 0;
    for (let i = visibleIndices.length - 1; i >= 0; i--) {
      const localIdx = visibleIndices[i];
      const part = parts[localIdx] as { toolCall?: { name?: string }; name?: string; status?: { type?: string }; args?: Record<string, unknown>; result?: unknown } | undefined;
      const partName = part?.toolCall?.name ?? part?.name ?? "";
      const keyInfo = part ? getPartKeyInfo({ toolCall: { name: partName }, args: part.args }) : "";
      const hasResult = part?.result != null && (typeof part.result !== "string" || (part.result as string).trim().length > 0);
      const isRunning = (part?.status as { type?: string } | undefined)?.type === "running";
      if (!keyInfo && !hasResult && !isRunning) count++;
      else break;
    }
    const firstIndex = count > 0 ? visibleIndices[visibleIndices.length - count] : -1;
    return { trailingEmptyCount: count, firstTrailingEmptyIndex: firstIndex };
  }, [parts, visibleIndices]);

  if (visibleIndices.length === 0) return null;

  return (
    <div className="my-1 space-y-1.5" role="list">
      {visibleIndices.map((localIdx) => {
        const part = parts[localIdx] as { toolCall?: { id?: string; name?: string }; name?: string; status?: { type?: string }; args?: Record<string, unknown>; result?: unknown; [k: string]: unknown } | undefined;
        const label = part ? getStepLabelForPart(part, executionStepsFromContext) : "";
        const isRunningAsk = runningAskUserIndex === localIdx;
        const toolName = part?.toolCall?.name ?? part?.name ?? "";
        const keyInfo = part ? getPartKeyInfo({ toolCall: { name: toolName }, args: part.args }) : "";
        const hasResult = part?.result != null && (typeof part.result !== "string" || part.result.trim().length > 0);
        const isRunning = (part?.status as { type?: string } | undefined)?.type === "running";
        const isEmptyCard = !keyInfo && !hasResult && !isRunning;
        const isInTrailingRun = trailingEmptyCount >= 2 && localIdx >= firstTrailingEmptyIndex;
        const isMergeRow = isInTrailingRun && localIdx === firstTrailingEmptyIndex;
        if (isInTrailingRun && !isMergeRow) return null;
        if (isMergeRow) {
          const trailingIndices = visibleIndices.slice(visibleIndices.length - trailingEmptyCount);
          const names = trailingIndices.map((idx) => {
            const px = parts[idx] as { toolCall?: { name?: string }; name?: string };
            return getToolDisplayName(px?.toolCall?.name ?? px?.name ?? "");
          });
          const summary = names.length > 0 ? names.join("、") : "";
          const firstWithInfo = trailingIndices.find((idx) => {
            const p = parts[idx] as { toolCall?: { name?: string }; name?: string; args?: Record<string, unknown>; result?: unknown };
            const name = p?.toolCall?.name ?? p?.name ?? "";
            const ki = p ? getPartKeyInfo({ toolCall: { name }, args: p.args }) : "";
            return ki && ki.length > 0;
          });
          const detailSnippet = firstWithInfo != null
            ? (() => {
                const p0 = parts[firstWithInfo] as { toolCall?: { name?: string }; name?: string; args?: Record<string, unknown> };
                return getPartKeyInfo({ toolCall: { name: p0?.toolCall?.name ?? p0?.name ?? "" }, args: p0?.args });
              })()
            : "";
          const detailText = detailSnippet && detailSnippet.length > 60 ? `${detailSnippet.slice(0, 58)}…` : detailSnippet;
          return (
            <div key={`merged-${firstTrailingEmptyIndex}`} className="my-1 text-xs text-muted-foreground/70 flex flex-col gap-0.5">
              <div className="inline-flex items-center gap-1.5">
                <CheckIcon className="size-3 text-emerald-500/80 shrink-0" aria-hidden />
                <span>{t("thread.sourcesSummary.executedCount", { n: trailingEmptyCount, tools: summary })}</span>
              </div>
              {detailText ? <div className="pl-4.5 text-[11px] text-muted-foreground/60 truncate max-w-full" title={detailSnippet}>{detailText}</div> : null}
            </div>
          );
        }
        return (
          <div
            key={localIdx}
            className={cn(
              "space-y-0.5",
              isRunningAsk && "rounded-lg border border-primary/40 bg-primary/5 p-1.5"
            )}
            data-running-ask={isRunningAsk ? "true" : undefined}
          >
            {!isEmptyCard && (
              <div className="text-[11px] text-muted-foreground font-medium truncate" aria-hidden>
                {label}
              </div>
            )}
            {childrenArray[localIdx]}
          </div>
        );
      })}
    </div>
  );
});

/** 极简步骤条：过程只表节奏，单行展示思考·步骤1·…·回答（Cursor 式，支持真实步骤列表或三阶段回退） */
const MessageStepStrip: FC<{
  steps: Array<{ id: string; label: string }>;
  currentIndex: number;
}> = memo(function MessageStepStrip({ steps, currentIndex }) {
  if (steps.length === 0) return null;
  const total = steps.length;
  const current = Math.min(currentIndex, total - 1);
  const ariaLabel = t("thread.stepStrip.stepLabel", {
    current: String(current + 1),
    total: String(total),
    stage: steps[current]?.label ?? "",
  });
  return (
    <div
      className="mb-1 flex items-center gap-1 text-[11px] text-muted-foreground"
      role="progressbar"
      aria-valuenow={current + 1}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-label={ariaLabel}
    >
      {steps.map((s, i) => (
        <React.Fragment key={s.id}>
          {i > 0 && <span className="text-muted-foreground/50">·</span>}
          <span
            className={cn(
              "shrink-0",
              i < current && "text-muted-foreground/70",
              i === current && "font-medium text-foreground/90",
              i > current && "text-muted-foreground/50"
            )}
            aria-current={i === current ? "step" : undefined}
          >
            {i < current ? <CheckIcon className="size-3 inline-block mr-0.5 align-middle text-emerald-500" /> : null}
            {s.label}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
});

/** Cursor 式执行步骤时间线：竖向列表，每步状态图标 + label；无步骤不渲染，避免读屏读到空列表 */
const ExecutionStepTimeline: FC<{ steps: ExecutionStep[] }> = memo(function ExecutionStepTimeline({ steps }) {
  if (steps.length === 0) return null;
  const runningIdx = steps.findIndex((s) => s.status === "running");
  const current = runningIdx >= 0 ? runningIdx + 1 : steps.length;
  const stageLabel = steps[runningIdx >= 0 ? runningIdx : steps.length - 1]?.label ?? steps[0]?.label ?? "";
  return (
    <ul className="mb-1.5 space-y-0.5 text-[12px] text-muted-foreground" role="list" aria-label={t("thread.stepStrip.stepLabel", { current: String(current), total: String(steps.length), stage: stageLabel })}>
      {steps.map((s, i) => (
        <li key={s.id} className="flex items-center gap-2" aria-current={s.status === "running" ? "step" : undefined}>
          {s.status === "done" ? (
            <CheckIcon className="size-3 shrink-0 text-emerald-500" aria-hidden />
          ) : s.status === "running" ? (
            <LoaderIcon className="size-3 shrink-0 animate-spin text-violet-500" aria-hidden />
          ) : (
            <span className="size-3 shrink-0 rounded-full border border-muted-foreground/50" aria-hidden />
          )}
          <span className={cn("min-w-0 truncate", s.status === "running" && "font-medium text-foreground/90")}>{s.label}</span>
        </li>
      ))}
    </ul>
  );
});

/** 本消息依据：消息底部可折叠区，列出来源工具 + 关键参数 + 结果摘要 + 依据片段（Cursor 式详情）；每项可展开显示更长预览；支持 filePath/url 时展示「复制路径」「在编辑器中打开」 */
const MessageEvidenceSummary: FC<{
  items: Array<{ toolDisplayName: string; keyInfo: string; resultSummary: string | null; resultPreview?: string | null; resultPreviewLong?: string | null; filePath?: string | null; url?: string | null }>;
}> = memo(function MessageEvidenceSummary({ items }) {
  const [expanded, setExpanded] = useState(false);
  const [expandedItem, setExpandedItem] = useState<Set<number>>(new Set());
  if (items.length === 0) return null;
  const ariaLabel = t("thread.sourcesSummary.ariaExpand");
  const toggleItem = (i: number) => setExpandedItem((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => toast.success(t("common.copied"))).catch(() => toast.error(t("common.copyFailed")));
  };
  return (
    <div className="mt-1 rounded border border-border/40 bg-muted/5 overflow-hidden" role="region" aria-label={t("thread.sourcesSummary.title")}>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full inline-flex items-center gap-1.5 px-2 py-1 text-left text-[12px] text-muted-foreground min-w-0"
        aria-expanded={expanded}
        aria-label={ariaLabel}
      >
        {expanded ? <ChevronDownIcon className="size-3 shrink-0" /> : <ChevronRightIcon className="size-3 shrink-0" />}
        <span className="font-medium">{t("thread.sourcesSummary.title")}</span>
        <span className="tabular-nums">({items.length})</span>
      </button>
      {expanded && (
        <>
          <p className="px-2 pb-1 text-[11px] text-muted-foreground/80" role="doc-subtitle">
            {t("thread.sourcesSummary.hint")}
          </p>
          <ul className="px-2 pb-1.5 pt-0 list-none space-y-1.5" role="list">
          {items.map((it, i) => {
            const showLong = expandedItem.has(i) && it.resultPreviewLong;
            const previewText = showLong ? (it.resultPreviewLong ?? it.resultPreview) : it.resultPreview;
            const detailLine = it.resultSummary || it.resultPreview || it.keyInfo;
            const toCopy = it.resultPreviewLong ?? it.resultPreview ?? it.resultSummary ?? it.keyInfo ?? "";
            return (
              <li key={i} className="text-[12px] text-muted-foreground border-b border-border/20 last:border-b-0 pb-1.5 last:pb-0">
                <div className="flex flex-wrap items-baseline gap-x-1">
                  <span className="font-medium text-foreground/90">{it.toolDisplayName}</span>
                  {it.keyInfo ? <span className="text-foreground/80">· {it.keyInfo}</span> : null}
                  {detailLine && detailLine !== it.keyInfo ? <span className="text-muted-foreground/80">· {detailLine.length > 80 ? detailLine.slice(0, 78) + "…" : detailLine}</span> : null}
                  {!detailLine && !it.keyInfo ? <span className="text-muted-foreground/70">· {t("thread.sourcesSummary.executed")}</span> : null}
                </div>
                {previewText && (
                  <div className={cn("mt-0.5 text-[11px] text-muted-foreground/80 wrap-break-word", !showLong && "line-clamp-3")} title={previewText}>
                    {previewText}
                  </div>
                )}
                {(it.filePath || it.url || toCopy) && (
                  <div className="mt-0.5 flex flex-wrap gap-1.5">
                    {it.filePath && (
                      <>
                        <button type="button" className="inline-flex items-center gap-1 text-[11px] text-primary/80 hover:text-primary hover:underline" onClick={() => fileEventBus.openFile(it.filePath!)} aria-label={t("toolCard.openInEditor")}>
                          <ExternalLinkIcon className="size-3" /> {t("toolCard.openInEditor")}
                        </button>
                        <button type="button" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => copyToClipboard(it.filePath!)} aria-label={t("toolCard.copyPath")}>
                          <CopyIcon className="size-3" /> {t("toolCard.copyPath")}
                        </button>
                      </>
                    )}
                    {it.url && !it.filePath && (
                      <button type="button" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => copyToClipboard(it.url!)} aria-label={t("toolCard.copyLink")}>
                        <CopyIcon className="size-3" /> {t("toolCard.copyLink")}
                      </button>
                    )}
                    {toCopy && (
                      <button type="button" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => copyToClipboard(toCopy)} aria-label={t("toolCard.copyResult")}>
                        <CopyIcon className="size-3" /> {t("toolCard.copyResult")}
                      </button>
                    )}
                  </div>
                )}
                {it.resultPreviewLong && it.resultPreviewLong !== it.resultPreview && (
                  <button
                    type="button"
                    onClick={() => toggleItem(i)}
                    className="mt-0.5 text-[11px] text-primary/80 hover:text-primary hover:underline"
                  >
                    {expandedItem.has(i) ? t("toolCard.collapse") : t("toolCard.expandDetail")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        </>
      )}
    </div>
  );
});

const AssistantMessage: FC = memo(function AssistantMessage() {
  const executionStepsFromContext = React.useContext(ExecutionStepsContext);
  const currentMessageId = useMessage((state) => state.id);
  const isRunning = useMessage((state) => state.status?.type === "running");
  const threadId = useThread((s) => (s as { threadId?: string; id?: string })?.threadId ?? (s as { threadId?: string; id?: string })?.id ?? "");
  const rawContentLength = useMessage((state) => (Array.isArray(state.content) ? state.content.length : 0));
  const hasContent = useMessage((state) => {
    const content = state.content;
    if (!content || !Array.isArray(content)) return false;
    for (let i = 0; i < content.length; i++) {
      const part = content[i];
      if (!part) continue;
      if (part.type === 'text' && (part as { type: string; text?: string }).text) return true;
      if (part.type === 'tool-call') return true;
    }
    return false;
  });
  const hasToolCalls = useMessage((state) => {
    const content = state.content;
    if (!content || !Array.isArray(content)) return false;
    for (let i = 0; i < content.length; i++) {
      if (content[i]?.type === 'tool-call') return true;
    }
    return false;
  });
  const currentToolName = useMessage((state) => {
    const content = state.content;
    if (!content || !Array.isArray(content)) return null;
    for (let i = 0; i < content.length; i++) {
      if (content[i]?.type === 'tool-call') {
        const p = content[i] as { toolName?: string; name?: string; toolCall?: { name?: string } };
        return p.toolName ?? p.name ?? p.toolCall?.name ?? null;
      }
    }
    return null;
  });
  const messageText = useMessage(_extractMessageText);
  /** 推理块：来自 content 中 type===reasoning 的 part（custom 通道 content_parts 经 SDK 合并后） */
  const hasNativeReasoningParts = useMessage((s) => Array.isArray(s.content) && s.content.some((p: { type?: string }) => p.type === "reasoning"));
  const parsedThinking = React.useMemo(() => parseThinkingContent(messageText), [messageText]);
  const nativeReasoning = useNativeReasoningBlocks(currentMessageId || undefined, isRunning, threadId || undefined);
  const deferredReasoningBlocks = React.useDeferredValue(nativeReasoning.blocks);
  /** 单源：有 content 内 reasoning part 时仅用 content 展示，不再合并事件思考块，避免双源拧麻花 */
  const mergedThinkingBlocks = React.useMemo(() => {
    if (hasNativeReasoningParts) return parsedThinking.thinkingBlocks;
    if (deferredReasoningBlocks.length === 0) return parsedThinking.thinkingBlocks;
    return [...deferredReasoningBlocks, ...parsedThinking.thinkingBlocks];
  }, [hasNativeReasoningParts, deferredReasoningBlocks, parsedThinking.thinkingBlocks]);

  const content = useMessage((s) => s.content);
  const toolResultsByMessageId = React.useContext(ToolResultsByMessageIdContext);
  const evidenceItems = React.useMemo(() => {
    const raw = content;
    if (!raw || !Array.isArray(raw)) return [];
    const out: Array<{ toolDisplayName: string; keyInfo: string; resultSummary: string | null; resultPreview: string | null; resultPreviewLong?: string | null; filePath?: string | null; url?: string | null }> = [];
    for (let i = 0; i < raw.length; i++) {
      const p = raw[i] as { type?: string; toolCall?: { name?: string }; name?: string; toolName?: string; toolCallId?: string; args?: Record<string, unknown>; result?: unknown };
      if (p?.type !== "tool-call") continue;
      const name = p.toolCall?.name ?? p.name ?? p.toolName ?? "";
      if (getToolTier(name) === "hidden") continue;
      const partForKey = { toolCall: { name }, args: p.args };
      const keyInfo = getPartKeyInfo(partForKey);
      const partToolCallId = p.toolCallId ?? (p as { id?: string }).id ?? "";
      const fallbackResult = currentMessageId ? (toolResultsByMessageId.get(currentMessageId)?.[partToolCallId]) : undefined;
      const rawResult = p.result ?? fallbackResult;
      const resultStr = typeof rawResult === "string" ? rawResult : rawResult != null ? String(rawResult) : "";
      let resultSummary = resultStr ? extractResultSummary(resultStr, name) : null;
      if (resultStr && !resultSummary) {
        const firstLine = resultStr.trim().split(/\n/)[0]?.replace(/\s+/g, " ").trim() || "";
        resultSummary = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine || null;
      }
      let resultPreview = extractResultPreview(resultStr || null, name, 120);
      if (resultStr && !resultPreview) {
        const first = resultStr.trim().split(/\n/)[0]?.replace(/\s+/g, " ").trim() || "";
        resultPreview = first.length > 120 ? `${first.slice(0, 120)}…` : first || null;
      }
      const resultPreviewLong = resultStr && (resultPreview?.length ?? 0) > 0
        ? (extractResultPreview(resultStr || null, name, 400) || (resultStr.length > 400 ? `${resultStr.slice(0, 400)}…` : resultStr))
        : null;
      let filePath: string | null = null;
      let url: string | null = null;
      const args = p.args as Record<string, unknown> | undefined;
      if (args?.file_path && typeof args.file_path === "string") filePath = args.file_path;
      else if (args?.path && typeof args.path === "string") filePath = args.path;
      else if (args?.doc_path && typeof args.doc_path === "string") filePath = args.doc_path;
      if (args?.url && typeof args.url === "string") url = args.url;
      else if (args?.website && typeof args.website === "string") url = args.website;
      else if (args?.source && typeof args.source === "string" && /^https?:\/\//i.test(args.source)) url = args.source;
      if (!url && resultStr) {
        const linkMatch = resultStr.match(/https?:\/\/[^\s\]\)"']+/);
        if (linkMatch) url = linkMatch[0];
      }
      out.push({
        toolDisplayName: getToolDisplayName(name),
        keyInfo,
        resultSummary,
        resultPreview,
        resultPreviewLong: resultPreviewLong && resultPreviewLong !== resultPreview ? resultPreviewLong : null,
        filePath: filePath || undefined,
        url: url || undefined,
      });
    }
    return out;
  }, [content, currentMessageId, toolResultsByMessageId]);

  const hasAnswer = Boolean(messageText && String(messageText).trim().length > 0);

  const chatModeContext = React.useContext(ChatModeContext);
  const turnModeByMessageId = React.useContext(TurnModeByMessageIdContext);
  const turnMode: ChatMode = React.useMemo(() => {
    if (!currentMessageId) return chatModeContext.mode;
    const mode = turnModeByMessageId?.get(currentMessageId);
    if (mode === "agent" || mode === "plan" || mode === "ask" || mode === "debug" || mode === "review") return mode;
    return chatModeContext.mode;
  }, [turnModeByMessageId, currentMessageId, chatModeContext.mode]);
  const [elapsedTime, setElapsedTime] = React.useState(0);
  const showVerboseRuntimeMeta = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  React.useEffect(() => {
    if (!isRunning) {
      setElapsedTime(0);
      return;
    }
    const startTime = Date.now();
    const timer = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [isRunning]);
  
  const status: MessageStatus = React.useMemo(() => {
    if (!isRunning) return 'complete';
    return hasContent ? 'streaming' : 'thinking';
  }, [isRunning, hasContent]);

  const { phase, label: progressLabel, summary: agentSummary } = useAgentProgress(isRunning, t);
  const toolDisplay = currentToolName ? (TOOL_DISPLAY_NAMES[currentToolName] ?? currentToolName) : null;
  const toolStatusLabel = hasToolCalls ? (toolDisplay ? t("status.executingTool", { tool: toolDisplay }) : t("status.running")) : "";
  const statusLabel =
    (toolStatusLabel || progressLabel || ((parsedThinking.isThinking || status === "thinking") ? t("status.thinking") : t("status.generating")));
  /** 消息体内唯一思考入口（Cursor 一致）：运行且无内容时也展示，避免与 Skeleton 重复 */
  const showInlineThinkingBlock =
    (mergedThinkingBlocks.length > 0 || parsedThinking.isThinking || (isRunning && rawContentLength === 0)) && !hasNativeReasoningParts;
  const showMessageSkeleton =
    isRunning && rawContentLength === 0 && !showInlineThinkingBlock;
  const messageRenderFallback = (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      {t("thread.messageRenderFallback")}
    </div>
  );

  const dateDividerMap = React.useContext(DateDividerContext);
  const dateLabel = currentMessageId ? dateDividerMap.get(currentMessageId) : undefined;

  const handleQuoteReply = useCallback((text: string) => {
    const quoted = text.length > 100 ? `> ${text.slice(0, 100)}...` : `> ${text}`;
    window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, { detail: { prompt: quoted } }));
  }, []);

  const stripMarkdownToPlainText = useCallback((md: string): string => {
    if (!md) return "";
    return md
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/^```\w*\n?|```$/g, "").trim())
      .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^#+\s+/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .trim();
  }, []);

  const handleSaveToMemory = useCallback(async () => {
    if (!messageText) return;
    const content = messageText.slice(0, 500).trim();
    if (!content) return;
    try {
      const base = getApiBase();
      const q = new URLSearchParams();
      const wp = getCurrentWorkspacePathFromStorage();
      const uid = getStorageItem("maibot_user_id");
      if (wp) q.set("workspace_path", wp);
      if (uid) q.set("user_id", uid);
      const params = q.toString() ? `?${q.toString()}` : "";
      const res = await fetch(`${base}/memory/entries${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean }).__parseError) {
        toast.error(t("composer.responseParseFailed"));
        return;
      }
      if (data.ok) {
        toast.success(t("thread.toastSavedToMemory"));
        window.dispatchEvent(new CustomEvent("memory_entries_updated"));
      } else {
        toast.error(data.detail || data.error || "保存失败");
      }
    } catch {
      toast.error(t("thread.saveFailed"));
    }
  }, [messageText]);

  const handleCopyPlainText = useCallback(() => {
    if (!messageText) return;
    const plain = stripMarkdownToPlainText(messageText);
    navigator.clipboard.writeText(plain).then(() => toast.success(t("thread.toastCopiedPlain"))).catch(() => toast.error(t("common.copyFailed")));
  }, [messageText, stripMarkdownToPlainText]);

  const handleExportMarkdown = useCallback(() => {
    if (!messageText) return;
    const blob = new Blob([messageText], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `message-${currentMessageId || Date.now()}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
    toast.success(t("thread.exportedMarkdown"));
  }, [messageText, currentMessageId]);

  return (
    <>
      {dateLabel && (
        <div className="flex items-center gap-2 my-2 px-3" aria-hidden>
          <hr className="flex-1 border-border/30" />
          <span className="text-[10px] text-muted-foreground/60 select-none">{dateLabel}</span>
          <hr className="flex-1 border-border/30" />
        </div>
      )}
    <ContextMenu>
      <ContextMenuTrigger asChild>
    <MessagePrimitive.Root
      className="aui-assistant-message-root relative w-full py-2.5 group"
      data-role="assistant"
      data-status={status}
      data-mode={turnMode}
      data-message-id={currentMessageId || undefined}
    >
      {isRunning && (
        <div className="absolute top-0 left-0 right-0 h-[2px] overflow-hidden rounded-t" aria-hidden>
          <div className="h-full w-1/3 bg-primary/60 animate-[slide_1.5s_ease-in-out_infinite]" />
        </div>
      )}
      <TurnModeContext.Provider value={turnMode}>
        <div className="mx-3 px-2.5 py-1.5 flex gap-1.5 rounded-lg bg-muted/5 hover:bg-muted/10 transition-colors">
          <div className="shrink-0 flex items-start pt-0.5" aria-hidden>
            <span className="inline-flex size-5 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Sparkles className="size-3" />
            </span>
          </div>
          <div className="min-w-0 flex-1">
          {/* 运行状态指示 - 思考由 InlineThinkingBlock 展示时不重复 chip（Cursor 单一思考） */}
          {status !== 'complete' && !showInlineThinkingBlock && (
            <div className="mb-0.5">
              <div className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground rounded border border-border/20 bg-background/55 px-1.5 py-0.5" role="status" aria-live="polite">
                {status === 'thinking' && !progressLabel && !parsedThinking.isThinking ? (
                  <Loader2Icon className="size-3 animate-spin text-violet-500" />
                ) : (
                  <span className="w-1.5 h-1.5 rounded-full bg-violet-500" aria-hidden />
                )}
                {statusLabel && <span>{statusLabel}</span>}
                {(showVerboseRuntimeMeta ? elapsedTime > 0 : elapsedTime >= 10) && (
                  <span className="text-muted-foreground/50 tabular-nums">{elapsedTime}s</span>
                )}
              </div>
            </div>
          )}
          {!isRunning && agentSummary && (
            <p className="text-[11px] text-muted-foreground mt-0.5 truncate max-w-[280px]">
              {agentSummary}
            </p>
          )}

          {/* Cursor 一致：消息体即时间线，不单独渲染步骤列表；思考块 + 工具卡片 + 正文按顺序展示；回复即正文，无「结论」标题、无结论区竖线 */}
          <div
            className="aui-assistant-message-content px-0 py-0 text-foreground text-[14px] leading-[1.65] w-full max-w-[min(65ch,100%)] selection:bg-primary/20 wrap-break-word"
            role="region"
            aria-label={isRunning ? t("thread.generatingAria") : (t("thread.reply.regionLabel"))}
          >
            <ErrorBoundary fallback={messageRenderFallback}>
              {showMessageSkeleton ? (
                <MessageSkeleton thinkingPlaceholder />
              ) : (
                <>
                  {/* 思考内容折叠区域（唯一思考入口，运行且无内容时也展示） */}
                  {showInlineThinkingBlock && (
                    <InlineThinkingBlock
                      blocks={mergedThinkingBlocks}
                      isThinking={parsedThinking.isThinking || (isRunning && rawContentLength === 0)}
                      tokenCount={nativeReasoning.tokenCount}
                    />
                  )}
                  <MessagePrimitive.Parts components={_ASSISTANT_PARTS_COMPONENTS} />
                  <MessageError />
                </>
              )}
            </ErrorBoundary>
          </div>

          {evidenceItems.length > 0 && (
            <MessageEvidenceSummary items={evidenceItems} />
          )}

          {/* 操作栏 - 悬停显示 */}
          <div className="aui-assistant-message-footer mt-1 flex items-center gap-0.5 opacity-100 md:opacity-40 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity duration-200">
            <BranchPicker />
            <AssistantActionBar />
            <MessageTimestamp />
          </div>
          </div>
        </div>
      </TurnModeContext.Provider>
    </MessagePrimitive.Root>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onClick={() =>
          messageText && navigator.clipboard.writeText(messageText)
            .then(() => toast.success(t("common.copied")))
            .catch(() => toast.error(t("common.copyFailed")))
        }>
          <CopyIcon className="size-3.5 mr-2" /> 复制消息
        </ContextMenuItem>
        <ContextMenuItem onClick={handleCopyPlainText} disabled={!messageText}>
          <FileTextIcon className="size-3.5 mr-2" /> 复制为纯文本
        </ContextMenuItem>
        <ContextMenuItem onClick={handleExportMarkdown} disabled={!messageText}>
          <Download className="size-3.5 mr-2" /> 导出为 Markdown
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleSaveToMemory} disabled={!messageText}>
          <Brain className="size-3.5 mr-2" /> 保存到记忆
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => messageText && handleQuoteReply(messageText)}>
          <QuoteIcon className="size-3.5 mr-2" /> 引用回复
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ActionBarPrimitive.Reload asChild>
          <ContextMenuItem>
            <RefreshCwIcon className="size-3.5 mr-2" /> {t("error.retryRegenerate")}
          </ContextMenuItem>
        </ActionBarPrimitive.Reload>
      </ContextMenuContent>
    </ContextMenu>
    </>
  );
});

const MessageSkeleton: FC<{ thinkingPlaceholder?: boolean }> = memo(function MessageSkeleton({ thinkingPlaceholder }) {
  return (
    <div
      className="aui-message-skeleton"
      role="status"
      aria-label={thinkingPlaceholder ? t("thread.thinkingPlaceholderAria") : t("thread.generatingAria")}
    >
      <div className="aui-message-skeleton-content">
        {thinkingPlaceholder ? (
          <span className="text-sm text-muted-foreground italic">{t("status.respondingEllipsis")}</span>
        ) : (
          <>
            <div className="aui-message-skeleton-line w-3/4" />
            <div className="aui-message-skeleton-line w-full" />
            <div className="aui-message-skeleton-line w-2/3" />
          </>
        )}
      </div>
    </div>
  );
});

const GenerativeUIWithActionsPart: FC<{ part: { type: string; ui?: any } }> = ({ part }) => {
  const [visionLoading, setVisionLoading] = React.useState(false);
  const [visionResult, setVisionResult] = React.useState<VisionAnalyzeResult | null>(null);
  const sendMessage = useLangGraphSend();

  const sendActionToAgent = useCallback(async (text: string) => {
    await sendMessage([{ type: "human", content: text }], {});
    toast.success(t("thread.sentToAssistant"));
  }, [sendMessage]);

  const requestSystemInfo = useCallback(async () => {
    const res = await fetch(`${getApiBase()}/system/info`);
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean }).__parseError) {
      toast.error(t("composer.responseParseFailed"));
      return;
    }
    if (!res.ok) {
      throw new Error(String(data?.detail || data?.error || "读取系统状态失败"));
    }
    const platform = String(data?.platform || "unknown");
    const cpu = Number(data?.cpu_count || 0);
    const freeMemGb = Number(data?.memory_available || 0) / 1024 / 1024 / 1024;
    toast.success(t("thread.systemStateRefreshed"), {
      description: t("thread.systemStateRefreshedDescription", { platform, cpu: String(cpu), freeMemGb: freeMemGb.toFixed(1) }),
    });
  }, []);

  const checkPathNormalization = useCallback(async () => {
    const url = `${getApiBase()}/workspace/analyze?include_ai_insights=false`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean }).__parseError) {
      toast.error(t("composer.responseParseFailed"));
      return;
    }
    if (!res.ok || data?.ok === false) {
      throw new Error(String(data?.detail || data?.error || "路径检查失败"));
    }
    const total = Number(data?.file_stats?.total || 0);
    const recent = Number(data?.file_stats?.recently_modified || 0);
    toast.success(t("thread.pathWorkspaceCheckDone"), {
      description: `已扫描 ${total} 个文件，最近修改 ${recent} 个`,
    });
  }, []);

  const handleAnalyzeImage = useCallback(async (data: any) => {
    const rawSrc = String(data?.src || "").trim();
    if (!rawSrc) {
      toast.error(t("thread.imageSourceNotFound"));
      return;
    }
    if (rawSrc.startsWith("data:")) {
      toast.error(t("thread.dataUrlNotSupported"));
      return;
    }

    let requestBody: { path?: string; url?: string } = {};
    try {
      const parsed = new URL(rawSrc);
      const host = parsed.hostname.toLowerCase();
      if (parsed.pathname.endsWith("/files/read")) {
        const filePath = parsed.searchParams.get("path") || "";
        if (filePath.trim()) requestBody = { path: filePath.trim() };
      } else if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
          requestBody = {};
        } else {
          requestBody = { url: rawSrc };
        }
      }
    } catch {
      requestBody = { path: rawSrc };
    }
    if (!requestBody.path && !requestBody.url) {
      requestBody = { path: rawSrc };
    }

    setVisionLoading(true);
    setVisionResult(null);
    try {
      const res = await analyzeVisionImage(requestBody);
      setVisionResult(res);
      if (res.ok) toast.success(t("thread.imageAnalysisDone"));
      else toast.error(t("thread.imageAnalysisFailed"), { description: res.error || t("settings.imageAnalysis.unknownError") });
    } finally {
      setVisionLoading(false);
    }
  }, []);

  const handleAction = useCallback(async (action: string, data: any) => {
    try {
      switch (action) {
        case "analyze_image":
          await handleAnalyzeImage(data);
          return;
        case "copy_json": {
          const text = String(data?.text || "").trim();
          if (!text) {
            toast.error(t("thread.noJsonToCopy"));
            return;
          }
          await navigator.clipboard.writeText(text);
          toast.success(t("thread.toastCopiedJson"));
          return;
        }
        case "edit_markdown": {
          const content = String(data?.content || "");
          const title = String(data?.title || "document").trim() || "document";
          const filename = `${title.replace(/\s+/g, "_")}_${Date.now()}.md`;
          fileEventBus.openFile(`__artifact__/${filename}`, content);
          toast.success(t("thread.openedMarkdownInEditor"));
          return;
        }
        case "refresh_system_status":
          await requestSystemInfo();
          return;
        case "check_path_normalization":
          await checkPathNormalization();
          return;
        case "analyze_table":
          await sendActionToAgent(`请分析以下表格数据，并给出关键结论、异常点和下一步建议：\n${JSON.stringify(data || {}, null, 2)}`);
          return;
        case "copy_table":
        case "copy_code": {
          const text = String(data?.content ?? data?.text ?? "").trim();
          if (!text) {
            toast.error(t("thread.noContentToCopy"));
            return;
          }
          try {
            await navigator.clipboard.writeText(text);
            toast.success(t("thread.toastCopiedToClipboard"));
          } catch {
            toast.error(t("thread.copyFailedRetry"));
          }
          return;
        }
        case "export_table_csv":
        case "download_code": {
          const content = String(data?.content ?? data?.code ?? data?.text ?? "");
          const ext = action === "export_table_csv" ? "csv" : "txt";
          const filename = String(data?.filename ?? `export_${Date.now()}.${ext}`).replace(/\.\w+$/, "") + `.${ext}`;
          try {
            const blob = new Blob([content], { type: action === "export_table_csv" ? "text/csv;charset=utf-8" : "text/plain;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = filename;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 100);
            toast.success(t("thread.fileDownloaded"));
          } catch {
            toast.error(t("thread.downloadFailed"));
          }
          return;
        }
        case "open_table_in_editor": {
          const filename = String(data?.filename || `table_${Date.now()}.csv`);
          const content = String(data?.content || "");
          fileEventBus.openFile(`__artifact__/${filename}`, content);
          toast.success(t("thread.openedTableInEditor"));
          return;
        }
        case "open_code_in_editor": {
          const filename = String(data?.filename || `code_${Date.now()}.txt`);
          const content = String(data?.code || data?.content || "");
          fileEventBus.openFile(`__artifact__/${filename}`, content);
          toast.success(t("thread.openedFileInEditor"));
          return;
        }
        case "run_code":
          await sendActionToAgent(`请运行以下代码，并返回执行结果与风险提示：\n${JSON.stringify(data || {}, null, 2)}`);
          return;
        case "analyze_document":
          await sendActionToAgent(`请分析以下文档并提取要点、风险与建议：\n${JSON.stringify(data || {}, null, 2)}`);
          return;
        case "verify_evidence":
          await sendActionToAgent(`请核验以下引用证据的真实性、相关性和完整性：\n${JSON.stringify(data || {}, null, 2)}`);
          return;
        case "reanalyze_chart":
          await sendActionToAgent(`请重新分析该图表，给出趋势、异常和可执行建议：\n${JSON.stringify(data || {}, null, 2)}`);
          return;
        case "retry_step":
          await sendActionToAgent(`请重试以下失败/未完成步骤，并说明修复策略：\n${JSON.stringify(data || {}, null, 2)}`);
          return;
        case "submit_form":
          await sendActionToAgent(`请基于以下表单输入继续执行任务：\n${JSON.stringify(data || {}, null, 2)}`);
          return;
        default:
          toast.info(`暂不支持动作：${action}`);
          return;
      }
    } catch (e) {
      toast.error(t("thread.actionFailed"), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }, [checkPathNormalization, handleAnalyzeImage, requestSystemInfo, sendActionToAgent]);

  const visionSummary = useMemo(() => {
    if (!visionResult?.ok) return null;
    const a = (visionResult.analysis || {}) as Record<string, unknown>;
    const width = typeof a.width === "number" ? a.width : null;
    const height = typeof a.height === "number" ? a.height : null;
    const byteSize = typeof a.byte_size === "number" ? a.byte_size : null;
    const exifCount = typeof a.exif_count === "number" ? a.exif_count : 0;
    const risks: string[] = [];
    const actions: string[] = [];

    if (byteSize != null && byteSize > 4 * 1024 * 1024) {
      risks.push("文件体积较大，后续传输/处理可能较慢。");
      actions.push("如仅需内容理解，先压缩到 1-3MB 再继续。");
    }
    if (width != null && height != null && (width > 4000 || height > 4000)) {
      risks.push("分辨率较高，可能导致模型推理和前端渲染开销上升。");
      actions.push("优先裁剪关键信息区域再分析。");
    }
    if (exifCount > 0) {
      risks.push("检测到 EXIF 元数据，可能包含隐私信息（拍摄设备/地理位置等）。");
      actions.push("对外分享前建议移除 EXIF。");
    }
    if (risks.length === 0) {
      risks.push("未发现明显结构风险。");
      actions.push("可继续执行目标任务（OCR/图表解读/内容审查）。");
    }

    const metrics = [
      { label: "格式", value: String(a.format || "unknown") },
      { label: "分辨率", value: width && height ? `${width}×${height}` : "unknown" },
      { label: "大小", value: byteSize != null ? `${(byteSize / 1024).toFixed(1)} KB` : "unknown" },
      { label: "色彩模式", value: String(a.mode || "unknown") },
      { label: "通道", value: String(a.channels ?? "unknown") },
      { label: "Alpha", value: String(a.has_alpha ? "yes" : "no") },
    ];

    const markdown = [
      "### 结果摘要",
      visionResult.summary || "-",
      "",
      "### 风险提示",
      ...risks.map((r) => `- ${r}`),
      "",
      "### 建议动作",
      ...actions.map((s) => `- ${s}`),
    ].join("\n");

    return { metrics, markdown };
  }, [visionResult]);

  return (
    <ErrorBoundary
      fallback={
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          生成式组件渲染失败，已降级显示。
        </div>
      }
    >
      <>
        <GenerativeUIMessagePart part={part} onAction={handleAction} />
        {(visionLoading || visionResult) && (
          <div className="ml-1 mt-2">
            {visionLoading ? (
              <div className="rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                正在分析图片...
              </div>
            ) : visionSummary ? (
              <>
                <GenerativeUI ui={{ type: "metrics", title: "图片关键指标", columns: 3, metrics: visionSummary.metrics }} />
                <GenerativeUI ui={{ type: "markdown", title: "图片分析结论", content: visionSummary.markdown }} />
              </>
            ) : (
              <GenerativeUI ui={{ type: "json_viewer", title: "图片分析结果", data: visionResult }} />
            )}
          </div>
        )}
      </>
    </ErrorBoundary>
  );
};

const SafeToolFallback: ToolCallMessagePartComponent = (props) => (
  <ErrorBoundary
    fallback={
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        工具卡渲染异常，已降级显示。
      </div>
    }
  >
    <ToolFallback {...props} />
  </ErrorBoundary>
);

const _ASSISTANT_PARTS_COMPONENTS = {
  Text: MarkdownText,
  Reasoning: ReasoningBlock,
  ReasoningGroup: ReasoningGroupBlock,
  ToolGroup: ToolGroupBlock,
  tools: { Fallback: SafeToolFallback },
  ui: GenerativeUIWithActionsPart,
} as React.ComponentProps<typeof MessagePrimitive.Parts>["components"];

const MessageTimestamp: FC = memo(function MessageTimestamp() {
  const raw = useMessage((s) => {
    const state = s as unknown as { createdAt?: number | Date; timestamp?: number };
    return state?.createdAt ?? state?.timestamp;
  });
  const time = useMemo(() => {
    if (raw == null || raw === 0) return null;
    const ms = typeof raw === "number" ? raw : (raw instanceof Date ? raw : new Date(raw)).getTime();
    if (Number.isNaN(ms)) return null;
    const d = new Date(ms);
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }, [raw]);
  const display = time ?? t("common.timeUnknown");
  return (
    <span
      className="ml-1.5 self-center text-[11px] text-muted-foreground/50 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      aria-hidden
    >
      {display}
    </span>
  );
});

const UserMessage: FC = memo(function UserMessage() {
  const currentMessageId = useMessage((s) => (s as { id?: string }).id);
  const dateDividerMap = React.useContext(DateDividerContext);
  const dateLabel = currentMessageId ? dateDividerMap.get(currentMessageId) : undefined;

  const userMessageFallback = (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      用户消息渲染异常，已自动降级显示。
    </div>
  );

  return (
    <>
      {dateLabel && (
        <div className="flex items-center gap-2 my-2 px-3" aria-hidden>
          <hr className="flex-1 border-border/30" />
          <span className="text-[10px] text-muted-foreground/60 select-none">{dateLabel}</span>
          <hr className="flex-1 border-border/30" />
        </div>
      )}
    <MessagePrimitive.Root
      className="aui-user-message-root w-full py-2.5 group"
      data-role="user"
    >
      <div className="px-3">
        <div className="mb-0.5 text-right">
          <span className="text-[11px] tracking-wide text-muted-foreground/60">你</span>
        </div>
        <ErrorBoundary fallback={null}>
          <UserMessageAttachments />
        </ErrorBoundary>
        <div className="aui-user-message-content ml-auto max-w-[85%] rounded-xl border border-border/40 border-l-2 border-l-primary/50 bg-muted/40 px-3 py-2.5 text-foreground text-[14px] leading-[1.65] font-medium shadow-sm ring-1 ring-border/30">
          <ErrorBoundary fallback={userMessageFallback}>
            <MessagePrimitive.Parts />
          </ErrorBoundary>
        </div>
        {/* 操作栏 - 悬停显示 */}
        <div className="flex items-center gap-0.5 mt-1 opacity-100 md:opacity-40 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity">
          <UserActionBar />
          <BranchPicker className="aui-user-branch-picker" />
          <MessageTimestamp />
        </div>
      </div>
    </MessagePrimitive.Root>
    </>
  );
});

const UserActionBar: FC = memo(function UserActionBar() {
  const messageText = useMessage(_extractMessageText);
  const supportsEdit = useThread((s) => (s as { capabilities?: { edit?: boolean } })?.capabilities?.edit ?? false);

  const handleQuoteToNext = useCallback(() => {
    const snippet = (messageText ?? "").slice(0, 100);
    const quoted = snippet.length < (messageText ?? "").length ? `${snippet}...` : snippet;
    const prompt = quoted ? `> ${quoted}\n\n` : "";
    if (!prompt) return;
    const threadId = getCurrentThreadIdFromStorage() || undefined;
    window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, { detail: { prompt, threadId, autoSend: false } }));
  }, [messageText]);

  const handleResend = useCallback(() => {
    const text = (messageText ?? "").trim();
    if (!text) return;
    const threadId = getCurrentThreadIdFromStorage() || undefined;
    window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, { detail: { prompt: text, threadId, autoSend: true } }));
    toast.success(t("thread.filledAndSent"));
  }, [messageText]);

  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex items-center gap-0.5 text-muted-foreground"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="复制" className="aui-user-action-bar-copy size-7 hover:text-foreground hover:bg-muted/40 transition-all duration-150">
          <CopyIcon className="size-3.5" />
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      {supportsEdit && (
        <ActionBarPrimitive.Edit asChild>
          <TooltipIconButton tooltip="编辑" className="size-7 hover:text-foreground hover:bg-muted/40 transition-all duration-150">
            <PencilIcon className="size-3.5" />
          </TooltipIconButton>
        </ActionBarPrimitive.Edit>
      )}
      <DropdownMenu>
        <Tooltip>
          <DropdownMenuTrigger asChild>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="size-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-all duration-150"
                aria-label={t("a11y.moreActions")}
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </TooltipTrigger>
          </DropdownMenuTrigger>
          <TooltipContent side="top" sideOffset={4}>{t("a11y.moreActions")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem
            onClick={() => {
              if (!messageText) return;
              navigator.clipboard.writeText(messageText).then(() => toast.success(t("common.copied"))).catch(() => toast.error(t("common.copyFailed")));
            }}
          >
            <CopyIcon className="mr-2 size-3.5" />
            复制
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleQuoteToNext} disabled={!messageText?.trim()}>
            <QuoteIcon className="mr-2 size-3.5" />
            {t("message.quoteToNext")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleResend} disabled={!messageText?.trim()}>
            <Send className="mr-2 size-3.5" />
            {t("message.editResend")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </ActionBarPrimitive.Root>
  );
});

const EditComposer: FC = () => {
  const { mode } = React.useContext(ChatModeContext);
  
  return (
    <MessagePrimitive.Root className="aui-edit-composer-wrapper mx-auto flex w-full max-w-(--thread-max-width) flex-col px-2 py-2">
      <ComposerPrimitive.Root className="aui-edit-composer-root ml-auto flex w-full max-w-[85%] flex-col rounded-xl bg-muted ring-2 ring-primary/20">
        {/* 模式指示器 */}
        <div className="flex items-center justify-between px-2.5 pt-1.5 pb-0.5 border-b border-border/20">
          <span className="text-[11px] text-muted-foreground">编辑消息</span>
          <span className="text-[11px] text-muted-foreground">{t("modes." + (mode as ChatMode))} {t("thread.modeLabelSuffix")}</span>
        </div>
        
        <ComposerPrimitive.Input
          className="aui-edit-composer-input min-h-12 w-full resize-none bg-transparent p-2.5 text-foreground text-sm outline-none"
          autoFocus
        />
        
        <div className="aui-edit-composer-footer mx-2.5 mb-2 flex items-center gap-2 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" className="h-7 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1">
              取消
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" className="h-7 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1">
              更新
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root mr-2 -ml-2 inline-flex items-center text-muted-foreground text-xs opacity-100 pointer-events-auto md:opacity-0 transition-opacity duration-150 md:group-hover:opacity-100 md:group-hover:pointer-events-auto md:group-focus-within:opacity-100 md:group-focus-within:pointer-events-auto",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="上一分支">
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="下一分支">
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
