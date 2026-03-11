import { EVENTS } from "../constants";

/**
 * 工具流式输出事件总线
 * 
 * 处理来自后端工具（如 python_run, shell_run, grep_search）的实时流式输出
 * 使用 LangGraph 的 custom stream mode
 */

const MAX_OUTPUT_LINES = 500;

export type ToolStreamEventType = 
  // ============================================================
  // 执行状态（用于运行状态栏）
  // ============================================================
  | 'stream_start'      // 流开始
  | 'stream_end'        // 流结束
  | 'stream_error'      // 流错误
  | 'thinking'          // 思考中
  | 'generating'        // 生成中
  // 通用工具事件
  | 'tool_start'        // 工具开始
  | 'tool_end'          // 工具结束
  | 'tool_error'        // 工具错误
  // ============================================================
  // Python 执行
  // ============================================================
  | 'python_start'      // Python 执行开始
  | 'python_libs_loaded' // 库加载完成
  | 'python_output'     // Python 输出（实时）
  | 'python_complete'   // Python 执行完成
  // ============================================================
  // Shell 执行
  // ============================================================
  | 'shell_start'       // Shell 执行开始
  | 'shell_output'      // Shell 输出
  | 'shell_complete'    // Shell 执行完成
  // ============================================================
  // 搜索工具
  // ============================================================
  | 'search_start'      // 搜索开始
  | 'search_files_found' // 找到文件数量
  | 'search_progress'   // 搜索进度
  | 'search_match'      // 找到匹配
  | 'search_complete'   // 搜索完成
  // ============================================================
  // 定义查找
  // ============================================================
  | 'find_definition_start'
  | 'find_definition_progress'
  | 'find_definition_complete'
  // ============================================================
  // 引用查找
  // ============================================================
  | 'find_references_start'
  | 'find_references_complete'
  // ============================================================
  // 文件读取
  // ============================================================
  | 'file_read_start'
  | 'file_read_progress'
  | 'file_read_complete'
  | 'file_read_error'
  // ============================================================
  // 文件写入
  // ============================================================
  | 'file_write_start'
  | 'file_write_progress'
  | 'file_write_complete'
  // ============================================================
  // 思考/规划
  // ============================================================
  | 'think_start'
  | 'think_complete'
  | 'plan_start'
  | 'plan_complete'
  | 'ask_user_start'
  | 'ask_user_complete'
  | 'record_result_start'
  | 'record_result_complete'
  // ============================================================
  // Agent 进度与 SubAgent（后端 custom 事件）
  // ============================================================
  | 'reasoning'         // 统一思考协议（start/end/content）
  | 'subagent_start'    // SubAgent 开始执行
  | 'subagent_end'     // SubAgent 执行结束
  | 'task_progress'    // 任务进度更新
  | 'tool_result'      // 通用工具执行完成（Cursor 式：执行了什么、结果摘要）
  | 'artifact'        // Artifact 输出
  | 'crystallization_suggestion' // 蒸馏质量门通过，建议保存为 Skill
  | 'steps_updated';  // Cursor 式步骤时间线：当前 run 的步骤列表更新

/** 单步状态（步骤时间线） */
export type ExecutionStepStatus = 'pending' | 'running' | 'done';

/** 步骤时间线中的一步 */
export interface ExecutionStep {
  id: string;
  label: string;
  status: ExecutionStepStatus;
  tool?: string;
  tool_call_id?: string;
  result_preview?: string;
}

/** stream_end 时可选：complete=正常结束，abort=用户取消，error=异常 */
export type StreamEndReason = 'complete' | 'abort' | 'error';

export interface ToolStreamEvent {
  type: ToolStreamEventType;
  data?: string;
  timestamp?: number;
  /** 仅 type===stream_end 时有效，用于本轮完成提示 */
  reason?: StreamEndReason;
  // ============================================================
  // 通用工具属性
  // ============================================================
  toolName?: string;        // 工具名称
  toolCallId?: string;      // 工具调用 ID
  args?: Record<string, unknown>;  // 工具参数
  result?: unknown;         // 工具结果
  result_preview?: string;  // 工具结果摘要（后端 tool_result 事件，用于 Cursor 式展示）
  content?: string;         // 内容（思考、生成等）
  // ============================================================
  // Python 特有
  // ============================================================
  code_lines?: number;
  count?: number;
  status?: string;
  phase?: string;
  duration?: number;
  output_lines?: number;
  error?: string;
  // ============================================================
  // Shell 特有
  // ============================================================
  command?: string;
  // ============================================================
  // 搜索特有
  // ============================================================
  pattern?: string;
  path?: string;
  files_searched?: number;
  total_files?: number;
  matches_found?: number;
  matches?: number;
  file?: string;
  line?: number;
  total_matches?: number;
  // ============================================================
  // 文件读取特有
  // ============================================================
  file_path?: string;
  file_size?: number;
  file_type?: string;
  chars_read?: number;
  lines_read?: number;
  // ============================================================
  // 定义查找特有
  // ============================================================
  symbol?: string;
  language?: string;
  pattern_index?: number;
  total_patterns?: number;
  found?: boolean;
  results_count?: number;
  // ============================================================
  // 思考/规划特有
  // ============================================================
  content_length?: number;
  has_completed?: boolean;
  has_next?: boolean;
  has_context?: boolean;
  has_options?: boolean;
  step_name?: string;
  // ============================================================
  // Agent/SubAgent 进度
  // ============================================================
  progress_status?: 'start' | 'end';
  subagent_type?: string;  // explore-agent | general-purpose
  current_step?: number;
  total_steps?: number;
  msg_id?: string;
  artifact_type?: 'document' | 'code' | 'chart' | 'table' | 'markdown' | string;
  title?: string;
  // steps_updated 专用（当前 run 的步骤列表，按 thread 作用域）
  steps?: ExecutionStep[];
  runId?: string;
  threadId?: string | null;
}

/** 流事件最小契约：run_error 后端必填 error_code、message */
export interface RunErrorPayload {
  error_code?: string;
  message?: string;
}

/** 流事件最小契约：session_context 后端必填 threadId */
export interface SessionContextPayload {
  threadId?: string | null;
  mode?: string;
  roleId?: string | null;
  /** 本 run 实际使用的模型 id（如 cloud/qwen3.5-35b-a3b），便于展示「当前由哪台模型在服务」 */
  modelId?: string | null;
}

/** 防御性解析 run_error payload，畸形时返回 null 便于排查；error_code/message 兼容后端传字符串或数字 */
export function parseRunErrorPayload(d: unknown): RunErrorPayload | null {
  if (d == null || typeof d !== "object") return null;
  const data = (d as { data?: unknown }).data;
  if (data == null || typeof data !== "object") return null;
  const p = data as Record<string, unknown>;
  const rawCode = p.error_code;
  const rawMsg = p.message;
  return {
    error_code: rawCode != null ? String(rawCode) : undefined,
    message: rawMsg != null ? String(rawMsg) : undefined,
  };
}

/** 防御性解析 session_context payload，无 threadId 时返回 null */
export function parseSessionContextPayload(d: unknown): SessionContextPayload | null {
  if (d == null || typeof d !== "object") return null;
  const data = (d as { data?: unknown }).data;
  if (data == null || typeof data !== "object") return null;
  const p = data as Record<string, unknown>;
  const threadId = p.threadId;
  if (threadId == null || (typeof threadId !== "string" && typeof threadId !== "number")) return null;
  const tid = String(threadId).trim();
  if (!tid) return null;
  return {
    threadId: tid,
    mode: typeof p.mode === "string" ? p.mode : undefined,
    roleId: p.roleId != null ? String(p.roleId) : null,
    modelId: p.modelId != null ? String(p.modelId) : null,
  };
}

type ToolStreamListener = (event: ToolStreamEvent) => void;

class ToolStreamEventBus {
  private listeners: Map<string, Set<ToolStreamListener>> = new Map();
  private globalListeners: Set<ToolStreamListener> = new Set();
  
  // 当前工具执行状态（用于 UI 显示）
  private currentExecution: {
    toolName?: string;
    startTime?: number;
    output: string[];
    status: 'idle' | 'running' | 'complete' | 'error';
  } = {
    output: [],
    status: 'idle'
  };
  
  /**
   * 订阅特定类型的事件
   */
  on(eventType: ToolStreamEventType, listener: ToolStreamListener): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(listener);
    
    return () => {
      this.listeners.get(eventType)?.delete(listener);
    };
  }
  
  /**
   * 取消订阅特定类型的事件
   */
  off(eventType: ToolStreamEventType, listener: ToolStreamListener): void {
    this.listeners.get(eventType)?.delete(listener);
  }
  
  /**
   * 订阅所有事件
   */
  onAll(listener: ToolStreamListener): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }
  
  /**
   * 取消订阅所有事件
   */
  offAll(listener: ToolStreamListener): void {
    this.globalListeners.delete(listener);
  }
  
  /**
   * 发送事件
   */
  emit(event: ToolStreamEvent): void {
    // 更新当前执行状态
    this.updateExecutionState(event);
    
    // 通知特定类型的监听器
    const typeListeners = this.listeners.get(event.type);
    if (typeListeners) {
      typeListeners.forEach(listener => {
        try {
          listener(event);
        } catch (e) {
          console.error('[ToolStreamEventBus] Listener error:', e);
        }
      });
    }
    
    // 通知全局监听器
    this.globalListeners.forEach(listener => {
      try {
        listener(event);
      } catch (e) {
        console.error('[ToolStreamEventBus] Global listener error:', e);
      }
    });
  }
  
  /**
   * 处理来自 LangGraph 流的自定义事件
   */
  handleStreamEvent(event: unknown): void {
    // 检查是否是工具流式事件
    if (typeof event !== 'object' || event === null) return;
    
    const data = event as Record<string, unknown>;
    const eventType = data.type as string;
    
    // 只处理工具相关的事件（检查所有已知的事件前缀）或 Agent 进度事件
    const toolEventPrefixes = [
      'python_', 'shell_', 'search_', 'file_read_', 'file_write_',
      'find_definition_', 'find_references_', 'think_', 'plan_',
      'ask_user_', 'record_result_'
    ];
    const agentProgressTypes = ['reasoning', 'subagent_start', 'subagent_end', EVENTS.TASK_PROGRESS, 'tool_result', 'artifact', 'context_stats', 'execution_metrics'];
    const directToolEvents = ['stream_start', 'stream_end', 'stream_error', 'thinking', 'generating', 'tool_start', 'tool_end', 'tool_error', 'crystallization_suggestion', 'run_id'];
    const isToolEvent = eventType && toolEventPrefixes.some(prefix => eventType.startsWith(prefix));
    const isAgentProgress = eventType && agentProgressTypes.includes(eventType);
    const isDirectToolEvent = eventType && directToolEvents.includes(eventType);
    if (isToolEvent || isAgentProgress || isDirectToolEvent) {
      this.emit({ type: eventType, ...data, timestamp: data.timestamp ?? Date.now() } as unknown as ToolStreamEvent);
    }
  }
  
  /**
   * 更新当前执行状态
   */
  private updateExecutionState(event: ToolStreamEvent): void {
    switch (event.type) {
      // Python 执行
      case 'python_start':
        this.currentExecution = {
          toolName: 'python_run',
          startTime: event.timestamp || Date.now(),
          output: [],
          status: 'running'
        };
        break;
        
      case 'python_output':
        if (event.data) {
          this.currentExecution.output.push(event.data);
          if (this.currentExecution.output.length > MAX_OUTPUT_LINES) {
            this.currentExecution.output = this.currentExecution.output.slice(-MAX_OUTPUT_LINES);
          }
        }
        break;
        
      case 'python_complete':
        this.currentExecution.status = event.status === 'success' ? 'complete' : 'error';
        break;
      
      // Shell 执行
      case 'shell_start':
        this.currentExecution = {
          toolName: 'shell_run',
          startTime: event.timestamp || Date.now(),
          output: [],
          status: 'running'
        };
        break;
        
      case 'shell_output':
        if (event.data) {
          this.currentExecution.output.push(event.data);
          if (this.currentExecution.output.length > MAX_OUTPUT_LINES) {
            this.currentExecution.output = this.currentExecution.output.slice(-MAX_OUTPUT_LINES);
          }
        }
        break;
        
      case 'shell_complete':
        this.currentExecution.status = event.status === 'success' ? 'complete' : 'error';
        break;
      
      // 搜索工具
      case 'search_start':
        this.currentExecution = {
          toolName: 'grep_search',
          startTime: event.timestamp || Date.now(),
          output: [],
          status: 'running'
        };
        break;
        
      case 'search_progress':
        if (event.files_searched && event.total_files) {
          this.currentExecution.output.push(
            `搜索进度: ${event.files_searched}/${event.total_files} 文件, ${event.matches_found || 0} 匹配\n`
          );
          if (this.currentExecution.output.length > MAX_OUTPUT_LINES) {
            this.currentExecution.output = this.currentExecution.output.slice(-MAX_OUTPUT_LINES);
          }
        }
        break;
        
      case 'search_match':
        if (event.file && event.line) {
          this.currentExecution.output.push(`✓ ${event.file}:${event.line}\n`);
          if (this.currentExecution.output.length > MAX_OUTPUT_LINES) {
            this.currentExecution.output = this.currentExecution.output.slice(-MAX_OUTPUT_LINES);
          }
        }
        break;
        
      case 'search_complete':
        this.currentExecution.status = 'complete';
        break;

      // 通用工具状态（兼容后端仅发送通用事件）
      case 'tool_start':
        this.currentExecution = {
          toolName: event.toolName,
          startTime: event.timestamp || Date.now(),
          output: [],
          status: 'running'
        };
        break;

      case 'tool_end':
      case 'stream_end':
        this.currentExecution.status = 'complete';
        break;

      case 'tool_error':
      case 'stream_error':
        this.currentExecution.status = 'error';
        break;
    }
  }
  
  /**
   * 获取当前执行状态
   */
  getCurrentExecution() {
    return { ...this.currentExecution };
  }
  
  /**
   * 获取当前输出
   */
  getCurrentOutput(): string {
    return this.currentExecution.output.join('');
  }
  
  /**
   * 重置状态
   */
  reset(): void {
    this.currentExecution = {
      output: [],
      status: 'idle'
    };
  }
}

// 单例导出
export const toolStreamEventBus = new ToolStreamEventBus();

/** Cursor 式步骤时间线：按 thread 作用域累积（module 级），由 MyRuntimeProvider 写入、thread/RunTracker 读取 */
const stepsByThreadId = new Map<string, ExecutionStep[]>();

export function getStepsForThread(threadId: string | null): ExecutionStep[] {
  if (!threadId) return [];
  if (!stepsByThreadId.has(threadId)) stepsByThreadId.set(threadId, []);
  return stepsByThreadId.get(threadId)!;
}

export function setStepsForThread(threadId: string | null, steps: ExecutionStep[]): void {
  if (!threadId) return;
  stepsByThreadId.set(threadId, steps);
}

export function clearStepsForThread(threadId: string | null): void {
  if (!threadId) return;
  stepsByThreadId.set(threadId, []);
}

export function emitStepsUpdated(threadId: string | null, steps: ExecutionStep[]): void {
  if (!threadId) return;
  toolStreamEventBus.emit({ type: "steps_updated", threadId, steps: [...steps], timestamp: Date.now() } as ToolStreamEvent);
}

// ============================================================================
// 当前 run 思考流存储（Cursor 式：运行中消息展示思考内容，不依赖 msg_id 匹配）
// ============================================================================
const currentRunReasoningByThread: Record<string, string> = {};
export const CURRENT_RUN_REASONING_UPDATED = "current_run_reasoning_updated" as const;

export function getCurrentRunReasoning(threadId: string): string {
  return currentRunReasoningByThread[threadId] ?? "";
}

export function appendCurrentRunReasoning(threadId: string, chunk: string): void {
  if (!threadId || !chunk) return;
  currentRunReasoningByThread[threadId] = (currentRunReasoningByThread[threadId] ?? "") + chunk;
  try {
    window.dispatchEvent(
      new CustomEvent(CURRENT_RUN_REASONING_UPDATED, {
        detail: { threadId, content: currentRunReasoningByThread[threadId] },
      })
    );
  } catch {
    // ignore
  }
}

/** 可选：调用来源，便于排查「思考区被清空」 */
export function clearCurrentRunReasoning(threadId: string, from?: string): void {
  if (!threadId) return;
  if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
    console.warn("[clearCurrentRunReasoning]", { threadIdPrefix: threadId.slice(0, 8), len: threadId.length, from: from ?? "unknown" });
  }
  delete currentRunReasoningByThread[threadId];
  try {
    window.dispatchEvent(
      new CustomEvent(CURRENT_RUN_REASONING_UPDATED, { detail: { threadId, content: "" } })
    );
  } catch {
    // ignore
  }
}
