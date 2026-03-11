/**
 * 共享任务状态（WorkspaceDashboard 与 TaskDetailView 单一数据源）
 * 任务变更后双方通过订阅自动更新
 */
import { create } from "zustand";
import type { BoardTask } from "../lib/api/boardApi";
import { boardApi } from "../lib/api/boardApi";

type Scope = "personal" | "org" | "public";

interface TaskState {
  tasksById: Record<string, BoardTask>;
  getTask: (id: string) => BoardTask | undefined;
  setTask: (task: BoardTask) => void;
  setTasks: (tasks: BoardTask[]) => void;
  removeTask: (id: string) => void;
  fetchTask: (id: string, scope?: Scope) => Promise<BoardTask | null>;
  refreshTasks: (scope: Scope, options?: { workspacePath?: string | null }) => Promise<{ ok: boolean; tasks: BoardTask[]; error?: string }>;
  updateTask: (id: string, patch: Partial<BoardTask> | ((prev: BoardTask) => Partial<BoardTask>)) => void;
}

const inflight = new Map<string, Promise<BoardTask | null>>();

export const useTaskStore = create<TaskState>((set, get) => {
  return {
  tasksById: {},

  getTask(id: string) {
    const s = get().tasksById;
    return s[id] ?? Object.values(s).find((t) => (t.task_id ?? t.id) === id);
  },

  setTask(task: BoardTask) {
    const id = task.id ?? task.task_id ?? "";
    if (!id) return;
    set((s) => ({ tasksById: { ...s.tasksById, [id]: task } }));
  },

  setTasks(tasks: BoardTask[]) {
    const byId: Record<string, BoardTask> = {};
    for (const t of tasks) {
      const key = t.id ?? t.task_id ?? "";
      if (key) byId[key] = t;
    }
    set((s) => {
      const next = { ...s.tasksById };
      for (const [key, task] of Object.entries(byId)) {
        const existing = next[key];
        const incomingAt = task.updated_at ?? "";
        if (!existing) {
          next[key] = task;
          continue;
        }
        const existingAt = existing.updated_at ?? "";
        const incomingMs = incomingAt ? (() => { const d = new Date(incomingAt).getTime(); return Number.isFinite(d) ? d : 0; })() : 0;
        const existingMs = existingAt ? (() => { const d = new Date(existingAt).getTime(); return Number.isFinite(d) ? d : 0; })() : 0;
        if (incomingMs >= existingMs) next[key] = task;
      }
      return { tasksById: next };
    });
  },

  removeTask(id: string) {
    set((s) => {
      const task = s.tasksById[id] ?? Object.values(s.tasksById).find((t) => (t.task_id ?? t.id) === id);
      if (!task) return s;
      const canonical = task.id ?? task.task_id ?? id;
      const next = { ...s.tasksById };
      delete next[canonical];
      return { tasksById: next };
    });
  },

  async fetchTask(id: string, scope?: Scope): Promise<BoardTask | null> {
    const inflightKey = `${id}:${scope ?? ""}`;
    const existing = inflight.get(inflightKey);
    if (existing) return existing;
    const promise = (async (): Promise<BoardTask | null> => {
      const direct = await boardApi.getTask(id, scope);
      if (direct.ok && direct.task) {
        get().setTask(direct.task);
        return direct.task;
      }
      const directError = direct.error ?? "";
      const isNotFound = /任务不存在|未找到任务|not found|404/i.test(directError);
      if (isNotFound && scope !== "personal") {
        const fallback = await boardApi.getTask(id, "personal");
        if (fallback.ok && fallback.task) {
          get().setTask(fallback.task);
          return fallback.task;
        }
        return null;
      }
      if (directError.trim() === "") throw new Error("获取任务失败");
      throw new Error(directError || "获取任务失败");
    })().finally(() => {
      inflight.delete(inflightKey);
    });
    inflight.set(inflightKey, promise);
    return promise;
  },

  async refreshTasks(scope: Scope, options?: { workspacePath?: string | null }): Promise<{ ok: boolean; tasks: BoardTask[]; error?: string }> {
    try {
      const res = await boardApi.getTasks(scope, undefined, undefined, {
        workspacePath: options?.workspacePath ?? undefined,
      });
      if (!res.ok || !res.tasks) return { ok: false, tasks: [], error: res.error ?? "请求失败" };
      get().setTasks(res.tasks);
      return { ok: true, tasks: res.tasks };
    } catch (e) {
      const error = e instanceof Error ? e.message : "网络错误";
      return { ok: false, tasks: [], error };
    }
  },

  updateTask(id: string, patch: Partial<BoardTask> | ((prev: BoardTask) => Partial<BoardTask>)) {
    set((s) => {
      const current = s.tasksById[id] ?? Object.values(s.tasksById).find((t) => (t.task_id ?? t.id) === id);
      if (!current) return s;
      const patchValue = typeof patch === "function" ? patch(current) : patch;
      const updated = { ...current, ...patchValue };
      const canonical = updated.id ?? updated.task_id ?? id;
      const next = { ...s.tasksById };
      delete next[id];
      if (current.id && current.id !== id) delete next[current.id];
      if (current.task_id && current.task_id !== id) delete next[current.task_id];
      next[canonical] = updated;
      return { tasksById: next };
    });
  },
};
});
