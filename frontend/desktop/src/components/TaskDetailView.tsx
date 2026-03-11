/**
 * TaskDetailView - 编辑区任务详情页（生成式 UI）
 *
 * 设计理念：
 * - 任务像文件一样在编辑区 Tab 中打开
 * - 按「区块」渲染：概览、进展、成员、检查点、关联对话、产出、结果、操作
 * - 不同任务类型（skill_profile）可映射不同「视图模板」，决定展示哪些区块与顺序
 * - 为后续后端下发 schema 的生成式 UI 预留扩展
 */

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { cn } from "./ui/utils";
import { Progress } from "./ui/progress";
import { ScrollArea } from "./ui/scroll-area";
import { Skeleton } from "./ui/skeleton";
import { Textarea } from "./ui/textarea";
import {
  ListTodo,
  Play,
  Pause,
  XCircle,
  RotateCcw,
  MessageSquare,
  FileText,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
  Copy,
  Pencil,
  User,
  CircleDot,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { boardApi, type BoardTask, type AssessmentResult, type AgentProfile, type CollaborationMetricRow } from "../lib/api/boardApi";
import {
  getTaskStatusBadgeClass,
  getTaskStatusLabel,
  inferTaskDispatchStage,
  resolveTaskPrimaryEntryAction,
} from "../lib/taskDispatchStage";
import { EVENTS } from "../lib/constants";
import { getTimeGroupLabel, formatTimeForSummary } from "../lib/utils/formatters";
import { getCurrentWorkspacePathFromStorage } from "../lib/sessionState";
import { resolveScopedChatMode, type ChatMode } from "../lib/chatModeState";
import { SETTINGS_PREFILL_EXEC_THREAD_EVENT } from "./Settings";
import { t } from "../lib/i18n";
import { usePreciseMinute } from "../lib/hooks/usePreciseMinute";
import { useShallow } from "zustand/react/shallow";
import { useTaskStore } from "../store/taskStore";

import {
  RESULT_ISSUE_REGEX,
  classifyResultIssueToken,
  extractResultIssueHints,
  getResultIssueRecommendations,
} from "../lib/resultIssueClassifier";
import ReactMarkdown from "react-markdown";
import { remarkPluginsWithMath, rehypePluginsMath } from "../lib/markdownRender";
import { GenerativeUI } from "./ChatComponents/generative-ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";

// ============================================================================
// 类型
// ============================================================================

export interface TaskDetailViewProps {
  taskId: string;
  /** 打开后聚焦到指定区块（如 result） */
  focusSection?: "result";
  /** 打开关联对话 */
  onOpenThread?: (threadId: string) => void;
  /** 在编辑区打开文件 */
  onOpenFile?: (path: string) => void;
  /** 关闭当前任务 Tab */
  onClose?: () => void;
}

/** 区块类型 */
type SectionType =
  | "overview"
  | "progress"
  | "members"
  | "collaboration"
  | "checkpoints"
  | "thread"
  | "deliverables"
  | "result"
  | "actions";

/** 视图模板：决定展示哪些区块与顺序 */
interface ViewTemplate {
  sections: SectionType[];
  /** 默认折叠的区块 */
  collapsedByDefault?: SectionType[];
}

// ============================================================================
// 视图模板（按 skill_profile 分类）
// ============================================================================

const VIEW_TEMPLATES: Record<string, ViewTemplate> = {
  full: {
    sections: ["overview", "progress", "members", "collaboration", "checkpoints", "thread", "deliverables", "result", "actions"],
  },
  bidding: {
    sections: ["overview", "progress", "checkpoints", "members", "collaboration", "deliverables", "result", "thread", "actions"],
    collapsedByDefault: ["members"],
  },
  office: {
    sections: ["overview", "progress", "collaboration", "deliverables", "result", "thread", "actions"],
    collapsedByDefault: ["thread"],
  },
  research: {
    sections: ["overview", "progress", "collaboration", "result", "deliverables", "thread", "actions"],
  },
};

const DEFAULT_TEMPLATE: ViewTemplate = VIEW_TEMPLATES.full;

function getViewTemplate(skillProfile?: string): ViewTemplate {
  if (skillProfile && VIEW_TEMPLATES[skillProfile]) return VIEW_TEMPLATES[skillProfile];
  return DEFAULT_TEMPLATE;
}

// ============================================================================
// 状态标签与图标
// ============================================================================

const COST_TIER_LABEL: Record<string, string> = { low: "低", medium: "中", high: "高" };
const PRIORITY_LABEL = (n?: number) => (n != null ? `P${n}` : "—");

// ============================================================================
// 主组件
// ============================================================================

export function TaskDetailView({ taskId, focusSection, onOpenThread, onOpenFile, onClose }: TaskDetailViewProps) {
  const task = useTaskStore((s) => s.getTask(taskId)) ?? null;
  const allTasks = useTaskStore(useShallow((s) => Object.values(s.tasksById)));
  const [initialLoading, setInitialLoading] = useState(true);
  const initialLoadDoneRef = React.useRef(false);
  const [assessment, setAssessment] = useState<AssessmentResult | null>(null);
  const [agentName, setAgentName] = useState<string>("本机");
  const [collapsedSections, setCollapsedSections] = useState<Set<SectionType>>(new Set());
  const [opLoading, setOpLoading] = useState<Record<string, boolean>>({});
  const [checkpointFeedback, setCheckpointFeedback] = useState<Record<string, string>>({});
  const isUnmountedRef = React.useRef(false);
  React.useEffect(() => () => { isUnmountedRef.current = true; }, []);
  const [scheduleRuns, setScheduleRuns] = useState<Array<{ subject?: string; slot?: string; triggered_at?: string; thread_id?: string }>>([]);
  const [spawnRows, setSpawnRows] = useState<Array<{
    ts?: string;
    parent_agent_id?: string;
    child_agent_id?: string;
    role?: string;
    reason?: string;
    task_id?: string | null;
    consumed?: boolean;
  }>>([]);
  const [collabMetricRows, setCollabMetricRows] = useState<CollaborationMetricRow[]>([]);
  const [spawnUpdatedAt, setSpawnUpdatedAt] = useState<string>("");
  const [metricsUpdatedAt, setMetricsUpdatedAt] = useState<string>("");
  const nowMinute = usePreciseMinute();
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const resultSectionRef = React.useRef<HTMLDivElement | null>(null);
  const emitSwitchToThread = useCallback((threadId: string, relatedTaskId?: string, relatedStatus?: string) => {
    window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_TO_THREAD, {
      detail: {
        threadId,
        taskId: relatedTaskId,
        status: relatedStatus,
      },
    }));
  }, []);

  // 加载任务数据（写入 store，Dashboard 与详情页共享）
  // getCancelled: 由调用方传入，用于 effect 卸载时避免脏更新（每 effect 独立，避免竞态）
  const loadTask = useCallback(async (getCancelled?: () => boolean) => {
    const isCancelled = getCancelled ?? (() => false);
    if (!initialLoadDoneRef.current) setInitialLoading(true);
    try {
      const found = await useTaskStore.getState().fetchTask(taskId);
      if (isCancelled()) return;
      if (found) {
        boardApi.assessTask(found).then((r) => {
          if (isCancelled()) return;
          if (r.ok && r.assessment) setAssessment(r.assessment);
        }).catch((err) => {
          if (import.meta.env?.DEV) console.warn("[TaskDetailView] assessTask failed:", err);
          if (!isCancelled()) toast.error(t("task.assessFailed"));
        });
      }
    } catch {
      if (!isCancelled()) toast.error(t("task.loadFailed"));
    } finally {
      if (!isCancelled()) {
        setInitialLoading(false);
        initialLoadDoneRef.current = true;
      }
    }
  }, [taskId]);

  const loadSpawnRecords = useCallback(async (getCancelled?: () => boolean) => {
    const cancelled = getCancelled ?? (() => false);
    try {
      const res = await boardApi.getSpawnRecords({ limit: 120, pending_only: false });
      if (cancelled()) return;
      if (!res.ok) {
        setSpawnRows([]);
        return;
      }
      setSpawnRows(res.rows || []);
      if (cancelled()) return;
      setSpawnUpdatedAt(new Date().toISOString());
    } catch {
      if (cancelled()) return;
      setSpawnRows([]);
      toast.error(t("task.detail.loadSpawnFailed"));
    }
  }, []);

  const loadCollaborationMetrics = useCallback(async (currentTask: BoardTask | null, getCancelled?: () => boolean) => {
    const cancelled = getCancelled ?? (() => false);
    if (!currentTask?.id) {
      setCollabMetricRows([]);
      return;
    }
    try {
      const res = await boardApi.getCollaborationMetrics({
        task_id: currentTask.id,
        scope: currentTask.scope || "personal",
        limit: 80,
      });
      if (cancelled()) return;
      if (!res.ok) {
        setCollabMetricRows([]);
        return;
      }
      setCollabMetricRows(res.rows || []);
      if (cancelled()) return;
      setMetricsUpdatedAt(new Date().toISOString());
    } catch {
      if (cancelled()) return;
      setCollabMetricRows([]);
      toast.error(t("task.detail.loadCollabFailed"));
    }
  }, []);

  // 加载 Agent 名称
  useEffect(() => {
    let cancelled = false;
    boardApi.getAgentProfile().then((r) => {
      if (cancelled) return;
      if (r.ok && r.profile?.name) setAgentName(r.profile.name);
    }).catch((err) => {
      if (import.meta.env?.DEV) console.warn("[TaskDetailView] getAgentProfile failed:", err);
      if (!cancelled) toast.error(t("task.detail.loadAgentFailed"));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    initialLoadDoneRef.current = false;
    loadTask(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadTask]);

  useEffect(() => {
    let cancelled = false;
    loadSpawnRecords(() => cancelled);
    return () => { cancelled = true; };
  }, [loadSpawnRecords]);

  const loadScheduleRuns = useCallback(async (currentTask: BoardTask | null) => {
    if (!currentTask) {
      setScheduleRuns([]);
      return;
    }
    try {
      const res = await boardApi.getAutonomousScheduleState({
        limit: 200,
        thread_id: currentTask.thread_id || undefined,
      });
      if (isUnmountedRef.current) return;
      if (!res.ok) {
        setScheduleRuns([]);
        return;
      }
      const subject = String(currentTask.subject || "");
      const threadId = String(currentTask.thread_id || "");
      const filtered = (res.recent_runs || []).filter((r) => {
        if (!r || typeof r !== "object") return false;
        const runThreadId = String(r.thread_id || "");
        const runSubject = String(r.subject || "");
        if (threadId && runThreadId && runThreadId === threadId) return true;
        if (subject && runSubject && runSubject === subject) return true;
        return false;
      });
      if (isUnmountedRef.current) return;
      setScheduleRuns(
        filtered
          .slice()
          .sort((a, b) => String(b.triggered_at || "").localeCompare(String(a.triggered_at || "")))
          .slice(0, 20)
      );
    } catch {
      if (!isUnmountedRef.current) setScheduleRuns([]);
    }
  }, []);

  useEffect(() => {
    loadScheduleRuns(task);
  }, [task?.id, task?.thread_id, loadScheduleRuns]);

  useEffect(() => {
    let cancelled = false;
    loadCollaborationMetrics(task, () => cancelled);
    return () => { cancelled = true; };
  }, [task?.id, task?.scope, loadCollaborationMetrics]);

  // 单一刷新入口：debounce 300ms + version 忽略过期结果，合并 TASK_PROGRESS 与轮询的请求风暴
  const refreshDebounceTimerRef = React.useRef<number | null>(null);
  const refreshVersionRef = React.useRef(0);
  const requestTaskRefresh = useCallback((id: string) => {
    if (refreshDebounceTimerRef.current != null) clearTimeout(refreshDebounceTimerRef.current);
    refreshDebounceTimerRef.current = window.setTimeout(() => {
      refreshDebounceTimerRef.current = null;
      const version = ++refreshVersionRef.current;
      useTaskStore.getState().fetchTask(id).then((found) => {
        if (refreshVersionRef.current !== version) return;
        if (found) {
          const next = found.status ?? null;
          lastPolledStatusRef.current = next;
          boardApi.assessTask(found).then((r) => {
            if (refreshVersionRef.current !== version) return;
            if (r.ok && r.assessment) setAssessment(r.assessment);
          }).catch((err) => {
            if (import.meta.env?.DEV) console.warn("[TaskDetailView] assessTask poll failed:", err);
            if (refreshVersionRef.current === version) toast.error(t("task.assessFailed"));
          });
          const terminal = ["completed", "failed", "cancelled"].includes(String(next));
          if (terminal && pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
        }
      }).catch((err) => {
        if (import.meta.env?.DEV) console.warn("[TaskDetailView] refresh failed:", err);
        toast.error(t("task.detail.refreshFailed"));
      });
    }, 300);
  }, []);

  const lastPolledStatusRef = React.useRef<string | null>(null);
  const pollIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const scrollToCheckpointsTimerRef = React.useRef<number | null>(null);
  useEffect(() => () => {
    if (scrollToCheckpointsTimerRef.current != null) clearTimeout(scrollToCheckpointsTimerRef.current);
  }, []);
  useEffect(() => () => {
    if (refreshDebounceTimerRef.current != null) clearTimeout(refreshDebounceTimerRef.current);
  }, []);

  // 监听 TASK_PROGRESS：走 debounce 刷新
  useEffect(() => {
    if (!taskId) return;
    const handler = () => requestTaskRefresh(taskId);
    window.addEventListener(EVENTS.TASK_PROGRESS, handler);
    return () => window.removeEventListener(EVENTS.TASK_PROGRESS, handler);
  }, [taskId, requestTaskRefresh]);

  // 轮询 5s：首次立即执行一次再设 interval
  useEffect(() => {
    if (!taskId) return;
    lastPolledStatusRef.current = useTaskStore.getState().getTask(taskId)?.status ?? null;
    requestTaskRefresh(taskId);
    pollIntervalRef.current = setInterval(() => requestTaskRefresh(taskId), 5000);
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [taskId, requestTaskRefresh]);

  // 初始化折叠状态
  const template = useMemo(() => getViewTemplate(task?.skill_profile), [task?.skill_profile]);
  useEffect(() => {
    if (template.collapsedByDefault) {
      setCollapsedSections(new Set(template.collapsedByDefault));
    }
  }, [template]);

  // 外部请求聚焦到结果区：自动展开并滚动
  useEffect(() => {
    if (focusSection !== "result") return;
    setCollapsedSections((prev) => {
      if (!prev.has("result")) return prev;
      const next = new Set(prev);
      next.delete("result");
      return next;
    });
    const timer = window.setTimeout(() => {
      resultSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [focusSection, task?.id]);

  const toggleSection = useCallback((section: SectionType) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }, []);

  const onScrollToCheckpoints = useCallback(() => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      next.delete("checkpoints");
      return next;
    });
    if (scrollToCheckpointsTimerRef.current != null) clearTimeout(scrollToCheckpointsTimerRef.current);
    scrollToCheckpointsTimerRef.current = window.setTimeout(() => {
      scrollToCheckpointsTimerRef.current = null;
      document.querySelector('[data-section="checkpoints"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  }, []);

  const copyToClipboard = useCallback((text: string, label: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success(`已复制${label}`),
      () => toast.error(t("common.copyFailed"))
    );
  }, []);

  const formatShortTime = useCallback((raw?: string) => (raw ? formatTimeForSummary(raw) : ""), []);

  const taskStatusHistory = useMemo(() => {
    const t = task as { metadata?: { task_status_history?: unknown[] }; task_status_history?: unknown[] };
    const raw = t?.metadata?.task_status_history ?? t?.task_status_history;
    return (Array.isArray(raw) ? raw : []) as Array<{ from?: string; to?: string; at_ms?: number; source?: string }>;
  }, [task]);

  const groupedProgressEvents = useMemo(() => {
    const getBucketLabel = (raw?: string) => getTimeGroupLabel(raw);
    const events: Array<{ label: string; ts?: string; thread_id?: string }> = [];
    if (task?.progress_message) {
      events.push({
        label: task.progress_message,
        ts: task.updated_at || task.created_at,
        thread_id: task.thread_id || undefined,
      });
    }
    for (const r of scheduleRuns) {
      events.push({
        label: `${r.subject || task?.subject || "任务"} · ${r.slot || "unscheduled"}`,
        ts: r.triggered_at,
        thread_id: r.thread_id || task?.thread_id || undefined,
      });
    }
    const sorted = events.slice().sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
    const order = ["刚刚", "15分钟内", "更早"] as const;
    const groups: Record<(typeof order)[number], Array<{ label: string; ts?: string; thread_id?: string }>> = {
      刚刚: [],
      "15分钟内": [],
      更早: [],
    };
    for (const item of sorted) {
      groups[getBucketLabel(item.ts) as (typeof order)[number]].push(item);
    }
    return order
      .map((bucket) => ({ bucket, items: groups[bucket] }))
      .filter((g) => g.items.length > 0);
  }, [task?.progress_message, task?.updated_at, task?.created_at, task?.thread_id, task?.subject, scheduleRuns, nowMinute]);

  const collaborationRows = useMemo(() => {
    if (!task) return [];
    return spawnRows
      .filter((r) => {
        const spawnTaskId = String(r.task_id || "").trim();
        const childThreadId = String(r.child_agent_id || "").trim();
        if (spawnTaskId && (spawnTaskId === task.id || spawnTaskId === task.task_id)) return true;
        if (task.thread_id && childThreadId && childThreadId === task.thread_id) return true;
        return false;
      })
      .sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
  }, [spawnRows, task]);

  const childCollabInsights = useMemo(() => {
    if (!collaborationRows.length) return [];
    return collaborationRows.map((row) => {
      const childThreadId = String(row.child_agent_id || "").trim();
      const activeLoads = allTasks.filter((t) => {
        const threadHit = childThreadId && String(t.thread_id || "") === childThreadId;
        const roleHit = row.role && String(t.claimed_by || "") === String(row.role);
        const active = ["claimed", "running", "pending"].includes(String(t.status || ""));
        return active && (threadHit || roleHit);
      });
      const loadLevel = activeLoads.length >= 3 ? "高" : activeLoads.length >= 1 ? "中" : "低";
      const base = task?.status === "completed" ? 70 : task?.status === "running" ? 55 : 40;
      const progressBonus = Math.max(0, Math.min(20, Math.round(Number(task?.progress || 0) / 5)));
      const linkBonus = task?.thread_id && childThreadId === task.thread_id ? 10 : 0;
      const contribution = Math.min(100, base + progressBonus + linkBonus);
      return { row, loadLevel, activeCount: activeLoads.length, contribution };
    });
  }, [collaborationRows, allTasks, task]);

  const displayCollabRows = useMemo(() => {
    if (collabMetricRows.length > 0) {
      return collabMetricRows.map((m) => {
        const activeCount = Number(m.metrics?.active_count || 0);
        const contribution = Number(m.metrics?.contribution_score || 0);
        const loadLevel = activeCount >= 3 ? "高" : activeCount >= 1 ? "中" : "低";
        return {
          row: {
            ts: m.ts,
            parent_agent_id: m.parent_agent_id || undefined,
            child_agent_id: m.child_agent_id || undefined,
            role: m.role || undefined,
            reason: m.reason,
            task_id: m.task_id || undefined,
          },
          loadLevel,
          activeCount,
          contribution,
          completedCount: Number(m.metrics?.completed_count || 0),
          failureRate: Number(m.metrics?.failure_rate || 0),
          avgDurationMinutes: m.metrics?.avg_duration_minutes ?? null,
        };
      });
    }
    return childCollabInsights.map((x) => ({
      ...x,
      completedCount: undefined as number | undefined,
      failureRate: undefined as number | undefined,
      avgDurationMinutes: undefined as number | undefined,
    }));
  }, [collabMetricRows, childCollabInsights]);

  const collaborationMeta = useMemo(() => {
    if (collabMetricRows.length > 0) {
      return {
        sourceLabel: "真实指标",
        updatedAt: metricsUpdatedAt,
      };
    }
    if (displayCollabRows.length > 0) {
      return {
        sourceLabel: "估算指标",
        updatedAt: spawnUpdatedAt || metricsUpdatedAt,
      };
    }
    return { sourceLabel: "", updatedAt: "" };
  }, [collabMetricRows.length, displayCollabRows.length, metricsUpdatedAt, spawnUpdatedAt]);

  const lineageInfo = useMemo(() => {
    if (!task) {
      return {
        rootTask: null as BoardTask | null,
        parentTask: null as BoardTask | null,
        siblingTasks: [] as BoardTask[],
        childTasks: [] as BoardTask[],
      };
    }
    const byId = new Map<string, BoardTask>();
    for (const t of allTasks) {
      if (t?.id) byId.set(String(t.id), t);
    }
    const byTaskId = new Map<string, BoardTask>();
    for (const t of allTasks) {
      if (t?.task_id) byTaskId.set(String(t.task_id), t);
    }
    const resolve = (key: string) => byId.get(key) ?? byTaskId.get(key) ?? null;
    const parentTaskId = String(task.parent_task_id || "").trim();
    const parentTask = parentTaskId ? resolve(parentTaskId) : null;
    let rootTask: BoardTask | null = null;
    const visited = new Set<string>();
    let cursor: BoardTask | null = parentTask;
    while (cursor && !visited.has(String(cursor.id))) {
      visited.add(String(cursor.id));
      rootTask = cursor;
      const nextParentId = String(cursor.parent_task_id || "").trim();
      cursor = nextParentId ? resolve(nextParentId) : null;
    }
    const siblingTasks = parentTaskId
      ? allTasks.filter((t) => String(t.parent_task_id || "") === parentTaskId && String(t.id) !== String(task.id)).slice(0, 5)
      : [];
    const childTasks = allTasks.filter((t) => String(t.parent_task_id || "") === String(task.id)).slice(0, 5);
    return { rootTask, parentTask, siblingTasks, childTasks };
  }, [task, allTasks]);

  const getResultKeywordTone = useCallback((token: string) => {
    const kind = classifyResultIssueToken(token);
    if (kind === "权限") {
      return { label: "权限", cls: "bg-red-500/15 text-red-700 dark:text-red-300" };
    }
    if (kind === "路径") {
      return { label: "路径", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300" };
    }
    if (kind === "参数") {
      return { label: "参数", cls: "bg-violet-500/15 text-violet-700 dark:text-violet-300" };
    }
    if (kind === "网络") {
      return { label: "网络", cls: "bg-blue-500/15 text-blue-700 dark:text-blue-300" };
    }
    if (kind === "限流") {
      return { label: "限流", cls: "bg-orange-500/15 text-orange-700 dark:text-orange-300" };
    }
    return null;
  }, []);

  const highlightedResultParts = useMemo(() => {
    const text = String(task?.result || "");
    if (!text) return [];
    return text.split(RESULT_ISSUE_REGEX).map((part, idx) => {
      if (!part) return null;
      const tone = getResultKeywordTone(part);
      if (!tone) return <React.Fragment key={`res-${idx}`}>{part}</React.Fragment>;
      return (
        <mark key={`res-${idx}`} className={`rounded px-0.5 ${tone.cls}`}>
          {part}
        </mark>
      );
    });
  }, [task?.result, getResultKeywordTone]);

  const resultKeywordHints = useMemo(() => {
    return extractResultIssueHints(String(task?.result || ""));
  }, [task?.result]);

  const resultIssueRecommendations = useMemo(() => {
    return getResultIssueRecommendations(resultKeywordHints);
  }, [resultKeywordHints]);

  const handleSaveDescription = useCallback(async () => {
    if (!task) return;
    setOpLoading((prev) => ({ ...prev, desc: true }));
    try {
      const res = await boardApi.updateTask(task.id, { description: descDraft });
      if (!res.ok) {
        toast.error(t("task.detail.saveFailed"), { description: res.error ?? t("task.detail.saveFailedRetry") });
        return;
      }
      toast.success(t("task.detail.descriptionUpdated"));
      setEditingDesc(false);
      loadTask(() => isUnmountedRef.current);
    } catch (e) {
      toast.error(t("task.detail.saveFailed"), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      if (!isUnmountedRef.current) setOpLoading((prev) => ({ ...prev, desc: false }));
    }
  }, [task, descDraft, loadTask]);

  const handleAction = useCallback(async (action: "pause" | "cancel" | "resume" | "reset") => {
    if (!task) return;
    if (action === "cancel") {
      setCancelConfirmOpen(true);
      return;
    }
    setOpLoading((prev) => ({ ...prev, [action]: true }));
    try {
      const statusMap: Record<string, string> = {
        pause: "paused",
        cancel: "cancelled",
        resume: "running",
        reset: "available",
      };
      if (action === "resume") {
        const resumeRes = await boardApi.resumeTask(task.id, { scope: task.scope || "personal" });
        if (!resumeRes.ok) {
          toast.error(t("task.detail.resumeFailed"), { description: resumeRes.error || t("task.detail.saveFailedRetry") });
          return;
        }
        toast.success(t("task.detail.resumed"));
        loadTask(() => isUnmountedRef.current);
        return;
      }
      const res = await boardApi.updateTask(task.id, {
        status: statusMap[action],
        scope: task.scope || "personal",
      });
      if (!res.ok) {
        toast.error(t("task.detail.operationFailed"), { description: res.error || t("task.detail.stateUpdateFailed") });
        return;
      }
      toast.success(action === "pause" ? "已暂停" : "已重新开始");
      loadTask(() => isUnmountedRef.current);
    } catch (e) {
      toast.error(t("task.detail.operationFailed"), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      if (!isUnmountedRef.current) setOpLoading((prev) => ({ ...prev, [action]: false }));
    }
  }, [task, loadTask]);

  const performCancel = useCallback(async () => {
    if (!task) return;
    const previousStatus = task.status;
    setCancelConfirmOpen(false);
    setOpLoading((prev) => ({ ...prev, cancel: true }));
    try {
      const res = await boardApi.updateTask(task.id, {
        status: "cancelled",
        scope: task.scope || "personal",
      });
      if (!res.ok) {
        toast.error(t("task.detail.operationFailed"), { description: res.error || t("task.detail.stateUpdateFailed") });
        return;
      }
      loadTask(() => isUnmountedRef.current);
      toast.success(t("task.detail.cancelled"), {
        duration: 5000,
        action: {
          label: t("common.undo"),
          onClick: () => {
            boardApi.updateTask(task.id, { status: previousStatus, scope: task.scope || "personal" }).then((r) => {
              if (r.ok && !isUnmountedRef.current) loadTask(() => isUnmountedRef.current);
            });
          },
        },
      });
    } catch (e) {
      toast.error(t("task.detail.operationFailed"), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      if (!isUnmountedRef.current) setOpLoading((prev) => ({ ...prev, cancel: false }));
    }
  }, [task, loadTask]);

  const handleCheckpointDecision = useCallback(async (checkpointId: string, decision: "approve" | "reject" | "revise" | "delegate" | "skip", feedback?: string) => {
    if (!task) return;
    const cpKey = `cp_${checkpointId}`;
    setOpLoading((prev) => ({ ...prev, [cpKey]: true }));
    try {
      const res = await boardApi.submitHumanReview(
        task.id,
        {
          checkpoint_id: checkpointId,
          decision,
          feedback: feedback ?? "",
        },
        task.scope || "personal",
      );
      if (!res.ok) {
        toast.error(t("task.detail.submitReviewFailed"), { description: res.error || t("task.detail.unknownError") });
        return;
      }
      const actionLabel =
        decision === "approve"
          ? "通过"
          : decision === "reject"
            ? "驳回"
            : decision === "delegate"
              ? "委派"
              : decision === "skip"
                ? "跳过"
                : "要求修订";
      toast.success(`检查点已${actionLabel}`);
      window.dispatchEvent(new CustomEvent(EVENTS.TASK_PROGRESS, { detail: { taskId: task.id, source: "task_detail_review" } }));
      await loadTask(() => isUnmountedRef.current);
    } catch (e) {
      toast.error(t("task.detail.submitReviewFailed"), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      if (!isUnmountedRef.current) setOpLoading((prev) => ({ ...prev, [cpKey]: false }));
    }
  }, [task, loadTask]);

  // ============================================================================
  // 渲染
  // ============================================================================

  if (initialLoading) {
    return (
      <div className="flex-1 flex flex-col min-h-0" role="region" aria-label={t("task.detailRegionAria")}>
        <div className="shrink-0 h-11 border-b border-border/20 bg-muted/30 px-4 flex items-center gap-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-5 w-16 rounded-md" />
        </div>
        <div className="flex-1 max-w-2xl mx-auto px-6 py-6 w-full space-y-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground">
        <AlertCircle className="h-8 w-8" />
        <p className="text-sm">{t("task.notFound")}</p>
        <Button size="sm" variant="outline" onClick={() => loadTask()} className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" aria-label={t("common.retry")}>
          <RefreshCw className="h-3 w-3 mr-1" />
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  const status = task.status ?? "available";
  const executionStatusLabel = (() => {
    const execution = (task as any)?.execution;
    if (!execution || typeof execution !== "object") return "";
    const recoveryAvailable = Boolean((execution as any).recovery_available);
    const activeRunId = String((execution as any).active_run_id || "").trim();
    const reason = String((execution as any).recovery_reason || "").trim().toLowerCase();
    if (recoveryAvailable) return reason ? `resumable(${reason})` : "resumable";
    if (activeRunId) return "recovering";
    if (status === "failed") return "failed";
    if (status === "running") return "running";
    return "";
  })();
  const dispatchStage = inferTaskDispatchStage(task);
  const primaryEntry = resolveTaskPrimaryEntryAction(task);
  const nextStepSuggestions: string[] = (() => {
    const suggestions: string[] = [];
    if (status === "awaiting_plan_confirm") {
      suggestions.push("打开对话查看计划草案，确认后继续执行。");
      suggestions.push("如计划与目标不一致，可先“回到待处理”再补充约束。");
    }
    if (status === "blocked") {
      suggestions.push("先补齐“待补充信息”中的关键字段，再点击“补充后重试”。");
      if (!task.missing_information?.length) {
        suggestions.push("当前未识别到缺失信息，建议在对话中补充上下文后再重试。");
      }
    }
    if (status === "waiting_human") {
      suggestions.push("该任务正在等待人工决策，请优先处理检查点并给出明确结论。");
      suggestions.push("可打开关联对话补充意见，提交后任务会继续执行。");
    }
    if (status === "failed") {
      suggestions.push("优先根据错误摘要修正参数/权限/路径后重新开始。");
      suggestions.push("如需快速定位，先打开关联对话复现本次执行轨迹。");
    }
    if (status === "completed" && !task.deliverables?.length) {
      suggestions.push("建议补充交付物摘要，便于后续复盘与共享。");
    }
    return suggestions.slice(0, 3);
  })();

  // 区块渲染器
  const renderSection = (section: SectionType) => {
    const isCollapsed = collapsedSections.has(section);

    switch (section) {
      // ====== 概览 ======
      case "overview":
        return (
          <TaskDetailOverviewSection
            task={task}
            assessment={assessment ?? null}
            dispatchStage={dispatchStage}
            status={status}
            executionStatusLabel={executionStatusLabel}
            primaryEntry={primaryEntry}
            nextStepSuggestions={nextStepSuggestions}
            editingDesc={editingDesc}
            descDraft={descDraft}
            opLoading={opLoading}
            setEditingDesc={setEditingDesc}
            setDescDraft={setDescDraft}
            handleSaveDescription={handleSaveDescription}
            copyToClipboard={copyToClipboard}
            onOpenThread={onOpenThread}
            emitSwitchToThread={emitSwitchToThread}
          />
        );

      // ====== 进展 ======
      case "progress":
        if (
          typeof task.progress !== "number" &&
          !task.progress_message &&
          !task.ui_blocks?.length &&
          !task.blocked_reason &&
          !(task.missing_information && task.missing_information.length > 0) &&
          taskStatusHistory.length === 0
        ) return null;
        return (
          <SectionWrapper key="progress" title={t("task.detail.sectionProgress")} section="progress" collapsed={isCollapsed} onToggle={toggleSection}>
            <div className="space-y-2">
              {typeof task.progress === "number" && (
                <div className="flex items-center gap-3">
                  <Progress value={task.progress} className="h-2 flex-1" />
                  <span className="text-sm font-medium tabular-nums w-10 text-right">{task.progress}%</span>
                </div>
              )}
              {task.progress_message && (
                <p className="text-sm text-muted-foreground">{task.progress_message}</p>
              )}
              {task.blocked_reason && (
                <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
                  阻塞原因：{task.blocked_reason}
                </div>
              )}
              {(task.blocked_at || task.recovered_at) && (
                <div className="rounded border border-border/50 bg-muted/20 px-2 py-1 text-xs text-muted-foreground">
                  {task.blocked_at ? `阻塞时间：${new Date(task.blocked_at).toLocaleString("zh-CN")}` : "阻塞时间：—"}
                  {task.recovered_at ? ` · 恢复时间：${new Date(task.recovered_at).toLocaleString("zh-CN")}` : ""}
                </div>
              )}
              {task.missing_information && task.missing_information.length > 0 && (
                <div className="rounded border border-border/50 bg-muted/20 px-2 py-1">
                  <div className="text-xs text-muted-foreground mb-1">待补充信息</div>
                  <ul className="list-disc list-inside space-y-0.5 text-xs text-muted-foreground">
                    {task.missing_information.slice(0, 6).map((item, idx) => (
                      <li key={`${item}-${idx}`}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
              {nextStepSuggestions.length > 0 && (
                <div className="rounded border border-primary/30 bg-primary/5 px-2 py-1">
                  <div className="text-xs text-primary mb-1">推荐下一步</div>
                  <ul className="list-disc list-inside space-y-0.5 text-xs text-muted-foreground">
                    {nextStepSuggestions.map((item, idx) => (
                      <li key={`next-step-${idx}`}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
              {(task.splittable || (task.total_units != null && task.total_units > 0)) && (
                <p className="text-xs text-muted-foreground">
                  单元进度：{task.claimed_units ?? 0} / {task.total_units ?? 0}
                  {task.unit_label ? ` ${task.unit_label}` : ""}
                </p>
              )}

              {/* 后端下发的生成式 UI 区块（统一渲染器） */}
              {task.ui_blocks?.map((block, idx) => {
                if (!block || typeof block !== "object") return null;
                const normalized = {
                  type: block.type,
                  title: block.title,
                  ...(block.data && typeof block.data === "object" ? block.data : {}),
                } as any;
                return <GenerativeUI key={`ui-${idx}`} ui={normalized} />;
              })}

              {taskStatusHistory.length > 0 && (
                <div className="mt-2 rounded-md border border-border/40 bg-muted/20 p-2">
                  <div className="mb-1 text-[11px] text-muted-foreground">状态历史</div>
                  <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                    {taskStatusHistory.slice().reverse().map((h, idx) => (
                      <li key={idx}>
                        {h.at_ms ? new Date(h.at_ms).toLocaleString("zh-CN") : ""} {h.from || "—"} → {h.to || "—"}
                        {h.source ? `（${h.source}）` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {groupedProgressEvents.length > 0 && (
                <div className="mt-2 rounded-md border border-border/40 bg-muted/20 p-2">
                  <div className="mb-1 text-[11px] text-muted-foreground">事件时间线</div>
                  <div className="space-y-1.5">
                    {groupedProgressEvents.map((g) => (
                      <div key={`timeline-${g.bucket}`} className="space-y-1">
                        <div className="px-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">{g.bucket}</div>
                        {g.items.map((item, idx) => (
                          <div
                            key={`timeline-item-${g.bucket}-${idx}`}
                            role="button"
                            tabIndex={0}
                            className="group/event flex items-start gap-2 rounded px-2 py-1 text-[11px] text-muted-foreground bg-background/60 border border-border/20 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() => {
                              if (item.thread_id) {
                                onOpenThread?.(item.thread_id);
                                emitSwitchToThread(item.thread_id!, task.id, task.status);
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                if (item.thread_id) {
                                  onOpenThread?.(item.thread_id);
                                  emitSwitchToThread(item.thread_id!, task.id, task.status);
                                }
                              }
                            }}
                            title={item.thread_id ? "回车打开关联对话" : "事件记录"}
                          >
                            <span className="flex-1 min-w-0 text-foreground/90">{item.label}</span>
                            {item.ts ? <span className="shrink-0"> · {formatShortTime(item.ts)}</span> : null}
                            <button
                              type="button"
                              className="opacity-0 group-hover/event:opacity-100 shrink-0 p-0.5 rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={(e) => {
                                e.stopPropagation();
                                copyToClipboard(item.label, "已复制");
                              }}
                              title={t("common.copy")}
                              aria-label={t("common.copy")}
                            >
                              <Copy className="size-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </SectionWrapper>
        );

      // ====== 成员 ======
      case "members":
        return (
          <SectionMembersSection
            key="members"
            agentName={agentName}
            isCollapsed={isCollapsed}
            onToggle={toggleSection}
          />
        );

      // ====== 协作链路 ======
      case "collaboration":
        if (!displayCollabRows.length) return null;
        return (
          <SectionWrapper key="collaboration" title={`协作链路 (${displayCollabRows.length})`} section="collaboration" collapsed={isCollapsed} onToggle={toggleSection}>
            <div className="space-y-2">
              {collaborationMeta.sourceLabel ? (
                <div className="text-[11px] text-muted-foreground">
                  数据来源：{collaborationMeta.sourceLabel}
                  {collaborationMeta.updatedAt ? ` · 更新于 ${new Date(collaborationMeta.updatedAt).toLocaleTimeString("zh-CN", { hour12: false })}` : ""}
                </div>
              ) : null}
              {(lineageInfo.rootTask || lineageInfo.parentTask || lineageInfo.siblingTasks.length > 0 || lineageInfo.childTasks.length > 0) && (
                <div className="rounded-md border border-primary/30 bg-primary/5 p-2 text-xs">
                  <div className="font-medium text-primary mb-1">回溯链路</div>
                  <div className="mb-2 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                    {lineageInfo.rootTask ? (
                      <>
                        <button
                          type="button"
                          className="underline-offset-2 hover:underline"
                          onClick={() => {
                            const rt = lineageInfo.rootTask!;
                            window.dispatchEvent(new CustomEvent(EVENTS.OPEN_TASK_IN_EDITOR, { detail: { taskId: rt.id, subject: rt.subject ?? "根任务" } }));
                          }}
                        >
                          根任务
                        </button>
                        <span>→</span>
                      </>
                    ) : null}
                    {lineageInfo.parentTask ? (
                      <>
                        <button
                          type="button"
                          className="underline-offset-2 hover:underline"
                          onClick={() => {
                            const p = lineageInfo.parentTask!;
                            window.dispatchEvent(new CustomEvent(EVENTS.OPEN_TASK_IN_EDITOR, { detail: { taskId: p.id, subject: p.subject ?? "父任务" } }));
                          }}
                        >
                          父任务
                        </button>
                        <span>→</span>
                      </>
                    ) : null}
                    <span className="font-medium text-foreground">当前任务</span>
                    {lineageInfo.childTasks.length > 0 ? <span>→</span> : null}
                    {lineageInfo.childTasks.length > 0 ? <span>子任务</span> : null}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {lineageInfo.parentTask ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[11px]"
                        onClick={() => {
                          const p = lineageInfo.parentTask!;
                          window.dispatchEvent(new CustomEvent(EVENTS.OPEN_TASK_IN_EDITOR, { detail: { taskId: p.id, subject: p.subject ?? "父任务" } }));
                        }}
                      >
                        打开父任务
                      </Button>
                    ) : null}
                    {lineageInfo.siblingTasks.map((s) => (
                      <Button
                        key={`sibling-${s.id}`}
                        size="sm"
                        variant="outline"
                        className="h-6 text-[11px]"
                        onClick={() => {
                          window.dispatchEvent(new CustomEvent(EVENTS.OPEN_TASK_IN_EDITOR, { detail: { taskId: s.id, subject: s.subject ?? "同批任务" } }));
                        }}
                      >
                        同批：{String(s.subject || s.id).slice(0, 10)}
                      </Button>
                    ))}
                    {lineageInfo.childTasks.map((c) => (
                      <Button
                        key={`child-${c.id}`}
                        size="sm"
                        variant="outline"
                        className="h-6 text-[11px]"
                        onClick={() => {
                          window.dispatchEvent(new CustomEvent(EVENTS.OPEN_TASK_IN_EDITOR, { detail: { taskId: c.id, subject: c.subject ?? "子任务" } }));
                        }}
                      >
                        子：{String(c.subject || c.id).slice(0, 10)}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              {displayCollabRows.map(({ row, loadLevel, activeCount, contribution, completedCount, failureRate, avgDurationMinutes }, idx) => {
                const parentAgent = String(row.parent_agent_id || "parent").trim();
                const childAgent = String(row.role || "worker").trim();
                const childThreadId = String(row.child_agent_id || "").trim();
                const taskThreadId = String(task.thread_id || "").trim();
                const linkedThread = taskThreadId || childThreadId;
                return (
                  <div key={`${row.ts || "ts"}-${idx}`} className="rounded-md border border-border/50 bg-muted/20 p-2 text-xs">
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                      <span className="font-medium">{parentAgent}</span>
                      <span className="text-muted-foreground">→</span>
                      <span className="font-medium">{childAgent}</span>
                      <span className="text-muted-foreground">→</span>
                      <code className="text-[10px] text-muted-foreground">{linkedThread || "未绑定线程"}</code>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                      <span>负载：{loadLevel}（{activeCount} 个执行中）</span>
                      <span>贡献分：{contribution}</span>
                      {typeof completedCount === "number" ? <span>完成：{completedCount}</span> : null}
                      {typeof failureRate === "number" ? <span>失败率：{Math.round(failureRate * 100)}%</span> : null}
                      {typeof avgDurationMinutes === "number" ? <span>平均时长：{Math.round(avgDurationMinutes)} 分钟</span> : null}
                      {row.reason ? <span>触发：{row.reason}</span> : null}
                    </div>
                    {linkedThread ? (
                      <div className="mt-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[11px]"
                          onClick={() => {
                            onOpenThread?.(linkedThread);
                            emitSwitchToThread(linkedThread, task.id, task.status);
                          }}
                        >
                          <MessageSquare className="h-3 w-3 mr-1" />
                          打开子线程
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </SectionWrapper>
        );

      // ====== 人类检查点 ======
      case "checkpoints": {
        if (!task.human_checkpoints?.length) return null;
        const pendingCount = task.human_checkpoints.filter((cp: any) => String(cp?.status || "pending") === "pending").length;
        return (
          <SectionWrapper key="checkpoints" title={`人类检查点 (${task.human_checkpoints.length})`} section="checkpoints" collapsed={isCollapsed} onToggle={toggleSection}>
            {pendingCount > 0 && (
              <div className="mb-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
                待人工确认：{pendingCount} 个检查点
              </div>
            )}
            <ul className="space-y-1.5">
              {task.human_checkpoints.map((cp, i) => (
                <li key={cp.checkpoint_id ?? String(i)} className="flex items-start gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    {cp.after_step && <span className="font-medium">步骤 {cp.after_step} 后</span>}
                    {cp.action && <span className="text-muted-foreground"> · {cp.action}</span>}
                    {cp.status && (
                      <Badge variant="outline" className="ml-1 text-[10px]">
                        {cp.status === "approved" ? "已通过" : cp.status === "rejected" ? "已驳回" : "待确认"}
                      </Badge>
                    )}
                    {cp.description && <p className="text-xs text-muted-foreground mt-0.5">{cp.description}</p>}
                    {String(cp.status || "pending") === "pending" && (() => {
                      const cpKey = cp.checkpoint_id ?? `checkpoint_${i}`;
                      const cpOpKey = `cp_${String(cp.checkpoint_id || `checkpoint-${i}`)}`;
                      const feedback = checkpointFeedback[cpKey] ?? "";
                      const clearFeedback = () => setCheckpointFeedback((prev) => ({ ...prev, [cpKey]: "" }));
                      return (
                      <>
                        <textarea
                          placeholder={t("task.detail.checkpointNotePlaceholder")}
                          className="mt-2 w-full min-h-[52px] rounded border border-border/60 bg-muted/30 px-2 py-1.5 text-xs placeholder:text-muted-foreground/70 resize-y"
                          value={feedback}
                          onChange={(e) => setCheckpointFeedback((prev) => ({ ...prev, [cpKey]: e.target.value }))}
                          aria-label={t("task.detail.checkpointNoteAria")}
                        />
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <Button
                            size="sm"
                            className="h-6 text-[11px]"
                            disabled={!!opLoading[cpOpKey]}
                            onClick={() => { handleCheckpointDecision(String(cp.checkpoint_id || `checkpoint-${i}`), "approve", feedback); clearFeedback(); }}
                            aria-label={`通过检查点 ${cpKey}`}
                          >
                            通过
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-[11px]"
                            disabled={!!opLoading[cpOpKey]}
                            onClick={() => { handleCheckpointDecision(String(cp.checkpoint_id || `checkpoint-${i}`), "revise", feedback); clearFeedback(); }}
                            aria-label={`要求修订检查点 ${cpKey}`}
                          >
                            要求修订
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-6 text-[11px]"
                            disabled={!!opLoading[cpOpKey]}
                            onClick={() => { handleCheckpointDecision(String(cp.checkpoint_id || `checkpoint-${i}`), "reject", feedback); clearFeedback(); }}
                            aria-label={`驳回检查点 ${cpKey}`}
                          >
                            驳回
                          </Button>
                          {Array.isArray((cp as any).options) && (cp as any).options.includes("delegate") && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 text-[11px]"
                              disabled={!!opLoading[cpOpKey]}
                              onClick={() => { handleCheckpointDecision(String(cp.checkpoint_id || `checkpoint-${i}`), "delegate", feedback); clearFeedback(); }}
                              aria-label={`委派检查点 ${cpKey}`}
                            >
                              委派
                            </Button>
                          )}
                          {Array.isArray((cp as any).options) && (cp as any).options.includes("skip") && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 text-[11px]"
                              disabled={!!opLoading[cpOpKey]}
                              onClick={() => { handleCheckpointDecision(String(cp.checkpoint_id || `checkpoint-${i}`), "skip", feedback); clearFeedback(); }}
                              aria-label={`跳过检查点 ${cpKey}`}
                            >
                              跳过
                            </Button>
                          )}
                        </div>
                      </>
                    ); })()}
                  </div>
                </li>
              ))}
            </ul>
            {(task.human_reviews?.length ?? 0) > 0 && (
              <div className="mt-3 space-y-1">
                <div className="text-xs text-muted-foreground">审核记录</div>
                {task.human_reviews!.slice(-3).reverse().map((r, idx) => (
                  <div key={`${r.checkpoint_id || "cp"}-${idx}`} className="rounded border border-border/50 bg-background/50 px-2 py-1 text-xs">
                    <span>{r.decision === "approve" ? "通过" : r.decision === "reject" ? "驳回" : r.decision || "已处理"}</span>
                    {r.checkpoint_id ? <span className="text-muted-foreground"> · {r.checkpoint_id}</span> : null}
                    {r.feedback ? <span className="text-muted-foreground"> · {r.feedback}</span> : null}
                  </div>
                ))}
              </div>
            )}
            {(task.decision_points?.length ?? 0) > 0 && (
              <div className="mt-3 space-y-1">
                <div className="text-xs text-muted-foreground">决策点输出</div>
                {task.decision_points!.slice(-3).reverse().map((d, idx) => (
                  <div key={`${d.type || "decision"}-${idx}`} className="rounded border border-border/50 bg-background/50 px-2 py-1 text-xs">
                    <span>{d.type || "decision"}</span>
                    {d.checkpoint_id ? <span className="text-muted-foreground"> · {d.checkpoint_id}</span> : null}
                    {d.decision ? <span className="text-muted-foreground"> · {d.decision}</span> : null}
                    {d.reason ? <span className="text-muted-foreground"> · {d.reason}</span> : null}
                    {d.summary ? <span className="text-muted-foreground"> · {d.summary}</span> : null}
                  </div>
                ))}
              </div>
            )}
          </SectionWrapper>
        );
      }

      // ====== 关联对话 ======
      case "thread":
        return (
          <SectionThreadSection
            key="thread"
            threadId={task.thread_id}
            taskId={task.id}
            taskStatus={task.status}
            isCollapsed={isCollapsed}
            onToggle={toggleSection}
            onOpenThread={onOpenThread}
            emitSwitchToThread={emitSwitchToThread}
          />
        );

      // ====== 产出 ======
      case "deliverables": {
        if (!task.deliverables?.length && !task.changed_files?.length && !task.rollback_hint) return null;
        const deliverablesCount = (task.deliverables?.length || 0) + (task.changed_files?.length || 0);
        return (
          <SectionWrapper key="deliverables" title={`产出 (${deliverablesCount})`} section="deliverables" collapsed={isCollapsed} onToggle={toggleSection}>
            {task.deliverables?.length ? (
              <ul className="space-y-1">
                {task.deliverables.map((d, i) => (
                  <li key={i} className="flex items-center gap-2 text-sm">
                    <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="flex-1 truncate">{d}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-xs shrink-0"
                      onClick={() => {
                        if (!navigator.clipboard?.writeText) {
                          toast.error(t("task.detail.copyNotSupported"));
                          return;
                        }
                        navigator.clipboard.writeText(String(d)).then(() => toast.success(t("task.detail.copied")), () => toast.error(t("common.copyFailed")));
                      }}
                      aria-label={t("common.copy")}
                    >
                      <Copy className="h-3 w-3 mr-1" />
                      复制
                    </Button>
                    {onOpenFile && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-xs shrink-0"
                        onClick={() => onOpenFile(d)}
                      >
                        <ExternalLink className="h-3 w-3 mr-1" />
                        打开
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            {task.changed_files?.length ? (
              <div className="mt-3">
                <div className="text-xs text-muted-foreground mb-1">变更文件</div>
                <ul className="space-y-0.5">
                  {task.changed_files.slice(0, 20).map((file, idx) => (
                    <li key={`${file}-${idx}`} className="text-xs text-muted-foreground font-mono truncate">
                      {file}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {task.rollback_hint ? (
              <div className="mt-3 rounded border border-border/50 bg-muted/20 px-2 py-1 text-xs text-muted-foreground">
                回滚建议：{task.rollback_hint}
              </div>
            ) : null}
          </SectionWrapper>
        );
      }

      // ====== 结果 ======
      case "result":
        return (
          <TaskDetailResultSection
            task={task}
            status={status}
            resultIssueRecommendations={resultIssueRecommendations}
            resultKeywordHints={resultKeywordHints}
            isCollapsed={isCollapsed}
            onToggle={toggleSection}
            onOpenThread={onOpenThread}
            emitSwitchToThread={emitSwitchToThread}
            resultSectionRef={resultSectionRef}
          />
        );

      // ====== 操作 ======
      case "actions":
        return (
          <TaskDetailActionsSection
            task={task}
            status={status}
            primaryEntry={primaryEntry}
            opLoading={opLoading}
            setOpLoading={setOpLoading}
            handleAction={handleAction}
            loadTask={loadTask}
            onOpenThread={onOpenThread}
            emitSwitchToThread={emitSwitchToThread}
            onScrollToCheckpoints={onScrollToCheckpoints}
            isUnmountedRef={isUnmountedRef}
          />
        );

      default:
        return null;
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0" role="region" aria-label={t("task.detail.regionAria")}>
      <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-2 border-b border-border/20 bg-muted/30">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <h1 className="text-sm font-medium truncate min-w-0" id="task-detail-title">
            {task.subject ?? "未命名任务"}
          </h1>
          <span className={cn("shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium", getTaskStatusBadgeClass(status))}>
            {getTaskStatusLabel(status)}
          </span>
        </div>
        {onClose && (
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 h-7 px-2 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            onClick={onClose}
            title={t("editor.closeTabTitle")}
            aria-label={t("editor.closeTaskAria")}
          >
            <X className="h-3.5 w-3.5 mr-1" />
            关闭
          </Button>
        )}
      </div>
      <ScrollArea className="flex-1">
        <div className="max-w-2xl mx-auto px-6 py-6 space-y-1" aria-labelledby="task-detail-title">
          {template.sections
            .filter((section) => !(section === "actions" && ["running", "blocked", "waiting_human", "failed", "paused"].includes(status)))
            .map((section) => {
              const content = renderSection(section);
              return content ? <React.Fragment key={section}>{content}</React.Fragment> : null;
            })
            .filter(Boolean)}
        </div>
      </ScrollArea>
      {["running", "blocked", "waiting_human", "failed", "paused"].includes(status) && (
        <div className="shrink-0 sticky bottom-0 border-t border-border/40 bg-background/95 backdrop-blur-sm px-4 py-3">
          {renderSection("actions")}
        </div>
      )}
      <AlertDialog open={cancelConfirmOpen} onOpenChange={setCancelConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认取消</AlertDialogTitle>
            <AlertDialogDescription>确定取消该任务？取消后将停止当前执行流程。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>暂不</AlertDialogCancel>
            <AlertDialogAction onClick={performCancel} disabled={!!opLoading['cancel']}>确定取消</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ============================================================================
// 可折叠区块包装器
// ============================================================================

function SectionWrapper({
  title,
  section,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  section: SectionType;
  collapsed: boolean;
  onToggle: (s: SectionType) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-border/40 rounded-lg overflow-hidden" data-section={section}>
      <button
        type="button"
        id={`section-${section}-heading`}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={() => onToggle(section)}
        aria-expanded={!collapsed}
        aria-controls={`section-${section}`}
        aria-label={collapsed ? `展开${title}` : `折叠${title}`}
      >
        {collapsed ? <ChevronRight className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
        {title}
      </button>
      {!collapsed && (
        <div id={`section-${section}`} className="px-4 pb-3" role="region" aria-labelledby={`section-${section}-heading`}>
          {children}
        </div>
      )}
    </div>
  );
}

const SectionMembersSection = React.memo(function SectionMembersSection({
  agentName,
  isCollapsed,
  onToggle,
}: {
  agentName: string;
  isCollapsed: boolean;
  onToggle: (s: SectionType) => void;
}) {
  return (
    <SectionWrapper title={t("task.detail.sectionMembers")} section="members" collapsed={isCollapsed} onToggle={onToggle}>
      <div className="flex items-center gap-2 text-sm">
        <User className="h-4 w-4 text-muted-foreground" />
        <span>执行者：{agentName}</span>
        <Badge variant="outline" className="text-[10px]">本机</Badge>
      </div>
    </SectionWrapper>
  );
});

const SectionThreadSection = React.memo(function SectionThreadSection({
  threadId,
  taskId,
  taskStatus,
  isCollapsed,
  onToggle,
  onOpenThread,
  emitSwitchToThread,
}: {
  threadId?: string | null;
  taskId: string;
  taskStatus?: string;
  isCollapsed: boolean;
  onToggle: (s: SectionType) => void;
  onOpenThread?: (threadId: string) => void;
  emitSwitchToThread: (threadId: string, relatedTaskId?: string, relatedStatus?: string) => void;
}) {
  return (
    <SectionWrapper title={t("task.detail.sectionThread")} section="thread" collapsed={isCollapsed} onToggle={onToggle}>
      {threadId ? (
        <div className="flex items-center gap-2">
          <code className="text-xs font-mono text-muted-foreground">{threadId.slice(0, 12)}…</code>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            onClick={() => {
              onOpenThread?.(threadId);
              emitSwitchToThread(threadId, taskId, taskStatus);
            }}
            aria-label={t("task.detail.openThreadAria")}
          >
            <MessageSquare className="h-3 w-3 mr-1" />
            打开对话
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">尚未关联对话，开始执行后自动创建。</p>
      )}
    </SectionWrapper>
  );
});

// ============================================================================
// 各区块 memo 组件（section 间互不牵动重渲染）
// ============================================================================

const TaskDetailOverviewSection = React.memo(function TaskDetailOverviewSection(props: {
  task: BoardTask;
  assessment: AssessmentResult | null;
  dispatchStage: { label: string; className: string };
  status: string;
  executionStatusLabel: string;
  primaryEntry: { label: string; reason?: string; kind: string };
  nextStepSuggestions: string[];
  editingDesc: boolean;
  descDraft: string;
  opLoading: Record<string, boolean>;
  setEditingDesc: (v: boolean) => void;
  setDescDraft: (v: string) => void;
  handleSaveDescription: () => void;
  copyToClipboard: (text: string, label: string) => void;
  onOpenThread?: (threadId: string) => void;
  emitSwitchToThread: (threadId: string, relatedTaskId?: string, relatedStatus?: string) => void;
}) {
  const {
    task,
    assessment,
    dispatchStage,
    status,
    executionStatusLabel,
    primaryEntry,
    nextStepSuggestions,
    editingDesc,
    descDraft,
    opLoading,
    setEditingDesc,
    setDescDraft,
    handleSaveDescription,
    copyToClipboard,
    onOpenThread,
    emitSwitchToThread,
  } = props;
  return (
    <div key="overview" className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold leading-tight">{task.subject ?? "未命名任务"}</h2>
          {(task.description || editingDesc) ? (
            <div className="relative group/desc mt-1">
              {editingDesc ? (
                <div className="space-y-2">
                  <Textarea
                    value={descDraft}
                    onChange={(e) => setDescDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setDescDraft(task.description ?? "");
                        setEditingDesc(false);
                      }
                      if (e.key === "Enter" && e.ctrlKey) handleSaveDescription();
                    }}
                    className="min-h-[80px] text-sm resize-y"
                    placeholder={t("task.detail.descriptionPlaceholder")}
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleSaveDescription} disabled={!!opLoading["desc"]}>
                      保存
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setDescDraft(task.description ?? ""); setEditingDesc(false); }}>
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="text-sm text-muted-foreground prose prose-sm dark:prose-invert max-w-none prose-p:leading-[1.65] prose-p:my-1 prose-li:my-0 prose-headings:font-semibold prose-headings:tracking-tight prose-blockquote:border-l-primary prose-blockquote:bg-muted/30 prose-blockquote:py-1 prose-code:rounded prose-code:bg-muted/60 prose-code:px-1.5 prose-code:py-0.5">
                    <ReactMarkdown remarkPlugins={[...remarkPluginsWithMath]} rehypePlugins={[...rehypePluginsMath]}>{task.description || ""}</ReactMarkdown>
                  </div>
                  <button
                    type="button"
                    className="absolute top-0 right-0 opacity-0 group-hover/desc:opacity-100 p-1 rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-all"
                    onClick={() => { setDescDraft(task.description ?? ""); setEditingDesc(true); }}
                    title={t("task.detail.editDescriptionTitle")}
                    aria-label={t("task.detail.editDescriptionAria")}
                  >
                    <Pencil className="size-3" />
                  </button>
                </>
              )}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Badge variant="outline" className={cn("border", dispatchStage.className)}>
            {dispatchStage.label}
          </Badge>
          <Badge variant="outline" className={cn(getTaskStatusBadgeClass(status))}>
            {getTaskStatusLabel(status)}
          </Badge>
          {executionStatusLabel ? (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              {executionStatusLabel}
            </Badge>
          ) : null}
        </div>
      </div>
      {["awaiting_plan_confirm", "blocked", "waiting_human", "failed", "running", "claimed"].includes(status) && primaryEntry.reason && (
        <div className="mt-2 px-2.5 py-1.5 rounded-md bg-muted/50 border border-border/50 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">推荐：{primaryEntry.label}</span>
          <span className="ml-1">{primaryEntry.reason}</span>
        </div>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span title={t("task.detail.priorityTitle")}>优先级 {PRIORITY_LABEL(task.priority)}</span>
        {task.skill_profile && <span>场景 {task.skill_profile}</span>}
        {task.cost_tier && <span>成本 {COST_TIER_LABEL[task.cost_tier] ?? task.cost_tier}</span>}
        {task.source_channel && <span>渠道 {task.source_channel === "local" ? "本地" : task.source_channel}</span>}
        <span className="flex items-center gap-1">
          ID
          <code className="font-mono text-[10px]">{task.id.slice(0, 8)}</code>
          <button type="button" onClick={() => copyToClipboard(task.id, "ID")} className="hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded" title={t("task.detail.copyIdTitle")} aria-label={t("task.detail.copyTaskIdAria")}>
            <Copy className="h-3 w-3" />
          </button>
        </span>
      </div>
      {(task.skill_hints?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1">
          <span className="text-xs text-muted-foreground mr-1">沉淀技能提示</span>
          {task.skill_hints!.slice(0, 8).map((h) => (
            <Badge key={`hint-${h}`} variant="outline" className="text-[10px]">{h}</Badge>
          ))}
        </div>
      )}
      <div className="rounded border border-primary/30 bg-primary/5 px-2 py-1.5 text-xs">
        <div className="text-primary mb-1">推荐入口：{primaryEntry.label}</div>
        <div className="text-muted-foreground mb-1">{primaryEntry.reason}</div>
        {primaryEntry.kind === "open_thread" && task.thread_id ? (
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[11px]"
            onClick={() => {
              onOpenThread?.(task.thread_id!);
              emitSwitchToThread(task.thread_id!, task.id, task.status);
            }}
          >
            {primaryEntry.label}
          </Button>
        ) : null}
      </div>
      <div className="flex gap-4 text-[11px] text-muted-foreground">
        <span>创建 {task.created_at ? new Date(task.created_at).toLocaleString("zh-CN") : "—"}</span>
        <span>更新 {task.updated_at ? new Date(task.updated_at).toLocaleString("zh-CN") : "—"}</span>
      </div>
      {assessment && (
        <div className="flex flex-wrap gap-3 text-xs">
          <span className={assessment.can_do ? "text-emerald-600" : "text-amber-600"}>
            匹配 {Math.round(assessment.skill_match * 100)}%
          </span>
          {assessment.estimated_time_minutes > 0 && (
            <span className="text-muted-foreground">预估 {assessment.estimated_time_minutes} 分钟</span>
          )}
          {assessment.matched_skills?.length > 0 && (
            <span className="text-muted-foreground">
              技能 {assessment.matched_skills.slice(0, 4).join(", ")}
              {assessment.matched_skills.length > 4 ? "…" : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
});

const TaskDetailResultSection = React.memo(function TaskDetailResultSection(props: {
  task: BoardTask;
  status: string;
  resultIssueRecommendations: string[];
  resultKeywordHints: string[];
  isCollapsed: boolean;
  onToggle: (s: SectionType) => void;
  onOpenThread?: (threadId: string) => void;
  emitSwitchToThread: (threadId: string, relatedTaskId?: string, relatedStatus?: string) => void;
  resultSectionRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { task, status, resultIssueRecommendations, resultKeywordHints, isCollapsed, onToggle, onOpenThread, emitSwitchToThread, resultSectionRef } = props;
  if (!task.result) return null;
  return (
    <div key="result-anchor" ref={resultSectionRef as React.RefObject<HTMLDivElement>}>
      <SectionWrapper key="result" title={t("task.detail.sectionResult")} section="result" collapsed={isCollapsed} onToggle={onToggle}>
        {status === "failed" && (
          <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px]">
            <div className="font-medium text-destructive mb-1">建议排查步骤</div>
            <ol className="list-decimal pl-4 space-y-0.5 text-muted-foreground">
              {resultIssueRecommendations.slice(0, 2).map((rec) => (
                <li key={rec}>{rec}</li>
              ))}
              {resultIssueRecommendations.length === 0 && (
                <li>先查看下方错误摘要，确认是工具参数、资源路径还是权限问题。</li>
              )}
              <li>若需复现上下文，打开关联对话查看执行轨迹与工具调用顺序。</li>
              <li>修正后可在操作区点击“重新开始”发起新一轮执行。</li>
            </ol>
            {task.thread_id ? (
              <div className="mt-2">
                <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => { onOpenThread?.(task.thread_id!); emitSwitchToThread(task.thread_id!, task.id, task.status); }}>
                  <MessageSquare className="h-3 w-3 mr-1" />打开对话复现
                </Button>
              </div>
            ) : null}
          </div>
        )}
        {status === "failed" && resultKeywordHints.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {resultKeywordHints.map((k) => (
              <Badge key={k} variant="outline" className="text-[10px]">可能问题：{k}</Badge>
            ))}
          </div>
        )}
        <div className="flex items-center justify-end gap-1 mb-1">
          <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => { const text = String(task?.result ?? ""); if (!navigator.clipboard?.writeText) { toast.error(t("task.detail.copyNotSupported")); return; } navigator.clipboard.writeText(text).then(() => toast.success(t("task.detail.copied")), () => toast.error(t("common.copyFailed"))); }} aria-label={t("task.detail.copyResultAria")}>
            <Copy className="h-3 w-3 mr-1" />复制
          </Button>
          <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => { const text = String(task?.result ?? ""); const safeTitle = (task?.subject ?? "result").replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, "_").slice(0, 40); window.dispatchEvent(new CustomEvent(EVENTS.OPEN_FILE_IN_EDITOR, { detail: { path: `__artifact__/${safeTitle}.md`, content: text, isVirtual: true } })); toast.success(t("task.detail.openedInEditor")); }} aria-label={t("task.detail.openInEditorAria")}>
            <ExternalLink className="h-3 w-3 mr-1" />在编辑器中打开
          </Button>
        </div>
        <div className="text-sm bg-muted/30 rounded-md p-3 max-h-96 overflow-auto prose prose-sm dark:prose-invert max-w-none prose-p:leading-[1.65] prose-p:my-1 prose-li:my-0 prose-headings:font-semibold prose-headings:tracking-tight prose-blockquote:border-l-primary prose-blockquote:bg-muted/30 prose-blockquote:py-1 prose-code:rounded prose-code:bg-muted/60 prose-code:px-1.5 prose-code:py-0.5">
          <ReactMarkdown remarkPlugins={[...remarkPluginsWithMath]} rehypePlugins={[...rehypePluginsMath]}>{String(task?.result ?? "")}</ReactMarkdown>
        </div>
      </SectionWrapper>
    </div>
  );
});

const TaskDetailActionsSection = React.memo(function TaskDetailActionsSection(props: {
  task: BoardTask;
  status: string;
  primaryEntry: { label: string; kind: string };
  opLoading: Record<string, boolean>;
  setOpLoading: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  handleAction: (action: "pause" | "cancel" | "resume" | "reset") => Promise<void>;
  loadTask: (getCancelled?: () => boolean) => Promise<void>;
  onOpenThread?: (threadId: string) => void;
  emitSwitchToThread: (threadId: string, relatedTaskId?: string, relatedStatus?: string) => void;
  onScrollToCheckpoints: () => void;
  isUnmountedRef: React.MutableRefObject<boolean>;
}) {
  const { task, status, primaryEntry, opLoading, setOpLoading, handleAction, loadTask, onOpenThread, emitSwitchToThread, onScrollToCheckpoints, isUnmountedRef } = props;
  const currentMode: ChatMode = resolveScopedChatMode(task?.thread_id);
  const modeAllowsExecute = currentMode !== "ask";
  return (
    <div key="actions" className="flex flex-wrap gap-2 pt-2">
      <p className="text-[11px] text-muted-foreground w-full basis-full" title={t("task.detail.modeTitle")}>
        {t("task.detail.currentMode")}：{t("modes." + currentMode)}，{modeAllowsExecute ? t("task.detail.modeExecuteHint") : t("task.detail.modeSuggestOnlyHint")}
      </p>
      {["available", "pending"].includes(status) && (
        <Button size="sm" onClick={() => {
          if (opLoading["start"]) return;
          setOpLoading((prev) => ({ ...prev, start: true }));
          import("../lib/api/tasks").then(({ tasksApi }) => {
            if (isUnmountedRef.current) return;
            const scene = task.skill_profile ?? "full";
            return tasksApi.create({ subject: task.subject, description: task.description || task.subject, priority: task.priority ?? 3, scene, skill_profile: scene, workspace_path: getCurrentWorkspacePathFromStorage() || undefined }).then(async (res) => {
              if (isUnmountedRef.current) return;
              if (res.ok && res.thread_id) {
                const updateRes = await boardApi.updateTask(task.id, { status: "running", thread_id: res.thread_id, scope: task.scope || "personal" });
                if (isUnmountedRef.current) return;
                if (!updateRes.ok) { toast.error(t("task.detail.startWriteBackFailed"), { description: updateRes.error || t("task.detail.stateUpdateFailed") }); return; }
                toast.success(t("task.detail.started"));
                loadTask(() => isUnmountedRef.current);
                onOpenThread?.(res.thread_id);
                emitSwitchToThread(res.thread_id, task.id, "running");
                return;
              }
              toast.error(t("task.detail.startFailed"), { description: t("task.detail.startFailedNoThread") });
            }).catch((e) => toast.error(t("task.detail.startFailed"), { description: e instanceof Error ? e.message : String(e) }));
          }).catch(() => { if (!isUnmountedRef.current) setOpLoading((prev) => ({ ...prev, start: false })); toast.error(t("task.detail.startFailed"), { description: t("task.detail.startFailedModule") }); }).finally(() => { if (!isUnmountedRef.current) setOpLoading((prev) => ({ ...prev, start: false })); });
        }} disabled={!!opLoading["start"]} className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
          {opLoading["start"] ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Play className="h-3.5 w-3.5 mr-1" />}开始执行
        </Button>
      )}
      {task.thread_id && (
        <Button size="sm" variant="outline" className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onClick={() => { onOpenThread?.(task.thread_id!); emitSwitchToThread(task.thread_id!, task.id, task.status); }} aria-label={primaryEntry.kind === "open_thread" ? "继续对话执行" : "打开对话"}>
          <MessageSquare className="h-3.5 w-3.5 mr-1" />{primaryEntry.kind === "open_thread" ? "继续对话执行" : "打开对话"}
        </Button>
      )}
      {status === "running" && (
        <>
          <Button size="sm" variant="outline" className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onClick={() => handleAction("pause")} disabled={!!opLoading["pause"]}><Pause className="h-3.5 w-3.5 mr-1" />暂停</Button>
          <Button size="sm" variant="outline" className="text-destructive focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onClick={() => handleAction("cancel")} disabled={!!opLoading["cancel"]}><XCircle className="h-3.5 w-3.5 mr-1" />取消</Button>
        </>
      )}
      {status === "awaiting_plan_confirm" && (
        <>
          {task.thread_id && <Button size="sm" variant="outline" className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onClick={() => { onOpenThread?.(task.thread_id!); emitSwitchToThread(task.thread_id!, task.id, task.status); }} aria-label={t("task.detail.openThreadConfirmPlanAria")}><MessageSquare className="h-3.5 w-3.5 mr-1" />{t("task.detail.openThreadConfirmPlan")}</Button>}
          <Button size="sm" variant="outline" className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onClick={() => handleAction("reset")} disabled={!!opLoading["reset"]}><RotateCcw className="h-3.5 w-3.5 mr-1" />重新开始</Button>
          <Button size="sm" variant="outline" className="text-destructive focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onClick={() => handleAction("cancel")} disabled={!!opLoading["cancel"]}><XCircle className="h-3.5 w-3.5 mr-1" />取消</Button>
        </>
      )}
      {status === "blocked" && (
        <>
          <Button size="sm" variant="outline" className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onClick={() => handleAction("reset")} disabled={!!opLoading["reset"]}><RotateCcw className="h-3.5 w-3.5 mr-1" />重新开始</Button>
          <Button size="sm" variant="outline" className="text-destructive focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onClick={() => handleAction("cancel")} disabled={!!opLoading["cancel"]}><XCircle className="h-3.5 w-3.5 mr-1" />取消</Button>
        </>
      )}
      {status === "waiting_human" && <Button size="sm" variant="outline" className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onClick={onScrollToCheckpoints}>审核检查点</Button>}
      {status === "completed" && (
        <Button size="sm" variant="outline" className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" disabled={!task.thread_id} title={task.thread_id ? undefined : t("task.detail.taskNotLinkedChat")} onClick={() => { if (!task.thread_id) { toast.info(t("task.detail.taskNotLinkedChat")); return; } onOpenThread?.(task.thread_id); emitSwitchToThread(task.thread_id, task.id, task.status); }}>查看产出</Button>
      )}
      {status === "paused" && (
        <>
          <Button size="sm" variant="outline" className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onClick={() => handleAction("resume")} disabled={!!opLoading["resume"]}><Play className="h-3.5 w-3.5 mr-1" />继续</Button>
          <Button size="sm" variant="outline" className="text-destructive focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onClick={() => handleAction("cancel")} disabled={!!opLoading["cancel"]}><XCircle className="h-3.5 w-3.5 mr-1" />取消</Button>
        </>
      )}
      {(status === "failed" || status === "cancelled") && (
        <Button size="sm" variant="outline" className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onClick={() => handleAction("reset")} disabled={!!opLoading["reset"]}><RotateCcw className="h-3.5 w-3.5 mr-1" />重新开始</Button>
      )}
      {task.thread_id && (
        <Button size="sm" variant="outline" className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onClick={() => { window.dispatchEvent(new CustomEvent(EVENTS.OPEN_SETTINGS)); setTimeout(() => { window.dispatchEvent(new CustomEvent(SETTINGS_PREFILL_EXEC_THREAD_EVENT, { detail: { threadId: task.thread_id } })); }, 150); }}>{t("task.detail.viewExecLog")}</Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => loadTask()} title={t("task.detail.refreshTitle")} aria-label={t("task.detail.refreshTaskAria")} className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"><RefreshCw className="h-3.5 w-3.5" /></Button>
    </div>
  );
});
