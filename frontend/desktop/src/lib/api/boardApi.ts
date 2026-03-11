/**
 * 看板 API - 多级任务看板与能力摘要
 * 对接后端 /board/tasks、/board/capabilities、/board/connections
 */

import { getApiBase, validServerThreadIdOrUndefined } from "./langserveChat";
import { rolesApi } from "./rolesApi";
import { skillsAPI } from "./skillsApi";
import { apiClient } from "./client";
import { formatApiErrorMessage } from "../utils/formatApiError";
import { getApiErrorBody } from "../utils/api-helpers";

const AGENT_PROFILE_CACHE_TTL_MS = 8000;
const AGENT_PROFILE_BACKOFF_MS = 5000;
/** 401 等鉴权失败后延长 backoff，避免重复请求刷控制台 */
const AGENT_PROFILE_AUTH_BACKOFF_MS = 60_000;
let agentProfileCache: { value: AgentProfile | null; expireAt: number; error?: string } | null = null;
let agentProfileInFlight: Promise<{ ok: boolean; profile: AgentProfile | null; error?: string }> | null = null;

const ROLES_CACHE_TTL_MS = 120_000;
const ROLES_BACKOFF_MS = 5000;
let rolesCache: { value: RoleDefinition[]; expireAt: number; error?: string } | null = null;
let rolesInFlight: Promise<{ ok: boolean; roles: RoleDefinition[]; error?: string }> | null = null;

const TASKS_IN_FLIGHT_KEY_MAX = 8;
const tasksInFlightMap = new Map<string, Promise<{ ok: boolean; tasks: BoardTask[]; next_cursor?: string | null; error?: string }>>();

function clearAgentProfileCache() {
  agentProfileCache = null;
  agentProfileInFlight = null;
}

function clearRolesCache() {
  rolesCache = null;
  rolesInFlight = null;
}

export interface BoardTask {
  id: string;
  task_id?: string;
  subject: string;
  description?: string;
  status: string;
  priority: number;
  scope?: "personal" | "org" | "public";
  workspace_path?: string | null;
  source_channel?: string;
  created_by?: string;
  cost_tier?: string;
  thread_id?: string;
  created_at?: string;
  updated_at?: string;
  result?: string;
  deliverables?: string[];
  changed_files?: string[];
  rollback_hint?: string;
  blocked_reason?: string;
  missing_information?: string[];
  blocked_at?: string | null;
  recovered_at?: string | null;
  splittable?: boolean;
  total_units?: number | null;
  claimed_units?: number;
  unit_label?: string | null;
  parent_task_id?: string | null;
  subtask_ids?: string[];
  required_skills?: string[];
  human_checkpoints?: {
    checkpoint_id?: string;
    after_step?: string;
    action?: string;
    description?: string;
    options?: string[] | null;
    status?: "pending" | "approved" | "rejected" | string;
    last_decision?: string;
    reviewed_at?: string;
  }[];
  human_reviews?: Array<{ checkpoint_id?: string; decision?: string; feedback?: string; at?: string }>;
  decision_points?: Array<{ type?: string; checkpoint_id?: string; decision?: string; feedback?: string; at?: string; reason?: string; summary?: string }>;
  skill_hints?: string[];
  progress?: number;
  progress_message?: string | null;
  external_task_id?: string | null;
  pricing?: Record<string, unknown> | null;
  skill_profile?: string;
  role_id?: string | null;
  bids?: BoardBid[];
  claimed_by?: string | null;
  ui_blocks?: Array<{ type: string; title?: string; data?: any }>;
  dispatch_state?: string;
  status_projection_source?: string;
  status_projection_at?: string;
  execution?: {
    active_run_id?: string | null;
    last_success_step_seq?: number;
    completed_step_ids?: string[];
    inflight_step_ids?: string[];
    idempotency_key?: string;
    execution_fingerprint?: string;
    lease_owner?: string | null;
    lease_expires_at?: string | null;
    last_event_seq?: number;
    recovery_point?: {
      step_id?: string;
      seq?: number;
      at?: string;
      reason?: string;
    } | null;
    state_version?: number;
    recovery_available?: boolean;
    recovery_reason?: string;
  };
}

export interface BoardTaskExecutionState {
  task_id: string;
  status?: string;
  thread_id?: string | null;
  run_id?: string | null;
  execution?: Record<string, unknown>;
}

export interface BoardBid {
  agent_id: string;
  confidence: number;
  skill_match?: number;
  reason?: string;
  estimated_effort?: string;
  bid_time?: string;
}

export interface AgentProfile {
  agent_id?: string;
  name?: string;
  description?: string;
  active_role_id?: string;
  skill_profile?: string;
  capabilities?: {
    skills?: string[];
    domains?: string[];
    modes?: string[];
    max_parallel_tasks?: number;
    supported_input_types?: string[];
    supported_output_types?: string[];
  };
  resources?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
  network?: { openclaw_enabled?: boolean; channels?: string[] };
  features?: {
    organization_mode?: boolean;
    tradeable_mode?: boolean;
    wallet_enabled?: boolean;
  };
}

export interface AssessmentResult {
  can_do: boolean;
  skill_match: number;
  matched_skills: string[];
  estimated_cost: number;
  estimated_time_minutes: number;
  capacity: number | null;
}

export interface BoardCapabilityProfile {
  id: string;
  label: string;
  description: string;
  capabilities_summary: string;
}

export interface AutonomousTaskConfig {
  id: string;
  subject?: string;
  description?: string;
  schedule?: string;
  enabled?: boolean;
  auto_assign?: boolean;
}

export interface AutonomousRun {
  task_id?: string;
  subject?: string;
  slot?: string;
  triggered_at?: string;
  thread_id?: string;
  run_id?: string;
}

export interface AutonomousRunDetail {
  run?: AutonomousRun;
  thread_id?: string | null;
  task_config?: AutonomousTaskConfig | null;
  logs?: Array<Record<string, unknown>>;
  logs_count?: number;
}

export interface AutonomousWatcherConfigState {
  enabled?: boolean;
  role_id?: string;
}

export interface AutonomousWatcherRuntimeState {
  enabled?: boolean;
  assistant_id?: string;
  scope?: string;
  scheduler_running?: boolean;
  executing_tasks?: number;
  invites_observability?: {
    scan_search_calls?: number;
    scan_fallback_calls?: number;
    scan_search_rows?: number;
    scan_fallback_rows?: number;
    scan_search_errors?: number;
    rows_seen?: number;
    processable_rows?: number;
    ignored?: number;
    skipped?: number;
    invalid?: number;
    bid_submitted?: number;
    bid_failed?: number;
    loop_errors?: number;
    last_scan_path?: string;
    last_scan_at?: string;
    last_error?: string;
  };
}

export interface SpawnRecord {
  ts?: string;
  parent_agent_id?: string;
  child_agent_id?: string;
  role?: string;
  reason?: string;
  task_id?: string | null;
  consumed?: boolean;
}

export interface SpawnConsumeRow {
  role?: string;
  child_agent_id?: string;
  task_id?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface CollaborationMetricRow {
  ts?: string;
  task_id?: string | null;
  parent_agent_id?: string | null;
  child_agent_id?: string | null;
  role?: string | null;
  reason?: string;
  metrics?: {
    active_count?: number;
    completed_count?: number;
    failed_count?: number;
    total_count?: number;
    failure_rate?: number;
    avg_duration_minutes?: number | null;
    contribution_score?: number;
  };
}

export interface ReliabilityMetrics {
  scope?: string;
  window_hours?: number;
  task_count?: number;
  terminal_count?: number;
  completed_count?: number;
  success_rate?: number;
  blocked_total?: number;
  blocked_recovered?: number;
  blocked_recovery_rate?: number;
  human_intervened_count?: number;
  human_intervention_rate?: number;
  deliverable_ready_count?: number;
  deliverable_effective_rate?: number;
  excluded_task_count_by_source?: number;
  excluded_source_channels?: string[];
  failed_count?: number;
  cancelled_count?: number;
}

export interface ReleaseGateSummary {
  overall_status?: string;
  profile_gate_status?: string;
  generated_at?: string;
  blocking_reasons?: string[];
  evidence?: Record<string, any>;
}

export interface OrganizationResourceQuota {
  cpu_slots?: number;
  model_calls_per_hour?: number;
  usd_budget_daily?: number;
}

export interface OrganizationLearningRecent {
  success_patterns: Array<Record<string, unknown>>;
  failure_lessons: Array<Record<string, unknown>>;
}

/** 角色定义（对应 backend/config/roles.json） */
export interface RoleDefinition {
  id: string;
  label: string;
  icon?: string;
  description: string;
  skill_profile: string;
  skill_profile_label?: string;
  skill_profile_description?: string;
  capabilities_summary?: string;
  responsibility_scope?: string;
  not_responsible_for?: string[];
  preferred_fourth_mode?: "debug" | "review" | null;
  modes?: string[];
  capabilities?: { id: string; label: string; skill?: string | null }[];
  resolved_capabilities?: { id: string; label: string; skill?: string | null; domain?: string; description?: string }[];
  resolved_capabilities_count?: number;
  suggested_questions?: string[];
}

const NETWORK_ERROR = "网络错误";
const FETCH_TIMEOUT_MS = 30_000;

function anySignal(signals: AbortSignal[]): AbortSignal {
  const c = new AbortController();
  for (const s of signals) s.addEventListener("abort", () => c.abort(), { once: true });
  return c.signal;
}

/** 包装 Promise，超时后拒绝并在 settle 后清除定时器，避免泄漏。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T>;
/** 传入工厂函数时，超时后 abort 传入的 signal，从而取消底层 fetch。 */
function withTimeout<T>(createPromise: (signal: AbortSignal) => Promise<T>, timeoutMs?: number): Promise<T>;
function withTimeout<T>(
  promiseOrFactory: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<T> {
  if (typeof promiseOrFactory === "function") {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeoutMs);
    let p: Promise<T>;
    try {
      p = promiseOrFactory(controller.signal);
    } catch (e) {
      clearTimeout(tid);
      throw e;
    }
    return Promise.race([
      p,
      new Promise<never>((_, rej) => {
        controller.signal.addEventListener("abort", () => rej(new Error("timeout")), { once: true });
      }),
    ]).finally(() => clearTimeout(tid));
  }
  let tid: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    tid = setTimeout(() => rej(new Error("timeout")), timeoutMs);
  });
  return Promise.race([promiseOrFactory, timeout]).finally(() => {
    if (tid !== undefined) clearTimeout(tid);
  });
}

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let abortHandler: (() => void) | null = null;
  if (init?.signal) {
    if (init.signal.aborted) {
      controller.abort();
    } else {
      abortHandler = () => controller.abort();
      init.signal.addEventListener("abort", abortHandler, { once: true });
    }
  }
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
    if (abortHandler && init?.signal) {
      init.signal.removeEventListener("abort", abortHandler);
    }
  }
}

async function authedFetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs?: number
): Promise<Response> {
  const authHeaders = (apiClient as any).buildHeaders(false) as Record<string, string>;
  return fetchWithTimeout(url, {
    ...init,
    headers: { ...(authHeaders ?? {}), ...((init?.headers as Record<string, string>) ?? {}) },
  }, timeoutMs ?? FETCH_TIMEOUT_MS);
}

export const boardApi = {
  async getTasks(
    scope: string = "personal",
    status?: string,
    roleId?: string,
    options?: { signal?: AbortSignal; limit?: number; cursor?: string | null; workspacePath?: string | null }
  ): Promise<{ ok: boolean; tasks: BoardTask[]; next_cursor?: string | null; error?: string }> {
    const { limit, cursor, workspacePath } = options ?? {};
    const inFlightKey = options?.signal != null || cursor != null ? null : `${scope}:${status ?? ""}:${roleId ?? ""}:${limit ?? ""}:${workspacePath ?? ""}`;
    if (inFlightKey && tasksInFlightMap.has(inFlightKey)) {
      return tasksInFlightMap.get(inFlightKey)!;
    }
    const run = (async (): Promise<{ ok: boolean; tasks: BoardTask[]; next_cursor?: string | null; error?: string }> => {
      try {
        const raw = await withTimeout((timeoutSignal) =>
          apiClient.get<any>("board/tasks", {
            scope,
            ...(status ? { status } : {}),
            ...(roleId ? { role_id: roleId } : {}),
            ...(limit != null ? { limit } : {}),
            ...(cursor != null && cursor !== "" ? { cursor } : {}),
            ...(workspacePath != null && workspacePath !== "" ? { workspace_path: workspacePath } : {}),
          }, false, { signal: options?.signal ? anySignal([options.signal, timeoutSignal]) : timeoutSignal })
        );
        const ok = (raw as any).ok === true || (raw as any).success === true;
        const data = (raw as any).data ?? raw;
        const tasks = Array.isArray(data?.tasks) ? data.tasks : Array.isArray(data) ? data : Array.isArray((raw as any).tasks) ? (raw as any).tasks : [];
        const next_cursor = (raw as any).next_cursor ?? data?.next_cursor ?? null;
        const errMsg = (raw as any).error ?? (raw as any).detail ?? NETWORK_ERROR;
        if (!ok) return { ok: false, tasks: tasks ?? [], next_cursor: null, error: errMsg };
        return { ok: true, tasks, next_cursor };
      } catch (e) {
        return { ok: false, tasks: [], next_cursor: null, error: formatApiErrorMessage(e) || NETWORK_ERROR };
      } finally {
        if (inFlightKey) tasksInFlightMap.delete(inFlightKey);
      }
    })();
    if (inFlightKey) {
      if (tasksInFlightMap.size >= TASKS_IN_FLIGHT_KEY_MAX) {
        const firstKey = tasksInFlightMap.keys().next().value;
        if (firstKey) tasksInFlightMap.delete(firstKey);
      }
      tasksInFlightMap.set(inFlightKey, run);
    }
    return run;
  },

  async getTask(
    taskId: string,
    scope?: "personal" | "org" | "public"
  ): Promise<{ ok: boolean; task: BoardTask | null; error?: string }> {
    try {
      const qs = scope ? `?scope=${encodeURIComponent(scope)}` : "";
      const raw = await withTimeout((signal) =>
        apiClient.get<any>(`board/tasks/${encodeURIComponent(taskId)}${qs}`, undefined, false, { signal })
      );
      const ok = (raw as any).success ?? (raw as any).ok ?? true;
      const task = (raw as any).task ?? (raw as any).data?.task ?? null;
      const errMsg = (raw as any).error ?? (raw as any).detail;
      if (!ok) return { ok: false, task: null, error: errMsg ?? "未找到任务" };
      if (task && typeof task === "object") {
        const patchedTask = {
          ...task,
          id: task.id || taskId,
          task_id: task.task_id || taskId,
        };
        return { ok: true, task: patchedTask as BoardTask | null };
      }
      return { ok: true, task: task as BoardTask | null };
    } catch (e) {
      return { ok: false, task: null, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async getAutonomousScheduleState(params?: {
    limit?: number;
    offset?: number;
    task_id?: string;
    thread_id?: string;
    start_at?: string;
    end_at?: string;
  }): Promise<{
    ok: boolean;
    tasks: Record<string, { last_slot?: string; last_run_at?: string }>;
    recent_runs: Array<{ task_id?: string; subject?: string; slot?: string; triggered_at?: string; thread_id?: string; run_id?: string }>;
    total?: number;
    offset?: number;
    limit?: number;
    error?: string;
  }> {
    try {
      const qs = new URLSearchParams();
      if (params?.limit != null) qs.set("limit", String(params.limit));
      if (params?.offset != null) qs.set("offset", String(params.offset));
      if (params?.task_id) qs.set("task_id", params.task_id);
      const tid = validServerThreadIdOrUndefined(params?.thread_id);
      if (tid) qs.set("thread_id", tid);
      if (params?.start_at) qs.set("start_at", params.start_at);
      if (params?.end_at) qs.set("end_at", params.end_at);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const res = await authedFetchWithTimeout(`${getApiBase()}/autonomous/schedule-state${suffix}`);
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) {
        return { ok: false, tasks: {}, recent_runs: [], error: "响应解析失败" };
      }
      if (!res.ok) {
        return {
          ok: false,
          tasks: {},
          recent_runs: [],
          error: getApiErrorBody(data, res.statusText),
        };
      }
      return {
        ok: true,
        tasks: (data as any).tasks && typeof (data as any).tasks === "object" ? (data as any).tasks : {},
        recent_runs: Array.isArray((data as any).recent_runs) ? (data as any).recent_runs : [],
        total: Number.isFinite((data as any).total) ? Number((data as any).total) : undefined,
        offset: Number.isFinite((data as any).offset) ? Number((data as any).offset) : undefined,
        limit: Number.isFinite((data as any).limit) ? Number((data as any).limit) : undefined,
      };
    } catch (e) {
      return { ok: false, tasks: {}, recent_runs: [], error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async getAutonomousTasks(): Promise<{ ok: boolean; tasks: AutonomousTaskConfig[]; total?: number; error?: string }> {
    try {
      const res = await authedFetchWithTimeout(`${getApiBase()}/autonomous/tasks`);
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) {
        return { ok: false, tasks: [], error: "响应解析失败" };
      }
      if (!res.ok) {
        return { ok: false, tasks: [], error: getApiErrorBody(data, res.statusText) };
      }
      return {
        ok: true,
        tasks: Array.isArray((data as any).tasks) ? (data as any).tasks : [],
        total: Number.isFinite((data as any).total) ? Number((data as any).total) : undefined,
      };
    } catch (e) {
      return { ok: false, tasks: [], error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async getAutonomousWatcherConfig(): Promise<{
    ok: boolean;
    config: AutonomousWatcherConfigState;
    runtime: AutonomousWatcherRuntimeState;
    available_roles?: Array<{ id: string; label?: string; description?: string; skill_profile?: string }>;
    error?: string;
  }> {
    try {
      const res = await authedFetchWithTimeout(`${getApiBase()}/autonomous/watcher/config`);
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) {
        return {
          ok: false,
          config: { enabled: false, role_id: "" },
          runtime: { enabled: false, assistant_id: "", scope: "personal", scheduler_running: false, executing_tasks: 0 },
          error: "响应解析失败",
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          config: { enabled: false, role_id: "" },
          runtime: { enabled: false, assistant_id: "", scope: "personal", scheduler_running: false, executing_tasks: 0 },
          error: getApiErrorBody(data, res.statusText),
        };
      }
      return {
        ok: Boolean((data as any)?.ok ?? true),
        config: (data as any)?.config ?? { enabled: false, role_id: "" },
        runtime: (data as any)?.runtime ?? { enabled: false, assistant_id: "", scope: "personal", scheduler_running: false, executing_tasks: 0 },
        available_roles: Array.isArray((data as any)?.available_roles) ? (data as any).available_roles : [],
        error: (data as any)?.error,
      };
    } catch (e) {
      return {
        ok: false,
        config: { enabled: false, role_id: "" },
        runtime: { enabled: false, assistant_id: "", scope: "personal", scheduler_running: false, executing_tasks: 0 },
        error: formatApiErrorMessage(e) || NETWORK_ERROR,
      };
    }
  },

  async updateAutonomousTask(
    taskId: string,
    updates: Partial<Pick<AutonomousTaskConfig, "enabled" | "schedule" | "description" | "auto_assign">>
  ): Promise<{ ok: boolean; task?: AutonomousTaskConfig; error?: string }> {
    try {
      const res = await authedFetchWithTimeout(`${getApiBase()}/autonomous/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, error: "响应解析失败" };
      if (!res.ok) return { ok: false, error: getApiErrorBody(data, res.statusText) };
      return { ok: true, task: (data as any).task };
    } catch (e) {
      return { ok: false, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async triggerAutonomousTask(taskId: string): Promise<{ ok: boolean; created?: { thread_id?: string; run_id?: string }; error?: string }> {
    try {
      const res = await authedFetchWithTimeout(`${getApiBase()}/autonomous/tasks/${encodeURIComponent(taskId)}/trigger`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, error: "响应解析失败" };
      if (!res.ok) return { ok: false, error: getApiErrorBody(data, res.statusText) };
      return { ok: true, created: (data as any).created };
    } catch (e) {
      return { ok: false, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async getAutonomousRunDetail(
    runId: string,
    limit: number = 20
  ): Promise<{ ok: boolean; detail?: AutonomousRunDetail; error?: string }> {
    try {
      const qs = new URLSearchParams();
      qs.set("limit", String(limit));
      const res = await authedFetchWithTimeout(`${getApiBase()}/autonomous/runs/${encodeURIComponent(runId)}?${qs.toString()}`);
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, error: "响应解析失败" };
      if (!res.ok) return { ok: false, error: getApiErrorBody(data, res.statusText) };
      return {
        ok: true,
        detail: {
          run: (data as any)?.run,
          thread_id: (data as any)?.thread_id,
          task_config: (data as any)?.task_config,
          logs: Array.isArray((data as any)?.logs) ? (data as any).logs : [],
          logs_count: Number.isFinite((data as any)?.logs_count) ? Number((data as any).logs_count) : 0,
        },
      };
    } catch (e) {
      return { ok: false, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async cancelAutonomousRun(runId: string): Promise<{ ok: boolean; thread_id?: string; error?: string }> {
    try {
      const res = await authedFetchWithTimeout(`${getApiBase()}/autonomous/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, error: "响应解析失败" };
      if (!res.ok) return { ok: false, error: getApiErrorBody(data, res.statusText) };
      return { ok: true, thread_id: (data as any)?.thread_id };
    } catch (e) {
      return { ok: false, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  /** 获取任务竞标列表（自治认领模式） */
  async getBids(taskId: string, scope: string = "personal"): Promise<{ ok: boolean; task_id: string; bids: BoardBid[]; error?: string }> {
    try {
      const res = await authedFetchWithTimeout(`${getApiBase()}/board/tasks/${encodeURIComponent(taskId)}/bids?scope=${encodeURIComponent(scope)}`);
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, task_id: taskId, bids: [], error: "响应解析失败" };
      if (!res.ok) return { ok: false, task_id: taskId, bids: [], error: getApiErrorBody(data, res.statusText) };
      return { ok: true, task_id: taskId, bids: Array.isArray(data.bids) ? data.bids : [] };
    } catch (e) {
      return { ok: false, task_id: taskId, bids: [], error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  /** Agent 提交竞标，请求头携带 X-Agent-Id 与 body.agent_id 一致 */
  async submitBid(
    taskId: string,
    body: { agent_id: string; confidence?: number; reason?: string; estimated_effort?: string },
    scope: string = "personal"
  ): Promise<{ ok: boolean; task_id?: string; agent_id?: string; task?: BoardTask; error?: string }> {
    try {
      const res = await authedFetchWithTimeout(
        `${getApiBase()}/board/tasks/${encodeURIComponent(taskId)}/bids?scope=${encodeURIComponent(scope)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Agent-Id": body.agent_id },
          body: JSON.stringify(body),
        }
      );
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, error: "响应解析失败" };
      if (!res.ok) return { ok: false, error: getApiErrorBody(data, res.statusText) };
      return { ok: true, task_id: data?.task_id, agent_id: data?.agent_id, task: data?.task };
    } catch (e) {
      return { ok: false, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  /** 确认竞标：指定 agent_id 或由后端按 strategy 选择 */
  async acceptBid(
    taskId: string,
    params: { agent_id?: string; strategy?: string },
    scope: string = "personal"
  ): Promise<{ ok: boolean; task_id?: string; claimed_by?: string; bid?: BoardBid; dispatch_state?: string; error?: string }> {
    try {
      const res = await authedFetchWithTimeout(`${getApiBase()}/board/tasks/${encodeURIComponent(taskId)}/accept-bid?scope=${encodeURIComponent(scope)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, error: "响应解析失败" };
      if (!res.ok) return { ok: false, error: getApiErrorBody(data, res.statusText) };
      return { ok: true, ...data };
    } catch (e) {
      return { ok: false, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  /** 自动选择最优竞标者 */
  async autoAssign(taskId: string, strategy: string = "fair_weighted", scope: string = "personal"): Promise<{ ok: boolean; task_id?: string; claimed_by?: string; bid?: BoardBid; dispatch_state?: string; error?: string }> {
    try {
      const res = await authedFetchWithTimeout(`${getApiBase()}/board/tasks/${encodeURIComponent(taskId)}/auto-assign?strategy=${encodeURIComponent(strategy)}&scope=${encodeURIComponent(scope)}`, { method: "POST" });
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, error: "响应解析失败" };
      if (!res.ok) return { ok: false, error: getApiErrorBody(data, res.statusText) };
      return { ok: true, ...data };
    } catch (e) {
      return { ok: false, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async createTask(body: {
    subject: string;
    description?: string;
    priority?: number;
    scope?: string;
    workspace_path?: string;
    source_channel?: string;
    cost_tier?: string;
    splittable?: boolean;
    total_units?: number;
    unit_label?: string;
    required_skills?: string[];
    human_checkpoints?: { after_step?: string; action?: string; description?: string; options?: string[] }[];
    require_plan_confirmation?: boolean;
    skill_profile?: string;
    role_id?: string;
  }): Promise<{ ok: boolean; task_id?: string; task?: BoardTask; dispatch_state?: string; error?: string }> {
    try {
      const data = await apiClient.post<any>("board/tasks", body);
      if (data && (data as any).ok === false) return { ok: false, error: getApiErrorBody(data, "请求失败") };
      if (!data || (data.task_id == null && !data.task)) return { ok: false, error: "响应解析失败" };
      return { ok: true, task_id: data.task_id ?? data.task?.id, task: data.task ?? undefined, dispatch_state: (data as any).dispatch_state };
    } catch (e) {
      return { ok: false, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async updateTask(
    taskId: string,
    updates: {
      scope?: string;
      status?: string;
      result?: string;
      thread_id?: string | null;
      claimed_by?: string | null;
      deliverables?: string[];
      changed_files?: string[];
      rollback_hint?: string;
      blocked_reason?: string;
      missing_information?: string[];
      progress?: number;
      progress_message?: string;
      description?: string;
    }
  ): Promise<{ ok: boolean; task?: BoardTask; error?: string }> {
    try {
      const data = await withTimeout(
        apiClient.patch<any>(`board/tasks/${encodeURIComponent(taskId)}`, updates)
      );
      if (data?.ok === false) return { ok: false, error: getApiErrorBody(data, "请求失败") };
      return { ok: true, task: data?.task ?? data };
    } catch (e) {
      return { ok: false, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  /** 软删除：后端暂无 DELETE 接口，通过将 status 置为 cancelled 实现；后续若提供 DELETE 可改为直调。 */
  async deleteTask(taskId: string, scope: string = "personal"): Promise<{ ok: boolean; error?: string }> {
    return this.updateTask(taskId, { status: "cancelled", scope }).then((r) => (r.ok ? { ok: true } : { ok: false, error: r.error }));
  },

  async getTaskExecutionState(
    taskId: string,
    scope: string = "personal"
  ): Promise<{ ok: boolean; state?: BoardTaskExecutionState; error?: string }> {
    try {
      const data = await apiClient.get<any>(`board/tasks/${encodeURIComponent(taskId)}/execution-state`, { scope });
      if (!data || data.ok === false) return { ok: false, error: getApiErrorBody(data, "响应解析失败") };
      return { ok: true, state: data.state as BoardTaskExecutionState };
    } catch (e) {
      return { ok: false, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async resumeTask(
    taskId: string,
    payload?: {
      scope?: string;
      reason?: string;
      thread_id?: string;
      run_id?: string;
      force_prompt_fallback?: boolean;
    }
  ): Promise<{ ok: boolean; resumed?: boolean; mode?: string; state?: BoardTaskExecutionState; error?: string }> {
    try {
      const data = await apiClient.post<any>(`board/tasks/${encodeURIComponent(taskId)}/resume`, payload || {});
      if (!data || data.ok === false) return { ok: false, error: getApiErrorBody(data, "响应解析失败") };
      return {
        ok: true,
        resumed: Boolean(data.resumed),
        mode: String(data.mode || ""),
        state: data.state as BoardTaskExecutionState,
      };
    } catch (e) {
      return { ok: false, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async reportTaskStepComplete(
    taskId: string,
    runId: string,
    payload: {
      step_id: string;
      step_seq?: number;
      event_seq?: number;
      result_digest?: string;
      scope?: string;
    }
  ): Promise<{ ok: boolean; deduped?: boolean; state?: BoardTaskExecutionState; error?: string }> {
    try {
      const data = await apiClient.post<any>(
        `board/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/step-complete`,
        payload
      );
      if (!data || data.ok === false) return { ok: false, error: getApiErrorBody(data, "响应解析失败") };
      return {
        ok: true,
        deduped: Boolean(data.deduped),
        state: data.state as BoardTaskExecutionState,
      };
    } catch (e) {
      return { ok: false, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async reportBlocked(
    taskId: string,
    payload: { reason: string; missing_info?: string[]; scope?: string }
  ): Promise<{ ok: boolean; task?: BoardTask; error?: string }> {
    try {
      const scope = payload.scope || "personal";
      const data = await apiClient.post<any>(
        `board/tasks/${encodeURIComponent(taskId)}/blocked?scope=${encodeURIComponent(scope)}`,
        {
          reason: payload.reason,
          missing_info: payload.missing_info || [],
        }
      );
      if (data && (data as any).ok === false) return { ok: false, error: getApiErrorBody(data, "操作失败") };
      return { ok: true, task: (data as any).task };
    } catch (e) {
      return { ok: false, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async reportArtifacts(
    taskId: string,
    payload: {
      deliverables?: string[];
      changed_files?: string[];
      rollback_hint?: string;
      scope?: string;
    }
  ): Promise<{ ok: boolean; task?: BoardTask; error?: string }> {
    try {
      const scope = payload.scope || "personal";
      const data = await apiClient.post<any>(
        `board/tasks/${encodeURIComponent(taskId)}/artifacts?scope=${encodeURIComponent(scope)}`,
        {
          deliverables: payload.deliverables || [],
          changed_files: payload.changed_files || [],
          rollback_hint: payload.rollback_hint || "",
        }
      );
      if (data && (data as any).ok === false) return { ok: false, error: getApiErrorBody(data, "操作失败") };
      return { ok: true, task: (data as any).task };
    } catch (e) {
      return { ok: false, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async getCapabilities(profileId?: string): Promise<{
    ok: boolean;
    profiles: BoardCapabilityProfile[];
    capabilities_summary: string;
    error?: string;
  }> {
    try {
      const data = await apiClient.get<any>(
        "board/capabilities",
        profileId ? { profile_id: profileId } : undefined
      );
      if (data && (data as any).ok === false) {
        return { ok: false, profiles: [], capabilities_summary: "", error: getApiErrorBody(data, "请求失败") };
      }
      return { ok: true, profiles: Array.isArray(data?.profiles) ? data.profiles : [], capabilities_summary: data?.capabilities_summary ?? "" };
    } catch (e) {
      return { ok: false, profiles: [], capabilities_summary: "", error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async getReliabilityMetrics(params?: {
    scope?: "personal" | "org" | "public";
    window_hours?: number;
  }): Promise<{ ok: boolean; metrics?: ReliabilityMetrics; error?: string }> {
    try {
      const qs = new URLSearchParams();
      if (params?.scope) qs.set("scope", params.scope);
      if (params?.window_hours != null) qs.set("window_hours", String(params.window_hours));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const res = await authedFetchWithTimeout(`${getApiBase()}/board/metrics/reliability${suffix}`);
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) {
        return { ok: false, error: "响应解析失败" };
      }
      if (!res.ok || (data as any)?.ok === false) {
        return { ok: false, error: getApiErrorBody(data, res.statusText) };
      }
      return { ok: true, metrics: (data as any)?.metrics ?? {} };
    } catch (e) {
      return { ok: false, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async getLatestReleaseGateSummary(): Promise<{ ok: boolean; summary?: ReleaseGateSummary | null; error?: string }> {
    try {
      const res = await authedFetchWithTimeout(`${getApiBase()}/board/ops/latest-release-gate-summary`);
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) {
        return { ok: false, summary: null, error: "响应解析失败" };
      }
      if (!res.ok || (data as any)?.ok === false) {
        return { ok: false, summary: null, error: getApiErrorBody(data, res.statusText) };
      }
      return { ok: true, summary: (data as any)?.summary ?? null };
    } catch (e) {
      return { ok: false, summary: null, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async getConnections(): Promise<{
    ok: boolean;
    channels: { type: string; connected: boolean; latency_ms?: number | null }[];
    error?: string;
  }> {
    try {
      const data = await apiClient.get<any>("board/connections");
      if (data?.ok === false) {
        return { ok: false, channels: [], error: getApiErrorBody(data, "请求失败") };
      }
      return { ok: true, channels: Array.isArray(data?.channels) ? data.channels : [] };
    } catch (e) {
      return { ok: false, channels: [], error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async getSpawnRecords(params?: {
    limit?: number;
    pending_only?: boolean;
  }): Promise<{ ok: boolean; rows: SpawnRecord[]; pending_only?: boolean; error?: string }> {
    try {
      const qs = new URLSearchParams();
      if (params?.limit != null) qs.set("limit", String(params.limit));
      if (params?.pending_only != null) qs.set("pending_only", String(Boolean(params.pending_only)));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const res = await authedFetchWithTimeout(`${getApiBase()}/organization/spawn/records${suffix}`);
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) {
        return { ok: false, rows: [], pending_only: params?.pending_only, error: "响应解析失败" };
      }
      if (!res.ok) {
        return {
          ok: false,
          rows: [],
          pending_only: params?.pending_only,
          error: getApiErrorBody(data, res.statusText),
        };
      }
      return {
        ok: Boolean((data as any)?.ok ?? true),
        rows: Array.isArray((data as any)?.rows) ? (data as any).rows : [],
        pending_only: (data as any)?.pending_only,
        error: (data as any)?.error,
      };
    } catch (e) {
      return { ok: false, rows: [], pending_only: params?.pending_only, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async consumeSpawnRequests(
    params?: { limit?: number; consume?: boolean }
  ): Promise<{ ok: boolean; rows: SpawnConsumeRow[]; error?: string }> {
    try {
      const res = await authedFetchWithTimeout(`${getApiBase()}/organization/spawn/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limit: Number.isFinite(params?.limit) ? Number(params?.limit) : 2,
          consume: params?.consume !== false,
        }),
      });
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) {
        return { ok: false, rows: [], error: "响应解析失败" };
      }
      if (!res.ok || (data as any)?.ok === false) {
        return { ok: false, rows: [], error: getApiErrorBody(data, res.statusText) };
      }
      return {
        ok: true,
        rows: Array.isArray((data as any)?.rows) ? (data as any).rows : [],
      };
    } catch (e) {
      return { ok: false, rows: [], error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async getCollaborationMetrics(params?: {
    task_id?: string;
    scope?: string;
    limit?: number;
  }): Promise<{ ok: boolean; rows: CollaborationMetricRow[]; error?: string }> {
    try {
      const qs = new URLSearchParams();
      if (params?.task_id) qs.set("task_id", params.task_id);
      if (params?.scope) qs.set("scope", params.scope);
      if (params?.limit != null) qs.set("limit", String(params.limit));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const res = await authedFetchWithTimeout(`${getApiBase()}/organization/collaboration/metrics${suffix}`);
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) {
        return { ok: false, rows: [], error: "响应解析失败" };
      }
      if (!res.ok) return { ok: false, rows: [], error: getApiErrorBody(data, res.statusText) };
      return {
        ok: Boolean((data as any)?.ok ?? true),
        rows: Array.isArray((data as any)?.rows) ? (data as any).rows : [],
        error: (data as any)?.error,
      };
    } catch (e) {
      return { ok: false, rows: [], error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async getOrganizationResourceQuota(agentId: string): Promise<{ ok: boolean; quota?: OrganizationResourceQuota; error?: string }> {
    try {
      const res = await authedFetchWithTimeout(`${getApiBase()}/organization/resources/quota?agent_id=${encodeURIComponent(agentId)}`);
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) {
        return { ok: false, error: "响应解析失败" };
      }
      if (!res.ok) return { ok: false, error: getApiErrorBody(data, res.statusText) };
      return {
        ok: Boolean((data as any)?.ok ?? true),
        quota: (data as any)?.quota ?? undefined,
        error: (data as any)?.error,
      };
    } catch (e) {
      return { ok: false, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async setOrganizationResourceQuota(params: {
    agent_id: string;
    cpu_slots?: number;
    model_calls_per_hour?: number;
    usd_budget_daily?: number;
  }): Promise<{ ok: boolean; quota?: OrganizationResourceQuota; error?: string }> {
    try {
      const res = await authedFetchWithTimeout(`${getApiBase()}/organization/resources/quota`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) {
        return { ok: false, error: "响应解析失败" };
      }
      if (!res.ok) return { ok: false, error: getApiErrorBody(data, res.statusText) };
      return {
        ok: Boolean((data as any)?.ok ?? true),
        quota: (data as any)?.quota ?? undefined,
        error: (data as any)?.error,
      };
    } catch (e) {
      return { ok: false, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async getOrganizationLearningRecent(params?: {
    limit?: number;
    agent_id?: string;
    task_type?: string;
  }): Promise<{
    ok: boolean;
    rows: OrganizationLearningRecent;
    agent_score?: { success_count?: number; failure_count?: number; score?: number } | null;
    error?: string;
  }> {
    try {
      const qs = new URLSearchParams();
      if (params?.limit != null) qs.set("limit", String(params.limit));
      if (params?.agent_id) qs.set("agent_id", params.agent_id);
      if (params?.task_type) qs.set("task_type", params.task_type);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      const res = await authedFetchWithTimeout(`${getApiBase()}/organization/learning/recent${suffix}`);
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) {
        return { ok: false, rows: { success_patterns: [], failure_lessons: [] }, error: "响应解析失败" };
      }
      if (!res.ok) return { ok: false, rows: { success_patterns: [], failure_lessons: [] }, error: getApiErrorBody(data, res.statusText) };
      return {
        ok: Boolean((data as any)?.ok ?? true),
        rows: (data as any)?.rows ?? { success_patterns: [], failure_lessons: [] },
        agent_score: (data as any)?.agent_score ?? null,
        error: (data as any)?.error,
      };
    } catch (e) {
      return { ok: false, rows: { success_patterns: [], failure_lessons: [] }, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  /**
   * 获取 Agent 档案。带缓存与 in-flight 合并；失败（含 401）时 backoff 内不再请求。
   * 调用方禁止在失败后轮询或重复拉取，仅依赖本方法缓存或用户主动操作（如保存后刷新）再调。
   */
  async getAgentProfile(): Promise<{ ok: boolean; profile: AgentProfile | null; error?: string }> {
    const now = Date.now();
    if (agentProfileCache && agentProfileCache.expireAt > now) {
      const err = agentProfileCache.error;
      return err
        ? { ok: false, profile: null, error: err }
        : { ok: true, profile: agentProfileCache.value };
    }
    if (agentProfileInFlight) {
      return agentProfileInFlight;
    }
    agentProfileInFlight = (async () => {
    try {
      const data = await withTimeout(apiClient.get<any>("agent/profile"), FETCH_TIMEOUT_MS);
      const profile = data.profile ?? null;
      agentProfileCache = { value: profile, expireAt: Date.now() + AGENT_PROFILE_CACHE_TTL_MS };
      return { ok: true, profile };
    } catch (e) {
      const err =
        e instanceof Error && (e.name === "AbortError" || (e as Error).message === "timeout")
          ? "请求超时"
          : NETWORK_ERROR;
      const isAuthError = e instanceof Error && (e as Error & { name?: string }).name === "UnauthorizedError";
      const backoffMs = isAuthError ? AGENT_PROFILE_AUTH_BACKOFF_MS : AGENT_PROFILE_BACKOFF_MS;
      agentProfileCache = { value: null, expireAt: Date.now() + backoffMs, error: err };
      return { ok: false, profile: null, error: err };
    } finally {
      agentProfileInFlight = null;
    }
    })();
    return agentProfileInFlight;
  },

  /** 获取业务场景列表（与 backend/config/skill_profiles.json 一致，支持插件化扩展） */
  async getSkillProfiles(): Promise<{ ok: boolean; profiles: BoardCapabilityProfile[]; error?: string }> {
    const res = await skillsAPI.getProfiles().catch((e) => ({
      ok: false as const,
      profiles: [] as BoardCapabilityProfile[],
      error: String(e),
    }));
    return { ok: !!res.ok, profiles: (res.profiles as BoardCapabilityProfile[]) ?? [], error: (res as any).error };
  },

  async updateAgentProfile(
    updates: Partial<Pick<AgentProfile, "name" | "description" | "capabilities" | "resources" | "pricing" | "network">>
  ): Promise<{ ok: boolean; profile?: AgentProfile; error?: string }> {
    try {
      const data = await apiClient.patch<any>("agent/profile", updates);
      if (data?.ok === false) return { ok: false, error: getApiErrorBody(data, "请求失败") };
      if (!data?.profile) return { ok: false, error: "响应解析失败" };
      const profile = data.profile ?? data;
      clearAgentProfileCache();
      return { ok: true, profile };
    } catch (e) {
      return { ok: false, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async assessTask(task: BoardTask): Promise<{
    ok: boolean;
    assessment: AssessmentResult | null;
    error?: string;
  }> {
    try {
      const data = await apiClient.post<any>("agent/assess-task", { task });
      return { ok: true, assessment: data.assessment ?? null, error: data.error };
    } catch (e) {
      return { ok: false, assessment: null, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async reportProgress(
    taskId: string,
    progress: number,
    message?: string,
    scope?: string
  ): Promise<{ ok: boolean; task?: BoardTask; error?: string }> {
    try {
      const clamped = Math.max(0, Math.min(100, Math.round(Number(progress))));
      const scopeParam = scope ? `?scope=${encodeURIComponent(scope)}` : "";
      const data = await apiClient.post<any>(
        `board/tasks/${encodeURIComponent(taskId)}/progress${scopeParam}`,
        { progress: clamped, message: message ?? "" }
      );
      if (data?.ok === false) return { ok: false, error: getApiErrorBody(data, "请求失败") };
      if (!data?.task) return { ok: false, error: "响应解析失败" };
      return { ok: true, task: data.task ?? data };
    } catch (e) {
      return { ok: false, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  async getSubtasks(
    taskId: string,
    scope?: string
  ): Promise<{ ok: boolean; task_id: string; subtasks: BoardTask[]; error?: string }> {
    try {
      const data = await apiClient.get<any>(
        `board/tasks/${encodeURIComponent(taskId)}/subtasks`,
        scope ? { scope } : undefined
      );
      return { ok: true, task_id: data.task_id ?? taskId, subtasks: Array.isArray(data.subtasks) ? data.subtasks : [], error: data.error };
    } catch (e) {
      return { ok: false, task_id: taskId, subtasks: [], error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },

  /** 获取所有角色列表（120s 缓存 + 请求去重；失败时 5s 退避防风暴） */
  async listRoles(): Promise<{ ok: boolean; roles: RoleDefinition[]; error?: string }> {
    const now = Date.now();
    if (rolesCache && rolesCache.expireAt > now) {
      const err = rolesCache.error;
      return err
        ? { ok: false, roles: rolesCache.value, error: err }
        : { ok: true, roles: rolesCache.value };
    }
    if (rolesInFlight) return rolesInFlight;
    rolesInFlight = (async () => {
      try {
        const res = await rolesApi.listRoles().catch((e) => ({
          ok: false as const,
          roles: [] as RoleDefinition[],
          error: String(e),
        }));
        const roles = ((res.roles as RoleDefinition[]) ?? []);
        if (res.ok) {
          rolesCache = { value: roles, expireAt: Date.now() + ROLES_CACHE_TTL_MS };
        } else {
          const err = (res as any).error ?? NETWORK_ERROR;
          rolesCache = { value: [], expireAt: Date.now() + ROLES_BACKOFF_MS, error: err };
        }
        return { ok: !!res.ok, roles, error: (res as any).error };
      } finally {
        rolesInFlight = null;
      }
    })();
    return rolesInFlight;
  },

  /** 激活指定角色 */
  async activateRole(roleId: string): Promise<{ ok: boolean; profile?: AgentProfile; error?: string }> {
    clearAgentProfileCache();
    clearRolesCache();
    const res = await rolesApi.activateRole(roleId).catch((e) => ({
      ok: false as const,
      profile: null as AgentProfile | null,
      error: String(e),
    }));
    return { ok: !!res.ok, profile: (res.profile as AgentProfile | null) ?? undefined, error: (res as any).error };
  },

  async submitHumanReview(
    taskId: string,
    body: { checkpoint_id: string; decision: string; feedback?: string },
    scope?: string
  ): Promise<{ ok: boolean; task?: BoardTask; error?: string }> {
    try {
      const path = scope
        ? `board/tasks/${encodeURIComponent(taskId)}/human-review?scope=${encodeURIComponent(scope)}`
        : `board/tasks/${encodeURIComponent(taskId)}/human-review`;
      const data = await withTimeout(apiClient.post<any>(path, body));
      if (data?.ok === false) return { ok: false, error: getApiErrorBody(data, "请求失败") };
      return { ok: true, task: data?.task ?? data };
    } catch (e) {
      return { ok: false, error: formatApiErrorMessage(e) || NETWORK_ERROR };
    }
  },
};
