/**
 * LangSmith 可观测性状态卡片
 */
import React, { useState, useEffect } from "react";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { RefreshCw } from "lucide-react";
import { getLangSmithStatus } from "../../lib/api/systemApi";
import type { LangSmithStatus } from "../../lib/api/systemApi";

export function LangSmithStatusCard() {
  const [status, setStatus] = useState<LangSmithStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const handleFetch = async () => {
    setLoading(true);
    try {
      const s = await getLangSmithStatus();
      setStatus(s);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    handleFetch();
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">LangSmith 可观测性</CardTitle>
        <CardDescription>追踪启用状态与配置检查</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {status?.message || (loading ? "检查中..." : "未获取状态")}
          </p>
          <Button size="sm" variant="outline" onClick={handleFetch} disabled={loading}>
            {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : "刷新"}
          </Button>
        </div>
        {status && (
          <div className="text-[11px] text-muted-foreground space-y-1">
            <p>启用: {status.enabled ? "是" : "否"}</p>
            <p>API Key: {status.has_api_key ? "已配置" : "未配置"}</p>
            <p>Tracing V2: {status.tracing_v2 ? "true" : "false"}</p>
            {!!status.tracing_source && <p>Tracing 来源: {status.tracing_source}</p>}
            {!!status.project && <p>Project: {status.project}</p>}
            {status.eval_summary && (
              <p>
                最近评估: total={Number(status.eval_summary.total || 0)} feedback=
                {Number(status.eval_summary.feedback_sent || 0)} avg=
                {Number(status.eval_summary.avg_score || 0).toFixed(2)}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
