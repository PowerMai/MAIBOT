/**
 * 结晶建议 Toast：任务完成后拉取建议并展示「保存为 Skill」或「工作区建议」（统一通道）
 */
import React, { useEffect, useRef } from "react";
import { toast } from "sonner";
import { getApiBase } from "../lib/api/langserveChat";
import { getInternalAuthHeaders } from "../lib/api/internalAuth";
import { EVENTS } from "../lib/constants";
import { t } from "../lib/i18n";

export type CrystallizationSuggestion = {
  skill_name?: string;
  benefit?: string;
  cost?: string;
  quality_score?: number;
};

interface CrystallizationToastProps {
  threadId: string | null;
  taskRunning: boolean;
  workspaceId?: string | null;
}

async function fetchSuggestions(
  threadId: string | null,
  workspaceId: string | null,
  signal?: AbortSignal
): Promise<{ suggestion: CrystallizationSuggestion | null; workspace_suggestion: string | null }> {
  try {
    const params = new URLSearchParams();
    if (threadId) params.set("thread_id", threadId);
    if (workspaceId) params.set("workspace_id", workspaceId);
    const res = await fetch(`${getApiBase()}/agent/crystallization-suggestion?${params.toString()}`, {
      signal,
      headers: getInternalAuthHeaders(),
    });
    if (!res.ok) return { suggestion: null, workspace_suggestion: null };
    const data = await res.json().catch(() => ({ __parseError: true } as const));
    if ((data as { __parseError?: boolean })?.__parseError) return { suggestion: null, workspace_suggestion: null };
    if (!data?.ok) return { suggestion: null, workspace_suggestion: null };
    return {
      suggestion: (data.suggestion as CrystallizationSuggestion) || null,
      workspace_suggestion: typeof data.workspace_suggestion === "string" ? data.workspace_suggestion : null,
    };
  } catch {
    return { suggestion: null, workspace_suggestion: null };
  }
}

export const CrystallizationToast: React.FC<CrystallizationToastProps> = ({
  threadId,
  taskRunning,
  workspaceId = null,
}) => {
  const prevRunning = useRef(false);
  const prevThreadId = useRef(threadId);

  useEffect(() => {
    if (prevThreadId.current !== threadId) {
      prevRunning.current = false;
      prevThreadId.current = threadId;
      return;
    }
    if (prevRunning.current && !taskRunning && (threadId || workspaceId)) {
      prevRunning.current = taskRunning;
      const controller = new AbortController();
      fetchSuggestions(threadId, workspaceId, controller.signal).then(({ suggestion, workspace_suggestion }) => {
        if (controller.signal.aborted) return;
        if (suggestion) {
          toast.success(t("crystallization.skillToast"), {
            description: suggestion.benefit || t("crystallization.skillToastDescription"),
            action: {
              label: t("crystallization.viewAction"),
              onClick: () => {
                if (typeof window !== "undefined") {
                  window.dispatchEvent(
                    new CustomEvent(EVENTS.OPEN_SKILLS_PANEL, {
                      detail: { skill_name: suggestion.skill_name, from: "crystallization" },
                    })
                  );
                }
              },
            },
            duration: 8000,
          });
        }
        if (controller.signal.aborted) return;
        if (workspace_suggestion) {
          toast.info(t("crystallization.workspaceSuggestion"), {
            description: workspace_suggestion,
            duration: 6000,
          });
        }
      });
      return () => controller.abort();
    }
    prevRunning.current = taskRunning;
  }, [taskRunning, threadId, workspaceId]);

  return null;
};
