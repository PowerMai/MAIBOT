"use client";

import React, { useMemo, useState } from "react";
import type { FC } from "react";
import { Button } from "../ui/button";
import { cn } from "../ui/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { MoreHorizontal, CheckIcon, ListChecksIcon, ChevronDown, ChevronUp } from "lucide-react";
import { t } from "../../lib/i18n";
import { toast } from "sonner";
import { fileEventBus } from "../../lib/events/fileEvents";
import { summarizeFailureSeries, type RunSummaryState } from "./runTrackerConstants";

const ElapsedTimer: FC<{
  running: boolean;
  startedAt: number | null;
  initialElapsed: number;
}> = ({ running, startedAt, initialElapsed }) => {
  const [elapsed, setElapsed] = React.useState(initialElapsed);
  const initialElapsedRef = React.useRef(initialElapsed);
  initialElapsedRef.current = initialElapsed;
  React.useEffect(() => {
    if (!running || !startedAt) {
      setElapsed(initialElapsedRef.current);
      return;
    }
    const tick = () => {
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    };
    tick();
    const id = window.setInterval(tick, 2000);
    return () => window.clearInterval(id);
  }, [running, startedAt]);
  const display = running && startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : elapsed;
  return <span className="tabular-nums text-muted-foreground/70">{display}s</span>;
};

/** 本 run 的产出：运行状态与结束后汇总（本轮完成/工具数/失败/变更文件），与消息内叙事同一上下文，应在 Footer/Composer 上方单一位置展示 */
export const RunSummaryCard: FC<{
  summary: RunSummaryState;
  queueLength?: number;
  onStop: () => void;
  onRetry: () => void;
  onAskDiagnose: () => void;
  onCopyDiagnostics: () => void;
  onOpenTask: (taskId: string, subject: string, focusSection?: "result") => void;
  onOpenThread: (threadId: string) => void;
  variant?: "card" | "nested";
}> = ({ summary, queueLength = 0, onStop, onRetry, onAskDiagnose, onCopyDiagnostics, onOpenTask, onOpenThread, variant = "card" }) => {
  const failureSummary = summarizeFailureSeries(summary.recentFailures || []);
  const recommendedActionId = useMemo(() => {
    if (summary.running) return "stop";
    if (summary.lastError && summary.linkedTaskId) return "open_task";
    if (summary.lastError && summary.linkedThreadId) return "ask";
    if (summary.lastError) return "ask";
    if (summary.linkedTaskId) return "open_task";
    if (summary.linkedThreadId) return "open_thread";
    return "retry";
  }, [summary.running, summary.lastError, summary.linkedTaskId, summary.linkedThreadId]);
  const hasLastRunSummary = !!summary.lastRunSummary;
  // 规则：无任务时隐藏、有任务时展示；有本轮结果汇总时也展示以便显示工具数/文件/失败数或「本轮完成」（与 cursor_claude_cowork_behavior_analysis §5 一致）
  if (!summary.running && !summary.lastError && !summary.linkedTaskId && !summary.linkedThreadId && !hasLastRunSummary) return null;
  const phaseText =
    summary.stepSummary && summary.running
      ? t("thread.stepStrip.stepLabel", {
          current: String(summary.stepSummary.current),
          total: String(summary.stepSummary.total),
          stage: summary.stepSummary.label,
        })
      : summary.phaseLabel || (summary.running ? t("runTracker.phaseRunning") : t("runTracker.phaseLastRun"));
  const phaseAndTool = summary.activeTool ? `${phaseText} · ${summary.activeTool}` : phaseText;
  const queueLabel = queueLength > 0 ? t("runTracker.queueCount", { count: queueLength }) : "";
  const statusAria = [summary.running ? t("runTracker.phaseRunning") : t("runTracker.phaseLastRun"), queueLabel].filter(Boolean).join(" ");
  const isNested = variant === "nested";
  return (
    <div className={cn(isNested ? "border-b border-border/30 px-3 py-1" : "mx-auto mb-1 w-full max-w-(--thread-max-width) px-0")} role="region" aria-label={statusAria}>
      <div className={cn(!isNested && COMPOSER_FOOTER_CARD_CLASS, isNested ? "" : "px-2 py-1")}>
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-muted-foreground">
            <span
              className={cn(
                "inline-block size-1.5 shrink-0 rounded-full",
                summary.running ? "bg-violet-500 animate-pulse" : "bg-muted-foreground/50"
              )}
            />
            <span className="min-w-0 truncate" title={phaseAndTool}>{phaseAndTool}</span>
            {queueLength > 0 ? (
              <span className="shrink-0 text-muted-foreground/80" title={queueLabel}>{queueLabel}</span>
            ) : null}
            {(summary.running || summary.elapsedSec > 0) ? (
              <span className="shrink-0">
                <ElapsedTimer
                  running={summary.running}
                  startedAt={summary.startedAt}
                  initialElapsed={summary.elapsedSec}
                />
              </span>
            ) : null}
            {typeof summary.lastTtftMs === "number" && summary.lastTtftMs > 0 && ((import.meta as { env?: { DEV?: boolean } }).env?.DEV ?? false) ? (
              <span className="shrink-0 text-[10px] text-muted-foreground/60" title={t("runTracker.ttftTooltip")}>
                首 token {summary.lastTtftMs}ms
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {/* 主操作：仅保留一个主按钮，其余收入「更多」以节省横向空间 */}
            {recommendedActionId === "ask" && summary.lastError ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" variant="default" className="h-6 px-2 text-[11px]" onClick={onAskDiagnose} aria-label={t("runTracker.askDiagnose")}>
                    {t("runTracker.askDiagnose")}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>{t("runTracker.askDiagnose")}</TooltipContent>
              </Tooltip>
            ) : recommendedActionId === "retry" ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="default"
                    className="h-6 px-2 text-[11px]"
                    onClick={onRetry}
                    aria-label={(summary.recoveryPoint || summary.lastError) ? t("runTracker.retryFromRecovery") : t("runTracker.retry")}
                  >
                    {(summary.recoveryPoint || summary.lastError) ? t("runTracker.retryFromRecovery") : t("runTracker.retry")}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>{(summary.recoveryPoint || summary.lastError) ? t("runTracker.retryFromRecovery") : t("runTracker.retry")}</TooltipContent>
              </Tooltip>
            ) : recommendedActionId === "open_task" && summary.linkedTaskId ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="default"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => onOpenTask(summary.linkedTaskId!, summary.linkedSubject || "任务", summary.linkedStatus === "failed" ? "result" : undefined)}
                    aria-label={t("runTracker.openTask")}
                  >
                    {t("runTracker.openTask")}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>{t("runTracker.openTask")}</TooltipContent>
              </Tooltip>
            ) : recommendedActionId === "open_thread" && summary.linkedThreadId ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" variant="default" className="h-6 px-2 text-[11px]" onClick={() => onOpenThread(summary.linkedThreadId!)} aria-label={t("runTracker.openThread")}>
                    {t("runTracker.openThread")}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>{t("runTracker.openThread")}</TooltipContent>
              </Tooltip>
            ) : null}
            {(summary.lastError && recommendedActionId !== "ask") ||
            (recommendedActionId !== "retry") ||
            (summary.lastError || summary.linkedTaskId || summary.linkedThreadId) ? (
              <DropdownMenu>
                <Tooltip>
                  <DropdownMenuTrigger asChild>
                    <TooltipTrigger asChild>
                      <Button size="sm" variant="outline" className="h-6 px-1.5 text-[11px]" aria-label={t("runTracker.moreActions")}>
                        <MoreHorizontal className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                  </DropdownMenuTrigger>
                  <TooltipContent side="top" sideOffset={4}>{t("runTracker.moreActions")}</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end" className="min-w-[140px]">
                  {summary.lastError && recommendedActionId !== "ask" ? (
                    <DropdownMenuItem onClick={onAskDiagnose}>{t("runTracker.askDiagnose")}</DropdownMenuItem>
                  ) : null}
                  {recommendedActionId !== "retry" ? (
                    <DropdownMenuItem onClick={onRetry}>{(summary.recoveryPoint || summary.lastError) ? t("runTracker.retryFromRecovery") : t("runTracker.retry")}</DropdownMenuItem>
                  ) : null}
                  {(summary.lastError || summary.linkedTaskId || summary.linkedThreadId) ? (
                    <DropdownMenuItem onClick={onCopyDiagnostics}>{t("runTracker.copyDiagnostics")}</DropdownMenuItem>
                  ) : null}
                  {summary.linkedTaskId && recommendedActionId !== "open_task" ? (
                    <DropdownMenuItem onClick={() => onOpenTask(summary.linkedTaskId!, summary.linkedSubject || "任务", summary.linkedStatus === "failed" ? "result" : undefined)}>
                      {t("runTracker.openTask")}
                    </DropdownMenuItem>
                  ) : null}
                  {!summary.linkedTaskId && summary.linkedThreadId && recommendedActionId !== "open_thread" ? (
                    <DropdownMenuItem onClick={() => onOpenThread(summary.linkedThreadId!)}>{t("runTracker.openThread")}</DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>
        {summary.lastError ? (
          <div className="mt-0.5 rounded border border-destructive/25 bg-destructive/8 px-2 py-0.5 text-[11px] text-destructive/90 line-clamp-1 truncate" role="alert" aria-live="assertive" title={summary.lastError}>
            {t("runTracker.lastErrorLabel")}{summary.lastError}
          </div>
        ) : null}
        {failureSummary.length > 0 ? (
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80" title={failureSummary.join(" · ")}>
            {t("runTracker.failureSummaryLabel")}{failureSummary.join(" · ")}
          </div>
        ) : null}
        {!summary.running && summary.recoveryPoint && typeof summary.recoveryPoint === "object" ? (
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80">
            {t("runTracker.recoveryPointLabel")}{String(summary.recoveryPoint.step_id || "unknown")}
            {Number.isFinite(Number(summary.recoveryPoint.seq))
              ? ` · step #${Number(summary.recoveryPoint.seq)}`
              : ""}
          </div>
        ) : null}
        {!summary.running && summary.lastRunSummary ? (
          <div className="mt-0.5 space-y-0.5">
            <div className="truncate text-[11px] text-muted-foreground/80" title={summary.lastRunSummary.filePaths?.length ? summary.lastRunSummary.filePaths.join(", ") : undefined}>
              {summary.lastRunSummary.toolCount > 0
                ? t("runTracker.lastRunSummary", { toolCount: String(summary.lastRunSummary.toolCount) })
                : t("runTracker.roundComplete")}
              {summary.lastRunSummary.errorCount ? ` · ${summary.lastRunSummary.errorCount} ${t("runTracker.errorCountSuffix")}` : ""}
              {summary.lastRunSummary.filePaths?.length ? ` · ${summary.lastRunSummary.filePaths.length} ${t("runTracker.fileCountSuffix")}` : ""}
            </div>
            {summary.lastRunSummary.filePaths && summary.lastRunSummary.filePaths.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {summary.lastRunSummary.filePaths.slice(0, 5).map((path, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => fileEventBus.openFile(path)}
                    className="text-[10px] text-primary/80 hover:text-primary hover:underline truncate max-w-[140px]"
                    title={path}
                  >
                    {path.split("/").pop() || path}
                  </button>
                ))}
                {summary.lastRunSummary.filePaths.length > 5 ? (
                  <span className="text-[10px] text-muted-foreground/70">+{summary.lastRunSummary.filePaths.length - 5}</span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};

/** Composer 上方卡片统一样式（与 RunSummaryCard、快捷条一致） */
const COMPOSER_FOOTER_CARD_CLASS = "rounded-lg border border-border/50 bg-card/65 shadow-sm";

/** Cursor 式：与运行状态同一行右侧，仅 k/n + 细进度条 + 展开；无标题文案 */
export const RunTodoSummaryButton: FC<{
  todos: Array<{ id?: string; content: string; status: string }>;
  expanded: boolean;
  onToggle: () => void;
}> = ({ todos, expanded, onToggle }) => {
  if (!todos.length) return null;
  const completedCount = todos.filter((t) => String(t.status).toLowerCase() === "completed").length;
  const totalCount = todos.length;
  const progress = totalCount ? Math.round((completedCount / totalCount) * 100) : 0;
  const tooltipText = expanded ? t("runTracker.todoCollapse") : t("runTracker.todoExpand");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-1 text-[10px] text-muted-foreground/90 rounded transition-colors hover:bg-muted/20 py-0.5 px-1 min-h-0 border-0"
          aria-expanded={expanded}
          aria-label={tooltipText}
        >
          <span className="tabular-nums">{completedCount}/{totalCount}</span>
          <div className="w-8 h-0.5 bg-muted/80 rounded-full overflow-hidden shrink-0">
            <div
              className={cn("h-full transition-all duration-300 rounded-full", progress >= 100 ? "bg-emerald-500" : "bg-violet-500")}
              style={{ width: `${progress}%` }}
            />
          </div>
          {expanded ? <ChevronUp className="size-2.5 shrink-0" /> : <ChevronDown className="size-2.5 shrink-0" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>{tooltipText}</TooltipContent>
    </Tooltip>
  );
};

/** Cursor 风格任务列表：展示当前 run 的 Todo（完成/进行中/待办），无任务时不渲染；nested 时收折为一行，可向上展开；onlyList 时仅渲染列表（用于与状态行合并时的展开区） */
export const RunTodoListCard: FC<{
  todos: Array<{ id?: string; content: string; status: string }>;
  isRunning: boolean;
  variant?: "card" | "nested";
  /** 仅渲染列表内容，用于与运行状态同一行时的展开区域（Cursor 式） */
  onlyList?: boolean;
  /** nested 时受控展开（由父组件与状态行合并为一排时使用） */
  expanded?: boolean;
  onExpandToggle?: () => void;
}> = ({ todos, isRunning, variant = "card", onlyList = false, expanded: controlledExpanded, onExpandToggle }) => {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const expanded = onExpandToggle != null ? (controlledExpanded ?? false) : internalExpanded;
  const handleToggle = onExpandToggle ?? (() => setInternalExpanded((e) => !e));
  if (!todos.length) return null;
  const completedCount = todos.filter((t) => String(t.status).toLowerCase() === "completed").length;
  const totalCount = todos.length;
  const progress = totalCount ? Math.round((completedCount / totalCount) * 100) : 0;
  const isNested = variant === "nested";

  if (onlyList) {
    const listContent = (
      <div className="space-y-0" role="list">
        {todos.map((todo, i) => {
          const status = String(todo.status).toLowerCase();
          const isCompleted = status === "completed";
          const isInProgress = status === "in_progress";
          return (
            <div
              key={todo.id ?? `todo-${i}`}
              role="listitem"
              className={cn(
                "flex items-center gap-1.5 py-0.5 px-1.5 rounded text-[11px] transition-colors",
                isInProgress && isRunning && "bg-violet-500/10"
              )}
            >
              {isCompleted ? (
                <CheckIcon className="size-3 text-emerald-500 shrink-0" aria-hidden />
              ) : isInProgress && isRunning ? (
                <div className="size-3 rounded-full border-2 border-violet-500 border-t-transparent animate-spin shrink-0" aria-hidden />
              ) : isInProgress ? (
                <div className="size-3 rounded-full border-2 border-amber-500 shrink-0" aria-hidden />
              ) : (
                <div className="size-3 rounded-full border border-muted-foreground/30 shrink-0" aria-hidden />
              )}
              <span
                className={cn(
                  "flex-1 min-w-0 truncate",
                  isCompleted ? "text-muted-foreground line-through" : isInProgress ? "text-foreground font-medium" : "text-muted-foreground"
                )}
              >
                {todo.content || "—"}
              </span>
            </div>
          );
        })}
      </div>
    );
    return <div className="border-t border-border/20 px-2 py-0.5 max-h-[100px] overflow-y-auto bg-muted/5" role="region" aria-label={t("runTracker.todoListAria")}>{listContent}</div>;
  }

  const summaryLine = (
    <button
      type="button"
      onClick={handleToggle}
      className={cn(
        "w-full flex items-center gap-1.5 text-[11px] text-muted-foreground rounded transition-colors hover:bg-muted/40",
        isNested ? "py-0.5 px-0" : "py-1 px-1"
      )}
      aria-expanded={expanded}
      aria-label={expanded ? t("runTracker.todoCollapse") : t("runTracker.todoExpand")}
    >
      <ListChecksIcon className="size-3 text-violet-500 shrink-0" />
      <span className="font-medium text-foreground/80">{t("runTracker.todoListTitle")}</span>
      <span className="tabular-nums">{completedCount}/{totalCount}{totalCount ? ` (${progress}%)` : ""}</span>
      <div className="flex-1 min-w-[32px] h-0.5 bg-muted rounded-full overflow-hidden">
        <div
          className={cn("h-full transition-all duration-300 rounded-full", progress >= 100 ? "bg-emerald-500" : "bg-violet-500")}
          style={{ width: `${progress}%` }}
        />
      </div>
      {expanded ? <ChevronUp className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />}
    </button>
  );

  const listContent = (
    <div className="space-y-0" role="list">
      {todos.map((todo, i) => {
        const status = String(todo.status).toLowerCase();
        const isCompleted = status === "completed";
        const isInProgress = status === "in_progress";
        return (
          <div
            key={todo.id ?? `todo-${i}`}
            role="listitem"
            className={cn(
              "flex items-center gap-1.5 py-0.5 px-1.5 rounded text-[11px] transition-colors",
              isInProgress && isRunning && "bg-violet-500/10"
            )}
          >
            {isCompleted ? (
              <CheckIcon className="size-3 text-emerald-500 shrink-0" aria-hidden />
            ) : isInProgress && isRunning ? (
              <div className="size-3 rounded-full border-2 border-violet-500 border-t-transparent animate-spin shrink-0" aria-hidden />
            ) : isInProgress ? (
              <div className="size-3 rounded-full border-2 border-amber-500 shrink-0" aria-hidden />
            ) : (
              <div className="size-3 rounded-full border border-muted-foreground/30 shrink-0" aria-hidden />
            )}
            <span
              className={cn(
                "flex-1 min-w-0 truncate",
                isCompleted ? "text-muted-foreground line-through" : isInProgress ? "text-foreground font-medium" : "text-muted-foreground"
              )}
            >
              {todo.content || "—"}
            </span>
          </div>
        );
      })}
    </div>
  );

  if (isNested) {
    return (
      <div className="px-0 py-0.5" role="region" aria-label={t("runTracker.todoListAria")}>
        {summaryLine}
        {expanded && (
          <div className="border-t border-border/20 mt-0.5 pt-0.5 max-h-[100px] overflow-y-auto bg-muted/5 rounded-b">{listContent}</div>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto mb-1 w-full max-w-(--thread-max-width) px-0" role="list" aria-label={t("runTracker.todoListAria")}>
      <div className={cn(COMPOSER_FOOTER_CARD_CLASS, "px-2 py-1.5")}>
        <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <ListChecksIcon className="size-3.5 text-violet-500 shrink-0" />
          <span className="font-medium text-foreground/80">{t("runTracker.todoListTitle")}</span>
          <span className="tabular-nums">
            {completedCount}/{totalCount}
            {totalCount ? ` (${progress}%)` : ""}
          </span>
        </div>
        <div className="h-1 bg-muted rounded-full overflow-hidden mb-1">
          <div
            className={cn("h-full transition-all duration-300 rounded-full", progress >= 100 ? "bg-emerald-500" : "bg-violet-500")}
            style={{ width: `${progress}%` }}
          />
        </div>
        {listContent}
      </div>
    </div>
  );
};

export const AutonomousRunsStrip: FC<{
  runs: Array<{
    task_id?: string;
    subject?: string;
    slot?: string;
    triggered_at?: string;
    thread_id?: string;
    matched_task_id?: string;
  }>;
  onOpenThread: (threadId: string) => void;
  onOpenTask: (taskId: string, subject: string, focusSection?: "result") => void;
}> = ({ runs, onOpenThread, onOpenTask }) => {
  const formatTime = (ts?: string) => {
    if (!ts) return "";
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  };
  const getBucketLabel = (ts?: string) => {
    if (!ts) return t("runTracker.timeAgoEarlier");
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return t("runTracker.timeAgoEarlier");
    const diffMs = Date.now() - d.getTime();
    if (diffMs <= 2 * 60 * 1000) return t("runTracker.timeAgoJustNow");
    if (diffMs <= 15 * 60 * 1000) return t("runTracker.timeAgoWithin15");
    return t("runTracker.timeAgoEarlier");
  };
  const groupedRuns = useMemo(() => {
    const order = [t("runTracker.timeAgoJustNow"), t("runTracker.timeAgoWithin15"), t("runTracker.timeAgoEarlier")] as const;
    const groups: Record<(typeof order)[number], typeof runs> = {
      [order[0]]: [],
      [order[1]]: [],
      [order[2]]: [],
    };
    for (const run of runs) {
      groups[getBucketLabel(run.triggered_at) as (typeof order)[number]].push(run);
    }
    return order
      .map((label) => ({ label, items: groups[label] }))
      .filter((g) => g.items.length > 0);
  }, [runs]);
  const runPrimaryAction = (r: {
    matched_task_id?: string;
    subject?: string;
    thread_id?: string;
  }) => {
    if (r.matched_task_id) {
      onOpenTask(r.matched_task_id, r.subject || t("runTracker.unnamedTask"));
      return;
    }
    if (r.thread_id) onOpenThread(r.thread_id);
  };
  return (
    <div className="mx-auto mb-2 w-full max-w-(--thread-max-width) px-4">
      <div className="rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2">
        <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="inline-block size-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <span>{t("runTracker.autonomousScheduling")}</span>
          <span>·</span>
          <span>{runs.length} {t("runTracker.runsCountUnit")}</span>
        </div>
        <div className="space-y-2">
          {groupedRuns.map((group) => (
            <div key={group.label} className="space-y-1.5">
              <div className="px-1 text-[11px] tracking-wide text-muted-foreground/70">{group.label}</div>
              {group.items.map((r, idx) => (
                <div
                  key={`${group.label}-${r.thread_id || r.task_id || "run"}-${idx}`}
                  role="button"
                  tabIndex={0}
                  className="group flex cursor-pointer items-center justify-between gap-2 rounded-md border border-border/40 bg-background/60 px-2 py-1.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => runPrimaryAction(r)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      runPrimaryAction(r);
                    }
                  }}
                  title={t("runTracker.enterOpenPrimaryAction")}
                >
                  <div className="min-w-0 truncate text-muted-foreground">
                    <span className="text-foreground/90">{r.subject || r.task_id || t("runTracker.unnamedTask")}</span>
                    <span> · {r.slot || "unscheduled"}</span>
                    {r.triggered_at ? <span> · {formatTime(r.triggered_at)}</span> : null}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 shrink-0 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100"
                        aria-label={t("runTracker.autonomousTaskActions")}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      {r.matched_task_id ? (
                        <DropdownMenuItem onClick={() => onOpenTask(r.matched_task_id!, r.subject || t("runTracker.unnamedTask"))}>
                          {t("runTracker.openTaskDetail")}
                        </DropdownMenuItem>
                      ) : null}
                      {r.thread_id ? (
                        <DropdownMenuItem onClick={() => onOpenThread(r.thread_id!)}>
                          {t("runTracker.backToThread")}
                        </DropdownMenuItem>
                      ) : null}
                      {r.thread_id ? (
                        <DropdownMenuItem onClick={() => navigator.clipboard.writeText(r.thread_id || "").then(() => toast.success(t("runTracker.toastCopiedThreadId"))).catch(() => toast.error(t("common.copyFailed")))}>
                          {t("runTracker.copyThreadId")}
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
