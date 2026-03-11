/**
 * 任务 API（Task = Thread with metadata）
 * 对接后端 POST/GET/PATCH /tasks。非 UUID 的 threadId 不请求后端，直接返回无效结果（与后端 404 语义一致）。
 */

import { apiClient } from "./client";
import { validServerThreadIdOrUndefined } from "./langserveChat";

export interface TaskMetadata {
  is_task?: boolean;
  subject?: string;
  task_status?: "pending" | "running" | "completed" | "failed" | "cancelled";
  priority?: number;
  scene?: string;
  mode?: string;
  deliverables?: string;
  parent_task_id?: string | null;
  created_by?: string;
  result_summary?: string | null;
  error?: string | null;
}

export interface TaskItem {
  thread_id: string;
  metadata?: TaskMetadata;
  created_at?: string;
  updated_at?: string;
  state?: { values?: { messages?: unknown[] } };
}

export interface CreateTaskParams {
  subject: string;
  description?: string;
  priority?: number;
  scene?: string;
  mode?: string;
  skill_profile?: string;
  /** 为 true 且未传 skill_profile 时，后端按 subject/required_skills 推荐角色并设置 skill_profile */
  use_router?: boolean;
  required_skills?: string[];
  /** 当前工作区路径，用于任务按工作区过滤 */
  workspace_path?: string | null;
}

export const tasksApi = {
  async create(params: CreateTaskParams): Promise<{ ok: boolean; thread_id: string; run_id: string }> {
    const explicitProfile = params.skill_profile ?? params.scene;
    const body: Record<string, unknown> = {
      subject: params.subject,
      description: params.description,
      priority: params.priority ?? 3,
      scene: params.scene ?? "full",
      mode: params.mode ?? "agent",
      skill_profile: explicitProfile ?? undefined,
      use_router: params.use_router ?? (explicitProfile == null),
      required_skills: params.required_skills,
    };
    if (params.workspace_path != null && params.workspace_path !== "") body.workspace_path = params.workspace_path;
    const res = await apiClient.post<{ ok: boolean; thread_id: string; run_id: string }>("/tasks", body);
    return res;
  },

  async list(status?: string, limit = 50, workspacePath?: string | null): Promise<{ ok: boolean; tasks: TaskItem[] }> {
    const params: Record<string, string | number> = { limit };
    if (status) params.status = status;
    if (workspacePath != null && workspacePath !== "") params.workspace_path = workspacePath;
    return apiClient.get<{ ok: boolean; tasks: TaskItem[] }>("/tasks", params);
  },

  async get(threadId: string): Promise<{ ok: boolean; task?: TaskItem | null }> {
    const tid = validServerThreadIdOrUndefined(threadId);
    if (!tid) return { ok: false, task: null };
    return apiClient.get<{ ok: boolean; task: TaskItem }>(`/tasks/${tid}`);
  },

  async update(threadId: string, updates: Partial<TaskMetadata>): Promise<{ ok: boolean; task?: TaskItem | null }> {
    const tid = validServerThreadIdOrUndefined(threadId);
    if (!tid) return { ok: false, task: null };
    return apiClient.patch<{ ok: boolean; task: TaskItem }>(`/tasks/${tid}`, updates);
  },

  async cancel(threadId: string): Promise<{ ok: boolean; task?: TaskItem | null }> {
    const tid = validServerThreadIdOrUndefined(threadId);
    if (!tid) return { ok: false, task: null };
    return apiClient.patch<{ ok: boolean; task: TaskItem }>(`/tasks/${tid}`, {
      task_status: "cancelled",
    });
  },
};
