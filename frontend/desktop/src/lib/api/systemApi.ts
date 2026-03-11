/**
 * 系统/仪表盘 API - 对接后端孤立端点
 * - /suggestions/work - 工作建议
 * - /projects/active - 活跃项目
 * - /execution-logs - 执行日志（Debug 模式）
 */

import { getApiBase, validServerThreadIdOrUndefined } from './langserveChat';
import { apiClient } from './client';

function base(): string {
  return getApiBase();
}

export interface WorkSuggestion {
  id: string;
  type: string;
  title: string;
  description: string;
  priority: string;
  source: string;
}

export interface ActiveProject {
  id: string;
  title: string;
  status: string;
  lastActivity: string;
  messageCount: number;
  aiSummary?: string;
  workspacePath?: string;
}

export interface ExecutionLogEntry {
  thread_id?: string;
  step?: string;
  status?: string;
  message?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface DailyInsightFile {
  date: string;
  filename: string;
  size: number;
  updated_at: string;
}

export interface InsightsSummary {
  runs: number;
  signals: number;
  roses: number;
  buds: number;
  thorns: number;
}

export interface LangSmithStatus {
  ok: boolean;
  enabled: boolean;
  has_api_key?: boolean;
  tracing_v2?: boolean;
  tracing_source?: string;
  project?: string;
  endpoint?: string;
  message?: string;
  eval_summary?: {
    total?: number;
    feedback_sent?: number;
    feedback_rate?: number;
    failed?: number;
    avg_score?: number;
  };
  error?: string;
}

export interface ExecutionTraceResponse {
  ok: boolean;
  preferred?: 'langsmith' | 'local';
  thread_id?: string;
  langsmith?: LangSmithStatus;
  logs?: ExecutionLogEntry[];
  error?: string;
}

export interface SchedulingSliSummary {
  window_hours: number;
  total_runs: number;
  ttft_p50_ms: number;
  ttft_p95_ms: number;
  queue_wait_p50_ms: number;
  queue_wait_p95_ms: number;
  retry_rate: number;
  fallback_rate: number;
  cost_per_task_usd: number;
}

export interface UiStreamMetricsSample {
  request_id?: string;
  model_id?: string;
  ttft_ms?: number;
  stream_to_first_token_ms?: number;
  lmstudio_gap_overhead_ms?: number;
  max_inter_token_gap_ms?: number;
  message_channel_fallback_count?: number;
  partial_suppressed_count?: number;
  frontend_first_payload_ms?: number;
  frontend_first_ui_yield_ms?: number;
  frontend_max_inter_payload_gap_ms?: number;
  total_ms?: number;
  ts?: number;
}

export interface SkillFeedbackItem {
  skill_name: string;
  positive: number;
  negative: number;
  total: number;
  score_sum: number;
  positive_rate?: number;
  avg_score?: number;
  last_note?: string;
  updated_at?: string;
}

export interface UpgradeRunLog {
  ts?: string;
  action?: string;
  exit_code?: number;
  stdout_tail?: string;
  stderr_tail?: string;
}

export interface UpgradeStatusResponse {
  ok: boolean;
  section?: string;
  refresh?: boolean;
  status?: Record<string, unknown>;
  stdout_tail?: string;
  stderr_tail?: string;
  error?: string;
}

export interface LangSmithEvalRow {
  ts?: string;
  thread_id?: string;
  run_id?: string;
  mode?: string;
  task_status?: string;
  score?: number;
  langsmith_enabled?: boolean;
  feedback_sent?: boolean;
  feedback_error?: string;
  summary_preview?: string;
  error_preview?: string;
}

export interface SensitiveFileCandidate {
  path: string;
  risk_level?: 'high' | 'medium' | 'low' | string;
  reasons?: string[];
}

export interface VisionAnalyzeResult {
  ok: boolean;
  source?: string;
  summary?: string;
  analysis?: Record<string, unknown>;
  error?: string;
}

export interface BriefingSummaryCard {
  type: string;
  title: string;
  summary?: string;
  data?: Record<string, unknown>;
}

export interface BriefingPayload {
  greeting: string;
  summary_cards: BriefingSummaryCard[];
  suggestions: Array<Record<string, unknown> | string>;
  markdown_report?: string;
}

export interface BriefingResponse {
  ok: boolean;
  briefing?: BriefingPayload | null;
  meta?: Record<string, unknown>;
  error?: string;
}

export interface PluginListItem {
  name: string;
  version: string;
  display_name?: string;
  description?: string;
  requires_tier?: string;
  license?: string;
  components?: Record<string, unknown>;
  loaded?: boolean;
  eligible?: boolean;
  discovered_only?: boolean;
  category?: string;
  icon?: string;
  changelog?: string;
  compatibility?: { min_version?: string };
  source_label?: string;
  remote_version?: string | null;
  update_available?: boolean;
}

export interface PluginListResponse {
  ok: boolean;
  tier?: string;
  limits?: {
    max_plugins?: number;
  };
  usage?: {
    installed_plugins?: number;
  };
  plugins: PluginListItem[];
  error?: string;
}

export interface PluginCommandItem {
  command: string;
  command_key?: string;
  plugin?: string;
  description?: string;
  path?: string;
}

export interface PluginCommandsResponse {
  ok: boolean;
  commands: PluginCommandItem[];
  error?: string;
}

export interface SlashExecuteResponse {
  ok: boolean;
  type?: string;
  mode?: string;
  prompt?: string;
  thread_id?: string;
  command?: string;
  plugin?: string;
  plugins?: PluginListItem[];
  tier?: string;
  installed?: string[];
  error?: string;
}

export interface LicenseStatusResponse {
  ok: boolean;
  tier?: string;
  limits?: {
    max_custom_skills?: number;
    max_mcp_connections?: number;
    max_daily_autonomous_tasks?: number;
    max_plugins?: number;
    cloud_model_requests_daily?: number;
    evolution_enabled?: boolean;
  };
  usage?: {
    custom_skills?: number;
    cloud_model_requests_today?: number;
    autonomous_tasks_today?: number;
  };
  profile?: Record<string, unknown>;
  error?: string;
}

export interface AutonomousWatcherRuntime {
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

export interface AutonomousWatcherConfigResponse {
  ok: boolean;
  config?: { enabled: boolean; role_id?: string };
  runtime?: AutonomousWatcherRuntime;
  available_roles?: Array<{ id: string; label?: string; skill_profile?: string }>;
  error?: string;
}

export interface AutonomousWatcherObservabilityResetResponse {
  ok: boolean;
  invites_observability?: AutonomousWatcherRuntime['invites_observability'];
  runtime?: AutonomousWatcherRuntime;
  error?: string;
}

export interface AutonomyLevelConfig {
  level: 'L0' | 'L1' | 'L2' | 'L3';
  require_tool_approval?: boolean;
  allow_idle_loop?: boolean;
  allow_gated_code_changes?: boolean;
  auto_accept_tools?: string[];
}

/** 可配置为「默认接受」的工具（勾选后该工具不再弹出 diff/确认） */
export const AUTO_ACCEPT_TOOL_OPTIONS: { id: string; label: string }[] = [
  { id: 'write_file', label: '写入文件' },
  { id: 'edit_file', label: '编辑文件' },
  { id: 'delete_file', label: '删除文件' },
  { id: 'shell_run', label: 'Shell 命令' },
  { id: 'python_run', label: 'Python 执行' },
];

export interface AutonomyLevelConfigResponse {
  ok: boolean;
  config?: AutonomyLevelConfig;
  error?: string;
}

/** 获取工作建议（基于 Skills、工作区与可选会话）；refresh 为 true 时后端跳过缓存；threadId 供后端按会话目标动态排序/过滤 */
export async function getWorkSuggestions(
  workspacePath?: string,
  options?: { refresh?: boolean; threadId?: string; mode?: string }
): Promise<{
  success: boolean;
  suggestions: WorkSuggestion[];
  error?: string;
}> {
  try {
    const params: Record<string, string | boolean> = workspacePath
      ? { path: workspacePath, workspace_id: workspacePath }
      : {};
    if (options?.refresh) params.refresh = true;
    const optTid = validServerThreadIdOrUndefined(options?.threadId);
    if (optTid) params.thread_id = optTid;
    if (options?.mode) params.mode = options.mode;
    const data = await apiClient.get<any>('suggestions/work', Object.keys(params).length ? params : undefined);
    const raw = data?.suggestions;
    const suggestions = Array.isArray(raw) ? raw : [];
    return {
      success: data?.success ?? false,
      suggestions,
      error: data?.error,
    };
  } catch (e) {
    return { success: false, suggestions: [], error: String(e) };
  }
}

/** 获取活跃项目列表（后端从 LangGraph 线程汇总） */
export async function getActiveProjects(): Promise<{
  success: boolean;
  projects: ActiveProject[];
  error?: string;
}> {
  try {
    const data = await apiClient.get<any>('projects/active');
    return {
      success: data.success ?? false,
      projects: data.projects ?? [],
      error: data.error,
    };
  } catch (e) {
    return { success: false, projects: [], error: String(e) };
  }
}

/** 获取执行日志（Debug 模式）。非服务端 threadId 时直接返回空，避免无效请求。 */
export async function getExecutionLogs(
  threadId: string,
  options?: { limit?: number; status?: string }
): Promise<{ success: boolean; logs?: ExecutionLogEntry[]; error?: string }> {
  const tid = validServerThreadIdOrUndefined(threadId);
  if (!tid) {
    return { success: true, logs: [] };
  }
  try {
    const data = await apiClient.get<any>('execution-logs', {
      thread_id: tid,
      ...(options?.limit != null ? { limit: String(options.limit) } : {}),
      ...(options?.status ? { status: options.status } : {}),
    });
    const success = data.ok ?? data.success ?? false;
    return {
      success,
      logs: data.logs ?? data.entries ?? [],
      error: data.error,
    };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/** 统一执行追踪（LangSmith 优先，失败时本地回退）。非服务端 threadId 时直接返回空。 */
export async function getExecutionTrace(
  threadId: string,
  options?: { limit?: number; status?: string }
): Promise<ExecutionTraceResponse> {
  const tid = validServerThreadIdOrUndefined(threadId);
  if (!tid) {
    return { ok: true, logs: [], preferred: 'local' };
  }
  try {
    const data = await apiClient.get<any>('execution-trace', {
      thread_id: tid,
      ...(options?.limit != null ? { limit: String(options.limit) } : {}),
      ...(options?.status ? { status: options.status } : {}),
    });
    return {
      ok: data.ok ?? false,
      preferred: data.preferred,
      thread_id: data.thread_id,
      langsmith: data.langsmith,
      logs: data.logs ?? [],
      error: data.error,
    };
  } catch (e) {
    return { ok: false, error: String(e), logs: [] };
  }
}

/** 获取调度核心 SLI（队列等待/TTFT/重试/回退/成本） */
export async function getSchedulingSli(windowHours: number = 24): Promise<{
  ok: boolean;
  summary?: SchedulingSliSummary;
  error?: string;
}> {
  try {
    const params = new URLSearchParams({ window_hours: String(windowHours) });
    const res = await fetch(`${base()}/observability/sli?${params}`);
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) {
      return { ok: false, error: "响应解析失败" };
    }
    return {
      ok: data.ok ?? false,
      summary: data.summary,
      error: data.error,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function postUiStreamMetricsSample(sample: UiStreamMetricsSample): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${base()}/observability/ui-stream-metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sample || {}),
    });
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) {
      return { ok: false, error: "响应解析失败" };
    }
    return { ok: data.ok ?? res.ok ?? false, error: data.error ?? data.detail };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** 获取 LangSmith 可观测性状态 */
export async function getLangSmithStatus(): Promise<LangSmithStatus> {
  try {
    const data = await apiClient.get<any>('observability/langsmith/status');
    return {
      ok: data.ok ?? false,
      enabled: data.enabled ?? false,
      has_api_key: data.has_api_key,
      tracing_v2: data.tracing_v2,
      tracing_source: data.tracing_source,
      project: data.project,
      endpoint: data.endpoint,
      message: data.message,
      eval_summary: data.eval_summary,
      error: data.error,
    };
  } catch (e) {
    return { ok: false, enabled: false, error: String(e) };
  }
}

/** 读取最近 LangSmith 自动评估记录（本地落盘日志） */
export async function getLangSmithEvals(limit: number = 30): Promise<{
  ok: boolean;
  rows: LangSmithEvalRow[];
  total?: number;
  error?: string;
}> {
  try {
    const data = await apiClient.get<any>('observability/langsmith/evals', { limit: String(limit) });
    return {
      ok: data.ok ?? false,
      rows: Array.isArray(data.rows) ? data.rows : [],
      total: data.total,
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, rows: [], error: String(e) };
  }
}

/** 扫描工作区潜在敏感文件（用于云端发送前审查） */
export async function getSensitiveFiles(
  limit: number = 200,
  signal?: AbortSignal
): Promise<{
  ok: boolean;
  items: SensitiveFileCandidate[];
  total: number;
  truncated?: boolean;
  error?: string;
}> {
  try {
    const params = new URLSearchParams({ limit: String(limit) });
    const res = await fetch(`${base()}/privacy/sensitive-files?${params}`, { signal });
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) {
      return { ok: false, items: [], total: 0, error: "响应解析失败" };
    }
    return {
      ok: data.ok ?? false,
      items: Array.isArray(data.items) ? data.items : [],
      total: typeof data.total === 'number' ? data.total : 0,
      truncated: data.truncated,
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, items: [], total: 0, error: String(e) };
  }
}

/** 多模态：轻量图片分析（路径/URL） */
export async function analyzeVisionImage(body: {
  path?: string;
  url?: string;
  max_bytes?: number;
}): Promise<VisionAnalyzeResult> {
  try {
    const res = await fetch(`${base()}/multimodal/vision/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, error: '响应解析失败' };
    return {
      ok: data.ok ?? res.ok ?? false,
      source: data.source,
      summary: data.summary,
      analysis: data.analysis,
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** 读取自治巡检 watcher 配置与运行状态 */
export async function getAutonomousWatcherConfig(): Promise<AutonomousWatcherConfigResponse> {
  try {
    const res = await fetch(`${base()}/autonomous/watcher/config`);
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, error: '响应解析失败' };
    return {
      ok: data.ok ?? res.ok ?? false,
      config: data.config,
      runtime: data.runtime,
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** 更新自治巡检 watcher 配置（并立即应用） */
export async function updateAutonomousWatcherConfig(body: {
  enabled: boolean;
  role_id?: string;
}): Promise<AutonomousWatcherConfigResponse> {
  try {
    const res = await fetch(`${base()}/autonomous/watcher/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, error: '响应解析失败' };
    return {
      ok: data.ok ?? res.ok ?? false,
      config: data.config,
      runtime: data.runtime,
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** 重置自治巡检 invites 观测计数 */
export async function resetAutonomousWatcherObservability(): Promise<AutonomousWatcherObservabilityResetResponse> {
  try {
    const res = await fetch(`${base()}/autonomous/watcher/observability/reset`, {
      method: 'POST',
    });
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, error: '响应解析失败' };
    return {
      ok: data.ok ?? res.ok ?? false,
      invites_observability: data.invites_observability,
      runtime: data.runtime,
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** 读取自主级别配置（L0-L3） */
export async function getAutonomyLevelConfig(): Promise<AutonomyLevelConfigResponse> {
  try {
    const res = await fetch(`${base()}/autonomous/level/config`);
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, error: '响应解析失败' };
    return {
      ok: data.ok ?? res.ok ?? false,
      config: data.config,
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** 更新自主级别配置（L0-L3） */
export async function updateAutonomyLevelConfig(
  body: Partial<AutonomyLevelConfig> & { level: 'L0' | 'L1' | 'L2' | 'L3' }
): Promise<AutonomyLevelConfigResponse> {
  try {
    const res = await fetch(`${base()}/autonomous/level/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, error: '响应解析失败' };
    return {
      ok: data.ok ?? res.ok ?? false,
      config: data.config,
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** 读取升级状态（可选 refresh 先触发编排） */
export async function getUpgradeStatus(
  section: 'all' | 'health' | 'rollout' | 'gate' | 'prompt_modules' | 'status_commands' = 'rollout',
  refresh: boolean = false
): Promise<UpgradeStatusResponse> {
  try {
    const params = new URLSearchParams({ section, refresh: String(refresh) });
    const res = await fetch(`${base()}/upgrade/status?${params}`);
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, error: '响应解析失败' };
    return {
      ok: data.ok ?? false,
      section: data.section,
      refresh: data.refresh,
      status: data.status,
      stdout_tail: data.stdout_tail,
      stderr_tail: data.stderr_tail,
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** 检查远程升级清单 */
export async function checkUpgrade(
  manifestUrl?: string
): Promise<{
  ok: boolean;
  message?: string;
  manifest_url?: string;
  current_version?: string;
  remote_version?: string;
  update_available?: boolean;
  manifest?: Record<string, unknown>;
  error?: string;
}> {
  try {
    const res = await fetch(`${base()}/upgrade/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest_url: manifestUrl || '' }),
    });
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, error: '响应解析失败' };
    return {
      ok: data.ok ?? false,
      message: data.message,
      manifest_url: data.manifest_url,
      current_version: data.current_version,
      remote_version: data.remote_version,
      update_available: data.update_available,
      manifest: data.manifest,
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** 触发升级编排（auto_rollout_upgrade） */
export async function triggerUpgrade(
  refreshStatus: boolean = true
): Promise<{
  ok: boolean;
  run?: UpgradeRunLog;
  status?: Record<string, unknown>;
  error?: string;
}> {
  try {
    const res = await fetch(`${base()}/upgrade/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_status: refreshStatus }),
    });
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, error: '响应解析失败' };
    return {
      ok: data.ok ?? false,
      run: data.run,
      status: data.status,
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** 读取最近升级运行日志 */
export async function getUpgradeRuns(limit: number = 20): Promise<{
  ok: boolean;
  rows: UpgradeRunLog[];
  total?: number;
  error?: string;
}> {
  try {
    const params = new URLSearchParams({ limit: String(limit) });
    const res = await fetch(`${base()}/upgrade/runs?${params}`);
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, rows: [], error: '响应解析失败' };
    return {
      ok: data.ok ?? false,
      rows: Array.isArray(data.rows) ? data.rows : [],
      total: data.total,
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, rows: [], error: String(e) };
  }
}

/** 获取 Skill 反馈统计 */
export async function getSkillFeedbackStats(limit: number = 20): Promise<{
  ok: boolean;
  count?: number;
  items: SkillFeedbackItem[];
  error?: string;
}> {
  try {
    const params = new URLSearchParams({ limit: String(limit) });
    const res = await fetch(`${base()}/learning/skill-feedback/stats?${params}`);
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, items: [], error: '响应解析失败' };
    return {
      ok: data.ok ?? false,
      count: data.count ?? 0,
      items: data.items ?? [],
      error: data.error,
    };
  } catch (e) {
    return { ok: false, items: [], error: String(e) };
  }
}

/** 获取每日洞察文件列表 */
export async function getDailyInsights(limit: number = 30): Promise<{
  success: boolean;
  files: DailyInsightFile[];
  error?: string;
}> {
  try {
    const params = new URLSearchParams({ limit: String(limit) });
    const res = await fetch(`${base()}/insights/daily?${params}`);
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) return { success: false, files: [], error: '响应解析失败' };
    return {
      success: data.success ?? false,
      files: data.files ?? [],
      error: data.error,
    };
  } catch (e) {
    return { success: false, files: [], error: String(e) };
  }
}

/** 获取某日洞察 Markdown 内容 */
export async function getDailyInsightContent(date: string): Promise<{
  success: boolean;
  date?: string;
  content?: string;
  error?: string;
}> {
  try {
    const params = new URLSearchParams({ date });
    const res = await fetch(`${base()}/insights/daily/content?${params}`);
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) return { success: false, error: '响应解析失败' };
    return {
      success: data.success ?? false,
      date: data.date,
      content: data.content,
      error: data.error,
    };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/** 按文件名获取洞察 Markdown 内容（兼容 growth_radar_*.md） */
export async function getInsightContentByFilename(filename: string): Promise<{
  success: boolean;
  filename?: string;
  content?: string;
  error?: string;
}> {
  try {
    const params = new URLSearchParams({ filename });
    const res = await fetch(`${base()}/insights/content?${params}`);
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) return { success: false, error: '响应解析失败' };
    return {
      success: data.success ?? false,
      filename: data.filename,
      content: data.content,
      error: data.error,
    };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/** 获取最近 N 天洞察摘要 */
export async function getInsightsSummary(days: number = 7): Promise<{
  success: boolean;
  days?: number;
  summary?: InsightsSummary;
  error?: string;
}> {
  try {
    const params = new URLSearchParams({ days: String(days) });
    const res = await fetch(`${base()}/insights/summary?${params}`);
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) return { success: false, error: '响应解析失败' };
    return {
      success: data.success ?? false,
      days: data.days,
      summary: data.summary,
      error: data.error,
    };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/** 生成启动简报（秘书式主动汇报） */
export async function generateBriefing(body?: {
  workspace_path?: string;
  days?: number;
  scope?: string;
  include_llm?: boolean;
}): Promise<BriefingResponse> {
  try {
    const res = await fetch(`${base()}/briefing/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, briefing: null, error: '响应解析失败' };
    return {
      ok: data.ok ?? res.ok ?? false,
      briefing: data.briefing,
      meta: data.meta,
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, briefing: null, error: String(e) };
  }
}

export async function listPlugins(): Promise<PluginListResponse> {
  try {
    const data = await apiClient.get<any>('plugins/list');
    return {
      ok: data.ok ?? false,
      tier: data.tier,
      limits: data.limits,
      usage: data.usage,
      plugins: Array.isArray(data.plugins) ? data.plugins : [],
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, plugins: [], error: String(e) };
  }
}

export async function installPlugin(name: string): Promise<{ ok: boolean; installed: string[]; error?: string }> {
  try {
    const data = await apiClient.post<any>('plugins/install', { name });
    return {
      ok: data.ok ?? false,
      installed: Array.isArray(data.installed) ? data.installed : [],
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, installed: [], error: String(e) };
  }
}

export async function uninstallPlugin(name: string): Promise<{ ok: boolean; installed: string[]; error?: string }> {
  try {
    const data = await apiClient.post<any>('plugins/uninstall', { name });
    return {
      ok: data.ok ?? false,
      installed: Array.isArray(data.installed) ? data.installed : [],
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, installed: [], error: String(e) };
  }
}

export async function listPluginCommands(): Promise<PluginCommandsResponse> {
  try {
    const data = await apiClient.get<any>('plugins/commands');
    return {
      ok: data.ok ?? false,
      commands: Array.isArray(data.commands) ? data.commands : [],
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, commands: [], error: String(e) };
  }
}

export async function executeSlashCommand(command: string, threadId?: string): Promise<SlashExecuteResponse> {
  try {
    const data = await apiClient.post<any>('slash/execute', {
      command,
      thread_id: validServerThreadIdOrUndefined(threadId),
    });
    return {
      ok: data.ok ?? false,
      type: data.type,
      mode: data.mode,
      prompt: data.prompt,
      thread_id: data.thread_id,
      command: data.command,
      plugin: data.plugin,
      plugins: Array.isArray(data.plugins) ? data.plugins : undefined,
      tier: data.tier,
      installed: Array.isArray(data.installed) ? data.installed : undefined,
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getLicenseStatus(): Promise<LicenseStatusResponse> {
  try {
    const data = await apiClient.get<any>('license/status');
    return {
      ok: data.ok ?? false,
      tier: data.tier,
      limits: data.limits,
      usage: data.usage,
      profile: data.profile,
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export interface LicenseActivateResponse {
  ok: boolean;
  tier?: string;
  error?: string;
}

export async function activateLicense(tier: string, token?: string): Promise<LicenseActivateResponse> {
  try {
    const data = await apiClient.post<any>('license/activate', { tier: tier.trim().toLowerCase(), token: token?.trim() || undefined });
    return {
      ok: data.ok ?? false,
      tier: data.tier,
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export interface EvolutionStatusResponse {
  ok: boolean;
  status?: {
    allow_gated_code_changes?: boolean;
    allow_idle_loop?: boolean;
  };
  engine_kind?: string;
  error?: string;
}

export interface EvolutionProposalRequest {
  title: string;
  motivation: string;
  plan: string;
  target?: string;
}

export interface EvolutionRunResponse {
  ok: boolean;
  result?: {
    ok?: boolean;
    proposal_path?: string;
    stages?: Array<{
      ok: boolean;
      stage: string;
      message?: string;
      data?: Record<string, unknown>;
      created_at?: string;
    }>;
  };
  proposal_path?: string;
  error?: string;
}

export async function getEvolutionStatus(): Promise<EvolutionStatusResponse> {
  try {
    const res = await fetch(`${base()}/evolution/status`);
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, error: '响应解析失败' };
    return {
      ok: data.ok ?? res.ok ?? false,
      status: data.status,
      engine_kind: data.engine_kind,
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function createEvolutionProposal(body: EvolutionProposalRequest): Promise<EvolutionRunResponse> {
  try {
    const res = await fetch(`${base()}/evolution/propose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, error: '响应解析失败' };
    return {
      ok: data.ok ?? res.ok ?? false,
      proposal_path: data.proposal_path,
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function runEvolutionPipeline(body: EvolutionProposalRequest): Promise<EvolutionRunResponse> {
  try {
    const res = await fetch(`${base()}/evolution/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) return { ok: false, error: '响应解析失败' };
    return {
      ok: data.ok ?? res.ok ?? false,
      result: data.result,
      error: data.error ?? data.detail,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
