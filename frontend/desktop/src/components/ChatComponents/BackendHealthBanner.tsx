"use client";

import React from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "../ui/button";
import { useBackendHealth } from "../../lib/hooks/useBackendHealth";
import { t } from "../../lib/i18n";

/**
 * 当后端不健康时在 Composer 上方展示的非侵入式横幅：服务连接异常 + 重试。
 */
export const BackendHealthBanner: React.FC = () => {
  const { healthy, error, loading, retry } = useBackendHealth();

  if (healthy) return null;

  return (
    <div
      className="shrink-0 flex items-center justify-between gap-2 px-3 py-1.5 text-xs border-b border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200"
      role="alert"
      aria-live="polite"
    >
      <span className="flex items-center gap-1.5 truncate">
        <AlertCircle className="size-3.5 shrink-0" />
        {t("connection.serviceError")}
        {error && <span className="text-muted-foreground/80 truncate">（{error}）</span>}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-6 text-xs shrink-0 border-amber-500/50 hover:bg-amber-500/20"
        onClick={() => retry()}
        disabled={loading}
        aria-label={t("connection.retryAria")}
      >
        {loading ? (
          <RefreshCw className="size-3 animate-spin" />
        ) : (
          <>
            <RefreshCw className="size-3 mr-1" />
            {t("connection.retry")}
          </>
        )}
      </Button>
    </div>
  );
};
