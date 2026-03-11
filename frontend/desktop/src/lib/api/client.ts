// 轻量环境类型声明，避免依赖 vite 类型包
declare interface ImportMetaEnv {
  DEV?: boolean;
  MODE?: string;
  VITE_API_BASE_URL?: string;
  VITE_APP_VERSION?: string;
  VITE_LOCAL_AGENT_TOKEN?: string;
  VITE_RBAC_API_KEY?: string;
  VITE_WORKSPACE?: string;
  VITE_TOOL_SCOPE?: 'local' | 'cloud' | 'hybrid';
  VITE_PRINCIPAL?: string;
  VITE_TENANT?: string;
  VITE_LANGGRAPH_API_URL?: string;
  VITE_LANGGRAPH_ASSISTANT_ID?: string;
}
declare interface ImportMeta { env: ImportMetaEnv }

/**
 * API 客户端基础类
 * 统一处理请求、响应、错误和鉴权
 * 
 * 补充中文说明（详细说明，保留原注释）：
 * - 目的：为前端提供统一的 API 客户端基础类，统一处理 HTTP 请求、响应、错误和鉴权，提供一致的 API 调用接口。
 * - 架构设计：
 *   - 本模块提供 `APIClient` 类，封装所有 HTTP 请求逻辑。
 *   - 支持从环境变量读取配置，也支持运行时注入配置。
 *   - 统一处理请求头构建、URL 构建、错误处理和响应解析。
 *   - 支持多种鉴权方式：localAgentToken、rbacApiKey 等。
 *   - 提供默认值注入功能，自动为请求添加默认字段（workspace、toolScope、principal、tenant 等）。
 * - 核心功能：
 *   - `get`：发送 GET 请求，支持查询参数和可选的 admin 模式。
 *   - `post`：发送 POST 请求，支持请求体和可选的 admin 模式。
 *   - `put`：发送 PUT 请求，支持请求体和可选的 admin 模式。
 *   - `delete`：发送 DELETE 请求，支持可选的 admin 模式。
 *   - `addDefaults`：为请求添加默认值，包括 workspace、toolScope、principal、tenant 等。
 *   - `updateConfig`：更新客户端配置。
 *   - `getConfig`：获取当前配置。
 * - 配置说明：
 *   - `baseURL`：API 基础 URL，优先使用配置，否则从环境变量 `VITE_API_BASE_URL` 读取，最后使用当前窗口 origin。
 *   - `localAgentToken`：本地代理令牌，从环境变量 `VITE_LOCAL_AGENT_TOKEN` 读取。
 *   - `rbacApiKey`：RBAC API 密钥，从环境变量 `VITE_RBAC_API_KEY` 读取。
 *   - `workspace`：工作空间名称，默认 `default`。
 *   - `toolScope`：工具作用域，可选 `local`、`cloud`、`hybrid`，默认 `local`。
 *   - `principal`：主体标识，从环境变量 `VITE_PRINCIPAL` 读取。
 *   - `tenant`：租户标识，从环境变量 `VITE_TENANT` 读取。
 * - 错误处理：
 *   - 统一错误类型：`UnauthorizedError`（401）、`ForbiddenError`（403）、`NotFoundError`（404）、`NetworkError`（网络错误）。
 *   - 自动错误转换：根据 HTTP 状态码自动转换为对应的错误类型。
 * - 使用场景：
 *   - 在所有需要调用后端 API 的地方，使用 `apiClient` 实例。
 *   - 在需要自定义配置时，使用 `updateConfig` 更新配置。
 *   - 在需要添加默认值时，使用 `addDefaults` 方法。
 * - 设计原则：
 *   - 统一接口：提供统一的 HTTP 请求接口，简化调用方代码。
 *   - 配置灵活：支持环境变量和运行时配置，提供灵活的配置方式。
 *   - 错误处理：统一错误处理，提供清晰的错误类型和消息。
 * 
 * 该补充注释用于增强文档，不改变模块的导出或行为。
 */

import { UnauthorizedError, ForbiddenError, NotFoundError, NetworkError, ServiceUnavailableError } from './errors';

export interface APIConfig {
  baseURL: string;
  localAgentToken?: string;
  rbacApiKey?: string;
  workspace: string;
  toolScope: 'local' | 'cloud' | 'hybrid';
  principal?: string;
  tenant?: string;
}

export interface APIError {
  status: number;
  message: string;
  code: string;
  details?: Record<string, unknown>;
}
import { getApiBase } from './langserveChat';

class APIClient {
  private config: APIConfig;

  constructor(config?: Partial<APIConfig>) {
    // 从环境变量读取配置，支持运行时注入
    const env = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env : {} as ImportMetaEnv;
    this.config = {
      baseURL: config?.baseURL || getApiBase(),
      localAgentToken: config?.localAgentToken || env.VITE_LOCAL_AGENT_TOKEN,
      rbacApiKey: config?.rbacApiKey || env.VITE_RBAC_API_KEY,
      workspace: config?.workspace || env.VITE_WORKSPACE || 'default',
      toolScope: config?.toolScope || (env.VITE_TOOL_SCOPE as any) || 'local',
      principal: config?.principal || env.VITE_PRINCIPAL,
      tenant: config?.tenant || env.VITE_TENANT,
    };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<APIConfig>) {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  getConfig(): APIConfig {
    return { ...this.config };
  }

  /**
   * 构建完整 URL
   */
  private buildURL(path: string): string {
    const base = (this.config.baseURL || '').replace(/\/+$/, '');
    const cleanPath = (path || '').replace(/^\/+/, '');
    if (!cleanPath) return base || '/';
    return base ? `${base}/${cleanPath}` : `/${cleanPath}`;
  }

  /**
   * 构建请求头
   */
  private buildHeaders(isAdmin: boolean = false): HeadersInit {
    const headers: HeadersInit = {
      'Content-Type': 'application/json; charset=utf-8',
    };

    // 管理员接口：同时兼容 x-api-key / x-admin-key 与 Bearer 方案
    if (isAdmin && this.config.rbacApiKey) {
      headers['x-api-key'] = this.config.rbacApiKey;
      // 为兼容后端 _check_admin_key_optional 读取 x-admin-key 的实现，额外设置一份
      (headers as any)['x-admin-key'] = this.config.rbacApiKey;
      // 兼容 Bearer 作为 Admin
      (headers as any)['Authorization'] = `Bearer ${this.config.rbacApiKey}`;
    }

    // 普通接口可选 Bearer token
    if (!isAdmin && this.config.localAgentToken) {
      headers['Authorization'] = `Bearer ${this.config.localAgentToken}`;
    }

    // 透传主体与租户信息，支持后端的 ACL / 租户隔离
    if (this.config.principal) {
      headers['x-principal'] = this.config.principal;
    }
    if (this.config.tenant) {
      headers['x-tenant'] = this.config.tenant;
    }

    return headers;
  }

  /**
   * 处理响应
   */
  private async handleResponse<T>(response: Response): Promise<T> {
    // 处理 401
    if (response.status === 401) {
      throw new UnauthorizedError('未授权：请在设置中配置 LOCAL_AGENT_TOKEN');
    }

    // 处理 403
    if (response.status === 403) {
      throw new ForbiddenError('权限不足：此操作需要管理员权限');
    }

    // 处理 404
    if (response.status === 404) {
      throw new NotFoundError('资源未找到');
    }

    // 处理其他错误状态码：先取 text 再尝试 JSON，避免非 JSON 响应丢失正文
    if (!response.ok) {
      const rawText = await response.text();
      let errorData: Record<string, unknown> = {};
      try {
        if (rawText.trim()) errorData = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        errorData = { _rawBody: rawText.length > 500 ? rawText.slice(0, 500) + '…' : rawText };
      }
      const rawMsg = errorData.message || errorData.detail || errorData.error || (errorData._rawBody as string) || '';
      const normalized = String((rawMsg || '').toString());
      // 面向用户的友好提示映射（尽量简短且带操作建议）
      const friendly = (() => {
        const m = normalized.toLowerCase();
        if (m.includes('asr_disabled')) return '语音功能未启用，请在设置中开启后重试';
        if (m.includes('macos_adapter_unavailable')) return '当前设备未启用 macOS 语音能力，请切换至其他方案或联系管理员';
        if (m.includes('asr_model_missing')) return '未配置语音模型路径，请在设置中填写模型路径后重试';
        if (m.includes('file_not_found')) return '找不到音频文件，请确认路径或重新选择文件';
        if (m.includes('asr_failed') || m.includes('transcribe_failed')) return '转写失败，请重试或更换音频格式（建议 wav/mp3）';
        if (m.includes('unauthorized') || response.status === 401) return '未授权：请在设置中配置 LOCAL_AGENT_TOKEN';
        if (response.status === 403) return '权限不足：此操作需要管理员权限';
        if (response.status === 404) return '资源未找到';
        if (m.includes('timeout')) return '请求超时，请稍后重试';
        if (m.includes('invalid thread') || m.includes('invalid thread_id') || m.includes('must be a uuid')) return '当前会话 ID 无效，请新建对话后重试';
        // 上传相关友好提示
        const code = (errorData.code || '').toString().toUpperCase();
        if (code === 'MIME_NOT_ALLOWED') return '文件类型不被允许，请更换为允许的类型后再试';
        if (code === 'TOO_LARGE') return '文件过大，超过服务端限制，请压缩或分割后重试';
        if (code === 'TOO_MANY_CHUNKS') return '分片数量过多，请增大分片大小或减少文件体积';
        if (code === 'MISSING_CHUNK') return '缺少部分分片，建议重新上传';
        if (code === 'INCOMPLETE') return '上传未完成，请等待所有分片完成后再点完成';
        if (code === 'EXTRACT_FAILED') return '文件解析失败，请确认文件是否损坏或更换文件重试';
        if (code === 'KM_UPSERT_FAILED') return '入库失败，请稍后重试或联系管理员';
        if (code === 'DISABLED') return '上传功能未启用，请联系管理员在服务端开启后重试';
        return `请求失败：${response.statusText}`;
      })();
      
      // 处理 503 Service Unavailable 错误
      if (response.status === 503) {
        throw new ServiceUnavailableError(
          friendly,
          errorData.service,
          errorData.code || normalized,
          errorData.trace_id || errorData.traceId
        );
      }
      
      const error: APIError = {
        status: response.status,
        message: friendly,
        code: errorData.code || normalized,
        details: errorData,
      };
      throw error;
    }

    // 解析 JSON，失败时抛出而非静默返回空对象
    let data: T;
    try {
      const raw = await response.json();
      data = raw as T;
    } catch (e) {
      throw new Error('响应不是有效 JSON', { cause: e });
    }
    // 统一处理 ResultEnvelope（HTTP 200 但业务失败）
    if (data && typeof data.ok === 'boolean') {
      if (data.ok === false) {
        const traceId = response.headers.get('x-trace-id') || data.trace_id || data.traceId || '';
        const err: APIError = {
          status: response.status,
          message: String(data.error || data.message || '请求失败'),
          code: data.code || 'REQUEST_FAILED',
          details: { ...data, trace_id: traceId },
        };
        throw err;
      }
    }
    return data;
  }

  /** 默认请求超时（毫秒），流式接口不适用 */
  static readonly DEFAULT_TIMEOUT_MS = 30000;

  /**
   * DELETE 请求
   */
  async delete<T>(path: string, params?: Record<string, any>, isAdmin: boolean = false, options?: { signal?: AbortSignal }): Promise<T> {
    try {
      const url = new URL(this.buildURL(path));
      if (params) {
        Object.entries(params).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
            url.searchParams.append(key, String(value));
          }
        });
      }
      const signal = options?.signal ?? (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
        ? (AbortSignal as any).timeout(APIClient.DEFAULT_TIMEOUT_MS)
        : undefined);
      const response = await fetch(url.toString(), {
        method: 'DELETE',
        headers: this.buildHeaders(isAdmin),
        signal,
      });
      return this.handleResponse<T>(response);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new NetworkError('无法连接到后端服务，请检查网络连接');
      }
      throw error;
    }
  }

  /**
   * GET 请求，可选 signal 用于取消
   */
  async get<T>(path: string, params?: Record<string, any>, isAdmin: boolean = false, options?: { signal?: AbortSignal }): Promise<T> {
    try {
      const url = new URL(this.buildURL(path));
      
      // 添加查询参数
      if (params) {
        Object.entries(params).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
            url.searchParams.append(key, String(value));
          }
        });
      }

      const signal = options?.signal ?? (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
        ? (AbortSignal as any).timeout(APIClient.DEFAULT_TIMEOUT_MS)
        : undefined);
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: this.buildHeaders(isAdmin),
        signal,
      });

      return this.handleResponse<T>(response);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new NetworkError('无法连接到后端服务，请检查网络连接');
      }
      throw error;
    }
  }

  /**
   * PATCH 请求
   */
  async patch<T>(path: string, data?: any, isAdmin: boolean = false, options?: { signal?: AbortSignal }): Promise<T> {
    try {
      const signal = options?.signal ?? (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
        ? (AbortSignal as any).timeout(APIClient.DEFAULT_TIMEOUT_MS)
        : undefined);
      const response = await fetch(this.buildURL(path), {
        method: "PATCH",
        headers: this.buildHeaders(isAdmin),
        body: data ? JSON.stringify(data) : undefined,
        signal,
      });
      return this.handleResponse<T>(response);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new NetworkError("无法连接到后端服务，请检查网络连接");
      }
      throw error;
    }
  }

  /**
   * POST 请求
   */
  async post<T>(
    path: string,
    data?: any,
    isAdmin: boolean = false,
    options?: RequestInit & { signal?: AbortSignal }
  ): Promise<T> {
    try {
      const baseHeaders = this.buildHeaders(isAdmin) as Record<string, string>;
      const { headers: optHeaders, signal: optSignal, ...restOptions } = options ?? {};
      const signal = optSignal ?? (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
        ? (AbortSignal as any).timeout(APIClient.DEFAULT_TIMEOUT_MS)
        : undefined);
      const response = await fetch(this.buildURL(path), {
        method: 'POST',
        headers: { ...((optHeaders ?? {}) as Record<string, string>), ...baseHeaders },
        body: data ? JSON.stringify(data) : undefined,
        ...restOptions,
        signal,
      });

      return this.handleResponse<T>(response);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new NetworkError('无法连接到后端服务，请检查网络连接');
      }
      throw error;
    }
  }

  /**
   * POST multipart/form-data（用于文件上传）
   */
  async postForm<T>(path: string, form: FormData, isAdmin: boolean = false): Promise<T> {
    try {
      const headers = this.buildHeaders(isAdmin);
      // 移除 JSON Content-Type，让浏览器自动设置 multipart 边界
      if (typeof headers === 'object' && 'Content-Type' in headers) {
        delete (headers as any)['Content-Type'];
      }
      const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
        ? (AbortSignal as any).timeout(APIClient.DEFAULT_TIMEOUT_MS)
        : undefined;
      const response = await fetch(this.buildURL(path), {
        method: 'POST',
        headers,
        body: form,
        signal,
      });
      return this.handleResponse<T>(response);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new NetworkError('无法连接到后端服务，请检查网络连接');
      }
      throw error;
    }
  }

  /**
   * 流式 POST 请求（SSE）
   * 返回一个 ReadableStream 供调用者消费
   */
  async postStream(
    path: string,
    data?: any,
    isAdmin: boolean = false
  ): Promise<ReadableStream<Uint8Array>> {
    try {
      const response = await fetch(this.buildURL(path), {
        method: 'POST',
        headers: this.buildHeaders(isAdmin),
        body: data ? JSON.stringify(data) : undefined,
      });

      // 检查错误
      if (!response.ok) {
        if (response.status === 401) {
          throw new UnauthorizedError();
        }
        if (response.status === 403) {
          throw new ForbiddenError();
        }
        throw new Error(`请求失败: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('响应体为空');
      }

      return response.body;
    } catch (error) {
      if (error instanceof TypeError) {
        throw new NetworkError();
      }
      throw error;
    }
  }

  /**
   * 添加默认的 workspace 和 tool_scope
   */
  addDefaults<T extends Record<string, any>>(data: T): T {
    return {
      workspace: this.config.workspace,
      tool_scope: this.config.toolScope,
      ...data,
    };
  }
}

// 导出单例
export const apiClient = new APIClient();

// 导出获取基础 URL 的函数（供 workspace.ts 等模块使用）
export function getBaseUrl(): string {
  return apiClient.getConfig().baseURL;
}

// 也导出类以便创建新实例
export default APIClient;
