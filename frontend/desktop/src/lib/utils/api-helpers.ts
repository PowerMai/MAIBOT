/**
 * API 调用辅助函数
 * 
 * 提供统一的错误处理、重试逻辑和加载状态管理
 */

import { toast } from 'sonner';

/** 响应 JSON 解析失败时的哨兵，避免静默吞错；调用方可用 isParseError(data) 判断后 toast */
export const PARSE_ERROR_SENTINEL = { __parseError: true } as const;
export type ParseErrorResult = typeof PARSE_ERROR_SENTINEL;

/** 解析 Response 为 JSON，失败时返回 PARSE_ERROR_SENTINEL */
export async function safeParseResponseJson(res: Response): Promise<unknown> {
  return res.json().catch(() => PARSE_ERROR_SENTINEL);
}

export function isParseError(data: unknown): data is ParseErrorResult {
  return typeof data === "object" && data !== null && (data as { __parseError?: boolean }).__parseError === true;
}

/** 从接口响应体提取错误文案（单源，替代各处 (data as any)?.detail ?? (data as any)?.error ?? res.statusText） */
export function getApiErrorBody(data: unknown, statusText: string): string {
  if (data == null || typeof data !== "object") return statusText;
  const d = data as { detail?: string; error?: string };
  const msg = d.detail ?? d.error ?? statusText;
  return typeof msg === "string" ? msg : statusText;
}

export interface ApiCallOptions {
  /** 是否显示错误 toast */
  showError?: boolean;
  /** 错误消息前缀 */
  errorPrefix?: string;
  /** 是否显示成功 toast */
  showSuccess?: boolean;
  /** 成功消息 */
  successMessage?: string;
  /** 重试次数 */
  retries?: number;
  /** 重试延迟（毫秒） */
  retryDelay?: number;
}

/**
 * 包装 API 调用，提供统一的错误处理
 */
export async function apiCall<T>(
  fn: () => Promise<T>,
  options: ApiCallOptions = {}
): Promise<{ ok: true; data: T } | { ok: false; error: Error }> {
  const {
    showError = true,
    errorPrefix = '',
    showSuccess = false,
    successMessage = '操作成功',
    retries = 0,
    retryDelay = 1000,
  } = options;

  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const data = await fn();
      
      if (showSuccess) {
        toast.success(successMessage);
      }
      
      return { ok: true, data };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }
    }
  }

  if (showError && lastError) {
    const message = errorPrefix 
      ? `${errorPrefix}: ${lastError.message}`
      : lastError.message;
    toast.error(message);
  }

  return { ok: false, error: lastError! };
}

/**
 * 创建带加载状态的 API 调用
 */
export function createApiCallWithLoading<T, Args extends any[]>(
  fn: (...args: Args) => Promise<T>,
  options: ApiCallOptions = {}
) {
  let isLoading = false;
  let loadingListeners: Array<(loading: boolean) => void> = [];

  const call = async (...args: Args) => {
    isLoading = true;
    loadingListeners.forEach(l => l(true));
    
    try {
      const result = await apiCall(() => fn(...args), options);
      return result;
    } finally {
      isLoading = false;
      loadingListeners.forEach(l => l(false));
    }
  };

  const onLoadingChange = (listener: (loading: boolean) => void) => {
    loadingListeners.push(listener);
    return () => {
      loadingListeners = loadingListeners.filter(l => l !== listener);
    };
  };

  return {
    call,
    get isLoading() { return isLoading; },
    onLoadingChange,
  };
}

/**
 * 批量 API 调用
 */
export async function batchApiCalls<T>(
  calls: Array<() => Promise<T>>,
  options: { concurrency?: number; stopOnError?: boolean } = {}
): Promise<Array<{ ok: true; data: T } | { ok: false; error: Error }>> {
  const { concurrency = 5, stopOnError = false } = options;
  const results: Array<{ ok: true; data: T } | { ok: false; error: Error }> = [];
  
  for (let i = 0; i < calls.length; i += concurrency) {
    const batch = calls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(fn => apiCall(fn, { showError: false }))
    );
    
    results.push(...batchResults);
    
    if (stopOnError && batchResults.some(r => !r.ok)) {
      break;
    }
  }
  
  return results;
}

/**
 * 防抖 API 调用
 */
export function debounceApiCall<T, Args extends any[]>(
  fn: (...args: Args) => Promise<T>,
  delay: number = 300
) {
  let timeoutId: NodeJS.Timeout | null = null;
  let pendingPromise: Promise<T> | null = null;
  let pendingResolve: ((value: T) => void) | null = null;
  let pendingReject: ((error: Error) => void) | null = null;

  return (...args: Args): Promise<T> => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (!pendingPromise) {
      pendingPromise = new Promise((resolve, reject) => {
        pendingResolve = resolve;
        pendingReject = reject;
      });
    }

    timeoutId = setTimeout(async () => {
      try {
        const result = await fn(...args);
        pendingResolve?.(result);
      } catch (e) {
        pendingReject?.(e instanceof Error ? e : new Error(String(e)));
      } finally {
        pendingPromise = null;
        pendingResolve = null;
        pendingReject = null;
      }
    }, delay);

    return pendingPromise;
  };
}

/**
 * 节流 API 调用
 */
export function throttleApiCall<T, Args extends any[]>(
  fn: (...args: Args) => Promise<T>,
  limit: number = 1000
) {
  let lastCall = 0;
  let pendingPromise: Promise<T> | null = null;

  return async (...args: Args): Promise<T> => {
    const now = Date.now();
    
    if (now - lastCall >= limit) {
      lastCall = now;
      pendingPromise = fn(...args);
      return pendingPromise;
    }
    
    if (pendingPromise) {
      return pendingPromise;
    }
    
    await new Promise(resolve => setTimeout(resolve, limit - (now - lastCall)));
    lastCall = Date.now();
    pendingPromise = fn(...args);
    return pendingPromise;
  };
}

