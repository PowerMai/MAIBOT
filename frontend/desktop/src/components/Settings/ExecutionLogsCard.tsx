/**
 * 执行日志卡片（Debug 模式，对接 /execution-logs）
 */
import React, { useState, useEffect } from "react";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { validServerThreadIdOrUndefined } from "../../lib/api/langserveChat";
import { getExecutionLogs, getExecutionTrace } from "../../lib/api/systemApi";
import type { ExecutionLogEntry } from "../../lib/api/systemApi";

export const SETTINGS_PREFILL_EXEC_THREAD_EVENT = "settings_prefill_execution_thread";

export function ExecutionLogsCard() {
  const [threadId, setThreadId] = useState("");
  const [logs, setLogs] = useState<ExecutionLogEntry[]>([]);
  const [preferredTrace, setPreferredTrace] = useState<"langsmith" | "local" | "">("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchByThreadId = async (rawThreadId: string) => {
    const tid = rawThreadId.trim();
    if (!tid) {
      toast.error("请输入线程 ID");
      return;
    }
    if (!validServerThreadIdOrUndefined(tid)) {
      toast.error("请输入有效的 UUID 格式 thread_id（服务端仅支持 UUID）");
      return;
    }
    setLoading(true);
    setError(null);
    setLogs([]);
    setPreferredTrace("");
    try {
      const trace = await getExecutionTrace(tid, { limit: 20 });
      if (trace.ok) {
        setPreferredTrace(trace.preferred || "");
        setLogs(trace.logs || []);
        if ((trace.logs || []).length === 0) toast.info("暂无执行日志");
        return;
      }

      const result = await getExecutionLogs(tid, { limit: 20 });
      if (result.success && result.logs) {
        setLogs(result.logs);
        if (result.logs.length === 0) toast.info("暂无执行日志");
      } else {
        setError(result.error ?? "获取失败");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };
  const handleFetch = async () => fetchByThreadId(threadId);

  useEffect(() => {
    const onPrefill = (ev: Event) => {
      const custom = ev as CustomEvent<{ threadId?: string }>;
      const tid = String(custom?.detail?.threadId || "").trim();
      if (!tid) return;
      setThreadId(tid);
      void fetchByThreadId(tid);
    };
    window.addEventListener(SETTINGS_PREFILL_EXEC_THREAD_EVENT as any, onPrefill as any);
    return () => window.removeEventListener(SETTINGS_PREFILL_EXEC_THREAD_EVENT as any, onPrefill as any);
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">执行日志（Debug）</CardTitle>
        <CardDescription>按线程 ID（UUID 格式）拉取后端执行日志</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex gap-2">
          <Input
            placeholder="thread_id (UUID)"
            value={threadId}
            onChange={(e) => setThreadId(e.target.value)}
            className="h-8 text-xs font-mono"
          />
          <Button size="sm" variant="outline" onClick={handleFetch} disabled={loading}>
            {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : "获取"}
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {preferredTrace && (
          <p className="text-[11px] text-muted-foreground">
            追踪来源：{preferredTrace === "langsmith" ? "LangSmith（优先）" : "本地日志（回退）"}
          </p>
        )}
        {logs.length > 0 && (
          <div className="space-y-2">
            <div className="space-y-1">
              {logs.slice(0, 5).map((log, idx) => (
                <div key={`${log.task_id || "task"}-${idx}`} className="rounded border border-border/40 px-2 py-1 text-[11px]">
                  <div className="flex flex-wrap gap-2 text-muted-foreground">
                    <span>{log.status || "unknown"}</span>
                    <span>total: {Number(log.total_duration_ms || 0)}ms</span>
                    <span>ttft: {Number((log as any).ttft_ms || 0)}ms</span>
                    <span>queue: {Number((log as any).queue_wait_ms || 0)}ms</span>
                    <span>retry: {Number((log as any).retry_count || 0)}</span>
                  </div>
                </div>
              ))}
            </div>
            <ScrollArea className="h-[160px] rounded border p-2 text-[11px] font-mono">
              <pre className="whitespace-pre-wrap break-all">{JSON.stringify(logs, null, 2)}</pre>
            </ScrollArea>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
