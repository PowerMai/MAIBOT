/**
 * 聚合短时间内的多条错误为一条 toast，避免网络异常时多个请求同时失败导致 toast 刷屏。
 * 500ms 内的多次 reportError 会合并为一条提示（多条时展示「多个请求失败，请检查连接」）。
 */

import { useCallback, useRef, useEffect } from "react";
import { toast } from "sonner";

const AGGREGATION_MS = 500;

export function useAggregatedErrors() {
  const pendingRef = useRef<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const list = pendingRef.current;
    pendingRef.current = [];
    if (list.length === 0) return;
    if (list.length === 1) {
      toast.error(list[0]);
    } else {
      toast.error("多个请求失败，请检查连接", {
        description: list.slice(0, 3).join("；") + (list.length > 3 ? " …" : ""),
      });
    }
  }, []);

  const reportError = useCallback(
    (message: string) => {
      pendingRef.current.push(message);
      if (timerRef.current == null) {
        timerRef.current = setTimeout(flush, AGGREGATION_MS);
      }
    },
    [flush]
  );

  useEffect(() => () => {
    if (timerRef.current != null) clearTimeout(timerRef.current);
  }, []);

  return { reportError, flush };
}
