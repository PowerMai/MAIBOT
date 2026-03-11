"use client";

/**
 * 聊天空状态欢迎卡片 - 根据当前激活角色动态展示
 * 数据来源：GET /agent/profile（当前角色名、能力）、GET /roles/list（角色 suggested_questions）
 */

import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  SparklesIcon,
  FileTextIcon,
  CheckSquareIcon,
  WrenchIcon,
  ArrowRightIcon,
} from "lucide-react";
import { toast } from "sonner";
import { boardApi, type AgentProfile } from "../../lib/api/boardApi";
import { EVENTS } from "../../lib/constants";
import { t } from "../../lib/i18n";
import { RECOMMENDED_FLOW_SHORT, NEXT_STEP_BY_MODE, type ChatModeKey } from "../../lib/modeFlowConstants";
import { cn } from "../ui/utils";
import { useSessionContext } from "../../lib/contexts/SessionContext";

const MODE_LABEL: Record<string, string> = {
  agent: "Agent",
  ask: "Ask",
  plan: "Plan",
  debug: "Debug",
  review: "Review",
};

const SUGGESTIONS_BY_MODE: Record<string, Array<{ text: string; icon: React.ReactNode }>> = {
  agent: [
    { text: "帮我完成一个具体任务", icon: <WrenchIcon className="h-4 w-4" /> },
    { text: "自动分析并处理当前工作区需求", icon: <SparklesIcon className="h-4 w-4" /> },
  ],
  plan: [
    { text: "制定一份可执行的实施计划", icon: <CheckSquareIcon className="h-4 w-4" /> },
    { text: "规划项目方案与步骤", icon: <FileTextIcon className="h-4 w-4" /> },
  ],
  ask: [
    { text: "解释这段内容或概念", icon: <FileTextIcon className="h-4 w-4" /> },
    { text: "对比分析几个方案的优劣", icon: <WrenchIcon className="h-4 w-4" /> },
  ],
  debug: [
    { text: "排查当前问题的根因", icon: <WrenchIcon className="h-4 w-4" /> },
    { text: "诊断并给出修复建议", icon: <CheckSquareIcon className="h-4 w-4" /> },
  ],
  review: [
    { text: "按清单评审当前文档/方案", icon: <CheckSquareIcon className="h-4 w-4" /> },
    { text: "输出分级问题与改进建议", icon: <FileTextIcon className="h-4 w-4" /> },
  ],
};

export interface AgentCapabilitiesProps {
  /** 当前聊天模式 */
  mode?: string;
  /** 当前技能场景（profile_id，用于兼容） */
  profileId?: string;
  /** 已加载技能数量（可选，用于展示） */
  skillsCount?: number;
  /** 点击建议时回调，传入建议文案 */
  onSuggestionClick?: (text: string) => void;
  className?: string;
}

const AgentCapabilitiesInner: React.FC<AgentCapabilitiesProps> = ({
  mode = "agent",
  skillsCount,
  onSuggestionClick,
  className,
}) => {
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [roleSuggestions, setRoleSuggestions] = useState<string[]>([]);
  const [currentRole, setCurrentRole] = useState<{ capabilities?: Array<{ id?: string; label?: string }> } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const { roleId: contextRoleId } = useSessionContext();
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const resolveCurrentRoleId = useCallback(() => contextRoleId, [contextRoleId]);

  const fetchProfile = useCallback(() => {
    if (mountedRef.current) {
      setLoadError(false);
      setLoading(true);
    }
    boardApi
      .getAgentProfile()
      .then((res) => {
        if (!mountedRef.current) return;
        if (!res.ok) {
          setProfile(null);
          setLoadError(true);
          toast.error(t("dashboard.agentProfileLoadError"));
          return;
        }
        setProfile(res.profile ?? null);
        setLoadError(false);
      })
      .catch((err) => {
        if (mountedRef.current) {
          setProfile(null);
          setLoadError(true);
          toast.error(t("dashboard.agentProfileLoadError"), { description: err instanceof Error ? err.message : undefined });
        }
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  // 根据当前线程角色拉取 suggested_questions（线程角色优先，全局仅作兜底）
  useEffect(() => {
    const activeRoleId = resolveCurrentRoleId();
    if (!activeRoleId) {
      setCurrentRole(null);
      setRoleSuggestions([]);
      return;
    }
    boardApi.listRoles().then((res) => {
      if (!mountedRef.current) return;
      if (!res.ok || !res.roles.length) return;
      const role = res.roles.find((r) => r.id === activeRoleId);
      setCurrentRole(role ?? null);
      setRoleSuggestions(role && Array.isArray(role.suggested_questions) ? role.suggested_questions : []);
    }).catch(() => {
      if (mountedRef.current) {
        setCurrentRole(null);
        setRoleSuggestions([]);
        toast.error(t("dashboard.rolesLoadError"));
      }
    });
  }, [resolveCurrentRoleId]);

  useEffect(() => {
    const onRoleChange = () => {
      fetchProfile();
      const r = resolveCurrentRoleId();
      if (!r) {
        setCurrentRole(null);
        setRoleSuggestions([]);
        return;
      }
      boardApi.listRoles().then((res) => {
        if (!res.ok || !res.roles.length) return;
        const role = res.roles.find((x) => x.id === r);
        setCurrentRole(role ?? null);
        setRoleSuggestions(role && Array.isArray(role.suggested_questions) ? role.suggested_questions : []);
      }).catch(() => {
        setCurrentRole(null);
        setRoleSuggestions([]);
        toast.error(t("dashboard.rolesLoadError"));
      });
    };
    window.addEventListener(EVENTS.ROLE_CHANGED, onRoleChange);
    window.addEventListener(EVENTS.COMPOSER_PREFS_CHANGED, onRoleChange);
    window.addEventListener(EVENTS.SESSION_CHANGED, onRoleChange as EventListener);
    return () => {
      window.removeEventListener(EVENTS.ROLE_CHANGED, onRoleChange);
      window.removeEventListener(EVENTS.COMPOSER_PREFS_CHANGED, onRoleChange);
      window.removeEventListener(EVENTS.SESSION_CHANGED, onRoleChange as EventListener);
    };
  }, [fetchProfile, resolveCurrentRoleId]);

  const hasActiveRole = !!resolveCurrentRoleId();
  const name = profile?.name ?? (hasActiveRole ? "工作助手" : "AI 工作助手");
  const description = profile?.description ?? "";
  const caps = profile?.capabilities ?? {};
  const skills: string[] = Array.isArray(caps.skills) ? caps.skills : [];
  const capabilityLabels: string[] = [
    ...(Array.isArray(caps.domains) ? caps.domains : []),
    ...(Array.isArray(caps.skills) ? caps.skills : []),
  ].slice(0, 8);
  const roleCapabilityLabels: string[] = (currentRole?.capabilities?.map((c) => c.label).filter(Boolean) ?? []) as string[];
  const modes: string[] = Array.isArray(caps.modes) ? caps.modes : ["agent", "ask", "plan", "debug", "review"];
  const networkChannels = profile?.network?.channels ?? ["local"];
  const isLocal = networkChannels.includes("local") && !profile?.network?.openclaw_enabled;

  const capabilityLines = description
    ? description
        .split(/[，、；\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 6)
    : [];
  const displayCapabilities =
    capabilityLabels.length > 0
      ? capabilityLabels
      : roleCapabilityLabels.length > 0
        ? roleCapabilityLabels.slice(0, 8)
        : skills.length > 0
          ? skills.slice(0, 8)
          : capabilityLines;

  const modeSuggestions = SUGGESTIONS_BY_MODE[mode] ?? SUGGESTIONS_BY_MODE.agent;
  const suggestions =
    roleSuggestions.length > 0
      ? [
          ...roleSuggestions.slice(0, 4).map((text) => ({ text, icon: <SparklesIcon className="h-4 w-4" /> })),
          ...(modeSuggestions.length > 0 ? [modeSuggestions[0]] : []),
        ]
      : skills.length > 0
        ? [
            { text: `用 ${skills[0]} 相关能力帮我分析`, icon: <SparklesIcon className="h-4 w-4" /> },
            ...modeSuggestions.slice(0, 2),
          ]
        : modeSuggestions;

  const title = !loading && !loadError && hasActiveRole ? name : "选择角色并开始对话";
  const subtitle = !loading && !loadError && hasActiveRole
    ? `${MODE_LABEL[mode] ?? mode} 模式`
    : "建议在聊天输入区先选择角色，再用一句话描述任务目标。";
  const flowLine = RECOMMENDED_FLOW_SHORT;
  const nextStep = NEXT_STEP_BY_MODE[mode as ChatModeKey] ?? NEXT_STEP_BY_MODE.agent;

  return (
    <div className={cn("flex w-full max-w-xl flex-col gap-3 text-left", className)}>
      <div className="rounded-xl border border-border/40 bg-card/40 px-3 py-2">
        <p className="text-sm font-medium text-foreground/90">{title}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">{subtitle}</p>
        {!loading && !loadError && (
          <>
            <p className="mt-1 text-[10px] text-muted-foreground/80">推荐流程：{flowLine}</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground/70">建议下一步：{nextStep}</p>
          </>
        )}
      </div>

      {loadError && (
        <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center justify-center gap-2">
          <span>Agent 档案加载失败</span>
          <button
            type="button"
            onClick={fetchProfile}
            className="px-2 py-0.5 rounded-md border border-amber-500/30 hover:bg-amber-500/10 focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:outline-none"
          >
            重试
          </button>
        </p>
      )}

      <div className="flex flex-col gap-2">
        {suggestions.map((item, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onSuggestionClick?.(item.text)}
            className="group flex w-full items-center gap-3 min-h-[36px] rounded-xl border border-border/40 bg-card/50 px-4 py-2 text-left text-sm text-foreground/90 hover:border-primary/30 hover:bg-primary/5 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label={`建议：${item.text}`}
          >
            <span className="text-muted-foreground/60 group-hover:text-primary transition-colors shrink-0">{item.icon}</span>
            <span className="flex-1 text-left">{item.text}</span>
            <ArrowRightIcon className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-primary/60 group-hover:translate-x-0.5 transition-all shrink-0" />
          </button>
        ))}
      </div>
    </div>
  );
};

export const AgentCapabilities = React.memo(AgentCapabilitiesInner);
export default AgentCapabilities;
