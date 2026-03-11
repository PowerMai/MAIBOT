/**
 * LangSmith 自动评估记录卡片
 */
import React, { useState, useEffect } from "react";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { ScrollArea } from "../ui/scroll-area";
import { Badge } from "../ui/badge";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { getLangSmithEvals, type LangSmithEvalRow } from "../../lib/api/systemApi";
import { SETTINGS_PREFILL_EXEC_THREAD_EVENT } from "./ExecutionLogsCard";

export function LangSmithEvalsCard() {
  const [rows, setRows] = useState<LangSmithEvalRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRows = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getLangSmithEvals(20);
      if (!res.ok) {
        setRows([]);
        setError(res.error || "读取评估记录失败");
        return;
      }
      setRows(res.rows || []);
    } catch (e) {
      setRows([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadRows();
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">LangSmith 自动评估记录</CardTitle>
        <CardDescription>任务结束后自动打分，LangSmith 可用时同步反馈</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-end">
          <Button size="sm" variant="outline" onClick={loadRows} disabled={loading}>
            {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : "刷新"}
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">暂无评估记录</p>
        ) : (
          <ScrollArea className="h-[180px] rounded border p-2">
            <div className="space-y-2">
              {rows.map((r, idx) => (
                <div key={`ls-eval-${idx}`} className="rounded border p-2 text-[11px] space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono truncate">{r.thread_id || "unknown-thread"}</span>
                    <Badge variant={r.feedback_sent ? "default" : "outline"}>
                      {typeof r.score === "number" ? `score=${r.score.toFixed(2)}` : "score=-"}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground">
                    {r.mode || "agent"} · {r.task_status || "unknown"} · feedback {r.feedback_sent ? "sent" : "local-only"}
                  </p>
                  {!!r.thread_id && (
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[10px]"
                        onClick={() => {
                          window.dispatchEvent(
                            new CustomEvent(SETTINGS_PREFILL_EXEC_THREAD_EVENT, {
                              detail: { threadId: r.thread_id },
                            })
                          );
                          toast.success("已定位到执行日志查询");
                        }}
                      >
                        查看执行日志
                      </Button>
                    </div>
                  )}
                  {r.ts ? <p className="text-muted-foreground">{new Date(r.ts).toLocaleString()}</p> : null}
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
