import { ThreadState, Client } from "@langchain/langgraph-sdk";
import {
  LangChainMessage,
  LangGraphMessagesEvent,
} from "@assistant-ui/react-langgraph";
import { getItem as getStorageItem } from "../safeStorage";
import { getCurrentThreadIdFromStorage, getCurrentWorkspacePathFromStorage } from "../sessionState";
import { t } from "../i18n";

// ============================================================
// LangGraph Client 配置
// ============================================================

/** 后端 JSON 错误体（发送/流式失败时解析用） */
interface ApiErrorBody {
  detail?: string;
  error?: string;
}

// API URL（优先级：设置页 baseURL > Electron 注入 > 环境变量 > 默认）
const STORAGE_BASE_URL_KEY = "maibot_settings_baseURL";
const normalizeApiUrl = (rawUrl: string): string => {
  const trimmed = String(rawUrl || "").trim().replace(/\/$/, "");
  if (!trimmed) return "http://127.0.0.1:2024";
  // 统一将 localhost 归一到 127.0.0.1，避免部分环境下 IPv4/IPv6 回环不一致导致连接失败
  return trimmed
    .replace(/^http:\/\/localhost(?=[:/]|$)/i, "http://127.0.0.1")
    .replace(/^https:\/\/localhost(?=[:/]|$)/i, "https://127.0.0.1");
};

export const getApiUrl = (): string => {
  if (typeof window !== "undefined") {
    const fromSettings = getStorageItem(STORAGE_BASE_URL_KEY);
    if (fromSettings && fromSettings.trim() !== "") {
      return normalizeApiUrl(fromSettings);
    }
    if ((window as any).__LANGGRAPH_API_URL__) {
      return normalizeApiUrl(String((window as any).__LANGGRAPH_API_URL__));
    }
  }
  return normalizeApiUrl(import.meta.env?.VITE_LANGGRAPH_API_URL || "http://127.0.0.1:2024");
};

/** 后端 API 根 URL（无尾部斜杠），供 knowledge、skills 等模块复用 */
export const getApiBase = (): string => getApiUrl().replace(/\/$/, "");

/** 与 langgraph.json graphs 的 key 一致，用于 runs.stream / runs.create */
export const LANGGRAPH_ASSISTANT_ID =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_LANGGRAPH_ASSISTANT_ID) ||
  "agent";

// Client 单例缓存（按 apiUrl），避免每次 sendMessage/cancelRun 新建
let _cachedClient: Client | null = null;
let _cachedApiUrl: string = "";

/** 设置页修改 base URL 后调用，使下次请求使用新地址 */
export function invalidateLangGraphClient(): void {
  _cachedClient = null;
  _cachedApiUrl = "";
  _healthStatus = { healthy: true, lastCheck: 0 };
}

const createClient = (): Client => {
  const apiUrl = getApiUrl();
  if (_cachedClient && _cachedApiUrl === apiUrl) {
    return _cachedClient;
  }
  _cachedApiUrl = apiUrl;
  _cachedClient = new Client({ apiUrl });
  return _cachedClient;
};

// 带超时的 Promise 包装器（.finally 中 clearTimeout 防止主 promise 完成后定时器仍运行）
const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId!);
  });
};

// 创建线程超时（后端冷启动或首请求可能较慢，适当放宽）
const CREATE_THREAD_TIMEOUT_MS = 30000;

// 获取线程状态超时（避免后端无响应时前端一直挂起，导致“输入后不处理”）
const GET_STATE_TIMEOUT_MS = 15000;

/** 后端 LangGraph API 要求 thread_id/run_id 为 UUID，本地占位符如 thread-{timestamp} 会触发 422 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isValidServerThreadId(threadId: string): boolean {
  return Boolean(threadId && UUID_REGEX.test(String(threadId).trim()));
}

/** 若为服务端 UUID 则返回 trim 后的 id，否则返回 undefined；用于「仅在使用合法 id 时写存储/传 API」的统一写法 */
export function validServerThreadIdOrUndefined(threadId: string | null | undefined): string | undefined {
  const t = typeof threadId === "string" ? threadId.trim() : "";
  return t && isValidServerThreadId(t) ? t : undefined;
}

/** run_id 与 thread_id 同格式，用于 runs.get / runs.cancel 等 */
export function isValidRunId(runId: string): boolean {
  return Boolean(runId && UUID_REGEX.test(String(runId).trim()));
}

// ============================================================
// 后端健康检查（生产级健壮性）
// ============================================================

/** 健康状态 */
export interface HealthStatus {
  healthy: boolean;
  lastCheck: number;
  latencyMs?: number;
  error?: string;
}

// 缓存健康状态（避免频繁检查）
let _healthStatus: HealthStatus = {
  healthy: true,
  lastCheck: 0,
};

/** 进行中的健康检查 Promise，用于并发去重 */
let _healthCheckInFlight: Promise<HealthStatus> | null = null;

// 健康检查间隔（30秒）
const HEALTH_CHECK_INTERVAL = 30000;

// 健康检查超时（20秒）：兼容 LangGraph 冷启动与首次模型加载
const HEALTH_CHECK_TIMEOUT = 20000;

/** 发送失败时“请先新建对话”的报错文案，供 isThreadNotFoundError 与 UI 统一识别 */
export const SEND_MESSAGE_INVALID_THREAD_ERROR =
  "当前会话 ID 无效（非服务端线程），请先新建对话";

/**
 * 判断是否为“线程不存在/无效”错误（后端重启后旧 thread_id、或本地占位符 thread 未创建）
 * 包含 404 与“非服务端线程”两种情况，UI 均可提示“新建会话”。
 */
export const isThreadNotFoundError = (error: unknown): boolean => {
  const err = error as { message?: string; status?: number; response?: { status?: number } };
  const status = err?.status ?? err?.response?.status;
  if (status === 404) return true;
  const message = String(err?.message ?? "");
  const lowerMessage = message.toLowerCase();
  if (message.includes(SEND_MESSAGE_INVALID_THREAD_ERROR)) return true;
  return (
    lowerMessage.includes("404") &&
    (lowerMessage.includes("thread") || lowerMessage.includes("/threads/") || lowerMessage.includes("not found"))
  );
};

/**
 * 检查后端健康状态
 * @param force 强制检查（忽略缓存）
 */
export const checkHealth = async (force: boolean = false): Promise<HealthStatus> => {
  const now = Date.now();
  if (!force && now - _healthStatus.lastCheck < HEALTH_CHECK_INTERVAL) {
    return _healthStatus;
  }
  if (_healthCheckInFlight) {
    const existing = _healthCheckInFlight;
    return existing;
  }
  const startTime = now;
  const promise = (async (): Promise<HealthStatus> => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      const apiUrl = getApiUrl();
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);
      const response = await fetch(`${apiUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startTime;
      if (response.ok) {
        _healthStatus = { healthy: true, lastCheck: now, latencyMs };
      } else {
        _healthStatus = { healthy: false, lastCheck: now, latencyMs, error: `HTTP ${response.status}` };
      }
      return _healthStatus;
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      _healthStatus = {
        healthy: false,
        lastCheck: now,
        latencyMs,
        error: error instanceof Error ? error.message : '连接失败',
      };
      return _healthStatus;
    } finally {
      if (timeoutId != null) clearTimeout(timeoutId);
    }
  })().finally(() => {
    _healthCheckInFlight = null;
  });
  _healthCheckInFlight = promise;
  return promise;
};

/**
 * 获取缓存的健康状态（不发起请求）
 */
export const getCachedHealthStatus = (): HealthStatus => {
  return _healthStatus;
};

/**
 * 等待后端恢复（带重试）
 * @param maxRetries 最大重试次数
 * @param retryInterval 重试间隔（毫秒）
 * @param onRetry 重试回调
 * @param signal 可选，中止时停止轮询并拒绝
 */
export const waitForBackend = async (
  maxRetries: number = 10,
  retryInterval: number = 3000,
  onRetry?: (attempt: number, error?: string) => void,
  signal?: AbortSignal
): Promise<boolean> => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new DOMException("waitForBackend aborted", "AbortError");
    const status = await checkHealth(true);
    if (status.healthy) {
      if (import.meta.env?.DEV) console.log(`[chatApi] ✅ 后端已恢复 (尝试 ${attempt}/${maxRetries})`);
      return true;
    }
    if (import.meta.env?.DEV) console.log(`[chatApi] ⏳ 等待后端恢复... (尝试 ${attempt}/${maxRetries}, 错误: ${status.error})`);
    onRetry?.(attempt, status.error);
    if (attempt < maxRetries) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, retryInterval);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("waitForBackend aborted", "AbortError"));
        }, { once: true });
      });
    }
  }
  console.error(`[chatApi] ❌ 后端恢复失败，已达到最大重试次数`);
  return false;
};

/**
 * 列出已上传文件（tmp/uploads）
 * 用于设置页或「已上传文件」展示
 * @param timeoutMs 超时毫秒，默认 10000
 */
export const listUploadedFiles = async (timeoutMs: number = 10000): Promise<{ filename: string; path: string; size: number }[]> => {
  const apiUrl = getApiUrl();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiUrl}/files/list`, { signal: controller.signal });
    if (!response.ok) {
      const err: ApiErrorBody = await response.json().catch((): ApiErrorBody => ({}));
      throw new Error(err.detail || err.error || `HTTP ${response.status}`);
    }
    const data = await response.json().catch(() => ({}));
    return Array.isArray(data?.files) ? data.files : [];
  } finally {
    clearTimeout(timeoutId);
  }
};

// ============================================================
// 线程生命周期管理
// ============================================================

/** createThread 返回值（LangGraph SDK threads.create） */
export interface CreateThreadResult {
  thread_id: string;
}

/**
 * 创建新线程
 * @param metadata 线程元数据（用户ID、创建时间等）
 */
export const createThread = async (metadata?: Record<string, unknown>): Promise<CreateThreadResult> => {
  const client = createClient();
  // 添加默认元数据用于生命周期管理
  const enrichedMetadata = {
    created_at: new Date().toISOString(),
    last_active_at: new Date().toISOString(),
    ...metadata,
  };

  try {
    // 使用缓存健康状态（30s），避免每次创建线程都强制探测 /ok
    const health = await checkHealth(false);
    if (!health.healthy) {
      throw new Error(
        `后端服务不可用（${health.error ?? "连接失败"}），请确认 LangGraph 服务已启动（如 \`langgraph dev\` 或 \`langgraph up\`），且地址与设置中的 Base URL 一致。`
      );
    }

    const doCreate = () =>
      withTimeout(
        client.threads.create({ metadata: enrichedMetadata }) as Promise<CreateThreadResult>,
        CREATE_THREAD_TIMEOUT_MS,
        `创建线程超时（${CREATE_THREAD_TIMEOUT_MS / 1000} 秒），请检查后端服务是否正常运行或稍后重试`
      );

    try {
      return await doCreate();
    } catch (firstError: unknown) {
      const msg = firstError instanceof Error ? firstError.message : String(firstError);
      if (msg.includes('超时') || msg.includes('timeout')) {
        if (import.meta.env?.DEV) console.warn('[chatApi] 创建线程超时，重试一次...');
        return await doCreate();
      }
      throw firstError;
    }
  } catch (error) {
    console.error('[chatApi] ❌ 创建线程失败:', error);
    throw error;
  }
};

/**
 * 列出线程（支持分页与工作区过滤，高线程量下避免截断导致找不到会话）
 * - limit/offset 用于分页；默认 limit=100
 * - 未传 metadata 时使用当前 maibot_workspace_path 作为 workspace_path 过滤
 */
export const listThreads = async (options?: {
  limit?: number;
  offset?: number;
  metadata?: Record<string, unknown>;
}) => {
  const client = createClient();
  try {
    const workspacePath = getCurrentWorkspacePathFromStorage();
    const metadata =
      options?.metadata ??
      (workspacePath ? { workspace_path: workspacePath } : undefined);
    const threads = await client.threads.search({
      limit: options?.limit || 100,
      offset: options?.offset || 0,
      metadata,
    });
    return threads;
  } catch (error) {
    console.error('[chatApi] 列出线程失败:', error);
    return [];
  }
};

/**
 * 删除线程（清理数据）
 * 非服务端 thread（如本地占位符）时直接返回 true，避免 422。
 */
export const deleteThread = async (threadId: string): Promise<boolean> => {
  if (!isValidServerThreadId(threadId)) return true;
  const client = createClient();
  try {
    await client.threads.delete(threadId);
    if (import.meta.env?.DEV) console.log('[chatApi] ✅ 线程已删除:', threadId);
    return true;
  } catch (error) {
    console.error('[chatApi] ❌ 删除线程失败:', error);
    return false;
  }
};

/**
 * 清理过期线程（基于 TTL）
 * @param ttlDays 线程保留天数，默认 7 天
 */
export const cleanupExpiredThreads = async (ttlDays: number = 7): Promise<number> => {
  const client = createClient();
  try {
    const rawThreads = await client.threads.search({ limit: 1000 });
    const threads = Array.isArray(rawThreads) ? rawThreads : ((rawThreads as { items?: unknown[] })?.items ?? []);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - ttlDays);

    const toDelete = threads.filter(
      (thread: { metadata?: { last_active_at?: string }; thread_id: string }) =>
        (thread.metadata?.last_active_at as string) && new Date(thread.metadata.last_active_at as string) < cutoffDate
    );
    const activeId = validServerThreadIdOrUndefined(getCurrentThreadIdFromStorage());
    const safeToDelete = toDelete.filter((t: { thread_id: string }) => !activeId || t.thread_id !== activeId);
    const results = await Promise.allSettled(
      safeToDelete.map((thread: { thread_id: string }) => client.threads.delete(thread.thread_id))
    );
    const deletedCount = results.filter((r) => r.status === "fulfilled").length;

    if (import.meta.env?.DEV) console.log(`[chatApi] ✅ 清理了 ${deletedCount} 个过期线程`);
    return deletedCount;
  } catch (error) {
    console.error('[chatApi] ❌ 清理线程失败:', error);
    return 0;
  }
};

/**
 * 更新线程活跃时间
 * 非服务端 thread 时直接返回，避免 422。
 */
export const touchThread = async (threadId: string): Promise<void> => {
  if (!isValidServerThreadId(threadId)) return;
  const client = createClient();
  try {
    await client.threads.update(threadId, {
      metadata: { last_active_at: new Date().toISOString() },
    });
  } catch (error) {
    // 静默失败，不影响主流程
    console.debug('[chatApi] 更新线程活跃时间失败:', error);
  }
};

/**
 * 更新线程标题（首条消息后用于列表展示）
 * 非服务端 thread 时直接返回，避免 422。
 */
export const updateThreadTitle = async (
  threadId: string,
  title: string
): Promise<void> => {
  if (!isValidServerThreadId(threadId)) return;
  const client = createClient();
  try {
    await client.threads.update(threadId, {
      metadata: { title: title.trim().slice(0, 80) || '新对话' },
    });
  } catch (error) {
    console.debug('[chatApi] 更新线程标题失败:', error);
  }
};

/** 非服务端 thread（如本地占位符 thread-{timestamp}）时的最小状态，避免请求 LangGraph 触发 422 */
const EMPTY_THREAD_STATE: ThreadState<Record<string, unknown>> = {
  values: {},
  next: [],
  tasks: [],
  interrupts: {},
} as ThreadState<Record<string, unknown>>;

export const getThreadState = async (
  threadId: string,
  timeoutMs?: number,
): Promise<ThreadState<Record<string, unknown>>> => {
  if (!isValidServerThreadId(threadId)) {
    return Promise.resolve(EMPTY_THREAD_STATE);
  }
  const client = createClient();
  const ms = timeoutMs ?? GET_STATE_TIMEOUT_MS;
  return withTimeout(
    client.threads.getState(threadId) as Promise<ThreadState<Record<string, unknown>>>,
    ms,
    `获取线程状态超时（${ms / 1000} 秒），请检查后端是否正常`
  );
};

/** 非服务端 thread 时直接 resolve，避免 422。 */
export const updateState = async (
  threadId: string,
  fields: {
    newState: Record<string, unknown>;
    asNode?: string;
  },
) => {
  if (!isValidServerThreadId(threadId)) return;
  const client = createClient();
  return client.threads.updateState(threadId, {
    values: fields.newState,
    ...(fields.asNode != null ? { asNode: fields.asNode } : {}),
  });
};

/**
 * ✅ 完全按照官方示例实现，支持 LangGraph Config
 * 官方示例：https://github.com/Yonom/assistant-ui/blob/main/examples/with-langgraph/lib/chatApi.ts
 * 
 * 关键点：
 * 1. 使用 streamMode: "messages" 实现 token 级别流式传输
 * 2. 支持通过 config 传递运行时配置（模型、任务、权限等）
 * 3. 直接返回 client.runs.stream() 的结果，不做任何转换
 * 4. 让 useLangGraphMessages 处理所有事件转换
 */
export interface LangGraphConfig {
  model_id?: string;
  model_temperature?: number;
  model_max_tokens?: number;
  task_type?: string;
  task_priority?: string;
  user_role?: string;
  debug_mode?: boolean;
  trace_id?: string;
  editor_path?: string;
  selected_text?: string;
  workspace_path?: string;
  /** 业务场景（skill_profile）：full | bidding | document | dev，后端按此加载能力子集 */
  skill_profile?: string;
  /** 请求元数据：用于后端调度/观测 */
  request_id?: string;
  request_enqueued_at?: string | number;
  session_id?: string;
  task_key?: string;
  cost_tier?: string;
  /** 会话级：本地/云端策略（local | cloud），供后端路由与 MAX_PARALLEL_* 使用；存储键 maibot_run_strategy_thread_{threadId} */
  run_strategy?: string;
  /** 会话级：并行级别（1|2|3 等），供后端并发调度；存储键 maibot_parallel_level_thread_{threadId} */
  parallel_level?: string;
  [key: string]: unknown;
}

const generateRequestId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

/**
 * 流式模式配置
 * - messages: LLM token 级流式输出
 * - custom: 工具自定义事件（进度、状态）
 * - updates: 状态更新（调试用）
 * - debug: 详细调试信息
 */
type StreamMode = "messages" | "custom" | "updates" | "values" | "debug";

export const sendMessage = (params: {
  threadId: string;
  messages: LangChainMessage[];
  config?: LangGraphConfig;
  /** 流式模式，默认 ["messages", "custom"] */
  streamModes?: StreamMode[];
  /** 是否启用调试模式 */
  debug?: boolean;
  /** 当 run 创建时回调（用于停止按钮拿到 run_id 并调用 cancel） */
  onRunCreated?: (params: { run_id: string; thread_id?: string }) => void;
  /** 用于停止时中断 fetch，使前端流立即结束 */
  signal?: AbortSignal;
}): AsyncGenerator<LangGraphMessagesEvent<LangChainMessage>> => {
  const threadId = String(params.threadId ?? "").trim();
  if (!threadId) {
    throw new Error("sendMessage 需要有效的 threadId（当前会话）");
  }
  if (!isValidServerThreadId(threadId)) {
    throw new Error(SEND_MESSAGE_INVALID_THREAD_ERROR);
  }
  const client = createClient();

  const input: Record<string, unknown> | null = {
    messages: params.messages,
  };
  
  const assistantId = LANGGRAPH_ASSISTANT_ID;

  // ✅ 构建完整的 config（按照 LangGraph 官方格式）
  const requestId = params.config?.request_id ? String(params.config.request_id) : generateRequestId();
  const enqueuedAt =
    params.config?.request_enqueued_at != null
      ? params.config.request_enqueued_at
      : new Date().toISOString();
  const sessionId = params.config?.session_id ? String(params.config.session_id) : threadId;
  const taskType = params.config?.task_type ? String(params.config.task_type) : "chat";
  const costTier = params.config?.cost_tier ? String(params.config.cost_tier) : "medium";
  const taskKey = params.config?.task_key ? String(params.config.task_key) : threadId;

  const config = params.config
    ? {
        configurable: {
          ...params.config,
          thread_id: threadId,
          request_id: requestId,
          request_enqueued_at: enqueuedAt,
          session_id: sessionId,
          task_key: taskKey,
          task_type: taskType,
          cost_tier: costTier,
        },
      }
    : {
        configurable: {
          thread_id: threadId,
          request_id: requestId,
          request_enqueued_at: enqueuedAt,
          session_id: sessionId,
          task_key: taskKey,
          task_type: taskType,
          cost_tier: costTier,
        },
      };

  // ✅ 流式模式配置
  // - 默认: ["messages", "custom", "updates"] - 消息流式 + 工具进度 + 完整消息列表（run 结束时收到 updates，merge 把 ToolMessage 填进 part.result，恢复「Agent 看到了什么、做了什么」展示）
  // - 调试: ["messages", "custom", "updates", "debug"] - 完整调试信息
  // ⚠️ 不要加 "values"：values 会在每步发送完整状态，useLangGraphMessages 会用 replaceMessages 覆盖正在流式的消息，导致流式失效
  let streamMode: StreamMode[] = params.streamModes ?? ["messages", "custom", "updates"];
  if (params.debug) {
    streamMode = ["messages", "custom", "updates", "debug"];
  }

  // ✅ 更新线程活跃时间（异步，不阻塞主流程）
  touchThread(threadId).catch((err) => { if (import.meta.env?.DEV) console.warn('[langserveChat] touchThread failed', err); });

  // ✅ 完全按照官方示例：直接返回 stream，不做任何转换
  // useLangGraphMessages 会自动处理所有事件类型（Messages, MessagesPartial, MessagesComplete, Updates 等）
  // onRunCreated：SDK 在收到首包 Content-Location 后会调用，用于停止按钮 cancel(threadId, run_id)
  return client.runs.stream(
    threadId,
    assistantId,
    {
      input,
      config, // ✅ 传递完整配置
      streamMode, // ✅ 可配置的流式模式
      streamSubgraphs: true,  // ✅ 关键修复：启用子图流式输出（deepagent 是 subgraph）
      onRunCreated: params.onRunCreated,
      signal: params.signal,
    },
  ) as AsyncGenerator<LangGraphMessagesEvent<LangChainMessage>>;
};

/**
 * 带重试的消息发送（与 Cursor 类似：不因延时或单次失败简单放弃，多轮重试后再报错）
 *
 * @param params 发送参数
 * @param options 重试选项（默认 4 次、退避延迟，仅用户主动取消或 stream 已开始后失败会立即抛）
 */
export async function* sendMessageWithRetry(
  params: {
    threadId: string;
    messages: LangChainMessage[];
    config?: LangGraphConfig;
    streamModes?: StreamMode[];
    debug?: boolean;
    onRunCreated?: (meta: { run_id: string }) => void;
    signal?: AbortSignal;
  },
  options: {
    maxRetries?: number;
    retryDelay?: number;
    onRetry?: (attempt: number, error: Error) => void;
  } = {}
): AsyncGenerator<LangGraphMessagesEvent<LangChainMessage>> {
  const { maxRetries = 4, retryDelay = 1500, onRetry } = options;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let streamStarted = false;
    try {
      if (params.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      if (attempt > 1) {
        const health = await checkHealth(true);
        if (!health.healthy) {
          throw new Error(`后端不可用: ${health.error ?? "连接失败"}`);
        }
      }

      const generator = sendMessage(params);
      for await (const event of generator) {
        streamStarted = true;
        yield event;
      }
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (params.signal?.aborted || lastError.name === "AbortError") {
        throw lastError;
      }
      if (streamStarted) {
        throw lastError;
      }
      if (import.meta.env?.DEV) console.warn(`[chatApi] 发送失败 (${attempt}/${maxRetries}):`, lastError.message);
      if (attempt >= maxRetries || isThreadNotFoundError(lastError)) break;
      onRetry?.(attempt, lastError);
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(id);
          params.signal?.removeEventListener("abort", onAbort);
          reject(new DOMException("Aborted", "AbortError"));
        };
        const id = setTimeout(() => {
          params.signal?.removeEventListener("abort", onAbort);
          resolve();
        }, retryDelay * attempt);
        params.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  if (lastError && isThreadNotFoundError(lastError)) {
    throw new Error("当前会话在后端不存在（可能后端已重启），请新建会话后重试", {
      cause: lastError,
    });
  }
  const msg = lastError?.message ?? "";
  if (msg.includes("Content-Type") || msg.includes("event-stream")) {
    throw new Error(
      "后端流式接口返回格式异常（需 text/event-stream），请查看 Network 中「runs/stream」请求的 Response Headers。",
      { cause: lastError ?? undefined }
    );
  }
  throw lastError ?? new Error("消息发送失败");
}

/**
 * 取消正在运行的任务。
 * @returns 是否实际取消了至少一个运行（无运行可取消时返回 false）
 */
export async function cancelRun(threadId: string, runId?: string): Promise<boolean> {
  if (!isValidServerThreadId(threadId)) return false;
  try {
    const client = createClient();

    if (runId && isValidRunId(runId)) {
      await client.runs.cancel(threadId, runId);
      if (import.meta.env?.DEV) console.log('[chatApi] ✅ 已取消运行:', runId);
      return true;
    }
    const runs = await client.runs.list(threadId, { limit: 20 });
    const activeRuns = (runs || []).filter(
      (r: { status?: string; run_id?: string }) =>
        (r.status === 'pending' || r.status === 'running') && r.run_id && isValidRunId(r.run_id)
    );
    if (activeRuns.length === 0) {
      if (import.meta.env?.DEV) console.debug('[chatApi] 无运行中任务可取消（首包前点击停止或未通过 onRunCreated 传递 run_id 时属正常）');
      return false;
    }
    const results = await Promise.allSettled(
      activeRuns.map((run) => client.runs.cancel(threadId, run.run_id))
    );
    const cancelledCount = results.filter((r) => r.status === "fulfilled").length;
    results.forEach((r, i) => {
      if (r.status === "fulfilled" && import.meta.env?.DEV) console.log('[chatApi] ✅ 已取消运行:', activeRuns[i]?.run_id);
    });
    return cancelledCount > 0;
  } catch (error) {
    console.error('[chatApi] ❌ 取消运行失败:', error);
    return false;
  }
}


// ============================================================
// Human-in-the-Loop 支持
// ============================================================

/**
 * 从单个 interrupt 对象解析为 getInterruptState 的返回形状
 */
function parseInterruptValue(interrupt: { value?: unknown }): {
  interrupted: true;
  question?: string;
  interruptType?: string;
  interruptData?: Record<string, unknown>;
} | null {
  const value = interrupt?.value;
  const isObj = value !== null && typeof value === 'object' && !Array.isArray(value);
  const obj = isObj ? (value as Record<string, unknown>) : null;
  const hasActionRequests = isObj && Array.isArray((obj as Record<string, unknown>).action_requests);
  // 纯字符串为 ask_user 中断，识别为 input_required，供 InterruptDialog 展示问题与输入框
  const interruptType =
    typeof value === 'string'
      ? 'input_required'
      : (obj?.type as string | undefined) ?? (hasActionRequests ? 'tool_diff_approval' : undefined);
  const interruptData = obj ?? undefined;
  const question =
    typeof value === 'string'
      ? value
      : (interruptType === 'human_checkpoint' || interruptType === 'plan_confirmation') && obj?.summary != null
        ? String(obj.summary)
        : hasActionRequests
          ? t('interrupt.toolDiffPrompt')
          : JSON.stringify(value);
  return {
    interrupted: true,
    question,
    ...(interruptType && { interruptType }),
    ...(interruptData && { interruptData: interruptData as Record<string, unknown> }),
  };
}

/**
 * 获取等待人工确认的中断状态
 *
 * LangGraph 可能返回 state.tasks[].interrupts 或 state.interrupts（task_id -> list）。
 * 兼容两种结构，取第一个待处理 interrupt 供 InterruptDialog 展示。
 */
const GET_INTERRUPT_STATE_TIMEOUT_MS = 25000;

export async function getInterruptState(threadId: string): Promise<{
  interrupted: boolean;
  question?: string;
  interruptType?: string;
  interruptData?: Record<string, unknown>;
}> {
  if (!threadId || !String(threadId).trim()) return { interrupted: false };
  if (!isValidServerThreadId(threadId)) return { interrupted: false };
  try {
    const state = await getThreadState(threadId, GET_INTERRUPT_STATE_TIMEOUT_MS);

    if (state.tasks && Array.isArray(state.tasks)) {
      for (const task of state.tasks) {
        if (task.interrupts && task.interrupts.length > 0) {
          const parsed = parseInterruptValue(task.interrupts[0]);
          if (parsed) return parsed;
        }
      }
    }

    const interruptsMap = state.interrupts as Record<string, Array<{ value?: unknown }>> | undefined;
    if (interruptsMap && typeof interruptsMap === 'object') {
      for (const taskId of Object.keys(interruptsMap)) {
        const list = interruptsMap[taskId];
        if (Array.isArray(list) && list.length > 0) {
          const parsed = parseInterruptValue(list[0]);
          if (parsed) return parsed;
        }
      }
    }

    return { interrupted: false };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes('超时')) {
      if (import.meta.env?.DEV) console.warn('[chatApi] 获取中断状态失败:', error);
    }
    return { interrupted: false };
  }
}

/**
 * 恢复被中断的运行（Human-in-the-Loop）
 *
 * response: true/false 表示确认/拒绝；字符串如 "approve"/"reject"；或 HITL 负载 { decisions: Array<{ type, message? }> }。
 * extra: 可选，确认时作为回复内容，拒绝时作为拒绝说明。
 * @returns 恢复后新 run 的 run_id，供前端接流续显；无法获取时为 undefined
 */
export async function resumeInterrupt(
  threadId: string,
  response: string | boolean | { decisions: Array<{ type: string; message?: string }> },
  extra?: string,
): Promise<{ run_id: string } | void> {
  if (!threadId || !String(threadId).trim()) return undefined;
  if (!isValidServerThreadId(threadId)) return undefined;
  const client = createClient();
  const assistantId = LANGGRAPH_ASSISTANT_ID;
  let resumePayload: unknown;
  if (typeof response === 'object' && response !== null && 'decisions' in response) {
    resumePayload = response;
  } else if (typeof response === 'boolean') {
    resumePayload = response ? (extra || 'yes') : (extra ? `reject: ${extra}` : 'no');
  } else {
    const normalized = String(response || '').trim().toLowerCase();
    if (
      normalized === 'approve' ||
      normalized === 'reject' ||
      normalized === 'revise' ||
      normalized === 'delegate' ||
      normalized === 'skip'
    ) {
      resumePayload = {
        decision: normalized,
        ...(extra ? { feedback: extra } : {}),
      };
    } else {
      resumePayload = extra ? `${response} ${extra}`.trim() : String(response);
    }
  }
  let runIdFromHeader: string | undefined;
  const run = await client.runs.create(threadId, assistantId, {
    command: { resume: resumePayload },
    onRunCreated: (meta) => {
      if (meta?.run_id) runIdFromHeader = meta.run_id;
    },
  });
  const runId = runIdFromHeader ?? (run as { run_id?: string } | undefined)?.run_id;
  if (runId) return { run_id: runId };
  return undefined;
}

/**
 * 按 run_id 接流（用于 resume 后继续展示同一 run 的输出）
 * 与 sendMessage 使用同一套 SSE 事件格式，供 runtime 消费。
 */
export async function* streamRun(
  threadId: string,
  runId: string,
  options?: {
    signal?: AbortSignal;
    streamMode?: string[];
    onRunCreated?: (meta: { run_id: string }) => void;
  },
): AsyncGenerator<{ event: string; data?: unknown; id?: string }> {
  if (!isValidServerThreadId(threadId)) {
    throw new Error("当前会话 ID 无效（非服务端线程），无法接流");
  }
  const client = createClient();
  options?.onRunCreated?.({ run_id: runId });
  const streamMode: StreamMode[] = (options?.streamMode ?? ['messages', 'custom', 'updates']) as StreamMode[];
  yield* client.runs.joinStream(threadId, runId, {
    signal: options?.signal,
    streamMode,
  });
}

// ============================================================
// 运行历史和状态
// ============================================================

/**
 * 获取线程的运行历史
 */
export async function getRunHistory(threadId: string, limit: number = 10) {
  if (!isValidServerThreadId(threadId)) return [];
  try {
    const client = createClient();
    const runs = await client.runs.list(threadId, { limit });
    return runs;
  } catch (error) {
    console.error('[chatApi] 获取运行历史失败:', error);
    return [];
  }
}

/**
 * 获取特定运行的详细信息
 */
export async function getRunDetails(threadId: string, runId: string) {
  if (!isValidServerThreadId(threadId) || !runId || !isValidRunId(runId)) return null;
  try {
    const client = createClient();
    return await client.runs.get(threadId, runId);
  } catch (error) {
    console.error('[chatApi] 获取运行详情失败:', error);
    return null;
  }
}

// ============================================================
// Store 操作（持久化记忆）
// ============================================================

function djb2Hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * 工作区路径规范化为 scope id，用 djb2 哈希后缀防碰撞。
 */
function normalizeWorkspaceScopeId(workspacePath?: string): string {
  const raw = String(workspacePath || '').trim().toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!raw) return 'default';
  const hash = djb2Hash(raw).toString(16).slice(0, 6);
  const prefix = raw.replace(/[^a-z0-9._-]+/g, '_').replace(/^[_.-]+|[_.-]+$/g, '').slice(0, 24);
  return (prefix || 'ws') + '_' + hash;
}

function resolveWorkspaceScopeId(preferredWorkspacePath?: string): string {
  const explicit = String(preferredWorkspacePath || '').trim();
  if (explicit) return normalizeWorkspaceScopeId(explicit);
  if (typeof window === 'undefined') return 'default';
  return normalizeWorkspaceScopeId(getCurrentWorkspacePathFromStorage() || '');
}

export async function getUserMemories(
  userId: string,
  namespace: string = 'memories',
  workspacePath?: string,
) {
  try {
    const client = createClient();
    const workspaceId = resolveWorkspaceScopeId(workspacePath);
    const [scoped, legacy] = await Promise.all([
      client.store.searchItems([namespace, workspaceId, userId], { limit: 100 }),
      client.store.searchItems([namespace, userId], { limit: 50 }).catch(() => []),
    ]);
    const rows = [...(Array.isArray(scoped) ? scoped : []), ...(Array.isArray(legacy) ? legacy : [])];
    return rows.map((row: any) => {
      const namespaceSegments = Array.isArray(row?.namespace) ? row.namespace : [];
      return {
        ...row,
        namespaceSegments,
        workspace_id: namespaceSegments.length >= 3 ? namespaceSegments[1] : null,
        source_thread_id: row?.value?.source_thread_id || row?.value?.thread_id || null,
        write_reason: row?.value?.write_reason || row?.value?.reason || null,
        confidence: row?.value?.confidence ?? null,
      };
    });
  } catch (error) {
    console.error('[chatApi] 获取记忆失败:', error);
    return [];
  }
}

/**
 * 保存用户记忆
 */
export async function saveUserMemory(
  userId: string,
  key: string,
  value: Record<string, unknown>,
  namespace: string = 'memories',
  workspacePath?: string,
) {
  try {
    const client = createClient();
    const workspaceId = resolveWorkspaceScopeId(workspacePath);
    await client.store.putItem([namespace, workspaceId, userId], key, value);
    if (import.meta.env?.DEV) console.log('[chatApi] ✅ 记忆已保存');
    return true;
  } catch (error) {
    console.error('[chatApi] 保存记忆失败:', error);
    return false;
  }
}

/**
 * 删除用户记忆
 */
export async function deleteUserMemory(
  userId: string,
  key: string,
  namespace: string = 'memories',
  workspacePath?: string,
) {
  try {
    const client = createClient();
    const workspaceId = resolveWorkspaceScopeId(workspacePath);
    try {
      await client.store.deleteItem([namespace, workspaceId, userId], key);
    } catch {
      await client.store.deleteItem([namespace, userId], key);
    }
    if (import.meta.env?.DEV) console.log('[chatApi] ✅ 记忆已删除');
    return true;
  } catch (error) {
    console.error('[chatApi] 删除记忆失败:', error);
    return false;
  }
}

// ============================================================
// 消息反馈和收藏（使用 LangGraph Store 持久化）
// ============================================================

export interface MessageFeedback {
  messageId: string;
  threadId: string;
  type: 'up' | 'down';
  timestamp: string;
  content?: string;  // 可选的反馈内容
}

export interface BookmarkedMessage {
  messageId: string;
  threadId: string;
  content: string;
  timestamp: string;
  tags?: string[];
}

/**
 * 保存消息反馈
 */
export async function saveMessageFeedback(
  userId: string,
  feedback: MessageFeedback
): Promise<boolean> {
  try {
    const client = createClient();
    const key = `feedback_${feedback.threadId}_${feedback.messageId}`;
    await client.store.putItem(['feedback', userId], key, {
      ...feedback,
      savedAt: new Date().toISOString(),
    });
    if (import.meta.env?.DEV) console.log('[chatApi] ✅ 反馈已保存:', feedback.type);
    return true;
  } catch (error) {
    console.error('[chatApi] 保存反馈失败:', error);
    return false;
  }
}

/**
 * 获取消息反馈
 */
export async function getMessageFeedback(
  userId: string,
  threadId: string,
  messageId: string
): Promise<MessageFeedback | null> {
  try {
    const client = createClient();
    const key = `feedback_${threadId}_${messageId}`;
    const item = await client.store.getItem(['feedback', userId], key);
    return item?.value as MessageFeedback | null;
  } catch (error) {
    console.error('[chatApi] 获取反馈失败:', error);
    return null;
  }
}

/**
 * 删除消息反馈
 */
export async function deleteMessageFeedback(
  userId: string,
  threadId: string,
  messageId: string
): Promise<boolean> {
  try {
    const client = createClient();
    const key = `feedback_${threadId}_${messageId}`;
    await client.store.deleteItem(['feedback', userId], key);
    if (import.meta.env?.DEV) console.log('[chatApi] ✅ 反馈已删除');
    return true;
  } catch (error) {
    console.error('[chatApi] 删除反馈失败:', error);
    return false;
  }
}

/**
 * 收藏消息
 */
export async function bookmarkMessage(
  userId: string,
  bookmark: BookmarkedMessage
): Promise<boolean> {
  try {
    const client = createClient();
    const key = `bookmark_${bookmark.threadId}_${bookmark.messageId}`;
    await client.store.putItem(['bookmarks', userId], key, {
      ...bookmark,
      savedAt: new Date().toISOString(),
    });
    if (import.meta.env?.DEV) console.log('[chatApi] ✅ 消息已收藏');
    return true;
  } catch (error) {
    console.error('[chatApi] 收藏失败:', error);
    return false;
  }
}

/**
 * 取消收藏
 */
export async function unbookmarkMessage(
  userId: string,
  threadId: string,
  messageId: string
): Promise<boolean> {
  try {
    const client = createClient();
    const key = `bookmark_${threadId}_${messageId}`;
    await client.store.deleteItem(['bookmarks', userId], key);
    if (import.meta.env?.DEV) console.log('[chatApi] ✅ 已取消收藏');
    return true;
  } catch (error) {
    console.error('[chatApi] 取消收藏失败:', error);
    return false;
  }
}

/**
 * 获取所有收藏
 */
export async function getBookmarks(userId: string): Promise<BookmarkedMessage[]> {
  try {
    const client = createClient();
    const items = await client.store.searchItems(['bookmarks', userId], {
      limit: 100,
    });
    const list = Array.isArray(items) ? items : (items?.items ?? []);
    return list.map((item: { value?: BookmarkedMessage } | BookmarkedMessage) =>
      (item && typeof item === 'object' && 'value' in item && item.value != null ? item.value : item) as BookmarkedMessage
    );
  } catch (error) {
    console.error('[chatApi] 获取收藏失败:', error);
    return [];
  }
}

/**
 * 检查消息是否已收藏
 */
export async function isMessageBookmarked(
  userId: string,
  threadId: string,
  messageId: string
): Promise<boolean> {
  try {
    const client = createClient();
    const key = `bookmark_${threadId}_${messageId}`;
    const item = await client.store.getItem(['bookmarks', userId], key);
    return item != null;
  } catch (error) {
    console.error('[chatApi] 检查收藏状态失败:', error);
    return false;
  }
}

// ============================================================
// 模型管理
// ============================================================

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  is_healthy: boolean;
  context_window: number;
}

const LIST_MODELS_TIMEOUT_MS = 15000;

/**
 * 获取可用模型列表
 * 从 LangGraph Server 的自定义 API 获取
 */
export async function listModels(): Promise<{ ok: boolean; models: ModelInfo[]; default_model?: string; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LIST_MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(`${getApiUrl()}/models/list`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('[chatApi] Failed to list models:', error);
    return { ok: false, models: [], error: String(error) };
  }
}
