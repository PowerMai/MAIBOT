/**
 * 远程升级配置与触发卡片
 */
import React, { useState, useEffect, useRef } from "react";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Badge } from "../ui/badge";
import { ScrollArea } from "../ui/scroll-area";
import { Label } from "../ui/label";
import { Input } from "../ui/input";
import { RefreshCw, Copy } from "lucide-react";
import { toast } from "sonner";
import { configApi } from "../../lib/api/configApi";
import {
  getUpgradeStatus,
  getUpgradeRuns,
  checkUpgrade,
  triggerUpgrade,
  type UpgradeRunLog,
} from "../../lib/api/systemApi";
import { getItem as getStorageItem, setItem as setStorageItem } from "../../lib/safeStorage";

export function UpgradeControlCard() {
  const [manifestUrl, setManifestUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [checkResult, setCheckResult] = useState<{
    current_version?: string;
    remote_version?: string;
    update_available?: boolean;
    message?: string;
  } | null>(null);
  const [rolloutSummary, setRolloutSummary] = useState<string>("");
  const [upgradeRuns, setUpgradeRuns] = useState<UpgradeRunLog[]>([]);
  const [expandedRunIdx, setExpandedRunIdx] = useState<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const persistManifestUrl = async (url: string) => {
    try {
      const safeUrl = String(url || "").trim();
      const current = await configApi.read("settings.json");
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(current.content || "{}") as Record<string, unknown>;
      } catch {
        payload = {};
      }
      if (!payload || typeof payload !== "object") payload = {};
      const upgrade = payload.upgrade && typeof payload.upgrade === "object" ? (payload.upgrade as Record<string, unknown>) : {};
      payload.upgrade = { ...upgrade, remote_manifest_url: safeUrl };
      await configApi.write("settings.json", `${JSON.stringify(payload, null, 2)}\n`);
      setStorageItem("maibot_upgrade_manifest_url", safeUrl);
    } catch (e) {
      toast.error("保存升级配置失败", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const loadStatus = async (refresh = false) => {
    if (mountedRef.current) setStatusLoading(true);
    try {
      const res = await getUpgradeStatus("rollout", refresh);
      if (!mountedRef.current) return;
      if (res.ok) {
        const summary = String((res.status as { summary?: string })?.summary || "");
        setRolloutSummary(summary);
      } else {
        setRolloutSummary("");
      }
    } finally {
      if (mountedRef.current) setStatusLoading(false);
    }
  };

  const loadRuns = async () => {
    const res = await getUpgradeRuns(10);
    if (mountedRef.current) {
      if (res.ok) setUpgradeRuns(res.rows || []);
      else setUpgradeRuns([]);
    }
  };

  useEffect(() => {
    const bootstrap = async () => {
      try {
        const cfg = await configApi.read("settings.json");
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(cfg.content || "{}") as Record<string, unknown>;
        } catch {
          data = {};
        }
        if (!mountedRef.current) return;
        const fromCfg = String((data?.upgrade as { remote_manifest_url?: string })?.remote_manifest_url || "").trim();
        if (fromCfg) {
          setManifestUrl(fromCfg);
          setStorageItem("maibot_upgrade_manifest_url", fromCfg);
        } else {
          const raw = getStorageItem("maibot_upgrade_manifest_url") || "";
          setManifestUrl(raw);
        }
      } catch {
        if (mountedRef.current) {
          const raw = getStorageItem("maibot_upgrade_manifest_url") || "";
          setManifestUrl(raw);
        }
      }
      await loadStatus(false);
      await loadRuns();
    };
    void bootstrap();
  }, []);

  const handleCheck = async () => {
    if (mountedRef.current) setLoading(true);
    try {
      if (manifestUrl.trim()) {
        await persistManifestUrl(manifestUrl.trim());
      }
      const res = await checkUpgrade(manifestUrl.trim());
      if (!mountedRef.current) return;
      if (!res.ok) {
        toast.error("检查升级失败", { description: res.error || res.message || "未知错误" });
        return;
      }
      setCheckResult({
        current_version: res.current_version,
        remote_version: res.remote_version,
        update_available: res.update_available,
        message: res.message,
      });
      toast.success(res.update_available ? "检测到可升级版本" : "当前已是最新版本");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  const handleTrigger = async () => {
    if (mountedRef.current) setLoading(true);
    try {
      const res = await triggerUpgrade(true);
      if (!mountedRef.current) return;
      if (!res.ok) {
        toast.error("触发升级失败", { description: res.error || "未知错误" });
        return;
      }
      toast.success("升级编排已触发");
      await loadStatus(false);
      await loadRuns();
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">远程升级</CardTitle>
        <CardDescription>检查版本、触发升级编排、查看最近运行记录</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="space-y-1">
          <Label className="text-xs">远程 Manifest URL</Label>
          <Input
            value={manifestUrl}
            onChange={(e) => setManifestUrl(e.target.value)}
            placeholder="https://example.com/maibot-manifest.json"
            className="h-8 text-xs font-mono"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void persistManifestUrl(manifestUrl)} disabled={loading}>
            保存配置
          </Button>
          <Button size="sm" variant="outline" onClick={handleCheck} disabled={loading}>
            {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : "检查更新"}
          </Button>
          <Button size="sm" onClick={handleTrigger} disabled={loading}>
            触发升级
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { void loadStatus(true); void loadRuns(); }} disabled={statusLoading}>
            {statusLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : "刷新状态"}
          </Button>
        </div>
        {checkResult && (
          <div className="text-[11px] text-muted-foreground rounded border p-2 space-y-1">
            <p>当前版本: {checkResult.current_version || "-"}</p>
            <p>远程版本: {checkResult.remote_version || "-"}</p>
            <p>可升级: {checkResult.update_available ? "是" : "否"}</p>
            {checkResult.message ? <p>{checkResult.message}</p> : null}
          </div>
        )}
        <div className="text-[11px] text-muted-foreground">
          rollout 摘要：{rolloutSummary || (statusLoading ? "加载中..." : "暂无")}
        </div>
        {upgradeRuns.length > 0 && (
          <ScrollArea className="h-[120px] rounded border p-2">
            <div className="space-y-1">
              {upgradeRuns.map((row, idx) => (
                <div key={`upgrade-run-${idx}`} className="text-[11px] rounded border p-1.5 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-mono truncate">{row.ts || "-"}</p>
                    <Badge
                      variant={typeof row.exit_code === "number" && row.exit_code === 0 ? "default" : "destructive"}
                      className="text-[10px]"
                    >
                      exit={typeof row.exit_code === "number" ? row.exit_code : "-"}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground truncate">{row.action || "upgrade"}</p>
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[10px]"
                      onClick={() => setExpandedRunIdx((prev) => (prev === idx ? null : idx))}
                    >
                      {expandedRunIdx === idx ? "收起日志" : "展开日志"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[10px]"
                      onClick={async () => {
                        const text = [
                          `ts=${row.ts || "-"}`,
                          `action=${row.action || "upgrade"}`,
                          `exit_code=${typeof row.exit_code === "number" ? row.exit_code : "-"}`,
                          "",
                          "[stdout_tail]",
                          String(row.stdout_tail || ""),
                          "",
                          "[stderr_tail]",
                          String(row.stderr_tail || ""),
                        ].join("\n");
                        try {
                          await navigator.clipboard.writeText(text);
                          toast.success("升级日志已复制");
                        } catch (e) {
                          toast.error(e instanceof Error ? e.message : String(e));
                        }
                      }}
                    >
                      <Copy className="h-3 w-3 mr-1" />
                      复制
                    </Button>
                  </div>
                  {expandedRunIdx === idx && (
                    <div className="rounded border bg-muted/20 p-2 space-y-1">
                      <p className="text-[10px] font-medium text-muted-foreground">stdout_tail</p>
                      <pre className="whitespace-pre-wrap break-all text-[10px] font-mono max-h-24 overflow-auto">
                        {String(row.stdout_tail || "(empty)")}
                      </pre>
                      <p className="text-[10px] font-medium text-muted-foreground">stderr_tail</p>
                      <pre className="whitespace-pre-wrap break-all text-[10px] font-mono max-h-24 overflow-auto">
                        {String(row.stderr_tail || "(empty)")}
                      </pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
