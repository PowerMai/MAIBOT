import { boardApi, type BoardTask } from "./api/boardApi";
import { EVENTS } from "./constants";

type CreateTaskWithDispatchFeedbackArgs = {
  subject: string;
  description?: string;
  priority?: number;
  scope?: "personal" | "org" | "public";
  source?: "task_list_sidebar" | "workspace_dashboard";
  /** 当前工作区路径，用于任务按工作区过滤 */
  workspace_path?: string | null;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  onTaskCreated?: (task: BoardTask) => void;
  onTasksSnapshot?: (tasks: BoardTask[]) => void;
  onOpenTask?: (task: BoardTask) => void;
};

export type CreateTaskWithDispatchFeedbackResult =
  | {
      ok: true;
      taskId: string;
      task?: BoardTask;
      dispatchState?: string;
      message: string;
    }
  | {
      ok: false;
      error: string;
    };

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function emitThreadHint(task: BoardTask, source: string): void {
  if (!task.thread_id) return;
  const message = `任务「${task.subject || task.id}」已自动开始执行`;
  window.dispatchEvent(
    new CustomEvent(EVENTS.TASK_PANEL_THREAD_HINT, {
      detail: {
        threadId: task.thread_id,
        taskId: task.id,
        subject: task.subject,
        status: task.status,
        message,
        source,
      },
    }),
  );
  window.dispatchEvent(new CustomEvent(EVENTS.TASK_PROGRESS, { detail: { message } }));
  window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_TO_THREAD, { detail: { threadId: task.thread_id } }));
}

function getCreatedMessage(task?: BoardTask, dispatchState?: string): string {
  const state = String(dispatchState || "").trim().toLowerCase();
  if (String(task?.status || "").trim().toLowerCase() === "waiting_human" || state === "waiting_human") {
    return "任务已创建，等待人工检查点确认";
  }
  return "任务已创建，正在自动分发并准备执行";
}

export async function createTaskWithDispatchFeedback(
  args: CreateTaskWithDispatchFeedbackArgs,
): Promise<CreateTaskWithDispatchFeedbackResult> {
  const subject = String(args.subject || "").trim();
  if (!subject) return { ok: false, error: "任务标题不能为空" };

  const createRes = await boardApi.createTask({
    subject,
    description: args.description,
    priority: args.priority ?? 3,
    scope: args.scope ?? "personal",
    workspace_path: args.workspace_path ?? undefined,
  });
  if (!createRes.ok || !createRes.task_id) {
    return { ok: false, error: createRes.error ?? "创建任务失败" };
  }

  const initialMessage = getCreatedMessage(createRes.task, createRes.dispatch_state);
  window.dispatchEvent(new CustomEvent(EVENTS.TASK_PROGRESS, { detail: { message: initialMessage } }));

  if (createRes.task) {
    args.onTaskCreated?.(createRes.task);
    args.onOpenTask?.(createRes.task);
  }

  const timeoutMs = args.pollTimeoutMs ?? 20000;
  const intervalMs = args.pollIntervalMs ?? 1200;
  const startedAt = Date.now();
  let latestTask: BoardTask | undefined = createRes.task;

  const wp = args.workspace_path ?? undefined;
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await boardApi.getTasks(args.scope ?? "personal", undefined, undefined, { workspacePath: wp });
    if (!snapshot.ok || !snapshot.tasks) break;
    args.onTasksSnapshot?.(snapshot.tasks);

    const task = snapshot.tasks.find((t) => t.id === createRes.task_id || t.task_id === createRes.task_id);
    if (!task) {
      await sleep(intervalMs);
      continue;
    }
    latestTask = task;
    args.onOpenTask?.(task);

    const status = String(task.status || "").trim().toLowerCase();
    if (status === "waiting_human") break;
    if (task.thread_id && status === "running") {
      emitThreadHint(task, args.source || "task_list_sidebar");
      break;
    }
    if (["completed", "failed", "cancelled", "paused"].includes(status)) break;

    await sleep(intervalMs);
  }

  return {
    ok: true,
    taskId: createRes.task_id,
    task: latestTask,
    dispatchState: createRes.dispatch_state,
    message: initialMessage,
  };
}
