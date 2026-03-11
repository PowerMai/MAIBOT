/**
 * 后端健康状态 hook：用于 Composer 旁或状态栏展示「服务连接异常」+ 重试。
 * 复用 langserveChat 的 checkHealth / 缓存，轮询间隔与健康检查间隔一致。
 */

import { useState, useEffect, useCallback } from "react";
import { checkHealth, getCachedHealthStatus } from "../api/langserveChat";

const POLL_INTERVAL_MS = 30_000;

export interface BackendHealthState {
  healthy: boolean;
  error: string | undefined;
  loading: boolean;
}

export function useBackendHealth(): BackendHealthState & { retry: () => Promise<void> } {
  const [state, setState] = useState<BackendHealthState>(() => {
    const cached = getCachedHealthStatus();
    return {
      healthy: cached.healthy,
      error: cached.healthy ? undefined : (cached.error ?? "连接失败"),
      loading: false,
    };
  });

  const refresh = useCallback(async (force = false) => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const status = await checkHealth(force);
      setState({
        healthy: status.healthy,
        error: status.healthy ? undefined : (status.error ?? "连接失败"),
        loading: false,
      });
    } catch {
      setState({
        healthy: false,
        error: "检查失败",
        loading: false,
      });
    }
  }, []);

  useEffect(() => {
    refresh(false);
    const id = setInterval(() => refresh(false), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const retry = useCallback(async () => {
    await refresh(true);
  }, [refresh]);

  return { ...state, retry };
}
