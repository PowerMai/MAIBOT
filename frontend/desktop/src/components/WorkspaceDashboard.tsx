/**
 * WorkspaceDashboard - 工作区仪表盘（核心价值版）
 * 
 * 参考顶级产品设计：
 * - Accomplish: 大输入框 + 示例提示词 + 命令面板
 * - Cursor: 快速操作 + 项目管理 + 键盘导航
 * - Linear/Notion: 项目看板 + 进度追踪
 * 
 * 核心交互价值：
 * 1. 任务输入框 - 直接描述任务，AI 自动执行
 * 2. 示例提示词 - 一键启动常见任务
 * 3. 命令面板 (⌘K) - 快速搜索和启动
 * 4. 项目列表 - 继续未完成的工作
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { remarkPluginsWithMath, rehypePluginsMath } from '../lib/markdownRender';
import { motion } from 'motion/react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Progress } from './ui/progress';
import { ScrollArea } from './ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import {
  FileText,
  FileCode,
  RefreshCw,
  Play,
  Plus,
  FileSearch,
  BarChart3,
  Search,
  X,
  History,
  Scale,
  AlertCircle,
  FolderOpen,
  Database,
  Sparkles,
  Image,
  ListTodo,
  ChevronDown,
  ChevronUp,
  Send,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAggregatedErrors } from '../lib/hooks/useAggregatedErrors';
import { listThreads } from '../lib/api/langserveChat';
import { boardApi, type BoardTask, type RoleDefinition, type CollaborationMetricRow, type ReleaseGateSummary } from '../lib/api/boardApi';
import { generateBriefing, getLicenseStatus, getWorkSuggestions, listPlugins, type BriefingPayload, type WorkSuggestion } from '../lib/api/systemApi';
import { skillsAPI, type MarketSkillItem } from '../lib/api/skillsApi';
import { isHandledApiError } from '../lib/api/errorHandler';
import { EVENTS, SESSION_SWITCH_TIMEOUT_MS, type SessionChangedDetail } from '../lib/constants';
import { userModelApi } from '../lib/api/userModelApi';
import { getLicenseTier, getTierCapabilities, licenseTierRank, type LicenseTier } from '../lib/licenseTier';
import {
  getTaskStatusBadgeClass,
  getTaskStatusLabel,
  inferTaskDispatchStage,
  resolveTaskPrimaryEntryAction,
} from '../lib/taskDispatchStage';
import { getItem as getStorageItem, setItem as setStorageItem } from '../lib/safeStorage';
import { getCurrentWorkspacePathFromStorage } from '../lib/sessionState';
import { getCurrentThreadIdFromStorage } from '../lib/runSummaryState';
import { useRunSummarySync } from '../lib/hooks/useRunSummarySync';
import { resolveScopedChatMode, setScopedChatMode } from '../lib/chatModeState';
import { useShallow } from 'zustand/react/shallow';
import { useTaskStore } from '../store/taskStore';
import { useDashboardBriefingStore } from '../store/dashboardBriefingStore';
import { useDashboardMetaStore } from '../store/dashboardMetaStore';
import { useDashboardDataStore, type RawThread } from '../store/dashboardDataStore';
import { getScopedActiveRoleIdFromStorage } from '../lib/roleIdentity';
import { cn } from './ui/utils';
import { Skeleton } from './ui/skeleton';
import { t } from '../lib/i18n';
import { RoleContextBadgeGroup } from './RoleContextBadgeGroup';

// ============================================================================
// 动画配置（参考 Accomplish）
// ============================================================================

const springs = {
  bouncy: { type: 'spring', stiffness: 400, damping: 25 },
  gentle: { type: 'spring', stiffness: 300, damping: 30 },
  snappy: { type: 'spring', stiffness: 500, damping: 30 },
} as const;

const staggerContainer = {
  initial: {},
  animate: {
    transition: {
      staggerChildren: 0.05,
      delayChildren: 0.1,
    },
  },
};

const staggerItem = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
};

const SECTION_LABEL_CLASS = "text-[11px] font-medium leading-4 text-muted-foreground/90 mb-1.5";
const SECTION_TITLE_CLASS = "text-xs font-medium text-foreground/90 inline-flex items-center gap-2 leading-5";
const SECTION_ICON_CLASS = "h-3.5 w-3.5 shrink-0 text-muted-foreground/80";
const HEADER_ACTION_BUTTON_CLASS = "h-6 px-2 text-xs font-medium text-muted-foreground/85 hover:text-foreground";
const HEADER_ACTION_ICON_CLASS = "h-3 w-3 text-muted-foreground/80";
const PRIMARY_ACTION_BUTTON_CLASS = "h-8 px-3 text-xs font-medium pointer-events-auto";
const OUTLINE_ACTION_BUTTON_CLASS = "h-8 px-3 text-xs font-medium text-muted-foreground/90 pointer-events-auto";
const INLINE_GHOST_ACTION_BUTTON_CLASS =
  "h-6 px-2 text-xs font-medium text-muted-foreground/85 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";
const INTERACTIVE_CARD_BUTTON_CLASS =
  "text-left rounded-lg border border-border/50 text-xs transition-colors hover:bg-muted/40 active:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
const INTERACTIVE_ROW_BUTTON_CLASS =
  "w-full text-left flex items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-muted/40 active:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
const SOFT_PANEL_CLASS = "rounded-lg border border-border/50 bg-card/25 px-3 py-2";
const SOFT_DASHED_PANEL_CLASS = "rounded-lg border border-dashed border-border/50 bg-card/25 px-3 py-2";
const CHIP_CLASS = "inline-flex items-center rounded-md border border-border/50 bg-card/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground";
const CHIP_BUTTON_CLASS = cn(CHIP_CLASS, "cursor-pointer hover:bg-card/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1");
const BADGE_CLASS = "rounded-md text-[10px] font-medium shrink-0";
const SUBTLE_TAG_CLASS = "inline-flex items-center rounded-md border border-border/50 bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground shrink-0";
const STATUS_DOT_CLASS = "w-2 h-2 rounded-full shrink-0";
const RECOVERY_ACTION_STATS_KEY = "maibot_recovery_action_stats";
const DASHBOARD_CACHE_KEY = "maibot_workspace_dashboard_cache";
const DASHBOARD_CACHE_TTL_MS = 20_000;

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const d = new Date(ts);
  const todayStart = new Date(now).setHours(0, 0, 0, 0);
  const diff = now - ts;
  if (diff < 60_000) return t("common.justNow");
  if (ts >= todayStart) return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const yesterdayStart = todayStart - 86400_000;
  if (ts >= yesterdayStart) return t("common.yesterday");
  if (diff < 7 * 86400_000) return t(`common.weekday${d.getDay()}` as "common.weekday0");
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function switchThreadThen(threadId: string, next?: () => void) {
  const targetThreadId = String(threadId || "").trim();
  if (!targetThreadId) {
    next?.();
    return;
  }
  let done = false;
  let forceRemoveTimer: ReturnType<typeof setTimeout> | null = null;
  const finish = () => {
    if (done) return;
    done = true;
    window.removeEventListener(EVENTS.SESSION_CHANGED, onSessionChanged as EventListener);
    window.clearTimeout(fallbackTimer);
    if (forceRemoveTimer != null) {
      window.clearTimeout(forceRemoveTimer);
      forceRemoveTimer = null;
    }
    next?.();
  };
  const onSessionChanged = (event: Event) => {
    const detail = (event as CustomEvent<SessionChangedDetail>).detail;
    if (String(detail?.threadId || "").trim() === targetThreadId) {
      finish();
    }
  };
  const fail = () => {
    if (done) return;
    done = true;
    window.removeEventListener(EVENTS.SESSION_CHANGED, onSessionChanged as EventListener);
    window.clearTimeout(fallbackTimer);
    toast.error(t("dashboard.switchSessionFail"), { description: t("dashboard.switchSessionFailDesc") });
  };
  const fallbackTimer = window.setTimeout(fail, SESSION_SWITCH_TIMEOUT_MS);
  window.addEventListener(EVENTS.SESSION_CHANGED, onSessionChanged as EventListener);
  window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_TO_THREAD, { detail: { threadId: targetThreadId } }));
}

// ============================================================================
// 类型定义
// ============================================================================

type ProjectStatus = 'active' | 'paused' | 'completed';

const MODE_LABELS: Record<string, string> = {
  agent: 'Agent',
  plan: 'Plan',
  ask: 'Ask',
  debug: 'Debug',
  review: 'Review',
};

interface Project {
  id: string;
  title: string;
  status: ProjectStatus;
  lastActivity: Date;
  messageCount: number;
  aiSummary?: string;
  /** 线程 metadata 中的角色 ID，用于显示角色标签 */
  activeRoleId?: string;
  /** 最后使用的模式，用于显示模式标签 */
  lastMode?: string;
}

interface UseCaseExample {
  id: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  prompt: string;
  category: string;
}

interface WorkspaceDashboardProps {
  workspacePath?: string;
  workspaceName?: string;
  openFiles?: Array<{ id: string; name: string; path: string; format: string }>;
  onOpenFile?: (path: string) => void;
  onNewProject?: () => void;
  onContinueProject?: (projectId: string) => void;
  onSubmitTask?: (prompt: string) => void;
  onRefresh?: () => void;
}

type DashboardDataCache = {
  updatedAt: number;
  rawThreads?: RawThread[];
  workSuggestions?: WorkSuggestion[];
  briefing?: BriefingPayload | null;
  boardTasks?: BoardTask[];
  collaborationRows?: CollaborationMetricRow[];
  latestReleaseGateSummary?: ReleaseGateSummary | null;
};

// ============================================================================
// 通用快捷任务（与角色无关）
// ============================================================================

interface QuickTask {
  id: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  prompt?: string;
  titleKey?: string;
  descriptionKey?: string;
  promptKey?: string;
  executionMode?: 'create_task' | 'chat_prompt';
  action?: 'continue';
}

const COMMON_QUICK_TASKS: QuickTask[] = [
  {
    id: 'workspace-summary',
    icon: <FolderOpen className="h-5 w-5" />,
    title: '整理工作区资料',
    description: '扫描工作区文件并生成摘要',
    prompt: '请扫描当前工作区文件并生成摘要，包括目录结构和关键文件说明。',
    titleKey: 'dashboard.quickTask.workspaceSummary.title',
    descriptionKey: 'dashboard.quickTask.workspaceSummary.description',
    promptKey: 'dashboard.quickTask.workspaceSummary.prompt',
    executionMode: 'create_task',
  },
  {
    id: 'knowledge-overview',
    icon: <Database className="h-5 w-5" />,
    title: '查看知识库概览',
    description: '展示知识图谱和已学习内容统计',
    prompt: '请展示知识图谱和已学习内容统计。',
    titleKey: 'dashboard.quickTask.knowledgeOverview.title',
    descriptionKey: 'dashboard.quickTask.knowledgeOverview.description',
    promptKey: 'dashboard.quickTask.knowledgeOverview.prompt',
    executionMode: 'create_task',
  },
  {
    id: 'continue-last',
    icon: <History className="h-5 w-5" />,
    title: '继续上次的工作',
    description: '恢复最近的对话',
    titleKey: 'dashboard.quickTask.continueLast.title',
    descriptionKey: 'dashboard.quickTask.continueLast.description',
    action: 'continue',
  },
];

/** 保留用于命令面板的示例（兼容） */
const USE_CASE_EXAMPLES: UseCaseExample[] = [
  { id: 'office-doc', icon: <FileText className="h-5 w-5" />, title: '文档处理', description: '文档读写、格式转换、会议纪要', prompt: '请帮我整理这份文档，优化格式和内容结构，并生成摘要。', category: '日常办公' },
  { id: 'report-writing', icon: <BarChart3 className="h-5 w-5" />, title: '报告生成', description: '周报月报、数据汇总', prompt: '请根据这些数据生成一份分析报告。', category: '报告汇报' },
  { id: 'research-brief', icon: <Search className="h-5 w-5" />, title: '研究简报', description: '多源资料检索、结论归纳', prompt: '请围绕这个主题做深度研究，并给出结论、证据和行动建议。', category: '研究分析' },
  { id: 'data-insight', icon: <Database className="h-5 w-5" />, title: '数据洞察', description: '指标分析、异常发现、解释建议', prompt: '请分析这批数据，指出关键趋势、异常点和可执行改进建议。', category: '数据分析' },
  { id: 'code-review', icon: <FileCode className="h-5 w-5" />, title: '代码与开发', description: '代码审查、Bug 修复', prompt: '请审查这段代码，检查 bug 和性能问题。', category: '开发' },
];

// ============================================================================
// 辅助函数
// ============================================================================

const formatTime = (date: Date): string => {
  const ts = date.getTime();
  if (!Number.isFinite(ts)) return '—';
  const now = new Date();
  const diff = now.getTime() - ts;
  if (!Number.isFinite(diff) || diff < 0) return '—';
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (!Number.isFinite(minutes)) return '—';
  if (minutes < 1) return t("common.justNow");
  if (minutes < 60) return t("common.minutesAgo", { n: minutes });
  if (hours < 24) return t("common.hoursAgo", { n: hours });
  if (days < 7) return t("common.daysAgo", { n: days });
  return date.toLocaleDateString('zh-CN');
};

const resolveCurrentRoleId = (): string => {
  return getScopedActiveRoleIdFromStorage();
};

const getDashboardCacheKey = (workspacePath?: string): string =>
  `${DASHBOARD_CACHE_KEY}:${String(workspacePath || "__global__").trim() || "__global__"}`;

const loadDashboardCache = (workspacePath?: string): DashboardDataCache | null => {
  try {
    const raw = getStorageItem(getDashboardCacheKey(workspacePath));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DashboardDataCache;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.updatedAt !== "number") return null;
    if (Date.now() - parsed.updatedAt > DASHBOARD_CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
};

const saveDashboardCache = (workspacePath: string | undefined, cache: DashboardDataCache) => {
  try {
    setStorageItem(getDashboardCacheKey(workspacePath), JSON.stringify(cache));
  } catch {
    // ignore cache write failure
  }
};

const patchDashboardCache = (
  workspacePath: string | undefined,
  patch: Partial<DashboardDataCache>
) => {
  try {
    const key = getDashboardCacheKey(workspacePath);
    const raw = getStorageItem(key);
    const prev = raw ? JSON.parse(raw) : {};
    const base = prev && typeof prev === "object" ? prev : {};
    setStorageItem(
      key,
      JSON.stringify({
        ...base,
        ...patch,
        updatedAt: Date.now(),
      })
    );
  } catch {
    // ignore cache write failure
  }
};

const getStatusConfig = (status: ProjectStatus) => ({
  active: { color: 'bg-emerald-500', text: t("dashboard.statusActive") },
  paused: { color: 'bg-amber-500', text: t("dashboard.statusPaused") },
  completed: { color: 'bg-blue-500', text: t("dashboard.statusCompleted") },
}[status]);

const summarizeFailures = (rows: string[]): string[] => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const counts = new Map<string, number>();
  for (const raw of rows) {
    const text = String(raw || "").trim();
    if (!text) continue;
    counts.set(text, (counts.get(text) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([text, count]) => (count > 1 ? `${text} ×${count}` : text))
    .slice(0, 3);
};

// ============================================================================
// 子组件：快捷任务卡片（第二行）
// ============================================================================

interface QuickTaskCardProps {
  task: QuickTask;
  onClick: () => void;
  disabled?: boolean;
  creating?: boolean;
}

const QuickTaskCard = React.memo<QuickTaskCardProps>(({ task, onClick, disabled, creating }) => {
  const modeLabel = task.executionMode === 'create_task' ? t("dashboard.quickTask.modeCreateTask") : t("dashboard.quickTask.modeChatPrompt");
  const fullTitle = [task.title, task.description].filter(Boolean).join('\n');
  return (
    <motion.button
      type="button"
      variants={staggerItem}
      transition={springs.gentle}
      whileHover={disabled ? undefined : { scale: 1.02, transition: { duration: 0.15 } }}
      whileTap={disabled ? undefined : { scale: 0.98 }}
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-[108px] flex-col items-start gap-2 p-3 rounded-xl border border-border/50 bg-card/50 hover:border-primary/50 hover:bg-card/80 transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-70 disabled:pointer-events-none"
      aria-label={task.title}
      title={fullTitle || undefined}
    >
      <div className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary [&>svg]:h-4 [&>svg]:w-4 [&>svg]:align-middle">
        {creating ? <Skeleton className="h-4 w-4 rounded" /> : task.icon}
      </div>
      <div className="font-semibold text-[12px] leading-4 tracking-tight line-clamp-1">{task.title}</div>
      {!task.action && <span className={SUBTLE_TAG_CLASS}>{modeLabel}</span>}
      <div className="text-[11px] leading-4 text-muted-foreground line-clamp-2">
        {task.description}
      </div>
    </motion.button>
  );
});

// ============================================================================
// 子组件：用例示例卡片（命令面板用）
// ============================================================================

interface ExampleCardProps {
  example: UseCaseExample;
  onClick: () => void;
}

const ExampleCard = React.memo<ExampleCardProps>(({ example, onClick }) => (
    <motion.button
      type="button"
      variants={staggerItem}
      transition={springs.gentle}
      whileHover={{ scale: 1.02, transition: { duration: 0.15 } }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className="flex min-h-[108px] flex-col items-start gap-2 p-3 rounded-xl border border-border/50 bg-card/50 hover:border-primary/50 hover:bg-card/80 transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      aria-label={example.title}
    >
      <div className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {example.icon}
      </div>
      <div className="font-semibold text-[12px] leading-4 tracking-tight line-clamp-1">{example.title}</div>
      <div className="text-[11px] leading-4 text-muted-foreground line-clamp-2">
        {example.description}
      </div>
    </motion.button>
));

// ============================================================================
// 子组件：项目列表项
// ============================================================================

interface ProjectListItemProps {
  project: Project;
  roleLabel?: string;
  modeLabel?: string;
  isSelected?: boolean;
  onClick: () => void;
  onContinue: () => void;
}

const ProjectListItem = React.memo<ProjectListItemProps>(({
  project,
  roleLabel,
  modeLabel,
  isSelected,
  onClick,
  onContinue,
}) => {
  const statusConfig = getStatusConfig(project.status);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <motion.div
      variants={staggerItem}
      transition={springs.gentle}
      role="button"
      tabIndex={0}
      aria-label={project.title}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      className={`group flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
        isSelected ? 'bg-primary/10 shadow-sm' : 'hover:bg-muted/60 hover:shadow-sm'
      }`}
    >
      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusConfig.color}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          {roleLabel && (
            <span className={SUBTLE_TAG_CLASS}>
              {roleLabel}
            </span>
          )}
          {modeLabel && (
            <span className={cn(SUBTLE_TAG_CLASS, "text-muted-foreground/85")}>
              {modeLabel}
            </span>
          )}
          <span className="text-[13px] font-medium truncate">{project.title}</span>
        </div>
        <div className="text-[11px] text-muted-foreground/70 flex items-center gap-1.5 mt-0.5">
          <span>{formatTime(project.lastActivity)}</span>
          <span className="text-border">·</span>
          <span>{project.messageCount} 条消息</span>
          {project.aiSummary && (
            <>
              <span className="text-border">·</span>
              <span className="truncate">{project.aiSummary}</span>
            </>
          )}
        </div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className={INLINE_GHOST_ACTION_BUTTON_CLASS}
        onClick={(e) => {
          e.stopPropagation();
          onContinue();
        }}
        aria-label={t("a11y.continueConversation")}
      >
        <Play className="h-3 w-3 mr-1" />
        继续
      </Button>
    </motion.div>
  );
});

// ============================================================================
// 简报卡片 / 工作建议卡片 / 看板任务行 / 技能卡片（memo 减少重渲染）
// ============================================================================

interface BriefingCardItem {
  type?: string;
  title?: string;
  summary?: string;
}

const BriefingCard = React.memo<{
  card: BriefingCardItem;
  index: number;
  onSelect: (hint: string) => void;
}>(({ card, index, onSelect }) => (
  <button
    type="button"
    className="rounded-xl border border-border/50 bg-card/40 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
    onClick={() => onSelect(`${card.title ?? ''}${card.summary ? `：${card.summary}` : ''}`)}
  >
    <p className="text-[11px] font-medium text-foreground/90">{card.title}</p>
    <p className="mt-1 text-[11px] text-muted-foreground line-clamp-3">
      {card.summary || t('dashboard.briefingCardExpand')}
    </p>
  </button>
));

const WorkSuggestionCard = React.memo<{
  suggestion: WorkSuggestion;
  onSelect: (s: WorkSuggestion) => void;
}>(({ suggestion, onSelect }) => (
  <button
    type="button"
    onClick={() => onSelect(suggestion)}
    className={cn(INTERACTIVE_CARD_BUTTON_CLASS, 'w-full px-3 py-2 bg-card/30')}
    title={suggestion.description}
  >
    <div className="flex items-center gap-1.5">
      <span className="font-medium line-clamp-1">{suggestion.title}</span>
      {String(suggestion.type || '').includes('intent_resume') && (
        <span className="inline-flex items-center rounded border border-amber-500/30 px-1 text-[10px] text-amber-600 dark:text-amber-400">
          上次未完成
        </span>
      )}
      {String(suggestion.type || '').includes('autonomous') && (
        <span className="inline-flex items-center rounded border border-primary/30 px-1 text-[10px] text-primary">
          自主准备
        </span>
      )}
    </div>
    {suggestion.description ? (
      <p className="mt-1 text-[11px] text-muted-foreground line-clamp-2">{suggestion.description}</p>
    ) : null}
  </button>
));

const BoardTaskRow = React.memo<{
  task: BoardTask;
  onOpen: (task: BoardTask) => void;
}>(({ task, onOpen }) => {
  const status = task.status ?? 'available';
  const dispatchStage = inferTaskDispatchStage(task);
  const primaryEntry = resolveTaskPrimaryEntryAction(task);
  return (
    <button
      type="button"
      onClick={() => onOpen(task)}
      className={INTERACTIVE_ROW_BUTTON_CLASS}
      aria-label={`${primaryEntry.label}：${task.subject}`}
      title={primaryEntry.reason}
    >
      <ListTodo className="h-4 w-4 text-violet-500 shrink-0" />
      <span className="truncate flex-1">{task.subject ?? t('dashboard.taskSubjectFallback')}</span>
      <Badge variant="outline" className={BADGE_CLASS}>{primaryEntry.label}</Badge>
      <Badge variant="outline" className={cn(BADGE_CLASS, dispatchStage.className)}>{dispatchStage.label}</Badge>
      {(task.updated_at || task.created_at) && (() => {
        const t = (task.updated_at || task.created_at) as string;
        const ms = new Date(t).getTime();
        if (!Number.isFinite(ms)) return null;
        return <span className="shrink-0 text-[10px] text-muted-foreground/50">{formatRelativeTime(ms)}</span>;
      })()}
      <Badge variant="outline" className={cn(BADGE_CLASS, getTaskStatusBadgeClass(status))}>{getTaskStatusLabel(status)}</Badge>
    </button>
  );
});

const SkillCard = React.memo<{
  skill: MarketSkillItem;
  tierLabel: string;
  tierAllowed: boolean;
  isTrialing: boolean;
  hasTrialed: boolean;
  onTrial: (skill: MarketSkillItem) => void;
}>(({ skill, tierLabel, tierAllowed, isTrialing, hasTrialed, onTrial }) => (
  <div className="rounded-lg border border-border/50 bg-card/30 px-3 py-2">
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-medium truncate">{skill.name}</span>
      <Badge variant="outline" className={BADGE_CLASS}>{tierLabel}</Badge>
    </div>
    {skill.description && (
      <p className="mt-1 text-[11px] text-muted-foreground line-clamp-2">{skill.description}</p>
    )}
    <div className="mt-2">
      <Button
        size="sm"
        variant="secondary"
        className="h-6 text-[11px]"
        disabled={!tierAllowed || isTrialing || hasTrialed}
        title={!tierAllowed ? `当前版本不可试用（需要 ${tierLabel}）` : undefined}
        onClick={() => onTrial(skill)}
      >
        {isTrialing ? t('common.loading') : hasTrialed ? t('dashboard.trialed') : t('dashboard.tryTrial')}
      </Button>
    </div>
  </div>
));

// ============================================================================
// 子组件：工作区快速操作（搜索项目/示例/新建任务）
// ============================================================================

interface WorkspaceQuickActionsProps {
  isOpen: boolean;
  onClose: () => void;
  projects: Project[];
  examples: UseCaseExample[];
  onSelectProject: (project: Project) => void;
  onSelectExample: (example: UseCaseExample) => void;
  onNewTask: (query: string) => void;
}

const WorkspaceQuickActions: React.FC<WorkspaceQuickActionsProps> = ({
  isOpen,
  onClose,
  projects,
  examples,
  onSelectProject,
  onSelectExample,
  onNewTask,
}) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 过滤结果（无搜索时展示按最近活动排序的前 5 条）
  const filteredProjects = useMemo(() => {
    if (!query.trim()) {
      return [...projects].sort((a, b) => new Date(b.lastActivity || 0).getTime() - new Date(a.lastActivity || 0).getTime()).slice(0, 5);
    }
    return projects.filter(p =>
      p.title.toLowerCase().includes(query.toLowerCase())
    ).slice(0, 5);
  }, [projects, query]);

  const filteredExamples = useMemo(() => {
    if (!query.trim()) return examples.slice(0, 4);
    return examples.filter(e => 
      e.title.toLowerCase().includes(query.toLowerCase()) ||
      e.description.toLowerCase().includes(query.toLowerCase())
    ).slice(0, 4);
  }, [examples, query]);

  const totalItems = 1 + filteredProjects.length + filteredExamples.length; // +1 for "New Task"

  // 重置状态
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setSelectedIndex(0);
    const timer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, [isOpen]);

  // 键盘导航
  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, totalItems - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        handleSelect(selectedIndex);
        break;
      case 'Escape':
        onClose();
        break;
    }
  };

  const handleSelect = (index: number) => {
    if (index === 0) {
      // New Task
      onNewTask(query);
      onClose();
    } else if (index <= filteredProjects.length) {
      // Project
      onSelectProject(filteredProjects[index - 1]);
      onClose();
    } else {
      // Example
      const exampleIndex = index - 1 - filteredProjects.length;
      onSelectExample(filteredExamples[exampleIndex]);
      onClose();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden">
        {/* 搜索输入 */}
        <div className="flex h-12 items-center gap-3 px-4 py-3 border-b border-border">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder={t('dashboard.commandSearchPlaceholder')}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label={t('dashboard.commandSearchAria')}
            aria-controls="dashboard-command-list"
          />
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
            aria-label={t('dashboard.closeCommandAria')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 结果列表 */}
        <div id="dashboard-command-list" role="listbox" aria-label={t('dashboard.commandListAria')} className="max-h-80 overflow-y-auto p-2">
          {/* 新建任务 */}
          <button
            type="button"
            role="option"
            aria-selected={selectedIndex === 0}
            onClick={() => handleSelect(0)}
            className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${
              selectedIndex === 0
                ? 'bg-primary text-primary-foreground'
                : 'hover:bg-muted'
            }`}
          >
            <Plus className="h-4 w-4 shrink-0" />
            <span>{t('dashboard.newTask')}</span>
            {query.trim() && (
              <span className={`text-xs truncate ${
                selectedIndex === 0 ? 'text-primary-foreground/70' : 'text-muted-foreground'
              }`}>
                — "{query}"
              </span>
            )}
          </button>

          {/* 最近对话 */}
          {filteredProjects.length > 0 && (
            <>
              <div className="px-3 py-2 text-xs font-medium text-muted-foreground">
                {query.trim() ? t('dashboard.searchResults') : t('dashboard.recentConversations')}
              </div>
              {filteredProjects.map((project, i) => {
                const index = i + 1;
                const statusConfig = getStatusConfig(project.status);
                return (
                  <button
                    type="button"
                    key={project.id}
                    role="option"
                    aria-selected={selectedIndex === index}
                    onClick={() => handleSelect(index)}
                    className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${
                      selectedIndex === index
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-muted'
                    }`}
                  >
                    <div className={cn(STATUS_DOT_CLASS, statusConfig.color)} />
                    <span className="truncate flex-1">{project.title}</span>
                    <span className={`text-xs ${
                      selectedIndex === index ? 'text-primary-foreground/70' : 'text-muted-foreground'
                    }`}>
                      {formatTime(project.lastActivity)}
                    </span>
                  </button>
                );
              })}
            </>
          )}

          {/* 用例示例 */}
          {filteredExamples.length > 0 && (
            <>
              <div className="px-3 py-2 text-xs font-medium text-muted-foreground">
                快速开始
              </div>
              {filteredExamples.map((example, i) => {
                const index = i + 1 + filteredProjects.length;
                return (
                  <button
                    type="button"
                    key={example.id}
                    role="option"
                    aria-selected={selectedIndex === index}
                    onClick={() => handleSelect(index)}
                    className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${
                      selectedIndex === index
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-muted'
                    }`}
                  >
                    <div className={`shrink-0 ${
                      selectedIndex === index ? 'text-primary-foreground' : 'text-muted-foreground'
                    }`}>
                      {example.icon}
                    </div>
                    <span className="truncate flex-1">{example.title}</span>
                    <Badge
                      variant="outline"
                      className={cn(BADGE_CLASS, "text-[9px]", selectedIndex === index ? 'border-primary-foreground/30' : '')}
                    >
                      {example.category}
                    </Badge>
                  </button>
                );
              })}
            </>
          )}

          {/* 空状态 */}
          {query.trim() && filteredProjects.length === 0 && filteredExamples.length === 0 && (
            <div className="px-3 py-4 text-sm text-muted-foreground text-center">
              {t('dashboard.noMatchResult')}
            </div>
          )}
        </div>

        {/* 底部提示 */}
        <div className="px-4 py-2 border-t border-border text-xs text-muted-foreground flex items-center gap-4">
          <span><kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px]">↑↓</kbd> 导航</span>
          <span><kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px]">↵</kbd> 选择</span>
          <span><kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px]">Esc</kbd> 关闭</span>
        </div>
      </DialogContent>
    </Dialog>
  );
};

// ============================================================================
// 主组件
// ============================================================================

const WorkspaceDashboardInner: React.FC<WorkspaceDashboardProps> = ({
  workspacePath,
  workspaceName = '工作区',
  openFiles = [],
  onOpenFile,
  onNewProject,
  onContinueProject,
  onSubmitTask,
  onRefresh,
}) => {
  // 状态（briefing / meta / data 三 slice 放入 store 以隔离重渲染）
  const {
    briefing,
    briefingLoading,
    briefingError,
    workSuggestions: workSuggestionsFromStore,
    workSuggestionsReady,
    setBriefing,
    setBriefingLoading,
    setBriefingError,
    setWorkSuggestions,
    setWorkSuggestionsReady,
  } = useDashboardBriefingStore(useShallow((s) => ({
    briefing: s.briefing,
    briefingLoading: s.briefingLoading,
    briefingError: s.briefingError,
    workSuggestions: s.workSuggestions,
    workSuggestionsReady: s.workSuggestionsReady,
    setBriefing: s.setBriefing,
    setBriefingLoading: s.setBriefingLoading,
    setBriefingError: s.setBriefingError,
    setWorkSuggestions: s.setWorkSuggestions,
    setWorkSuggestionsReady: s.setWorkSuggestionsReady,
  })));
  const workSuggestions = workSuggestionsFromStore;
  const {
    showMarkdownReport,
    setShowMarkdownReport,
    rawThreads,
    showCommandPalette,
    setShowCommandPalette,
    collaborationRows,
    setCollaborationRows,
    recommendedSkills,
    installedPluginNames,
    loadingRecommendedSkills,
    trialingSkillId,
    setTrialingSkillId,
    trialedSkillIds,
    setTrialedSkillIds,
    showAdvancedSections,
    setShowAdvancedSections,
    orgQuotaHint,
    setOrgQuotaHint,
    orgLearningHint,
    setOrgLearningHint,
    workerQuotaCpuSlots,
    setWorkerQuotaCpuSlots,
    cloudQuotaLimit,
    cloudQuotaUsed,
    setCloudQuotaLimit,
    setCloudQuotaUsed,
    autonomousQuotaLimit,
    autonomousQuotaUsed,
    setAutonomousQuotaLimit,
    setAutonomousQuotaUsed,
    focusModeEnabled,
    setFocusModeEnabled,
    lastRunSummary,
    setLastRunSummary,
    isLoading,
    setIsLoading,
    refreshTrigger,
    incRefreshTrigger,
    taskCreating,
    setTaskCreating,
    setRawThreads,
    setRecommendedSkills,
    setInstalledPluginNames,
    setLoadingRecommendedSkills,
  } = useDashboardDataStore(useShallow((s) => ({
    showMarkdownReport: s.showMarkdownReport,
    setShowMarkdownReport: s.setShowMarkdownReport,
    rawThreads: s.rawThreads,
    showCommandPalette: s.showCommandPalette,
    setShowCommandPalette: s.setShowCommandPalette,
    collaborationRows: s.collaborationRows,
    setCollaborationRows: s.setCollaborationRows,
    recommendedSkills: s.recommendedSkills,
    installedPluginNames: s.installedPluginNames,
    loadingRecommendedSkills: s.loadingRecommendedSkills,
    trialingSkillId: s.trialingSkillId,
    setTrialingSkillId: s.setTrialingSkillId,
    trialedSkillIds: s.trialedSkillIds,
    setTrialedSkillIds: s.setTrialedSkillIds,
    showAdvancedSections: s.showAdvancedSections,
    setShowAdvancedSections: s.setShowAdvancedSections,
    orgQuotaHint: s.orgQuotaHint,
    setOrgQuotaHint: s.setOrgQuotaHint,
    orgLearningHint: s.orgLearningHint,
    setOrgLearningHint: s.setOrgLearningHint,
    workerQuotaCpuSlots: s.workerQuotaCpuSlots,
    setWorkerQuotaCpuSlots: s.setWorkerQuotaCpuSlots,
    cloudQuotaLimit: s.cloudQuotaLimit,
    cloudQuotaUsed: s.cloudQuotaUsed,
    setCloudQuotaLimit: s.setCloudQuotaLimit,
    setCloudQuotaUsed: s.setCloudQuotaUsed,
    autonomousQuotaLimit: s.autonomousQuotaLimit,
    autonomousQuotaUsed: s.autonomousQuotaUsed,
    setAutonomousQuotaLimit: s.setAutonomousQuotaLimit,
    setAutonomousQuotaUsed: s.setAutonomousQuotaUsed,
    focusModeEnabled: s.focusModeEnabled,
    setFocusModeEnabled: s.setFocusModeEnabled,
    lastRunSummary: s.lastRunSummary,
    setLastRunSummary: s.setLastRunSummary,
    isLoading: s.isLoading,
    setIsLoading: s.setIsLoading,
    refreshTrigger: s.refreshTrigger,
    incRefreshTrigger: s.incRefreshTrigger,
    taskCreating: s.taskCreating,
    setTaskCreating: s.setTaskCreating,
    setRawThreads: s.setRawThreads,
    setRecommendedSkills: s.setRecommendedSkills,
    setInstalledPluginNames: s.setInstalledPluginNames,
    setLoadingRecommendedSkills: s.setLoadingRecommendedSkills,
  })));
  const {
    featureFlags,
    roles,
    activeRoleId,
    currentLicenseTier: currentLicenseTierFromStore,
    latestReleaseGateSummary,
    showReleaseGateDetail,
    recoveryStats,
    setFeatureFlags,
    setRoles,
    setActiveRoleId,
    setCurrentLicenseTier,
    setLatestReleaseGateSummary,
    setShowReleaseGateDetail,
    setRecoveryStats,
  } = useDashboardMetaStore(useShallow((s) => ({
    featureFlags: s.featureFlags,
    roles: s.roles,
    activeRoleId: s.activeRoleId,
    currentLicenseTier: s.currentLicenseTier,
    latestReleaseGateSummary: s.latestReleaseGateSummary,
    showReleaseGateDetail: s.showReleaseGateDetail,
    recoveryStats: s.recoveryStats,
    setFeatureFlags: s.setFeatureFlags,
    setRoles: s.setRoles,
    setActiveRoleId: s.setActiveRoleId,
    setCurrentLicenseTier: s.setCurrentLicenseTier,
    setLatestReleaseGateSummary: s.setLatestReleaseGateSummary,
    setShowReleaseGateDetail: s.setShowReleaseGateDetail,
    setRecoveryStats: s.setRecoveryStats,
  })));
  const currentLicenseTier = currentLicenseTierFromStore;
  const boardTasks = useTaskStore(
    useShallow((s) =>
      Object.values(s.tasksById).filter((t) => (t.scope || "personal") === "personal").slice(0, 20)
    )
  );
  const collabSectionRef = useRef<HTMLDivElement | null>(null);
  const actionCooldownUntilRef = useRef<number>(0);
  const [suggestionsRefreshing, setSuggestionsRefreshing] = useState(false);
  const [roleSkillsCount, setRoleSkillsCount] = useState(0);
  const { reportError: reportAggregatedError } = useAggregatedErrors();
  const tierCapabilities = useMemo(
    () => getTierCapabilities(currentLicenseTier as LicenseTier),
    [currentLicenseTier],
  );

  const runWithActionGuard = useCallback((fn: () => void) => {
    const now = Date.now();
    if (now < actionCooldownUntilRef.current) return;
    actionCooldownUntilRef.current = now + 300;
    fn();
  }, []);

  const openCommandPaletteSafely = useCallback(() => {
    runWithActionGuard(() => setShowCommandPalette(true));
  }, [runWithActionGuard]);

  const openNewProjectSafely = useCallback(() => {
    runWithActionGuard(() => onNewProject?.());
  }, [runWithActionGuard, onNewProject]);

  const quotaPercent = (used: number, limit: number): number => {
    if (limit <= 0) return 0;
    return Math.max(0, Math.min(100, (used / limit) * 100));
  };

  const quotaText = (used: number, limit: number): string => {
    if (limit < 0) return `${used} / 无限`;
    return `${used} / ${limit}`;
  };

  const handleBriefingCardSelect = useCallback((hint: string) => {
    onNewProject?.();
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(EVENTS.OPEN_CHAT_PANEL));
      const threadId = getCurrentThreadIdFromStorage();
      window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, {
        detail: { prompt: `请基于这条汇报继续执行：${hint}`, threadId: threadId || undefined },
      }));
    }, 180);
  }, [onNewProject]);

  const handleWorkSuggestionSelect = useCallback((s: WorkSuggestion) => {
    toast.info(t('dashboard.promptFilled'), { duration: 1500 });
    onNewProject?.();
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(EVENTS.OPEN_CHAT_PANEL));
      const threadId = getCurrentThreadIdFromStorage();
      window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, {
        detail: { prompt: s.title + (s.description ? ': ' + s.description : ''), threadId: threadId || undefined },
      }));
    }, 180);
    if (String(s.type || '').includes('intent_resume') && s.id?.startsWith('intent_')) {
      const intentId = s.id.replace('intent_', '');
      const wsId = workspacePath || undefined;
      userModelApi.get(wsId).then((res) => {
        if (res?.ok && res.profile) {
          const filtered = (res.profile.unsolved_intents || []).filter(
            (i: { id?: string }) => String(i.id) !== intentId
          );
          userModelApi.put({ unsolved_intents: filtered }, wsId).catch(() => toast.error(t('dashboard.updateIntentsFailed')));
        }
      }).catch(() => { toast.error(t('dashboard.agentProfileLoadError')); });
    }
  }, [onNewProject, workspacePath]);

  const handleBoardTaskOpen = useCallback((task: BoardTask) => {
    const primaryEntry = resolveTaskPrimaryEntryAction(task);
    if (primaryEntry.kind === "open_thread" && task.thread_id) {
      switchThreadThen(task.thread_id);
      return;
    }
    window.dispatchEvent(new CustomEvent(EVENTS.OPEN_TASK_IN_EDITOR, { detail: { taskId: task.id, subject: task.subject ?? t('thread.task') } }));
  }, []);

  const handleSkillTrial = useCallback(async (skill: MarketSkillItem) => {
    const tier = String(skill.requires_tier || '').toLowerCase();
    const tierLabel = tier === 'enterprise' ? t('dashboard.tierEnterprise') : tier === 'pro' ? t('dashboard.tierPro') : t('dashboard.tierFree');
    const tierAllowed = !tier || tier === 'free' || tier === 'community' || licenseTierRank(currentLicenseTier) >= licenseTierRank(tier);
    if (!tierAllowed) {
      toast.error(t('dashboard.skillTrialRequiresTier', { tier: tierLabel }));
      return;
    }
    const trialKey = skill.id || skill.name;
    try {
      setTrialingSkillId(trialKey);
      await skillsAPI.createTrial({
        name: skill.name,
        domain: skill.domain,
        url: skill.url,
        market_id: skill.id,
        version: skill.version,
      });
      setTrialedSkillIds([...useDashboardDataStore.getState().trialedSkillIds, trialKey]);
      toast.success(t('dashboard.skillTrialStarted', { name: skill.name }), {
        description: t('dashboard.skillTrialOpenedPanel'),
        action: {
          label: t('dashboard.goToSkillMarket'),
          onClick: () => {
            window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_LEFT_PANEL, { detail: { tab: 'knowledge' } }));
          },
        },
      });
      window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_LEFT_PANEL, { detail: { tab: 'knowledge' } }));
    } catch (e: unknown) {
      if (isHandledApiError(e)) return;
      toast.error((e as Error)?.message || t('dashboard.skillTrialFailed'));
    } finally {
      setTrialingSkillId(null);
    }
  }, [currentLicenseTier, setTrialingSkillId, setTrialedSkillIds]);

  // 拉取角色列表（最多 5 个用于第一行）
  useEffect(() => {
    let cancelled = false;
    boardApi.listRoles().then((res) => {
      if (cancelled) return;
      if (res.ok && Array.isArray(res.roles) && res.roles.length > 0) setRoles(res.roles);
      else if (!res.ok) reportAggregatedError(t('dashboard.rolesLoadError'));
    }).catch((e) => {
      if (!cancelled) reportAggregatedError(t('dashboard.rolesLoadError'));
    });
    return () => { cancelled = true; };
  }, [reportAggregatedError]);

  useEffect(() => {
    const syncRecoveryStats = () => {
      try {
        const raw = getStorageItem(RECOVERY_ACTION_STATS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        const next: Record<string, number> = {};
        if (parsed && typeof parsed === "object") {
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (!k.startsWith("_")) next[k] = Number(v || 0);
          }
        }
        setRecoveryStats(next);
      } catch {
        setRecoveryStats({});
      }
    };
    syncRecoveryStats();
    window.addEventListener("storage", syncRecoveryStats);
    window.addEventListener(EVENTS.RUN_SUMMARY_UPDATED, syncRecoveryStats);
    return () => {
      window.removeEventListener("storage", syncRecoveryStats);
      window.removeEventListener(EVENTS.RUN_SUMMARY_UPDATED, syncRecoveryStats);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    boardApi.getAgentProfile().then((res) => {
      if (cancelled) return;
      if (!res.ok || !res.profile) return;
      const f = (res.profile as { features?: Record<string, unknown> }).features ?? {};
      setFeatureFlags({
        organization_mode: Boolean(f.organization_mode),
        tradeable_mode: Boolean(f.tradeable_mode),
        wallet_enabled: Boolean(f.wallet_enabled),
      });
    }).catch(() => {
      if (!cancelled) reportAggregatedError(t('dashboard.agentProfileLoadError'));
    });
    return () => { cancelled = true; };
  }, [reportAggregatedError]);

  // 同步当前角色与模式（localStorage / 事件）。SESSION_CHANGED/ROLE_CHANGED 仅当 event.detail.threadId 与当前激活一致时同步，符合领域模型约定
  useEffect(() => {
    const sync = () => {
      setActiveRoleId(resolveCurrentRoleId());
      setCurrentLicenseTier(getLicenseTier());
      setFocusModeEnabled(getStorageItem("maibot_focus_mode") === "1");
    };
    const syncIfCurrentThread = (e: Event) => {
      const ev = e as CustomEvent<{ threadId?: string }>;
      const eventThreadId = ev.detail?.threadId;
      const current = getCurrentThreadIdFromStorage();
      if (eventThreadId != null && current !== eventThreadId) return;
      sync();
    };
    sync();
    window.addEventListener('storage', sync);
    window.addEventListener(EVENTS.SESSION_CHANGED, syncIfCurrentThread as EventListener);
    window.addEventListener(EVENTS.ROLE_CHANGED, syncIfCurrentThread as EventListener);
    window.addEventListener(EVENTS.COMPOSER_PREFS_CHANGED, sync);
    window.addEventListener(EVENTS.LICENSE_TIER_CHANGED, sync);
    window.addEventListener(EVENTS.FOCUS_MODE_CHANGED, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(EVENTS.SESSION_CHANGED, syncIfCurrentThread as EventListener);
      window.removeEventListener(EVENTS.ROLE_CHANGED, syncIfCurrentThread as EventListener);
      window.removeEventListener(EVENTS.COMPOSER_PREFS_CHANGED, sync);
      window.removeEventListener(EVENTS.LICENSE_TIER_CHANGED, sync);
      window.removeEventListener(EVENTS.FOCUS_MODE_CHANGED, sync);
    };
  }, []);

  useEffect(() => {
    const onCollabCenterOpen = () => {
      setShowAdvancedSections(true);
      window.setTimeout(() => {
        collabSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 120);
    };
    window.addEventListener(EVENTS.COLLAB_CENTER_OPEN, onCollabCenterOpen);
    return () => window.removeEventListener(EVENTS.COLLAB_CENTER_OPEN, onCollabCenterOpen);
  }, []);

  useRunSummarySync(setLastRunSummary);

  useEffect(() => {
    let cancelled = false;
    const loadQuotaStatus = async () => {
      try {
        const res = await getLicenseStatus();
        if (cancelled) return;
        if (!res.ok) return;
        setCloudQuotaLimit(Number(res.limits?.cloud_model_requests_daily ?? 0));
        setCloudQuotaUsed(Number(res.usage?.cloud_model_requests_today ?? 0));
        setAutonomousQuotaLimit(Number(res.limits?.max_daily_autonomous_tasks ?? 0));
        setAutonomousQuotaUsed(Number(res.usage?.autonomous_tasks_today ?? 0));
      } catch {
        // ignore
      }
    };
    void loadQuotaStatus();
    return () => { cancelled = true; };
  }, [currentLicenseTier]);

  // 键盘快捷键：⌘K 命令面板，⌘⇧V 从剪贴板填入任务
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openCommandPaletteSafely();
        return;
      }
      if (e.key.toLowerCase() === 'v' && e.shiftKey) {
        e.preventDefault();
        navigator.clipboard?.readText?.()
          .then((text) => {
            if (text?.trim()) {
              onSubmitTask?.(text.trim());
              onNewProject?.();
            } else {
              toast.info(t('dashboard.clipboardEmpty'));
            }
          })
          .catch(() => {
            toast.error(t('dashboard.cannotReadClipboard'), { description: t('dashboard.allowPastePermission') });
          });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onSubmitTask, onNewProject, openCommandPaletteSafely]);

  const handleCreateBoardTask = useCallback(async (rawPrompt: string) => {
    const prompt = String(rawPrompt || '').trim();
    if (!prompt) return;
    setTaskCreating(true);
    try {
      const created = await boardApi.createTask({
        subject: prompt,
        description: prompt,
        priority: 3,
        scope: 'personal',
        source_channel: 'workspace_dashboard',
        workspace_path: workspacePath || undefined,
      });
      if (!created.ok || !created.task_id) {
        toast.error(t('dashboard.createTaskFailed'), { description: created.error || t('settings.pleaseRetry') });
        return;
      }
      const subject = created.task?.subject ?? prompt;
      window.dispatchEvent(new CustomEvent(EVENTS.OPEN_TASK_IN_EDITOR, { detail: { taskId: created.task_id, subject } }));
      window.dispatchEvent(new CustomEvent(EVENTS.TASK_PROGRESS, { detail: { taskId: created.task_id, source: 'workspace_dashboard' } }));
      incRefreshTrigger();
      toast.success(t('dashboard.taskCreatedAndEnterBoard'));
    } catch (e) {
      toast.error(t('dashboard.createTaskFailed'), { description: e instanceof Error ? e.message : t('dashboard.networkError') });
    } finally {
      setTaskCreating(false);
    }
  }, [workspacePath]);

  // 看板任务已并入 loadData 的 Promise.all，并从 useTaskStore 订阅
  useEffect(() => {
    const cached = loadDashboardCache(workspacePath);
    const cachedBoardTasks = cached?.boardTasks;
    if (Array.isArray(cachedBoardTasks) && cachedBoardTasks.length) {
      useTaskStore.getState().setTasks(cachedBoardTasks);
    }
  }, [workspacePath]);

  useEffect(() => {
    let cancelled = false;
    const cached = loadDashboardCache(workspacePath);
    const cachedCollaborationRows = cached?.collaborationRows;
    if (Array.isArray(cachedCollaborationRows)) {
      setCollaborationRows(cachedCollaborationRows);
    }
    boardApi.getCollaborationMetrics({ scope: 'personal', limit: 60 }).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        const next = res.rows || [];
        setCollaborationRows(next);
        patchDashboardCache(workspacePath, { collaborationRows: next });
      }
      else if (res.error) reportAggregatedError(t('dashboard.collaborationLoadError'));
    }).catch(() => {
      if (!cancelled) reportAggregatedError(t('dashboard.collaborationLoadError'));
    });
    return () => { cancelled = true; };
  }, [refreshTrigger, workspacePath, reportAggregatedError]);

  useEffect(() => {
    let cancelled = false;
    const cached = loadDashboardCache(workspacePath);
    const prevRelease = useDashboardMetaStore.getState().latestReleaseGateSummary;
    setLatestReleaseGateSummary(cached && "latestReleaseGateSummary" in cached ? (cached?.latestReleaseGateSummary ?? prevRelease ?? null) : prevRelease);
    boardApi.getLatestReleaseGateSummary()
      .then((res) => {
        if (cancelled) return;
        if (res.ok && res.summary != null) {
          setLatestReleaseGateSummary(res.summary);
          patchDashboardCache(workspacePath, { latestReleaseGateSummary: res.summary });
        } else if (!res.ok) {
          reportAggregatedError(t('dashboard.releaseGate.loadError'));
        }
      })
      .catch(() => {
        if (!cancelled) reportAggregatedError(t('dashboard.releaseGate.loadError'));
      });
    return () => { cancelled = true; };
  }, [refreshTrigger, workspacePath, reportAggregatedError]);

  useEffect(() => {
    let cancelled = false;
    if (!featureFlags.organization_mode) return;
    const aid = String(activeRoleId || "").trim();
    if (!aid) {
      setOrgQuotaHint("");
      setOrgLearningHint("");
      return;
    }
    boardApi.getOrganizationResourceQuota(aid).then((res) => {
      if (cancelled) return;
      if (!res.ok || !res.quota) {
        setOrgQuotaHint("");
        return;
      }
      const cpu = Number(res.quota.cpu_slots || 0);
      const calls = Number(res.quota.model_calls_per_hour || 0);
      const usd = Number(res.quota.usd_budget_daily || 0);
      setOrgQuotaHint(`配额 CPU槽位 ${cpu} · 模型调用/小时 ${calls} · 日预算 $${usd.toFixed(2)}`);
    }).catch(() => { if (!cancelled) setOrgQuotaHint(""); });
    boardApi.getOrganizationLearningRecent({ agent_id: aid, limit: 40 }).then((res) => {
      if (cancelled) return;
      const s = Number(res.agent_score?.success_count || 0);
      const f = Number(res.agent_score?.failure_count || 0);
      const score = Number(res.agent_score?.score || 0);
      if (s + f <= 0) {
        setOrgLearningHint("学习评分 暂无样本");
        return;
      }
      setOrgLearningHint(`学习评分 ${score.toFixed(2)}（成功 ${s} / 失败 ${f}）`);
    }).catch(() => { if (!cancelled) setOrgLearningHint(""); });
    return () => { cancelled = true; };
  }, [featureFlags.organization_mode, activeRoleId, refreshTrigger]);

  useEffect(() => {
    let cancelled = false;
    const loadRecommendedSkills = async () => {
      try {
        setLoadingRecommendedSkills(true);
        const res = await skillsAPI.getMarketSkills();
        const pluginRes = await listPlugins();
        if (!res.ok || cancelled) return;
        const currentRole = activeRoleId ? roles.find((r) => r.id === activeRoleId) : null;
        const profile = String(currentRole?.skill_profile || '').toLowerCase();
        const profileDomainMap: Record<string, string[]> = {
          office: ['office', 'general'],
          report: ['report', 'general'],
          research: ['research', 'general'],
          analyst: ['analytics', 'analyst', 'data'],
          general: ['general', 'productivity', 'data', 'engineering'],
          full: ['general', 'productivity', 'data', 'engineering'],
        };
        const domains = profileDomainMap[profile] || [];
        const matched = domains.length
          ? res.skills.filter((s) => domains.includes(String(s.domain || '').toLowerCase()))
          : res.skills;
        const installed = Array.isArray(pluginRes.plugins)
          ? pluginRes.plugins.filter((p) => p.loaded).map((p) => p.name).slice(0, 6)
          : [];
        if (!cancelled) setInstalledPluginNames(installed);
        if (!cancelled) setRecommendedSkills((matched.length ? matched : res.skills).slice(0, 3));
      } catch {
        if (!cancelled) setRecommendedSkills([]);
      } finally {
        if (!cancelled) setLoadingRecommendedSkills(false);
      }
    };
    void loadRecommendedSkills();
    return () => {
      cancelled = true;
    };
  }, [activeRoleId, roles]);

  useEffect(() => {
    let cancelled = false;
    const currentRole = activeRoleId ? roles.find((r) => r.id === activeRoleId) : null;
    const profile = String(currentRole?.skill_profile || "general").trim() || "general";
    skillsAPI
      .getSkillsByProfile(profile)
      .then((r) => {
        if (!cancelled && r.ok) setRoleSkillsCount(r.total ?? 0);
      })
      .catch(() => {
        if (!cancelled) setRoleSkillsCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRoleId, roles, refreshTrigger]);

  // 加载数据：真实对话记录（按任务/线程），与聊天区统一
  useEffect(() => {
    const withTimeout = async <T,>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => {
      return await new Promise<T>((resolve) => {
        const timer = window.setTimeout(() => resolve(fallback), ms);
        promise
          .then((value) => {
            window.clearTimeout(timer);
            resolve(value);
          })
          .catch(() => {
            window.clearTimeout(timer);
            resolve(fallback);
          });
      });
    };

    let cancelled = false;
    const abortController = new AbortController();
    const loadData = async () => {
      useTaskStore.getState().setTasks([]);
      const cached = loadDashboardCache(workspacePath);
      if (cached) {
        if (!cancelled && Array.isArray(cached.rawThreads)) setRawThreads(cached.rawThreads);
        if (!cancelled && Array.isArray(cached.workSuggestions)) {
          setWorkSuggestions(cached.workSuggestions.slice(0, 3));
          setWorkSuggestionsReady(true);
        }
        if (!cancelled && "briefing" in cached) setBriefing(cached.briefing ?? null);
        if (!cancelled && Array.isArray(cached.boardTasks) && cached.boardTasks.length)
          useTaskStore.getState().setTasks(cached.boardTasks);
      }
      if (!cancelled) setIsLoading(!cached);
      if (!cancelled) setBriefingLoading(true);
      if (!cancelled) setBriefingError(false);
      if (!cached?.workSuggestions) setWorkSuggestionsReady(false);
      try {
        const currentThreadId = getCurrentThreadIdFromStorage();
        const currentMode = resolveScopedChatMode(currentThreadId || undefined);
        const [threads, suggestionsRes, briefingRes, tasksRes] = await Promise.all([
          withTimeout<RawThread[]>(listThreads({ limit: 10 }) as Promise<RawThread[]>, 6000, []),
          withTimeout(getWorkSuggestions(workspacePath || undefined, { threadId: currentThreadId || undefined, mode: currentMode }), 6000, {
            success: false,
            suggestions: [],
          } as { success: boolean; suggestions: WorkSuggestion[] }),
          withTimeout(
            generateBriefing({
              workspace_path: workspacePath || undefined,
              days: 7,
              scope: "personal",
              include_llm: true,
            }),
            7000,
            { ok: false, briefing: null } as { ok: boolean; briefing: BriefingPayload | null }
          ),
          withTimeout(boardApi.getTasks("personal", undefined, undefined, { signal: abortController.signal, workspacePath: workspacePath || undefined }), 6000, { ok: false, tasks: [] } as { ok: boolean; tasks: BoardTask[] }),
        ]);
        if (cancelled) return;

        setWorkSuggestionsReady(true);
        const nextThreads = Array.isArray(threads) ? (threads as RawThread[]) : [];
        setRawThreads(nextThreads);

        if (suggestionsRes.success && Array.isArray(suggestionsRes.suggestions)) {
          setWorkSuggestions(suggestionsRes.suggestions.slice(0, 3));
        }

        if (briefingRes.ok && briefingRes.briefing) {
          setBriefing(briefingRes.briefing);
          setBriefingError(false);
        } else {
          setBriefingError(true);
        }

        const nextTasks = tasksRes.ok && Array.isArray(tasksRes.tasks) ? tasksRes.tasks : [];
        const prevTasks = Object.values(useTaskStore.getState().tasksById);
        const tasksToStore = nextTasks.length ? nextTasks : prevTasks;
        useTaskStore.getState().setTasks(tasksToStore);

        const nextSuggestions = suggestionsRes.success && Array.isArray(suggestionsRes.suggestions)
          ? suggestionsRes.suggestions.slice(0, 3)
          : (cached?.workSuggestions ?? []);
        const nextBriefing = briefingRes.ok && briefingRes.briefing
          ? briefingRes.briefing
          : (cached?.briefing ?? null);
        saveDashboardCache(workspacePath, {
          updatedAt: Date.now(),
          rawThreads: nextThreads,
          workSuggestions: nextSuggestions,
          briefing: nextBriefing,
          boardTasks: tasksToStore,
        });
        setBriefingLoading(false);
      } catch (error) {
        if (cancelled) return;
        toast.error(t('dashboard.dataLoadError'));
        if (import.meta.env?.DEV) console.warn('[WorkspaceDashboard] loadData failed:', error);
        setBriefingError(true);
        setBriefingLoading(false);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    loadData();
    return () => { cancelled = true; abortController.abort(); };
  }, [workspacePath, refreshTrigger]);

  const handleRefreshWorkSuggestions = useCallback(() => {
    setSuggestionsRefreshing(true);
    const threadId = getCurrentThreadIdFromStorage();
    getWorkSuggestions(workspacePath || undefined, { refresh: true, threadId: threadId || undefined, mode: resolveScopedChatMode(threadId || undefined) })
      .then((res) => {
        if (res.success && Array.isArray(res.suggestions)) {
          setWorkSuggestions(res.suggestions.slice(0, 3));
          setWorkSuggestionsReady(true);
        }
      })
      .catch(() => {
        toast.error(t('dashboard.refreshSuggestionsFailed'));
      })
      .finally(() => setSuggestionsRefreshing(false));
  }, [workspacePath, setWorkSuggestions, setWorkSuggestionsReady]);

  // 每 30 秒轮询任务列表（仅页面可见时），刷新泳道与芯片（不调用 LLM briefing）
  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const poll = async () => {
      try {
        const res = await boardApi.getTasks("personal", undefined, undefined, { workspacePath: workspacePath || undefined });
        if (cancelled) return;
        if (res.ok && Array.isArray(res.tasks)) useTaskStore.getState().setTasks(res.tasks);
      } catch {
        // 轮询失败静默忽略，不中断定时器
      }
    };
    const startPolling = () => {
      if (intervalId != null) return;
      poll();
      intervalId = setInterval(poll, 30_000);
    };
    const stopPolling = () => {
      if (intervalId != null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
    if (typeof document !== "undefined" && !document.hidden) startPolling();
    const onVisibility = () => {
      if (document.hidden) stopPolling();
      else startPolling();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [workspacePath]);

  const projects = useMemo(() => {
    const isUserMessage = (m: unknown): m is { type?: string; role?: string; content?: string; additional_kwargs?: { mode?: string } } => {
      if (!m || typeof m !== 'object') return false;
      const x = m as { type?: string; role?: string };
      return x.type === 'human' || x.role === 'user';
    };
    return rawThreads
      .filter((t) => t.metadata?.title || (t.values?.messages?.length ?? 0) > 0)
      .map((t, index) => {
        let title = t.metadata?.title as string | undefined;
        if (!title) {
          const msgs = t.values?.messages;
          if (Array.isArray(msgs)) {
            const firstHuman = msgs.find((m: unknown) => isUserMessage(m)) as { content?: string } | undefined;
            const raw = typeof firstHuman?.content === 'string' ? firstHuman.content.trim() : '';
            if (raw.length > 4) {
              title = raw.length > 40 ? raw.slice(0, 40) + '…' : raw;
            } else if (raw) {
              const humans = msgs.filter((m: unknown) => isUserMessage(m));
              const second = humans[1] as { content?: string } | undefined;
              const secondRaw = typeof second?.content === 'string' ? second.content.trim() : '';
              title = secondRaw.length > 2
                ? (secondRaw.length > 40 ? secondRaw.slice(0, 40) + '…' : secondRaw)
                : raw;
            }
          }
        }
        if (!title) title = `对话 ${index + 1}`;
        let lastMode: string | undefined = t.metadata?.mode as string | undefined;
        const messages = t.values?.messages;
        if (!lastMode && Array.isArray(messages)) {
          const humans = messages.filter((m: unknown) => isUserMessage(m));
          const last = humans[humans.length - 1] as { additional_kwargs?: { mode?: string } } | undefined;
          lastMode = last?.additional_kwargs?.mode;
        }
        return {
          id: t.thread_id,
          title,
          status: 'active' as ProjectStatus,
          lastActivity: (() => {
            const d = new Date((t.metadata?.last_active_at as string) || t.created_at || Date.now());
            return Number.isFinite(d.getTime()) ? d : new Date();
          })(),
          messageCount: t.values?.messages?.length ?? 0,
          aiSummary: t.metadata?.summary as string | undefined,
          activeRoleId: t.metadata?.active_role_id as string | undefined,
          lastMode: lastMode && ['agent', 'plan', 'ask', 'debug', 'review'].includes(lastMode) ? lastMode : undefined,
        };
      })
      .sort((a, b) => {
        const ta = a.lastActivity instanceof Date ? a.lastActivity.getTime() : new Date(String(a.lastActivity)).getTime();
        const tb = b.lastActivity instanceof Date ? b.lastActivity.getTime() : new Date(String(b.lastActivity)).getTime();
        return tb - ta;
      });
  }, [rawThreads]);

  const latestProjects = useMemo(
    () => [...projects].sort((a, b) => new Date(b.lastActivity || 0).getTime() - new Date(a.lastActivity || 0).getTime()).slice(0, 5),
    [projects]
  );

  const autonomousSuggestionTitles = useMemo(() => {
    return new Set(
      workSuggestions
        .filter((s) => String(s.type || "").includes("autonomous"))
        .map((s) => String(s.title || "").trim().toLowerCase())
        .filter(Boolean)
    );
  }, [workSuggestions]);

  const actionableBoardTaskCount = useMemo(
    () => boardTasks.filter((t) => !["completed", "failed", "cancelled"].includes(String(t.status || "").toLowerCase())).length,
    [boardTasks]
  );

  const collaborationOverview = useMemo(() => {
    const grouped = new Map<string, {
      id: string;
      label: string;
      active: number;
      completed: number;
      failed: number;
      total: number;
      contribution: number;
      taskId?: string;
      threadId?: string;
      quotaAgentId?: string;
      latestStatus: "running" | "failed" | "completed" | "idle" | "unknown";
    }>();
    for (const row of collaborationRows) {
      const key = String(row.child_agent_id || row.role || row.task_id || row.ts || "").trim();
      if (!key) continue;
      const curr = grouped.get(key) || {
        id: key,
        label: String(row.role || row.child_agent_id || key),
        active: 0,
        completed: 0,
        failed: 0,
        total: 0,
        contribution: 0,
        taskId: String(row.task_id || "").trim() || undefined,
        threadId: String(row.child_agent_id || "").trim() || undefined,
        quotaAgentId: String(row.role || row.child_agent_id || "").trim() || undefined,
        latestStatus: "unknown",
      };
      curr.active += Number(row.metrics?.active_count || 0);
      curr.completed += Number(row.metrics?.completed_count || 0);
      curr.failed += Number(row.metrics?.failed_count || 0);
      curr.total += Number(row.metrics?.total_count || 0);
      curr.contribution += Number(row.metrics?.contribution_score || 0);
      if (!curr.taskId) {
        const candidateTaskId = String(row.task_id || "").trim();
        if (candidateTaskId) curr.taskId = candidateTaskId;
      }
      if (!curr.threadId) {
        const candidateThreadId = String(row.child_agent_id || "").trim();
        if (candidateThreadId) curr.threadId = candidateThreadId;
      }
      if (!curr.quotaAgentId) {
        const candidateQuotaAgentId = String(row.role || row.child_agent_id || "").trim();
        if (candidateQuotaAgentId) curr.quotaAgentId = candidateQuotaAgentId;
      }
      if (Number(row.metrics?.active_count || 0) > 0) {
        curr.latestStatus = "running";
      } else if (Number(row.metrics?.failed_count || 0) > 0) {
        curr.latestStatus = "failed";
      } else if (Number(row.metrics?.completed_count || 0) > 0) {
        curr.latestStatus = "completed";
      } else if (Number(row.metrics?.total_count || 0) > 0) {
        curr.latestStatus = "idle";
      }
      grouped.set(key, curr);
    }
    const workers = Array.from(grouped.values()).sort((a, b) => b.contribution - a.contribution).slice(0, 5);
    const total = workers.reduce((acc, w) => acc + w.total, 0);
    const failed = workers.reduce((acc, w) => acc + w.failed, 0);
    const failureRate = total > 0 ? failed / total : 0;
    const completedCount = workers.reduce((acc, w) => acc + w.completed, 0);
    const activeCount = workers.reduce((acc, w) => acc + w.active, 0);
    const healthLevel = failureRate > 0.35 ? "风险" : failureRate > 0.18 ? "关注" : "健康";
    return {
      workers,
      workerCount: grouped.size,
      activeCount,
      completedCount,
      failureRate,
      healthLevel,
    };
  }, [collaborationRows]);

  useEffect(() => {
    if (!featureFlags.organization_mode || collaborationOverview.workers.length === 0) {
      setWorkerQuotaCpuSlots({});
      return;
    }
    let cancelled = false;
    const loadWorkerQuotas = async () => {
      const entries = await Promise.all(
        collaborationOverview.workers.map(async (w) => {
          const quotaAgentId = String(w.quotaAgentId || "").trim();
          if (!quotaAgentId) return [w.id, 1] as const;
          const res = await boardApi.getOrganizationResourceQuota(quotaAgentId);
          const cpuSlots = res.ok && res.quota ? Math.max(1, Number(res.quota.cpu_slots ?? 1)) : 1;
          return [w.id, cpuSlots] as const;
        })
      );
      if (!cancelled) {
        setWorkerQuotaCpuSlots(Object.fromEntries(entries));
      }
    };
    void loadWorkerQuotas();
    return () => {
      cancelled = true;
    };
  }, [featureFlags.organization_mode, collaborationOverview.workers]);

  const throttledWorkerCount = useMemo(() => {
    return collaborationOverview.workers.filter((w) => {
      const cpuSlots = Math.max(1, Number(workerQuotaCpuSlots[w.id] ?? 1));
      return w.active > 0 && w.active >= cpuSlots;
    }).length;
  }, [collaborationOverview.workers, workerQuotaCpuSlots]);

  const hasOrganizationBackpressure = featureFlags.organization_mode && throttledWorkerCount > 0;
  const warnOrganizationBackpressure = useCallback(() => {
    if (!hasOrganizationBackpressure) return;
    toast.warning(`当前组织资源有 ${throttledWorkerCount} 个执行单元处于限流状态，新任务可能排队`);
  }, [hasOrganizationBackpressure, throttledWorkerCount]);

  const primarySuggestions = useMemo(
    () => {
      const briefingSuggestions = (briefing?.suggestions || [])
        .map((s, idx) => {
          if (typeof s === "string") {
            return { id: `briefing-${idx}`, title: s, description: "", type: "briefing" };
          }
          const item = s as Record<string, unknown>;
          return {
            id: String(item.id || `briefing-${idx}`),
            title: String(item.title || item.text || "建议"),
            description: String(item.description || ""),
            type: String(item.type || "briefing"),
          };
        })
        .filter((s) => s.title.trim())
        .slice(0, 2);
      return briefingSuggestions.length ? briefingSuggestions : workSuggestions.slice(0, 2);
    },
    [briefing?.suggestions, workSuggestions]
  );

  const todayPrepTasks = useMemo(() => {
    const today = new Date();
    const sameDay = (raw?: string) => {
      if (!raw) return false;
      const d = new Date(raw);
      return (
        d.getFullYear() === today.getFullYear() &&
        d.getMonth() === today.getMonth() &&
        d.getDate() === today.getDate()
      );
    };
    return boardTasks
      .filter((t) => {
        const source = String(t.source_channel || "").toLowerCase();
        const subject = String(t.subject || "").toLowerCase();
        return (
          source === "autonomous" ||
          source.includes("auto") ||
          subject.includes("准备") ||
          subject.includes("摘要") ||
          subject.includes("分拣") ||
          subject.includes("扫描")
        );
      })
      .filter((t) => sameDay(t.updated_at || t.created_at))
      .filter((t) => !autonomousSuggestionTitles.has(String(t.subject || "").trim().toLowerCase()))
      .slice(0, 4);
  }, [boardTasks, autonomousSuggestionTitles]);

  const responsibilityLanes = useMemo(() => {
    const userPendingFull = boardTasks.filter((t) => ["pending", "available", "awaiting_plan_confirm", "paused"].includes(String(t.status || "").toLowerCase()));
    const aiRunningFull = boardTasks.filter((t) => ["running", "in_progress"].includes(String(t.status || "").toLowerCase()));
    const completedFull = boardTasks.filter((t) => ["completed", "done", "success"].includes(String(t.status || "").toLowerCase()));
    return {
      userPending: { rows: userPendingFull.slice(0, 5), total: userPendingFull.length },
      aiRunning: { rows: aiRunningFull.slice(0, 5), total: aiRunningFull.length },
      completed: { rows: completedFull.slice(0, 5), total: completedFull.length },
    };
  }, [boardTasks]);

  const todayCompletedCount = useMemo(() => {
    const today = new Date().toDateString();
    return boardTasks.filter((t) => {
      if (!["completed", "done", "success"].includes(String(t.status || "").toLowerCase())) return false;
      const u = t.updated_at || t.created_at || "";
      if (!u) return false;
      try {
        return new Date(u).toDateString() === today;
      } catch {
        return false;
      }
    }).length;
  }, [boardTasks]);

  const capabilityBoostActions = useMemo(() => {
    const actions: Array<{
      id: string;
      label: string;
      description: string;
      actionType: string;
      payload?: Record<string, unknown>;
      etaLabel: string;
      gainLabel: string;
    }> = [];
    if (lastRunSummary?.lastError) {
      actions.push({
        id: "cap-ask-diagnose",
        label: t("dashboard.actionDiagnose"),
        description: t("dashboard.actionDiagnoseDesc"),
        actionType: "ask_diagnose",
        etaLabel: "~30秒",
        gainLabel: "降低重复试错",
      });
      actions.push({
        id: "cap-retry-run",
        label: t("dashboard.actionRetryRun"),
        description: t("dashboard.actionRetryRunDesc"),
        actionType: "retry_last_run",
        etaLabel: "~10秒",
        gainLabel: "快速恢复流程",
      });
    }
    if (lastRunSummary?.linkedTaskId) {
      actions.push({
        id: "cap-open-linked-task",
        label: t("dashboard.actionOpenTask"),
        description: t("dashboard.actionOpenTaskDesc"),
        actionType: "open_linked_task",
        payload: { taskId: lastRunSummary.linkedTaskId, subject: lastRunSummary.linkedSubject || t("thread.task") },
        etaLabel: "~20秒",
        gainLabel: "提升复盘质量",
      });
    } else if (lastRunSummary?.linkedThreadId) {
      actions.push({
        id: "cap-open-linked-thread",
        label: t("dashboard.actionBackToThread"),
        description: t("dashboard.actionBackToThreadDesc"),
        actionType: "open_linked_thread",
        payload: { threadId: lastRunSummary.linkedThreadId },
        etaLabel: "~8秒",
        gainLabel: "回到执行上下文",
      });
    }
    actions.push({
      id: "cap-open-collab",
      label: t("dashboard.actionOpenCollab"),
      description: t("dashboard.actionOpenCollabDesc"),
      actionType: "open_collab_center",
      etaLabel: "~15秒",
      gainLabel: "明确下一步分工",
    });
    return actions.slice(0, 3);
  }, [lastRunSummary, t]);

  const recommendedCapabilityActionId = useMemo(() => {
    const hasError = Boolean(String(lastRunSummary?.lastError || "").trim());
    const hasThread = Boolean(String(lastRunSummary?.linkedThreadId || "").trim());
    const hasTask = Boolean(String(lastRunSummary?.linkedTaskId || "").trim());
    if (!hasError) return "cap-open-collab";
    if (hasThread) return "cap-ask-diagnose";
    if (hasTask) return "cap-open-linked-task";
    return "cap-retry-run";
  }, [lastRunSummary]);
  const recommendedCapabilityAction = useMemo(
    () => capabilityBoostActions.find((x) => x.id === recommendedCapabilityActionId) || capabilityBoostActions[0] || null,
    [capabilityBoostActions, recommendedCapabilityActionId]
  );

  const dispatchCapabilityAction = useCallback((actionType: string, payload?: Record<string, unknown>) => {
    window.dispatchEvent(new CustomEvent(EVENTS.CAPABILITY_ACTION, {
      detail: { actionType, payload: payload || {} },
    }));
  }, []);

  const advancedOverviewText = useMemo(() => {
    const parts: string[] = [];
    if (todayPrepTasks.length > 0) parts.push(`今日准备 ${todayPrepTasks.length}`);
    if (boardTasks.length > 0) parts.push(`看板任务 ${boardTasks.length}`);
    if (workSuggestions.length > 0) parts.push(`推荐任务 ${workSuggestions.length}`);
    if (openFiles.length > 0) parts.push(`最近文件 ${Math.min(openFiles.length, 5)}`);
    return parts.length ? parts.join(" · ") : "推荐任务、技能、看板、最近文件";
  }, [todayPrepTasks.length, boardTasks.length, workSuggestions.length, openFiles.length]);

  const releaseGateEvidencePreview = useMemo(() => {
    const evidence = latestReleaseGateSummary?.evidence;
    if (!evidence || typeof evidence !== "object") return [];
    return Object.entries(evidence as Record<string, unknown>)
      .map(([key, value]) => {
        if (Array.isArray(value)) {
          const status = value.length ? String(value.join(", ")).trim() : "unknown";
          return { key, status };
        }
        const row = (value && typeof value === "object") ? (value as Record<string, unknown>) : {};
        const status = String(row.status || "").trim() || "unknown";
        return { key, status };
      })
      .slice(0, 6);
  }, [latestReleaseGateSummary]);

  const releaseGateMarkdownSummary = useMemo(() => {
    if (!latestReleaseGateSummary) return "";
    const lines: string[] = [
      `## ${t("dashboard.releaseGate.summaryTitle")}`,
      "",
      `- profile_gate_status: \`${latestReleaseGateSummary.profile_gate_status || "unknown"}\``,
      `- overall_status: \`${latestReleaseGateSummary.overall_status || "unknown"}\``,
    ];
    if (latestReleaseGateSummary.generated_at) {
      lines.push(`- generated_at: \`${latestReleaseGateSummary.generated_at}\``);
    }
    const reasons = latestReleaseGateSummary.blocking_reasons || [];
    if (reasons.length > 0) {
      lines.push("", "### Blocking Reasons");
      for (const reason of reasons.slice(0, 5)) {
        lines.push(`- ${reason}`);
      }
    }
    if (releaseGateEvidencePreview.length > 0) {
      lines.push("", "### Evidence");
      for (const row of releaseGateEvidencePreview) {
        lines.push(`- ${row.key}: \`${row.status}\``);
      }
    }
    return `${lines.join("\n")}\n`;
  }, [latestReleaseGateSummary, releaseGateEvidencePreview]);

  const releaseGatePlainTextSummary = useMemo(() => {
    if (!latestReleaseGateSummary) return "";
    const lines: string[] = [
      t("dashboard.releaseGate.summaryTitle"),
      `profile_gate_status: ${latestReleaseGateSummary.profile_gate_status || "unknown"}`,
      `overall_status: ${latestReleaseGateSummary.overall_status || "unknown"}`,
    ];
    if (latestReleaseGateSummary.generated_at) {
      lines.push(`generated_at: ${latestReleaseGateSummary.generated_at}`);
    }
    const reasons = latestReleaseGateSummary.blocking_reasons || [];
    if (reasons.length > 0) {
      lines.push("blocking_reasons:");
      for (const reason of reasons.slice(0, 5)) {
        lines.push(`- ${reason}`);
      }
    }
    if (releaseGateEvidencePreview.length > 0) {
      lines.push("evidence:");
      for (const row of releaseGateEvidencePreview) {
        lines.push(`- ${row.key}: ${row.status}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }, [latestReleaseGateSummary, releaseGateEvidencePreview]);

  // 加载状态
  if (isLoading) {
    return (
      <div className="h-full overflow-auto" role="status" aria-live="polite" aria-label={t("dashboard.loadingAria")}>
        <div className="min-h-full flex flex-col items-center px-6 py-8 max-w-2xl mx-auto gap-6">
          <div className="w-full space-y-2">
            <Skeleton className="h-6 w-48 mx-auto" />
            <Skeleton className="h-3 w-full max-w-sm mx-auto" />
            <Skeleton className="h-4 w-full max-w-md mx-auto mt-4" />
          </div>
          <div className="w-full grid grid-cols-2 gap-3">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
          <div className="w-full space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        </div>
      </div>
    );
  }

  const hasProjects = projects.length > 0;
  const hasActiveTasks = responsibilityLanes.userPending.total > 0 || responsibilityLanes.aiRunning.total > 0 || responsibilityLanes.completed.total > 0;
  // 数据驱动：当前工作区展示名（有 path 时用路径最后一段，否则用传入 name 或「工作区」）
  const displayWorkspaceName = workspaceName && workspaceName !== '工作区'
    ? workspaceName
    : (workspacePath ? (workspacePath.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '工作区') : '工作区');

  return (
    <>
      <ScrollArea className="h-full">
        <div className="min-h-full flex items-start justify-center px-6 py-5 sm:py-6">
          <div className="w-full max-w-2xl flex flex-col items-center gap-4 sm:gap-5">
            
            {/* 工作区概览标题（当前工作区单源展示 + 问候与最近运行） */}
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={springs.gentle}
              className="text-center w-full"
            >
              <h1 className="text-[18px] font-semibold tracking-tight text-foreground" title={workspacePath || undefined}>
                当前工作区：{displayWorkspaceName}
              </h1>
              <p className="text-[13px] text-muted-foreground/80 mt-2">
                {briefing?.greeting || t("dashboard.greetingFallback")}
              </p>
              <p className="text-[11px] text-muted-foreground/70 mt-1 inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                {new Date().toLocaleString("zh-CN", { hour12: false })}
                {lastRunSummary && !lastRunSummary.running && (
                  <span className="text-[11px] text-muted-foreground/80">
                    · {t("dashboard.lastRunLabel")}：{t("dashboard.lastRunEnded")}
                    {lastRunSummary.elapsedSec ? ` ${lastRunSummary.elapsedSec}s` : ""}
                    {lastRunSummary.linkedTaskId || lastRunSummary.linkedThreadId ? " · " : ""}
                    {lastRunSummary.linkedTaskId ? (
                      <button
                        type="button"
                        className="underline hover:no-underline"
                        onClick={() => window.dispatchEvent(new CustomEvent(EVENTS.OPEN_TASK_IN_EDITOR, { detail: { taskId: lastRunSummary!.linkedTaskId, subject: lastRunSummary!.linkedSubject || t("thread.task") } }))}
                      >
                        {t("dashboard.openTaskLink")}
                      </button>
                    ) : lastRunSummary.linkedThreadId ? (
                      <button
                        type="button"
                        className="underline hover:no-underline"
                        onClick={() => switchThreadThen(lastRunSummary!.linkedThreadId!, () => onNewProject?.())}
                      >
                        {t("dashboard.backToChatLink")}
                      </button>
                    ) : null}
                  </span>
                )}
              </p>
              {focusModeEnabled ? (
                <p className="text-[10px] text-primary/80 mt-1" title={t("dashboard.focusModeHint")}>{t("dashboard.focusModeHint")}</p>
              ) : null}
              <div className="mt-2 flex flex-col items-center gap-1.5">
                <div className="flex flex-wrap items-center justify-center gap-1.5 text-[10px] text-muted-foreground/80" title={t("dashboard.roleSwitchHint")}>
                  <RoleContextBadgeGroup
                    activeRoleId={activeRoleId}
                    roles={roles.map((r) => ({ id: r.id, label: r.label }))}
                    showCurrentRole
                    showRoleCount={false}
                    showHint={false}
                  />
                  <button
                    type="button"
                    onClick={() => document.getElementById("dashboard-recent-tasks")?.scrollIntoView({ behavior: "smooth" })}
                    className={CHIP_BUTTON_CLASS}
                    title={t("dashboard.continueChatsChipTooltip")}
                  >
                    {t("dashboard.continueTasksChip")}：{projects.length}
                  </button>
                  <span className={CHIP_CLASS} title={t("dashboard.skillsCountTitle")}>{t("dashboard.skillsCountChip")}：{roleSkillsCount}</span>
                </div>
                {(actionableBoardTaskCount > 0 || responsibilityLanes.userPending.total > 0 || responsibilityLanes.aiRunning.total > 0 || todayCompletedCount > 0) && (
                  <div className="flex flex-wrap items-center justify-center gap-1.5 text-[10px] text-muted-foreground/80">
                    <button
                      type="button"
                      onClick={() => window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_LEFT_PANEL, { detail: { tab: "tasks" } }))}
                      className={CHIP_BUTTON_CLASS}
                      title={t("dashboard.openTaskPanel")}
                    >
                      {t("dashboard.boardProcessingChip")}：{actionableBoardTaskCount}
                    </button>
                    {responsibilityLanes.userPending.total > 0 && (
                      <button
                        type="button"
                        onClick={() => window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_LEFT_PANEL, { detail: { tab: "tasks" } }))}
                        className={CHIP_BUTTON_CLASS}
                        title={t("dashboard.openTaskPanel")}
                      >
                        {t("dashboard.pendingChip")} {responsibilityLanes.userPending.total}
                      </button>
                    )}
                    {responsibilityLanes.aiRunning.total > 0 && (
                      <button
                        type="button"
                        onClick={() => window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_LEFT_PANEL, { detail: { tab: "tasks" } }))}
                        className={CHIP_BUTTON_CLASS}
                        title={t("dashboard.openTaskPanel")}
                      >
                        {t("dashboard.runningChip")} {responsibilityLanes.aiRunning.total}
                      </button>
                    )}
                    {todayCompletedCount > 0 && (
                      <button
                        type="button"
                        onClick={() => window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_LEFT_PANEL, { detail: { tab: "tasks" } }))}
                        className={CHIP_BUTTON_CLASS}
                        title={t("dashboard.openTaskPanel")}
                      >
                        {t("dashboard.todayDoneChip")} {todayCompletedCount}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </motion.div>

            {/* 第一屏：最近会话/任务（最多 5 条） */}
            {hasProjects && (
              <motion.div
                id="dashboard-recent-tasks"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.gentle, delay: 0.05 }}
                className="w-full"
              >
                <div className="flex items-center justify-between mb-2.5">
                  <h2 className={SECTION_TITLE_CLASS} title={t("dashboard.recentTasksHint")}>
                    <History className={SECTION_ICON_CLASS} />
                    {t("dashboard.recentTasksTitle")}
                  </h2>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={HEADER_ACTION_BUTTON_CLASS}
                    onClick={() => {
                      incRefreshTrigger();
                      onRefresh?.();
                    }}
                    title={t("dashboard.refreshListTitle")}
                    aria-label={t("dashboard.refreshListTitle")}
                  >
                    <RefreshCw className={HEADER_ACTION_ICON_CLASS} />
                  </Button>
                </div>
                <div className="rounded-xl border border-border/50 bg-card/30 overflow-hidden">
                  <motion.div
                    variants={staggerContainer}
                    initial="initial"
                    animate="animate"
                    className="divide-y divide-border/30"
                  >
                    {latestProjects.map((project) => (
                      <ProjectListItem
                        key={project.id}
                        project={project}
                        roleLabel={project.activeRoleId ? roles.find((r) => r.id === project.activeRoleId)?.label : undefined}
                        modeLabel={project.lastMode ? (MODE_LABELS[project.lastMode] ?? project.lastMode) : undefined}
                        onClick={() => onContinueProject?.(project.id)}
                        onContinue={() => onContinueProject?.(project.id)}
                      />
                    ))}
                  </motion.div>
                </div>
              </motion.div>
            )}

            {/* 层次 2 - 主焦点区：任务 > 建议 > 欢迎态 */}
            {(responsibilityLanes.userPending.total > 0 || responsibilityLanes.aiRunning.total > 0 || responsibilityLanes.completed.total > 0) && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.gentle, delay: 0.07 }}
                className="w-full"
              >
                <div className="rounded-xl border border-border/60 bg-card/35 px-3 py-2.5">
                  <div className="mb-2">
                    <p className="text-[11px] text-muted-foreground">{t("dashboard.responsibilityLanes")}</p>
                    <p className="text-[10px] text-muted-foreground/70">{t("dashboard.myBoardTasksLabel")}</p>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    {[
                      { key: "pending", labelKey: "dashboard.lanePending" as const, rows: responsibilityLanes.userPending.rows, total: responsibilityLanes.userPending.total },
                      { key: "running", labelKey: "dashboard.laneRunning" as const, rows: responsibilityLanes.aiRunning.rows, total: responsibilityLanes.aiRunning.total },
                      { key: "done", labelKey: "dashboard.laneDone" as const, rows: responsibilityLanes.completed.rows, total: responsibilityLanes.completed.total },
                    ].map((lane) => (
                      <div key={lane.key} className="rounded-lg border border-border/40 bg-background/50 p-2">
                        <div className="mb-1 text-[11px] font-medium text-foreground/85" title={lane.key === "running" ? t("dashboard.laneRunningTooltip") : undefined}>{t(lane.labelKey)} · {lane.total}</div>
                        {lane.rows.length === 0 ? (
                          <p className="text-[10px] text-muted-foreground/70">{t("dashboard.noEntries")}</p>
                        ) : (
                          <div className="space-y-1">
                            {lane.rows.slice(0, 3).map((task) => {
                              const st = task.status ?? "available";
                              const dotClass =
                                st === "running"
                                  ? "bg-emerald-500"
                                  : st === "blocked"
                                    ? "bg-amber-500"
                                    : st === "waiting_human"
                                      ? "bg-blue-500"
                                      : "bg-muted-foreground/50";
                              return (
                                <button
                                  key={`${lane.key}-${task.id}`}
                                  type="button"
                                  onClick={() => window.dispatchEvent(new CustomEvent(EVENTS.OPEN_TASK_IN_EDITOR, { detail: { taskId: task.id, subject: task.subject || t("thread.task") } }))}
                                  className="w-full min-h-8 flex items-center gap-2 truncate rounded px-1.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/45 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  title={task.subject || t("thread.task")}
                                >
                                  <span className={cn("size-1 rounded-full shrink-0", dotClass)} aria-hidden />
                                  <span className="truncate flex-1 min-w-0">{task.subject || t("thread.task")}</span>
                                  {(task.updated_at || task.created_at) && (() => {
                                    const t = (task.updated_at || task.created_at) as string;
                                    const ms = new Date(t).getTime();
                                    if (!Number.isFinite(ms)) return null;
                                    return <span className="shrink-0 text-[10px] text-muted-foreground/50">{formatRelativeTime(ms)}</span>;
                                  })()}
                                </button>
                              );
                            })}
                            {lane.total > lane.rows.length && (
                              <p className="text-[10px] text-muted-foreground/70 pt-0.5">+{lane.total - lane.rows.length} 条</p>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {!hasActiveTasks && !workSuggestionsReady && (
              <div className="w-full grid grid-cols-1 sm:grid-cols-2 gap-2">
                {[0, 1].map((i) => (
                  <Skeleton key={i} className="rounded-lg h-14 w-full" />
                ))}
              </div>
            )}

            {!hasActiveTasks && workSuggestionsReady && primarySuggestions.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.gentle, delay: 0.045 }}
                className="w-full rounded-xl border border-primary/25 bg-primary/5 p-3"
              >
                <p className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-medium text-foreground/85" title={t("dashboard.suggestionsClickHint")}>
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  {t("dashboard.suggestionsHeader")}
                </p>
                {hasOrganizationBackpressure && (
                  <p className="mb-2 text-[10px] text-amber-600 dark:text-amber-300">{t("dashboard.orgBackpressureBrief")}</p>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                  {primarySuggestions.map((s) => (
                    <button
                      key={`primary-${s.id}`}
                      type="button"
                      onClick={() => {
                        toast.info(t('dashboard.promptFilled'), { duration: 1500 });
                        warnOrganizationBackpressure();
                        onNewProject?.();
                        window.setTimeout(() => {
                          window.dispatchEvent(new CustomEvent(EVENTS.OPEN_CHAT_PANEL));
                          const threadId = getCurrentThreadIdFromStorage();
                          window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, {
                            detail: { prompt: s.title + (s.description ? ': ' + s.description : ''), threadId: threadId || undefined },
                          }));
                        }, 180);
                      }}
                      className={cn(INTERACTIVE_CARD_BUTTON_CLASS, "group/sugg w-full px-3 py-2 bg-card/60 flex items-start justify-between gap-2")}
                      title={s.description}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium line-clamp-1">{s.title}</span>
                          {String(s.type || "").includes("autonomous") && (
                            <span className="inline-flex items-center rounded border border-primary/30 px-1 text-[10px] text-primary shrink-0">
                              自主准备
                            </span>
                          )}
                        </div>
                        {s.description ? (
                          <p className="mt-1 text-[11px] text-muted-foreground line-clamp-2">{s.description}</p>
                        ) : null}
                      </div>
                      <span className="shrink-0 opacity-0 group-hover/sugg:opacity-100 transition-opacity inline-flex items-center gap-1 text-[10px] text-primary">
                        <Send className="size-3" aria-hidden />
                        {t("dashboard.sendLabel")}
                      </span>
                    </button>
                  ))}
                </div>
              </motion.div>
            )}

            {!hasActiveTasks && primarySuggestions.length === 0 && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.gentle, delay: 0.04 }}
                className="w-full"
              >
                <div className="rounded-xl border border-border/60 bg-card/50 p-3.5">
                  <p className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                    <Sparkles className="h-3.5 w-3.5 text-primary/80" />
                    {t("dashboard.welcomeEmptyLine")}
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      className={PRIMARY_ACTION_BUTTON_CLASS}
                      onClick={() => {
                        openNewProjectSafely();
                        window.setTimeout(() => {
                          window.dispatchEvent(new CustomEvent(EVENTS.OPEN_CHAT_PANEL));
                          const threadId = getCurrentThreadIdFromStorage();
                          window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, {
                            detail: { prompt: "请先给我今日重点任务清单，并按优先级执行。", threadId: threadId || undefined },
                          }));
                        }, 180);
                      }}
                    >
                      {t("dashboard.goToChatStart")}
                    </Button>
                    <Button
                      className={OUTLINE_ACTION_BUTTON_CLASS}
                      variant="outline"
                      onClick={openCommandPaletteSafely}
                    >
                      {t("dashboard.openCommandPalette")}
                    </Button>
                    <Button
                      className={OUTLINE_ACTION_BUTTON_CLASS}
                      variant="outline"
                      onClick={() => {
                        setShowAdvancedSections(true);
                        window.dispatchEvent(new CustomEvent(EVENTS.COLLAB_CENTER_OPEN, { detail: { source: "dashboard_primary" } }));
                      }}
                    >
                      {t("dashboard.collabCenter")}
                    </Button>
                    <Button
                      className={OUTLINE_ACTION_BUTTON_CLASS}
                      variant="outline"
                      onClick={() => {
                        window.dispatchEvent(
                          new CustomEvent(EVENTS.COMMAND_PALETTE_COMMAND, { detail: { commandId: 'settings.agent_profile' } })
                        );
                      }}
                    >
                      {t("dashboard.evolutionSettings")}
                    </Button>
                    {briefingLoading && (
                      <span className="inline-flex items-center gap-1.5">
                        <Skeleton className="h-3 w-24 rounded" />
                        <span className="text-[11px] text-muted-foreground">{t("dashboard.briefingGenerating")}</span>
                      </span>
                    )}
                  </div>
                </div>
              </motion.div>
            )}

            {latestReleaseGateSummary && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.gentle, delay: 0.055 }}
                className="w-full"
              >
                <div className="rounded-xl border border-border/60 bg-card/40 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] text-muted-foreground inline-flex items-center gap-1.5">
                      <Scale className="h-3.5 w-3.5 text-muted-foreground/80" />
                      最近巡检结果
                    </p>
                    <Badge
                      variant="outline"
                      className={cn(
                        BADGE_CLASS,
                        latestReleaseGateSummary.profile_gate_status === "pass"
                          ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-300"
                          : "border-amber-500/40 text-amber-600 dark:text-amber-300"
                      )}
                    >
                      {latestReleaseGateSummary.profile_gate_status || "unknown"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    overall: {latestReleaseGateSummary.overall_status || "unknown"}
                    {latestReleaseGateSummary.generated_at
                      ? (() => {
                          const d = new Date(latestReleaseGateSummary.generated_at!);
                          return !Number.isNaN(d.getTime())
                            ? ` · 更新时间：${d.toLocaleString("zh-CN")}`
                            : " · 更新时间未知";
                        })()
                      : ""}
                  </p>
                  {(latestReleaseGateSummary.blocking_reasons || []).length > 0 ? (
                    <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-300 line-clamp-2">
                      阻断原因：{(latestReleaseGateSummary.blocking_reasons || []).slice(0, 2).join("；")}
                    </p>
                  ) : null}
                  <div className="mt-1.5 flex justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => setShowReleaseGateDetail(true)}
                    >
                      查看门禁详情
                    </Button>
                  </div>
                </div>
              </motion.div>
            )}

            {briefing?.summary_cards?.length ? (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.gentle, delay: 0.042 }}
                className="w-full"
              >
                <p className={SECTION_LABEL_CLASS}>{t("dashboard.briefingCardsLabel")}</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {briefing.summary_cards.slice(0, 4).map((card, idx) => (
                    <BriefingCard
                      key={`${card.type}-${idx}`}
                      card={card}
                      index={idx}
                      onSelect={handleBriefingCardSelect}
                    />
                  ))}
                </div>
              </motion.div>
            ) : null}
            {briefing?.markdown_report ? (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.gentle, delay: 0.05 }}
                className="w-full"
              >
                <div className="mt-2 space-y-1">
                  <button
                    type="button"
                    className="text-[11px] text-primary hover:underline"
                    onClick={() => setShowMarkdownReport(!showMarkdownReport)}
                  >
                    {showMarkdownReport ? '收起简报 ▴' : '查看完整简报 ▾'}
                  </button>
                  {showMarkdownReport && (
                    <div className="rounded-xl border border-border/40 bg-card/30 p-3 text-[11px] prose prose-sm dark:prose-invert max-w-none prose-p:leading-[1.65] prose-p:my-0.5 prose-headings:font-semibold prose-headings:tracking-tight prose-blockquote:border-l-primary prose-blockquote:bg-muted/30 prose-blockquote:py-0.5 prose-code:rounded prose-code:bg-muted/60 prose-code:px-1 prose-code:py-0.5 prose-li:my-0.5">
                      <ReactMarkdown remarkPlugins={[...remarkPluginsWithMath]} rehypePlugins={[...rehypePluginsMath]}>
                        {briefing.markdown_report}
                      </ReactMarkdown>
                    </div>
                  )}
                  <div className="flex justify-end">
                    <button
                      type="button"
                      className="text-[11px] text-muted-foreground hover:underline"
                      onClick={() => {
                        onNewProject?.();
                        window.setTimeout(() => {
                          window.dispatchEvent(new CustomEvent(EVENTS.OPEN_CHAT_PANEL));
                          const threadId = getCurrentThreadIdFromStorage();
                          window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, {
                            detail: { prompt: briefing.markdown_report, threadId: threadId || undefined },
                          }));
                        }, 180);
                      }}
                    >
                      {t("dashboard.fillBriefingButton")}
                    </button>
                  </div>
                </div>
              </motion.div>
            ) : null}
            {!briefing?.summary_cards?.length ? (
              briefingLoading ? (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.gentle, delay: 0.042 }}
                className="w-full"
              >
                <p className={SECTION_LABEL_CLASS}>{t("dashboard.briefingCardsLabel")}</p>
                <div className="grid grid-cols-2 gap-2">
                  {[0, 1, 2].map((i) => (
                    <div key={`briefing-skeleton-${i}`} className="rounded-xl border border-border/50 bg-card/30 px-3 py-2 space-y-2">
                      <Skeleton className="h-3 w-20" />
                      <Skeleton className="h-3 w-full" />
                      <Skeleton className="h-3 w-2/3" />
                    </div>
                  ))}
                </div>
              </motion.div>
            ) : briefingError ? (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.gentle, delay: 0.042 }}
                className="w-full"
              >
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
                  <AlertCircle className="size-4 text-destructive/70" />
                  <span>{t('dashboard.reportLoadError')}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setBriefingError(false);
                      setBriefingLoading(true);
                      const workspacePath = getCurrentWorkspacePathFromStorage() || (typeof window !== 'undefined' && (window as { __CURRENT_WORKSPACE_PATH__?: string }).__CURRENT_WORKSPACE_PATH__) || '';
                      generateBriefing({ workspace_path: workspacePath || undefined, days: 7, scope: 'personal', include_llm: true })
                        .then((res) => {
                          if (res.ok && res.briefing) {
                            setBriefing(res.briefing);
                            setBriefingError(false);
                          } else {
                            setBriefingError(true);
                          }
                        })
                        .catch(() => {
                          setBriefingError(true);
                          toast.error(t('execution.loadFailed'));
                        })
                        .finally(() => setBriefingLoading(false));
                    }}
                    className="text-primary underline text-xs"
                  >
                    {t('common.retry')}
                  </button>
                </div>
              </motion.div>
            ) : null) : null }

            {/* 快捷任务（主焦点区无活跃任务时显示） */}
            {!hasActiveTasks && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...springs.gentle, delay: 0.1 }}
              className="w-full"
            >
              <p className={SECTION_LABEL_CLASS} title={t('dashboard.quickTaskHint')}>{t("dashboard.quickTasksSection")}</p>
              <p className="text-[10px] text-muted-foreground/70 mb-2">{t("dashboard.quickTasksSubtitle")}</p>
              {hasOrganizationBackpressure && (
                <p className="text-[10px] text-amber-600 dark:text-amber-300 mb-2">{t("dashboard.orgBackpressureThrottle", { n: String(throttledWorkerCount) })}</p>
              )}
              <motion.div
                variants={staggerContainer}
                initial="initial"
                animate="animate"
                className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2"
              >
                {(() => {
                  const pluginTasks: QuickTask[] =
                    installedPluginNames.length > 0
                      ? installedPluginNames.slice(0, 3).map((name, i) => {
                          const text = `请基于 ${name} 插件给出 3 个可直接执行的任务，并先执行第 1 个。`;
                          return {
                          id: `plugin-${name}-${i}`,
                          icon: <Sparkles className="h-5 w-5" />,
                          title: text.length > 12 ? text.slice(0, 12) + '…' : text,
                          description: text,
                          prompt: text,
                          executionMode: 'chat_prompt' as const,
                        };
                      })
                      : [];
                  const allTasks = [...pluginTasks, ...COMMON_QUICK_TASKS.map((tk) => ({
                      ...tk,
                      title: tk.titleKey ? t(tk.titleKey) : tk.title,
                      description: tk.descriptionKey ? t(tk.descriptionKey) : tk.description,
                      prompt: tk.promptKey ? t(tk.promptKey) : tk.prompt,
                    }))].slice(0, 6);
                  return allTasks.map((task) => (
                    <QuickTaskCard
                      key={task.id}
                      task={task}
                      disabled={taskCreating}
                      creating={taskCreating && task.executionMode === 'create_task'}
                      onClick={() => {
                        if (task.action === 'continue') {
                          if (projects[0]?.id) onContinueProject?.(projects[0].id);
                          onNewProject?.();
                        } else if (task.prompt) {
                          if (task.executionMode === 'create_task') {
                            warnOrganizationBackpressure();
                            handleCreateBoardTask(task.prompt);
                            return;
                          }
                          const isPluginTask = pluginTasks.some((pt) => pt.id === task.id);
                          if (isPluginTask) {
                            const shouldSwitchToAgent = (() => {
                              try {
                                  const v = getStorageItem("maibot_plan_confirm_switch_to_agent");
                                return v == null ? true : v !== "false";
                              } catch {
                                return true;
                              }
                            })();
                            const currentThreadId = getCurrentThreadIdFromStorage() || '';
                            if (shouldSwitchToAgent) {
                              setScopedChatMode('agent', currentThreadId || undefined);
                            }
                          }
                          onNewProject?.();
                          window.setTimeout(() => {
                            window.dispatchEvent(new CustomEvent(EVENTS.OPEN_CHAT_PANEL));
                            const threadId = getCurrentThreadIdFromStorage();
                            window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, {
                              detail: { prompt: task.prompt, threadId: threadId || undefined },
                            }));
                          }, 180);
                        }
                      }}
                    />
                  ));
                })()}
              </motion.div>
            </motion.div>
            )}

            {!hasProjects && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.gentle, delay: 0.15 }}
                className="w-full rounded-lg border border-dashed border-border/60 bg-card/25 p-4"
              >
                <div className="text-sm font-medium">{t("dashboard.noProjectsTitle")}</div>
                <p className="text-xs text-muted-foreground mt-1">{t("dashboard.noProjectsDesc")}</p>
                <div className="mt-2 flex items-center gap-2">
                  <Button size="sm" className={PRIMARY_ACTION_BUTTON_CLASS} onClick={openNewProjectSafely}>
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    {t("dashboard.newChatButton")}
                  </Button>
                  <Button size="sm" variant="outline" className={OUTLINE_ACTION_BUTTON_CLASS} onClick={openCommandPaletteSafely}>
                    <Search className="h-3.5 w-3.5 mr-1" />
                    {t("dashboard.openCommandPalette")}
                  </Button>
                </div>
              </motion.div>
            )}

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...springs.gentle, delay: 0.24 }}
              className="w-full"
            >
              <button
                type="button"
                onClick={() => setShowAdvancedSections(!showAdvancedSections)}
                className="w-full rounded-xl border border-border/50 bg-card/20 px-3 py-2 text-left text-[12px] text-muted-foreground transition-colors hover:bg-muted/40 active:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="inline-flex flex-col" title={t("dashboard.advancedOrderHint")}>
                    <span className="text-[12px] font-medium text-foreground/85">
                      {showAdvancedSections ? t("dashboard.advancedCollapse") : t("dashboard.advancedExpand")}
                      {!showAdvancedSections && capabilityBoostActions.length > 0 ? t("dashboard.advancedWithCapability") : ""}
                    </span>
                    <span className="text-[10px] text-muted-foreground/80">
                      {advancedOverviewText}
                    </span>
                  </span>
                  {showAdvancedSections ? (
                    <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground/80" />
                  ) : (
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground/80" />
                  )}
                </span>
              </button>
            </motion.div>

            {showAdvancedSections && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.gentle, delay: 0.165 }}
                className="w-full"
                title={t("dashboard.advancedOrderHintFull")}
              >
                <div className={cn(SOFT_PANEL_CLASS, "text-[11px] text-muted-foreground")}>
                  {t("dashboard.advancedOrderHint")}
                </div>
              </motion.div>
            )}

            {showAdvancedSections && capabilityBoostActions.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.gentle, delay: 0.166 }}
                className="w-full"
              >
                <div className="rounded-xl border border-border/60 bg-card/35 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] text-muted-foreground inline-flex items-center gap-1.5">
                      <Sparkles className="h-3.5 w-3.5 text-primary/80" />
                      {t("dashboard.capabilityBoostTitle")}
                    </p>
                    <div className="inline-flex items-center gap-1.5">
                      <span className={CHIP_CLASS}>{t("dashboard.capabilityEventDrivenChip")}</span>
                      <Button
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => {
                          const target = recommendedCapabilityAction;
                          if (!target) return;
                          dispatchCapabilityAction(target.actionType, target.payload);
                        }}
                      >
                        {t("dashboard.capabilityExecuteRecommend")}
                      </Button>
                    </div>
                  </div>
                  {recommendedCapabilityAction ? (
                    <p className="mt-1 text-[10px] text-muted-foreground/80">
                      {t("dashboard.capabilityThisRun", {
                        label: recommendedCapabilityAction.label,
                        eta: recommendedCapabilityAction.etaLabel,
                        gain: recommendedCapabilityAction.gainLabel,
                      })}
                    </p>
                  ) : null}
                  <div className="mt-2 space-y-1.5">
                    {capabilityBoostActions.map((item) => (
                      <div
                        key={item.id}
                        className="w-full rounded-md border border-border/50 bg-card/20 px-2.5 py-2 text-left text-[11px]"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-medium text-foreground/90">{item.label}</div>
                          {item.id === recommendedCapabilityActionId ? (
                            <span className={SUBTLE_TAG_CLASS}>{t("dashboard.recommendedTag")}</span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 text-muted-foreground/85">{item.description}</div>
                        <div className="mt-1 inline-flex items-center gap-1.5 text-[10px] text-muted-foreground/75">
                          <span className={SUBTLE_TAG_CLASS}>预估耗时 {item.etaLabel}</span>
                          <span className={SUBTLE_TAG_CLASS}>预期收益 {item.gainLabel}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {showAdvancedSections && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.gentle, delay: 0.17 }}
                className="w-full"
              >
                <span className={CHIP_CLASS}>{t("dashboard.zoneExecution")}</span>
              </motion.div>
            )}

            {/* 工作建议（后端 /suggestions/work） */}
            {showAdvancedSections && workSuggestionsReady && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.gentle, delay: 0.18 }}
                className="w-full"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className={SECTION_LABEL_CLASS}>推荐任务</p>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-muted-foreground hover:text-foreground"
                    onClick={handleRefreshWorkSuggestions}
                    disabled={suggestionsRefreshing}
                    title={t('dashboard.refreshSuggestions')}
                    aria-label={t('dashboard.refreshSuggestions')}
                  >
                    <RefreshCw className={cn('h-3.5 w-3.5', suggestionsRefreshing && 'animate-spin')} />
                  </Button>
                </div>
                {workSuggestions.length > 0 ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                    {workSuggestions.map((s) => (
                      <WorkSuggestionCard
                        key={s.id}
                        suggestion={s}
                        onSelect={handleWorkSuggestionSelect}
                      />
                    ))}
                  </div>
                ) : (
                  <div className={cn(SOFT_DASHED_PANEL_CLASS, "text-[11px] text-muted-foreground")}>
                    {t("dashboard.noSuggestedTasks")}
                  </div>
                )}
              </motion.div>
            )}

            {showAdvancedSections && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...springs.gentle, delay: 0.185 }}
              className="w-full"
            >
                <span className={CHIP_CLASS}>{t("dashboard.zoneResources")}</span>
            </motion.div>
            )}

            {showAdvancedSections && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...springs.gentle, delay: 0.19 }}
              className="w-full"
            >
              <p className={SECTION_LABEL_CLASS}>推荐技能</p>
              {loadingRecommendedSkills ? (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-12 w-full rounded-lg" />
                  <Skeleton className="h-12 w-full rounded-lg" />
                  <Skeleton className="h-12 w-full max-w-[85%] rounded-lg" />
                </div>
              ) : recommendedSkills.length > 0 ? (
                <div className="space-y-2">
                  <div className={cn(SOFT_PANEL_CLASS, "text-[11px] text-muted-foreground")}>
                    当前授权：自治上限 {tierCapabilities.maxAutonomyLevel}，插件上限 {tierCapabilities.maxPlugins < 0 ? "无限" : tierCapabilities.maxPlugins}，
                    {tierCapabilities.cloudModelEnabled ? "已启用" : "未启用"}云模型。
                  </div>
                  <div className={cn(SOFT_PANEL_CLASS, "space-y-2")}>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>云模型日配额</span>
                        <span>{quotaText(cloudQuotaUsed, cloudQuotaLimit)}</span>
                      </div>
                      {cloudQuotaLimit < 0 ? (
                        <div className="text-[10px] text-muted-foreground">无限制</div>
                      ) : (
                        <Progress value={quotaPercent(cloudQuotaUsed, cloudQuotaLimit)} className="h-1.5" />
                      )}
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>自治任务日配额</span>
                        <span>{quotaText(autonomousQuotaUsed, autonomousQuotaLimit)}</span>
                      </div>
                      {autonomousQuotaLimit < 0 ? (
                        <div className="text-[10px] text-muted-foreground">无限制</div>
                      ) : (
                        <Progress value={quotaPercent(autonomousQuotaUsed, autonomousQuotaLimit)} className="h-1.5" />
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {recommendedSkills.map((skill, idx) => {
                    const tier = String(skill.requires_tier || '').toLowerCase();
                    const tierLabel = tier === 'enterprise' ? t('dashboard.tierEnterprise') : tier === 'pro' ? t('dashboard.tierPro') : t('dashboard.tierFree');
                    const tierAllowed =
                      !tier || tier === 'free' || tier === 'community' || licenseTierRank(currentLicenseTier) >= licenseTierRank(tier);
                    const sid = skill.id || skill.name;
                    return (
                      <SkillCard
                        key={`${sid}-${idx}`}
                        skill={skill}
                        tierLabel={tierLabel}
                        tierAllowed={tierAllowed}
                        isTrialing={trialingSkillId === sid}
                        hasTrialed={trialedSkillIds.includes(sid)}
                        onTrial={handleSkillTrial}
                      />
                    );
                  })}
                  </div>
                </div>
              ) : (
                <div className={cn(SOFT_DASHED_PANEL_CLASS, "text-[11px] text-muted-foreground")}>
                  {t("dashboard.noSuggestedSkills")}
                </div>
              )}
            </motion.div>
            )}

            {showAdvancedSections && todayPrepTasks.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.gentle, delay: 0.2 }}
                className="w-full"
              >
                <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
                  <div className="text-[11px] font-medium text-primary mb-1">{t("dashboard.todayPrepTitle")}</div>
                  {hasOrganizationBackpressure && (
                    <p className="mb-1 text-[10px] text-amber-600 dark:text-amber-300">{t("dashboard.orgBackpressureView")}</p>
                  )}
                  <div className="space-y-1">
                    {todayPrepTasks.map((taskItem) => (
                      <button
                        key={`prep-${taskItem.id}`}
                        type="button"
                        onClick={() => {
                          warnOrganizationBackpressure();
                          window.dispatchEvent(new CustomEvent(EVENTS.OPEN_TASK_IN_EDITOR, { detail: { taskId: taskItem.id, subject: taskItem.subject ?? t('thread.task') } }));
                        }}
                        className="w-full rounded px-1 text-left text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring truncate"
                        title={taskItem.subject}
                      >
                        · {taskItem.subject}
                      </button>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {showAdvancedSections && featureFlags.organization_mode && collaborationOverview.workers.length > 0 && (
              <motion.div
                ref={collabSectionRef}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.gentle, delay: 0.21 }}
                className="w-full"
              >
                <div className="flex items-center justify-between mb-2.5">
                  <h2 className={SECTION_TITLE_CLASS}>
                    <BarChart3 className={cn(SECTION_ICON_CLASS, "text-cyan-500/90")} />
                    {t("dashboard.collabOverviewTitle")}
                  </h2>
                </div>
                <p className={SECTION_LABEL_CLASS}>
                  子代理 {collaborationOverview.workerCount} · 运行中 {collaborationOverview.activeCount} · 已完成 {collaborationOverview.completedCount} · 失败率 {Math.round(collaborationOverview.failureRate * 100)}% · 本周健康度 {collaborationOverview.healthLevel}
                </p>
                {(orgQuotaHint || orgLearningHint) && (
                  <p className="mb-2 text-[10px] text-muted-foreground/80">
                    {[orgQuotaHint, orgLearningHint].filter(Boolean).join(" · ")}
                  </p>
                )}
                <p className="mb-2 text-[10px] text-muted-foreground/80" title={t("dashboard.collabContributionHint")}>
                  {t("dashboard.collabContributionHint")}
                </p>
                <div className="rounded-xl border border-border/50 bg-card/30 overflow-hidden divide-y divide-border/30">
                  {collaborationOverview.workers.map((w) => (
                    (() => {
                      const cpuSlots = Math.max(1, Number(workerQuotaCpuSlots[w.id] ?? 1));
                      const isQuotaBlocked = w.active >= cpuSlots && w.active > 0;
                      return (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() => {
                        if (w.taskId) {
                          const task = boardTasks.find((t) => t.id === w.taskId || t.task_id === w.taskId);
                          window.dispatchEvent(new CustomEvent(EVENTS.OPEN_TASK_IN_EDITOR, { detail: { taskId: w.taskId, subject: task?.subject ?? t('thread.task') } }));
                          return;
                        }
                        if (w.threadId) {
                          switchThreadThen(w.threadId);
                        }
                      }}
                      className={INTERACTIVE_ROW_BUTTON_CLASS}
                      title={w.taskId ? t("dashboard.openTaskDetailTitle") : w.threadId ? t("dashboard.switchToSubThread") : t("dashboard.collabEntry")}
                    >
                      <BarChart3 className="h-4 w-4 text-cyan-500 shrink-0" />
                      <span className="truncate flex-1">{w.label}</span>
                      <Badge variant="outline" className={BADGE_CLASS}>活跃 {w.active}</Badge>
                      <Badge
                        variant="outline"
                        className={cn(
                          BADGE_CLASS,
                          isQuotaBlocked ? "border-amber-500/50 text-amber-600 dark:text-amber-300" : ""
                        )}
                      >
                        {isQuotaBlocked ? "限流中" : "配额正常"} {w.active}/{cpuSlots}
                      </Badge>
                      <Badge variant="outline" className={BADGE_CLASS}>完成 {w.completed}</Badge>
                      <Badge variant="outline" className={BADGE_CLASS}>
                        最近 {w.latestStatus === "running" ? "运行中" : w.latestStatus === "failed" ? "失败" : w.latestStatus === "completed" ? "完成" : "空闲"}
                      </Badge>
                      <Badge variant="outline" className={BADGE_CLASS}>贡献 {w.contribution}</Badge>
                    </button>
                      );
                    })()
                  ))}
                </div>
              </motion.div>
            )}

            {showAdvancedSections && featureFlags.organization_mode && collaborationOverview.workers.length === 0 && (
              <motion.div
                ref={collabSectionRef}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.gentle, delay: 0.21 }}
                className="w-full"
              >
                <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/5 px-3 py-2">
                  <p className="text-[11px] font-medium text-cyan-700 dark:text-cyan-300">
                    组织协作视图（已启用）
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    组织模式已开启，当前暂无可展示的子代理运行数据。后续将自动显示 A2A 协作状态。
                  </p>
                </div>
              </motion.div>
            )}

            {showAdvancedSections && featureFlags.tradeable_mode && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.gentle, delay: 0.215 }}
                className="w-full"
              >
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                  <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                    交易与钱包视图（已启用）
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    当前配置允许展示可交易智能体能力。后续可在此接入钱包余额、服务定价与交易记录。
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px]">
                    <span className={CHIP_CLASS}>
                      钱包 {featureFlags.wallet_enabled ? "已开启" : "未开启"}
                    </span>
                    <span className={CHIP_CLASS}>
                      交易模式 已开启
                    </span>
                  </div>
                </div>
              </motion.div>
            )}

            {/* 看板任务：点击在编辑区打开任务详情 */}
            {showAdvancedSections && boardTasks.length === 0 && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.gentle, delay: 0.2 }}
                className="w-full"
              >
                <div className="flex flex-col items-center gap-2 py-6 text-center">
                  <ListTodo className="size-8 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">{t("dashboard.noBoardTasks")}</p>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => window.dispatchEvent(new CustomEvent(EVENTS.COLLAB_CENTER_OPEN, { detail: { source: 'dashboard_empty_board' } }))}
                    >
                      {t("task.createFirst")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => window.dispatchEvent(new CustomEvent(EVENTS.CREATE_ONBOARDING_SAMPLE_TASK))}
                      title={t("onboarding.createSampleTaskHint")}
                      aria-label={t("onboarding.createSampleTask")}
                    >
                      {t("onboarding.createSampleTask")}
                    </Button>
                  </div>
                </div>
              </motion.div>
            )}
            {showAdvancedSections && boardTasks.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.gentle, delay: 0.22 }}
                className="w-full"
              >
                <div className="flex items-center justify-between mb-2.5">
                  <h2 className={SECTION_TITLE_CLASS}>
                    <ListTodo className={cn(SECTION_ICON_CLASS, "text-violet-500/90")} />
                    {t("dashboard.boardTasksSectionTitle")}
                  </h2>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={HEADER_ACTION_BUTTON_CLASS}
                    onClick={() => window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_LEFT_PANEL, { detail: { tab: 'tasks' } }))}
                    title={t("dashboard.expandTaskList")}
                    aria-label={t("dashboard.expandTaskListAria")}
                  >
                    {t("dashboard.viewAllTasks")}
                  </Button>
                </div>
                <p className={SECTION_LABEL_CLASS}>{t("dashboard.boardTaskOpenHint")}</p>
                <div className="rounded-xl border border-border/50 bg-card/30 overflow-hidden divide-y divide-border/30">
                  {boardTasks.map((task) => (
                    <BoardTaskRow key={task.id} task={task} onOpen={handleBoardTaskOpen} />
                  ))}
                </div>
              </motion.div>
            )}

            {/* 最近文件（已在编辑器中打开，最多 5 个） */}
            {showAdvancedSections && openFiles.length > 0 && onOpenFile && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...springs.gentle, delay: 0.25 }}
                className="w-full"
              >
                <h2 className={cn(SECTION_TITLE_CLASS, "mb-2.5")}>
                  <FileText className={SECTION_ICON_CLASS} />
                  最近文件
                </h2>
                <div className="rounded-xl border border-border/50 bg-card/30 overflow-hidden divide-y divide-border/30">
                  {openFiles.slice(0, 5).map((file) => {
                    const format = (file.format || '').toLowerCase();
                    const ext = file.name.split('.').pop() ?? '';
                    const isCode = ['code', 'json'].includes(format) || ['ts', 'tsx', 'js', 'jsx', 'py', 'vue', 'go', 'rs', 'java', 'c', 'cpp', 'json'].includes(ext);
                    const isImage = format === 'image' || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(ext);
                    const isPdf = format === 'pdf' || ext === 'pdf';
                    return (
                      <button
                        key={file.id}
                        type="button"
                        onClick={() => onOpenFile(file.path)}
                        className={INTERACTIVE_ROW_BUTTON_CLASS}
                        aria-label={file.name}
                      >
                        {isImage ? <Image className="h-4 w-4 text-muted-foreground shrink-0" /> : isCode ? <FileCode className="h-4 w-4 text-muted-foreground shrink-0" /> : isPdf ? <FileText className="h-4 w-4 text-red-500 shrink-0" /> : <FileText className="h-4 w-4 text-muted-foreground shrink-0" />}
                        <span className="truncate flex-1">{file.name}</span>
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </div>
        </div>
      </ScrollArea>

      {/* 工作区快速操作 */}
      <WorkspaceQuickActions
        isOpen={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
        projects={projects}
        examples={USE_CASE_EXAMPLES}
        onSelectProject={(project) => onContinueProject?.(project.id)}
        onSelectExample={(example) => {
          onNewProject?.();
          window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent(EVENTS.OPEN_CHAT_PANEL));
            const threadId = getCurrentThreadIdFromStorage();
            window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, {
              detail: { prompt: example.prompt, threadId: threadId || undefined },
            }));
          }, 180);
        }}
        onNewTask={(query) => {
          if (query.trim()) {
            onNewProject?.();
            window.setTimeout(() => {
              window.dispatchEvent(new CustomEvent(EVENTS.OPEN_CHAT_PANEL));
              const threadId = getCurrentThreadIdFromStorage();
              window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, {
                detail: { prompt: query.trim(), threadId: threadId || undefined },
              }));
            }, 180);
            return;
          }
          onNewProject?.();
        }}
      />

      <Dialog open={showReleaseGateDetail} onOpenChange={setShowReleaseGateDetail}>
        <DialogContent className="sm:max-w-xl" aria-describedby="release-gate-detail-desc">
          <DialogHeader>
            <DialogTitle>{t("dashboard.releaseGate.detailTitle")}</DialogTitle>
            <DialogDescription id="release-gate-detail-desc">
              {t("dashboard.releaseGate.detailDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">{t("dashboard.releaseGate.detailSectionTitle")}</p>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[11px]"
                  onClick={async () => {
                    if (!releaseGatePlainTextSummary.trim()) return;
                    try {
                      await navigator.clipboard.writeText(releaseGatePlainTextSummary);
                      toast.success(t("dashboard.releaseGate.copiedSummary"));
                    } catch {
                      toast.error(t("common.copyFailed"), { description: t("common.copyFailedDescription") });
                    }
                  }}
                >
                  {t("dashboard.releaseGate.copyText")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[11px]"
                  onClick={async () => {
                    if (!releaseGateMarkdownSummary.trim()) return;
                    try {
                      await navigator.clipboard.writeText(releaseGateMarkdownSummary);
                      toast.success(t("dashboard.releaseGate.copiedMarkdown"));
                    } catch {
                      toast.error(t("common.copyFailed"), { description: t("common.copyFailedDescription") });
                    }
                  }}
                >
                  {t("dashboard.releaseGate.copyMarkdown")}
                </Button>
                <Badge
                  variant="outline"
                  className={cn(
                    BADGE_CLASS,
                    latestReleaseGateSummary?.profile_gate_status === "pass"
                      ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-300"
                      : "border-amber-500/40 text-amber-600 dark:text-amber-300"
                  )}
                >
                  {latestReleaseGateSummary?.profile_gate_status || "unknown"}
                </Badge>
              </div>
            </div>

            <div className={SOFT_PANEL_CLASS}>
              <p className="text-[12px] text-muted-foreground">
                overall: {latestReleaseGateSummary?.overall_status || "unknown"}
                {latestReleaseGateSummary?.generated_at
                  ? (() => {
                      const d = new Date(latestReleaseGateSummary.generated_at!);
                      return !Number.isNaN(d.getTime())
                        ? ` · 更新时间：${d.toLocaleString("zh-CN")}`
                        : " · 更新时间未知";
                    })()
                  : ""}
              </p>
            </div>

            {(latestReleaseGateSummary?.blocking_reasons || []).length > 0 ? (
              <div className={SOFT_DASHED_PANEL_CLASS}>
                <p className="text-[12px] font-medium text-foreground/90 mb-1">阻断原因</p>
                <div className="space-y-1">
                  {(latestReleaseGateSummary?.blocking_reasons || []).map((reason, idx) => (
                    <p key={`blocking-${idx}`} className="text-[11px] text-amber-600 dark:text-amber-300 wrap-break-word">
                      - {reason}
                    </p>
                  ))}
                </div>
              </div>
            ) : null}

            <div className={SOFT_DASHED_PANEL_CLASS}>
              <p className="text-[12px] font-medium text-foreground/90 mb-1">关键 Evidence</p>
              {releaseGateEvidencePreview.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {releaseGateEvidencePreview.map((row) => (
                    <Badge key={row.key} variant="outline" className={BADGE_CLASS}>
                      {row.key}: {row.status}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">暂无 evidence 信息</p>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

export const WorkspaceDashboard = React.memo(WorkspaceDashboardInner);
export default WorkspaceDashboard;
