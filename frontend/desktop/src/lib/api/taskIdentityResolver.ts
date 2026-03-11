import { boardApi, type BoardTask } from "./boardApi";

export interface ResolvedTaskRef {
  task: BoardTask;
  scope: "personal" | "org" | "public";
}

export async function resolveTaskRefByTaskOrThread(input: {
  taskId?: string;
  threadId?: string;
}): Promise<ResolvedTaskRef | null> {
  const taskId = String(input.taskId || "").trim();
  const threadId = String(input.threadId || "").trim();
  if (!taskId && !threadId) return null;

  const scopes: Array<"personal" | "org" | "public"> = ["personal", "org", "public"];
  for (const scope of scopes) {
    const list = await boardApi.getTasks(scope);
    if (!list.ok) continue;
    const hit = (list.tasks || []).find((t) => {
      const id = String(t.id || "");
      const externalTaskId = String(t.task_id || "");
      const tid = String(t.thread_id || "");
      if (taskId && (id === taskId || externalTaskId === taskId)) return true;
      if (threadId && tid === threadId) return true;
      return false;
    });
    if (hit) return { task: hit, scope };
  }
  return null;
}

