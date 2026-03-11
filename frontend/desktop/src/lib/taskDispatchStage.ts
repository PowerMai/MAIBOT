import type { BoardTask } from "./api/boardApi";

export type TaskDispatchStage = {
  key:
    | "pending_review"
    | "awaiting_plan_confirm"
    | "blocked"
    | "dispatching"
    | "bidding"
    | "claimed"
    | "starting"
    | "running"
    | "done"
    | "failed"
    | "dispatch_failed"
    | "paused"
    | "cancelled"
    | "queue_timeout"
    | "execution_timeout";
  label: string;
  className: string;
};

export const TASK_STATUS_LABEL: Record<string, string> = {
  available: "待处理",
  pending: "待处理",
  bidding: "竞标中",
  claimed: "已认领",
  running: "执行中",
  in_progress: "执行中",
  completed: "已完成",
  failed: "失败",
  paused: "已暂停",
  cancelled: "已取消",
  waiting_human: "待人工确认",
  awaiting_plan_confirm: "待确认计划",
  blocked: "已阻塞",
};

export const TASK_STATUS_BADGE_CLASS: Record<string, string> = {
  available: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  pending: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  bidding: "bg-sky-500/10 text-sky-600 border-sky-500/20",
  claimed: "bg-indigo-500/10 text-indigo-600 border-indigo-500/20",
  running: "bg-violet-500/10 text-violet-600 border-violet-500/20",
  in_progress: "bg-violet-500/10 text-violet-600 border-violet-500/20",
  completed: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  done: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  failed: "bg-red-500/10 text-red-600 border-red-500/20",
  paused: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  cancelled: "bg-gray-500/10 text-gray-500 border-gray-500/20",
  waiting_human: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  awaiting_plan_confirm: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  blocked: "bg-orange-500/10 text-orange-600 border-orange-500/20",
};

export function getTaskStatusLabel(status?: string): string {
  const key = String(status || "").trim();
  return TASK_STATUS_LABEL[key] ?? key;
}

export function getTaskStatusBadgeClass(status?: string): string {
  const key = String(status || "").trim();
  return TASK_STATUS_BADGE_CLASS[key] ?? "bg-muted text-muted-foreground border-border";
}

export function inferTaskDispatchStage(task: BoardTask): TaskDispatchStage {
  const status = String(task.status || "available");
  const dispatchState = String(task.dispatch_state || "").trim().toLowerCase();
  if (dispatchState === "execution_started" || dispatchState === "already_running") {
    return { key: "running", label: "已自动启动", className: "border-emerald-500/40 text-emerald-700" };
  }
  if (dispatchState === "waiting_human") {
    return { key: "pending_review", label: "等待人工检查", className: "border-amber-500/40 text-amber-700" };
  }
  if (dispatchState === "awaiting_plan_confirm") {
    return { key: "awaiting_plan_confirm", label: "等待计划确认", className: "border-blue-500/40 text-blue-700" };
  }
  if (dispatchState === "blocked") {
    return { key: "blocked", label: "任务阻塞", className: "border-orange-500/40 text-orange-700" };
  }
  if (dispatchState === "queue_timeout") {
    return { key: "queue_timeout", label: "排队超时，已重排", className: "border-amber-500/40 text-amber-700" };
  }
  if (dispatchState === "execution_timeout") {
    return { key: "execution_timeout", label: "执行超时", className: "border-rose-500/40 text-rose-700" };
  }
  if (["no_roles", "no_bid_or_unresolved", "invalid_claim", "not_found"].includes(dispatchState)) {
    return { key: "dispatch_failed", label: "分发失败", className: "border-rose-500/40 text-rose-700" };
  }
  if (status === "waiting_human") return { key: "pending_review", label: "等待人工检查", className: "border-amber-500/40 text-amber-700" };
  if (status === "awaiting_plan_confirm") return { key: "awaiting_plan_confirm", label: "等待计划确认", className: "border-blue-500/40 text-blue-700" };
  if (status === "blocked") return { key: "blocked", label: "任务阻塞", className: "border-orange-500/40 text-orange-700" };
  if (status === "bidding") return { key: "bidding", label: "角色评估中", className: "border-sky-500/40 text-sky-700" };
  if (status === "available") return { key: "dispatching", label: "自动分发中", className: "border-sky-500/40 text-sky-700" };
  if (status === "claimed") return { key: "claimed", label: "已认领待启动", className: "border-indigo-500/40 text-indigo-700" };
  if ((status === "running" || status === "in_progress") && !task.thread_id) return { key: "starting", label: "执行引擎启动中", className: "border-indigo-500/40 text-indigo-700" };
  if (status === "running" || status === "in_progress") return { key: "running", label: "执行中", className: "border-emerald-500/40 text-emerald-700" };
  if (status === "paused") return { key: "paused", label: "执行已暂停", className: "border-slate-500/40 text-slate-700" };
  if (status === "completed") return { key: "done", label: "执行完成", className: "border-emerald-500/40 text-emerald-700" };
  if (status === "failed") return { key: "failed", label: "执行失败", className: "border-rose-500/40 text-rose-700" };
  if (status === "cancelled") return { key: "cancelled", label: "任务已取消", className: "border-slate-500/40 text-slate-700" };
  return { key: "dispatching", label: "状态同步中", className: "border-sky-500/40 text-sky-700" };
}

export type TaskPrimaryEntryAction = {
  kind: "open_thread" | "open_task_detail";
  label: string;
  reason: string;
};

/**
 * 统一“用户应从哪里继续”的入口判定，避免 Dashboard / TaskDetail 出现分叉。
 */
export function resolveTaskPrimaryEntryAction(task: BoardTask): TaskPrimaryEntryAction {
  const status = String(task.status || "").trim().toLowerCase();
  const hasThread = Boolean(String(task.thread_id || "").trim());

  if (hasThread && (status === "running" || status === "in_progress" || status === "claimed")) {
    return {
      kind: "open_thread",
      label: "继续对话执行",
      reason: "任务已有执行线程，直接回到对话最连贯。",
    };
  }

  if (status === "awaiting_plan_confirm") {
    return {
      kind: hasThread ? "open_thread" : "open_task_detail",
      label: hasThread ? "去对话确认计划" : "打开任务确认计划",
      reason: "当前处于计划确认门禁，先确认再执行。",
    };
  }

  if (status === "blocked") {
    return {
      kind: "open_task_detail",
      label: "打开任务补全信息",
      reason: "任务阻塞，需在任务详情查看缺失信息与修复建议。",
    };
  }

  if (status === "waiting_human") {
    return {
      kind: "open_task_detail",
      label: "打开任务进行审核",
      reason: "任务等待人工检查点决策。",
    };
  }

  if (status === "failed" || status === "cancelled") {
    return {
      kind: "open_task_detail",
      label: "打开任务重试",
      reason: "任务已结束但未成功，建议先看失败原因再重试。",
    };
  }

  return {
    kind: "open_task_detail",
    label: "打开任务详情",
    reason: "优先查看任务全貌与下一步建议。",
  };
}

export type UserFacingTaskStatus = {
  key: string;
  label: string;
  badgeClass: string;
  reason?: string;
};

export type TaskActionPolicy = {
  canStart: boolean;
  canPause: boolean;
  canCancel: boolean;
  canResume: boolean;
  canReset: boolean;
  canOpenThread: boolean;
};

function getDispatchState(task: BoardTask): string {
  return String(task.dispatch_state || "").trim().toLowerCase();
}

function getTaskStatus(task: BoardTask): string {
  return String(task.status || "available").trim().toLowerCase();
}

/**
 * 单一用户真相：优先使用后端 dispatch_state 投影，再回落 status。
 * 这样可以避免不同视图对 status / dispatch_state 解释不一致。
 */
export function resolveUserFacingTaskStatus(task: BoardTask): UserFacingTaskStatus {
  const status = getTaskStatus(task);
  const dispatchState = getDispatchState(task);

  if (dispatchState === "awaiting_plan_confirm") {
    return {
      key: "awaiting_plan_confirm",
      label: "待确认计划",
      badgeClass: TASK_STATUS_BADGE_CLASS.awaiting_plan_confirm,
      reason: "系统已产出计划，等待你确认后继续执行",
    };
  }
  if (dispatchState === "waiting_human") {
    return {
      key: "waiting_human",
      label: "待人工确认",
      badgeClass: TASK_STATUS_BADGE_CLASS.waiting_human,
      reason: "存在检查点，需人工确认后继续",
    };
  }
  if (dispatchState === "blocked") {
    return {
      key: "blocked",
      label: "已阻塞",
      badgeClass: TASK_STATUS_BADGE_CLASS.blocked,
      reason: "缺少必要信息或执行条件",
    };
  }
  if (dispatchState === "queue_timeout") {
    return {
      key: "queue_timeout",
      label: "排队超时",
      badgeClass: "bg-amber-500/10 text-amber-600 border-amber-500/20",
      reason: "分发排队超时，系统将自动重试",
    };
  }
  if (dispatchState === "execution_timeout") {
    return {
      key: "execution_timeout",
      label: "执行超时",
      badgeClass: "bg-rose-500/10 text-rose-600 border-rose-500/20",
      reason: "任务执行超时，建议检查输入范围或资源限制",
    };
  }
  if (dispatchState === "execution_started" || dispatchState === "already_running") {
    return {
      key: "running",
      label: "执行中",
      badgeClass: TASK_STATUS_BADGE_CLASS.running,
      reason: "任务已进入执行链路",
    };
  }

  return {
    key: status || "available",
    label: getTaskStatusLabel(status),
    badgeClass: getTaskStatusBadgeClass(status),
  };
}

export function getTaskActionPolicy(task: BoardTask): TaskActionPolicy {
  const status = resolveUserFacingTaskStatus(task).key;
  const hasThread = Boolean(String(task.thread_id || "").trim());
  const cancelable = ["running", "paused", "blocked", "awaiting_plan_confirm", "queue_timeout", "execution_timeout"];
  const resettable = ["failed", "cancelled", "blocked", "awaiting_plan_confirm", "queue_timeout", "execution_timeout"];
  return {
    canStart: !hasThread && (status === "available" || status === "pending"),
    canPause: status === "running",
    canCancel: cancelable.includes(status),
    canResume: status === "paused",
    canReset: resettable.includes(status),
    canOpenThread: hasThread,
  };
}
