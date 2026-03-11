"use client";

import React, { useCallback, useRef } from "react";
import type { FC } from "react";
import { useLangGraphSend } from "@assistant-ui/react-langgraph";
import { Loader2Icon, ChevronRight, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { motion } from "motion/react";
import { EVENTS } from "../../lib/constants";
import { getCurrentThreadIdFromStorage, getCurrentWorkspacePathFromStorage } from "../../lib/sessionState";
import { getScopedActiveRoleIdFromStorage } from "../../lib/roleIdentity";
import {
  generateBriefing,
  getActiveProjects,
  getInsightsSummary,
  listPlugins,
  getWorkSuggestions,
  type BriefingPayload,
  type BriefingSummaryCard,
} from "../../lib/api/systemApi";
import { boardApi, type RoleDefinition } from "../../lib/api/boardApi";
import { personaApi } from "../../lib/api/personaApi";
import { Skeleton } from "../ui/skeleton";
import { cn } from "../ui/utils";
import { t } from "../../lib/i18n";

const LOADING_SPINNER_DELAY_MS = 200;

export const ThreadWelcome: FC = () => {
  const sendMessage = useLangGraphSend();
  const [loading, setLoading] = React.useState(true);
  const [showLoadingSpinner, setShowLoadingSpinner] = React.useState(false);
  const loadingDelayTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [briefing, setBriefing] = React.useState<BriefingPayload | null>(null);
  const [fallbackCards, setFallbackCards] = React.useState<BriefingSummaryCard[]>([]);
  const [fallbackSuggestions, setFallbackSuggestions] = React.useState<Array<string | Record<string, unknown>>>([]);
  const [installedPlugins, setInstalledPlugins] = React.useState<string[]>([]);
  const [failed, setFailed] = React.useState(false);
  const [roles, setRoles] = React.useState<RoleDefinition[]>([]);
  const [assistantName, setAssistantName] = React.useState<string | null>(null);
  const callIdRef = useRef(0);

  React.useEffect(() => {
    if (loading) {
      loadingDelayTimerRef.current = setTimeout(() => {
        loadingDelayTimerRef.current = null;
        setShowLoadingSpinner(true);
      }, LOADING_SPINNER_DELAY_MS);
    } else {
      if (loadingDelayTimerRef.current) {
        clearTimeout(loadingDelayTimerRef.current);
        loadingDelayTimerRef.current = null;
      }
      setShowLoadingSpinner(false);
    }
    return () => {
      if (loadingDelayTimerRef.current) {
        clearTimeout(loadingDelayTimerRef.current);
        loadingDelayTimerRef.current = null;
      }
    };
  }, [loading]);

  const loadBriefing = useCallback(async () => {
    const myCallId = ++callIdRef.current;
    setLoading(true);
    setFailed(false);
    try {
      // 工作区真源：与设置页/文件树一致
      const workspacePath =
        (typeof window !== "undefined" && getCurrentWorkspacePathFromStorage()?.trim()) ||
        (typeof window !== "undefined" && ((window as any).__CURRENT_WORKSPACE_PATH__ as string | undefined)) ||
        "";

      const [projectsRes, summaryRes, suggestionsRes, pluginsRes, rolesRes, profileRes, personaRes] = await Promise.allSettled([
        getActiveProjects(),
        getInsightsSummary(7),
        getWorkSuggestions(workspacePath || undefined),
        listPlugins(),
        boardApi.listRoles(),
        boardApi.getAgentProfile(),
        personaApi.get().catch(() => ({ ok: false, persona: {} })),
      ]);
      if (callIdRef.current !== myCallId) return;
      if (rolesRes.status === "fulfilled" && rolesRes.value?.ok && Array.isArray(rolesRes.value.roles) && rolesRes.value.roles.length > 0) {
        setRoles(rolesRes.value.roles);
      }
      const p = profileRes.status === "fulfilled" ? profileRes.value?.profile?.name?.trim() : undefined;
      const q = personaRes.status === "fulfilled" ? (personaRes.value as { persona?: { name?: string } })?.persona?.name?.trim() : undefined;
      const name = (p && p.length > 0) ? p : (q && q.length > 0) ? q : null;
      setAssistantName(name);
      const safeProjects = (projectsRes.status === "fulfilled" && Array.isArray(projectsRes.value?.projects)) ? projectsRes.value.projects : [];
      const safeSummary = summaryRes.status === "fulfilled" ? summaryRes.value.summary : undefined;
      const safeSuggestions = (suggestionsRes.status === "fulfilled" && Array.isArray(suggestionsRes.value?.suggestions)) ? suggestionsRes.value.suggestions : [];
      const safePlugins = (pluginsRes.status === "fulfilled" && Array.isArray(pluginsRes.value?.plugins))
        ? pluginsRes.value.plugins.filter((p: { loaded?: boolean; name?: string }) => p.loaded).map((p: { name?: string }) => p.name ?? "").filter(Boolean).slice(0, 6) as string[]
        : [];
      setInstalledPlugins(safePlugins);
      const quickCards: BriefingSummaryCard[] = [
        {
          type: "tasks_overview",
          title: t("welcome.cardTasksOverview"),
          summary: t("welcome.activeSessions", { n: String(safeProjects.length) }),
          data: { active_projects: safeProjects.length },
        },
        {
          type: "insights",
          title: t("welcome.cardInsights"),
          summary: t("welcome.insightsRuns", { n: String(safeSummary?.runs || 0) }),
          data: safeSummary ? { ...safeSummary } : {},
        },
        {
          type: "suggestions",
          title: t("welcome.cardSuggestions"),
          summary: t("welcome.suggestionsCount", { n: String(safeSuggestions.length) }),
          data: { suggestions: safeSuggestions.length },
        },
        {
          type: "plugins",
          title: t("welcome.cardPlugins"),
          summary: safePlugins.length > 0 ? t("welcome.pluginsInstalled", { n: String(safePlugins.length) }) : t("welcome.pluginsNone"),
          data: { plugins: safePlugins },
        },
      ];
      setFallbackCards(quickCards);
      const pluginPrompts = safePlugins.slice(0, 2).map((name) => t("welcome.pluginSuggestionTemplate", { name }));
      setFallbackSuggestions([...safeSuggestions.slice(0, 3).map((s) => s.title), ...pluginPrompts]);

      const briefingRes = await generateBriefing({
        workspace_path: workspacePath || undefined,
        days: 7,
        scope: "personal",
        include_llm: true,
      });
      if (callIdRef.current !== myCallId) return;
      if (briefingRes.ok && briefingRes.briefing) {
        setBriefing(briefingRes.briefing);
      } else {
        setFailed(true);
      }
    } catch (err) {
      if (typeof import.meta !== "undefined" && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
        console.warn("[ThreadWelcome] briefing load failed:", err);
      }
      if (callIdRef.current === myCallId) setFailed(true);
    } finally {
      if (callIdRef.current === myCallId) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadBriefing();
    return () => { callIdRef.current = 0; };
  }, [loadBriefing]);

  const handleSuggestionClick = useCallback(
    (text: string) => {
      toast.info(t("welcome.suggestionSent"), { duration: 1500 });
      sendMessage([{ type: "human", content: text }], {}).catch((err) => {
        console.error("[ThreadWelcome] send failed:", err);
        toast.error(t("welcome.sendFailed"));
      });
      setTimeout(() => window.dispatchEvent(new CustomEvent(EVENTS.FOCUS_COMPOSER)), 100);
    },
    [sendMessage]
  );

  const roleId = getScopedActiveRoleIdFromStorage();
  const roleLabel = roles.find((r) => r.id === roleId)?.label ?? roleId;
  const workspacePath =
    (typeof window !== "undefined" && getCurrentWorkspacePathFromStorage()?.trim()) ||
    (typeof window !== "undefined" && ((window as any).__CURRENT_WORKSPACE_PATH__ as string | undefined)) ||
    "";
  const workspaceDisplay = workspacePath
    ? (workspacePath.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || workspacePath)
    : t("welcome.workspaceNotSelected");
  const roleGreeting = assistantName
    ? t("welcome.greetingAsName", { name: assistantName })
    : roleId && roleId !== "default"
      ? t("welcome.greetingAsRole", { role: roleLabel })
      : t("welcome.greetingDefault");
  const greeting = (briefing?.greeting || "").trim() || roleGreeting;
  const cards = briefing?.summary_cards?.length ? briefing.summary_cards : fallbackCards;
  const todayLabel = (() => {
    const d = new Date();
    return t("welcome.today", { month: String(d.getMonth() + 1), day: String(d.getDate()) });
  })();

  const handleCardClick = useCallback((card: BriefingSummaryCard & { type?: string }) => {
    const t = (card as { type?: string }).type;
    if (t === "tasks_overview") {
      window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_LEFT_PANEL, { detail: { tab: "tasks" } }));
    } else if (t === "insights") {
      window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_LEFT_PANEL, { detail: { tab: "knowledge" } }));
    } else if (t === "suggestions") {
      window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_LEFT_PANEL, { detail: { tab: "tasks" } }));
    }
  }, []);

  const suggestions = (briefing?.suggestions?.length ? briefing.suggestions : fallbackSuggestions)
    .map((s) => {
      if (typeof s === "string") return s;
      if (s && typeof s === "object") {
        const title = String((s as Record<string, unknown>).title || "");
        const text = String((s as Record<string, unknown>).text || "");
        const desc = String((s as Record<string, unknown>).description || "");
        return (title || text || desc).trim();
      }
      return "";
    })
    .filter(Boolean)
    .slice(0, 4);

  const displayCards = cards.length ? cards : [
    { title: t("welcome.cardTasksOverview") },
    { title: t("welcome.cardInsights") },
    { title: t("welcome.cardSuggestions") },
    { title: t("welcome.cardPlugins") },
  ];
  const isCardClickable = (c: { type?: string }) =>
    c.type === "tasks_overview" || c.type === "insights" || c.type === "suggestions";

  const CARD_GRID_MIN_H = "min-h-[72px]";
  const cardSlots = [0, 1, 2, 3] as const;

  return (
    <div className="aui-thread-welcome-root flex w-full grow flex-col items-center justify-center px-4 py-6">
      <div className="w-full max-w-xl rounded-xl border border-border/50 bg-card/40 p-4 shadow-elevation-md">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            {!loading && (
              <>
                <p className="text-[11px] text-muted-foreground mb-0.5">{todayLabel}</p>
                <p className="text-[10px] text-muted-foreground/80 mb-1">
                  {t("welcome.role")}：{roleLabel}
                  {workspaceDisplay !== t("welcome.workspaceNotSelected") ? ` · ${t("welcome.workspace")}：${workspaceDisplay}` : ""}
                </p>
              </>
            )}
            <p className="text-sm font-semibold text-foreground/90">
              {showLoadingSpinner ? t("welcome.briefingLoading") : greeting}
            </p>
            {loading && <Skeleton className="mt-1.5 h-3 w-full max-w-[200px]" />}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {!loading && (
              <button
                type="button"
                onClick={() => loadBriefing()}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                title={t("welcome.refreshBriefing")}
                aria-label={t("welcome.refreshBriefing")}
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            )}
            {loading && <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
          {cardSlots.map((idx) => {
            const card = displayCards[idx];
            const cardWithType = card as BriefingSummaryCard & { type?: string } | undefined;
            const clickable = cardWithType ? isCardClickable(cardWithType) : false;
            if (loading) {
              return (
                <div
                  key={`slot-${idx}`}
                  className={cn("rounded-lg border border-border/40 bg-background/60 px-3 py-2 flex flex-col", CARD_GRID_MIN_H)}
                >
                  <Skeleton className="h-3 w-16 mb-2" />
                  <Skeleton className="h-3 w-full flex-1 min-h-6" />
                </div>
              );
            }
            return (
              <motion.div
                key={`card-${idx}-${cardWithType?.title ?? "empty"}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: idx * 0.04 }}
                role={clickable ? "button" : undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={clickable && cardWithType ? () => handleCardClick(cardWithType) : undefined}
                onKeyDown={clickable && cardWithType ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleCardClick(cardWithType); } } : undefined}
                className={cn(
                  "rounded-lg border border-border/40 bg-background/60 px-3 py-2 flex flex-col min-h-0 text-left",
                  CARD_GRID_MIN_H,
                  clickable && "cursor-pointer hover:bg-muted/40 hover:border-border/60 transition-colors"
                )}
              >
                <div className="text-[11px] font-medium text-muted-foreground">{cardWithType?.title ?? t("welcome.cardOverview")}</div>
                <div className="mt-1 text-xs text-foreground/90 line-clamp-3 flex-1 min-h-0">
                  {cardWithType?.summary ?? t("welcome.summaryNone")}
                </div>
                {clickable && (
                  <div className="mt-1 flex justify-end">
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>
        {installedPlugins.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {installedPlugins.map((name) => (
              <span key={name} className="rounded border border-border/50 bg-background/70 px-2 py-0.5 text-[10px] text-muted-foreground">
                {name}
              </span>
            ))}
          </div>
        )}
        <div className="mt-3">
          <p className="mb-2 text-[11px] text-muted-foreground">{t("welcome.youCanStart")}</p>
          <div className="flex flex-col gap-2">
            {(suggestions.length ? suggestions : [t("welcome.fallbackSuggestion")]).map((text, i) => (
              <button
                key={`${text}-${i}`}
                type="button"
                onClick={() => handleSuggestionClick(text)}
                className="w-full rounded-lg border border-border/40 bg-card/60 px-3 py-2 text-left text-xs text-foreground/90 hover:bg-muted/40 transition-colors"
              >
                {text}
              </button>
            ))}
          </div>
        </div>
        {failed && (
          <div className="mt-2 flex items-center gap-2" role="alert" aria-live="assertive">
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              {t("welcome.briefingFailed")}
            </p>
            <button
              type="button"
              onClick={() => loadBriefing()}
              className="text-[11px] text-primary hover:underline shrink-0"
            >
              {t("welcome.briefingRetry")}
            </button>
          </div>
        )}
        {briefing?.markdown_report ? (
          <button
            type="button"
            className="mt-3 text-[11px] text-primary hover:underline"
            onClick={() => {
              const scopedThreadId = getCurrentThreadIdFromStorage();
              window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, {
                detail: { prompt: briefing.markdown_report, threadId: scopedThreadId || undefined },
              }));
            }}
          >
            {t("welcome.fillBriefingPrompt")}
          </button>
        ) : null}
      </div>
    </div>
  );
};
