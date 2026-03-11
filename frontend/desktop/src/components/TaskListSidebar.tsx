/**
 * TaskListSidebar - 左侧栏折叠区内的紧凑任务列表
 *
 * 设计理念：
 * - 只展示关键信息（标题、状态、进度条）
 * - 点击任务 → 在编辑区打开 TaskDetailView
 * - 支持筛选与快速新建
 * - 占用空间极小，从左侧栏底部向上展开
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "./ui/button";
import { cn } from "./ui/utils";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { Progress } from "./ui/progress";
import {
  Plus,
  Play,
  RefreshCw,
  Loader2,
  Clock,
  CheckCircle2,
  XCircle,
  CircleDot,
  Pause,
  Search,
  ClipboardList,
  Star,
  MoreHorizontal,
  StopCircle,
  Trash2,
  Check,
  AlertTriangle,
  FileQuestion,
  MessageSquare,
} from "lucide-react";
import { toast } from "sonner";
import { boardApi, type BoardTask } from "../lib/api/boardApi";
import { createTaskWithDispatchFeedback } from "../lib/taskCreateWithDispatchFeedback";
import { getTaskStatusLabel, inferTaskDispatchStage, resolveTaskPrimaryEntryAction } from "../lib/taskDispatchStage";
import { EVENTS } from "../lib/constants";
import { getCurrentWorkspacePathFromStorage } from "../lib/sessionState";
import { formatRelativeTime } from "../lib/utils/formatters";
import { t } from "../lib/i18n";
import { useTaskStore } from "../store/taskStore";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

// ============================================================================
// 类型
// ============================================================================

export interface TaskListSidebarProps {
  /** 在编辑区打开任务详情 */
  onOpenTask: (taskId: string, subject: string) => void;
  /** 当前在编辑区打开的任务 ID（高亮） */
  activeTaskId?: string | null;
}

// ============================================================================
// 派发执行：FILL_PROMPT detail 单源，避免两处重复构造
// ============================================================================
function getDispatchExecuteDetail(task: BoardTask): { prompt: string; threadId?: string; autoSend: boolean } {
  const prompt = `请执行以下任务：${task.subject ?? ""}`;
  const hasThread = Boolean(task.thread_id?.trim());
  return hasThread && task.thread_id
    ? { prompt, threadId: task.thread_id, autoSend: true }
    : { prompt, autoSend: false };
}

// ============================================================================
// 状态标签
// ============================================================================

const STATUS_ICON: Record<string, React.ReactNode> = {
  available: <Clock className="h-3 w-3 text-blue-500" />,
  pending: <Clock className="h-3 w-3 text-blue-500" />,
  bidding: <CircleDot className="h-3 w-3 text-sky-500" />,
  claimed: <CircleDot className="h-3 w-3 text-indigo-500" />,
  running: <Loader2 className="h-3 w-3 animate-spin text-violet-500" />,
  completed: <CheckCircle2 className="h-3 w-3 text-emerald-500" />,
  failed: <XCircle className="h-3 w-3 text-red-500" />,
  paused: <Pause className="h-3 w-3 text-amber-500" />,
  cancelled: <XCircle className="h-3 w-3 text-gray-400" />,
  waiting_human: <Clock className="h-3 w-3 text-amber-500" />,
  blocked: <AlertTriangle className="h-3 w-3 text-amber-500" />,
  awaiting_plan_confirm: <FileQuestion className="h-3 w-3 text-sky-500" />,
};

// ============================================================================
// 组件
// ============================================================================

export function TaskListSidebar({ onOpenTask, activeTaskId }: TaskListSidebarProps) {
  const tasks = useTaskStore(
    useShallow((s) =>
      Object.values(s.tasksById).filter((t) => (t.scope || "personal") === "personal")
    )
  );
  const refreshTasks = useTaskStore((s) => s.refreshTasks);
  const [loading, setLoading] = useState(false);
  const [showLoadingSpinner, setShowLoadingSpinner] = useState(false);
  const loadingDelayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [workspaceScopeFilter, setWorkspaceScopeFilter] = useState<"all" | "current">("current");
  const [tabFilter, setTabFilter] = useState<"all" | "running" | "pending" | "done">("all");
  const [sortBy, setSortBy] = useState<"priority" | "created" | "updated">("updated");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createSubject, setCreateSubject] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createPriority, setCreatePriority] = useState(3);
  const [creating, setCreating] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (loadingDelayTimerRef.current) {
        clearTimeout(loadingDelayTimerRef.current);
        loadingDelayTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (loading) {
      loadingDelayTimerRef.current = setTimeout(() => {
        loadingDelayTimerRef.current = null;
        if (isMountedRef.current) setShowLoadingSpinner(true);
      }, 200);
    } else {
      if (loadingDelayTimerRef.current) {
        clearTimeout(loadingDelayTimerRef.current);
        loadingDelayTimerRef.current = null;
      }
      setShowLoadingSpinner(false);
    }
    return () => {
      if (loadingDelayTimerRef.current) {
        clearTimeout(loadingDelayTimerRef.current);
        loadingDelayTimerRef.current = null;
      }
    };
  }, [loading]);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await refreshTasks("personal", {
        workspacePath: workspaceScopeFilter === "current" ? (getCurrentWorkspacePathFromStorage() || undefined) : undefined,
      });
      if (!isMountedRef.current) return;
      if (res.ok) setLoadError(null);
      else {
        const msg = res.error || t("task.loadFailed");
        setLoadError(msg);
        toast.error(msg);
      }
    } catch (e) {
      if (!isMountedRef.current) return;
      const msg = e instanceof Error ? e.message : t("task.loadFailed");
      setLoadError(msg);
      toast.error(t("task.loadFailed"), { description: e instanceof Error ? e.message : undefined });
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [refreshTasks, workspaceScopeFilter]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    const onWorkspace = (e: Event) => {
      if (workspaceScopeFilter !== "current") return;
      const path = (e as CustomEvent<{ workspacePath?: string }>)?.detail?.workspacePath ?? getCurrentWorkspacePathFromStorage() ?? "";
      void refreshTasks("personal", { workspacePath: path || undefined });
    };
    window.addEventListener(EVENTS.WORKSPACE_CONTEXT_CHANGED, onWorkspace);
    return () => window.removeEventListener(EVENTS.WORKSPACE_CONTEXT_CHANGED, onWorkspace);
  }, [workspaceScopeFilter, refreshTasks]);

  useEffect(() => {
    const handler = () => loadTasks();
    window.addEventListener(EVENTS.TASK_PROGRESS, handler);
    return () => window.removeEventListener(EVENTS.TASK_PROGRESS, handler);
  }, [loadTasks]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadTasks();
      }
    }, 12000);
    return () => window.clearInterval(timer);
  }, [loadTasks]);

  const filtered = useMemo(() => {
    const statusFiltered =
      tabFilter === "all"
        ? [...tasks]
        : tabFilter === "running"
          ? tasks.filter((t) => ["running", "in_progress", "claimed"].includes(String(t.status ?? "").toLowerCase()))
          : tabFilter === "pending"
            ? tasks.filter((t) => ["available", "pending", "awaiting_plan_confirm", "blocked", "waiting_human"].includes(String(t.status ?? "").toLowerCase()))
            : tasks.filter((t) => ["completed", "done", "failed", "cancelled"].includes(String(t.status ?? "").toLowerCase()));
    const list = searchTerm.trim()
      ? statusFiltered.filter(
          (t) =>
            (t.subject ?? "").toLowerCase().includes(searchTerm.toLowerCase()) ||
            (t.id ?? "").includes(searchTerm)
        )
      : statusFiltered;
    const mult = sortOrder === "asc" ? 1 : -1;
    list.sort((a, b) => {
      if (sortBy === "priority") {
        const pa = a.priority ?? 0;
        const pb = b.priority ?? 0;
        return mult * (pa - pb);
      }
      if (sortBy === "created") {
        const ta = a.created_at ?? "";
        const tb = b.created_at ?? "";
        return mult * (ta.localeCompare(tb));
      }
      const ta = a.updated_at ?? a.created_at ?? "";
      const tb = b.updated_at ?? b.created_at ?? "";
      return mult * (ta.localeCompare(tb));
    });
    return list;
  }, [tasks, tabFilter, searchTerm, sortBy, sortOrder]);

  // 停止运行中任务
  const handleStopTask = useCallback(async (task: BoardTask) => {
    try {
      const runId = task.execution?.active_run_id;
      if (runId) {
        const res = await boardApi.cancelAutonomousRun(runId);
        if (res.ok) {
          toast.success(t("taskList.stopSent"));
          void loadTasks();
        } else {
          toast.error(res.error ?? t("taskList.stopFailed"));
        }
      } else {
        const prompt = t("taskList.stopTaskPrompt", { subject: task.subject ?? "" });
        const detail = task.thread_id?.trim() ? { prompt, threadId: task.thread_id } : { prompt };
        window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, { detail }));
      }
    } catch (e) {
      toast.error(t("taskList.operationFailed"));
    }
  }, [loadTasks]);

  // 取消/归档任务
  const handleCancelTask = useCallback(async (task: BoardTask) => {
    const previousStatus = task.status;
    try {
      const res = await boardApi.updateTask(task.id, { status: "cancelled" });
      if (res.ok) {
        void loadTasks();
        toast.success(t("taskList.cancelled"), {
          duration: 5000,
          action: {
            label: t("common.undo"),
            onClick: () => {
              boardApi.updateTask(task.id, { status: previousStatus }).then((r) => {
                if (r.ok) void loadTasks();
                else toast.error(r.error ?? t("taskList.restoreFailed"));
              }).catch(() => {
                toast.error(t("taskList.restoreFailed"));
                void loadTasks();
              });
            },
          },
        });
      } else {
        toast.error(res.error ?? t("taskList.cancelFailed"));
      }
    } catch (e) {
      toast.error(t("taskList.operationFailed"));
    }
  }, [loadTasks]);

  // 快速完成（内联勾选）
  const handleCompleteTask = useCallback(async (task: BoardTask) => {
    const previousStatus = task.status;
    try {
      const res = await boardApi.updateTask(task.id, { status: "completed" });
      if (res.ok) {
        void loadTasks();
        toast.success(t("taskList.completed"), {
          duration: 5000,
          action: {
            label: t("common.undo"),
            onClick: () => {
              boardApi.updateTask(task.id, { status: previousStatus }).then((r) => {
                if (r.ok) void loadTasks();
                else toast.error(r.error ?? t("taskList.restoreFailed"));
              }).catch(() => {
                toast.error(t("taskList.restoreFailed"));
                void loadTasks();
              });
            },
          },
        });
      } else {
        toast.error(res.error ?? t("taskList.operationFailed"));
      }
    } catch (e) {
      toast.error(t("taskList.operationFailed"));
    }
  }, [loadTasks]);

  // 删除（归档）任务
  const handleArchiveTask = useCallback(async (task: BoardTask) => {
    const previousStatus = task.status;
    try {
      const res = await boardApi.updateTask(task.id, { status: "cancelled" });
      if (!res.ok) {
        toast.error(res.error ?? t("taskList.deleteFailed"));
        return;
      }
      void loadTasks();
      toast.success(t("taskList.deleted"), {
        duration: 5000,
        action: {
          label: t("common.undo"),
          onClick: () => {
            boardApi.updateTask(task.id, { status: previousStatus }).then((r) => {
              if (r.ok) void loadTasks();
              else toast.error(r.error ?? t("taskList.restoreFailed"));
            }).catch(() => {
              toast.error(t("taskList.restoreFailed"));
              void loadTasks();
            });
          },
        },
      });
    } catch (e) {
      toast.error(t("taskList.operationFailed"));
    }
  }, [loadTasks]);

  const handleCreate = useCallback(async () => {
    if (!createSubject.trim()) return;
    setCreating(true);
    try {
      const res = await createTaskWithDispatchFeedback({
        subject: createSubject.trim(),
        description: createDescription.trim() || undefined,
        priority: createPriority,
        source: "task_list_sidebar",
        workspace_path: getCurrentWorkspacePathFromStorage() || undefined,
        onTaskCreated: (createdTask) => {
          if (!isMountedRef.current) return;
          useTaskStore.getState().setTask(createdTask);
          onOpenTask(createdTask.id, createdTask.subject ?? "任务");
        },
        onTasksSnapshot: (snapshot) => {
          if (!isMountedRef.current) return;
          useTaskStore.getState().setTasks(snapshot);
        },
        onOpenTask: (task) => {
          if (!isMountedRef.current) return;
          onOpenTask(task.id, task.subject ?? "任务");
        },
      });
      if (!res.ok) {
        toast.error(t("taskList.createFailed"), { description: res.error ?? t("common.unknownError") });
        return;
      }
      toast.success(res.message);
      setShowCreateDialog(false);
      setCreateSubject("");
      setCreateDescription("");
      setCreatePriority(3);
      await loadTasks();
    } catch (e) {
      toast.error(t("taskList.createTaskFailed"), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setCreating(false);
    }
  }, [createSubject, createDescription, createPriority, loadTasks, onOpenTask]);

  // 状态筛选 Tab：全部 / 进行中 / 待处理 / 已完成
  const filterTabs: { label: string; value: "all" | "running" | "pending" | "done" }[] = [
    { label: "全部", value: "all" },
    { label: "进行中", value: "running" },
    { label: "待处理", value: "pending" },
    { label: "已完成", value: "done" },
  ];

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 工具栏 */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border/20 shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <Input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={t("taskList.searchPlaceholder")}
            className="h-6 pl-6 text-xs bg-transparent border-none focus-visible:ring-0"
            aria-label={t("taskList.searchAria")}
          />
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 shrink-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          onClick={() => setShowCreateDialog(true)}
          title={t("taskList.newTaskTitle")}
          aria-label={t("taskList.newTaskAria")}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 shrink-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          onClick={loadTasks}
          title={t("taskList.refreshTitle")}
          aria-label={t("taskList.refreshListAria")}
          disabled={loading}
        >
          <RefreshCw className={`h-3 w-3 ${showLoadingSpinner ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* 工作区范围：全部 | 本工作区 */}
      <div className="flex items-center gap-1 px-2 py-0.5 shrink-0">
        <span className="text-[10px] text-muted-foreground shrink-0">范围</span>
        <div className="flex gap-0.5">
          {(["all", "current"] as const).map((scope) => (
            <button
              key={scope}
              type="button"
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                workspaceScopeFilter === scope
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
              )}
              onClick={() => setWorkspaceScopeFilter(scope)}
              aria-pressed={workspaceScopeFilter === scope}
              aria-label={scope === "all" ? "显示全部任务" : "仅本工作区任务"}
            >
              {scope === "all" ? "全部" : "本工作区"}
            </button>
          ))}
        </div>
      </div>
      {/* 筛选 Tab：全部 / 进行中 / 待处理 / 已完成 */}
      <div className="flex gap-0.5 px-2 py-1 shrink-0">
        {filterTabs.map((f) => (
          <button
            key={f.value}
            type="button"
            className={`text-[10px] px-2 py-1 rounded shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${
              tabFilter === f.value
                ? "bg-primary/10 text-primary font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
            }`}
            onClick={() => setTabFilter(f.value)}
            aria-pressed={tabFilter === f.value}
            aria-label={`筛选：${f.label}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {/* 排序 */}
      <div className="flex items-center gap-1 px-2 py-0.5 shrink-0">
        <select
          value={`${sortBy}-${sortOrder}`}
          onChange={(e) => {
            const v = e.target.value;
            const [by, order] = v.split("-") as ["priority" | "created" | "updated", "asc" | "desc"];
            setSortBy(by);
            setSortOrder(order);
          }}
          className="text-[10px] h-5 pl-1.5 pr-5 rounded border border-border/50 bg-transparent text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          aria-label={t("taskList.sortAria")}
        >
          <option value="updated-desc">最近更新</option>
          <option value="updated-asc">最早更新</option>
          <option value="created-desc">最近创建</option>
          <option value="created-asc">最早创建</option>
          <option value="priority-desc">优先级高→低</option>
          <option value="priority-asc">优先级低→高</option>
        </select>
      </div>

      {/* 列表 */}
      <ScrollArea className="flex-1 min-h-0">
        {loadError ? (
          <div className="mx-2 mt-2 rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate">{loadError}</span>
              <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={loadTasks}>
                {t("common.retry")}
              </Button>
            </div>
          </div>
        ) : null}
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 px-4 text-center text-muted-foreground" role="status" aria-live="polite" aria-label={t("taskList.emptyAria")}>
            <div className="w-14 h-14 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
              <ClipboardList className="h-7 w-7 opacity-60" aria-hidden />
            </div>
            <p className="text-sm font-medium text-foreground mb-1">{showLoadingSpinner ? t("common.loading") : loadError ? t("taskList.loadError") : t("taskList.noTasks")}</p>
            {!showLoadingSpinner && !loadError && <p className="text-xs text-muted-foreground mb-4">{t("taskList.emptyHint")}</p>}
            {!loading && (
              loadError ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs h-7 mt-2"
                  onClick={loadTasks}
                  aria-label={t("taskList.retryLoadAria")}
                >
                  <RefreshCw className="h-3 w-3 mr-1" />
                  {t("common.retry")}
                </Button>
              ) : (
                <div className="flex flex-col gap-2 w-full max-w-[160px] mt-2">
                  <Button
                    size="sm"
                    variant="default"
                    className="text-xs h-8 w-full"
                    onClick={() => window.dispatchEvent(new CustomEvent(EVENTS.NEW_THREAD_REQUEST))}
                    aria-label={t("taskList.startChatAria")}
                  >
                    <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
                    开始对话
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs h-7 w-full"
                    onClick={() => setShowCreateDialog(true)}
                    aria-label={t("task.createFirst")}
                  >
                    <Plus className="h-3.5 w-3.5 mr-1.5" />
                    新建任务
                  </Button>
                </div>
              )
            )}
          </div>
        ) : (
          <div className="py-0.5">
            {filtered.map((task) => {
              const isActive = activeTaskId === task.id || activeTaskId === task.task_id;
              const status = task.status ?? "available";
              const dispatchStage = inferTaskDispatchStage(task);
              const canDispatch = status === "pending" || status === "available";
              const canComplete = status === "pending" || status === "available" || status === "paused";
              const isRunning = status === "running";
              const hasThread = Boolean(task.thread_id?.trim());
              const primaryEntry = resolveTaskPrimaryEntryAction(task);
              const updatedAt = task.updated_at ?? task.created_at ?? "";
              const relativeTime = updatedAt ? formatRelativeTime(updatedAt) : "";
              const handlePrimary = () => {
                if (primaryEntry.kind === "open_thread" && task.thread_id) {
                  window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_TO_THREAD, { detail: { threadId: task.thread_id } }));
                  onOpenTask(task.id, task.subject ?? "任务");
                } else {
                  onOpenTask(task.id, task.subject ?? "任务");
                }
              };
              return (
                <div
                  key={task.id}
                  className={`group/task w-full px-2 py-1.5 flex items-center gap-2 transition-colors duration-150 border-l-2 ${
                    isActive ? "bg-primary/8 border-primary" : "hover:bg-sidebar-accent border-transparent"
                  }`}
                >
                  <button
                    type="button"
                    className="flex-1 min-w-0 text-left flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset rounded"
                    onClick={handlePrimary}
                    title={primaryEntry.label}
                    aria-label={task.subject ?? "未命名任务"}
                    aria-current={isActive ? "true" : undefined}
                  >
                    <span className="mt-0.5 shrink-0 opacity-70 group-hover/task:opacity-100">{STATUS_ICON[status] ?? <CircleDot className="h-3 w-3" />}</span>
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs truncate ${isActive ? "font-medium" : ""}`}>
                        {task.subject ?? "未命名"}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {relativeTime && (
                          <span className="text-[10px] text-muted-foreground shrink-0">{relativeTime}</span>
                        )}
                        <span className="text-[9px] text-muted-foreground/80 opacity-0 group-hover/task:opacity-100 transition-opacity">
                          {getTaskStatusLabel(status)}
                          {typeof task.priority === "number" && task.priority > 0 ? ` · P${task.priority}` : ""}
                        </span>
                      </div>
                    </div>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="opacity-0 group-hover/task:opacity-100 shrink-0 h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-all focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        title={t("threadList.moreActionsTitle")}
                        aria-label={t("taskList.moreActionsAria")}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[140px]">
                      <DropdownMenuItem
                        onClick={(e) => { e.stopPropagation(); onOpenTask(task.id, task.subject ?? "任务"); }}
                      >
                        <FileQuestion className="h-3.5 w-3.5 mr-2" />
                        打开任务详情
                      </DropdownMenuItem>
                      {hasThread && (
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            if (task.thread_id) {
                              window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_TO_THREAD, { detail: { threadId: task.thread_id } }));
                              onOpenTask(task.id, task.subject ?? "任务");
                            }
                          }}
                        >
                          <MessageSquare className="h-3.5 w-3.5 mr-2" />
                          打开对话
                        </DropdownMenuItem>
                      )}
                      {canComplete && (
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleCompleteTask(task); }}>
                          <Check className="h-3.5 w-3.5 mr-2" />
                          标记完成
                        </DropdownMenuItem>
                      )}
                      {isRunning && (
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleStopTask(task); }}>
                          <StopCircle className="h-3.5 w-3.5 mr-2" />
                          停止
                        </DropdownMenuItem>
                      )}
                      {canDispatch && (
                        <>
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, { detail: getDispatchExecuteDetail(task) }));
                            }}
                          >
                            <Play className="h-3.5 w-3.5 mr-2" />
                            派发执行
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleCancelTask(task); }}>
                            <XCircle className="h-3.5 w-3.5 mr-2" />
                            取消
                          </DropdownMenuItem>
                        </>
                      )}
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          window.dispatchEvent(new CustomEvent(EVENTS.OPEN_TASK_IN_CONSOLE, {
                            detail: { taskId: task.id, subject: task.subject ?? "任务", threadId: task.thread_id ?? null },
                          }));
                        }}
                        disabled={!hasThread}
                        title={!hasThread ? "该任务未关联对话，请先派发执行" : undefined}
                      >
                        <MessageSquare className="h-3.5 w-3.5 mr-2" />
                        在控制台查看
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={(e) => { e.stopPropagation(); handleArchiveTask(task); }}
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-2" />
                        删除
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>

      {/* 底部统计 */}
      <div className="flex items-center justify-between px-2 py-1 text-[10px] text-muted-foreground border-t border-border/20 shrink-0">
        <span>
          {searchTerm.trim()
            ? t("task.list.filteredCount", { filtered: filtered.length, total: tasks.length })
            : tabFilter !== "all"
              ? t("task.list.filteredSuffix", { n: tasks.length })
              : t("task.list.count", { n: tasks.length })}
        </span>
        <span>{tasks.filter((t) => t.status === "running").length} {t("task.list.running")}</span>
      </div>

      {/* 新建任务对话框 */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>新建任务</DialogTitle>
            <DialogDescription>创建一个新任务，后续可在详情页配置更多参数。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label htmlFor="task-subject" className="text-xs">任务名称</Label>
              <Input
                id="task-subject"
                value={createSubject}
                onChange={(e) => setCreateSubject(e.target.value)}
                placeholder={t("taskList.taskNamePlaceholder")}
                className="mt-1"
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && !creating && handleCreate()}
                autoFocus
              />
            </div>
            <div>
              <Label htmlFor="task-description" className="text-xs">描述（可选）</Label>
              <Textarea
                id="task-description"
                value={createDescription}
                onChange={(e) => setCreateDescription(e.target.value)}
                placeholder={t("taskList.taskContextPlaceholder")}
                className="mt-1 min-h-[60px] text-sm resize-none"
                rows={2}
              />
            </div>
            <div>
              <span className="text-xs text-muted-foreground">优先级</span>
              <div className="mt-1.5 flex items-center gap-0.5" role="group" aria-label={t("taskList.priorityStarsAria")}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="p-0.5 rounded text-muted-foreground hover:text-amber-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                    title={`${n} 星`}
                    onClick={() => setCreatePriority(n)}
                    aria-pressed={createPriority === n}
                  >
                    <Star
                      className={`h-5 w-5 ${createPriority >= n ? "fill-amber-500 text-amber-500" : ""}`}
                      aria-hidden
                    />
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)} className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">取消</Button>
            <Button onClick={handleCreate} disabled={creating || !createSubject.trim()} className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
              {creating && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
