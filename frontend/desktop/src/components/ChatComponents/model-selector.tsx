"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo, startTransition } from "react";
import { Cpu, CheckCircle2, Loader2, RefreshCw, AlertCircle, Sparkles, Image, ImageOff } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { cn } from "../ui/utils";
import { getApiUrl } from "../../lib/api/langserveChat";
import { getInternalAuthHeaders } from "../../lib/api/internalAuth";
import { apiClient } from "../../lib/api/client";
import { EVENTS } from "../../lib/constants";
import { t } from "../../lib/i18n";
import { toast } from "sonner";

// ============================================================
// 模型选择器（Claude/Cursor 风格）
// ============================================================
// 
// 业务逻辑（重要）：
// - 模型列表来自后端（配置 + 本地/云端发现），available 由后端探测或发现结果决定
// - 会话（Thread）创建时绑定模型，会话过程中不能切换
// - 切换模型 = 下次新建会话时使用新模型
// - 支持 "auto" 选项，自动选择最优可用模型
// - 仅展示 enabled=true 的模型（auto 始终展示）
// - 用户选择保存到 localStorage，下次启动时恢复
// ============================================================

interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  provider: "local" | "cloud";
  tier?: string;
  costLevel?: string;
  enabled: boolean;
  available: boolean;
  is_default: boolean;
  is_current: boolean;
  contextWindow?: number;
  supportsImages?: boolean;
}

interface ModelSelectorProps {
  onModelChange?: (modelId: string) => void;
  className?: string;
  /** 仅渲染列表内容，无触发按钮（用于状态栏 Popover 等嵌入场景） */
  embedded?: boolean;
  /** 嵌入模式下选择模型后关闭父级 Popover */
  onClose?: () => void;
}

// localStorage key
const STORAGE_KEY = "maibot_selected_model";
const NO_MODELS_SENTINEL = "__no_models__";
const MODEL_SUPPORTS_IMAGES_KEY = "maibot_selected_model_supports_images";
const CLOUD_CONSENT_KEY = "maibot_cloud_model_consented";
const LEGACY_CLOUD_CONSENT_KEY = "maibot_cloud_model_consent_v1";
const FETCH_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  if (init?.signal) {
    if (init.signal.aborted) {
      controller.abort();
    } else {
      init.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function isCloudModel(model: ModelInfo): boolean {
  return model.provider === "cloud" || String(model.tier || "").startsWith("cloud");
}

/** 模型 ID 去掉 provider 前缀，用于底栏显示（原名） */
function getModelDisplayId(id: string): string {
  if (!id) return id;
  const i = id.indexOf("/");
  return i >= 0 ? id.slice(i + 1) : id;
}

// 默认模型列表（后端不可用时的回退）
const DEFAULT_MODELS: ModelInfo[] = [
  {
    id: "auto",
    name: "自动选择",
    description: "自动选择最优可用模型",
    provider: "local",
    enabled: true,
    available: true,
    is_default: true,
    is_current: true,
  },
];

export function ModelSelector({ onModelChange, className, embedded, onClose }: ModelSelectorProps) {
  const [models, setModels] = useState<ModelInfo[]>(DEFAULT_MODELS);
  const [selectedModelId, setSelectedModelId] = useState<string>(() => {
    // 从 localStorage 恢复用户选择；占位符 __no_models__ 视为无效，用 auto
    if (typeof window !== 'undefined') {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v === NO_MODELS_SENTINEL) return "auto";
      return v || "auto";
    }
    return "auto";
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeRoleId, setActiveRoleId] = useState<string>("");
  const [recommendedModelIds, setRecommendedModelIds] = useState<string[]>([]);
  const onModelChangeRef = useRef(onModelChange);
  const initialLoadDone = useRef(false);
  const lastNotifiedModelRef = useRef<string | null>(null);
  
  // 更新 ref
  useEffect(() => {
    onModelChangeRef.current = onModelChange;
  }, [onModelChange]);
  
  // 选择模型变化时总是通知父组件（去重），避免 UI 与 Runtime 模型偏离
  useEffect(() => {
    if (selectedModelId && lastNotifiedModelRef.current !== selectedModelId) {
      lastNotifiedModelRef.current = selectedModelId;
      onModelChangeRef.current?.(selectedModelId);
    }
  }, [selectedModelId]);

  // 获取当前选中的模型对象
  const selectedModel = useMemo(() => models.find(m => m.id === selectedModelId) || models[0], [models, selectedModelId]);

  // 从后端获取模型列表（使用与 LangGraph 一致的 getApiUrl；状态更新用 startTransition 降低卡顿）
  const fetchModels = useCallback(async (forceRefresh = false) => {
    if (forceRefresh) console.log("[ModelSelector] 刷新模型列表...");
    try {
      startTransition(() => setError(null));
      const apiUrl = getApiUrl();
      const endpoint = forceRefresh ? "/models/refresh" : "/models/list";
      const method = forceRefresh ? "POST" : "GET";
      // #region agent log（仅当配置了 VITE_AGENT_LOG_INGEST_URL 时上报）
      const ingestUrl = (import.meta as { env?: { VITE_AGENT_LOG_INGEST_URL?: string } }).env?.VITE_AGENT_LOG_INGEST_URL;
      if (forceRefresh && ingestUrl) {
        fetch(ingestUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "e406ec" },
          body: JSON.stringify({ sessionId: "e406ec", location: "model-selector.tsx:fetchModels", message: "request endpoint", data: { endpoint, method }, hypothesisId: "E", timestamp: Date.now() }),
        }).catch((err) => { if (import.meta.env?.DEV) console.warn('[ModelSelector] ingest fetchModels failed', err); });
      }
      // #endregion

      const response = await fetchWithTimeout(`${apiUrl}${endpoint}`, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...getInternalAuthHeaders(),
        },
      });

      if (response.ok) {
        const data = await response.json();
        const rawModels = Array.isArray(data.models) ? data.models : [];
        if (data.ok && rawModels.length > 0) {
          const modelList: ModelInfo[] = rawModels.map((m: any) => ({
            id: m.id,
            name: m.name || formatModelName(m.id),
            description: m.description || "",
            provider: String(m.tier || "local").startsWith("cloud") ? "cloud" : "local",
            tier: m.tier || "local",
            costLevel: m.cost_level || "unknown",
            enabled: m.enabled !== false,
            available: m.available !== false,
            is_default: m.is_default || false,
            is_current: m.is_current || false,
            contextWindow: m.context_length || 32768,
            supportsImages: m.supports_images === true,
          }));
          const autoModel = modelList.find((m) => m.id === "auto") ?? {
            id: "auto",
            name: "自动选择",
            description: "自动选择最优可用模型",
            provider: "local",
            enabled: true,
            available: true,
            is_default: true,
            is_current: true,
          };
          const enabledModels = modelList.filter((m) => m.id !== "auto" && m.enabled);
          const visibleModels = [autoModel, ...enabledModels];
          const availableCount = visibleModels.filter((m) => m.available).length;
          if (forceRefresh) console.log("[ModelSelector] 刷新完成:", visibleModels.length, "个模型,", availableCount, "个可用");
          // #region agent log（仅当配置了 VITE_AGENT_LOG_INGEST_URL 时上报）
          if (forceRefresh && ingestUrl) {
            const rawSample = rawModels.slice(0, 3).map((m: any) => ({ id: m?.id, available: m?.available }));
            fetch(ingestUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "e406ec" },
              body: JSON.stringify({
                sessionId: "e406ec",
                location: "model-selector.tsx:after_parse",
                message: "response parsed",
                data: { ok: data.ok, rawLen: rawModels.length, rawSample, availableCount, visibleLen: visibleModels.length },
                hypothesisId: "D",
                timestamp: Date.now(),
              }),
            }).catch((err) => { if (import.meta.env?.DEV) console.warn('[ModelSelector] ingest after_parse failed', err); });
          }
          // #endregion
          startTransition(() => {
            setModels(visibleModels);
            if (!initialLoadDone.current) {
              initialLoadDone.current = true;
              let savedModelId = localStorage.getItem(STORAGE_KEY);
              if (savedModelId === NO_MODELS_SENTINEL) savedModelId = null;
              const savedModelInList = savedModelId ? visibleModels.find((m) => m.id === savedModelId) : null;
              if (savedModelInList) {
                setSelectedModelId(savedModelInList.id);
                if (savedModelInList.id !== "auto" && !savedModelInList.is_current) {
                  switchModelOnBackend(savedModelInList.id);
                }
              } else if (data.current_model) {
                const currentInList = visibleModels.find((m) => m.id === data.current_model);
                const fallbackModel = currentInList ?? autoModel;
                setSelectedModelId(fallbackModel.id);
                localStorage.setItem(STORAGE_KEY, fallbackModel.id);
                localStorage.setItem(MODEL_SUPPORTS_IMAGES_KEY, String(Boolean(fallbackModel.supportsImages)));
                window.dispatchEvent(
                  new CustomEvent("model_changed", {
                    detail: { modelId: fallbackModel.id, supportsImages: Boolean(fallbackModel.supportsImages) },
                  }),
                );
              } else {
                setSelectedModelId(autoModel.id);
                localStorage.setItem(STORAGE_KEY, autoModel.id);
                localStorage.setItem(MODEL_SUPPORTS_IMAGES_KEY, String(Boolean(autoModel.supportsImages)));
                window.dispatchEvent(
                  new CustomEvent("model_changed", {
                    detail: { modelId: autoModel.id, supportsImages: Boolean(autoModel.supportsImages) },
                  }),
                );
              }
            }
          });
        } else if (data.ok && rawModels.length === 0) {
          // 后端返回空列表时仍保留「自动选择」，保证模型始终可用
          const fallbackAuto: ModelInfo = {
            id: "auto",
            name: "自动选择",
            description: "自动选择最优可用模型",
            provider: "local",
            enabled: true,
            available: true,
            is_default: true,
            is_current: true,
          };
          startTransition(() => {
            setModels([fallbackAuto]);
            setError(null);
            if (!initialLoadDone.current) {
              initialLoadDone.current = true;
              setSelectedModelId("auto");
              localStorage.setItem(STORAGE_KEY, "auto");
              localStorage.setItem(MODEL_SUPPORTS_IMAGES_KEY, "false");
              window.dispatchEvent(new CustomEvent("model_changed", { detail: { modelId: "auto", supportsImages: false } }));
            }
          });
        } else if (data.error) {
          startTransition(() => setError(data.error));
        }
      } else {
        if (forceRefresh) {
          console.warn("[ModelSelector] 刷新失败: HTTP", response.status);
          toast.error(t("modelSelector.cannotConnectBackend"), { description: `HTTP ${response.status}` });
        }
        startTransition(() => setError(`HTTP ${response.status}`));
      }
    } catch (err) {
      const isAbort = (err instanceof Error && err.name === "AbortError") || (err instanceof DOMException && err.name === "AbortError");
      if (isAbort) {
        // 请求被取消（如组件卸载、HMR），不视为错误、不刷 UI
      } else {
        startTransition(() => setError(t("modelSelector.cannotConnectBackend")));
        toast.error(t("modelSelector.cannotConnectBackend"), { description: err instanceof Error ? err.message : undefined });
        if (forceRefresh) console.warn("[ModelSelector] 刷新失败:", err instanceof Error ? err.message : err);
        if (import.meta.env?.DEV && err instanceof Error && err.message !== "Failed to fetch") {
          console.warn("[ModelSelector] 获取模型列表失败:", err);
        }
      }
    } finally {
      startTransition(() => setIsLoading(false));
    }
  }, []);

  // 通知后端切换模型
  const switchModelOnBackend = async (modelId: string) => {
    try {
      const data = await apiClient.post<{ ok: boolean; error?: string }>(
        "models/switch",
        { model_id: modelId }
      );

      if (data.ok) {
        if (import.meta.env?.DEV) console.log('Model switched to:', modelId);
        fetchModels(false);
      } else {
        toast.error(t("modelSelector.switchFailed"), { description: data.error || t("modelSelector.unknownError") });
      }
    } catch (err) {
      console.warn("Failed to switch model:", err);
      toast.error(t("modelSelector.backendSwitchFailed"), {
        description: err instanceof Error ? err.message : t("modelSelector.retryLater"),
      });
    }
  };

  // 格式化模型名称
  const formatModelName = (name: string): string => {
    // 移除路径前缀，只保留模型名称
    const parts = name.split('/');
    const modelName = parts[parts.length - 1];
    
    // 美化常见模型名称
    return modelName
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  };

  // 初始 30 秒内每 5 秒轮询，之后每 60 秒，便于 LM Studio 启动后尽快发现模型
  const slowIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    const rafId = requestAnimationFrame(() => fetchModels());
    const fastInterval = setInterval(() => fetchModels(false), 5000);
    const timeoutId = setTimeout(() => {
      clearInterval(fastInterval);
      slowIntervalRef.current = setInterval(() => fetchModels(false), 60000);
    }, 30000);
    return () => {
      cancelAnimationFrame(rafId);
      clearInterval(fastInterval);
      clearTimeout(timeoutId);
      if (slowIntervalRef.current) clearInterval(slowIntervalRef.current);
      slowIntervalRef.current = null;
    };
  }, [fetchModels]);

  // 角色变化后拉取推荐模型清单（用于一人多岗场景）
  useEffect(() => {
    const handler = async (evt: Event) => {
      const roleId = String((evt as CustomEvent).detail?.roleId || "").trim();
      setActiveRoleId(roleId);
      if (!roleId) {
        setRecommendedModelIds([]);
        return;
      }
      try {
        const res = await fetchWithTimeout(`${getApiUrl()}/models/recommend?role_id=${encodeURIComponent(roleId)}`);
        if (!res.ok) return;
        const data = await res.json();
        const ids = Array.isArray(data?.recommendations)
          ? data.recommendations.map((r: any) => String(r?.id || "")).filter(Boolean)
          : [];
        setRecommendedModelIds(ids);
      } catch {
        // ignore recommend failures
      }
    };
    window.addEventListener(EVENTS.ROLE_CHANGED, handler as EventListener);
    return () => window.removeEventListener(EVENTS.ROLE_CHANGED, handler as EventListener);
  }, []);

  const CLOUD_CONFIRM_MSG = t("modelSelector.cloudConfirmMsg");

  // 处理模型选择
  const handleModelSelect = useCallback(async (model: ModelInfo) => {
    if (!model.available && model.id !== "auto") {
      toast.warning(t("modelSelector.unavailable"), { description: t("modelSelector.checkServiceOrRefresh") });
      return;
    }
    // 云端模型一次性知情确认（与 MyRuntimeProvider 一致，走 CONFIRM_CLOUD_MODEL 事件）
    if (model.id !== "auto" && isCloudModel(model)) {
      let acceptedModels: string[] = [];
      try {
        const raw = localStorage.getItem(CLOUD_CONSENT_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        acceptedModels = Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
      } catch {
        acceptedModels = [];
      }
      if (
        acceptedModels.length === 0 &&
        localStorage.getItem(LEGACY_CLOUD_CONSENT_KEY) === "true"
      ) {
        acceptedModels = [model.id];
      }
      const alreadyConsented = acceptedModels.includes(model.id);
      if (!alreadyConsented) {
        const ok = await Promise.race([
          new Promise<boolean>((resolve) => {
            window.dispatchEvent(
              new CustomEvent(EVENTS.CONFIRM_CLOUD_MODEL, {
                detail: { modelId: model.id, previewText: CLOUD_CONFIRM_MSG, resolve },
              })
            );
          }),
          new Promise<boolean>((resolve) => {
            setTimeout(() => resolve(false), 30_000);
          }),
        ]);
        if (!ok) return;
        localStorage.setItem(
          CLOUD_CONSENT_KEY,
          JSON.stringify(Array.from(new Set([...acceptedModels, model.id])))
        );
        localStorage.removeItem(LEGACY_CLOUD_CONSENT_KEY);
      }
    }

    setSelectedModelId(model.id);
    
    // 保存到 localStorage
    localStorage.setItem(STORAGE_KEY, model.id);
    localStorage.setItem(MODEL_SUPPORTS_IMAGES_KEY, String(Boolean(model.supportsImages)));
    
    // 触发自定义事件通知其他组件（同一标签页内）
    window.dispatchEvent(
      new CustomEvent("model_changed", {
        detail: { modelId: model.id, supportsImages: Boolean(model.supportsImages) },
      }),
    );
    
    // 通知后端切换模型
    switchModelOnBackend(model.id);
    
    if (embedded) onClose?.();
  }, []);

  // 处理刷新
  const handleRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsLoading(true);
    await fetchModels(true);
  };

  // 加载中状态：显示“正在连接模型服务...”
  if (isLoading && models.length === 0) {
    return (
      <div className={cn("flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground", className)}>
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>正在连接模型服务...</span>
      </div>
    );
  }

  // 分离 auto 和其他模型
  const autoModel = models.find(m => m.id === "auto");
  const otherModels = models.filter(m => m.id !== "auto");

  const menuContent = (
    <>
        {/* 刷新按钮和状态 */}
        <div className="flex items-center justify-between px-2.5 py-2">
          <span className="text-[12px] text-muted-foreground">
            {error ? (
              <span className="flex items-center gap-1 text-amber-500">
                <AlertCircle className="h-3 w-3" />
                {error}
              </span>
            ) : otherModels.length === 0 ? (
              <span className="text-muted-foreground/90" title={t("modelSelector.onlyAutoTitle")}>
                {autoModel ? t("modelSelector.onlyAutoAvailable") : t("modelSelector.noModelsHint")}
              </span>
            ) : otherModels.every(m => !m.available) ? (
              <span className="text-muted-foreground/90" title={t("modelSelector.listLoadedTitle")}>
                {t("modelSelector.availableCountHint", { available: 0, total: otherModels.length })}
              </span>
            ) : (
              t("modelSelector.modelsAvailable", { available: otherModels.filter(m => m.available).length, total: otherModels.length })
            )}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={handleRefresh}
            disabled={isLoading}
          >
            <RefreshCw className={cn("h-3 w-3", isLoading && "animate-spin")} />
          </Button>
        </div>
        
        <DropdownMenuSeparator />
        
        {/* Auto 选项 */}
        {autoModel && (
          <>
            <DropdownMenuItem
              onClick={() => handleModelSelect(autoModel)}
              className="flex items-center justify-between gap-2 py-1.5"
              title={autoModel.id === "auto" ? t("modelSelector.autoDescription") : autoModel.description}
            >
              <div className="flex items-center gap-2 min-w-0">
                <Sparkles className="h-4 w-4 text-purple-500 shrink-0" />
                <span className="text-[12px] font-medium truncate">{autoModel.id === "auto" ? t("modelSelector.autoName") : getModelDisplayId(autoModel.id)}</span>
              </div>
              {selectedModelId === "auto" && (
                <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
              )}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        
        {/* 本地模型列表 */}
        <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground px-2.5 py-1.5">{t("modelSelector.localModels")}</DropdownMenuLabel>
        {otherModels.map((model) => {
          const tooltip = [model.name, model.description, model.contextWindow ? `${(model.contextWindow / 1000).toFixed(0)}${t("modelSelector.contextKSuffix")}` : ""].filter(Boolean).join(" · ");
          const isRecommended = recommendedModelIds.includes(model.id);
          const isZeroCost = model.costLevel === "zero" || model.tier === "local";
          return (
            <DropdownMenuItem
              key={model.id}
              onClick={() => handleModelSelect(model)}
              disabled={!model.available}
              className={cn(
                "flex items-center justify-between gap-2 py-1.5",
                !model.available && "opacity-50 cursor-not-allowed"
              )}
              title={tooltip}
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <Cpu className={cn(
                  "h-4 w-4 shrink-0",
                  model.available ? "text-foreground" : "text-muted-foreground"
                )} />
                <span className={cn(
                  "text-[12px] truncate",
                  model.is_default && "font-medium"
                )}>
                  {model.id === "auto" ? t("modelSelector.autoName") : getModelDisplayId(model.id)}
                </span>
                {model.supportsImages ? (
                  <Image className="h-3 w-3 text-muted-foreground shrink-0" />
                ) : (
                  <ImageOff className="h-3 w-3 text-muted-foreground shrink-0" />
                )}
                {model.is_default && (
                  <Badge variant="secondary" className="ml-1 h-4 px-1 text-[9px] shrink-0">{t("modelSelector.badgeDefault")}</Badge>
                )}
                {isRecommended && (
                  <Badge variant="secondary" className="ml-1 h-4 px-1 text-[9px] shrink-0">{t("modelSelector.badgeRecommended")}</Badge>
                )}
                {isZeroCost && (
                  <Badge variant="outline" className="ml-1 h-4 px-1 text-[9px] shrink-0">{t("modelSelector.badgeZeroCost")}</Badge>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {model.available ? (
                  <span className="h-2 w-2 rounded-full bg-emerald-500" title={t("modelSelector.available")} />
                ) : (
                  <span className="h-2 w-2 rounded-full bg-gray-400" title={t("modelSelector.unavailableTitle")} />
                )}
                {selectedModelId === model.id && (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                )}
              </div>
            </DropdownMenuItem>
          );
        })}

        {/* 如果没有模型：等待模型加载提示 */}
        {otherModels.length === 0 && (
          <DropdownMenuItem disabled className="text-xs text-muted-foreground">
            {t("modelSelector.waitLoading")}
          </DropdownMenuItem>
        )}
        
        <DropdownMenuSeparator />
        
        {/* 提示信息 */}
        <div className="px-2.5 py-2 text-[11px] text-muted-foreground space-y-1 border-t border-border/50">
          <div>💡 {t("modelSelector.switchEffectiveNext")}</div>
          <div className="opacity-70">{t("modelSelector.currentSessionKeeps")}</div>
          {activeRoleId ? <div className="opacity-70">{t("modelSelector.currentRoleLabel")}{activeRoleId}</div> : null}
        </div>
    </>
  );

  if (embedded) {
    return (
      <div className={cn("w-80 rounded-md border bg-popover p-0 text-popover-foreground shadow-md", className)}>
        {menuContent}
      </div>
    );
  }

  const triggerTitle = selectedModel.id === "auto"
    ? `${selectedModel.name} · ${selectedModel.description || ""}`
    : [selectedModel.name, selectedModel.description, selectedModel.contextWindow ? `${(selectedModel.contextWindow / 1000).toFixed(0)}K 上下文` : ""].filter(Boolean).join(" · ");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "h-7 min-h-7 px-2 text-[12px] rounded-md hover:bg-muted/80 flex items-center gap-1.5 text-muted-foreground/80 min-w-0 max-w-[160px] transition-colors",
            className
          )}
          title={triggerTitle}
        >
          <span className="font-medium text-foreground/80 truncate">{selectedModel.id === "auto" ? t("modelSelector.autoName") : getModelDisplayId(selectedModel.id)}</span>
          {selectedModel.available ? (
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-gray-400 shrink-0" />
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-80">
        {menuContent}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
