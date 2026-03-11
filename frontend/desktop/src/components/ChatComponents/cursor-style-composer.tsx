"use client";

/**
 * Cursor 风格的聊天输入组件
 *
 * 功能：
 * 1. 模式选择：Agent / Ask / Plan / Debug / Review（第4位按角色动态）
 * 2. Token 计数和上下文管理显示
 * 3. 附件上传（图片、文件、代码）
 * 4. 联网搜索开关
 * 5. 添加上下文（文件、文件夹、代码片段）
 *
 * 数据与实时性（展示 = 实际发送）：
 * - 模式 / 业务场景 / 联网：来自 state + localStorage，同 tab 通过 COMPOSER_PREFS_CHANGED 与 storage 同步。
 * - 上下文项：与 MyRuntimeProvider 共用 context_items_changed，展示与发送一致；发送后清空并派发以清空 ref。
 * - 运行状态（发送/停止）：来自 ThreadPrimitive.If running，即 runtime 实时状态。
 * - 上下文统计：流式结束后来自 context_stats 事件（估算）或点击刷新拉取 /context/stats（当前对话）。
 * - 模型：由 ModelSelector 管理，选择时写 localStorage 并派发 model_changed，发送时从 ref 读取。
 */

import React, { useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo, startTransition, useContext } from "react";
import { createPortal } from "react-dom";
import type { FC } from "react";
import {
  ComposerPrimitive,
  ThreadPrimitive,
  useComposerRuntime,
  useAssistantState,
} from "@assistant-ui/react";
import { toast } from "sonner";
import { cn } from "../ui/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover";
import {
  ArrowUpIcon,
  SquareIcon,
  PlusIcon,
  ImageIcon,
  FileIcon,
  FolderIcon,
  GlobeIcon,
  BrainIcon,
  ListTodoIcon,
  HelpCircleIcon,
  BugIcon,
  CheckIcon,
  ClipboardCheckIcon,
  ChevronDownIcon,
  CodeIcon,
  LinkIcon,
  XIcon,
  DatabaseIcon,
} from "lucide-react";
import { CancelContext } from "./cancelContext";
import { OpenFilesContext } from "./openFilesContext";
import { ModelSelector } from "./model-selector";
import { boardApi, type RoleDefinition } from "../../lib/api/boardApi";
import { getApiBase, validServerThreadIdOrUndefined } from "../../lib/api/langserveChat";
import { getInternalAuthHeaders } from "../../lib/api/internalAuth";
import { EVENTS } from "../../lib/constants";
import { t } from "../../lib/i18n";
import type { ContextItem } from "../../types/context";
import { getItem as getStorageItem, setItem as setStorageItem } from "../../lib/safeStorage";
import { getCurrentWorkspacePathFromStorage } from "../../lib/sessionState";
import { useSessionContext } from "../../lib/contexts/SessionContext";
import { MODE_SEND_BUTTON_BG } from "../../lib/chatModeState";
import { NEXT_STEP_BY_MODE } from "../../lib/modeFlowConstants";
import { useTaskStore } from "../../store/taskStore";
import { InterruptStateContext } from "./InterruptStateContext";
import { listPluginCommands, listPlugins } from "../../lib/api/systemApi";
import {
  DEFAULT_ROLE_ID,
  getCurrentThreadIdFromStorage,
  getThreadScopedRoleStorageKey,
  normalizeRoleId,
} from "../../lib/roleIdentity";

// ============================================================
// 类型定义
// ============================================================

export type ChatMode = "agent" | "plan" | "ask" | "debug" | "review";

const _MODE_LABELS: Record<ChatMode, string> = {
  agent: "已切换至 Agent：将自动执行并交付成果",
  ask: "已切换至 Ask：只读分析，不修改文件",
  plan: "已切换至 Plan：将产出可执行计划供您确认",
  debug: "已切换至 Debug：将排查根因并给出修复建议",
  review: "已切换至 Review：将执行清单化评审并输出问题分级报告",
};

interface ModeConfig {
  id: ChatMode;
  label: string;
  icon: React.ReactNode;
  description: string;
  color: string;
  shortcut?: string;
}

const VALID_CHAT_MODES: ChatMode[] = ["agent", "plan", "ask", "debug", "review"];
const BASE_MODE_ORDER: ChatMode[] = ["agent", "ask", "plan", "debug", "review"];
const DEBUG_PRIMARY_ROLE_IDS = new Set(["coding_engineer", "developer", "software_engineer", "programmer"]);
const MAX_PASTE_TEXT_CHARS = 200_000;
const MAX_PASTE_IMAGE_BYTES = 15 * 1024 * 1024;

// ============================================================
// 模式配置 - 通过消息 additional_kwargs.mode 传递给后端
// 
// 模式工作流程：
// Ask（咨询探讨）→ Plan（规划计划）→ Agent（自动执行）→ Debug/Review（诊断或评审）
// ============================================================

const CHAT_MODES: ModeConfig[] = [
  {
    id: "agent",
    label: "Agent",
    icon: <BrainIcon className="size-4" />,
    description: "已明确要做什么时选用 · 自动执行并交付成果（可读写文件、运行命令）",
    color: "text-purple-500",
    shortcut: "⌘1",
  },
  {
    id: "ask",
    label: "Ask",
    icon: <HelpCircleIcon className="size-4" />,
    description: "想先讨论、分析或评估时选用 · 只读分析、回答疑问、不修改任何文件",
    color: "text-emerald-500",
    shortcut: "⌘2",
  },
  {
    id: "plan",
    label: "Plan",
    icon: <ListTodoIcon className="size-4" />,
    description: "任务较复杂、希望先看方案再执行时选用 · 产出可执行计划，确认后可转 Agent 执行",
    color: "text-blue-500",
    shortcut: "⌘3",
  },
  {
    id: "debug",
    label: "Debug",
    icon: <BugIcon className="size-4" />,
    description: "出现报错或结果异常时选用 · 假设驱动排查、给出根因与修复建议",
    color: "text-orange-500",
  },
  {
    id: "review",
    label: "Review",
    icon: <ClipboardCheckIcon className="size-4" />,
    description: "需要系统化审查时选用 · 清单驱动评审并输出分级问题与建议",
    color: "text-teal-500",
  },
];

// ============================================================
// 角色（Role）- 对应 backend/config/roles.json
// 用户选择一个角色，Agent 以该角色的身份、知识、提示词工作
// ============================================================

/** 前端角色项（从后端 RoleDefinition 映射或使用 fallback） */
interface RoleItem {
  id: string;
  label: string;
  description: string;
  icon?: string;
  /** 角色绑定的技能档案，切换角色时同步到领域下拉 */
  skill_profile?: string;
  responsibility_scope?: string;
  not_responsible_for?: string[];
  resolved_capabilities_count?: number;
  suggested_questions?: string[];
  capabilities?: { id: string; label: string }[];
  modes?: ChatMode[];
  preferred_fourth_mode?: "debug" | "review" | null;
}

const ROLES_FALLBACK: RoleItem[] = [];

const ROLE_COLOR_PALETTE = [
  { text: "text-indigo-600", textDark: "dark:text-indigo-400", bg: "bg-indigo-500/8", border: "border-indigo-500/20", focus: "hsl(239 83% 67% / 0.15)" },
  { text: "text-teal-600", textDark: "dark:text-teal-400", bg: "bg-teal-500/8", border: "border-teal-500/20", focus: "hsl(173 80% 40% / 0.15)" },
  { text: "text-rose-600", textDark: "dark:text-rose-400", bg: "bg-rose-500/8", border: "border-rose-500/20", focus: "hsl(347 77% 50% / 0.15)" },
  { text: "text-cyan-600", textDark: "dark:text-cyan-400", bg: "bg-cyan-500/8", border: "border-cyan-500/20", focus: "hsl(189 94% 43% / 0.15)" },
  { text: "text-slate-600", textDark: "dark:text-slate-400", bg: "bg-slate-500/8", border: "border-slate-500/20", focus: "hsl(215 16% 47% / 0.15)" },
] as const;

const DEFAULT_ROLE_COLOR = { text: "text-muted-foreground", textDark: "", bg: "", border: "", focus: "hsl(var(--primary) / 0.15)" };

function getRoleTheme(roleId: string) {
  if (!roleId) return DEFAULT_ROLE_COLOR;
  let hash = 0;
  for (let i = 0; i < roleId.length; i++) hash = (hash * 31 + roleId.charCodeAt(i)) >>> 0;
  return ROLE_COLOR_PALETTE[hash % ROLE_COLOR_PALETTE.length] ?? DEFAULT_ROLE_COLOR;
}

// 保留 SkillProfileId 类型以兼容 localStorage 旧值
export type SkillProfileId =
  | "full"
  | "office"
  | "report"
  | "research"
  | "analyst"
  | "analytics"
  | "general";

/** 有效的技能档案 ID 列表（用于校验 localStorage） */
const VALID_SKILL_PROFILE_IDS: SkillProfileId[] = [
  "full",
  "office",
  "report",
  "research",
  "analyst",
  "analytics",
  "general",
];

function normalizeSkillProfileId(profileId: string | null | undefined): SkillProfileId | "full" {
  if (!profileId) return "full";
  if (profileId === "analytics") return "analyst";
  return VALID_SKILL_PROFILE_IDS.includes(profileId as SkillProfileId) ? (profileId as SkillProfileId) : "full";
}

const THREAD_MODE_KEY_PREFIX = "maibot_chat_mode_thread_";
const THREAD_SESSION_PLUGINS_KEY_PREFIX = "maibot_session_plugins_thread_";

function getThreadRoleStorageKey(threadId: string): string {
  return getThreadScopedRoleStorageKey(threadId);
}

function getThreadModeStorageKey(threadId: string): string {
  return `${THREAD_MODE_KEY_PREFIX}${threadId}`;
}

function getThreadSessionPluginsStorageKey(threadId: string): string {
  return `${THREAD_SESSION_PLUGINS_KEY_PREFIX}${threadId}`;
}

function getScopedSessionPlugins(): string[] {
  const threadId = getCurrentThreadIdFromStorage();
  if (!threadId) return [];
  try {
    const raw = getStorageItem(getThreadSessionPluginsStorageKey(threadId)) || "[]";
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((x) => String(x || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeRoleModes(modes?: string[], roleId?: string, preferredFourthMode?: string | null): ChatMode[] {
  const raw = Array.isArray(modes) ? modes : [];
  const allowed = BASE_MODE_ORDER.filter((m) => raw.includes(m));

  if (allowed.length === 0) {
    return BASE_MODE_ORDER;
  }

  // 与后端保持一致：不裁剪角色可用模式，仅做顺序归一。
  if (!allowed.includes("agent")) return ["agent", ...allowed.filter((m) => m !== "agent")];
  return allowed;
}

/** Debug/Review 互斥：后端 modes 已至多含其一，第四模式即其中在列者 */
function resolvePreferredFourthMode(availableModes: ChatMode[]): ChatMode | undefined {
  if (availableModes.includes("debug")) return "debug";
  if (availableModes.includes("review")) return "review";
  return undefined;
}

/** 能力档位展示项（与岗位角色解耦） */
interface SkillProfileItem {
  id: SkillProfileId;
  label: string;
  title?: string;
}

const SKILL_PROFILES_FALLBACK: SkillProfileItem[] = [
  { id: "full", label: "全域能力", title: "加载全部已装备技能（默认）" },
  { id: "office", label: "办公协作域", title: "文档处理、会议纪要、日常事务" },
];

// ============================================================
// 上下文统计显示 - 显示实际发送给 LLM 的报文组成
// ============================================================
interface ContextComponent {
  name: string;        // 组件名称
  tokens: number;      // Token 数量
  percentage: number;  // 占比
  details?: string;    // 详细说明
}

interface ContextStats {
  total_tokens: number;
  model_limit: number;
  components: ContextComponent[];
  timestamp: number;
  /** 来自事件时为估算值，来自 API 时为后端统计 */
  fromEstimate?: boolean;
}

const SLASH_COMMANDS = [
  { cmd: "/plan", desc: "切换 Plan 模式并生成计划" },
  { cmd: "/ask", desc: "切换 Ask 模式只读分析不修改文件" },
  { cmd: "/debug", desc: "切换 Debug 模式并排查问题" },
  { cmd: "/review", desc: "切换 Review 模式并执行评审" },
  { cmd: "/research", desc: "启动深度研究任务（可带主题）" },
  { cmd: "/plugins", desc: "查看当前已安装插件" },
  { cmd: "/install", desc: "安装插件：/install <plugin>" },
  { cmd: "/memory", desc: "查看或检索长期记忆" },
];

import { getPromptTemplates, type PromptTemplate as PromptTemplateType } from "../../lib/promptTemplates";

const COMPOSER_PLACEHOLDERS = [
  "描述你的目标或粘贴需求…",
  "向 AI 描述任务…",
  "粘贴代码，AI 帮你解析…",
  "输入问题，AI 实时搜索作答…",
  "描述需求，生成可执行计划…",
  "上传文件，深度分析内容…",
];

// 组件名称映射
const COMPONENT_NAMES: Record<string, string> = {
  'system_prompt': '系统提示词',
  'skills': 'Skills',
  'memory': '长期记忆',
  'history': '历史消息',
  'user_input': '用户输入',
  'attachments': '附件',
  'tools': '工具定义',
  'context': '上下文',
  'prompt_tokens': '输入 Token',
  'completion_tokens': '输出 Token',
};

// 颜色映射
const COMPONENT_COLORS: Record<string, string> = {
  'system_prompt': 'bg-slate-500',
  'skills': 'bg-violet-500',
  'memory': 'bg-purple-500',
  'history': 'bg-blue-500',
  'user_input': 'bg-emerald-500',
  'attachments': 'bg-amber-500',
  'tools': 'bg-cyan-500',
  'context': 'bg-teal-500',
  'prompt_tokens': 'bg-indigo-500',
  'completion_tokens': 'bg-sky-500',
};

function getModeShortcut(modeId: ChatMode, fourthMode?: ChatMode): string | undefined {
  if (modeId === "agent") return "⌘1";
  if (modeId === "ask") return "⌘2";
  if (modeId === "plan") return "⌘3";
  if (fourthMode && modeId === fourthMode) return "⌘4";
  return undefined;
}

const ContextStatsDisplay: FC<{
  contextItemsCount?: number;
  onRemoveHeavyContextItem?: () => void;
  /** 当前输入框未发送内容的 token 估算（本地 length/4），用于实时进度条 */
  liveInputTokens?: number;
}> = ({ contextItemsCount = 0, onRemoveHeavyContextItem, liveInputTokens = 0 }) => {
  const [stats, setStats] = useState<ContextStats | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchStatsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchAbortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => () => { isMountedRef.current = false; }, []);

  // 获取统计数据（每次请求前新建 AbortController，避免竞态）
  const fetchStats = useCallback(async () => {
    fetchAbortControllerRef.current?.abort();
    fetchAbortControllerRef.current = new AbortController();
    const controller = fetchAbortControllerRef.current;

    const apiUrl = getApiBase();
    const threadId = getCurrentThreadIdFromStorage();
    const validThreadId = validServerThreadIdOrUndefined(threadId);

    try {
      if (!isMountedRef.current) return;
      setLoading(true);
      const url = validThreadId
        ? `${apiUrl}/context/stats?thread_id=${encodeURIComponent(validThreadId)}`
        : `${apiUrl}/context/stats`;

      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return;
      if (!isMountedRef.current) return;

      const data = await response.json();
      if (data.success && data.stats) {
        const s = data.stats;
        const safeLimit = (s.limit > 0 ? s.limit : 1) as number;
        const componentsFromApi = Array.isArray(s.components)
          ? (s.components as Array<{ name: string; tokens: number; percentage?: number; details?: string }>)
              .filter((c) => (c.tokens ?? 0) > 0)
              .map((c) => ({
                name: c.name,
                tokens: c.tokens,
                percentage: c.percentage ?? (safeLimit > 0 ? (c.tokens / safeLimit) * 100 : 0),
                details: c.details,
              }))
          : null;
        if (!isMountedRef.current) return;
        setStats({
          total_tokens: s.total_tokens,
          model_limit: s.limit,
          fromEstimate: false,
          components: componentsFromApi ?? [
            { name: 'system_prompt', tokens: s.system_tokens, percentage: (s.system_tokens / safeLimit) * 100 },
            { name: 'history', tokens: s.history_tokens, percentage: (s.history_tokens / safeLimit) * 100 },
            { name: 'context', tokens: s.context_tokens, percentage: (s.context_tokens / safeLimit) * 100 },
            { name: 'memory', tokens: s.memory_tokens, percentage: (s.memory_tokens / safeLimit) * 100 },
            { name: 'tools', tokens: s.tool_tokens || 0, percentage: ((s.tool_tokens || 0) / safeLimit) * 100 },
          ].filter(c => c.tokens > 0),
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      console.debug('[ContextStats] 获取统计失败:', error);
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    return () => {
      fetchAbortControllerRef.current?.abort();
      fetchAbortControllerRef.current = null;
    };
  }, []);

  // 监听后端/流式返回的上下文统计（流式为估算，API 拉取为当前对话）
  useEffect(() => {
    const handleStats = (e: CustomEvent<ContextStats | Record<string, unknown>>) => {
      if (!isMountedRef.current) return;
      const d = e.detail as Record<string, unknown>;
      const rawLimit = (d.model_limit as number) ?? (d.limit as number) ?? 32768;
      const safeLimit = rawLimit > 0 ? rawLimit : 1;
      const components = Array.isArray(d.components)
        ? (d.components as Array<{ name: string; tokens: number; percentage?: number; details?: string }>)
            .filter((c) => (c.tokens ?? 0) > 0)
            .map((c) => ({
              name: c.name,
              tokens: c.tokens,
              percentage: c.percentage ?? (c.tokens / safeLimit) * 100,
              details: c.details,
            }))
        : [];
      setStats({
        total_tokens: (d.total_tokens as number) ?? 0,
        model_limit: rawLimit,
        fromEstimate: d.fromEstimate === false ? false : true,
        components,
        timestamp: (d.timestamp as number) ?? Date.now(),
      });
    };
    window.addEventListener(EVENTS.CONTEXT_STATS, handleStats as EventListener);
    return () => window.removeEventListener(EVENTS.CONTEXT_STATS, handleStats as EventListener);
  }, []);
  
  // 消息发送后刷新统计（持有时器 id，卸载时 clearTimeout 避免卸载后仍执行 setState）
  useEffect(() => {
    const handleMessageSent = () => {
      if (fetchStatsTimerRef.current != null) clearTimeout(fetchStatsTimerRef.current);
      fetchStatsTimerRef.current = setTimeout(fetchStats, 1000);
    };

    window.addEventListener(EVENTS.MESSAGE_SENT, handleMessageSent);
    return () => {
      window.removeEventListener(EVENTS.MESSAGE_SENT, handleMessageSent);
      if (fetchStatsTimerRef.current != null) {
        clearTimeout(fetchStatsTimerRef.current);
        fetchStatsTimerRef.current = null;
      }
    };
  }, [fetchStats]);

  const derived = useMemo(() => {
    if (!stats) {
      return { safeLimit: 1, totalWithLive: 0, percentage: 0, isWarning: false, isCritical: false, componentsWithLive: [] as ContextComponent[], heaviestComponent: null as ContextComponent | null };
    }
    const safeLimit = stats.model_limit > 0 ? stats.model_limit : 1;
    const totalWithLive = stats.total_tokens + liveInputTokens;
    const percentage = Math.min((totalWithLive / safeLimit) * 100, 100);
    const isWarning = percentage > 75;
    const isCritical = percentage > 90;
    let componentsWithLive: ContextComponent[];
    if (liveInputTokens <= 0) {
      componentsWithLive = stats.components;
    } else {
      const hasUserInput = stats.components.some((c) => c.name === "user_input");
      if (hasUserInput) {
        componentsWithLive = stats.components.map((c) =>
          c.name === "user_input"
            ? { ...c, tokens: c.tokens + liveInputTokens, percentage: ((c.tokens + liveInputTokens) / safeLimit) * 100 }
            : c
        );
      } else {
        componentsWithLive = [
          ...stats.components,
          { name: "user_input", tokens: liveInputTokens, percentage: (liveInputTokens / safeLimit) * 100, details: "当前输入（估算）" },
        ];
      }
    }
    const heaviestComponent = componentsWithLive.reduce<ContextComponent | null>((acc, item) => {
      if (!acc) return item;
      return item.tokens > acc.tokens ? item : acc;
    }, null);
    return { safeLimit, totalWithLive, percentage, isWarning, isCritical, componentsWithLive, heaviestComponent };
  }, [stats, liveInputTokens]);

  // 无上下文且无统计数据时不占位
  if (contextItemsCount === 0 && !stats && !loading) return null;
  // 没有统计数据时显示占位，点击可刷新
  if (!stats) {
    return (
      <button 
        onClick={fetchStats}
        disabled={loading}
        className="h-8 min-h-8 px-2 text-[10px] font-mono text-muted-foreground/50 hover:text-muted-foreground rounded-md hover:bg-muted/50 transition-colors flex items-center" 
        title={t("composer.contextStatsTitle")}
      >
        {loading ? "..." : "ctx: --"}
      </button>
    );
  }

  const { safeLimit, totalWithLive, percentage, isWarning, isCritical, componentsWithLive, heaviestComponent } = derived;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "h-8 min-h-8 px-2 text-[10px] font-mono rounded-md hover:bg-muted/50 transition-colors flex items-center gap-1 relative overflow-hidden min-w-0 max-w-24",
            isCritical ? "text-red-500" : isWarning ? "text-amber-500" : "text-muted-foreground"
          )}
          title={`上下文使用: ${percentage.toFixed(0)}% (${totalWithLive.toLocaleString()}/${stats.model_limit.toLocaleString()})${liveInputTokens > 0 ? " · 含输入估算" : ""}`}
        >
          {/* 背景进度条 */}
          <div 
            className={cn(
              "absolute inset-0 opacity-20 transition-all",
              isCritical ? "bg-red-500" : isWarning ? "bg-amber-500" : "bg-muted-foreground"
            )}
            style={{ width: `${percentage}%` }}
          />
          {/* 文字内容：使用量 / 模型上限（如 12k/128K）使上下文窗口信息可见 */}
          <span className="relative z-10 truncate">
            {percentage.toFixed(0)}% · {(stats.total_tokens / 1000).toFixed(1)}k/{(stats.model_limit / 1000).toFixed(0)}K
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" side="top" align="end">
        <div className="p-3 border-b">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-foreground">
              上下文组成{stats.fromEstimate ? "（估算）" : "（当前对话）"}
            </span>
            <span className={cn(
              "text-xs font-mono",
              isCritical ? "text-red-500" : isWarning ? "text-amber-500" : "text-muted-foreground"
            )}>
              {percentage.toFixed(0)}%
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            总用量含历史消息与系统提示；本栏「N 个上下文」仅指本次添加的附件。
          </p>
        </div>
        
        {/* 进度条 - 分段显示各组件 */}
        <div className="px-3 py-2">
          <div className="h-3 bg-muted rounded overflow-hidden flex">
            {componentsWithLive.map((comp, i) => (
              <div
                key={i}
                className={cn("h-full transition-all", COMPONENT_COLORS[comp.name] || 'bg-gray-500')}
                style={{ width: `${comp.percentage}%` }}
                title={`${COMPONENT_NAMES[comp.name] || comp.name}: ${comp.tokens.toLocaleString()} (${comp.percentage.toFixed(1)}%)`}
              />
            ))}
          </div>
        </div>
        
        {/* 详细列表 */}
        <div className="px-3 pb-3 space-y-1">
          {componentsWithLive.map((comp, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <div className={cn("w-2.5 h-2.5 rounded-sm shrink-0", COMPONENT_COLORS[comp.name] || 'bg-gray-500')} />
              <span className="text-muted-foreground flex-1 truncate" title={comp.details}>
                {COMPONENT_NAMES[comp.name] || comp.name}
              </span>
              <span className="font-mono text-foreground shrink-0 tabular-nums">
                {comp.tokens.toLocaleString()}
              </span>
              <span className="text-muted-foreground/60 w-10 text-right tabular-nums">
                {comp.percentage.toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
        
        {/* 分隔线 + 总计 */}
        <div className="px-3 py-2 border-t bg-muted/30 flex justify-between text-xs">
          <span className="text-muted-foreground">总计 / 模型上限</span>
          <span className="font-mono font-medium">
            {totalWithLive.toLocaleString()} / {stats.model_limit.toLocaleString()}
            {liveInputTokens > 0 && <span className="text-muted-foreground/70">（含输入）</span>}
          </span>
        </div>
        {heaviestComponent && (
          <div className="px-3 py-2 border-t text-[11px] text-muted-foreground flex items-center justify-between gap-2">
            <span className="truncate">
              最高占用：{COMPONENT_NAMES[heaviestComponent.name] || heaviestComponent.name}（{heaviestComponent.tokens.toLocaleString()}）
            </span>
            {contextItemsCount > 0 && onRemoveHeavyContextItem ? (
              <button
                type="button"
                onClick={onRemoveHeavyContextItem}
                className="h-6 px-2 rounded border border-border/50 hover:bg-muted/60 text-[11px] shrink-0"
              >
                移除一个高成本项
              </button>
            ) : null}
          </div>
        )}
        
        {/* 时间 */}
        <div className="px-3 py-1.5 border-t text-[11px] text-muted-foreground/50">
          更新于 {new Date(stats.timestamp).toLocaleTimeString()}
        </div>
      </PopoverContent>
    </Popover>
  );
};

// ============================================================
// 错误提示组件
// ============================================================

interface BackendError {
  error: string;
  message: string;
  timestamp: number;
  request_id?: string;
}

const ErrorToast: FC = () => {
  const [error, setError] = useState<BackendError | null>(null);
  const [visible, setVisible] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  useEffect(() => {
    const handleError = (e: CustomEvent<BackendError>) => {
      if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) console.log('[ErrorToast] 收到错误:', e.detail);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      setError(e.detail);
      setVisible(true);
      hideTimerRef.current = setTimeout(() => setVisible(false), 5000);
    };
    
    window.addEventListener(EVENTS.BACKEND_ERROR, handleError as EventListener);
    return () => {
      window.removeEventListener(EVENTS.BACKEND_ERROR, handleError as EventListener);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);
  
  if (!visible || !error) return null;

  const msg = (error.error + " " + error.message).toLowerCase();
  const recoveryHint =
    msg.includes("network") || msg.includes("fetch") || msg.includes("连接") || msg.includes("econnrefused")
      ? t("composer.checkBackendConnection")
      : msg.includes("401") || msg.includes("403") || msg.includes("api key") || msg.includes("权限")
        ? t("composer.checkApiKey")
        : msg.includes("timeout") || msg.includes("超时")
          ? t("composer.hintTimeout")
          : t("composer.hintRetryAsk");

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 px-3" role="alert" aria-live="assertive">
      <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 flex items-start gap-2">
        <div className="text-red-500 mt-0.5" aria-hidden>
          <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-red-500">{error.error}</div>
          <div className="text-xs text-red-400/80 truncate">{error.message}</div>
          <div className="text-[11px] text-muted-foreground mt-1">{recoveryHint}</div>
        </div>
        <button
          type="button"
          onClick={() => setVisible(false)}
          className="text-red-400 hover:text-red-300 p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
          aria-label={t("common.close")}
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
};

// ============================================================
// 上下文项组件
// ============================================================

interface ContextItemChipProps {
  item: ContextItem;
  onRemove: () => void;
}

// 格式化文件大小
const formatFileSize = (bytes?: number): string => {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};

const _CONTEXT_ITEM_STYLE: Record<string, { color: string; bg: string }> = {
  file: { color: "text-blue-500", bg: "bg-blue-500/10" },
  folder: { color: "text-amber-500", bg: "bg-amber-500/10" },
  code: { color: "text-emerald-500", bg: "bg-emerald-500/10" },
  url: { color: "text-purple-500", bg: "bg-purple-500/10" },
  image: { color: "text-pink-500", bg: "bg-pink-500/10" },
};
const _CONTEXT_ITEM_ICONS: Record<string, React.ReactElement> = {
  file: <FileIcon className="size-3" />,
  folder: <FolderIcon className="size-3" />,
  code: <CodeIcon className="size-3" />,
  url: <LinkIcon className="size-3" />,
  image: <ImageIcon className="size-3" />,
};

const ContextItemChip: FC<ContextItemChipProps> = ({ item, onRemove }) => {
  const { color, bg } = _CONTEXT_ITEM_STYLE[item.type] ?? _CONTEXT_ITEM_STYLE.file;
  const icon = _CONTEXT_ITEM_ICONS[item.type] ?? _CONTEXT_ITEM_ICONS.file;
  const isUploading = item.status === "uploading";
  const isError = item.status === "error";
  
  const path = (item as { path?: string }).path;
  const tooltipTitle = path ?? item.name;
  return (
    <div
      title={tooltipTitle}
      className={cn(
      "relative flex items-center gap-1.5 h-6 px-2 rounded-md text-xs group border border-transparent hover:border-border/50 overflow-hidden shrink-0",
      bg,
      isError && "border-destructive/50 bg-destructive/10"
    )}>
      {/* 上传进度条 */}
      {isUploading && item.progress !== undefined && (
        <div 
          className="absolute inset-0 bg-primary/20 transition-all duration-200"
          style={{ width: `${item.progress}%` }}
        />
      )}
      
      <span className={cn(color, "relative z-10", isUploading && "animate-pulse")}>
        {icon}
      </span>
      <span className={cn(
        "max-w-32 truncate relative z-10",
        isError ? "text-destructive" : "text-foreground/80"
      )}>
        {item.name}
        {isUploading && item.progress !== undefined && ` (${item.progress}%)`}
        {isError && " (失败)"}
      </span>
      {item.size && !isUploading && !isError && (
        <span className="text-muted-foreground/60 relative z-10">
          {formatFileSize(item.size)}
        </span>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive ml-0.5 relative z-10"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
};

// ============================================================
// 主组件：Cursor 风格 Composer（占位符/发送停止/附件/选择器与 Cursor 对齐，见 docs/cursor_alignment_checklist.md）
// ============================================================

interface CursorStyleComposerProps {
  onModeChange?: (mode: ChatMode) => void;
  onContextChange?: (context: ContextItem[]) => void;
  onWebSearchToggle?: (enabled: boolean) => void;
  connectionHealthy?: boolean;
  /** 是否正在发送/流式响应中，为 true 时禁用发送并显示「发送中…」 */
  isStreaming?: boolean;
  /** 排队消息数量（运行中再次发送时入队，用于状态栏展示） */
  queueLength?: number;
  /** 运行中用户点击发送时入队，不取消当前 run */
  onEnqueue?: (content: string) => void;
  /** 是否嵌入统一外框内（与 Todo/运行状态捏合），为 true 时快捷条/URL/KB/输入区使用精简边框与内边距 */
  nestedInCard?: boolean;
}

const CursorStyleComposerInner: FC<CursorStyleComposerProps> = ({
  onModeChange,
  onContextChange,
  onWebSearchToggle,
  connectionHealthy = true,
  isStreaming = false,
  queueLength = 0,
  onEnqueue,
  nestedInCard = false,
}) => {
  const { cancelRun } = React.useContext(CancelContext);
  const openFilesFromContext = React.useContext(OpenFilesContext);
  const { chatMode: mode, setMode: setSessionMode, roleId: activeRoleId, setRole: setSessionRole } = useSessionContext();

  const [rolesList, setRolesList] = useState<RoleItem[]>(ROLES_FALLBACK);
  const [rolesLoading, setRolesLoading] = useState(true);
  const [skillProfileItems, setSkillProfileItems] = useState<SkillProfileItem[]>(SKILL_PROFILES_FALLBACK);
  const [skillProfilesLoading, setSkillProfilesLoading] = useState(true);
  const [contextItems, setContextItems] = useState<ContextItem[]>([]);
  const uploadingContextCount = useMemo(
    () => contextItems.filter((item) => item.status === "uploading").length,
    [contextItems]
  );
  const failedContextCount = useMemo(
    () => contextItems.filter((item) => item.status === "error").length,
    [contextItems]
  );
  const hasUploadingContext = uploadingContextCount > 0;
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [researchMode, setResearchMode] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState(false);
  const [availablePlugins, setAvailablePlugins] = useState<Array<{ name: string; loaded?: boolean }>>([]);
  const [pluginSlashCommands, setPluginSlashCommands] = useState<Array<{ cmd: string; desc: string; plugin?: string; commandKey?: string; conflict?: boolean; plugins?: string[] }>>([]);
  const [sessionPlugins, setSessionPlugins] = useState<string[]>([]);
  const [skillProfile, setSkillProfile] = useState<SkillProfileId>("full");
  const [promptTemplates, setPromptTemplates] = useState<PromptTemplateType[]>(() => getPromptTemplates());
  const [, setComposerPrefsVersion] = useState(0);
  useEffect(() => {
    const h = () => {
      setComposerPrefsVersion((v) => v + 1);
      setPromptTemplates(getPromptTemplates());
    };
    window.addEventListener(EVENTS.COMPOSER_PREFS_CHANGED, h);
    return () => window.removeEventListener(EVENTS.COMPOSER_PREFS_CHANGED, h);
  }, []);
  const [editorSelection, setEditorSelection] = useState<{
    selectedText: string;
    selectionRange: { startLine: number; endLine: number } | null;
    filePath?: string;
    fileName?: string;
  } | null>(null);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      setResearchMode(getStorageItem("maibot_research_mode") === "true");
      setSessionPlugins(getScopedSessionPlugins());
      const savedWebSearch = getStorageItem("maibot_web_search");
      if (savedWebSearch) setWebSearchEnabled(savedWebSearch === "true");
      const saved = getStorageItem("maibot_skill_profile");
      const normalized = normalizeSkillProfileId(saved);
      if (saved && normalized !== saved) setStorageItem("maibot_skill_profile", normalized);
      setSkillProfile(normalized);
    } catch {
      // safeStorage 不可用（如 SSR）
    }
  }, []);
  const activeRole = useMemo(
    () => rolesList.find((r) => r.id === activeRoleId),
    [rolesList, activeRoleId]
  );
  const availableModes = useMemo(
    () => normalizeRoleModes(activeRole?.modes, activeRole?.id, activeRole?.preferred_fourth_mode),
    [activeRole?.id, activeRole?.modes, activeRole?.preferred_fourth_mode]
  );
  const menuModes = useMemo(
    () => CHAT_MODES.filter((m) => availableModes.includes(m.id)),
    [availableModes]
  );
  const fourthMode = useMemo(
    () => resolvePreferredFourthMode(availableModes),
    [availableModes]
  );
  const fourthModeLabel = useMemo(
    () => (fourthMode ? (CHAT_MODES.find((m) => m.id === fourthMode)?.label ?? fourthMode) : t("composer.noMode")),
    [fourthMode, t]
  );
  const roleModeHint = useMemo(() => {
    if (rolesLoading) return t("composer.rolesLoading");
    const roleName = activeRole?.label || activeRoleId || t("composer.currentRole");
    return t("composer.roleFourthModeHint", { roleName, fourthModeLabel });
  }, [activeRole?.label, activeRoleId, fourthModeLabel, rolesLoading, t]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const composerRootRef = useRef<HTMLDivElement>(null);
  const composerInputAreaRef = useRef<HTMLDivElement>(null);
  const [dropdownAnchorRect, setDropdownAnchorRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  const contextItemsRef = useRef<ContextItem[]>([]);
  const contextItemsDispatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftBeforeHistoryRef = useRef<string>("");
  const composerInitErrorShownRef = useRef(false);
  const pluginConflictHintShownRef = useRef(false);
  contextItemsRef.current = contextItems;

  // 批量上传时合并派发 CONTEXT_ITEMS_CHANGED，减少下游处理频率（保留逐文件 setContextItems 以维持进度展示）
  const scheduleContextItemsDispatch = useCallback((items: ContextItem[]) => {
    if (contextItemsDispatchTimerRef.current) clearTimeout(contextItemsDispatchTimerRef.current);
    contextItemsDispatchTimerRef.current = setTimeout(() => {
      contextItemsDispatchTimerRef.current = null;
      window.dispatchEvent(new CustomEvent(EVENTS.CONTEXT_ITEMS_CHANGED, { detail: { contextItems: items } }));
    }, 200);
  }, []);

  useEffect(() => {
    onContextChange?.(contextItems);
  }, [contextItems, onContextChange]);

  // 卸载时释放所有图片 blob URL、清除派发定时器，避免内存泄漏
  useEffect(() => {
    return () => {
      if (contextItemsDispatchTimerRef.current) {
        clearTimeout(contextItemsDispatchTimerRef.current);
        contextItemsDispatchTimerRef.current = null;
      }
      contextItemsRef.current.forEach(item => {
        if (item.type === "image" && item.preview?.startsWith("blob:")) {
          URL.revokeObjectURL(item.preview);
        }
      });
    };
  }, []);

  // 顶部轻提示：模式/角色切换时给出短反馈
  const [transientHint, setTransientHint] = useState<string | null>(null);
  const showTransientHint = useCallback((message: string) => {
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    setTransientHint(message);
    hintTimerRef.current = setTimeout(() => {
      setTransientHint(null);
      hintTimerRef.current = null;
    }, 1800);
  }, []);
  useEffect(() => () => {
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
  }, []);
  
  // 模式切换（通过 SessionContext 写 storage 并派发事件）
  const handleModeChange = useCallback((newMode: ChatMode) => {
    if (!availableModes.includes(newMode)) {
      const roleName = activeRole?.label || activeRoleId || t("composer.currentRole");
      toast.info(`${roleName} 当前不可切换到 ${newMode.toUpperCase()} 模式`);
      return;
    }
    setSessionMode(newMode);
    onModeChange?.(newMode);
    const nextStep = NEXT_STEP_BY_MODE[newMode];
    showTransientHint(nextStep ? `${_MODE_LABELS[newMode]}\n建议下一步：${nextStep}` : _MODE_LABELS[newMode]);
  }, [availableModes, activeRole?.label, activeRoleId, onModeChange, setSessionMode, showTransientHint]);

  // 会话创建时若事件带 mode/role 则写入当前会话（SessionContext 会从 storage 同步）
  useEffect(() => {
    const handler = (e: CustomEvent<{ threadId?: string; roleId?: string; mode?: ChatMode }>) => {
      const threadId = String(e.detail?.threadId || "").trim();
      const currentThreadId = getCurrentThreadIdFromStorage();
      if (!threadId || !currentThreadId || threadId !== currentThreadId) return;
      const modeFromEvent = e.detail?.mode;
      if (modeFromEvent && VALID_CHAT_MODES.includes(modeFromEvent)) {
        setSessionMode(modeFromEvent);
      }
      const roleFromEvent = normalizeRoleId(String(e.detail?.roleId || "").trim());
      if (roleFromEvent) {
        setSessionRole(roleFromEvent);
      }
    };
    window.addEventListener(EVENTS.SESSION_CREATED, handler as EventListener);
    return () => window.removeEventListener(EVENTS.SESSION_CREATED, handler as EventListener);
  }, [setSessionMode, setSessionRole]);

  // 领域（技能档案）切换
  const handleSkillProfileChange = useCallback((profileId: SkillProfileId) => {
    setSkillProfile(profileId);
    setStorageItem("maibot_skill_profile", profileId);
    window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
    window.dispatchEvent(new CustomEvent(EVENTS.SKILL_PROFILE_CHANGED, { detail: { profileId } }));
  }, []);

  // 联网搜索切换（写 localStorage 后派发事件，供同 tab 内实时同步）
  const handleWebSearchToggle = useCallback(() => {
    const newValue = !webSearchEnabled;
    setWebSearchEnabled(newValue);
    onWebSearchToggle?.(newValue);
    setStorageItem("maibot_web_search", String(newValue));
    window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
    window.dispatchEvent(new CustomEvent(EVENTS.WEB_SEARCH_CHANGED, { detail: { enabled: newValue } }));
  }, [webSearchEnabled, onWebSearchToggle]);

  // Globe 三态循环：关闭 → 联网搜索 → 深度研究 → 关闭
  const handleGlobeClick = useCallback(() => {
    if (researchMode) {
      setResearchMode(false);
      setWebSearchEnabled(false);
      setStorageItem("maibot_research_mode", "false");
      setStorageItem("maibot_task_type", "");
      setStorageItem("maibot_web_search", "false");
    } else if (webSearchEnabled) {
      setResearchMode(true);
      setStorageItem("maibot_research_mode", "true");
      setStorageItem("maibot_task_type", "deep_research");
      setStorageItem("maibot_web_search", "true");
      window.dispatchEvent(new CustomEvent(EVENTS.WEB_SEARCH_CHANGED, { detail: { enabled: true } }));
    } else {
      setWebSearchEnabled(true);
      onWebSearchToggle?.(true);
      setStorageItem("maibot_web_search", "true");
      window.dispatchEvent(new CustomEvent(EVENTS.WEB_SEARCH_CHANGED, { detail: { enabled: true } }));
    }
    window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
  }, [researchMode, webSearchEnabled, onWebSearchToggle]);

  const toggleResearchMode = useCallback(() => {
    setResearchMode((prev) => !prev);
  }, []);

  const researchModeSyncRef = useRef(false);
  useEffect(() => {
    if (!researchModeSyncRef.current) {
      researchModeSyncRef.current = true;
      return;
    }
    setStorageItem("maibot_research_mode", String(researchMode));
    setStorageItem("maibot_task_type", researchMode ? "deep_research" : "");
    if (researchMode) {
      setStorageItem("maibot_web_search", "true");
      setWebSearchEnabled(true);
      onWebSearchToggle?.(true);
      window.dispatchEvent(new CustomEvent(EVENTS.WEB_SEARCH_CHANGED, { detail: { enabled: true } }));
    } else {
      setStorageItem("maibot_web_search", "false");
      setWebSearchEnabled(false);
      onWebSearchToggle?.(false);
      window.dispatchEvent(new CustomEvent(EVENTS.WEB_SEARCH_CHANGED, { detail: { enabled: false } }));
    }
    window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
  }, [researchMode, onWebSearchToggle]);

  const toggleSessionPlugin = useCallback((pluginName: string) => {
    const name = String(pluginName || "").trim();
    if (!name) return;
    const threadId = getCurrentThreadIdFromStorage();
    if (!threadId) return;
    const storageKey = getThreadSessionPluginsStorageKey(threadId);
    setSessionPlugins((prev) => {
      const next = prev.includes(name) ? prev.filter((p) => p !== name) : [...prev, name];
      setStorageItem(storageKey, JSON.stringify(next));
      window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
      return next;
    });
  }, []);
  
  // 添加上下文项；onContextChange 由 useEffect([contextItems]) 统一触发
  const addContextItem = useCallback((item: ContextItem) => {
    setContextItems(prev => {
      const exists = prev.some(p => p.id === item.id);
      if (exists) return prev;
      return [...prev, item];
    });
  }, []);
  
  // 移除上下文项（图片预览为 blob URL 时释放，避免内存泄漏）
  const removeContextItem = useCallback((id: string) => {
    setContextItems(prev => {
      const removed = prev.find(item => item.id === id);
      if (removed?.type === "image" && removed.preview?.startsWith("blob:")) {
        URL.revokeObjectURL(removed.preview);
      }
      return prev.filter(item => item.id !== id);
    });
  }, []);

  const clearFailedContextItems = useCallback(() => {
    setContextItems((prev) => prev.filter((item) => item.status !== "error"));
  }, []);

  const removeHeavyContextItem = useCallback(() => {
    let targetName = "";
    setContextItems((prev) => {
      if (prev.length === 0) return prev;
      const scoreOf = (item: ContextItem) => {
        const nameScore = item.name?.length || 0;
        const contentScore = item.content?.length || 0;
        const sizeScore = item.size || 0;
        return sizeScore * 2 + contentScore + nameScore * 8;
      };
      let target = prev[0];
      for (const item of prev) {
        if (scoreOf(item) > scoreOf(target)) target = item;
      }
      targetName = target.name ?? "";
      const next = prev.filter((item) => item.id !== target.id);
      if (target.type === "image" && target.preview?.startsWith("blob:")) {
        URL.revokeObjectURL(target.preview);
      }
      toast.success(`已移除高成本上下文：${targetName}`);
      return next;
    });
  }, []);

  // 单点上传实现：文件/图片选择与拖拽共用，鉴权与 unifiedFileService 一致（getInternalAuthHeaders）
  const uploadFile = useCallback(async (file: File, itemId: string) => {
    const baseUrl = getApiBase();
    const uploadUrl = `${String(baseUrl).replace(/\/$/, "")}/files/upload`;
    return new Promise<{ path: string; filename: string; size: number }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const progress = Math.round((event.loaded / event.total) * 100);
          setContextItems(prev =>
            prev.map(item => (item.id === itemId ? { ...item, progress } : item))
          );
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const raw = JSON.parse(xhr.responseText);
            if (raw && raw.ok === false) {
              reject(new Error(raw.detail || raw.error || "上传失败"));
              return;
            }
            const path = raw.path ?? raw.data?.path ?? "";
            const filename = raw.filename ?? raw.name ?? raw.data?.filename ?? file.name;
            const size = raw.size ?? raw.data?.size ?? file.size;
            if (!path) {
              reject(new Error("服务器未返回文件路径"));
              return;
            }
            resolve({ path, filename, size });
          } catch {
            reject(new Error(t("composer.responseParseFailed") || "响应解析失败"));
          }
        } else {
          console.error("[Composer] 上传失败:", xhr.status, uploadUrl, xhr.responseText);
          reject(new Error(`上传失败: ${xhr.status}，请确认后端已启动且地址为 ${baseUrl}`));
        }
      };
      xhr.onerror = () => reject(new Error("网络错误"));
      xhr.ontimeout = () => reject(new Error(t("composer.uploadTimeout")));
      xhr.open("POST", uploadUrl);
      xhr.timeout = 300000;
      const authHeaders = getInternalAuthHeaders();
      Object.entries(authHeaders).forEach(([k, v]) => {
        if (v) xhr.setRequestHeader(k, v);
      });
      const formData = new FormData();
      formData.append("file", file);
      const wp = getCurrentWorkspacePathFromStorage();
      if (wp?.trim()) formData.append("workspace_path", wp.trim());
      xhr.send(formData);
    });
  }, []);

  // 处理文件选择 - 上传到服务器并获取路径（复用 uploadFile，与拖拽/图片上传一致）
  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    const fileList = Array.from(files);
    const now = Date.now();
    const initialItems: ContextItem[] = fileList.map((file, i) => ({
      id: `file-${now}-${i}-${Math.random().toString(36).slice(2)}`,
      type: "file",
      name: file.name,
      path: "",
      status: "uploading" as const,
      progress: 0,
      size: file.size,
    }));
    setContextItems(prev => [...prev, ...initialItems]);

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const itemId = initialItems[i].id;
      try {
        const result = await uploadFile(file, itemId);
        if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) console.log('[Composer] 文件上传成功:', result);
        setContextItems(prev => {
          const newItems = prev.map(item =>
            item.id === itemId ? { ...item, path: result.path, status: "success" as const, progress: 100 } : item
          );
          scheduleContextItemsDispatch(newItems);
          return newItems;
        });
      } catch (error) {
        console.error('[Composer] ❌ 文件上传失败:', error);
        toast.error(t("composer.uploadFileError"));
        setContextItems(prev => {
          const newItems = prev.map(item =>
            item.id === itemId ? { ...item, status: "error" as const, progress: 0 } : item
          );
          scheduleContextItemsDispatch(newItems);
          return newItems;
        });
      }
    }
    e.target.value = "";
  }, [uploadFile, scheduleContextItemsDispatch]);

  // 上传图片到后端并更新 context（供 handleImageSelect / handlePaste 复用）
  const uploadImageFiles = useCallback(
    async (imageFiles: File[]) => {
      if (imageFiles.length === 0) return;
      const now = Date.now();
      const initialItems: ContextItem[] = imageFiles.map((file, i) => ({
        id: `image-${now}-${i}-${Math.random().toString(36).slice(2)}`,
        type: "image" as const,
        name: file.name,
        preview: URL.createObjectURL(file),
        status: "uploading" as const,
        progress: 0,
        size: file.size,
      }));
      setContextItems((prev) => [...prev, ...initialItems]);

      for (let i = 0; i < imageFiles.length; i++) {
        const file = imageFiles[i];
        const itemId = initialItems[i].id;
        const previewUrl = initialItems[i].preview;

        if (file.size > MAX_PASTE_IMAGE_BYTES) {
          toast.warning(t("composer.imageTooLarge"), {
            description: `不能超过 ${(MAX_PASTE_IMAGE_BYTES / 1024 / 1024).toFixed(0)}MB`,
          });
          if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
          setContextItems((prev) =>
            prev.map((item) =>
              item.id === itemId ? { ...item, status: "error" as const, progress: 0 } : item
            )
          );
          continue;
        }

        try {
          const result = await uploadFile(file, itemId);
          setContextItems((prev) => {
            const newItems = prev.map((item) =>
              item.id === itemId
                ? { ...item, path: result.path, status: "success" as const, progress: 100 }
                : item
            );
            scheduleContextItemsDispatch(newItems);
            return newItems;
          });
        } catch (error) {
          if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
          toast.error(t("composer.uploadImageError"));
          setContextItems((prev) => {
            const newItems = prev.map((item) =>
              item.id === itemId ? { ...item, status: "error" as const, progress: 0 } : item
            );
            scheduleContextItemsDispatch(newItems);
            return newItems;
          });
        }
      }
    },
    [uploadFile, scheduleContextItemsDispatch]
  );

  const handleImageSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) return;
      const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (imageFiles.length === 0) {
        e.target.value = "";
        return;
      }
      await uploadImageFiles(imageFiles);
      e.target.value = "";
    },
    [uploadImageFiles]
  );

  // 处理粘贴图片：复用与 handleImageSelect 相同的上传逻辑
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData.items;
      const pastedText = e.clipboardData.getData("text/plain") || "";
      if (pastedText.length > MAX_PASTE_TEXT_CHARS) {
        e.preventDefault();
        toast.warning(t("composer.pasteTooLarge"), {
          description: `文本长度超过 ${MAX_PASTE_TEXT_CHARS.toLocaleString()} 字符，请改为文件附件或分段粘贴`,
        });
        return;
      }

      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            if (file.size > MAX_PASTE_IMAGE_BYTES) {
              e.preventDefault();
              toast.warning(t("composer.imageTooLarge"), {
                description: `单张粘贴图片不能超过 ${formatFileSize(MAX_PASTE_IMAGE_BYTES)}（当前 ${formatFileSize(file.size)}）`,
              });
              continue;
            }
            imageFiles.push(file);
          }
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        uploadImageFiles(imageFiles);
      }
    },
    [uploadImageFiles]
  );
  
  // 打开文件选择器
  const openFileSelector = useCallback(() => {
    fileInputRef.current?.click();
  }, []);
  
  // 打开图片选择器
  const openImageSelector = useCallback(() => {
    imageInputRef.current?.click();
  }, []);

  // 添加文件夹
  const handleAddFolder = useCallback(() => {
    // 触发文件夹选择事件，由文件树组件响应
    window.dispatchEvent(new CustomEvent(EVENTS.OPEN_FOLDER_PICKER, {
      detail: {
        callback: (folderPath: string, folderName: string) => {
          addContextItem({
            id: `folder-${Date.now()}`,
            type: "folder",
            name: folderName,
            path: folderPath,
          });
        }
      }
    }));
  }, [addContextItem]);

  // 从工作区选择文件（当前已打开的文件），作为附件加入 Composer
  const handleAddWorkspaceFile = useCallback(() => {
    window.dispatchEvent(new CustomEvent(EVENTS.OPEN_WORKSPACE_FILE_PICKER, {
      detail: {
        callback: (filePath: string, fileName: string) => {
          addContextItem({
            id: `file-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            type: "file",
            name: fileName,
            path: filePath,
          });
        }
      }
    }));
  }, [addContextItem]);

  // 从工作区浏览文件（树形选择，可不先打开文件）
  const handleAddWorkspaceFileFromTree = useCallback(() => {
    window.dispatchEvent(new CustomEvent(EVENTS.OPEN_WORKSPACE_TREE_PICKER, {
      detail: {
        callback: (filePath: string, fileName: string) => {
          addContextItem({
            id: `file-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            type: "file",
            name: fileName,
            path: filePath,
          });
          toast.success(t("composer.addedFileToContext"), { description: fileName });
        }
      }
    }));
  }, [addContextItem]);
  
  // 添加代码片段
  const handleAddCode = useCallback(() => {
    // 触发获取编辑器选中代码事件
    window.dispatchEvent(new CustomEvent(EVENTS.GET_SELECTED_CODE, {
      detail: {
        callback: (code: string, filePath: string, lineRange: string) => {
          if (code) {
            addContextItem({
              id: `code-${Date.now()}`,
              type: "code",
              name: `${filePath.split('/').pop() || t("composer.codeSnippet")}:${lineRange}`,
              path: filePath,
              content: code,
            });
          }
        }
      }
    }));
  }, [addContextItem]);
  
  // URL 输入状态
  const [urlInputVisible, setUrlInputVisible] = useState(false);
  const [urlInputValue, setUrlInputValue] = useState("");
  const [urlInputError, setUrlInputError] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const urlErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 知识库快捷引用（可选：选一条或路径作为 context_items）
  const [kbRefVisible, setKbRefVisible] = useState(false);
  const [kbRefPathValue, setKbRefPathValue] = useState("");
  const kbRefInputRef = useRef<HTMLInputElement>(null);
  
  // 添加 URL
  const handleAddUrl = useCallback(() => {
    setUrlInputVisible(true);
    setUrlInputValue("");
    setUrlInputError(null);
    // 延迟聚焦，等待 DOM 更新
    setTimeout(() => urlInputRef.current?.focus(), 50);
  }, []);
  
  // 确认添加 URL
  const confirmAddUrl = useCallback(() => {
    const url = urlInputValue.trim();
    if (!url) {
      setUrlInputVisible(false);
      return;
    }
    
    try {
      const urlWithProtocol = url.startsWith('http') ? url : `https://${url}`;
      const urlObj = new URL(urlWithProtocol);
      addContextItem({
        id: `url-${Date.now()}`,
        type: "url",
        name: urlObj.hostname + (urlObj.pathname !== '/' ? urlObj.pathname.slice(0, 20) : ''),
        path: urlWithProtocol,
      });
      setUrlInputVisible(false);
      setUrlInputValue("");
      setUrlInputError(null);
    } catch {
      setUrlInputError("URL 格式无效，请重新输入");
      urlInputRef.current?.focus();
      if (urlErrorTimerRef.current != null) clearTimeout(urlErrorTimerRef.current);
      urlErrorTimerRef.current = setTimeout(() => {
        urlErrorTimerRef.current = null;
        setUrlInputError(null);
      }, 3000);
    }
  }, [urlInputValue, addContextItem]);

  useEffect(() => () => {
    if (urlErrorTimerRef.current != null) clearTimeout(urlErrorTimerRef.current);
  }, []);

  // 从知识库添加：将知识库路径作为 context_item（type: file）传入本轮
  const handleAddKnowledgeRef = useCallback(() => {
    setKbRefPathValue("");
    setKbRefVisible(true);
    setTimeout(() => kbRefInputRef.current?.focus(), 50);
  }, []);
  const confirmAddKnowledgeRef = useCallback(() => {
    const path = kbRefPathValue.trim().replace(/^\/+/, "");
    if (!path) {
      setKbRefVisible(false);
      return;
    }
    const name = path.split("/").filter(Boolean).pop() || path;
    addContextItem({
      id: `kb-${Date.now()}`,
      type: "file",
      name: `知识库: ${name}`,
      path: path.startsWith("knowledge_base") ? path : `knowledge_base/${path}`,
      status: "success",
    });
    setKbRefVisible(false);
    setKbRefPathValue("");
  }, [kbRefPathValue, addContextItem]);
  
  // 键盘快捷键（⌘1-4 模式、⌘/ 上下文、⌘P 文件、⌘? 更多能力）；仅当焦点在 Composer 主输入框时触发，避免任意输入框误触发
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const root = composerRootRef.current;
      const inComposer = !!(root && active && root.contains(active));
      const composerInput = root?.querySelector("textarea");
      const inComposerInput = !!(composerInput && active && (composerInput === active || composerInput.contains(active)));
      const allowShortcut = inComposerInput; // 仅主输入框内触发，避免侧栏/编辑器/其他输入框误触
      if (e.metaKey || e.ctrlKey) {
        switch (e.key) {
          case "1":
            if (!allowShortcut) break;
            e.preventDefault();
            if (availableModes.includes("agent")) handleModeChange("agent");
            break;
          case "2":
            if (!allowShortcut) break;
            e.preventDefault();
            if (availableModes.includes("ask")) handleModeChange("ask");
            break;
          case "3":
            if (!allowShortcut) break;
            e.preventDefault();
            if (availableModes.includes("plan")) handleModeChange("plan");
            break;
          case "4":
            if (!allowShortcut) break;
            e.preventDefault();
            if (fourthMode) handleModeChange(fourthMode);
            break;
          case "/":
            if (!allowShortcut) break;
            e.preventDefault();
            setContextMenuOpen(true);
            break;
          case "p":
            if (!inComposer) break;
            e.preventDefault();
            e.stopImmediatePropagation();
            openFileSelector();
            break;
          case "?":
            if (!allowShortcut) break;
            e.preventDefault();
            window.dispatchEvent(new CustomEvent(EVENTS.OPEN_SHORTCUTS_HELP));
            break;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [availableModes, fourthMode, handleModeChange, openFileSelector]);

  useEffect(() => {
    let cancelled = false;
    listPlugins()
      .then((res) => {
        if (cancelled || !res.ok) return;
        const rows = (res.plugins || []).map((p) => ({ name: String(p.name || "").trim(), loaded: !!p.loaded }))
          .filter((p) => p.name);
        setAvailablePlugins(rows);
      })
      .catch(() => {
        if (!cancelled && !composerInitErrorShownRef.current) {
          composerInitErrorShownRef.current = true;
          toast.error(t("composer.rolesPluginsLoadError"));
        }
      });
    listPluginCommands()
      .then((res) => {
        if (cancelled || !res.ok) return;
        const rows = (res.commands || [])
          .map((c) => ({
            cmd: String(c.command || "").trim(),
            desc: String(c.description || t("composer.pluginCommand")),
            plugin: String(c.plugin || "").trim(),
            commandKey: String(c.command_key || "").trim(),
            conflict: Boolean((c as { conflict?: boolean }).conflict),
            plugins: Array.isArray((c as unknown as { plugins?: string[] }).plugins) ? (c as unknown as { plugins: string[] }).plugins : undefined,
          }))
          .filter((c) => c.cmd.startsWith("/"));
        setPluginSlashCommands(rows);
        const hasConflict = rows.some((r) => r.conflict && (r.plugins?.length ?? 0) > 1);
        if (hasConflict && !pluginConflictHintShownRef.current) {
          pluginConflictHintShownRef.current = true;
          toast.info(t("plugin.commandConflictHint"), { duration: 6000 });
        }
      })
      .catch(() => {
        if (!cancelled && !composerInitErrorShownRef.current) {
          composerInitErrorShownRef.current = true;
          toast.error(t("composer.rolesPluginsLoadError"));
        }
      });
    return () => { cancelled = true; };
  }, []);

  // 从后端拉取能力档位（skill_profiles.json），用于 UI 文案与角色档位展示
  useEffect(() => {
    let cancelled = false;
    setSkillProfilesLoading(true);
    boardApi.getSkillProfiles()
      .then((res) => {
        if (cancelled || !res.ok || !Array.isArray(res.profiles) || res.profiles.length === 0) return;
        const items: SkillProfileItem[] = res.profiles.map((p) => ({
          id: normalizeSkillProfileId(p.id) as SkillProfileId,
          label: p.label || p.id,
          title: p.description || p.capabilities_summary || "",
        }));
        setSkillProfileItems(items);
      })
      .catch(() => { if (!cancelled) toast.error(t("composer.skillProfilesLoadError")); })
      .finally(() => { if (!cancelled) setSkillProfilesLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // 从后端拉取角色列表（roles.json），fallback 使用 ROLES_FALLBACK
  useEffect(() => {
    let cancelled = false;
    setRolesLoading(true);
    boardApi.listRoles()
      .then((res) => {
        if (cancelled || !res.ok || !Array.isArray(res.roles) || res.roles.length === 0) return;
        const items: RoleItem[] = res.roles.map((r) => ({
          id: r.id,
          label: r.label,
          description: r.description,
          icon: r.icon,
          skill_profile: r.skill_profile,
          responsibility_scope: r.responsibility_scope,
          not_responsible_for: r.not_responsible_for,
          resolved_capabilities_count: r.resolved_capabilities_count,
          suggested_questions: r.suggested_questions,
          capabilities: (r.resolved_capabilities ?? r.capabilities)?.map(c => ({ id: c.id, label: c.label })),
          modes: normalizeRoleModes(r.modes, r.id, r.preferred_fourth_mode),
          preferred_fourth_mode: r.preferred_fourth_mode,
        }));
        setRolesList(items);
      })
      .catch((e) => {
        if (!cancelled) toast.error(t("composer.rolesLoadFailed"), { description: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => { if (!cancelled) setRolesLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // 与 localStorage 同步：多标签页通过 storage；同 tab 通过 COMPOSER_PREFS_CHANGED（模式/角色由 SessionContext 同步）
  useEffect(() => {
    const syncFromStorage = () => {
      const w = getStorageItem("maibot_web_search");
      setWebSearchEnabled(w === "true");
      const p = getStorageItem("maibot_skill_profile");
      const normalized = normalizeSkillProfileId(p);
      if (p && normalized !== p) setStorageItem("maibot_skill_profile", normalized);
      setSkillProfile(normalized);
      setResearchMode(getStorageItem("maibot_research_mode") === "true");
      setSessionPlugins(getScopedSessionPlugins());
    };
    window.addEventListener("storage", syncFromStorage);
    window.addEventListener(EVENTS.COMPOSER_PREFS_CHANGED, syncFromStorage);
    window.addEventListener(EVENTS.SESSION_CHANGED, syncFromStorage as EventListener);
    return () => {
      window.removeEventListener("storage", syncFromStorage);
      window.removeEventListener(EVENTS.COMPOSER_PREFS_CHANGED, syncFromStorage);
      window.removeEventListener(EVENTS.SESSION_CHANGED, syncFromStorage as EventListener);
    };
  }, []);

  // 文件树/知识库等触发：将指定路径文件加入对话上下文
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ path: string }>;
      const path = ev.detail?.path?.trim();
      if (!path) return;
      const fileName = path.replace(/\\/g, "/").split("/").filter(Boolean).pop() || path;
      addContextItem({
        id: `file-add-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        type: "file",
        name: fileName,
        path,
      });
      toast.success(t("composer.addedFileToContext"), { description: fileName });
    };
    window.addEventListener(EVENTS.ADD_FILE_TO_CONTEXT, handler);
    return () => window.removeEventListener(EVENTS.ADD_FILE_TO_CONTEXT, handler);
  }, [addContextItem]);

  // 文件树右键触发：将指定路径文件夹加入对话上下文
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ path: string }>;
      const path = ev.detail?.path?.trim();
      if (!path) return;
      const folderName = path.replace(/\\/g, "/").split("/").filter(Boolean).pop() || path;
      addContextItem({
        id: `folder-add-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        type: "folder",
        name: folderName,
        path,
      });
      toast.success(t("composer.addedFolderToContext"), { description: folderName });
    };
    window.addEventListener(EVENTS.ADD_FOLDER_TO_CONTEXT, handler);
    return () => window.removeEventListener(EVENTS.ADD_FOLDER_TO_CONTEXT, handler);
  }, [addContextItem]);

  useEffect(() => {
    const handler = (e: CustomEvent<{ selectedText?: string; selectionRange?: { startLine: number; endLine: number } | null; filePath?: string; fileName?: string }>) => {
      const d = e.detail ?? {};
      const text = (d.selectedText ?? "").trim();
      if (!text) {
        setEditorSelection(null);
        return;
      }
      setEditorSelection({
        selectedText: text,
        selectionRange: d.selectionRange ?? null,
        filePath: d.filePath,
        fileName: d.fileName,
      });
    };
    window.addEventListener(EVENTS.EDITOR_SELECTION_CHANGED, handler as EventListener);
    return () => window.removeEventListener(EVENTS.EDITOR_SELECTION_CHANGED, handler as EventListener);
  }, []);

  // 工作区文件选择弹窗空态等触发：打开 Composer 本地上传
  useEffect(() => {
    const handler = () => {
      // 延迟执行以便从弹窗内触发时先关闭弹窗再打开文件选择（避免 ref 未就绪）
      setTimeout(() => openFileSelector(), 120);
    };
    window.addEventListener(EVENTS.TRIGGER_COMPOSER_FILE_UPLOAD, handler);
    return () => window.removeEventListener(EVENTS.TRIGGER_COMPOSER_FILE_UPLOAD, handler);
  }, [openFileSelector]);

  // 角色切换后若当前模式不受支持，自动回退到角色首选模式
  useEffect(() => {
    if (availableModes.includes(mode)) return;
    const fallback = availableModes[0] ?? "agent";
    handleModeChange(fallback);
  }, [availableModes, mode, handleModeChange]);
  
  // 输入框内容长度上限，防止大粘贴/多会话后内存与渲染导致崩溃（与 inputTextMirror 相关）
  const MAX_COMPOSER_INPUT_LENGTH = 80_000;
  const setInputMirrorSafe = useCallback((v: string) => {
    if (v.length > MAX_COMPOSER_INPUT_LENGTH) {
      if (import.meta.env?.DEV) console.warn("[Composer] inputMirror 超过上限已截断", v.length, MAX_COMPOSER_INPUT_LENGTH);
      v = v.slice(0, MAX_COMPOSER_INPUT_LENGTH);
    }
    setInputMirror(v);
  }, []);

  // ✅ Composer Runtime；联想用 ref+state 驱动，确保按键后立即看到 / @ 下拉（不依赖库 store 时机）
  const composerRuntime = useComposerRuntime();
  const composerTextFromStore = useAssistantState((s) => s.composer.text ?? "");
  const inputValueRef = useRef("");
  const [inputMirror, setInputMirror] = useState("");
  const composerText = inputMirror !== "" ? inputMirror : composerTextFromStore;
  const [phIdx, setPhIdx] = useState(0);
  const [cursorPosition, setCursorPosition] = useState(0);
  const cursorPositionRef = useRef(0);
  const hasContext = contextItems.some((i) => i.status === 'success');
  const sendDisabled = hasUploadingContext || (!composerText.trim() && !hasContext);
  const INPUT_HISTORY_KEY = "maibot_composer_input_history";
  const INPUT_HISTORY_MAX = 30;
  const [inputHistory, setInputHistory] = useState<string[]>(() => {
    try {
      const raw = typeof sessionStorage !== "undefined" ? sessionStorage.getItem(INPUT_HISTORY_KEY) : null;
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.slice(0, INPUT_HISTORY_MAX) : [];
    } catch {
      return [];
    }
  });
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(-1);
  const [mentionTaskResults, setMentionTaskResults] = useState<Array<{ id: string; subject: string }>>([]);
  const [liveInputTokens, setLiveInputTokens] = useState(0);
  const liveTokensTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isComposingRef = useRef(false);
  useEffect(() => {
    if (liveTokensTimerRef.current) clearTimeout(liveTokensTimerRef.current);
    liveTokensTimerRef.current = setTimeout(() => {
      setLiveInputTokens(Math.ceil((composerText?.length ?? 0) / 4));
      liveTokensTimerRef.current = null;
    }, 500);
    return () => {
      if (liveTokensTimerRef.current) clearTimeout(liveTokensTimerRef.current);
    };
  }, [composerText]);

  /** Cursor 一致：单一句占位符，不轮换 */
  const placeholderOptions = useMemo(() => [t("composer.placeholder")], []);

  useEffect(() => {
    if (composerText.trim()) return;
    const len = placeholderOptions.length;
    if (len === 0) return;
    const t = setInterval(() => setPhIdx((i) => (i + 1) % len), 4000);
    return () => clearInterval(t);
  }, [composerText, placeholderOptions]);

  // 库在发送后清空 store 时，同步清空本地镜像与 ref
  useEffect(() => {
    if (composerTextFromStore === "") {
      setInputMirrorSafe("");
      inputValueRef.current = "";
    }
  }, [composerTextFromStore, setInputMirrorSafe]);

  const textBeforeCaret = (() => {
    const text = inputValueRef.current !== undefined ? inputValueRef.current : composerText;
    const pos = cursorPositionRef.current ?? cursorPosition;
    return String(text ?? "").slice(0, pos);
  })();
  const lastAt = textBeforeCaret.lastIndexOf("@");
  const charBeforeAt = lastAt <= 0 ? " " : textBeforeCaret[lastAt - 1];
  const atAfterWhitespace = /\s/.test(charBeforeAt);
  const mentionQuery = lastAt >= 0 && atAfterWhitespace && !/[\s\n]/.test(textBeforeCaret.slice(lastAt + 1)) ? textBeforeCaret.slice(lastAt + 1) : null;
  const mentionOpen = mentionQuery !== null;

  const mentionCandidates = useMemo(() => {
    if (!mentionOpen) return [];
    const q = (mentionQuery ?? "").toLowerCase();
    const roleItems = rolesList
      .filter((r) => !q || r.label.toLowerCase().includes(q) || r.id.toLowerCase().includes(q))
      .slice(0, 5)
      .map((r) => ({ type: "role" as const, id: r.id, label: r.label }));
    const taskItems = mentionTaskResults.slice(0, 5).map((t) => ({ type: "task" as const, id: t.id, label: t.subject || t.id }));
    const fileCandidates = (openFilesFromContext ?? [])
      .filter((f) => !q || f.name.toLowerCase().includes(q))
      .slice(0, 5)
      .map((f) => ({ type: "file" as const, id: `file:${f.path}`, label: f.name, sub: f.path }));
    const staticItems: { type: "file" | "task"; id: string; label: string; sub?: string }[] = [
      { type: "file", id: "__file__", label: t("composer.addFile") },
      { type: "task", id: "__task__", label: t("composer.addTask") },
    ];
    if (roleItems.length + taskItems.length + fileCandidates.length === 0 && !q) return [...staticItems];
    return [...roleItems, ...taskItems, ...fileCandidates, ...staticItems];
  }, [mentionOpen, mentionQuery, rolesList, mentionTaskResults, openFilesFromContext, t]);

  useEffect(() => {
    if (!mentionOpen || (mentionQuery ?? "").length < 2) {
      setMentionTaskResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      boardApi.getTasks("personal").then((res) => {
        if (cancelled || !res.ok || !res.tasks) return;
        const q = (mentionQuery ?? "").toLowerCase();
        const filtered = res.tasks
          .filter((t) => (t.subject ?? "").toLowerCase().includes(q) || (t.id ?? "").toLowerCase().includes(q))
          .slice(0, 5)
          .map((t) => ({ id: t.id, subject: t.subject ?? "" }));
        setMentionTaskResults(filtered);
      }).catch((err) => {
        if (import.meta.env?.DEV) console.warn('[CursorStyleComposer] mention tasks fetch failed:', err);
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mentionOpen, mentionQuery]);

  useEffect(() => setSelectedMentionIndex(-1), [mentionCandidates.length]);

  const slashSuggestions = useMemo(() => {
    const text = (inputValueRef.current !== undefined ? inputValueRef.current : composerText) || "";
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return [];
    const q = trimmed.toLowerCase();
    const merged = [...SLASH_COMMANDS, ...pluginSlashCommands];
    const dedup = new Map<string, { cmd: string; desc: string; plugin?: string; matchKey: string; conflict?: boolean; plugins?: string[] }>();
    for (const item of merged) {
      const cmd = String(item.cmd || "").trim();
      if (!cmd) continue;
      const plugin = String((item as { plugin?: string }).plugin || "").trim();
      const key = String((item as { commandKey?: string }).commandKey || "").trim() || `${cmd}@@${plugin || "builtin"}`;
      const matchKey = plugin ? `${cmd}@${plugin}` : cmd;
      if (!dedup.has(key)) {
        dedup.set(key, {
          cmd,
          desc: String(item.desc || "").trim(),
          plugin: plugin || undefined,
          matchKey: matchKey.toLowerCase(),
          conflict: Boolean((item as { conflict?: boolean }).conflict),
          plugins: Array.isArray((item as unknown as { plugins?: string[] }).plugins) ? (item as unknown as { plugins: string[] }).plugins : undefined,
        });
      }
    }
    const list = Array.from(dedup.values()).filter((item) => item.matchKey.startsWith(q) || item.cmd.toLowerCase().startsWith(q)).slice(0, 7);
    const byCmd = new Map<string, typeof list>();
    for (const item of list) {
      const c = item.cmd.toLowerCase();
      if (!byCmd.has(c)) byCmd.set(c, []);
      byCmd.get(c)!.push(item);
    }
    for (const group of byCmd.values()) {
      if (group.length > 1) {
        const plugins = group.map((x) => x.plugin).filter(Boolean) as string[];
        if (plugins.length > 0) {
          for (const item of group) {
            item.conflict = true;
            item.plugins = plugins.length ? plugins : undefined;
          }
        }
      }
    }
    return list;
  }, [composerText, inputMirror, pluginSlashCommands]);

  const [selectedSlashIndex, setSelectedSlashIndex] = useState(-1);
  useEffect(() => setSelectedSlashIndex(-1), [slashSuggestions]);

  const dropdownVisible = slashSuggestions.length > 0 || (mentionOpen && mentionCandidates.length > 0);
  useLayoutEffect(() => {
    if (!dropdownVisible || !composerInputAreaRef.current) {
      setDropdownAnchorRect(null);
      return;
    }
    const update = () => {
      const el = composerInputAreaRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setDropdownAnchorRect({ left: rect.left, top: rect.top, width: rect.width });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [dropdownVisible]);

  const handleSlashSelect = useCallback(
    (item: { cmd: string; desc: string; plugin?: string; matchKey: string }) => {
      const text = `${item.cmd} `;
      if (composerRuntime?.setText) composerRuntime.setText(text);
      inputValueRef.current = text;
      setInputMirrorSafe(text);
      setCursorPosition(text.length);
      cursorPositionRef.current = text.length;
      setSelectedSlashIndex(-1);
    },
    [composerRuntime],
  );

  const handleTemplateSelect = useCallback(
    (t: { id: string; label: string; text: string }) => {
      const text = t.text;
      if (composerRuntime?.setText) composerRuntime.setText(text);
      inputValueRef.current = text;
      setInputMirrorSafe(text);
      setCursorPosition(text.length);
      cursorPositionRef.current = text.length;
      setSelectedSlashIndex(-1);
    },
    [composerRuntime],
  );

  const handleMentionSelect = useCallback(
    (item: { type: string; id: string; label: string; sub?: string }) => {
      const prefix = composerText.slice(0, lastAt);
      const suffix = composerText.slice(cursorPosition);
      if (item.type === "file" && item.id === "__file__") {
        const newText = prefix + suffix;
        if (composerRuntime?.setText) composerRuntime.setText(newText);
        inputValueRef.current = newText;
        setInputMirrorSafe(newText);
        setCursorPosition(newText.length);
        cursorPositionRef.current = newText.length;
        setSelectedMentionIndex(-1);
        openFileSelector();
        return;
      }
      if (item.type === "file" && item.id.startsWith("file:")) {
        const path = item.sub ?? item.id.replace(/^file:/, "");
        addContextItem({ id: `file-${Date.now()}`, type: "file", name: item.label, path });
        const newText = prefix + suffix;
        if (composerRuntime?.setText) composerRuntime.setText(newText);
        inputValueRef.current = newText;
        setInputMirrorSafe(newText);
        setCursorPosition(newText.length);
        cursorPositionRef.current = newText.length;
        setSelectedMentionIndex(-1);
        return;
      }
      if (item.type === "task" && item.id === "__task__") {
        setSelectedMentionIndex(-1);
        return;
      }
      const insert = item.type === "role" || item.type === "task" ? `@${item.label} ` : "";
      const newText = prefix + insert + suffix;
      const newPos = prefix.length + insert.length;
      if (composerRuntime?.setText) composerRuntime.setText(newText);
      inputValueRef.current = newText;
      setInputMirrorSafe(newText);
      setCursorPosition(newPos);
      cursorPositionRef.current = newPos;
      setSelectedMentionIndex(-1);
    },
    [composerText, lastAt, cursorPosition, composerRuntime, openFileSelector, addContextItem],
  );

  const pushInputHistory = useCallback(() => {
    const trimmed = composerText.trim();
    if (!trimmed) return;
    setInputHistory((prev) => {
      const next = [trimmed, ...prev.filter((s) => s !== trimmed)].slice(0, INPUT_HISTORY_MAX);
      try {
        sessionStorage.setItem(INPUT_HISTORY_KEY, JSON.stringify(next));
      } catch (e) {
        if (import.meta.env?.DEV) console.warn('[CursorStyleComposer] input history persist failed:', e);
      }
      return next;
    });
    setHistoryIndex(-1);
  }, [composerText]);

  // Cursor 风格：发送前同步当前附件到 runtime ref；若有未执行完的防抖则取消并派发一次最新 ref，避免刚添加就发送时 ref 未同步
  const flushContextBeforeSend = useCallback(() => {
    if (contextItemsDispatchTimerRef.current) {
      clearTimeout(contextItemsDispatchTimerRef.current);
      contextItemsDispatchTimerRef.current = null;
    }
    const current = contextItemsRef.current;
    if (current.length > 0) {
      window.dispatchEvent(new CustomEvent(EVENTS.CONTEXT_ITEMS_CHANGED, { detail: { contextItems: current } }));
    }
  }, []);
  
  // focus_composer：命令面板/⌘L 仅聚焦输入框，不填内容
  useEffect(() => {
    const handleFocusComposer = () => {
      const textarea = composerRootRef.current?.querySelector('textarea');
      if (textarea) {
        textarea.focus();
      }
    };
    window.addEventListener(EVENTS.FOCUS_COMPOSER, handleFocusComposer);
    return () => window.removeEventListener(EVENTS.FOCUS_COMPOSER, handleFocusComposer);
  }, []);

  // fill_prompt 闭环：仪表盘/命令面板填入任务描述，可选自动发送（支持 threadId；指定且与当前不同时先切换再填词，对齐 Cursor；_deferred 防重入避免循环）
  useEffect(() => {
    const handleFillPrompt = (e: CustomEvent<{ prompt: string; autoSend?: boolean; threadId?: string; _deferred?: boolean }>) => {
      const targetThreadId = String(e.detail?.threadId || "").trim();
      const currentThreadId = getCurrentThreadIdFromStorage();
      const isDeferred = e.detail?._deferred === true;
      if (!isDeferred && targetThreadId && currentThreadId && targetThreadId !== currentThreadId) {
        window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_TO_THREAD, { detail: { threadId: targetThreadId } }));
        const detail = e.detail ?? {};
        setTimeout(() => window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, { detail: { ...detail, _deferred: true } })), 0);
        return;
      }
      const prompt = e.detail?.prompt?.trim();
      if (!prompt) return;
      if (composerRuntime?.setText) {
        composerRuntime.setText(prompt);
        inputValueRef.current = prompt;
        setInputMirrorSafe(prompt);
        setCursorPosition(prompt.length);
        cursorPositionRef.current = prompt.length;
      } else {
        const textarea = composerRootRef.current?.querySelector('textarea');
        if (textarea) {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            'value'
          )?.set;
          if (nativeInputValueSetter) {
            nativeInputValueSetter.call(textarea, prompt);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            textarea.value = prompt;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
        inputValueRef.current = prompt;
        setInputMirrorSafe(prompt);
        setCursorPosition(prompt.length);
        cursorPositionRef.current = prompt.length;
      }
      const textarea = composerRootRef.current?.querySelector('textarea');
      if (textarea) textarea.focus();
      if (e.detail?.autoSend) {
        setTimeout(() => window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_SUBMIT)), 150);
      }
    };
    // Cursor 一致：FILL_PROMPT+autoSend 时状态可能尚未同步，首次未点击则短延迟重试一次
    const handleComposerSubmit = () => {
      const btn = sendButtonRef.current;
      if (btn && document.body.contains(btn)) {
        if (!btn.disabled) {
          btn.click();
          return;
        }
        setTimeout(() => {
          const b = sendButtonRef.current;
          if (b && !b.disabled && document.body.contains(b)) b.click();
        }, 120);
      }
    };
    window.addEventListener(EVENTS.FILL_PROMPT, handleFillPrompt as EventListener);
    window.addEventListener(EVENTS.COMPOSER_SUBMIT, handleComposerSubmit as EventListener);
    return () => {
      window.removeEventListener(EVENTS.FILL_PROMPT, handleFillPrompt as EventListener);
      window.removeEventListener(EVENTS.COMPOSER_SUBMIT, handleComposerSubmit as EventListener);
    };
  }, [composerRuntime]);
  
  // 编辑区 → 对话区联动：收到「用 AI 分析」时填入文件上下文与提示
  useEffect(() => {
    const handleEditorAskContext = (e: CustomEvent<{ filePath?: string; selectedText?: string; content?: string }>) => {
      const { filePath, selectedText, content } = e.detail ?? {};
      if (filePath) {
        const name = filePath.split("/").filter(Boolean).pop() || "文件";
        addContextItem({
          id: `file-editor-${Date.now()}`,
          type: "file",
          name,
          path: filePath,
          status: "success",
        });
      }
      const prompt = selectedText?.trim()
        ? `请分析以下选中内容：\n\n${selectedText.slice(0, 4000)}${selectedText.length > 4000 ? "\n…" : ""}`
        : content?.trim()
          ? "请分析上述文件内容。"
          : "请分析当前文件。";
      const scopedThreadId = getCurrentThreadIdFromStorage();
      window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, { detail: { prompt, threadId: scopedThreadId || undefined } }));
      const textarea = composerRootRef.current?.querySelector("textarea");
      if (textarea) textarea.focus();
    };
    window.addEventListener(EVENTS.EDITOR_ASK_CONTEXT, handleEditorAskContext as EventListener);
    return () => window.removeEventListener(EVENTS.EDITOR_ASK_CONTEXT, handleEditorAskContext as EventListener);
  }, [addContextItem]);

  // ✅ 与 MyRuntimeProvider 同步：仅当数据实际变化时 setState，避免 setState → 重渲染 → 再次派发 → 循环/栈溢出
  // 事件来源：外部组件（如 MyRuntimeProvider）派发；此处只同步 state，不回调 onContextChange（避免循环）
  const isHandlingExternalEventRef = React.useRef(false);
  useEffect(() => {
    const handleContextItemsChanged = (e: CustomEvent<{ contextItems: ContextItem[] }>) => {
      if (isHandlingExternalEventRef.current) return; // 防重入
      isHandlingExternalEventRef.current = true;
      try {
        const items = e.detail?.contextItems ?? [];
        setContextItems((prev) => {
          if (prev.length !== items.length) return items;
          const same = prev.every((p, i) => {
            const n = items[i];
            return n && p.id === n.id && p.path === n.path && p.status === n.status;
          });
          return same ? prev : items;
        });
      } finally {
        // 延迟重置，确保 React 批量更新完成后再允许下一次处理
        Promise.resolve().then(() => { isHandlingExternalEventRef.current = false; });
      }
    };
    window.addEventListener(EVENTS.CONTEXT_ITEMS_CHANGED, handleContextItemsChanged as EventListener);
    return () => window.removeEventListener(EVENTS.CONTEXT_ITEMS_CHANGED, handleContextItemsChanged as EventListener);
  }, []);

  // ✅ 消息发送后清空上下文项，并通知 MyRuntimeProvider 清空 ref，避免下一轮仍带上轮附件；释放图片 blob URL（startTransition 降低卡顿）
  useEffect(() => {
    const handleMessageSent = () => {
      if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) console.log('[CursorStyleComposer] 消息已发送，清空上下文项');
      startTransition(() => {
        setContextItems(prev => {
          prev.forEach(item => {
            if (item.type === "image" && item.preview?.startsWith("blob:")) {
              URL.revokeObjectURL(item.preview);
            }
          });
          return [];
        });
      });
      window.dispatchEvent(new CustomEvent(EVENTS.CONTEXT_ITEMS_CHANGED, { detail: { contextItems: [] } }));
    };
    window.addEventListener(EVENTS.MESSAGE_SENT, handleMessageSent);
    return () => window.removeEventListener(EVENTS.MESSAGE_SENT, handleMessageSent);
  }, []);
  
  // 停止生成：仅在有 run 时显示停止按钮（ThreadPrimitive.If running）；无活动 run 时若仍被触发（如快捷键），cancelRun 内会 toast t("composer.noActiveRun")
  const handleCancel = useCallback(async () => {
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) console.log("[CursorStyleComposer] 停止生成");
    const _ingestUrl = (import.meta as { env?: { VITE_AGENT_LOG_INGEST_URL?: string } }).env?.VITE_AGENT_LOG_INGEST_URL;
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV && _ingestUrl) {
      fetch(_ingestUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location: "cursor-style-composer.tsx:handleCancel", message: "stop generation invoked", timestamp: Date.now() }) }).catch((err) => { if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) console.warn("[CursorStyleComposer] ingest handleCancel failed", err); });
    }
    await cancelRun();
  }, [cancelRun]);

  // 命令面板/菜单触发的“停止生成”统一入口
  useEffect(() => {
    const onStopGeneration = () => {
      void handleCancel();
    };
    window.addEventListener(EVENTS.STOP_GENERATION_REQUEST, onStopGeneration);
    return () => window.removeEventListener(EVENTS.STOP_GENERATION_REQUEST, onStopGeneration);
  }, [handleCancel]);
  
  // 拖拽事件处理
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);
  
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 只有当离开整个区域时才取消拖拽状态
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  }, []);
  
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    
    const files = Array.from(e.dataTransfer.files);
    
    for (const file of files) {
      if (file.type.startsWith("image/")) {
        // 图片：上传到服务器，与文件路径一致供 AI 访问
        const itemId = `image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        addContextItem({
          id: itemId,
          type: "image",
          name: file.name,
          preview: URL.createObjectURL(file),
          path: "",
          status: "uploading",
          progress: 0,
          size: file.size,
        });
        try {
          const result = await uploadFile(file, itemId);
          if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) console.log('[Composer] 拖拽图片上传成功:', result);
          setContextItems((prev) => {
            const newItems = prev.map((item) =>
              item.id === itemId
                ? { ...item, path: result.path, status: "success" as const, progress: 100 }
                : item
            );
            scheduleContextItemsDispatch(newItems);
            return newItems;
          });
        } catch (error) {
          console.error("[Composer] 拖拽图片上传失败:", error);
          toast.error(t("composer.uploadImageError"));
          setContextItems((prev) => {
            const newItems = prev.map((item) =>
              item.id === itemId ? { ...item, status: "error" as const, progress: 0 } : item
            );
            scheduleContextItemsDispatch(newItems);
            return newItems;
          });
        }
      } else {
        // 文件：上传到服务器
        const itemId = `file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        
        addContextItem({
          id: itemId,
          type: "file",
          name: file.name,
          path: "",
          status: "uploading",
          progress: 0,
          size: file.size,
        });
        
        try {
          const result = await uploadFile(file, itemId);
          if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) console.log('[Composer] 拖拽文件上传成功:', result);
          
          setContextItems(prev => {
            const newItems = prev.map(item =>
              item.id === itemId
                ? { ...item, path: result.path, status: "success" as const, progress: 100 }
                : item
            );
            scheduleContextItemsDispatch(newItems);
            return newItems;
          });
        } catch (error) {
          console.error('[Composer] ❌ 拖拽文件上传失败:', error);
          toast.error(t("composer.uploadFileError"));
          setContextItems(prev => {
            const newItems = prev.map(item =>
              item.id === itemId
                ? { ...item, status: "error" as const, progress: 0 }
                : item
            );
            scheduleContextItemsDispatch(newItems);
            return newItems;
          });
        }
      }
    }
  }, [addContextItem, uploadFile, scheduleContextItemsDispatch]);

  const interruptState = useContext(InterruptStateContext)?.state;
  /** 仅当当前会话存在待处理检查点（工具审批/人审）时显示，避免因全局 task 状态导致该条常显 */
  const hasHumanWaiting = Boolean(interruptState?.hasInterrupt);

  return (
    <div ref={composerRootRef} className="w-full flex flex-col">
    <ComposerPrimitive.Root 
      className="aui-composer-root relative flex w-full flex-col"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* 拖拽覆盖层 */}
      {isDragging && (
        <div className="absolute inset-0 z-[var(--z-dropdown)] flex items-center justify-center bg-primary/10 border-2 border-dashed border-primary rounded-lg backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 text-primary">
            <ArrowUpIcon className="size-8 animate-bounce" />
            <span className="text-sm font-medium">释放以添加文件</span>
          </div>
        </div>
      )}
      
      {/* 模式切换提示 */}
      {transientHint && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 bg-foreground/90 text-background text-xs rounded-full whitespace-pre-line text-center max-w-[280px] animate-in fade-in slide-in-from-bottom-2 duration-200">
          {transientHint}
        </div>
      )}
      
      {/* 错误提示 */}
      <ErrorToast />
      {/* 任务等待中提示 */}
      {hasHumanWaiting && (
        <div className="px-3 py-1.5 border-b border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 text-xs flex items-center gap-2">
          <ListTodoIcon className="size-3.5 shrink-0" />
          任务等待中，请前往检查点或任务详情处理
        </div>
      )}
      {/* 隐藏的文件输入 */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileSelect}
        accept=".txt,.md,.pdf,.docx,.xlsx,.csv,.json,.py,.js,.ts,.tsx"
      />
      <input
        ref={imageInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleImageSelect}
        accept="image/*"
      />

      {/* 编辑器选区提示条：点击添加为 code 上下文 */}
      {editorSelection?.selectedText && (
        <div className="flex items-center gap-2 min-h-9 px-3 py-1.5 border-b border-border/20 bg-primary/5 text-[11px] text-foreground/90">
          <CodeIcon className="size-3.5 text-primary shrink-0" aria-hidden />
          <button
            type="button"
            className="flex-1 min-w-0 text-left truncate hover:text-primary transition-colors"
            onClick={() => {
              const r = editorSelection.selectionRange;
              const name = editorSelection.fileName
                ? `${editorSelection.fileName}${r ? ` L${r.startLine}-${r.endLine}` : ""}`
                : "选中代码";
              addContextItem({
                id: `code-${Date.now()}`,
                type: "code",
                name,
                path: editorSelection.filePath,
                content: editorSelection.selectedText,
              });
              setEditorSelection(null);
            }}
          >
            <span className="tabular-nums">
              已选中 {(editorSelection.selectedText.match(/\n/g)?.length ?? 0) + 1} 行代码
            </span>
            {editorSelection.fileName && (
              <span className="text-muted-foreground/80">
                （{editorSelection.fileName}
                {editorSelection.selectionRange
                  ? ` L${editorSelection.selectionRange.startLine}-${editorSelection.selectionRange.endLine}`
                  : ""}
                ）
              </span>
            )}
            <span className="text-muted-foreground/60"> · 点击添加为上下文</span>
          </button>
          <button
            type="button"
            className="shrink-0 h-6 w-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            onClick={() => setEditorSelection(null)}
            aria-label={t("common.close")}
          >
            <XIcon className="size-3" />
          </button>
        </div>
      )}

      {/* 上下文项显示 - 紧凑对齐，最大高度+滚动；nestedInCard 时更紧凑 */}
      {contextItems.length > 0 && (
        <div className="border-b border-border/20 bg-muted/2">
          <div className={cn("flex items-center gap-2 text-[11px] text-muted-foreground", nestedInCard ? "min-h-7 px-2.5 py-1" : "min-h-8 px-3 py-1.5")}>
            <span>{t("composer.context.count", { n: contextItems.length })}</span>
          </div>
          <div className={cn("flex flex-wrap items-center gap-2 max-h-28 overflow-y-auto", nestedInCard ? "min-h-8 px-2.5 py-1.5" : "min-h-9 px-3 py-2")}>
            {contextItems.map(item => (
              <ContextItemChip
                key={item.id}
                item={item}
                onRemove={() => removeContextItem(item.id)}
              />
            ))}
            {/* 清空全部按钮 */}
            {contextItems.length > 1 && (
            <button
              onClick={() => {
                contextItems.forEach((item) => {
                  if (item.preview?.startsWith?.('blob:')) URL.revokeObjectURL(item.preview);
                });
                setContextItems([]);
                onContextChange?.([]);
              }}
              className="ml-auto h-6 px-2 text-[11px] text-muted-foreground/60 hover:text-muted-foreground rounded-md hover:bg-muted/50 transition-colors flex items-center"
              aria-label={t("composer.context.clearAllAria")}
            >
              {t("composer.context.clearAll")}
            </button>
          )}
          {failedContextCount > 0 && (
            <button
              onClick={clearFailedContextItems}
              className="h-6 px-2 text-[11px] text-destructive/80 hover:text-destructive rounded-md hover:bg-destructive/10 transition-colors flex items-center"
              aria-label={t("composer.removeFailedContextAria")}
            >
              {t("composer.removeFailedContextButton", { n: failedContextCount })}
            </button>
          )}
          </div>
        </div>
      )}
      
      {/* URL 输入框：与快捷条/运行卡统一样式 */}
      {urlInputVisible && (
        <div className={cn(
          nestedInCard ? "border-b border-border/30 px-2.5 py-0.5 flex items-center gap-2 min-h-7" : "rounded-lg border border-border/50 bg-card/65 shadow-sm flex items-center gap-2 min-h-8 px-2 py-1.5 mb-0.5",
          urlInputError && "border-destructive/40 bg-destructive/5"
        )}>
          <LinkIcon className="size-3.5 text-purple-500 shrink-0" />
          <input
            ref={urlInputRef}
            type="text"
            value={urlInputValue}
            onChange={(e) => {
              setUrlInputValue(e.target.value);
              if (urlInputError) setUrlInputError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                confirmAddUrl();
              } else if (e.key === 'Escape') {
                setUrlInputVisible(false);
              }
            }}
            onBlur={() => {
              setTimeout(() => {
                if (!urlInputValue.trim()) setUrlInputVisible(false);
              }, 150);
            }}
            placeholder={urlInputError ?? t("composer.urlInputPlaceholder")}
            className={cn("flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50", urlInputError && "placeholder:text-destructive")}
            aria-label={t("composer.urlInputAria")}
            aria-invalid={!!urlInputError}
          />
          <button onClick={confirmAddUrl} className="h-6 px-2 text-[11px] font-medium text-purple-600 hover:text-purple-700 rounded-md hover:bg-purple-500/10 transition-colors shrink-0" aria-label={t("composer.addLinkAria")}>{t("composer.addLinkAria")}</button>
          <button onClick={() => setUrlInputVisible(false)} className="h-6 w-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0" aria-label={t("composer.cancelAddLinkAria")}><XIcon className="size-3.5" /></button>
        </div>
      )}

      {/* 知识库快捷引用输入：与快捷条/运行卡统一样式 */}
      {kbRefVisible && (
        <div className={nestedInCard ? "border-b border-border/30 px-2.5 py-0.5 flex items-center gap-2 min-h-7" : "rounded-lg border border-border/50 bg-card/65 shadow-sm flex items-center gap-2 min-h-8 px-2 py-1.5 mb-0.5"}>
          <DatabaseIcon className="size-3.5 text-emerald-600 shrink-0" />
          <input
            ref={kbRefInputRef}
            type="text"
            value={kbRefPathValue}
            onChange={(e) => setKbRefPathValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                confirmAddKnowledgeRef();
              } else if (e.key === 'Escape') {
                setKbRefVisible(false);
              }
            }}
            onBlur={() => {
              setTimeout(() => {
                if (!kbRefPathValue.trim()) setKbRefVisible(false);
              }, 150);
            }}
            placeholder={t("composer.kbPathPlaceholder")}
            className="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
            aria-label={t("composer.kbPathInputAria")}
          />
          <button onClick={confirmAddKnowledgeRef} className="h-6 px-2 text-[11px] font-medium text-emerald-600 hover:text-emerald-700 rounded-md hover:bg-emerald-500/10 transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1" aria-label={t("composer.addKbRefAria")}>{t("composer.addKbRefAria")}</button>
          <button onClick={() => setKbRefVisible(false)} className="h-6 w-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1" aria-label={t("composer.cancelKbRefAria")}><XIcon className="size-3.5" /></button>
        </div>
      )}

      {/* 主输入区域：聚焦光晕随当前角色色 */}
      <ComposerPrimitive.AttachmentDropzone
        style={
          { "--role-focus": getRoleTheme(activeRoleId).focus } as React.CSSProperties
        }
        className={cn(
          "aui-composer-attachment-dropzone flex w-full flex-col bg-muted/5 outline-none transition-all duration-150 has-[textarea:focus-visible]:border-primary/40 has-[textarea:focus-visible]:bg-background has-[textarea:focus-visible]:shadow-[0_0_0_1px_var(--role-focus),var(--shadow-sm)] data-[dragging=true]:border-primary/50 data-[dragging=true]:bg-primary/5",
          nestedInCard
            ? "border-t border-border/30"
            : "border border-border/40 rounded-xl shadow-elevation-sm ring-1 ring-border/40"
        )}
        onPaste={handlePaste}
      >
        <div ref={composerInputAreaRef} className={cn("relative flex flex-col", nestedInCard ? "min-h-[44px]" : "min-h-[48px]")}>
          <ComposerPrimitive.Input
            placeholder={
              composerText.trim()
                ? ""
                : placeholderOptions[phIdx % placeholderOptions.length]
            }
            className={cn(
              "aui-composer-input max-h-48 w-full resize-none bg-transparent text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/50 focus-visible:ring-0 overflow-y-auto scrollbar-thin scrollbar-thumb-border/40 scrollbar-track-transparent",
              nestedInCard ? "min-h-[44px] px-3 py-2.5" : "min-h-[48px] px-4 py-3"
            )}
            rows={1}
            autoFocus
            aria-label={t("composer.inputAria")}
            aria-describedby="composer-submit-hint"
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
              const v = e.target.value;
              const pos = e.target.selectionStart ?? 0;
              inputValueRef.current = v;
              cursorPositionRef.current = pos;
              setInputMirrorSafe(v);
              setCursorPosition(pos);
            }}
            onSelect={(e: React.SyntheticEvent<HTMLTextAreaElement>) => {
              const target = e.target as HTMLTextAreaElement;
              const pos = target.selectionStart ?? 0;
              cursorPositionRef.current = pos;
              setCursorPosition(pos);
            }}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={(e: React.CompositionEvent<HTMLTextAreaElement>) => {
              isComposingRef.current = false;
              const target = e.target as HTMLTextAreaElement;
              const v = target.value;
              const pos = target.selectionStart ?? 0;
              inputValueRef.current = v;
              cursorPositionRef.current = pos;
              setInputMirrorSafe(v);
              setCursorPosition(pos);
            }}
            onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
              const target = e.target as HTMLTextAreaElement;
              const caretAtStart = (target.selectionStart ?? 0) === 0;
              if (mentionCandidates.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSelectedMentionIndex((i) => Math.min(i + 1, mentionCandidates.length - 1));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSelectedMentionIndex((i) => Math.max(i - 1, 0));
                  return;
                }
                if (e.key === "Enter" && selectedMentionIndex >= 0) {
                  e.preventDefault();
                  handleMentionSelect(mentionCandidates[selectedMentionIndex]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setSelectedMentionIndex(-1);
                  return;
                }
              }
              if (slashSuggestions.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSelectedSlashIndex((i) => Math.min(i + 1, slashSuggestions.length - 1));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSelectedSlashIndex((i) => Math.max(i - 1, 0));
                  return;
                }
                if (e.key === "Enter") {
                  if (selectedSlashIndex >= 0) {
                    e.preventDefault();
                    handleSlashSelect(slashSuggestions[selectedSlashIndex]);
                    return;
                  }
                  // selectedSlashIndex < 0：不拦截，允许直接发送
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setSelectedSlashIndex(-1);
                  return;
                }
              }
              if (!slashSuggestions.length && !mentionCandidates.length && caretAtStart) {
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  if (inputHistory.length === 0) return;
                  if (historyIndex === -1) draftBeforeHistoryRef.current = composerText;
                  const next = historyIndex === -1 ? 0 : Math.min(historyIndex + 1, inputHistory.length - 1);
                  setHistoryIndex(next);
                  const text = inputHistory[next];
                  if (composerRuntime?.setText) composerRuntime.setText(text);
                  inputValueRef.current = text;
                  setInputMirrorSafe(text);
                  setCursorPosition(text.length);
                  cursorPositionRef.current = text.length;
                  return;
                }
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  if (historyIndex <= 0) {
                    setHistoryIndex(-1);
                    const draft = historyIndex === -1 ? draftBeforeHistoryRef.current : composerText;
                    const d = draft ?? "";
                    if (composerRuntime?.setText) composerRuntime.setText(d);
                    inputValueRef.current = d;
                    setInputMirrorSafe(d);
                    setCursorPosition(d.length);
                    cursorPositionRef.current = d.length;
                    return;
                  }
                  const next = historyIndex - 1;
                  setHistoryIndex(next);
                  const text = inputHistory[next];
                  if (composerRuntime?.setText) composerRuntime.setText(text);
                  inputValueRef.current = text;
                  setInputMirrorSafe(text);
                  setCursorPosition(text.length);
                  cursorPositionRef.current = text.length;
                  return;
                }
              }
              // Cursor 一致：回车发送，Shift+Enter 换行
              if (!isComposingRef.current && e.key === "Enter" && !e.shiftKey && !mentionCandidates.length && !slashSuggestions.length) {
                e.preventDefault();
                const text = composerText.trim();
                if (text) {
                  if (isStreaming && onEnqueue) {
                    onEnqueue(text);
                    if (composerRuntime?.setText) composerRuntime.setText("");
                    inputValueRef.current = "";
                    setInputMirrorSafe("");
                    setCursorPosition(0);
                    toast.success(t("composer.enqueued"));
                  } else if (!isStreaming && !sendDisabled && sendButtonRef.current) {
                    sendButtonRef.current.click();
                  }
                }
              }
            }}
          />
          {dropdownAnchorRect && slashSuggestions.length > 0 && createPortal(
            <div
              className="rounded-md border bg-background/95 shadow-lg overflow-auto"
              style={{
                position: "fixed",
                left: dropdownAnchorRect.left,
                bottom: typeof window !== "undefined" ? window.innerHeight - dropdownAnchorRect.top + 4 : 0,
                width: Math.max(dropdownAnchorRect.width, 280),
                maxHeight: "min(70vh, 420px)",
                zIndex: 9999,
              }}
            >
              {slashSuggestions.map((item, i) => (
                <button
                  key={`${item.cmd}::${item.plugin || "builtin"}`}
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between px-2 py-1.5 text-left text-xs hover:bg-muted/60",
                    i === selectedSlashIndex && "bg-muted/60"
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSlashSelect(item);
                  }}
                >
                  <span className="font-mono text-[11px]">{item.cmd}</span>
                  <span className="text-muted-foreground truncate flex items-center gap-1.5">
                    {item.plugin ? (
                      <>
                        {item.conflict && (item.plugins?.length ?? 0) > 1 ? (
                          <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400" title={t("plugin.commandConflictHint")}>{t("plugin.commandConflictLabel")} · {item.plugins!.join(" / ")}</span>
                        ) : (
                          <span className="shrink-0 text-[10px] text-muted-foreground/70">来自 {item.plugin}</span>
                        )}
                        <span className="truncate">{item.desc}</span>
                      </>
                    ) : (
                      item.desc
                    )}
                  </span>
                </button>
              ))}
              <div className="border-t border-border/40 px-2 py-1.5 text-[10px] text-muted-foreground">模板</div>
              {promptTemplates.filter((t) => !t.modes || t.modes.length === 0 || t.modes.includes(mode)).slice(0, 8).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/60"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleTemplateSelect(t);
                  }}
                >
                  <FileIcon className="size-3 text-muted-foreground" />
                  <span className="truncate">{t.label}</span>
                </button>
              ))}
            </div>,
            document.body
          )}
          {dropdownAnchorRect && mentionOpen && mentionCandidates.length > 0 && createPortal(
            <div
              className="rounded-md border bg-background/95 shadow-lg overflow-auto"
              style={{
                position: "fixed",
                left: dropdownAnchorRect.left,
                bottom: typeof window !== "undefined" ? window.innerHeight - dropdownAnchorRect.top + 4 : 0,
                width: Math.max(dropdownAnchorRect.width, 280),
                maxHeight: "min(60vh, 360px)",
                zIndex: 9999,
              }}
            >
              {mentionCandidates.map((item, i) => (
                <button
                  key={`${item.type}-${item.id}`}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/60",
                    i === selectedMentionIndex && "bg-muted/60"
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleMentionSelect(item);
                  }}
                >
                  {item.type === "role" && <BrainIcon className="size-3 text-muted-foreground shrink-0" />}
                  {item.type === "task" && <ListTodoIcon className="size-3 text-muted-foreground shrink-0" />}
                  {item.type === "file" && <FileIcon className="size-3 text-muted-foreground shrink-0" />}
                  <span className="flex flex-col min-w-0">
                    <span className="truncate">{item.label}</span>
                    {(item as { sub?: string }).sub && (
                      <span className="text-[10px] text-muted-foreground/60 truncate">{(item as { sub?: string }).sub}</span>
                    )}
                  </span>
                </button>
              ))}
            </div>,
            document.body
          )}
        </div>
        <div className={cn("flex items-center gap-2 border-t border-border/20 bg-muted/20 min-w-0 overflow-hidden", nestedInCard ? "min-h-8 px-2.5" : "min-h-9 px-3")}>
          <span id="composer-submit-hint" className="sr-only" aria-hidden="false">{t("composer.submitHint")}</span>
          {/* 左侧：模式 | 模型 | 联网（Cursor 对齐：主栏仅模式名+模型+图标） */}
          <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
            {/* 模式选择（Cursor 风格：仅文字标签） */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <DropdownMenu open={modeMenuOpen} onOpenChange={setModeMenuOpen}>
                    <DropdownMenuTrigger asChild>
                      <button
                        className={cn(
                          "h-8 min-h-8 px-2 text-[11px] font-medium rounded-md flex items-center gap-1 min-w-0 max-w-24 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                          modeMenuOpen ? "bg-muted text-foreground" : "hover:bg-muted/80"
                        )}
                        aria-label={`模式：${CHAT_MODES.find(m => m.id === mode)?.label || 'Agent'}`}
                        title={`模式=本次怎么跑 · ${CHAT_MODES.find(m => m.id === mode)?.label || 'Agent'}（${getModeShortcut(mode, fourthMode) || '无快捷键'}） · ${roleModeHint}`}
                      >
                        <span className={cn(
                          "truncate",
                          mode === 'agent' && 'text-violet-600 dark:text-violet-400',
                          mode === 'plan' && 'text-blue-600 dark:text-blue-400',
                          mode === 'ask' && 'text-emerald-600 dark:text-emerald-400',
                          mode === 'debug' && 'text-amber-600 dark:text-amber-400',
                          mode === 'review' && 'text-teal-600 dark:text-teal-400',
                          !VALID_CHAT_MODES.includes(mode) && 'text-muted-foreground',
                        )}>
                          {CHAT_MODES.find(m => m.id === mode)?.label || 'Agent'}
                        </span>
                        <ChevronDownIcon className="size-3 text-muted-foreground/60 shrink-0" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-48">
                {menuModes.map(m => (
                  <DropdownMenuItem 
                    key={m.id} 
                    onClick={() => handleModeChange(m.id)}
                    className={cn("text-[12px] gap-2 py-2 flex items-center", mode === m.id && "bg-accent/60")}
                  >
                    <span className={m.color}>{m.icon}</span>
                    <span className="flex-1 font-medium">{m.label}</span>
                    {getModeShortcut(m.id, fourthMode) && (
                      <span className="text-[11px] text-muted-foreground/60 font-mono">{getModeShortcut(m.id, fourthMode)}</span>
                    )}
                    {mode === m.id && <CheckIcon className="ml-auto size-3 text-primary shrink-0" />}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <div className="px-2 py-1.5 text-[10px] text-muted-foreground space-y-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="cursor-default rounded px-0.5 py-0.5 -mx-0.5 -my-0.5">{t("composer.roleLabel")}</div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}>{t("composer.roleTooltip")}</TooltipContent>
                  </Tooltip>
                  <div>{roleModeHint}（⌘4）</div>
                </div>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>模式：怎么跑（本次对话的执行方式）</TooltipContent>
            </Tooltip>

            {/* 联网三态：仅图标，文案收进 Tooltip（Cursor 对齐） */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleGlobeClick}
                  className={cn(
                    "h-8 min-h-8 w-8 rounded-md flex items-center justify-center shrink-0 transition-colors",
                    researchMode ? "text-violet-500 bg-violet-500/10 hover:bg-violet-500/20" :
                    webSearchEnabled ? "text-blue-500 bg-blue-500/10 hover:bg-blue-500/20" :
                    "text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/80"
                  )}
                  title={researchMode ? "当前：深度研究（联网+深研），点击切换为关" : webSearchEnabled ? "当前：联网搜索，点击切换为深度研究" : "当前：关，点击开启联网搜索"}
                  aria-label={researchMode ? "深度研究" : webSearchEnabled ? "联网搜索已开启" : "联网搜索已关闭"}
                >
                  <GlobeIcon className="size-3.5 shrink-0" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                <p className="font-medium mb-1">{researchMode ? "深度研究" : webSearchEnabled ? "联网搜索" : "关"}</p>
                <p className="text-[11px] text-muted-foreground">关：不联网 · 联网搜索：可查网络 · 深度研究：联网+深研。点击循环切换。</p>
              </TooltipContent>
            </Tooltip>
            {/* 模型选择 */}
            <ModelSelector className="h-8 min-h-8" />
          </div>
          
          {/* 右侧：附件 | 快捷键帮助 | 上下文统计 | 发送 */}
          <div className="flex items-center gap-1.5 shrink-0">
            {/* 附件（添加上下文） */}
            <DropdownMenu open={contextMenuOpen} onOpenChange={setContextMenuOpen}>
              <Tooltip>
                <DropdownMenuTrigger asChild>
                  <TooltipTrigger asChild>
                    <button
                      className={cn(
                        "h-8 min-h-8 w-8 rounded-md flex items-center justify-center shrink-0 transition-colors",
                        contextMenuOpen 
                          ? "text-foreground bg-muted" 
                          : "text-muted-foreground/70 hover:text-foreground hover:bg-muted"
                      )}
                      aria-label={t("composer.addContextAria")}
                    >
                      <PlusIcon className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                </DropdownMenuTrigger>
                <TooltipContent side="top" sideOffset={4}>{t("composer.addContextTooltip")}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuItem onClick={() => { openFileSelector(); setContextMenuOpen(false); }} className="text-xs gap-2">
                  <FileIcon className="size-3.5 text-blue-500" />
                  <span className="flex-1">添加文件</span>
                  <span className="text-[10px] text-muted-foreground/60 font-mono">⌘P</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { handleAddWorkspaceFile(); setContextMenuOpen(false); }} className="text-xs gap-2">
                  <FileIcon className="size-3.5 text-sky-500" />
                  <span>从已打开文件选择</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { handleAddWorkspaceFileFromTree(); setContextMenuOpen(false); }} className="text-xs gap-2">
                  <FileIcon className="size-3.5 text-sky-600" />
                  <span>从工作区浏览文件</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { handleAddFolder(); setContextMenuOpen(false); }} className="text-xs gap-2">
                  <FolderIcon className="size-3.5 text-amber-500" />
                  <span>添加文件夹</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { handleAddCode(); setContextMenuOpen(false); }} className="text-xs gap-2">
                  <CodeIcon className="size-3.5 text-emerald-500" />
                  <span>{t("composer.addCodeSnippet")}</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { handleAddUrl(); setContextMenuOpen(false); }} className="text-xs gap-2">
                  <LinkIcon className="size-3.5 text-purple-500" />
                  <span>添加网页链接</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { handleAddKnowledgeRef(); setContextMenuOpen(false); }} className="text-xs gap-2">
                  <DatabaseIcon className="size-3.5 text-emerald-600" />
                  <span>从知识库引用</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => { openImageSelector(); setContextMenuOpen(false); }} className="text-xs gap-2">
                  <ImageIcon className="size-3.5 text-pink-500" />
                  <span className="flex-1">添加图片</span>
                  <span className="text-[10px] text-muted-foreground/60 font-mono">⌘V</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            
            {/* Cursor 一致：运行状态由 footer 状态行展示，此处仅上传/连接/上下文 + 发送；不重复“发送中” */}
            <div className="flex items-center gap-2 shrink-0">
            {hasUploadingContext && (
              <span className="text-[10px] text-muted-foreground/70 tabular-nums">
                上传中 {uploadingContextCount}
              </span>
            )}
            {!connectionHealthy && (
              <span className="flex items-center gap-1.5 text-[11px] text-destructive/90">
                {t("connection.disconnected")}
                <button
                  type="button"
                  className="underline hover:no-underline transition-colors"
                  onClick={() => window.dispatchEvent(new CustomEvent(EVENTS.CONNECTION_RETRY_REQUEST))}
                >
                  {t("connection.retry")}
                </button>
              </span>
            )}
            <ContextStatsDisplay
              contextItemsCount={contextItems.length}
              onRemoveHeavyContextItem={removeHeavyContextItem}
              liveInputTokens={liveInputTokens}
            />
            {(() => {
              const sendButtonBgClass = MODE_SEND_BUTTON_BG[mode as ChatMode] ?? MODE_SEND_BUTTON_BG.agent;
              const hasInputForQueue = composerText.trim().length > 0;
              const sendButtonBaseClass = "h-8 w-8 min-h-8 min-w-8 rounded-md flex items-center justify-center transition-all duration-150 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";
              const sendButtonActiveClass = "hover:scale-[1.02] active:scale-[0.98] disabled:hover:scale-100 disabled:active:scale-100";
              return (
                <div className="h-8 w-8 min-h-8 min-w-8 shrink-0 flex items-center justify-center">
                  <ThreadPrimitive.If running>
                    {hasInputForQueue && onEnqueue ? (
                      <button
                        type="button"
                        onClick={() => {
                          const content = composerText.trim();
                          if (!content) return;
                          onEnqueue(content);
                          if (composerRuntime?.setText) composerRuntime.setText("");
                          inputValueRef.current = "";
                          setInputMirrorSafe("");
                          setCursorPosition(0);
                          toast.success(t("composer.enqueued"));
                        }}
                        className={cn(
                          sendButtonBaseClass,
                          sendButtonActiveClass,
                          "shadow-sm",
                          sendButtonBgClass
                        )}
                        title={t("composer.sendToQueue")}
                        aria-label={t("composer.sendToQueue")}
                      >
                        <ArrowUpIcon className="size-4 shrink-0" />
                      </button>
                    ) : (
                      <ComposerPrimitive.Cancel asChild>
                        <button
                          onClick={handleCancel}
                          className={cn(
                            sendButtonBaseClass,
                            sendButtonActiveClass,
                            "bg-muted hover:bg-muted/80 text-foreground"
                          )}
                          title={t("composer.stopAria")}
                          aria-label={t("composer.stopAria")}
                        >
                          <SquareIcon className="size-3 fill-current shrink-0" />
                        </button>
                      </ComposerPrimitive.Cancel>
                    )}
                  </ThreadPrimitive.If>
                  <ThreadPrimitive.If running={false}>
                    <ComposerPrimitive.Send asChild>
                      <button
                        ref={sendButtonRef}
                        data-action="composer-send"
                        disabled={sendDisabled}
                        onClick={() => {
                          flushContextBeforeSend();
                          pushInputHistory();
                        }}
                        className={cn(
                          sendButtonBaseClass,
                          sendButtonActiveClass,
                          sendDisabled ? "bg-muted text-muted-foreground hover:bg-muted/80" : cn("shadow-sm", sendButtonBgClass)
                        )}
                        title={
                          hasUploadingContext
                            ? `有 ${uploadingContextCount} 个附件正在上传`
                            : !connectionHealthy
                              ? t("connection.disabledHint") + "（可尝试发送）"
                              : t("composer.sendAria")
                        }
                        aria-label={t("composer.sendAria")}
                      >
                        <ArrowUpIcon className="size-4 shrink-0" />
                      </button>
                    </ComposerPrimitive.Send>
                  </ThreadPrimitive.If>
                </div>
              );
            })()}
            </div>
          </div>
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
    </div>
  );
};

export const CursorStyleComposer = React.memo(CursorStyleComposerInner);
export default CursorStyleComposer;
