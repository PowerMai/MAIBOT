/**
 * TaskExecutionPanel - 控制台内「当前任务」执行过程视图
 * 展示 progress、progress_message、status、结果摘要；支持跳转聊天/任务详情
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";
import { ScrollArea } from "./ui/scroll-area";
import { cn } from "./ui/utils";
import {
  Loader2,
  MessageSquare,
  ListTodo,
  X,
  AlertCircle,
} from "lucide-react";
import { boardApi, type BoardTask } from "../lib/api/boardApi";
import { EVENTS } from "../lib/constants";
import { getTaskStatusLabel } from "../lib/taskDispatchStage";
import { t } from "../lib/i18n";

const POLL_INTERVAL_MS = 2500;

export interface TaskExecutionPanelProps {
  taskId: string;
  threadId?: string | null;
  subject?: string;
  scope?: "personal" | "org" | "public";
  onClose?: () => void;
  /** 在编辑区打开任务详情 */
  onOpenTaskInEditor?: (taskId: string, subject: string) => void;
}

export function TaskExecutionPanel({
  taskId,
  threadId: initialThreadId,
  subject: initialSubject,
  scope = "personal",
  onClose,
  onOpenTaskInEditor,
}: TaskExecutionPanelProps) {
  const [task, setTask] = useState<BoardTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const stoppedRef = useRef(false);

  const fetchTask = useCallback(async () => {
    if (stoppedRef.current) return;
    const res = await boardApi.getTask(taskId, scope);
    if (stoppedRef.current) return;
    if (!res.ok) {
      if (!stoppedRef.current) {
        setError(res.error ?? t("execution.loadFailed"));
        setLoading(false);
      }
      return;
    }
    if (stoppedRef.current) return;
    setError(null);
    setTask(res.task ?? null);
    setLoading(false);
  }, [taskId, scope]);

  useEffect(() => {
    stoppedRef.current = false;
    setLoading(true);
    fetchTask();
    const t = setInterval(fetchTask, POLL_INTERVAL_MS);
    return () => {
      stoppedRef.current = true;
      clearInterval(t);
    };
  }, [fetchTask]);

  const handleOpenInChat = useCallback(() => {
    const tid = task?.thread_id ?? initialThreadId;
    if (tid) {
      window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_TO_THREAD, { detail: { threadId: tid } }));
    }
  }, [task?.thread_id, initialThreadId]);

  const handleOpenInEditor = useCallback(() => {
    const subj = task?.subject ?? initialSubject ?? "任务";
    onOpenTaskInEditor?.(taskId, subj);
  }, [taskId, task?.subject, initialSubject, onOpenTaskInEditor]);

  if (loading && !task) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 p-4 text-muted-foreground text-sm">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span>{t("execution.loadingTask")}</span>
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="h-full flex flex-col p-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h3 className="text-sm font-medium">{t("execution.panelTitle")}</h3>
          {onClose && (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} aria-label={t("execution.closeAria")}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
        <div className="flex-1 flex items-center justify-center text-sm text-destructive">
          {error ?? t("execution.taskNotFound")}
        </div>
      </div>
    );
  }

  const status = (task.status ?? "").trim().toLowerCase();
  const isRunning = status === "running" || status === "pending" || status === "claimed";
  const isDone = ["completed", "failed", "cancelled", "paused"].includes(status);
  const progress = typeof task.progress === "number" ? Math.max(0, Math.min(100, task.progress)) : 0;
  const statusLabel = getTaskStatusLabel(status);

  return (
    <div className="h-full flex flex-col min-h-0 bg-background">
      <div className="shrink-0 px-4 py-3 border-b flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium truncate flex items-center gap-2">
          <ListTodo className="h-4 w-4 text-primary shrink-0" />
          <span title={task.subject}>{task.subject || t("execution.taskSubjectFallback")}</span>
        </h3>
        {onClose && (
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose} aria-label={t("execution.closeAria")}>
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      <ScrollArea className="flex-1 min-h-0 px-4 py-3">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("execution.statusLabel")}</span>
            <span
              className={cn(
                "text-xs font-medium px-2 py-0.5 rounded",
                isRunning && "bg-primary/10 text-primary",
                status === "completed" && "bg-emerald-500/10 text-emerald-600",
                status === "failed" && "bg-destructive/10 text-destructive",
                status === "waiting_human" && "bg-amber-500/10 text-amber-600",
                !isRunning && !isDone && "bg-muted text-muted-foreground"
              )}
            >
              {statusLabel}
            </span>
            {isRunning && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
          </div>

          {(typeof task.progress === "number" || task.progress_message) && (
            <div className="space-y-1">
              {typeof task.progress === "number" && (
                <Progress value={progress} className="h-1.5" />
              )}
              {task.progress_message && (
                <p className="text-xs text-muted-foreground">{task.progress_message}</p>
              )}
            </div>
          )}

          {task.blocked_reason && (
            <div className="flex items-start gap-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs">
              <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <span>{task.blocked_reason}</span>
            </div>
          )}

          {task.result && (
            <div className="space-y-1">
              <h4 className="text-xs font-medium text-muted-foreground">{t("execution.resultSummary")}</h4>
              <div className="text-xs rounded-lg border bg-muted/30 p-2 max-h-32 overflow-y-auto whitespace-pre-wrap">
                {task.result.slice(0, 800)}
                {task.result.length > 800 ? "…" : ""}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="shrink-0 px-4 py-3 border-t flex flex-wrap gap-2">
        {task.thread_id && (
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={handleOpenInChat}>
            <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
            {t("execution.openInChat")}
          </Button>
        )}
        {onOpenTaskInEditor && (
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={handleOpenInEditor}>
            <ListTodo className="h-3.5 w-3.5 mr-1.5" />
            {t("execution.openInEditor")}
          </Button>
        )}
      </div>
    </div>
  );
}
