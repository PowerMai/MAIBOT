/**
 * FullEditorV2 - 增强版三栏编辑器
 * 
 * 架构：
 * - 左侧：WorkspaceFileTree (文件管理 + 文件同步)
 * - 中间：增强编辑器 (多Tab + AI快捷操作 + 版本管理)
 * - 右侧：ChatArea (AI对话 + 上下文传递)
 * 
 * 集成：
 * - LangGraph API: 所有文件操作和AI功能
 * - 版本管理: 文件修改历史和回滚
 * - 实时同步: 前后端文件自动同步
 */
/// <reference path="../vite-env.d.ts" />

import React, { useState, useEffect, useRef, useCallback, useMemo, useImperativeHandle, forwardRef, lazy, Suspense } from 'react';
import { Resizable } from 're-resizable';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { t } from '../lib/i18n';

// UI组件
import { Button } from './ui/button';
import { cn } from './ui/utils';
import {
  FileText, Save, RefreshCw, X, Check, Sparkles, Search, Brain,
  Download, ExternalLink, Settings, PanelLeft, PanelLeftClose, Columns2, MessageCircle, ListTodo, Copy, AlertTriangle, MoreHorizontal, Wallet,
  Folder, BookOpen, CheckSquare, LayoutGrid, LayoutDashboard, Home, WrapText, Map as MapIcon,
  Maximize2, Minimize2, Plus, History, FileSpreadsheet,
} from 'lucide-react';

// 组件
import WorkspaceFileTree from './WorkspaceFileTree';
import { KnowledgeBasePanel } from './KnowledgeBasePanel';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from './ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Input } from './ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { ModelSelector } from './ChatComponents/model-selector';
import MonacoEditorEnhanced from './MonacoEditorEnhanced';
// PdfPreview 已合并进 UniversalFileViewer 内部处理
import { EditorCommandPalette } from './EditorCommandPalette';
import { KeyboardShortcutsHelp } from './KeyboardShortcutsHelp';
import { TaskListSidebar } from './TaskListSidebar';
import { MemoryPanel } from './MemoryPanel';
import { ErrorBoundary } from './common/ErrorBoundary';

// API
import langgraphApi from '../lib/langgraphApi';
import { checkHealth, getThreadState, isThreadNotFoundError, getApiBase } from '../lib/api/langserveChat';
import { useThreadExport } from '../lib/hooks/useThreadExport';
import { fileSystemService, isElectronEnv } from '../lib/services/electronService';
import { boardApi } from '../lib/api/boardApi';

// 事件总线与常量
import { fileEventBus } from '../lib/events/fileEvents';
import { EVENTS, SESSION_SWITCH_TIMEOUT_MS, type SessionChangedDetail } from '../lib/constants';
import { getFileTypeInfo, supportsDiffFormat, type FileFormat } from '../lib/utils/fileTypes';
import * as fileUtils from '../lib/fileUtils';
import { getItem as getStorageItem, setItem as setStorageItem } from '../lib/safeStorage';
import { getCurrentThreadIdFromStorage } from '../lib/runSummaryState';
import { useRunSummarySync } from '../lib/hooks/useRunSummarySync';
import { clearActiveThreadSession, getCurrentWorkspacePathFromStorage } from '../lib/sessionState';
import { getScopedActiveRoleIdFromStorage, normalizeRoleId } from '../lib/roleIdentity';
import { resolveScopedChatMode, MODE_BADGE_STYLES, MODE_STATUSBAR_BORDER, type ChatMode } from '../lib/chatModeState';

const SettingsView = lazy(() =>
  import('./SettingsView').then((m) => ({ default: m.SettingsView }))
);
// 静态导入避免 dev 下懒加载链（ChatAreaEnhanced -> thread -> markdown-text）触发 500
import ChatAreaEnhanced from './ChatAreaEnhanced';
const UniversalFileViewer = lazy(() =>
  import('./viewers/UniversalFileViewer').then((m) => ({ default: m.UniversalFileViewer }))
);
const MilkdownEditor = lazy(() =>
  import('./viewers/MilkdownEditor').then((m) => ({ default: m.MilkdownEditor }))
);
const WorkspaceDashboard = lazy(() =>
  import('./WorkspaceDashboard').then((m) => ({ default: m.WorkspaceDashboard }))
);
const TaskDetailView = lazy(() =>
  import('./TaskDetailView').then((m) => ({ default: m.TaskDetailView }))
);
const BidWizard = lazy(() =>
  import('./BidWizard').then((m) => ({ default: m.BidWizard }))
);
const KnowledgeGraphView = lazy(() =>
  import('./KnowledgeGraphView').then((m) => ({ default: m.KnowledgeGraphView }))
);

/** 编辑区虚拟 Tab：整体知识图谱（非磁盘文件） */
export const VIRTUAL_KNOWLEDGE_GRAPH_PATH = 'virtual://knowledge-graph';
const TaskExecutionPanel = lazy(() =>
  import('./TaskExecutionPanel').then((m) => ({ default: m.TaskExecutionPanel }))
);

// ============================================================================
// 类型定义
// ============================================================================

interface OpenFile {
  id: string;
  name: string;
  path: string;
  content: string;
  originalContent: string;  // 原始内容（用于检测修改）
  modified: boolean;
  language?: string;
  format: FileFormat;
  /** 渲染类别：决定使用哪个渲染器 */
  renderAs: 'monaco' | 'richtext' | 'viewer';
  /** 查看器提示：给 UniversalFileViewer 做内部路由 */
  viewerHint?: string;
  lastSaved?: Date;
  /** 二进制文件 base64 存于 base64Cache，此处仅类型保留便于兼容 */
  base64Data?: string;
  /** 文件 MIME 类型 */
  mimeType?: string;
  /** 文件大小 (bytes) */
  fileSize?: number;
  /** AI 修改前的原始内容（用于 diff 视图） */
  diffOriginal?: string;
  /** 是否处于 diff 模式 */
  showDiff?: boolean;
}

/** 二进制文件 base64 缓存（避免大字符串进入 React state 触发重拷贝），LRU 淘汰 */
const MAX_BASE64_CACHE_ENTRIES = 20;
const base64Cache = new Map<string, string>();
const base64CacheOrder: string[] = [];

function getBase64FromCache(fileId: string): string | undefined {
  return base64Cache.get(fileId);
}

function setBase64Cache(fileId: string, value: string): void {
  if (base64Cache.has(fileId)) {
    base64Cache.set(fileId, value);
    const i = base64CacheOrder.indexOf(fileId);
    if (i >= 0) {
      base64CacheOrder.splice(i, 1);
      base64CacheOrder.push(fileId);
    }
    return;
  }
  base64Cache.set(fileId, value);
  base64CacheOrder.push(fileId);
  while (base64Cache.size > MAX_BASE64_CACHE_ENTRIES && base64CacheOrder.length > 0) {
    const oldest = base64CacheOrder.shift();
    if (oldest !== undefined) base64Cache.delete(oldest);
  }
}

function removeBase64Cache(fileId: string): void {
  base64Cache.delete(fileId);
  const i = base64CacheOrder.indexOf(fileId);
  if (i >= 0) base64CacheOrder.splice(i, 1);
}

/** 单条 Lint 诊断（与 Monaco getModelMarkers 对齐，供 config.linter_errors） */
export type LinterErrorItem = { path: string; line: number; col: number; severity: number; message: string };

interface EditorState {
  activeFileId: string | null;
  openFiles: OpenFile[];
  selectedText: string;
  /** 选中区域行范围（供 get_selected_code 与聊天联动） */
  selectionRange?: { startLine: number; endLine: number };
  cursorPosition?: { line: number; column: number };
  /** 当前活动文件的 Lint 诊断（最多 20 条，供 Agent config.linter_errors） */
  linterErrors?: LinterErrorItem[];
}

interface FileVersion {
  timestamp: Date;
  content: string;
  description: string;
}

function isFileModified(file: OpenFile): boolean {
  return file.content !== file.originalContent;
}

interface WorkspaceInfo {
  id?: string;
  path?: string;
  name?: string;
}

interface FullEditorV2Props {
  className?: string;
  /** 打开命令面板 */
  onOpenCommandPalette?: () => void;
  /** 全局搜索面板是否打开（用于标题栏搜索触发器激活态） */
  commandPaletteOpen?: boolean;
  /** 外部请求打开设置（如 Cmd+, 或命令面板），为 true 时应在编辑器内打开设置并清除该请求 */
  openSettingsRequest?: boolean;
  /** 已处理打开设置请求后回调，用于 App 清除 openSettingsRequest */
  onOpenSettingsHandled?: () => void;
  /** 招投标向导在右侧面板展示（为 true 时右侧显示向导而非聊天） */
  bidWizardOpen?: boolean;
  /** 关闭招投标向导 */
  onBidWizardClose?: () => void;
}

/** 暴露给外部的方法 */
export interface FullEditorV2Handle {
  openFile: (path: string, content: string) => void;
}

/** 状态栏模型 ID 简短显示名（与 models.json 主力模型一致，单源展示） */
const STATUS_MODEL_LABELS: Record<string, string> = {
  auto: '自动',
  'qwen/qwen3.5-9b': 'Qwen3.5 9B',
  'qwen/qwen3.5-35b-a3b': 'Qwen3.5 35B',
  'qwen/qwen3-coder-30b': 'Qwen3 30B',
  'qwen3-coder-30b': 'Qwen3 30B',
  'bytedance/seed-oss-36b': 'Seed 36B',
};

function getStatusBarModelLabel(id: string | null): string {
  if (!id || id === '__no_models__') return '自动';
  return STATUS_MODEL_LABELS[id] ?? id.replace(/^.*\//, '');
}

/** 预览区错误兜底：单个文件预览崩溃时显示，可外部打开或关闭 Tab */
function EditorViewerErrorFallback({
  file,
  onOpenExternal,
  onClose,
}: {
  file: OpenFile | null;
  onOpenExternal: (f: OpenFile) => void;
  onClose: (fileId: string) => void;
}) {
  return (
    <div className="h-full min-h-0 flex flex-col items-center justify-center gap-4 p-6 bg-muted/30" role="alert" aria-label={t("editor.previewLoadError")}>
      <div className="flex items-center justify-center w-14 h-14 rounded-full bg-destructive/10">
        <AlertTriangle className="h-7 w-7 text-destructive" />
      </div>
      <p className="text-sm font-medium text-foreground">{t("editor.previewLoadError")}</p>
      {file && <p className="text-xs text-muted-foreground truncate max-w-full" title={file.path}>{file.name}</p>}
      <div className="flex items-center gap-2">
        {file && (
          <>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => onOpenExternal(file)}>
              <ExternalLink className="h-3.5 w-3.5" /> {t('viewer.openExternal')}
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => onClose(file.id)}>
              <X className="h-3.5 w-3.5" /> {t('viewer.close')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// 文件类型图标组件（对标 VSCode）
// ============================================================================

const _FILE_TYPE_COLORS: Record<string, string> = {
  'ts': 'text-blue-500', 'tsx': 'text-blue-500', 'mts': 'text-blue-500',
  'js': 'text-yellow-500', 'jsx': 'text-yellow-500', 'mjs': 'text-yellow-500',
  'py': 'text-green-500', 'pyw': 'text-green-500', 'ipynb': 'text-orange-500',
  'json': 'text-amber-500', 'yaml': 'text-red-400', 'yml': 'text-red-400',
  'xml': 'text-orange-500', 'csv': 'text-green-600',
  'html': 'text-orange-500', 'htm': 'text-orange-500',
  'css': 'text-blue-400', 'scss': 'text-pink-500', 'less': 'text-blue-400',
  'vue': 'text-emerald-500', 'svelte': 'text-orange-600',
  'md': 'text-blue-400', 'markdown': 'text-blue-400', 'mdx': 'text-blue-400',
  'txt': 'text-gray-500', 'log': 'text-gray-400',
  'pdf': 'text-red-500',
  'doc': 'text-blue-600', 'docx': 'text-blue-600',
  'xls': 'text-green-600', 'xlsx': 'text-green-600',
  'ppt': 'text-orange-600', 'pptx': 'text-orange-600',
  'png': 'text-purple-500', 'jpg': 'text-purple-500', 'jpeg': 'text-purple-500',
  'gif': 'text-purple-500', 'svg': 'text-amber-500', 'webp': 'text-purple-500',
  'go': 'text-cyan-500', 'rs': 'text-orange-700', 'rust': 'text-orange-700',
  'java': 'text-red-500', 'kt': 'text-purple-600', 'kotlin': 'text-purple-600',
  'c': 'text-blue-600', 'cpp': 'text-blue-600', 'h': 'text-blue-600',
  'cs': 'text-purple-500', 'php': 'text-purple-400',
  'rb': 'text-red-600', 'ruby': 'text-red-600',
  'swift': 'text-orange-500', 'scala': 'text-red-500',
  'sh': 'text-gray-500', 'bash': 'text-gray-500', 'zsh': 'text-gray-500',
  'sql': 'text-blue-500',
  'env': 'text-yellow-600', 'gitignore': 'text-gray-500',
  'dockerfile': 'text-blue-500', 'docker': 'text-blue-500',
};

const FileTypeIcon = React.memo<{ fileName: string; className?: string }>(function FileTypeIcon({ fileName, className = "" }) {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const color = _FILE_TYPE_COLORS[ext] || 'text-gray-400';
  return <FileText className={`${className} ${color}`} />;
});

// ============================================================================
// 文件类型检测工具 - 使用共享 lib/utils/fileTypes.ts
// ============================================================================

// getFileTypeInfo 已移至 lib/utils/fileTypes.ts（共享）

// ============================================================================
// 主组件
// ============================================================================

export const FullEditorV2Enhanced = forwardRef<FullEditorV2Handle, FullEditorV2Props>(function FullEditorV2Enhanced({ 
  className = '',
  onOpenCommandPalette,
  commandPaletteOpen = false,
  openSettingsRequest,
  onOpenSettingsHandled,
  bidWizardOpen = false,
  onBidWizardClose,
}, ref) {
  // ============================================================================
  // 状态管理
  // ============================================================================
  
  // 面板大小 - 拖拽更自由：左侧 140~420，右侧 280~900（持久化到 localStorage）；窗口变化时按视口 clamp 避免变形
  const [leftPanelWidth, setLeftPanelWidth] = useState(() => {
    if (typeof window === 'undefined') return 220;
    const w = window.innerWidth;
    const maxLeft = Math.min(420, Math.floor(w * 0.5));
    const clampLeft = (x: number) => Math.max(140, Math.min(x, maxLeft));
    try {
      const v = getStorageItem('maibot_left_panel_width');
      if (v == null) return clampLeft(220);
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? clampLeft(n) : clampLeft(220);
    } catch { return clampLeft(220); }
  });
  const [rightPanelWidth, setRightPanelWidth] = useState(() => {
    if (typeof window === 'undefined') return 420;
    const w = window.innerWidth;
    const maxRight = Math.min(900, Math.floor(w * 0.85));
    const clampRight = (x: number) => Math.max(280, Math.min(x, maxRight));
    try {
      const v = getStorageItem('maibot_right_panel_width');
      if (v == null) return clampRight(420);
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? clampRight(n) : clampRight(420);
    } catch { return clampRight(420); }
  });
  useEffect(() => {
    const handleResize = () => {
      const w = window.innerWidth;
      const maxLeft = Math.min(420, Math.floor(w * 0.5));
      const maxRight = Math.min(900, Math.floor(w * 0.85));
      const clampLeft = (x: number) => Math.max(140, Math.min(x, maxLeft));
      const clampRight = (x: number) => Math.max(280, Math.min(x, maxRight));
      setLeftPanelWidth((prev) => {
        const next = clampLeft(prev);
        return next !== prev ? next : prev;
      });
      setRightPanelWidth((prev) => {
        const next = clampRight(prev);
        return next !== prev ? next : prev;
      });
    };
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  const [showLeftPanel, setShowLeftPanel] = useState(() => {
    try { return getStorageItem('maibot_left_panel_open_by_default') === 'true'; } catch { return false; }
  });
  const [showRightPanel, setShowRightPanel] = useState(() => {
    try { return getStorageItem('maibot_right_panel_open_by_default') !== 'false'; } catch { return true; }
  });
  /** 资源管理器内部标签：工作区(文件) | 知识库 | 任务 | 记忆 */
  const [explorerTab, setExplorerTab] = useState<'files' | 'knowledge' | 'tasks' | 'memory'>('files');
  /** 知识库面板初始 Tab（open_skills_panel 事件时设为 "skills"） */
  const [knowledgeInitTab, setKnowledgeInitTab] = useState("files");
  /** 结晶建议跳转时传入的技能名，会传到知识库面板并预填草稿 */
  const [crystallizationSkillName, setCrystallizationSkillName] = useState<string | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ skill_name?: string }>).detail;
      const skillName = detail?.skill_name?.trim() || null;
      setCrystallizationSkillName(skillName);
      setShowLeftPanel(true);
      setExplorerTab("knowledge");
      setKnowledgeInitTab("skills");
    };
    window.addEventListener("open_skills_panel", handler);
    return () => window.removeEventListener("open_skills_panel", handler);
  }, []);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<'agent_profile' | 'workspaces' | undefined>(undefined);
  /** 在编辑区打开的任务列表（类似 openFiles） */
  const [openTasks, setOpenTasks] = useState<{ id: string; subject: string }[]>([]);
  /** 当前激活的任务 ID（在编辑区显示 TaskDetailView） */
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  /** 任务详情聚焦区块（例如 failed 场景聚焦 result） */
  const [taskFocusSectionById, setTaskFocusSectionById] = useState<Record<string, "result" | undefined>>({});
  const [showEditorCommandPalette, setShowEditorCommandPalette] = useState(false);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  // 两个独立 toggle：编辑区 / 对话区，至少保留一个可见
  const [showEditor, setShowEditorState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const v = getStorageItem('maibot_show_editor');
    return !v ? true : v === '1';
  });
  const [showChat, setShowChatState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const v = getStorageItem('maibot_show_chat');
    return !v ? true : v === '1';
  });
  const [taskRunning, setTaskRunning] = useState(false);
  /** 状态栏运行中时显示的当前步骤描述（由 TASK_PROGRESS 事件更新） */
  const [taskProgressMessage, setTaskProgressMessage] = useState<string | null>(null);
  /** 状态栏运行中时显示的步骤数（由 TASK_PROGRESS 事件更新，可选） */
  const [taskStepCount, setTaskStepCount] = useState<number | null>(null);
  /** write_todos 步骤进度（由 TASK_PROGRESS detail.todos 更新，可选） */
  const [todosProgress, setTodosProgress] = useState<{ done: number; total: number } | null>(null);
  /** 状态栏模型选择 Popover 开关 */
  const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
  /** 状态栏显示的模型 ID（用于 model_changed 后刷新） */
  const [statusBarModelId, setStatusBarModelId] = useState<string | null>(() =>
    typeof window !== 'undefined' ? (getStorageItem('maibot_selected_model') || null) : null
  );
  const [statusBarThreadId, setStatusBarThreadId] = useState<string | null>(null);
  const [statusBarThreadTitle, setStatusBarThreadTitle] = useState<string>('新对话');
  const [statusBarThreadRole, setStatusBarThreadRole] = useState<string>('');
  const [statusRunSummary, setStatusRunSummary] = useState<{
    running: boolean;
    phaseLabel?: string;
    activeTool?: string;
    elapsedSec?: number;
    lastError?: string;
    linkedTaskId?: string;
    linkedThreadId?: string;
    linkedSubject?: string;
    statusText?: string;
    recoveryPriority?: string;
  } | null>(null);
  const [focusModeEnabled, setFocusModeEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return getStorageItem('maibot_focus_mode') === '1';
  });
  const [agentFeatureFlags, setAgentFeatureFlags] = useState<{ tradeable_mode: boolean; wallet_enabled: boolean }>({
    tradeable_mode: false,
    wallet_enabled: false,
  });
  /** 当前聊天模式（底部栏颜色与角标） */
  const [activeMode, setActiveMode] = useState<ChatMode>(() => resolveScopedChatMode());
  /** 多窗口列表（仅 Electron 且 Popover 打开时轮询） */
  const [windowList, setWindowList] = useState<Array<{ id: number; title: string; primary: boolean; roleId: string; threadId: string | null }>>([]);
  const [windowPopoverOpen, setWindowPopoverOpen] = useState(false);
  /** 当前文件历史版本 Popover 开关（会话内版本，仅内存不持久化） */
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [newFilePopoverOpen, setNewFilePopoverOpen] = useState(false);
  /** 未保存的 xlsx 另存为：弹窗数据（fileId/path/fileName/base64） */
  const [saveAsXlsx, setSaveAsXlsx] = useState<{ fileId: string; path: string; fileName: string; base64: string } | null>(null);
  const [saveAsFilename, setSaveAsFilename] = useState('工作簿.xlsx');
  const [saveAsSubmitting, setSaveAsSubmitting] = useState(false);
  /** 二进制对比（原 | 新）：targetPath、originalBase64 未设置=待加载，null=无原文件/加载失败，string=已加载 */
  const [binaryDiffState, setBinaryDiffState] = useState<{ targetPath: string; originalBase64?: string | null; newBase64: string } | null>(null);
  const [binaryDiffSubmitting, setBinaryDiffSubmitting] = useState(false);
  const [binaryDiffSaveAsVisible, setBinaryDiffSaveAsVisible] = useState(false);
  const [binaryDiffSaveAsFilename, setBinaryDiffSaveAsFilename] = useState('');
  /** MCP 活跃服务器列表（仅 Electron 时 10s 轮询） */
  const [mcpServerNames, setMcpServerNames] = useState<string[]>([]);
  /** 待处理任务数（左侧 Tasks tab 徽章） */
  const [pendingTaskCount, setPendingTaskCount] = useState(0);
  /** 知识库更新徽章（5 分钟内显示） */
  const [knowledgeBadge, setKnowledgeBadge] = useState(false);
  /** 记忆条目数（状态栏显示，点击打开记忆面板） */
  const [memoryEntryCount, setMemoryEntryCount] = useState(0);
  /** 控制台 Tab：招投标向导 | 执行监控 */
  const [consoleTab, setConsoleTab] = useState<'wizard' | 'execution'>('wizard');
  /** 控制台当前绑定的任务（执行监控展示） */
  const [consoleLinkedTaskId, setConsoleLinkedTaskId] = useState<string | null>(null);
  const [consoleLinkedThreadId, setConsoleLinkedThreadId] = useState<string | null>(null);
  const [consoleLinkedSubject, setConsoleLinkedSubject] = useState<string | null>(null);

  // 编辑器状态
  const [editorState, setEditorState] = useState<EditorState>({
    activeFileId: null,
    openFiles: [],
    selectedText: '',
    linterErrors: [],
  });
  /** 工具卡片「打开到第 N 行」触发的跳转，Monaco 揭示后清除 */
  const [pendingGotoLine, setPendingGotoLine] = useState<number | null>(null);
  /** Tab 拖拽排序：当前拖拽中的 Tab 索引（ref 用于 drop 逻辑） */
  const tabDragIndexRef = useRef<number | null>(null);
  /** 被拖拽的 Tab 索引（用于 opacity 视觉） */
  const [tabDraggingIndex, setTabDraggingIndex] = useState<number | null>(null);
  /** 拖拽悬停目标索引（在该 Tab 左侧显示蓝色竖线） */
  const [tabDropIndicatorIndex, setTabDropIndicatorIndex] = useState<number | null>(null);
  /** 编辑区分栏：无 / 水平 / 垂直 */
  const [splitLayout, setSplitLayout] = useState<'none' | 'horizontal' | 'vertical'>(() => (getStorageItem('maibot_editor_split') as 'none' | 'horizontal' | 'vertical') || 'none');
  /** 分栏第二窗格尺寸（垂直时为高度 px，水平时为宽度 px），持久化 */
  const [splitSecondHeight, setSplitSecondHeight] = useState(() => {
    try {
      const v = getStorageItem('maibot_editor_split_second_height');
      const n = v ? parseInt(v, 10) : 320;
      return Number.isFinite(n) && n >= 120 ? n : 320;
    } catch { return 320; }
  });
  const [splitSecondWidth, setSplitSecondWidth] = useState(() => {
    try {
      const v = getStorageItem('maibot_editor_split_second_width');
      const n = v ? parseInt(v, 10) : 420;
      return Number.isFinite(n) && n >= 200 ? n : 420;
    } catch { return 420; }
  });
  const [wordWrap, setWordWrap] = useState<'on' | 'off'>(() => ((getStorageItem('maibot_editor_word_wrap') || 'off').toLowerCase() === 'on' ? 'on' : 'off'));
  const [minimapEnabled, setMinimapEnabled] = useState<boolean>(() => getStorageItem('maibot_editor_minimap') === 'true');
  /** 分栏时第二窗格显示的文件 ID */
  const [splitSecondFileId, setSplitSecondFileId] = useState<string | null>(null);
  /** 关闭未保存文件时弹出的确认对话框：待关闭的文件 ID */
  const [pendingCloseFileId, setPendingCloseFileId] = useState<string | null>(null);
  /** 批量关闭（关闭其他/右侧）时存在未保存文件，待确认的 ID 列表 */
  const [pendingBatchCloseIds, setPendingBatchCloseIds] = useState<string[] | null>(null);
  /** 刷新已修改文件时的确认对话框：待刷新的文件信息 */
  const [refreshConfirmFile, setRefreshConfirmFile] = useState<{ id: string; name: string; path: string; format?: string } | null>(null);
  /** 最近活动的文件 ID 列表（用于 Ctrl+Tab 切换），按最近使用顺序 */
  const recentFileIdsRef = useRef<string[]>([]);
  const prevActiveFileIdRef = useRef<string | null>(null);

  // 工作区和文件信息
  const [currentWorkspace, setCurrentWorkspace] = useState<WorkspaceInfo | null>(null);
  
  // 版本历史
  const [fileVersions, setFileVersions] = useState<Map<string, FileVersion[]>>(new Map());
  
  // 加载和保存状态
  const [savingFiles, setSavingFiles] = useState<Set<string>>(new Set());
  const savingFilesRef = useRef<Set<string>>(new Set());
  const [autoSaveEnabled, setAutoSaveEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try {
      return getStorageItem('maibot_settings_autoSave') !== 'false';
    } catch {
      return true;
    }
  });
  
  // 按文件 ID 维护自动保存定时器，关闭 Tab 时清理对应定时器
  const autoSaveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const uiTimersRef = useRef<Set<number>>(new Set());
  const isMountedRef = useRef(true);
  const runAfterThreadSwitchPendingRef = useRef<{ listener: EventListener; timer: number } | null>(null);
  const scheduleUiTimeout = useCallback((callback: () => void, delay: number): number => {
    const timerId = window.setTimeout(() => {
      uiTimersRef.current.delete(timerId);
      callback();
    }, delay);
    uiTimersRef.current.add(timerId);
    return timerId;
  }, []);
  const runAfterThreadSwitch = useCallback((threadId: string | undefined, next: () => void) => {
    const targetThreadId = String(threadId || "").trim();
    if (!targetThreadId) {
      next();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      if (!isMountedRef.current) return;
      done = true;
      const pending = runAfterThreadSwitchPendingRef.current;
      if (pending) {
        window.removeEventListener(EVENTS.SESSION_CHANGED, pending.listener);
        window.clearTimeout(pending.timer);
        runAfterThreadSwitchPendingRef.current = null;
      }
      next();
    };
    const fail = () => {
      if (done) return;
      if (!isMountedRef.current) return;
      done = true;
      const pending = runAfterThreadSwitchPendingRef.current;
      if (pending) {
        window.removeEventListener(EVENTS.SESSION_CHANGED, pending.listener);
        window.clearTimeout(pending.timer);
        runAfterThreadSwitchPendingRef.current = null;
      }
      toast.error(t("session.switchIncomplete"), { description: t("session.switchIncompleteDesc") });
    };
    const onSessionChanged = (event: Event) => {
      const detail = (event as CustomEvent<SessionChangedDetail>).detail;
      if (String(detail?.threadId || "").trim() === targetThreadId) {
        finish();
      }
    };
    const fallbackTimer = window.setTimeout(fail, SESSION_SWITCH_TIMEOUT_MS);
    window.addEventListener(EVENTS.SESSION_CHANGED, onSessionChanged as EventListener);
    runAfterThreadSwitchPendingRef.current = { listener: onSessionChanged as EventListener, timer: fallbackTimer };
    window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_TO_THREAD, { detail: { threadId: targetThreadId } }));
  }, []);
  useEffect(() => {
    return () => {
      const pending = runAfterThreadSwitchPendingRef.current;
      if (pending) {
        window.removeEventListener(EVENTS.SESSION_CHANGED, pending.listener);
        window.clearTimeout(pending.timer);
        runAfterThreadSwitchPendingRef.current = null;
      }
    };
  }, []);

  // ============================================================================
  // 辅助函数
  // ============================================================================

  // 获取活跃文件（useMemo 避免每次渲染重新计算）
  const activeFile = useMemo(
    () => editorState.openFiles.find(f => f.id === editorState.activeFileId) ?? null,
    [editorState.openFiles, editorState.activeFileId]
  );
  const splitSecondFile = useMemo(
    () => (splitSecondFileId ? editorState.openFiles.find(f => f.id === splitSecondFileId) ?? null : null),
    [editorState.openFiles, splitSecondFileId]
  );
  const modifiedOpenFiles = useMemo(
    () => editorState.openFiles.filter(isFileModified),
    [editorState.openFiles]
  );
  const activeFileRef = useRef<OpenFile | null>(activeFile);
  const openFilesRef = useRef<OpenFile[]>(editorState.openFiles);

  useEffect(() => {
    boardApi.getAgentProfile().then((res) => {
      if (!isMountedRef.current) return;
      if (!res.ok || !res.profile) return;
      const f = (res.profile as any).features || {};
      setAgentFeatureFlags({
        tradeable_mode: Boolean(f.tradeable_mode),
        wallet_enabled: Boolean(f.wallet_enabled),
      });
    }).catch(() => {
      if (!isMountedRef.current) return;
      toast.error(t('dashboard.agentProfileLoadError'));
    });
  }, []);
  const activeFileIdRef = useRef<string | null>(editorState.activeFileId);
  const openTasksRef = useRef<{ id: string; subject: string }[]>(openTasks);
  const activeTaskIdRef = useRef<string | null>(activeTaskId);
  const memoryCountErrorToastShownRef = useRef(false);
  const pendingTaskCountErrorToastShownRef = useRef(false);
  const lineCountCacheRef = useRef<Map<string, { contentLength: number; lineCount: number }>>(new Map());
  const shortcutActionsRef = useRef<{
    handleCloseTaskTab: (taskId: string) => void;
    handleNewFile: () => void;
    openNewFilePopover?: () => void;
    handleSaveFile: (fileId: string) => Promise<void> | void;
    handleSaveAll: () => Promise<void> | void;
    handleFileClose: (fileId: string) => void;
    handleRefreshFile: (fileId: string) => Promise<void> | void;
    persistShowChat: (show: boolean) => void;
    onOpenCommandPalette?: () => void;
  } | null>(null);
  useEffect(() => {
    activeFileRef.current = activeFile;
    openFilesRef.current = editorState.openFiles;
    activeFileIdRef.current = editorState.activeFileId;
    openTasksRef.current = openTasks;
    activeTaskIdRef.current = activeTaskId;
  }, [activeFile, editorState.openFiles, editorState.activeFileId, openTasks, activeTaskId]);
  // 同步当前编辑文件路径到 sessionStorage，供聊天区代码块「应用」无 filePath 时 fallback
  useEffect(() => {
    if (typeof sessionStorage === 'undefined') return;
    if (activeFile?.path) {
      sessionStorage.setItem('maibot_editor_active_file_path', activeFile.path);
    } else {
      sessionStorage.removeItem('maibot_editor_active_file_path');
    }
    window.dispatchEvent(new CustomEvent(EVENTS.ACTIVE_FILE_PATH_CHANGED));
  }, [activeFile?.path]);

  const activeFileDisplayPath = useMemo(() => {
    if (!activeFile?.path) return '';
    const workspaceRoot = currentWorkspace?.path;
    if (workspaceRoot && activeFile.path.startsWith(workspaceRoot)) {
      const relative = activeFile.path.slice(workspaceRoot.length).replace(/^[/\\]+/, '');
      return relative || activeFile.path;
    }
    return activeFile.path;
  }, [activeFile, currentWorkspace?.path]);

  // 维护最近文件列表（用于 Ctrl+Tab）
  useEffect(() => {
    const prev = prevActiveFileIdRef.current;
    const next = editorState.activeFileId;
    prevActiveFileIdRef.current = next;
    if (prev != null && prev !== next && editorState.openFiles.some(f => f.id === prev)) {
      const list = recentFileIdsRef.current.filter(id => id !== next);
      list.unshift(prev);
      recentFileIdsRef.current = list.slice(0, 20);
    }
  }, [editorState.activeFileId, editorState.openFiles]);

  // 仅在文件内容变化时更新行数缓存，避免光标移动触发全文 split
  const lineCountByFileId = useMemo(() => {
    const next = new Map<string, number>();
    const aliveIds = new Set<string>();
    for (const f of editorState.openFiles) {
      aliveIds.add(f.id);
      const cached = lineCountCacheRef.current.get(f.id);
      const contentLength = f.content.length;
      if (cached && cached.contentLength === contentLength) {
        next.set(f.id, cached.lineCount);
        continue;
      }
      const lineCount = f.content.split(/\r?\n/).length;
      lineCountCacheRef.current.set(f.id, { contentLength, lineCount });
      next.set(f.id, lineCount);
    }
    // 清理已关闭文件的缓存，防止无界增长
    for (const id of Array.from(lineCountCacheRef.current.keys())) {
      if (!aliveIds.has(id)) lineCountCacheRef.current.delete(id);
    }
    return next;
  }, [editorState.openFiles]);

  // 供 ChatArea 使用的 openFiles / workspaceFiles，避免每次渲染创建新数组导致子组件重渲染
  const openFilesForChat = useMemo(
    () =>
      editorState.openFiles.map((f) => ({
        path: f.path,
        totalLines: lineCountByFileId.get(f.id) ?? 1,
        cursorLine:
          editorState.activeFileId === f.id ? editorState.cursorPosition?.line : undefined,
      })),
    [
      editorState.openFiles,
      lineCountByFileId,
      editorState.activeFileId,
      editorState.cursorPosition?.line,
    ]
  );
  /** 当前已打开文件路径列表（供 openFilePaths 等用）；工作区文件列表由 Chat 侧按 workspacePath 拉取，不由此处传 workspaceFiles */
  const workspaceFilePaths = useMemo(
    () => editorState.openFiles.map((f) => f.path),
    [editorState.openFiles]
  );

  /** 最近查看的文件路径（当前激活优先，其余按 Tab 顺序），供 Chat 环境感知，与 MyRuntimeProvider maxRecentFiles 对齐 */
  const recentlyViewedFilesForChat = useMemo(() => {
    const list = editorState.openFiles.map((f) => f.path);
    if (list.length <= 1) return list;
    const activePath = editorState.openFiles.find((f) => f.id === editorState.activeFileId)?.path;
    if (!activePath) return list.slice(0, 30);
    const ordered = [activePath, ...list.filter((p) => p !== activePath)];
    return ordered.slice(0, 30);
  }, [editorState.openFiles, editorState.activeFileId]);

  // ============================================================================
  // 文件操作
  // ============================================================================

  /**
   * 打开文件
   */
  const handleFileOpen = useCallback(async (file: { 
    id: string; 
    name: string; 
    path: string; 
    content: string; 
    language?: string; 
    format?: FileFormat;
    base64Data?: string;
    mimeType?: string;
    fileSize?: number;
  }) => {
    // 检查是否是文件删除通知
    if (file.content === '__FILE_DELETED__') {
      setEditorState(prev => {
        const existingFile = prev.openFiles.find(f => f.path === file.path);
        if (!existingFile) return prev;
        const timer = autoSaveTimersRef.current.get(existingFile.id);
        if (timer) {
          clearTimeout(timer);
          autoSaveTimersRef.current.delete(existingFile.id);
        }
        const newOpenFiles = prev.openFiles.filter(f => f.id !== existingFile.id);
        let newActiveFileId = prev.activeFileId;
        if (newActiveFileId === existingFile.id) {
          newActiveFileId = newOpenFiles.length > 0 ? newOpenFiles[0].id : null;
        }
        return { ...prev, openFiles: newOpenFiles, activeFileId: newActiveFileId };
      });
      const existingName = editorState.openFiles.find(f => f.path === file.path)?.name;
      if (existingName) toast.info(`文件 "${existingName}" 已删除，已关闭编辑器中的文件`);
      return;
    }

    // 检查是否是文件重命名通知
    if (file.content.startsWith('__FILE_RENAMED__:')) {
      const newPath = file.content.replace('__FILE_RENAMED__:', '');
      setEditorState(prev => {
        const existingFile = prev.openFiles.find(f => f.path === file.path);
        if (!existingFile) return prev;
        return {
          ...prev,
          openFiles: prev.openFiles.map(f =>
            f.id === existingFile.id
              ? {
                  ...f,
                  path: newPath,
                  name: newPath.split('/').pop() || f.name,
                }
              : f
          ),
        };
      });
      toast.info(`文件已重命名为: ${newPath.split('/').pop()}`);
      return;
    }

    // 副作用在 updater 外执行，避免 Concurrent Mode 下重复执行
    const existingFromState = editorState.openFiles.find(f => f.path === file.path);
    if (existingFromState && file.base64Data !== undefined) setBase64Cache(existingFromState.id, file.base64Data);
    const newIdForOpen = file.id || crypto.randomUUID();
    if (!existingFromState && file.base64Data !== undefined) setBase64Cache(newIdForOpen, file.base64Data);

    setEditorState(prev => {
      // 检查文件是否已打开：若已打开则刷新内容并聚焦（避免“有 Tab 但内容不显示”）
      const existingIndex = prev.openFiles.findIndex(f => f.path === file.path);
      if (existingIndex >= 0) {
        const existing = prev.openFiles[existingIndex];
        const hasNewContent = file.content !== undefined && file.content !== existing.content;
        const hasNewBase64 = file.base64Data !== undefined && file.base64Data !== getBase64FromCache(existing.id);
        if (hasNewContent || hasNewBase64) {
          const updatedTypeInfo = getFileTypeInfo(existing.name);
          const updated: OpenFile = {
            ...existing,
            content: file.content !== undefined ? file.content : existing.content,
            originalContent: file.content !== undefined ? file.content : existing.originalContent,
            mimeType: file.mimeType !== undefined ? file.mimeType : existing.mimeType,
            fileSize: file.fileSize !== undefined ? file.fileSize : existing.fileSize,
            format: file.format || existing.format,
            language: file.language ?? existing.language,
            renderAs: existing.renderAs || updatedTypeInfo.renderAs,
            viewerHint: existing.viewerHint || updatedTypeInfo.viewerHint,
          };
          const nextOpenFiles = [...prev.openFiles];
          nextOpenFiles[existingIndex] = updated;
          return { ...prev, openFiles: nextOpenFiles, activeFileId: existing.id };
        }
        return { ...prev, activeFileId: existing.id };
      }

      // 创建新文件 tab；二进制数据放入 cache，不进入 state
      const typeInfo = getFileTypeInfo(file.name);
      const newFile: OpenFile = {
        id: newIdForOpen,
        name: file.name,
        path: file.path,
        content: file.content,
        originalContent: file.content,
        modified: false,
        language: file.language || typeInfo.language,
        format: file.format || typeInfo.format,
        renderAs: typeInfo.renderAs,
        viewerHint: typeInfo.viewerHint,
        lastSaved: new Date(),
        mimeType: file.mimeType || typeInfo.mimeType,
        fileSize: file.fileSize,
      };

      return { 
        ...prev, 
        openFiles: [...prev.openFiles, newFile], 
        activeFileId: newFile.id 
      };
    });

    // 通知 ChatArea 当前文件已切换
    if (import.meta.env?.DEV) console.log('[FullEditorV2] 文件已打开:', file.path);
  }, [editorState.openFiles]);

  // ✅ 暴露 openFile 方法给外部组件（通过 ref）
  useImperativeHandle(ref, () => ({
    openFile: (path: string, content: string) => {
      const fileName = path.split('/').pop() || 'untitled';
      const { language, format } = getFileTypeInfo(fileName);

      handleFileOpen({
        id: crypto.randomUUID(),
        name: fileName,
        path,
        content,
        language,
        format,
      });
    },
  }), [handleFileOpen]);

  /**
   * 保存文件（优先使用 Electron API 写入本地，然后同步到后端）
   */
  const handleSaveFile = useCallback(async (fileId?: string, isAutoSave = false) => {
    const targetFile = fileId 
      ? editorState.openFiles.find(f => f.id === fileId)
      : activeFile;

    if (!targetFile) return;
    if (targetFile.path === VIRTUAL_KNOWLEDGE_GRAPH_PATH) {
      if (!isAutoSave) toast.info(t("editor.knowledgeGraphReadOnlyToast"));
      return;
    }
    const isVirtualPath = targetFile.path.startsWith('__artifact__/') || targetFile.path.startsWith('__code__/') || targetFile.path.startsWith('/virtual/');
    if (isVirtualPath) {
      if (!isAutoSave) toast.info(t('editor.virtualFileSaveHint'));
      return;
    }

    if (savingFilesRef.current.has(targetFile.id)) {
      if (!isAutoSave) toast.info(t("editor.savingPleaseWait"));
      return;
    }

    if (!isFileModified(targetFile)) {
      if (!isAutoSave) {
        toast.info(`文件 "${targetFile.name}" 无需保存`);
      }
      return;
    }

    try {
      savingFilesRef.current.add(targetFile.id);
      setSavingFiles(prev => new Set(prev).add(targetFile.id));

      const electron = (window as any)?.electron;
      
      // 1. Electron 环境：优先写入本地文件
      if (electron?.writeFile && targetFile.path && !targetFile.path.startsWith('/untitled-')) {
        // 检查是否是本地绝对路径（Unix 或 Windows）
        const isLocalPath = targetFile.path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(targetFile.path);
        
        if (isLocalPath) {
          const result = await electron.writeFile({ 
            filePath: targetFile.path, 
            content: targetFile.content 
          });
          
          if (result.success) {
            if (import.meta.env?.DEV) console.log('[FullEditorV2] 本地文件已保存:', targetFile.path);
            
            // 本地保存成功后，也同步到后端（用于 AI 访问）
            try {
              await langgraphApi.writeFile(targetFile.path, targetFile.content);
            } catch (backendError) {
              if (import.meta.env?.DEV) console.warn('[FullEditorV2] 后端同步失败:', backendError);
            }
          } else {
            throw new Error(result.error || '写入本地文件失败');
          }
        } else {
          // 相对路径或新文件，使用 LangGraph API
          await langgraphApi.writeFile(targetFile.path, targetFile.content);
        }
      } else {
        // 2. Web 环境或新文件：使用 LangGraph API
        if (import.meta.env?.DEV) console.log('[FullEditorV2] LangGraph API 保存:', targetFile.path);
        await langgraphApi.writeFile(targetFile.path, targetFile.content);
      }

      // 保存成功后更新状态
      setEditorState(prev => ({
        ...prev,
        openFiles: prev.openFiles.map(f =>
          f.id === targetFile.id
            ? { ...f, originalContent: f.content, modified: false, lastSaved: new Date() }
            : f
        ),
      }));

      // 添加到版本历史（每文件最多保留 30 个版本）
      const MAX_VERSIONS_PER_FILE = 30;
      setFileVersions(prev => {
        const versions = prev.get(targetFile.path) || [];
        const newVersion: FileVersion = {
          timestamp: new Date(),
          content: targetFile.content,
          description: isAutoSave ? '自动保存' : '手动保存',
        };
        const next = [...versions, newVersion].slice(-MAX_VERSIONS_PER_FILE);
        return new Map(prev).set(targetFile.path, next);
      });

      if (!isAutoSave) {
        toast.success(`文件 "${targetFile.name}" 已保存`);
      }
    } catch (error) {
      console.error('[FullEditorV2] 保存文件失败:', error);
      toast.error(t('editor.saveFailed'), { description: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      savingFilesRef.current.delete(targetFile.id);
      setSavingFiles(prev => {
        const newSet = new Set(prev);
        newSet.delete(targetFile.id);
        return newSet;
      });
    }
  }, [editorState.openFiles, activeFile]);

  /** 保存二进制文件到工作区（如 Excel 编辑后写回 xlsx）；未命名 xlsx 会打开另存为弹窗 */
  const handleSaveBinaryFile = useCallback((fileId: string, path: string, fileName: string, base64: string) => {
    const isVirtual = path.startsWith('/virtual/') || path.startsWith('__artifact__') || path.startsWith('__code__');
    if (isVirtual) {
      toast.info(t('editor.virtualFileSaveHint'));
      return;
    }
    const isUntitledXlsx = path.startsWith('/untitled-') && path.endsWith('.xlsx');
    if (isUntitledXlsx) {
      setSaveAsFilename(t('editor.saveAsDefaultName'));
      setSaveAsXlsx({ fileId, path, fileName, base64 });
      return;
    }
    fileSystemService.writeFileBinary(path, base64).then((res) => {
      if (!isMountedRef.current) return;
      if (!res.success) {
        toast.error(t('editor.saveFailed'), { description: res.error });
        return;
      }
      setBase64Cache(fileId, base64);
      toast.success(t('editor.fileSavedTo', { path }));
    });
  }, []);

  /** 执行另存为：将未命名 xlsx 写入工作区指定路径并更新 Tab */
  const handleSaveAsXlsxConfirm = useCallback(async () => {
    if (!saveAsXlsx) return;
    const workspaceRoot = (currentWorkspace?.path ?? getCurrentWorkspacePathFromStorage() ?? '').toString().trim().replace(/[/\\]+$/, '');
    if (!workspaceRoot) {
      toast.error(t('editor.saveAsNoWorkspace'));
      return;
    }
    setSaveAsSubmitting(true);
    try {
      let name = saveAsFilename.trim() || t('editor.saveAsDefaultName');
      if (!name.toLowerCase().endsWith('.xlsx')) name += '.xlsx';
      const fullPath = workspaceRoot + '/' + name.replace(/^[/\\]+/, '');
      const res = await fileSystemService.writeFileBinary(fullPath, saveAsXlsx.base64);
      if (!res.success) {
        toast.error(t('editor.saveFailed'), { description: res.error });
        return;
      }
      setBase64Cache(saveAsXlsx.fileId, saveAsXlsx.base64);
      setEditorState((prev) => ({
        ...prev,
        openFiles: prev.openFiles.map((f) =>
          f.id === saveAsXlsx.fileId ? { ...f, path: fullPath, name, modified: false } : f
        ),
      }));
      setSaveAsXlsx(null);
      toast.success(t('editor.fileSavedTo', { path: fullPath }));
    } finally {
      setSaveAsSubmitting(false);
    }
  }, [saveAsXlsx, saveAsFilename, currentWorkspace?.path]);

  /** 二进制对比：接受并覆盖目标路径 */
  const handleBinaryDiffAccept = useCallback(async () => {
    if (!binaryDiffState) return;
    setBinaryDiffSubmitting(true);
    try {
      const res = await fileSystemService.writeFileBinary(binaryDiffState.targetPath, binaryDiffState.newBase64);
      if (!res.success) {
        toast.error(t('editor.saveFailed'), { description: res.error });
        return;
      }
      setBinaryDiffState(null);
      setBinaryDiffSaveAsVisible(false);
      toast.success(t('editor.fileSavedTo', { path: binaryDiffState.targetPath }));
    } finally {
      setBinaryDiffSubmitting(false);
    }
  }, [binaryDiffState]);

  /** 二进制对比：另存为到工作区指定路径 */
  const handleBinaryDiffSaveAs = useCallback(async () => {
    if (!binaryDiffState) return;
    const workspaceRoot = (currentWorkspace?.path ?? getCurrentWorkspacePathFromStorage() ?? '').toString().trim().replace(/[/\\]+$/, '');
    if (!workspaceRoot) {
      toast.error(t('editor.saveAsNoWorkspace'));
      return;
    }
    const name = binaryDiffSaveAsFilename.trim() || binaryDiffState.targetPath.replace(/^.*[/\\]/, '') || 'saved.bin';
    if (name.includes('..')) {
      toast.error(t('editor.saveAsInvalidPath'));
      return;
    }
    const fullPath = workspaceRoot + '/' + name.replace(/^[/\\]+/, '');
    setBinaryDiffSubmitting(true);
    try {
      const res = await fileSystemService.writeFileBinary(fullPath, binaryDiffState.newBase64);
      if (!res.success) {
        toast.error(t('editor.saveFailed'), { description: res.error });
        return;
      }
      setBinaryDiffState(null);
      setBinaryDiffSaveAsVisible(false);
      toast.success(t('editor.fileSavedTo', { path: fullPath }));
    } finally {
      setBinaryDiffSubmitting(false);
    }
  }, [binaryDiffState, binaryDiffSaveAsFilename, currentWorkspace?.path]);

  /**
   * 文件内容变更
   */
  const handleFileContentChange = useCallback((fileId: string, newContent: string) => {
    setEditorState(prev => ({
      ...prev,
      openFiles: prev.openFiles.map(f =>
        f.id === fileId 
          ? { ...f, content: newContent, modified: isFileModified({ ...f, content: newContent } as OpenFile) }
          : f
      ),
    }));

    // 触发自动保存（每文件独立定时器）
    if (autoSaveEnabled && isMountedRef.current) {
      const existing = autoSaveTimersRef.current.get(fileId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        autoSaveTimersRef.current.delete(fileId);
        if (!isMountedRef.current) return;
        handleSaveFile(fileId, true);
      }, 2000);
      autoSaveTimersRef.current.set(fileId, timer);
    }
  }, [autoSaveEnabled, handleSaveFile]);

  const handleEditorSelectionChange = useCallback((selectedText: string, range?: { startLine: number; endLine: number }) => {
    setEditorState(prev => ({ ...prev, selectedText, selectionRange: range }));
  }, []);

  // 派发选区变更供 Composer 显示「添加为上下文」提示条
  const editorSelectionRef = useRef({ selectedText: "", range: null as { startLine: number; endLine: number } | null, path: "", name: "" });
  useEffect(() => {
    const active = editorState.openFiles.find(f => f.id === editorState.activeFileId) ?? null;
    const payload = {
      selectedText: editorState.selectedText?.trim() ?? "",
      selectionRange: editorState.selectionRange ?? null,
      filePath: active?.path ?? "",
      fileName: active?.name ?? "",
    };
    if (
      payload.selectedText !== editorSelectionRef.current.selectedText ||
      payload.selectionRange !== editorSelectionRef.current.range ||
      payload.filePath !== editorSelectionRef.current.path
    ) {
      editorSelectionRef.current = {
        selectedText: payload.selectedText,
        range: payload.selectionRange,
        path: payload.filePath,
        name: payload.fileName,
      };
      window.dispatchEvent(
        new CustomEvent(EVENTS.EDITOR_SELECTION_CHANGED, {
          detail: {
            selectedText: payload.selectedText,
            selectionRange: payload.selectionRange,
            filePath: payload.filePath || undefined,
            fileName: payload.fileName || undefined,
          },
        })
      );
    }
  }, [editorState.selectedText, editorState.selectionRange, editorState.activeFileId, editorState.openFiles]);

  const handleEditorCursorChange = useCallback((line: number, column: number) => {
    setEditorState(prev => ({ ...prev, cursorPosition: { line, column } }));
  }, []);

  /** 实际执行关闭：清理定时器、缓存并从 state 移除（不弹窗） */
  const doCloseFileById = useCallback((fileId: string) => {
    const timer = autoSaveTimersRef.current.get(fileId);
    if (timer) {
      clearTimeout(timer);
      autoSaveTimersRef.current.delete(fileId);
    }
    removeBase64Cache(fileId);
    setSplitSecondFileId(prev => prev === fileId ? null : prev);
    setEditorState(prev => {
      const newOpenFiles = prev.openFiles.filter(f => f.id !== fileId);
      let newActiveFileId = prev.activeFileId;
      if (newActiveFileId === fileId) {
        newActiveFileId = newOpenFiles.length > 0 ? newOpenFiles[0].id : null;
      }
      return { ...prev, openFiles: newOpenFiles, activeFileId: newActiveFileId };
    });
  }, []);

  /**
   * 关闭文件（未保存时弹出保存/不保存/取消对话框，对齐 Cursor/VSCode）
   */
  const handleFileClose = useCallback((fileId: string) => {
    const file = editorState.openFiles.find(f => f.id === fileId);
    if (file && isFileModified(file)) {
      setPendingCloseFileId(fileId);
      return;
    }
    doCloseFileById(fileId);
  }, [editorState.openFiles, doCloseFileById]);

  /** 从资源区/文件树/知识库打开文件：解析预览包或对二进制格式走 readFileBinary 回退（xls/xlsx 等一致处理） */
  const handleFileOpenFromExplorer = useCallback(async (path: string, content: string) => {
    const fileName = path.split('/').pop()?.split('?')[0] || path.replace(/^.*[/\\]/, '') || 'untitled';
    const { language, format, mimeType } = getFileTypeInfo(fileName);
    const parsePreview = (prefix: string, endTag: string) => {
      const jsonStr = content.replace(prefix, '').replace(endTag, '').trim();
      try { return JSON.parse(jsonStr) as { base64: string; size?: number }; } catch { return null; }
    };
    if (content.startsWith('__PDF_PREVIEW__')) {
      const data = parsePreview('__PDF_PREVIEW__', '__PDF_PREVIEW_END__');
      if (data?.base64) {
        handleFileOpen({ id: crypto.randomUUID(), name: fileName, path, content: '', language, format: 'pdf', base64Data: data.base64, mimeType: 'application/pdf', fileSize: data.size });
        return;
      }
    }
    if (content.startsWith('__DOCX_PREVIEW__')) {
      const data = parsePreview('__DOCX_PREVIEW__', '__DOCX_PREVIEW_END__');
      if (data?.base64) {
        handleFileOpen({ id: crypto.randomUUID(), name: fileName, path, content: '', language, format: 'docx', base64Data: data.base64, mimeType: mimeType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileSize: data.size });
        return;
      }
    }
    if (content.startsWith('__EXCEL_PREVIEW__')) {
      const data = parsePreview('__EXCEL_PREVIEW__', '__EXCEL_PREVIEW_END__');
      if (data?.base64) {
        handleFileOpen({ id: crypto.randomUUID(), name: fileName, path, content: '', language, format: 'excel', base64Data: data.base64, mimeType: mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileSize: data.size });
        return;
      }
    }
    if (content.startsWith('__PPT_PREVIEW__')) {
      const data = parsePreview('__PPT_PREVIEW__', '__PPT_PREVIEW_END__');
      if (data?.base64) {
        handleFileOpen({ id: crypto.randomUUID(), name: fileName, path, content: '', language, format: 'ppt', base64Data: data.base64, mimeType: mimeType || 'application/vnd.openxmlformats-officedocument.presentationml.presentation', fileSize: data.size });
        return;
      }
    }
    if (content.startsWith('__IMAGE_PREVIEW__')) {
      const data = parsePreview('__IMAGE_PREVIEW__', '__IMAGE_PREVIEW_END__') as { base64?: string; size?: number; extension?: string } | null;
      if (data?.base64) {
        const ext = (data.extension || fileName.split('.').pop() || 'png').toLowerCase();
        const imageMime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon' };
        handleFileOpen({
          id: crypto.randomUUID(),
          name: fileName,
          path,
          content: '',
          language: ext,
          format: 'image',
          base64Data: data.base64,
          mimeType: mimeType || imageMime[ext] || 'image/png',
          fileSize: data.size,
        });
        return;
      }
    }
    if (format === 'pdf' || format === 'docx' || format === 'excel' || format === 'ppt') {
      const result = await fileSystemService.readFileBinary(path);
      if (result.success && result.data) {
        handleFileOpen({
          id: crypto.randomUUID(),
          name: fileName,
          path,
          content: '',
          language,
          format,
          base64Data: result.data.base64,
          mimeType: mimeType || undefined,
          fileSize: result.data.size,
        });
        return;
      }
      if (format === 'pdf') { toast.error(`无法读取 PDF: ${fileName}`); return; }
      if (format === 'excel') { toast.error(`无法读取 Excel: ${fileName}`); return; }
      if (format === 'docx') { toast.error(`无法读取 Word: ${fileName}`); return; }
      if (format === 'ppt') { toast.error(`无法读取 PPT: ${fileName}`); return; }
    }
    handleFileOpen({
      id: crypto.randomUUID(),
      name: fileName,
      path,
      content,
      language,
      format,
    });
  }, [handleFileOpen]);

  /** 新建未命名文件（Tab 栏 + 命令面板 file.new） */
  const handleNewFile = useCallback(() => {
    const newId = crypto.randomUUID();
    const newFile: OpenFile = {
      id: newId,
      name: 'untitled.txt',
      path: `/untitled-${newId}.txt`,
      content: '',
      originalContent: '',
      modified: true,
      language: 'plaintext',
      format: 'text',
      renderAs: 'monaco',
    };
    setEditorState(prev => ({
      ...prev,
      openFiles: [...prev.openFiles, newFile],
      activeFileId: newFile.id,
    }));
  }, []);

  /** 新建 Markdown */
  const handleNewMarkdown = useCallback(() => {
    const newId = crypto.randomUUID();
    const typeInfo = getFileTypeInfo('untitled.md');
    const newFile: OpenFile = {
      id: newId,
      name: 'untitled.md',
      path: `/untitled-${newId}.md`,
      content: '',
      originalContent: '',
      modified: true,
      language: typeInfo.language,
      format: typeInfo.format,
      renderAs: typeInfo.renderAs,
    };
    setEditorState(prev => ({
      ...prev,
      openFiles: [...prev.openFiles, newFile],
      activeFileId: newFile.id,
    }));
  }, []);

  /** 新建空表格（xlsx） */
  const handleNewSpreadsheet = useCallback(async () => {
    const newId = crypto.randomUUID();
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([[]]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const base64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
    setBase64Cache(newId, base64);
    const newFile: OpenFile = {
      id: newId,
      name: 'untitled.xlsx',
      path: `/untitled-${newId}.xlsx`,
      content: '',
      originalContent: '',
      modified: false,
      language: 'plaintext',
      format: 'excel',
      renderAs: 'viewer',
    };
    setEditorState(prev => ({
      ...prev,
      openFiles: [...prev.openFiles, newFile],
      activeFileId: newFile.id,
    }));
  }, []);

  // 组件卸载时标记已卸载并清理所有自动保存定时器
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      autoSaveTimersRef.current.forEach((t) => clearTimeout(t));
      autoSaveTimersRef.current.clear();
      uiTimersRef.current.forEach((t) => window.clearTimeout(t));
      uiTimersRef.current.clear();
    };
  }, []);

  /**
   * 保存所有文件
   */
  const handleSaveAll = useCallback(async () => {
    const modifiedFiles = editorState.openFiles.filter(isFileModified);
    
    if (modifiedFiles.length === 0) {
      toast.info(t("editor.noFilesToSave"));
      return;
    }

    toast.promise(
      Promise.all(modifiedFiles.map(f => handleSaveFile(f.id))),
      {
        loading: `正在保存 ${modifiedFiles.length} 个文件...`,
        success: t('editor.allFilesSaved'),
        error: '部分文件保存失败',
      }
    );
  }, [editorState.openFiles, handleSaveFile]);

  /**
   * 刷新文件（从后端重新加载）。若文件已修改则先打开确认弹窗。
   */
  const handleRefreshFile = useCallback(async (fileId?: string) => {
    const targetFile = fileId
      ? editorState.openFiles.find(f => f.id === fileId)
      : activeFile;

    if (!targetFile) return;

    if (isFileModified(targetFile)) {
      setRefreshConfirmFile({ id: targetFile.id, name: targetFile.name, path: targetFile.path, format: targetFile.format });
      return;
    }

    await doRefreshFile(targetFile);
  }, [editorState.openFiles, activeFile]);

  const doRefreshFile = useCallback(async (file: { id: string; name: string; path: string; format?: string }) => {
    try {
      if (import.meta.env?.DEV) console.log('[FullEditorV2] 刷新文件:', file.path);
      const content = await langgraphApi.readFile(file.path);

      const isBinary = ['pdf', 'docx', 'excel', 'ppt', 'image'].includes(file.format || '');
      if (isBinary) {
        setBase64Cache(file.id, content);
      }
      const updates = isBinary
        ? { modified: false }
        : { content, originalContent: content, modified: false };

      setEditorState(prev => ({
        ...prev,
        openFiles: prev.openFiles.map(f =>
          f.id === file.id ? { ...f, ...updates } : f
        ),
      }));
      toast.success(`文件 "${file.name}" 已刷新`);
    } catch (error) {
      console.error('[FullEditorV2] 刷新文件失败:', error);
      toast.error(t('editor.refreshFailed'), { description: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const performRefreshFile = useCallback(async () => {
    const file = refreshConfirmFile;
    setRefreshConfirmFile(null);
    if (file) await doRefreshFile(file);
  }, [refreshConfirmFile, doRefreshFile]);

  /**
   * 下载文件
   */
  const handleDownloadFile = useCallback(async (file: OpenFile) => {
    try {
      const electron = (window as any)?.electron;
      const base64 = getBase64FromCache(file.id) ?? file.base64Data;
      if (base64) {
        // 有 base64 数据，创建下载
        const mimeType = file.mimeType || 'application/octet-stream';
        const byteCharacters = atob(base64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: mimeType });
        
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        toast.success(`文件 "${file.name}" 已开始下载`);
      } else if (file.content) {
        // 文本内容下载
        const blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        toast.success(`文件 "${file.name}" 已开始下载`);
      } else if (electron?.showSaveDialog && file.path) {
        // 使用 Electron 对话框保存
        const result = await electron.showSaveDialog({
          defaultPath: file.name,
        });
        if (result.filePath) {
          await electron.copyFile(file.path, result.filePath);
          toast.success(t('editor.fileSavedTo', { path: result.filePath }));
        }
      } else {
        toast.error(t("editor.cannotDownloadFile"));
      }
    } catch (error) {
      console.error('[FullEditorV2] 下载文件失败:', error);
      toast.error(t("editor.downloadFailed"), { description: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  /**
   * 使用外部应用打开文件
   */
  const handleOpenExternal = useCallback(async (file: OpenFile) => {
    try {
      const electron = (window as any)?.electron;
      
      if (electron?.openPath && file.path) {
        // 使用 Electron 打开文件
        await electron.openPath(file.path);
        toast.success(`已使用系统应用打开 "${file.name}"`);
      } else if (file.path) {
        // Web 环境，尝试在新标签页打开
        window.open(file.path, '_blank');
      } else {
        toast.error(t("editor.cannotOpenFile"));
      }
    } catch (error) {
      console.error('[FullEditorV2] 打开文件失败:', error);
      toast.error(t('editor.openFailed'), { description: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  /**
   * 处理来自 ChatArea 的文件操作通知
   */
  const handleFileActionFromChat = useCallback(async (action: {
    type: 'open' | 'refresh' | 'close';
    filePath: string;
    content?: string;
  }) => {
    if (!action?.filePath?.trim()) return;
    if (import.meta.env?.DEV) console.log('[FullEditorV2] 文件操作:', action);
    
    try {
      if (action.type === 'open') {
        const fileName = action.filePath.split('/').pop() || 'untitled';
        const existingFile = editorState.openFiles.find(f => f.path === action.filePath);
        const typeInfo = getFileTypeInfo(fileName);
        if (existingFile && typeInfo.isBinary) {
          setEditorState(prev => {
            if (prev.activeFileId === existingFile.id) return prev;
            return { ...prev, activeFileId: existingFile.id };
          });
        } else if (existingFile) {
          let newContent = action.content;
          if (newContent === undefined || newContent === null) {
            newContent = await langgraphApi.readFile(action.filePath);
          }
          const supportsDiff = supportsDiffFormat(existingFile.format);
          if (existingFile.content !== newContent) {
            if (supportsDiff) {
              setEditorState(prev => ({
                ...prev,
                activeFileId: existingFile.id,
                openFiles: prev.openFiles.map(f =>
                  f.id === existingFile.id
                    ? { ...f, diffOriginal: f.content, content: newContent!, showDiff: true }
                    : f
                ),
              }));
              toast.info(`AI 修改了 ${existingFile.name}，显示变更对比`);
            } else {
              handleFileContentChange(existingFile.id, newContent);
              setEditorState(prev => (prev.activeFileId === existingFile.id ? prev : { ...prev, activeFileId: existingFile.id }));
              toast.info(`文件已更新: ${existingFile.name}`);
            }
          } else {
            setEditorState(prev => {
              if (prev.activeFileId === existingFile.id) return prev;
              return { ...prev, activeFileId: existingFile.id };
            });
          }
        } else {
          const { language, format, mimeType, isBinary } = typeInfo;
          if (isBinary) {
            let base64 = typeof action.content === 'string' ? action.content : '';
            let fileSize: number | undefined;
            if (!base64) {
              const res = await fileSystemService.readFileBinary(action.filePath);
              if (!res.success || !('data' in res) || !res.data?.base64) {
                toast.error(t('editor.openFailed'), { description: res.error || t('editor.binaryReadFailed') });
                return;
              }
              base64 = res.data.base64;
              fileSize = res.data.size;
            }
            await handleFileOpen({
              id: crypto.randomUUID(),
              name: fileName,
              path: action.filePath,
              content: '',
              language,
              format,
              base64Data: base64,
              mimeType: mimeType || undefined,
              fileSize,
            });
          } else {
            const textContent = action.content ?? await langgraphApi.readFile(action.filePath);
            await handleFileOpen({
              id: crypto.randomUUID(),
              name: fileName,
              path: action.filePath,
              content: textContent ?? '',
              language,
              format,
            });
          }
          toast.success(`已打开文件: ${fileName}`);
        }
      } else if (action.type === 'refresh') {
        const existingFile = editorState.openFiles.find(f => f.path === action.filePath);
        if (existingFile) {
          const typeInfo = getFileTypeInfo(existingFile.name);
          if (typeInfo.isBinary) {
            const res = await fileSystemService.readFileBinary(action.filePath);
            if (res.success && 'data' in res && res.data?.base64) {
              setBase64Cache(existingFile.id, res.data.base64);
              setEditorState(prev => ({
                ...prev,
                openFiles: prev.openFiles.map(f => f.id === existingFile.id ? { ...f, lastSaved: new Date() } : f),
              }));
              toast.info(`文件已刷新: ${existingFile.name}`);
            }
          } else {
            const newContent = await langgraphApi.readFile(action.filePath);
            if (existingFile.content !== newContent) {
              handleFileContentChange(existingFile.id, newContent);
              toast.info(`文件已刷新: ${existingFile.name}`);
            }
          }
        }
      } else if (action.type === 'close') {
        // 关闭文件
        const existingFile = editorState.openFiles.find(f => f.path === action.filePath);
        if (existingFile) {
          await handleFileClose(existingFile.id);
        }
      }
    } catch (error) {
      console.error('[FullEditorV2] 处理文件操作失败:', error);
      toast.error(t('editor.fileActionFailed'), { description: error instanceof Error ? error.message : String(error) });
    }
  }, [editorState.openFiles, handleFileOpen, handleFileContentChange, handleFileClose]);

  // AI 操作状态
  const [aiActionState, setAiActionState] = useState<{
    isProcessing: boolean;
    action: string | null;
    result: string | null;
    originalText: string | null;
  }>({
    isProcessing: false,
    action: null,
    result: null,
    originalText: null,
  });

  const persistShowEditor = useCallback((v: boolean) => {
    setStorageItem('maibot_show_editor', v ? '1' : '0');
  }, []);
  const persistShowChat = useCallback((v: boolean) => {
    setStorageItem('maibot_show_chat', v ? '1' : '0');
  }, []);

  /**
   * AI 快捷操作处理
   * expand/rewrite/fix/explain 使用 performEditorAction；translate/summary 打开对话并填入对应提示。
   */
  const handleAIAction = useCallback(async (
    action: 'expand' | 'rewrite' | 'fix' | 'explain' | 'translate' | 'summary',
    selectedText: string
  ) => {
    if (aiActionState.isProcessing) return;
    if (!activeFile || !selectedText) return;

    // 翻译、摘要：打开对话区并填入意图提示，由用户发送
    if (action === 'translate' || action === 'summary') {
      setShowChatState(true);
      persistShowChat(true);
      setShowRightPanel(true);
      const prompt = action === 'translate'
        ? `请翻译以下内容：\n\n${selectedText}`
        : `请对以下内容写摘要：\n\n${selectedText}`;
      scheduleUiTimeout(() => {
        const threadId = getCurrentThreadIdFromStorage();
        window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, {
          detail: { prompt, autoSend: false, threadId: threadId || undefined },
        }));
      }, 200);
      setShowEditorCommandPalette(false);
      return;
    }

    const actionLabels: Record<string, string> = {
      expand: '扩写',
      rewrite: '重写',
      fix: '修复',
      explain: '解释',
    };

    try {
      setAiActionState({
        isProcessing: true,
        action: actionLabels[action],
        result: null,
        originalText: selectedText,
      });
      
      const result = await langgraphApi.performEditorAction(
        action === 'expand' ? 'expand' : action === 'rewrite' ? 'refactor' : action === 'fix' ? 'refactor' : 'explain',
        activeFile.path,
        activeFile.content,
        selectedText,
        currentWorkspace?.id
      );

      const content = typeof result.content === 'string' ? result.content : String(result.content);
      
      if (action === 'expand' || action === 'rewrite' || action === 'fix') {
        setAiActionState({
          isProcessing: false,
          action: actionLabels[action],
          result: content,
          originalText: selectedText,
        });
      } else {
        setAiActionState({
          isProcessing: false,
          action: null,
          result: null,
          originalText: null,
        });
        toast.success(t("editor.explainDone"), { 
          description: content.substring(0, 200) + (content.length > 200 ? '...' : ''),
          duration: 10000,
        });
      }
    } catch (error) {
      console.error('[FullEditorV2] AI 操作失败:', error);
      toast.error(t('editor.aiActionFailed'), { description: error instanceof Error ? error.message : String(error) });
      setAiActionState({
        isProcessing: false,
        action: null,
        result: null,
        originalText: null,
      });
    }
  }, [activeFile, currentWorkspace, persistShowChat]);

  // 应用 AI 结果
  const handleApplyAIResult = useCallback(() => {
    if (!activeFile || !aiActionState.result || !aiActionState.originalText) return;
    
    const selectedText = aiActionState.originalText;
    const newText = aiActionState.result;
    const idx = activeFile.content.indexOf(selectedText);
    if (idx === -1) {
      toast.error(t("editor.contentChangedCannotApply"));
      return;
    }
    
    // 替换选中文本
    const beforeText = activeFile.content.substring(0, idx);
    const afterText = activeFile.content.substring(idx + selectedText.length);
    const newContent = beforeText + newText + afterText;
    
    handleFileContentChange(activeFile.id, newContent);
    toast.success(t("editor.contentAppliedToEditor"));
    
    // 清除状态
    setAiActionState({
      isProcessing: false,
      action: null,
      result: null,
      originalText: null,
    });
  }, [activeFile, aiActionState, handleFileContentChange]);

  // 取消 AI 结果
  const handleCancelAIResult = useCallback(() => {
    setAiActionState({
      isProcessing: false,
      action: null,
      result: null,
      originalText: null,
    });
  }, []);

  // ============================================================================
  // 面板控制
  // ============================================================================

  const toggleLeftPanel = useCallback(() => setShowLeftPanel(prev => !prev), []);
  const toggleRightPanel = useCallback(() => setShowRightPanel(prev => !prev), []);

  /** 在编辑区打开任务（像打开文件一样） */
  const handleOpenTaskInEditor = useCallback((taskId: string, subject: string, focusSection?: "result") => {
    setOpenTasks(prev => {
      if (prev.some(t => t.id === taskId)) return prev;
      return [...prev, { id: taskId, subject }];
    });
    if (focusSection) {
      setTaskFocusSectionById((prev) => ({ ...prev, [taskId]: focusSection }));
    }
    setActiveTaskId(taskId);
    setShowSettings(false);
    // 确保编辑区可见
    setShowEditorState(true);
    persistShowEditor(true);
  }, [persistShowEditor]);

  /** 关闭任务 Tab */
  const handleCloseTaskTab = useCallback((taskId: string) => {
    setOpenTasks(prev => {
      const next = prev.filter(t => t.id !== taskId);
      if (activeTaskId === taskId) {
        // 切换到其他任务或文件
        if (next.length > 0) {
          setActiveTaskId(next[next.length - 1].id);
        } else {
          setActiveTaskId(null);
        }
      }
      return next;
    });
  }, [activeTaskId]);

  useEffect(() => {
    shortcutActionsRef.current = {
      handleCloseTaskTab,
      handleNewFile,
      openNewFilePopover: () => setNewFilePopoverOpen(true),
      handleSaveFile,
      handleSaveAll,
      handleFileClose,
      handleRefreshFile,
      persistShowChat,
      onOpenCommandPalette,
    };
  }, [handleCloseTaskTab, handleNewFile, handleSaveFile, handleSaveAll, handleFileClose, handleRefreshFile, persistShowChat, onOpenCommandPalette]);

  /** 切换编辑区显示；至少保留编辑或对话其一 */
  const toggleShowEditor = useCallback(() => {
    setShowEditorState(prev => {
      const next = !prev;
      if (!next && !showChat) {
        setShowChatState(true);
        persistShowChat(true);
      }
      persistShowEditor(next);
      return next;
    });
  }, [showChat, persistShowEditor, persistShowChat]);

  /** 切换对话区显示；至少保留编辑或对话其一 */
  const toggleShowChat = useCallback(() => {
    setShowChatState(prev => {
      const next = !prev;
      if (!next && !showEditor) {
        setShowEditorState(true);
        persistShowEditor(true);
      }
      if (next) setShowRightPanel(true);
      persistShowChat(next);
      return next;
    });
  }, [showEditor, persistShowEditor, persistShowChat]);

  useEffect(() => {
    const onTaskRunning = (e: CustomEvent<{ running: boolean }>) => {
      setTaskRunning(e.detail?.running ?? false);
      if (!e.detail?.running) {
        setTaskProgressMessage(null);
        setTaskStepCount(null);
        setTodosProgress(null);
      }
    };
    window.addEventListener('task_running', onTaskRunning as EventListener);
    return () => window.removeEventListener('task_running', onTaskRunning as EventListener);
  }, []);

  useEffect(() => {
    const onTaskProgress = (e: CustomEvent<{ message?: string; step?: number; todos?: Array<{ status?: string }> }>) => {
      const detail = e.detail;
      if (detail == null) return;
      setTaskProgressMessage(detail.message ?? null);
      if (detail.step != null) setTaskStepCount(detail.step);
      const todos = detail.todos;
      if (Array.isArray(todos) && todos.length > 0) {
        const done = todos.filter((t) => String(t?.status ?? "").toLowerCase() === "completed").length;
        setTodosProgress({ done, total: todos.length });
      } else {
        setTodosProgress(null);
      }
    };
    window.addEventListener(EVENTS.TASK_PROGRESS, onTaskProgress as EventListener);
    return () => window.removeEventListener(EVENTS.TASK_PROGRESS, onTaskProgress as EventListener);
  }, []);

  // 轮询待处理任务数（左侧 Tasks tab 徽章），按当前工作区过滤
  useEffect(() => {
    let cancelled = false;
    const fetch = () => {
      const wp = getCurrentWorkspacePathFromStorage() || undefined;
      boardApi.getTasks('personal', 'pending', undefined, { workspacePath: wp }).then((res) => {
        if (cancelled || !isMountedRef.current) return;
        if (res.ok && Array.isArray(res.tasks)) {
          const next = res.tasks.length;
          setPendingTaskCount((prev) => (prev === next ? prev : next));
        }
      }).catch((err) => {
        if (cancelled || !isMountedRef.current) return;
        if (import.meta.env?.DEV) console.warn('[FullEditorV2Enhanced] pending task count fetch failed:', err);
        if (!pendingTaskCountErrorToastShownRef.current) {
          pendingTaskCountErrorToastShownRef.current = true;
          toast.error(t('task.loadFailed'));
        }
      });
    };
    fetch();
    const intervalId = setInterval(fetch, 45000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  // 知识库更新徽章：监听事件 + 每 30s 检查 localStorage 时间戳（5 分钟内显示）
  useEffect(() => {
    const check = () => {
      const ts = getStorageItem('maibot_knowledge_badge_ts');
      if (!ts) {
        setKnowledgeBadge((prev) => (prev === false ? prev : false));
        return;
      }
      const n = parseInt(ts, 10);
      if (Number.isNaN(n)) {
        setKnowledgeBadge((prev) => (prev === false ? prev : false));
        return;
      }
      const next = Date.now() - n < 5 * 60 * 1000;
      setKnowledgeBadge((prev) => (prev === next ? prev : next));
    };
    const onKnowledgeUpdated = () => {
      setStorageItem('maibot_knowledge_badge_ts', String(Date.now()));
      setKnowledgeBadge(true);
    };
    check();
    const checkIntervalId = setInterval(check, 30000);
    window.addEventListener(EVENTS.KNOWLEDGE_UPDATED, onKnowledgeUpdated);
    return () => {
      clearInterval(checkIntervalId);
      window.removeEventListener(EVENTS.KNOWLEDGE_UPDATED, onKnowledgeUpdated);
    };
  }, []);

  // 同步设置页自动保存开关（同标签事件 + 跨标签 storage）。
  useEffect(() => {
    const readAutoSaveFromStorage = () => {
      try {
        setAutoSaveEnabled(getStorageItem('maibot_settings_autoSave') !== 'false');
      } catch {
        setAutoSaveEnabled(true);
      }
    };
    const onAutoSaveChanged = (e: CustomEvent<{ enabled?: boolean }>) => {
      if (typeof e.detail?.enabled === 'boolean') {
        setAutoSaveEnabled(e.detail.enabled);
        return;
      }
      readAutoSaveFromStorage();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'maibot_settings_autoSave') readAutoSaveFromStorage();
    };
    window.addEventListener(EVENTS.SETTINGS_AUTO_SAVE_CHANGED, onAutoSaveChanged as EventListener);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENTS.SETTINGS_AUTO_SAVE_CHANGED, onAutoSaveChanged as EventListener);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useRunSummarySync((norm, raw) => {
    setStatusRunSummary(
      norm
        ? {
            ...norm,
            statusText: String((raw as Record<string, unknown>)?.statusText ?? ''),
            recoveryPriority: String((raw as Record<string, unknown>)?.recoveryPriority ?? ''),
          }
        : null
    );
  }, { listenStorage: true });

  const toggleFocusMode = useCallback(() => {
    setFocusModeEnabled((prev) => {
      const next = !prev;
      setStorageItem('maibot_focus_mode', next ? '1' : '0');
      window.dispatchEvent(new CustomEvent(EVENTS.FOCUS_MODE_CHANGED, { detail: { enabled: next } }));
      return next;
    });
  }, []);

  // 监听左侧面板 Tab 切换事件（来自 ThreadWelcome 知识库按钮等）
  useEffect(() => {
    const handler = (e: CustomEvent<{ tab: 'workspace' | 'knowledge' | 'tasks' }>) => {
      const tab = e.detail?.tab;
      if (tab === 'workspace') {
        setExplorerTab('files');
        setShowLeftPanel(true);
      } else if (tab === 'knowledge') {
        setExplorerTab('knowledge');
        setShowLeftPanel(true);
      } else if (tab === 'tasks') {
        setExplorerTab('tasks');
        setShowLeftPanel(true);
      } else if (tab === 'memory') {
        setExplorerTab('memory');
        setShowLeftPanel(true);
      }
    };
    window.addEventListener(EVENTS.SWITCH_LEFT_PANEL, handler as EventListener);
    return () => window.removeEventListener(EVENTS.SWITCH_LEFT_PANEL, handler as EventListener);
  }, []);

  // 统一消费“打开聊天面板”事件（设置页/仪表盘等入口复用）
  useEffect(() => {
    const handler = () => {
      setShowRightPanel(true);
      setShowChatState(true);
      persistShowChat(true);
      scheduleUiTimeout(() => {
        if (!isMountedRef.current) return;
        window.dispatchEvent(new CustomEvent(EVENTS.FOCUS_COMPOSER));
      }, 0);
    };
    window.addEventListener(EVENTS.OPEN_CHAT_PANEL, handler);
    return () => window.removeEventListener(EVENTS.OPEN_CHAT_PANEL, handler);
  }, [persistShowChat, scheduleUiTimeout]);

  // 轮询记忆条目数（状态栏 Brain 计数）
  useEffect(() => {
    let cancelled = false;
    const base = getApiBase();
    const fetchCount = () => {
      if (!base) return;
      fetch(`${base}/memory/entries?limit=1`)
        .then((r) => {
          if (!r.ok) return;
          return r.json();
        })
        .then((d) => {
          if (cancelled || !isMountedRef.current) return;
          if (d?.ok && typeof d.total === "number") {
            const next = d.total;
            setMemoryEntryCount((prev) => (prev === next ? prev : next));
          }
        })
        .catch(() => {
          if (cancelled || !isMountedRef.current) return;
          if (!memoryCountErrorToastShownRef.current) {
            memoryCountErrorToastShownRef.current = true;
            toast.error(t('editor.memoryCountLoadError'));
          }
        });
    };
    fetchCount();
    const intervalId = setInterval(fetchCount, 30000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  // 监听「在编辑区打开任务」事件（来自仪表盘、对话区等）
  useEffect(() => {
    const handler = (e: CustomEvent<{ taskId: string; subject: string; focusSection?: "result" }>) => {
      const { taskId, subject, focusSection } = e.detail ?? {};
      if (taskId) handleOpenTaskInEditor(taskId, subject || '任务', focusSection);
    };
    window.addEventListener(EVENTS.OPEN_TASK_IN_EDITOR, handler as EventListener);
    return () => window.removeEventListener(EVENTS.OPEN_TASK_IN_EDITOR, handler as EventListener);
  }, [handleOpenTaskInEditor]);

  // 监听「在控制台查看任务执行」（由左侧任务列表「在控制台查看」触发，App 需同时打开招投标/控制台面板）
  useEffect(() => {
    const handler = (e: CustomEvent<{ taskId: string; subject?: string; threadId?: string | null }>) => {
      const { taskId, subject, threadId } = e.detail ?? {};
      if (!taskId) return;
      setConsoleLinkedTaskId(taskId);
      setConsoleLinkedThreadId(threadId ?? null);
      setConsoleLinkedSubject(subject ?? null);
      setConsoleTab('execution');
      setShowChatState(true);
      persistShowChat(true);
      setShowRightPanel(true);
    };
    window.addEventListener(EVENTS.OPEN_TASK_IN_CONSOLE, handler as EventListener);
    return () => window.removeEventListener(EVENTS.OPEN_TASK_IN_CONSOLE, handler as EventListener);
  }, []);

  // 监听命令面板打开事件（来自 ThreadWelcome）
  useEffect(() => {
    const handler = () => {
      onOpenCommandPalette?.();
    };
    window.addEventListener(EVENTS.OPEN_COMMAND_PALETTE, handler);
    return () => window.removeEventListener(EVENTS.OPEN_COMMAND_PALETTE, handler);
  }, [onOpenCommandPalette]);

  useThreadExport();

  // 监听编辑器命令面板打开（来自 Monaco Cmd+K 等）；带 detail.prompt 时为内联 Cmd+K 提交，预填对话并打开聊天
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ prompt?: string; selection?: string }>).detail;
      if (detail?.prompt != null) {
        setShowChatState(true);
        persistShowChat(true);
        setShowRightPanel(true);
        const promptText = detail.selection?.trim()
          ? `${detail.prompt}\n\n选中的代码：\n\`\`\`\n${detail.selection}\n\`\`\``
          : detail.prompt;
        scheduleUiTimeout(() => {
          const threadId = getCurrentThreadIdFromStorage();
          window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, {
            detail: { prompt: promptText, autoSend: false, threadId: threadId || undefined },
          }));
        }, 200);
        return;
      }
      if (activeFile) setShowEditorCommandPalette(true);
    };
    window.addEventListener(EVENTS.OPEN_EDITOR_COMMAND_PALETTE, handler);
    return () => window.removeEventListener(EVENTS.OPEN_EDITOR_COMMAND_PALETTE, handler);
  }, [activeFile, persistShowChat, scheduleUiTimeout]);

  // 监听打开快捷键帮助（Composer 工具栏等触发）
  useEffect(() => {
    const handler = () => setShortcutsHelpOpen(true);
    window.addEventListener(EVENTS.OPEN_SHORTCUTS_HELP, handler);
    return () => window.removeEventListener(EVENTS.OPEN_SHORTCUTS_HELP, handler);
  }, []);

  // 底部栏模式角标：同步当前聊天模式
  useEffect(() => {
    const handler = (e: CustomEvent<{ mode?: string; threadId?: string }>) => {
      const mode = e.detail?.mode;
      if (mode && (mode === 'agent' || mode === 'plan' || mode === 'ask' || mode === 'debug' || mode === 'review')) {
        setActiveMode(mode as ChatMode);
      }
    };
    window.addEventListener(EVENTS.CHAT_MODE_CHANGED, handler as EventListener);
    return () => window.removeEventListener(EVENTS.CHAT_MODE_CHANGED, handler as EventListener);
  }, []);

  // 多窗口 Popover 打开时拉取列表并每 5s 刷新（与文件树轮询一致，降低 IO）
  useEffect(() => {
    if (!windowPopoverOpen || !isElectronEnv() || !window.electron?.listWindows) return;
    let cancelled = false;
    const fetchWindows = () => {
      window.electron!.listWindows()
        .then((list) => {
          if (!cancelled && isMountedRef.current) {
            setWindowList((prev) => {
              if (Array.isArray(list) && prev.length === list.length && prev.every((p, i) => p?.id === list[i]?.id && p?.title === list[i]?.title)) return prev;
              return Array.isArray(list) ? list : [];
            });
          }
        })
        .catch(() => { if (!cancelled && isMountedRef.current) { setWindowList((prev) => (prev.length === 0 ? prev : [])); toast.error(t("editor.windowListLoadError")); } });
    };
    fetchWindows();
    const intervalId = setInterval(fetchWindows, 5000);
    return () => { cancelled = true; clearInterval(intervalId); };
  }, [windowPopoverOpen]);

  // MCP 服务器状态：仅 Electron 时每 10s 轮询；仅当列表实际变化时 setState，避免整页（含 docx 显示区）每 10s 重渲染导致刷新
  useEffect(() => {
    if (!isElectronEnv() || !window.electron?.mcpGetStatus) return;
    let cancelled = false;
    const fetchMcp = () => {
      window.electron!.mcpGetStatus().then((res) => {
        if (cancelled || !isMountedRef.current) return;
        if (res?.success && Array.isArray(res.servers)) {
          const names = res.servers.filter((s: { running?: boolean }) => s.running).map((s: { name: string }) => s.name);
          setMcpServerNames((prev) => {
            if (prev.length !== names.length || prev.some((p, i) => p !== names[i])) return names;
            return prev;
          });
        } else {
          setMcpServerNames((prev) => (prev.length === 0 ? prev : []));
        }
      }).catch(() => {
        if (!cancelled && isMountedRef.current) { setMcpServerNames((prev) => (prev.length === 0 ? prev : [])); toast.error(t("editor.mcpListLoadError")); }
      });
    };
    fetchMcp();
    const intervalId = setInterval(fetchMcp, 10000);
    return () => { cancelled = true; clearInterval(intervalId); };
  }, []);

  // 外部请求打开设置（Cmd+, 或命令面板）时在编辑器内打开设置
  useEffect(() => {
    if (openSettingsRequest) {
      setSettingsInitialSection(undefined);
      setShowSettings(true);
      onOpenSettingsHandled?.();
    }
  }, [openSettingsRequest, onOpenSettingsHandled]);

  // 招投标向导打开时确保右侧面板可见（在聊天面板内展示）
  useEffect(() => {
    if (bidWizardOpen) {
      setShowChatState(true);
      persistShowChat(true);
      setShowRightPanel(true);
    }
  }, [bidWizardOpen]);

  // 监听模型切换，刷新状态栏显示
  useEffect(() => {
    const handler = (e: CustomEvent<{ modelId: string }>) => {
      setStatusBarModelId(e.detail?.modelId ?? null);
    };
    window.addEventListener('model_changed', handler as EventListener);
    return () => window.removeEventListener('model_changed', handler as EventListener);
  }, []);

  useEffect(() => {
    let disposed = false;
    const roleLabelMap = new Map<string, string>();

    const ensureRoleLabels = async () => {
      if (roleLabelMap.size > 0) return;
      const res = await boardApi.listRoles().catch(() => ({ ok: false as const, roles: [] as Array<{ id: string; label: string }> }));
      if (!res.ok || !Array.isArray(res.roles)) return;
      for (const role of res.roles) {
        const roleId = String(role.id || '').trim();
        if (!roleId) continue;
        roleLabelMap.set(roleId, String(role.label || roleId).trim() || roleId);
      }
    };

    const refreshThreadRole = async (threadId: string | null) => {
      if (!threadId) {
        if (!disposed) setStatusBarThreadRole('');
        return;
      }
      const roleId = normalizeRoleId(getScopedActiveRoleIdFromStorage());
      if (!roleId) {
        if (!disposed) setStatusBarThreadRole('');
        return;
      }
      await ensureRoleLabels();
      const roleLabel = roleLabelMap.get(roleId) || roleId;
      if (!disposed) setStatusBarThreadRole(roleLabel);
    };

    const refreshThreadTitle = (threadId: string | null) => {
      if (!threadId) {
        if (!disposed) setStatusBarThreadTitle('新对话');
        return;
      }
      getThreadState(threadId)
        .then((state) => {
          if (disposed) return;
          const title = String((state?.metadata as { title?: string } | undefined)?.title ?? '').trim();
          setStatusBarThreadTitle(title || threadId.slice(0, 8));
        })
        .catch((error) => {
          if (disposed) return;
          if (isThreadNotFoundError(error)) {
            const currentThread = getCurrentThreadIdFromStorage();
            if (currentThread === threadId) {
              clearActiveThreadSession();
              setStatusBarThreadId(null);
              setStatusBarThreadRole('');
              setStatusBarThreadTitle('新对话');
              return;
            }
          }
          setStatusBarThreadTitle(threadId.slice(0, 8));
        });
    };

    const initialThreadId = getCurrentThreadIdFromStorage() || null;
    setStatusBarThreadId(initialThreadId || null);
    refreshThreadTitle(initialThreadId || null);
    void refreshThreadRole(initialThreadId || null);

    const onThreadChanged = (e: Event) => {
      const detail = (e as CustomEvent<SessionChangedDetail>).detail;
      const threadId = detail?.threadId?.trim() || null;
      setStatusBarThreadId(threadId);
      void refreshThreadRole(threadId);
      const threadTitle = detail?.title?.trim();
      if (threadTitle) {
        setStatusBarThreadTitle(threadTitle);
      } else {
        refreshThreadTitle(threadId);
      }
    };
    const onRoleChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ threadId?: string }>)?.detail;
      const currentThreadId = getCurrentThreadIdFromStorage() || null;
      if (detail?.threadId && currentThreadId && detail.threadId !== currentThreadId) return;
      void refreshThreadRole(currentThreadId || null);
    };
    window.addEventListener(EVENTS.SESSION_CHANGED, onThreadChanged as EventListener);
    window.addEventListener(EVENTS.ROLE_CHANGED, onRoleChanged);
    return () => {
      disposed = true;
      window.removeEventListener(EVENTS.SESSION_CHANGED, onThreadChanged as EventListener);
      window.removeEventListener(EVENTS.ROLE_CHANGED, onRoleChanged);
    };
  }, []);

  // 监听命令面板具体命令（由 App 派发 command_palette_command）
  useEffect(() => {
    const handler = (e: CustomEvent<{ commandId: string }>) => {
      const id = e.detail?.commandId;
      switch (id) {
        case 'settings.open':
          setSettingsInitialSection(undefined);
          setShowSettings(true);
          break;
        case 'settings.agent_profile':
          setSettingsInitialSection('agent_profile');
          setShowSettings(true);
          break;
        case 'settings.workspaces':
          setSettingsInitialSection('workspaces');
          setShowSettings(true);
          break;
        case 'settings.keyboard':
          setSettingsInitialSection(undefined);
          setShowSettings(true);
          toast.info(t("editor.viewShortcutsInSettings"));
          break;
        case 'file.new':
          setNewFilePopoverOpen(true);
          break;
        case 'file.open':
        case 'nav.goToFile':
          setShowLeftPanel(true);
          setExplorerTab('files');
          toast.info(t("editor.selectFileInTree"));
          break;
        case 'file.save':
          if (activeFile) handleSaveFile(activeFile.id);
          else toast.info(t("editor.openOrNewFileFirst"));
          break;
        case 'file.saveAll':
          handleSaveAll();
          break;
        case 'file.close':
          if (activeFile) handleFileClose(activeFile.id);
          else toast.info(t("editor.noOpenFile"));
          break;
        case 'view.sidebar':
          setShowLeftPanel((prev) => !prev);
          break;
        case 'chat.new':
          setShowRightPanel(true);
          setShowChatState(true);
          persistShowChat(true);
          scheduleUiTimeout(() => window.dispatchEvent(new CustomEvent(EVENTS.NEW_THREAD_REQUEST)), 150);
          break;
        case 'chat.focus':
          setShowRightPanel(true);
          setShowChatState(true);
          persistShowChat(true);
          scheduleUiTimeout(() => window.dispatchEvent(new CustomEvent(EVENTS.FOCUS_COMPOSER)), 100);
          break;
        case 'chat.stop':
          setShowRightPanel(true);
          setShowChatState(true);
          persistShowChat(true);
          window.dispatchEvent(new CustomEvent(EVENTS.STOP_GENERATION_REQUEST));
          break;
        case 'open-task-panel':
          setShowLeftPanel(true);
          setExplorerTab('tasks');
          break;
        case 'open-collab-center':
          setShowSettings(false);
          setActiveTaskId(null);
          setEditorState((prev) => ({ ...prev, activeFileId: null }));
          window.dispatchEvent(new CustomEvent(EVENTS.COLLAB_CENTER_OPEN, { detail: { source: 'command_palette' } }));
          break;
        case 'view.focus_mode':
          toggleFocusMode();
          break;
        default:
          break;
      }
    };
    window.addEventListener(EVENTS.COMMAND_PALETTE_COMMAND, handler as EventListener);
    return () => window.removeEventListener(EVENTS.COMMAND_PALETTE_COMMAND, handler as EventListener);
  }, [activeFile, handleSaveFile, handleSaveAll, handleFileClose, persistShowChat, toggleFocusMode]);

  // ============================================================================
  // 快捷键
  // ============================================================================

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const actions = shortcutActionsRef.current;
      if (!actions) return;
      const activeFileCurrent = activeFileRef.current;
      const openFilesCurrent = openFilesRef.current;
      const activeFileIdCurrent = activeFileIdRef.current;
      const openTasksCurrent = openTasksRef.current;
      const activeTaskIdCurrent = activeTaskIdRef.current;
      const mod = e.metaKey || e.ctrlKey;
      // 忽略输入框内部分快捷键（保留 ⌘S 等）
      const target = e.target as HTMLElement;
      const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || (target as HTMLElement).isContentEditable;
      const inComposer = !!target.closest?.('.aui-composer-root');
      const inDialog = target.closest?.('[role="dialog"]');
      const suggestionKeys = new Set(['Tab', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown']);
      const targetInMonaco = !!target.closest?.('.monaco-editor, .suggest-widget, .monaco-list');
      const suggestWidgetVisible = !!document.querySelector(
        '.monaco-editor.focused .suggest-widget.visible, .monaco-editor:focus-within .suggest-widget.visible'
      );
      const monacoFocused = !!document.activeElement?.closest?.('.monaco-editor');
      const monacoSuggestContextActive = suggestWidgetVisible && (targetInMonaco || monacoFocused);

      // 补全浮窗打开时，优先交给 Monaco 处理补全导航与接受候选
      if (monacoSuggestContextActive && suggestionKeys.has(e.key)) {
        return;
      }

      // Cmd/Ctrl + B: 切换左侧边栏（文件树）
      if (mod && !e.shiftKey && e.key === 'b') {
        e.preventDefault();
        if (inInput) return;
        setShowLeftPanel((prev) => !prev);
        return;
      }
      // Cmd/Ctrl + Shift + E: 打开左侧资源管理器（文件）
      if (mod && e.shiftKey && e.key === 'E') {
        e.preventDefault();
        if (inInput) return;
        setExplorerTab('files');
        setShowLeftPanel(true);
        return;
      }
      // Cmd/Ctrl + J: 切换右侧 AI 面板
      if (mod && !e.shiftKey && e.key === 'j') {
        e.preventDefault();
        if (inInput) return;
        setShowRightPanel((prev) => !prev);
        return;
      }
      // Cmd/Ctrl + Shift + K: 打开左侧知识库
      if (mod && e.shiftKey && e.key === 'K') {
        e.preventDefault();
        if (inInput) return;
        setExplorerTab('knowledge');
        setShowLeftPanel(true);
        return;
      }

      // Cmd/Ctrl + K: 有当前文件时仅打开编辑器命令面板，capture 阶段 + stopImmediatePropagation 避免全局命令面板同时打开
      if (mod && !e.shiftKey && e.key === 'k') {
        e.preventDefault();
        if (inInput) return;
        if (activeFileCurrent) {
          e.stopImmediatePropagation();
          setShowEditorCommandPalette(true);
        }
        return;
      }

      // Cmd/Ctrl + P: 快速打开文件（打开左侧文件栏并聚焦搜索）
      if (mod && !e.shiftKey && e.key === 'p') {
        // 聊天输入区聚焦时交由 Composer 处理
        if (inComposer) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (inInput) return;
        setExplorerTab('files');
        setShowLeftPanel(true);
        scheduleUiTimeout(() => window.dispatchEvent(new CustomEvent('focus_file_search')), 100);
        return;
      }

      // Cmd/Ctrl + Shift + P: 全局命令面板
      if (mod && e.shiftKey && e.key === 'P') {
        e.preventDefault();
        if (inInput) return;
        actions.onOpenCommandPalette?.();
        return;
      }

      // ?: 快捷键帮助（非输入框时）
      if (e.key === '?' && !e.shiftKey && !mod && !inInput && !inComposer) {
        e.preventDefault();
        setShortcutsHelpOpen(true);
        return;
      }

      // Cmd/Ctrl + \: 切换 Markdown 预览/源码
      if (mod && e.key === '\\') {
        e.preventDefault();
        if (inInput) return;
        window.dispatchEvent(new CustomEvent('toggle_markdown_preview'));
        return;
      }

      // Diff 视图：⌘↵ 接受，⌘⌫ 拒绝
      if (activeFileCurrent?.showDiff && mod && !inInput) {
        if (e.key === 'Enter') {
          e.preventDefault();
          setEditorState(prev => ({
            ...prev,
            openFiles: prev.openFiles.map(f =>
              f.id === activeFileCurrent.id ? { ...f, diffOriginal: undefined, showDiff: false } : f
            ),
          }));
          return;
        }
        if (e.key === 'Backspace') {
          e.preventDefault();
          const orig = activeFileCurrent.diffOriginal;
          if (orig != null) {
            setEditorState(prev => ({
              ...prev,
              openFiles: prev.openFiles.map(f =>
                f.id === activeFileCurrent.id
                  ? { ...f, content: orig, originalContent: orig, diffOriginal: undefined, showDiff: false }
                  : f
              ),
            }));
          }
          return;
        }
      }

      // F11 或 Cmd/Ctrl + Shift + F: 切换全屏
      if (e.key === 'F11' || (mod && e.shiftKey && e.key === 'f')) {
        e.preventDefault();
        if (inInput) return;
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          document.documentElement.requestFullscreen?.();
        }
        return;
      }

      // Cmd/Ctrl + N: 打开新建类型选择（纯文本 / Markdown / 空表格）
      if (mod && !e.shiftKey && e.key === 'n') {
        e.preventDefault();
        if (inInput) return;
        actions.openNewFilePopover?.();
        return;
      }

      // Cmd+Shift+[ : 切换到左侧 Tab（当前为任务 Tab 时切换任务，否则切换文件）
      if (mod && e.shiftKey && e.key === '[') {
        e.preventDefault();
        if (inInput || inDialog) return;
        if (activeTaskIdCurrent && openTasksCurrent.length > 0) {
          const idx = openTasksCurrent.findIndex((t) => t.id === activeTaskIdCurrent);
          const newIndex = idx <= 0 ? 0 : idx - 1;
          setActiveTaskId(openTasksCurrent[newIndex].id);
          setEditorState((prev) => ({ ...prev, activeFileId: null }));
        } else {
          const openFiles = openFilesCurrent;
          if (openFiles.length === 0) return;
          const idx = openFiles.findIndex((f) => f.id === activeFileIdCurrent);
          const newIndex = idx < 0 ? 0 : Math.max(0, idx - 1);
          setActiveTaskId(null);
          setEditorState((prev) => ({ ...prev, activeFileId: openFiles[newIndex].id }));
        }
        return;
      }
      // Cmd+Shift+] : 切换到右侧 Tab
      if (mod && e.shiftKey && e.key === ']') {
        e.preventDefault();
        if (inInput || inDialog) return;
        if (activeTaskIdCurrent && openTasksCurrent.length > 0) {
          const idx = openTasksCurrent.findIndex((t) => t.id === activeTaskIdCurrent);
          const newIndex = idx < 0 ? 0 : Math.min(openTasksCurrent.length - 1, idx + 1);
          setActiveTaskId(openTasksCurrent[newIndex].id);
          setEditorState((prev) => ({ ...prev, activeFileId: null }));
        } else {
          const openFiles = openFilesCurrent;
          if (openFiles.length === 0) return;
          const idx = openFiles.findIndex((f) => f.id === activeFileIdCurrent);
          const newIndex = idx < 0 ? 0 : Math.min(openFiles.length - 1, idx + 1);
          setActiveTaskId(null);
          setEditorState((prev) => ({ ...prev, activeFileId: openFiles[newIndex].id }));
        }
        return;
      }

      // Ctrl+Tab（仅 Ctrl，不含 Cmd）: 最近文件快速切换
      if (e.ctrlKey && !e.metaKey && e.key === 'Tab') {
        if (inInput || inDialog) return;
        const openFiles = openFilesCurrent;
        const list = recentFileIdsRef.current;
        const valid = list.filter((id) => openFiles.some((f) => f.id === id) && id !== activeFileIdCurrent);
        if (valid.length > 0) {
          e.preventDefault();
          const nextId = valid[0];
          setEditorState((prev) => ({ ...prev, activeFileId: nextId }));
          recentFileIdsRef.current = list.filter((id) => id !== nextId).concat(nextId);
        }
        return;
      }

      // Cmd/Ctrl + Shift + O: 新建对话（打开右侧面板并触发新建）
      if (mod && e.shiftKey && e.key === 'o') {
        e.preventDefault();
        if (inInput || inDialog) return;
        setShowRightPanel(true);
        setShowChatState(true);
        actions.persistShowChat(true);
        scheduleUiTimeout(() => window.dispatchEvent(new CustomEvent(EVENTS.NEW_THREAD_REQUEST)), 150);
        return;
      }
      // Cmd/Ctrl + L: 聚焦到对话输入（与命令面板「聚焦到对话输入」一致）
      if (mod && !e.shiftKey && e.key === 'l') {
        e.preventDefault();
        setShowRightPanel(true);
        setShowChatState(true);
        actions.persistShowChat(true);
        scheduleUiTimeout(() => window.dispatchEvent(new CustomEvent(EVENTS.FOCUS_COMPOSER)), 100);
        return;
      }
      // Cmd/Ctrl + Shift + T: 打开左侧任务 Tab
      if (mod && e.shiftKey && e.key === 'T') {
        e.preventDefault();
        if (inInput) return;
        setShowLeftPanel(true);
        setExplorerTab('tasks');
        return;
      }

      // Cmd/Ctrl + S: 保存当前文件
      if (mod && !e.shiftKey && e.key === 's') {
        e.preventDefault();
        if (activeFileCurrent) {
          actions.handleSaveFile(activeFileCurrent.id);
        }
      }

      // Cmd/Ctrl + Shift + S: 保存所有文件
      if (mod && e.shiftKey && e.key === 's') {
        e.preventDefault();
        actions.handleSaveAll();
      }

      // Cmd/Ctrl + W: 关闭当前 Tab（任务 Tab 或文件 Tab）
      if (mod && !e.shiftKey && e.key === 'w') {
        e.preventDefault();
        if (activeTaskIdCurrent && openTasksCurrent.some((t) => t.id === activeTaskIdCurrent)) {
          actions.handleCloseTaskTab(activeTaskIdCurrent);
        } else if (activeFileCurrent) {
          actions.handleFileClose(activeFileCurrent.id);
        }
      }

      // Cmd/Ctrl + R: 刷新当前文件
      if (mod && !e.shiftKey && e.key === 'r') {
        e.preventDefault();
        if (activeFileCurrent) {
          actions.handleRefreshFile(activeFileCurrent.id);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  // ============================================================================
  // 监听编辑器 AI 事件
  // ============================================================================

  useEffect(() => {
    const handleEditorAIAction = (e: Event) => {
      const detail = (e as CustomEvent<{ action: string; text?: string; range?: { startLine: number; endLine: number }; filePath?: string }>).detail ?? {};
      const { action, text } = detail;
      if (!text && action !== 'ask_about_file') return;

      switch (action) {
        case 'ask_about_file': {
          setShowChatState(true);
          persistShowChat(true);
          setShowRightPanel(true);
          window.dispatchEvent(new CustomEvent(EVENTS.EDITOR_ASK_CONTEXT, {
            detail: {
              filePath: activeFile?.path,
              selectedText: editorState.selectedText?.trim() || undefined,
              content: activeFile?.content,
            },
          }));
          break;
        }
        case 'explain':
          handleAIAction('explain', text ?? '');
          break;
        case 'fix':
        case 'optimize':
          handleAIAction('fix', text ?? '');
          break;
        case 'rewrite':
          handleAIAction('rewrite', text ?? '');
          break;
        case 'expand':
          handleAIAction('expand', text ?? '');
          break;
        case 'document':
        case 'test': {
          setShowChatState(true);
          persistShowChat(true);
          setShowRightPanel(true);
          const fileRef = activeFile?.name || activeFile?.path || '当前文件';
          const prompt = action === 'document'
            ? `请为「${fileRef}」生成文档说明或注释，可结合当前打开的文件内容。`
            : `请为「${fileRef}」中的选中代码或全文编写测试用例。`;
          scheduleUiTimeout(() => {
            const threadId = getCurrentThreadIdFromStorage();
            window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, {
              detail: { prompt, autoSend: false, threadId: threadId || undefined },
            }));
          }, 300);
          break;
        }
        case 'inline_edit': {
          setShowChatState(true);
          persistShowChat(true);
          setShowRightPanel(true);
          const fileRef = detail.filePath
            ? detail.filePath.split('/').pop()
            : activeFile?.name || '当前文件';
          const codeBlock = `\`\`\`\n${text ?? ''}\n\`\`\``;
          const inlinePrompt = `请编辑「${fileRef}」中的以下内容：\n${codeBlock}\n`;
          scheduleUiTimeout(() => {
            const threadId = getCurrentThreadIdFromStorage();
            window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, {
              detail: { prompt: inlinePrompt, autoSend: false, threadId: threadId || undefined },
            }));
          }, 200);
          break;
        }
        case 'focus_chat':
          setShowChatState(true);
          persistShowChat(true);
          setShowRightPanel(true);
          break;
        case 'menu':
          setShowChatState(true);
          persistShowChat(true);
          setShowRightPanel(true);
          break;
        default:
          if (import.meta.env?.DEV) console.log('[FullEditorV2] 未知 AI 操作:', action);
      }
    };
    
    window.addEventListener('editor_ai_action', handleEditorAIAction as EventListener);
    return () => window.removeEventListener('editor_ai_action', handleEditorAIAction as EventListener);
  }, [handleAIAction, activeFile, editorState.selectedText, persistShowChat]);

  // ============================================================================
  // 订阅文件打开事件（来自工具卡片点击）
  // ============================================================================

  useEffect(() => {
    const unsubscribe = fileEventBus.subscribe(async (event) => {
      if (event.type !== 'file_open' || !event.path) return;
      const gotoLine = event.line != null ? Math.max(1, event.line) : undefined;
      try {
        const existingFile = editorState.openFiles.find(f => f.path === event.path);
        if (existingFile) {
          setEditorState(prev => {
            const alreadyActive = prev.activeFileId === existingFile.id;
            if (alreadyActive && gotoLine == null) return prev;
            return {
              ...prev,
              activeFileId: existingFile.id,
              ...(gotoLine != null ? { cursorPosition: { line: gotoLine, column: 1 } } : {}),
            };
          });
          if (gotoLine != null) {
            setPendingGotoLine(gotoLine);
            toast.success(`已定位到第 ${gotoLine} 行`);
          }
          return;
        }
        const fileName = event.path.split('/').pop() || 'untitled';
        const typeInfo = getFileTypeInfo(fileName);
        const { language, format, mimeType, isBinary } = typeInfo;
        if (isBinary) {
          const base64 = typeof event.content === 'string' ? event.content : '';
          const res = base64 ? { success: true as const, data: { base64, size: 0 } } : await fileSystemService.readFileBinary(event.path);
          if (!res.success || !('data' in res) || !res.data?.base64) {
            toast.error(t('editor.openFailed'), { description: ('error' in res ? res.error : null) || t('editor.binaryReadFailed') });
            return;
          }
          handleFileOpen({
            id: crypto.randomUUID(),
            name: fileName,
            path: event.path,
            content: '',
            language,
            format,
            base64Data: res.data.base64,
            mimeType: mimeType || undefined,
            fileSize: res.data.size,
          });
        } else {
          const content = event.content ?? await langgraphApi.readFile(event.path);
          handleFileOpen({
            id: crypto.randomUUID(),
            name: fileName,
            path: event.path,
            content,
            language,
            format,
          });
        }
        if (gotoLine != null) {
          setEditorState(prev => ({ ...prev, cursorPosition: { line: gotoLine, column: 1 } }));
          setPendingGotoLine(gotoLine);
          toast.success(`已打开并定位到第 ${gotoLine} 行: ${fileName}`);
        } else {
          toast.success(`已打开文件: ${fileName}`);
        }
      } catch (error) {
        console.error('[FullEditorV2] 打开文件失败:', error);
        toast.error(t('editor.openFailed'), { description: error instanceof Error ? error.message : String(error) });
      }
    });
    return unsubscribe;
  }, [editorState.openFiles, handleFileOpen]);

  // 监听「在编辑区打开文件并展示 diff」（来自聊天区 Apply 等）；支持虚拟文件（content + isVirtual）；支持 diffContent 且 path 留空时用当前激活文件
  useEffect(() => {
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string; showDiff?: boolean; diffOriginal?: string; diffContent?: string; content?: string; isVirtual?: boolean }>).detail;
      let path = detail?.path;
      const showDiff = detail.showDiff === true;
      const diffOriginal = detail.diffOriginal;
      const diffContent = detail?.diffContent;
      if (!path && diffContent) {
        const activeFile = editorState.openFiles.find((f) => f.id === editorState.activeFileId);
        if (activeFile) path = activeFile.path;
      }
      if (!path) {
        if (diffContent) {
          toast.info(t("editor.openFileThenApply"));
        }
        return;
      }
      // 相对路径解析：聊天区工具返回的 path 多为工作区相对路径，需拼接当前工作区根以便读取（避免「读取文件失败」）
      const isVirtualPath = path.startsWith("__artifact__") || path.startsWith("__code__") || path.startsWith("/virtual/");
      const isAbsolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
      if (!isVirtualPath && !isAbsolute) {
        const workspaceRoot = (currentWorkspace?.path ?? getCurrentWorkspacePathFromStorage() ?? "").toString().trim().replace(/[/\\]+$/, "");
        if (workspaceRoot) {
          path = workspaceRoot + "/" + path.replace(/^[/\\]+/, "");
        } else {
          toast.error(t("editor.openFailed"), { description: "请先选择工作区后再打开相对路径文件。" });
          return;
        }
      }
      const activeFile = editorState.openFiles.find((f) => f.path === path);
      if (diffContent && activeFile && showDiff) {
        scheduleUiTimeout(() => {
          setEditorState((prev) => ({
            ...prev,
            activeFileId: activeFile.id,
            openFiles: prev.openFiles.map((f) =>
              f.id === activeFile.id
                ? {
                    ...f,
                    content: diffContent,
                    diffOriginal: f.content,
                    showDiff: true,
                    ...(f.format === 'markdown' ? { renderAs: 'monaco' as const } : {}),
                  }
                : f
            ),
          }));
          toast.info(`已打开变更对比: ${activeFile.name}`);
        }, 0);
        return;
      }
      const isVirtual = detail.isVirtual === true || typeof detail.content === "string";
      const virtualContent = typeof detail.content === "string" ? detail.content : undefined;
      try {
        const existingFile = editorState.openFiles.find((f) => f.path === path);
        if (existingFile) {
          setEditorState((prev) => ({
            ...prev,
            activeFileId: existingFile.id,
            openFiles: prev.openFiles.map((f) =>
              f.id === existingFile.id
                ? {
                    ...f,
                    showDiff,
                    ...(diffOriginal !== undefined ? { diffOriginal } : {}),
                    ...(showDiff && f.format === 'markdown' ? { renderAs: 'monaco' as const } : {}),
                  }
                : f
            ),
          }));
          if (showDiff) toast.info(`已打开变更对比: ${existingFile.name}`);
          return;
        }
        const content = isVirtual && virtualContent !== undefined
          ? virtualContent
          : await langgraphApi.readFile(path);
        const fileName = path.split("/").pop() || "untitled";
        const { language, format } = getFileTypeInfo(fileName);
        await handleFileOpen({
          id: Date.now().toString(),
          name: fileName,
          path,
          content,
          language,
          format,
        });
        if (showDiff && diffOriginal !== undefined) {
          scheduleUiTimeout(() => {
            setEditorState((prev) => ({
              ...prev,
              openFiles: prev.openFiles.map((f) =>
                f.path === path
                  ? { ...f, showDiff: true, diffOriginal, ...(f.format === 'markdown' ? { renderAs: 'monaco' as const } : {}) }
                  : f
              ),
            }));
            toast.info(`已打开变更对比: ${fileName}`);
          }, 0);
        } else {
          toast.success(`已打开文件: ${fileName}`);
        }
      } catch (err) {
        console.error("[FullEditorV2] OPEN_FILE_IN_EDITOR failed:", err);
        toast.error(t('editor.openFailed'), { description: err instanceof Error ? err.message : String(err) });
      }
    };
    window.addEventListener(EVENTS.OPEN_FILE_IN_EDITOR, handler);
    return () => window.removeEventListener(EVENTS.OPEN_FILE_IN_EDITOR, handler);
  }, [editorState.openFiles, editorState.activeFileId, handleFileOpen, scheduleUiTimeout, currentWorkspace?.path]);

  // 监听二进制对比：AI 生成新版本后并排预览，接受/另存为/拒绝
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ targetPath?: string; originalBase64?: string; newBase64?: string }>;
      const targetPath = (ev.detail?.targetPath ?? '').trim();
      const newBase64 = ev.detail?.newBase64 ?? '';
      if (!targetPath || !newBase64) return;
      setBinaryDiffSaveAsVisible(false);
      setBinaryDiffSaveAsFilename(targetPath.replace(/^.*[/\\]/, '') || '');
      setBinaryDiffState({
        targetPath,
        originalBase64: ev.detail?.originalBase64,
        newBase64,
      });
    };
    window.addEventListener(EVENTS.OPEN_BINARY_DIFF, handler as EventListener);
    return () => window.removeEventListener(EVENTS.OPEN_BINARY_DIFF, handler as EventListener);
  }, []);

  // 二进制对比打开且未决原文件时，尝试从工作区读取；失败或无可读内容时设为 null 避免重复请求
  useEffect(() => {
    if (!binaryDiffState || binaryDiffState.originalBase64 !== undefined) return;
    let cancelled = false;
    fileSystemService.readFileBinary(binaryDiffState.targetPath).then((res) => {
      if (cancelled || !isMountedRef.current) return;
      if (res.success && 'data' in res && res.data?.base64) {
        setBinaryDiffState((prev) => (prev ? { ...prev, originalBase64: res.data!.base64 } : null));
      } else {
        setBinaryDiffState((prev) => (prev ? { ...prev, originalBase64: null } : null));
      }
    }).catch((e) => {
      if (import.meta.env?.DEV) console.warn('[FullEditorV2Enhanced] readFileBinary failed', e);
      if (!cancelled && isMountedRef.current) setBinaryDiffState((prev) => (prev ? { ...prev, originalBase64: null } : null));
    });
    return () => { cancelled = true; };
  }, [binaryDiffState?.targetPath, binaryDiffState?.originalBase64]);

  // 监听知识库引用：聊天区「在展示区查看」打开检索结果
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ content?: string; toolName?: string }>;
      const content = ev.detail?.content ?? "";
      const toolName = ev.detail?.toolName ?? "知识库";
      const id = `knowledge-ref-${crypto.randomUUID()}`;
      handleFileOpen({
        id,
        name: toolName === "query_kg" || toolName === "knowledge_graph" ? "知识图谱引用" : "知识库引用",
        path: `/virtual/${id}.md`,
        content: content || "（无内容）",
        language: "markdown",
        format: "markdown",
      });
    };
    window.addEventListener("open_knowledge_ref", handler);
    return () => window.removeEventListener("open_knowledge_ref", handler);
  }, [handleFileOpen]);

  // 编辑器快捷菜单「加入对话」：打开右侧面板并填入输入框
  useEffect(() => {
    const handler = (e: CustomEvent<{ text: string; filePath?: string }>) => {
      const text = e.detail?.text?.trim();
      if (!text) return;
      setShowRightPanel(true);
      scheduleUiTimeout(() => {
        const threadId = getCurrentThreadIdFromStorage();
        window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, {
          detail: { prompt: text, autoSend: false, threadId: threadId || undefined },
        }));
      }, 100);
    };
    window.addEventListener('send_selection_to_chat', handler as EventListener);
    return () => window.removeEventListener('send_selection_to_chat', handler as EventListener);
  }, []);

  // 聊天区「添加代码片段」：响应 get_selected_code，回传当前选中或当前文件
  useEffect(() => {
    const handler = (e: CustomEvent<{ callback: (code: string, filePath: string, lineRange: string) => void }>) => {
      const cb = e.detail?.callback;
      if (!cb) return;
      const file = activeFile;
      const sel = editorState.selectedText;
      const range = editorState.selectionRange;
      const lineRange = range ? `${range.startLine}-${range.endLine}` : '1-1';
      if (file && (sel || file.content)) {
        cb(sel || file.content, file.path, lineRange);
      } else {
        cb('', '', '0-0');
      }
    };
    window.addEventListener(EVENTS.GET_SELECTED_CODE, handler as EventListener);
    return () => window.removeEventListener(EVENTS.GET_SELECTED_CODE, handler as EventListener);
  }, [activeFile, editorState.selectedText, editorState.selectionRange]);

  // 聊天区「从工作区选择文件」：响应 open_workspace_file_picker，列出已打开的文件供用户选为附件
  const [workspaceFilePickerOpen, setWorkspaceFilePickerOpen] = useState(false);
  const [workspaceFilePickerHighlightedIndex, setWorkspaceFilePickerHighlightedIndex] = useState(0);
  const workspaceFilePickerCallbackRef = useRef<((path: string, name: string) => void) | null>(null);
  const workspaceFilePickerListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: CustomEvent<{ callback: (path: string, name: string) => void }>) => {
      const cb = e.detail?.callback;
      if (!cb) return;
      workspaceFilePickerCallbackRef.current = cb;
      setWorkspaceFilePickerOpen(true);
      setWorkspaceFilePickerHighlightedIndex(0);
    };
    window.addEventListener(EVENTS.OPEN_WORKSPACE_FILE_PICKER, handler as EventListener);
    return () => window.removeEventListener(EVENTS.OPEN_WORKSPACE_FILE_PICKER, handler as EventListener);
  }, []);

  const openFilesForPicker = useMemo(() => {
    return (editorState.openFiles || []).filter(
      (f) => f.path && !f.path.startsWith('/untitled-')
    );
  }, [editorState.openFiles]);

  useEffect(() => {
    if (workspaceFilePickerOpen && openFilesForPicker.length > 0) {
      setWorkspaceFilePickerHighlightedIndex(0);
      requestAnimationFrame(() => workspaceFilePickerListRef.current?.focus());
    }
  }, [workspaceFilePickerOpen, openFilesForPicker.length]);

  const handleWorkspaceFilePick = useCallback((path: string, name: string) => {
    const cb = workspaceFilePickerCallbackRef.current;
    if (cb) {
      cb(path, name);
      workspaceFilePickerCallbackRef.current = null;
    }
    setWorkspaceFilePickerOpen(false);
  }, []);

  // 聊天区「添加文件夹」：响应 open_folder_picker，用 Electron 选择目录后回调
  useEffect(() => {
    const handler = async (e: CustomEvent<{ callback: (folderPath: string, folderName: string) => void }>) => {
      const cb = e.detail?.callback;
      if (!cb) return;
      const electron = (window as any).electron;
      if (!electron?.selectDirectory) {
        toast.error(t("editor.folderSelectNotSupported"));
        return;
      }
      const result = await electron.selectDirectory();
      if (result.canceled || !result.success || !result.path) return;
      const folderPath = result.path;
      const folderName = folderPath.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || folderPath;
      cb(folderPath, folderName);
    };
    window.addEventListener(EVENTS.OPEN_FOLDER_PICKER, (handler as unknown) as EventListener);
    return () => window.removeEventListener(EVENTS.OPEN_FOLDER_PICKER, (handler as unknown) as EventListener);
  }, []);

  // ============================================================================
  // 渲染
  // ============================================================================

  // macOS 时为红绿灯留 72px；全屏时靠边（不预留红绿灯区）
  const isMacElectron = typeof window !== 'undefined' && (window as any).electron?.platform === 'darwin';
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const electron = (window as any).electron;
    if (electron?.onFullScreenChange) {
      electron.isFullScreen?.().then((v: boolean) => { if (isMountedRef.current) setIsFullscreen(!!v); }).catch((err) => { if (import.meta.env?.DEV) console.warn('[FullEditorV2Enhanced] isFullScreen failed', err); });
      const unsub = electron.onFullScreenChange((v: boolean) => { if (isMountedRef.current) setIsFullscreen(!!v); });
      return unsub;
    }
    const handler = () => { if (isMountedRef.current) setIsFullscreen(!!document.fullscreenElement); };
    document.addEventListener('fullscreenchange', handler);
    handler();
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);
  const titleBarStyle = isMacElectron && !isFullscreen
    ? {
        height: 'var(--titlebar-height, 38px)',
        minHeight: 'var(--titlebar-height, 38px)',
        paddingLeft: 'calc(var(--traffic-light-width, 65px) + var(--traffic-light-safe-gap, 8px))',
        paddingRight: 'var(--titlebar-horizontal-padding, 10px)',
      }
    : {
        height: 'var(--titlebar-height, 38px)',
        minHeight: 'var(--titlebar-height, 38px)',
        paddingLeft: 'var(--titlebar-horizontal-padding, 10px)',
        paddingRight: 'var(--titlebar-horizontal-padding, 10px)',
      };
  // macOS hiddenInset 红绿灯视觉中心略低于标题栏内容中心：仅在非全屏时轻微下移内容做像素对齐
  const titleBarContentStyle = isMacElectron && !isFullscreen
    ? { transform: 'translateY(0.6px)', willChange: 'transform' }
    : undefined;
  // 编辑区 Tab 栏与标题栏保持统一横向留白，不预留红绿灯区
  const editorTabBarLeftPadding = '';

  // 连接状态仅在此处展示（单一信息源），与 Chat 顶栏不再重复
  const [connectionHealthy, setConnectionHealthy] = useState(true);
  const [connectionChecking, setConnectionChecking] = useState(false);
  const [lastConnectionError, setLastConnectionError] = useState<string | null>(null);
  const disconnectTimerRef = useRef<number | null>(null);

  const applyConnectionHealth = useCallback((healthy: boolean, immediate = false) => {
    if (healthy) {
      if (disconnectTimerRef.current != null) {
        window.clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      }
      setConnectionHealthy(true);
      return;
    }
    if (immediate) {
      if (disconnectTimerRef.current != null) {
        window.clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      }
      setConnectionHealthy(false);
      return;
    }
    if (disconnectTimerRef.current != null) return;
    disconnectTimerRef.current = window.setTimeout(() => {
      setConnectionHealthy(false);
      disconnectTimerRef.current = null;
    }, 2500);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = () => checkHealth(false).then((s) => {
      if (cancelled || !isMountedRef.current) return;
      applyConnectionHealth(s.healthy, false);
      setLastConnectionError(s.healthy ? null : (s.error ?? null));
    }).catch(() => {
      if (cancelled || !isMountedRef.current) return;
      applyConnectionHealth(false, false);
      setLastConnectionError('连接失败');
    });
    run();
    const healthIntervalId = setInterval(run, 30000);
    return () => {
      cancelled = true;
      clearInterval(healthIntervalId);
      if (disconnectTimerRef.current != null) {
        window.clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      }
    };
  }, [applyConnectionHealth]);

  const handleConnectionClick = useCallback(() => {
    if (connectionChecking) return;
    setConnectionChecking(true);
    checkHealth(true)
      .then((s) => {
        if (!isMountedRef.current) return;
        applyConnectionHealth(s.healthy, true);
        setLastConnectionError(s.healthy ? null : (s.error ?? null));
        if (s.healthy) {
          toast.success(t("editor.connected"), { description: s.latencyMs != null ? t("editor.connectedDescription", { ms: s.latencyMs }) : undefined });
        } else {
          toast.error(t('editor.connectionFailed'), { description: s.error ?? t('editor.checkBackend') });
        }
      })
      .catch(() => {
        if (!isMountedRef.current) return;
        applyConnectionHealth(false, true);
        setLastConnectionError('连接失败');
        toast.error(t('editor.connectionFailed'), { description: t('editor.checkBackend') });
      })
      .finally(() => { if (isMountedRef.current) setConnectionChecking(false); });
  }, [connectionChecking, applyConnectionHealth]);

  const openWorkspaceDashboard = useCallback(() => {
    setShowSettings(false);
    setActiveTaskId(null);
    setEditorState((prev) => ({ ...prev, activeFileId: null }));
  }, []);

  /** 在编辑区打开整体知识图谱（虚拟 Tab，与文件 Tab 并列） */
  const openKnowledgeGraphInEditor = useCallback(() => {
    setShowSettings(false);
    setActiveTaskId(null);
    setEditorState((prev) => {
      const existing = prev.openFiles.find((f) => f.path === VIRTUAL_KNOWLEDGE_GRAPH_PATH);
      if (existing) {
        return { ...prev, activeFileId: existing.id };
      }
      const newFile: OpenFile = {
        id: crypto.randomUUID(),
        name: '知识图谱',
        path: VIRTUAL_KNOWLEDGE_GRAPH_PATH,
        content: '',
        originalContent: '',
        modified: false,
        format: 'json',
        renderAs: 'viewer',
        viewerHint: 'knowledge-graph',
      };
      return {
        ...prev,
        openFiles: [...prev.openFiles, newFile],
        activeFileId: newFile.id,
      };
    });
  }, []);

  useEffect(() => {
    const handler = () => { openWorkspaceDashboard(); };
    window.addEventListener(EVENTS.COLLAB_CENTER_OPEN, handler);
    return () => window.removeEventListener(EVENTS.COLLAB_CENTER_OPEN, handler);
  }, [openWorkspaceDashboard]);

  useEffect(() => {
    const handler = () => { handleConnectionClick(); };
    window.addEventListener(EVENTS.CONNECTION_RETRY_REQUEST, handler);
    return () => window.removeEventListener(EVENTS.CONNECTION_RETRY_REQUEST, handler);
  }, [handleConnectionClick]);

  const showDisconnectedState = !connectionHealthy && !taskRunning;
  const showConnectedState = connectionHealthy || taskRunning;
  // 任务栏规则：无任务时隐藏、有任务时展示（与 RunTracker、状态栏 run 芯片数据源一致）
  const hasGlobalRunSignal = Boolean(
    taskRunning ||
    (statusRunSummary && (
      statusRunSummary.running ||
      statusRunSummary.lastError ||
      statusRunSummary.linkedTaskId ||
      statusRunSummary.linkedThreadId
    ))
  );
  const statusRunText = statusRunSummary?.statusText
    || (statusRunSummary?.running || taskRunning
      ? `运行中${taskStepCount != null ? ` · ${taskStepCount}步` : ''}${(statusRunSummary?.phaseLabel || taskProgressMessage) ? ` · ${statusRunSummary?.phaseLabel || taskProgressMessage}` : ''}`
      : statusRunSummary?.lastError
        ? `失败：${statusRunSummary.lastError}`
        : taskProgressMessage || '最近运行');
  const statusRunIntentClass = (statusRunSummary?.running || taskRunning)
    ? 'text-primary'
    : statusRunSummary?.lastError
      ? 'text-destructive/90'
      : 'text-muted-foreground';

  return (
    <div className={`h-full min-h-0 overflow-hidden flex flex-col bg-background ${className}`}>
      {/* 顶部标题栏 - Cursor/VSCode 风格：侧边栏 | 全局搜索居中 | 编辑/对话/设置 */}
      <header
        className={cn(
          "titlebar-shell shrink-0 border-b flex items-center app-region-drag transition-[padding] duration-150",
        )}
        style={titleBarStyle}
      >
        {/* 左：侧边栏切换（与红绿灯区域右侧对齐；全屏时靠边） */}
        <div className="flex items-center gap-0.5 app-region-no-drag shrink-0" style={titleBarContentStyle}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "titlebar-icon-button flex items-center justify-center transition-colors",
                  showLeftPanel ? 'text-foreground bg-accent' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                )}
                onClick={() => {
                  if (showLeftPanel) setShowLeftPanel(false);
                  else { setShowLeftPanel(true); setExplorerTab('files'); }
                }}
                aria-label={t("editor.sidebarAria")}
              >
                {showLeftPanel ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>侧边栏 <kbd className="ml-1 font-mono text-[10px] opacity-80">⌘⇧E</kbd></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "titlebar-icon-button flex items-center justify-center transition-colors text-muted-foreground hover:text-foreground hover:bg-accent/50",
                  showLeftPanel && explorerTab === 'files' && 'text-foreground bg-accent'
                )}
                onClick={() => { setShowLeftPanel(true); setExplorerTab('files'); }}
                aria-label={t("editor.workspaceFilesAria")}
              >
                <Folder className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>工作区（文件）</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "titlebar-icon-button flex items-center justify-center transition-colors text-muted-foreground hover:text-foreground hover:bg-accent/50",
                  showLeftPanel && explorerTab === 'knowledge' && 'text-foreground bg-accent'
                )}
                onClick={() => { setShowLeftPanel(true); setExplorerTab('knowledge'); }}
                aria-label={t("editor.knowledgeAria")}
              >
                <BookOpen className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>知识库</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "titlebar-icon-button flex items-center justify-center transition-colors text-muted-foreground hover:text-foreground hover:bg-accent/50",
                  showLeftPanel && explorerTab === 'tasks' && 'text-foreground bg-accent'
                )}
                onClick={() => { setShowLeftPanel(true); setExplorerTab('tasks'); }}
                aria-label={t("editor.tasksAria")}
              >
                <CheckSquare className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>任务</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t("editor.memoryAria")}
                className={cn(
                  "titlebar-icon-button relative flex items-center justify-center transition-colors text-muted-foreground hover:text-foreground hover:bg-accent/50",
                  showLeftPanel && explorerTab === 'memory' && 'text-foreground bg-accent'
                )}
                onClick={() => {
                  if (explorerTab === 'memory' && showLeftPanel) {
                    setShowLeftPanel(false);
                  } else {
                    setExplorerTab('memory');
                    setShowLeftPanel(true);
                  }
                }}
              >
                <Brain className="h-4 w-4" />
                {memoryEntryCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] rounded-full bg-violet-500 text-[8px] text-white flex items-center justify-center px-0.5 leading-none">
                    {memoryEntryCount > 9 ? '9+' : memoryEntryCount}
                  </span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>记忆</TooltipContent>
          </Tooltip>
        </div>

        {/* 中：全局搜索（⌘⇧P；⌘K 为编辑器命令） */}
        <div className="flex-1 flex justify-center px-2.5 min-w-[120px]" style={titleBarContentStyle}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "titlebar-command-trigger h-7 px-3 max-w-72 w-full rounded-full border border-border/50 bg-muted/30 hover:bg-muted/50 flex items-center gap-2 text-[11px] text-muted-foreground/60 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30 text-left app-region-no-drag",
                  commandPaletteOpen && "bg-muted/50 border-border/50 text-foreground"
                )}
                onClick={() => onOpenCommandPalette?.()}
                aria-label={t("editor.globalSearchAria")}
                aria-expanded={commandPaletteOpen}
                aria-haspopup="dialog"
                aria-keyshortcuts="Meta+Shift+P"
              >
                <Search className="size-3 shrink-0" />
                <span className="flex-1 truncate">搜索命令、文件、会话…</span>
                <kbd className="hidden sm:inline text-[9px] px-1 rounded bg-background/60 border border-border/40">⌘⇧P</kbd>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>全局搜索 <kbd className="ml-1 font-mono text-[10px] opacity-80">⌘⇧P</kbd></TooltipContent>
          </Tooltip>
        </div>

        {/* 右：编辑区/对话区 toggle | 设置（与左侧按钮同高对齐） */}
        <div className="flex items-center gap-0.5 app-region-no-drag shrink-0" style={titleBarContentStyle}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="titlebar-icon-button flex items-center justify-center transition-colors text-muted-foreground hover:text-foreground hover:bg-accent/50"
                onClick={() => {
                  openWorkspaceDashboard();
                  window.dispatchEvent(new CustomEvent(EVENTS.COLLAB_CENTER_OPEN, { detail: { source: 'titlebar' } }));
                }}
                aria-label={t("editor.workspaceAria")}
                title={t("editor.workspaceTitle")}
              >
                <LayoutDashboard className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>工作区</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "titlebar-icon-button flex items-center justify-center transition-colors",
                  showEditor ? 'text-foreground bg-accent' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                )}
                onClick={toggleShowEditor}
                aria-label={t("editor.editorAreaAria")}
              >
                <Columns2 className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>编辑区</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "titlebar-icon-button flex items-center justify-center transition-colors",
                  showChat ? 'text-foreground bg-accent' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                )}
                onClick={toggleShowChat}
                aria-label={t("editor.chatAreaAria")}
              >
                <MessageCircle className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>对话区 <kbd className="ml-1 font-mono text-[10px] opacity-80">⌘J</kbd></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "hidden sm:inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors",
                  focusModeEnabled
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border/30 text-muted-foreground hover:text-foreground hover:bg-accent/40"
                )}
                onClick={toggleFocusMode}
                aria-label={t("editor.focusModeAria")}
              >
                {focusModeEnabled ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>切换专注模式（降低界面信息密度）</TooltipContent>
          </Tooltip>
          <span className="w-px h-4 bg-border/20 shrink-0 mx-0.5" aria-hidden />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="titlebar-icon-button flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                onClick={() => {
                  setSettingsInitialSection(undefined);
                  setShowSettings(true);
                }}
                aria-label={t("editor.settingsAria")}
              >
                <Settings className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>设置 <kbd className="ml-1 font-mono text-[10px] opacity-80">⌘,</kbd></TooltipContent>
          </Tooltip>
        </div>
      </header>

      {/* ========== 主内容区域：按 showEditor / showChat 切换 ========== */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* 仅对话：全宽 Chat 区 */}
          {!showEditor && showChat && (
            <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-muted/5">
              {bidWizardOpen ? (
                <div className="h-full flex flex-col min-h-0 bg-background">
                  <div className="shrink-0 flex border-b border-border/50 px-1">
                    <button
                      type="button"
                      className={cn(
                        "px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px",
                        consoleTab === 'wizard' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                      )}
                      onClick={() => setConsoleTab('wizard')}
                    >
                      {t('console.tabWizard')}
                    </button>
                    <button
                      type="button"
                      className={cn(
                        "px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px",
                        consoleTab === 'execution' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                      )}
                      onClick={() => setConsoleTab('execution')}
                    >
                      {t('console.tabExecution')}
                    </button>
                  </div>
                  <div className="flex-1 min-h-0 overflow-hidden">
                    {consoleTab === 'wizard' ? (
                      <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-muted-foreground">{t('console.loadingWizard')}</div>}>
                        <BidWizard
                          open={true}
                          onOpenChange={(open) => { if (!open) onBidWizardClose?.(); }}
                          variant="panel"
                          onComplete={onBidWizardClose}
                          onTaskCreated={(taskId, task, threadId) => {
                            setConsoleLinkedTaskId(taskId);
                            setConsoleLinkedThreadId(threadId ?? null);
                            setConsoleLinkedSubject(task.subject ?? null);
                            setConsoleTab('execution');
                          }}
                        />
                      </Suspense>
                    ) : consoleLinkedTaskId ? (
                      <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-muted-foreground">{t('console.loadingExecution')}</div>}>
                        <TaskExecutionPanel
                          taskId={consoleLinkedTaskId}
                          threadId={consoleLinkedThreadId}
                          subject={consoleLinkedSubject ?? undefined}
                          onClose={() => {
                            setConsoleLinkedTaskId(null);
                            setConsoleLinkedThreadId(null);
                            setConsoleLinkedSubject(null);
                          }}
                          onOpenTaskInEditor={handleOpenTaskInEditor}
                        />
                      </Suspense>
                    ) : (
                      <div className="h-full flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
                        <ListTodo className="h-10 w-10 opacity-40" />
                        <p>{t('console.emptyDescription')}</p>
                        <p className="text-xs">{t('console.emptyHint')}</p>
                        <Button variant="outline" size="sm" className="mt-2" onClick={() => setConsoleTab('wizard')}>
                          {t('console.openWizard')}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-muted-foreground">{t('editor.chatLoading')}</div>}>
                  <ChatAreaEnhanced
                    workspaceId={currentWorkspace?.id}
                    editorContent={activeFile?.content}
                    editorPath={activeFile?.path}
                    selectedText={editorState.selectedText}
                    linterErrors={editorState.linterErrors}
                    workspacePath={currentWorkspace?.path}
                    openFiles={openFilesForChat}
                    recentlyViewedFiles={recentlyViewedFilesForChat}
                    connectionHealthy={connectionHealthy}
                    connectionError={lastConnectionError}
                    className="h-full flex-1"
                    onClose={() => { setShowEditorState(true); persistShowEditor(true); }}
                    onFileAction={handleFileActionFromChat}
                  />
                </Suspense>
              )}
            </div>
          )}
          {/* 编辑区可见：侧边栏 + 编辑区（含 Tab 栏）+（showChat 时）聊天 */}
          {showEditor && (
          <>
          <div className="flex-1 flex overflow-hidden min-h-0">
            <AnimatePresence>
              {showLeftPanel && (
                <motion.div
                  key="left-panel"
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -12 }}
                  transition={{ duration: 0.18 }}
                  className="h-full min-h-0 shrink-0"
                >
              <Resizable
                size={{ width: leftPanelWidth, height: '100%' }}
                onResizeStop={(_e, _dir, ref) => {
                  const w = Math.max(140, Math.min(420, ref.offsetWidth));
                  setLeftPanelWidth(w);
                  setStorageItem('maibot_left_panel_width', String(w));
                }}
                minWidth={140}
                maxWidth={420}
                enable={{ right: true }}
                handleStyles={{ right: { width: '10px', right: '-5px', cursor: 'col-resize', background: 'transparent' } }}
                handleClasses={{ right: 'hover:bg-primary/20 active:bg-primary/40 rounded-r transition-colors duration-150' }}
                className="h-full min-h-0 overflow-hidden sidebar-container bg-sidebar border-l border-r border-sidebar-border shrink-0"
              >
                    <div className="h-full min-h-0 flex flex-col">
                      <div className="shrink-0 h-10 px-2 flex items-center justify-between border-b border-sidebar-border">
                        <span className="text-[11px] font-medium text-muted-foreground truncate" title={explorerTab === 'files' && (currentWorkspace?.path || getCurrentWorkspacePathFromStorage()) ? (currentWorkspace?.path || getCurrentWorkspacePathFromStorage()) : undefined}>
                          {explorerTab === 'files'
                            ? (() => {
                                const path = currentWorkspace?.path || getCurrentWorkspacePathFromStorage() || '';
                                const short = path ? (path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || path) : '';
                                return short ? `当前工作区：${short}` : '工作区';
                              })()
                            : explorerTab === 'knowledge' ? '知识库' : explorerTab === 'tasks' ? '任务' : '记忆'}
                        </span>
                        <button className="h-7 w-7 min-h-7 min-w-7 flex items-center justify-center rounded text-muted-foreground hover:bg-muted/50 hover:text-foreground" onClick={() => setShowLeftPanel(false)} title={t("editor.closeTitle")} aria-label={t("editor.closeAria")}>
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      <div className="shrink-0 relative flex border-b border-border/20">
                        {[
                          { id: 'files', icon: <Folder className="h-4 w-4" />, label: '文件', title: '工作区（文件树）' },
                          { id: 'knowledge', icon: <BookOpen className="h-4 w-4" />, label: '知识', title: '知识库', badge: knowledgeBadge },
                          { id: 'tasks', icon: <ListTodo className="h-4 w-4" />, label: '任务', title: '任务 (⌘⇧T)', count: pendingTaskCount },
                          { id: 'memory', icon: <Brain className="h-4 w-4" />, label: '记忆', title: '记忆' },
                        ].map((tab) => (
                          <button
                            key={tab.id}
                            type="button"
                            className={cn(
                              "flex-1 flex flex-col items-center gap-0.5 py-1.5 px-2 text-[10px] font-medium transition-colors relative z-10 pointer-events-auto",
                              explorerTab === tab.id ? 'text-foreground bg-accent/50' : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
                            )}
                            onClick={() => setExplorerTab(tab.id as typeof explorerTab)}
                            title={tab.title}
                            aria-label={tab.label}
                          >
                            <span className="relative inline-flex">
                              {tab.icon}
                              {tab.badge && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-500" aria-hidden />}
                              {typeof tab.count === 'number' && tab.count > 0 && (
                                <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] rounded-full bg-blue-500 text-[8px] text-white flex items-center justify-center px-0.5 leading-none">
                                  {tab.count > 9 ? '9+' : tab.count}
                                </span>
                              )}
                            </span>
                            <span>{tab.label}</span>
                          </button>
                        ))}
                        <motion.div
                          layoutId="left-panel-tab-indicator"
                          className="absolute bottom-0 h-[1.5px] bg-primary z-10"
                          style={{ width: '25%', left: explorerTab === 'files' ? 0 : explorerTab === 'knowledge' ? '25%' : explorerTab === 'tasks' ? '50%' : '75%' }}
                          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                        />
                      </div>

                      {/* 内容区：工作区 / 知识库 / 任务（细粒度 ErrorBoundary 隔离单块崩溃） */}
                      <div className="flex-1 overflow-hidden min-h-0">
                        <ErrorBoundary
                          fallback={
                            <div className="p-3 text-xs text-muted-foreground text-center">
                              {t('editor.panelLoadError')}
                            </div>
                          }
                        >
                        {explorerTab === 'files' && (
                          <WorkspaceFileTree
                            selectedPath={activeFile?.path}
                            openFilePaths={workspaceFilePaths}
                            onFocusOpenFile={(path) => {
                              const existing = editorState.openFiles.find((f) => f.path === path);
                              if (existing) setEditorState((prev) => ({ ...prev, activeFileId: existing.id }));
                            }}
                            onFileOpen={(path, content) => void handleFileOpenFromExplorer(path, content)}
                            onWorkspaceChange={setCurrentWorkspace}
                          />
                        )}
                        {explorerTab === 'knowledge' && (
                          <KnowledgeBasePanel
                            sidebarMode={true}
                            initialTab={knowledgeInitTab}
                            initialCrystallizationSkillName={crystallizationSkillName ?? undefined}
                            onFileOpen={(path, content) => void handleFileOpenFromExplorer(path, content ?? '')}
                            onOpenKnowledgeGraphInEditor={openKnowledgeGraphInEditor}
                          />
                        )}
                        {explorerTab === 'tasks' && (
                          <TaskListSidebar
                            onOpenTask={handleOpenTaskInEditor}
                            activeTaskId={activeTaskId}
                          />
                        )}
                        {explorerTab === 'memory' && (
                          <MemoryPanel workspacePath={currentWorkspace?.path} />
                        )}
                        </ErrorBoundary>
                      </div>
                    </div>
              </Resizable>
                </motion.div>
              )}
            </AnimatePresence>

            {/* 中间区域 - Tab 栏（文件+任务）始终显示；下方为任务详情 | 设置页 | 编辑器/预览器 | 仪表盘 */}
            <div className="flex-1 flex flex-col min-w-0">
              <div
                className={cn(
                  "h-(--tabbar-height) shrink-0 panel-header border-b flex items-center",
                  editorTabBarLeftPadding
                )}
                role="tablist"
                aria-label={t("editor.openFilesAria")}
              >
                  <div className="flex items-stretch overflow-x-auto scrollbar-hide flex-1 min-w-0">
                    {editorState.openFiles.map((file, index) => {
                      const isActive = file.id === editorState.activeFileId && !showSettings && !activeTaskId;
                      const isModified = isFileModified(file);
                      const isSaving = savingFiles.has(file.id);
                      const canSave = isActive && isModified && !savingFiles.has(file.id);
                      return (
                        <ContextMenu key={file.id}>
                          <ContextMenuTrigger asChild>
                            <div className="relative flex items-stretch min-w-0">
                              {tabDropIndicatorIndex === index && (
                                <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-primary z-10 rounded-full pointer-events-none" aria-hidden />
                              )}
                              <div
                                role="tab"
                                aria-selected={isActive}
                                aria-label={file.name}
                                draggable
                                onDragStart={(e) => {
                                  tabDragIndexRef.current = index;
                                  setTabDraggingIndex(index);
                                  e.dataTransfer.effectAllowed = 'move';
                                  e.dataTransfer.setData('text/plain', file.id);
                                }}
                                onDragOver={(e) => {
                                  e.preventDefault();
                                  e.dataTransfer.dropEffect = 'move';
                                  setTabDropIndicatorIndex(index);
                                }}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  const from = tabDragIndexRef.current;
                                  if (from == null || from === index) return;
                                  tabDragIndexRef.current = null;
                                  setTabDraggingIndex(null);
                                  setTabDropIndicatorIndex(null);
                                  setEditorState((prev) => {
                                    const files = [...prev.openFiles];
                                    const [removed] = files.splice(from, 1);
                                    files.splice(index, 0, removed);
                                    return { ...prev, openFiles: files };
                                  });
                                }}
                                onDragEnd={() => {
                                  tabDragIndexRef.current = null;
                                  setTabDraggingIndex(null);
                                  setTabDropIndicatorIndex(null);
                                }}
                                className={cn(
                                  "group relative flex items-center gap-1 px-2.5 text-[10px] cursor-grab active:cursor-grabbing transition-all duration-100 min-w-[72px] max-w-[140px]",
                                  tabDraggingIndex === index && "opacity-50",
                                  isActive
                                    ? 'bg-background text-foreground shadow-[inset_0_-1px_0_hsl(var(--background)),0_1px_0_hsl(var(--background))]'
                                    : 'text-muted-foreground hover:text-foreground/80 hover:bg-muted/30'
                                )}
                                onClick={() => {
                                  setShowSettings(false);
                                  setActiveTaskId(null);
                                  setEditorState(prev => ({ ...prev, activeFileId: file.id }));
                                }}
                              >
                              {isActive && (
                                <div className="absolute top-0 left-0 right-0 h-[2px] bg-primary" />
                              )}
                              {!isActive && (
                                <div className="absolute top-0 left-0 right-0 h-[2px] bg-primary opacity-0 transition-opacity group-hover:opacity-50" aria-hidden />
                              )}
                              {index > 0 && !isActive && (
                                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-px h-4 bg-border/20" />
                              )}
                              <FileTypeIcon fileName={file.name} className="h-3.5 w-3.5 shrink-0" />
                              <span className="flex flex-col min-w-0 flex-1">
                                <span className={`truncate ${isModified ? 'italic' : ''}`} title={file.path}>
                                  {file.name}
                                </span>
                                {isActive && file.language && (
                                  <span className="text-[9px] text-primary/50 leading-none -mt-0.5 truncate max-w-full" aria-hidden>
                                    {file.language}
                                  </span>
                                )}
                              </span>
                              <div className="flex items-center gap-0.5 shrink-0">
                                {isSaving ? (
                                  <RefreshCw className="h-3 w-3 animate-spin text-primary" aria-hidden />
                                ) : canSave ? (
                                  <button
                                    className="p-0.5 rounded hover:bg-foreground/10 transition-all opacity-80 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                                    onClick={(e) => { e.stopPropagation(); handleSaveFile(file.id); }}
                                    title={t("editor.saveTitle")}
                                    aria-label={t("editor.saveAria")}
                                  >
                                    <Save className="h-3 w-3" />
                                  </button>
                                ) : isModified ? (
                                  <span className="w-2 h-2 rounded-full bg-amber-500/80 animate-pulse" title={t("editor.unsavedTitle")} aria-hidden />
                                ) : null}
                                <button
                                  className={`p-0.5 rounded hover:bg-foreground/10 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${
                                    isModified ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                                  }`}
                                  onClick={(e) => { e.stopPropagation(); handleFileClose(file.id); }}
                                  title={t("editor.closeTabTitle")}
                                  aria-label={t("editor.closeTabAria")}
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </div>
                            </div>
                            </div>
                          </ContextMenuTrigger>
                          <ContextMenuContent className="min-w-[160px]">
                            {isModified && (
                              <ContextMenuItem onClick={() => handleSaveFile(file.id)} disabled={savingFiles.has(file.id)}>
                                <Save className="h-3.5 w-3.5" />
                                保存 (⌘S)
                              </ContextMenuItem>
                            )}
                            <ContextMenuItem onClick={() => handleDownloadFile(file)}>
                              <Download className="h-3.5 w-3.5" />
                              下载
                            </ContextMenuItem>
                            <ContextMenuItem onClick={() => handleOpenExternal(file)}>
                              <ExternalLink className="h-3.5 w-3.5" />
                              在外部打开
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              onClick={() => {
                                const filesToClose = editorState.openFiles.filter((f) => f.id !== file.id);
                                const modified = filesToClose.filter(isFileModified);
                                if (modified.length > 0) {
                                  setPendingBatchCloseIds(filesToClose.map((f) => f.id));
                                } else {
                                  filesToClose.forEach((f) => doCloseFileById(f.id));
                                }
                              }}
                            >
                              <X className="h-3.5 w-3.5" />
                              关闭其他
                            </ContextMenuItem>
                            <ContextMenuItem
                              onClick={() => {
                                const filesToClose = editorState.openFiles.filter((_, i) => i > index);
                                const modified = filesToClose.filter(isFileModified);
                                if (modified.length > 0) {
                                  setPendingBatchCloseIds(filesToClose.map((f) => f.id));
                                } else {
                                  filesToClose.forEach((f) => doCloseFileById(f.id));
                                }
                              }}
                              disabled={index >= editorState.openFiles.length - 1}
                            >
                              <X className="h-3.5 w-3.5" />
                              关闭右侧
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              onClick={() => {
                                try {
                                  navigator.clipboard.writeText(file.path);
                                  toast.success(t("editor.pathCopied"), { description: file.path });
                                } catch {
                                  toast.error(t('common.copyFailed'), { description: t('common.copyFailedDescription') });
                                }
                              }}
                            >
                              <Copy className="h-3.5 w-3.5" />
                              复制路径
                            </ContextMenuItem>
                            <ContextMenuItem
                              onClick={() => {
                                setShowLeftPanel(true);
                                setExplorerTab('files');
                                window.dispatchEvent(new CustomEvent('file_tree_locate', { detail: { path: file.path } }));
                              }}
                            >
                              <PanelLeft className="h-3.5 w-3.5" />
                              在文件树中定位
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem onClick={() => handleFileClose(file.id)}>
                              <X className="h-3.5 w-3.5" />
                              关闭 (⌘W)
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      );
                    })}
                  </div>
                  {/* 任务 Tab */}
                  {openTasks.map((task) => {
                    const isTaskActive = activeTaskId === task.id && !showSettings;
                    return (
                      <div key={`task-${task.id}`} className="relative flex items-stretch min-w-0">
                        <div
                          role="tab"
                          aria-selected={isTaskActive}
                          aria-label={`任务: ${task.subject}`}
                          className={cn(
                            "group relative flex items-center gap-1 px-2.5 text-[10px] cursor-pointer transition-all duration-100 min-w-[72px] max-w-[140px]",
                            isTaskActive
                              ? 'bg-background text-foreground shadow-[inset_0_-1px_0_hsl(var(--background)),0_1px_0_hsl(var(--background))]'
                              : 'text-muted-foreground hover:text-foreground/80 hover:bg-muted/30'
                          )}
                          onClick={() => {
                            setActiveTaskId(task.id);
                            setShowSettings(false);
                            setEditorState(prev => ({ ...prev, activeFileId: null }));
                          }}
                        >
                          {isTaskActive && <div className="absolute top-0 left-0 right-0 h-[2px] bg-violet-500" />}
                          {!isTaskActive && <div className="absolute top-0 left-0 right-0 h-[2px] bg-violet-500 opacity-0 transition-opacity group-hover:opacity-50" aria-hidden />}
                          <ListTodo className="h-3.5 w-3.5 shrink-0 text-violet-500" />
                          <span className="flex-1 truncate" title={task.subject}>{task.subject}</span>
                          <button
                            className="p-0.5 rounded hover:bg-foreground/10 transition-all opacity-0 group-hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                            onClick={(e) => { e.stopPropagation(); handleCloseTaskTab(task.id); }}
                            title={t("editor.closeTaskTitle")}
                            aria-label={t("editor.closeTaskAria")}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {editorState.openFiles.length === 0 && openTasks.length === 0 && (
                    <div className="flex items-center px-3 text-[11px] text-muted-foreground">
                      {t('editor.noOpenTabs')}
                    </div>
                  )}
                  {/* 新建文件（类型：纯文本 / Markdown / 空表格） */}
                  <Popover open={newFilePopoverOpen} onOpenChange={setNewFilePopoverOpen}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            className="flex items-center justify-center w-8 h-full shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                            title={t("editor.newFileTitle")}
                            aria-label={t("editor.newFileAria")}
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                        </PopoverTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">新建文件 <kbd className="ml-1 font-mono text-[10px] opacity-80">⌘N</kbd></TooltipContent>
                    </Tooltip>
                    <PopoverContent side="bottom" align="start" className="w-48 p-1">
                      <button
                        type="button"
                        className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-muted"
                        onClick={() => { setNewFilePopoverOpen(false); handleNewFile(); }}
                      >
                        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                        {t('editor.newPlainText')}
                      </button>
                      <button
                        type="button"
                        className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-muted"
                        onClick={() => { setNewFilePopoverOpen(false); handleNewMarkdown(); }}
                      >
                        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                        {t('editor.newMarkdown')}
                      </button>
                      <button
                        type="button"
                        className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-muted"
                        onClick={() => { setNewFilePopoverOpen(false); handleNewSpreadsheet(); }}
                      >
                        <FileSpreadsheet className="h-3.5 w-3.5 text-muted-foreground" />
                        {t('editor.newSpreadsheet')}
                      </button>
                    </PopoverContent>
                  </Popover>
                  {/* 分栏切换：无 → 水平 → 垂直 → 无 */}
                  {(activeFile || splitSecondFile) && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className={cn(
                            "flex items-center justify-center w-8 h-full shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                            splitLayout !== 'none' && "text-primary bg-primary/10"
                          )}
                          title={splitLayout === 'none' ? '分栏（水平）' : splitLayout === 'horizontal' ? '分栏（垂直）' : '关闭分栏'}
                          aria-label={t("editor.editorSplitAria")}
                          onClick={() => {
                            const next = splitLayout === 'none' ? 'horizontal' : splitLayout === 'horizontal' ? 'vertical' : 'none';
                            setSplitLayout(next);
                            setStorageItem('maibot_editor_split', next);
                            if (next === 'none') setSplitSecondFileId(null);
                          }}
                        >
                          <Columns2 className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{splitLayout === 'none' ? '分栏（水平）' : splitLayout === 'horizontal' ? '分栏（垂直）' : '关闭分栏'}</TooltipContent>
                    </Tooltip>
                  )}
                  {/* Word Wrap 切换 */}
                  {(activeFile || splitSecondFile) && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className={cn(
                            "flex items-center justify-center w-8 h-full shrink-0 transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                            wordWrap === 'on' ? "text-primary bg-accent" : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
                          )}
                          title={wordWrap === 'on' ? '关闭自动换行' : '开启自动换行'}
                          aria-label={wordWrap === 'on' ? '自动换行已开启' : '自动换行已关闭'}
                          onClick={() => {
                            const next = wordWrap === 'on' ? 'off' : 'on';
                            setWordWrap(next);
                            setStorageItem('maibot_editor_word_wrap', next);
                          }}
                        >
                          <WrapText className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{wordWrap === 'on' ? '关闭自动换行' : '开启自动换行'}</TooltipContent>
                    </Tooltip>
                  )}
                  {/* Minimap 切换 */}
                  {(activeFile || splitSecondFile) && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className={cn(
                            "flex items-center justify-center w-8 h-full shrink-0 transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                            minimapEnabled ? "text-primary bg-accent" : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
                          )}
                          title={minimapEnabled ? '关闭 Minimap' : '开启 Minimap'}
                          aria-label={minimapEnabled ? 'Minimap 已开启' : 'Minimap 已关闭'}
                          onClick={() => {
                            const next = !minimapEnabled;
                            setMinimapEnabled(next);
                            setStorageItem('maibot_editor_minimap', next ? 'true' : 'false');
                          }}
                        >
                          <MapIcon className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{minimapEnabled ? '关闭 Minimap' : '开启 Minimap'}</TooltipContent>
                    </Tooltip>
                  )}
                  {/* Tab 溢出菜单：列出所有已打开的文件与任务 */}
                  {(editorState.openFiles.length > 0 || openTasks.length > 0) && (
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className="flex items-center justify-center w-8 h-full shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                          title={t("editor.openFilesAndTasksAria")}
                          aria-label={t("editor.openFilesAndTasksAria")}
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent side="bottom" align="end" className="w-64 p-0">
                        <div className="max-h-[280px] overflow-y-auto py-1">
                          {editorState.openFiles.map((file) => {
                            const isActive = file.id === editorState.activeFileId && !showSettings && !activeTaskId;
                            return (
                              <button
                                key={file.id}
                                type="button"
                                className={cn(
                                  "w-full flex items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors",
                                  isActive ? "bg-accent text-accent-foreground" : "hover:bg-muted/50"
                                )}
                                onClick={() => {
                                  setShowSettings(false);
                                  setActiveTaskId(null);
                                  setEditorState(prev => ({ ...prev, activeFileId: file.id }));
                                }}
                              >
                                <FileTypeIcon fileName={file.name} className="h-3.5 w-3.5 shrink-0" />
                                <span className="flex-1 truncate">{file.name}</span>
                              </button>
                            );
                          })}
                          {openTasks.length > 0 && editorState.openFiles.length > 0 && (
                            <div className="h-px bg-border/50 my-1" />
                          )}
                          {openTasks.map((task) => {
                            const isActive = activeTaskId === task.id && !showSettings;
                            return (
                              <button
                                key={`task-${task.id}`}
                                type="button"
                                className={cn(
                                  "w-full flex items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors",
                                  isActive ? "bg-accent text-accent-foreground" : "hover:bg-muted/50"
                                )}
                                onClick={() => {
                                  setActiveTaskId(task.id);
                                  setShowSettings(false);
                                  setEditorState(prev => ({ ...prev, activeFileId: null }));
                                }}
                              >
                                <ListTodo className="h-3.5 w-3.5 shrink-0 text-violet-500" />
                                <span className="flex-1 truncate">{task.subject}</span>
                              </button>
                            );
                          })}
                        </div>
                      </PopoverContent>
                    </Popover>
                  )}
              </div>
              {activeTaskId && openTasks.some(t => t.id === activeTaskId) ? (
                <Suspense fallback={<div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">{t('editor.taskDetailLoading')}</div>}>
                  <TaskDetailView
                    taskId={activeTaskId}
                    focusSection={taskFocusSectionById[activeTaskId]}
                    onOpenThread={(threadId) => {
                      setShowRightPanel(true);
                      setShowChatState(true);
                      persistShowChat(true);
                      window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_TO_THREAD, { detail: { threadId } }));
                    }}
                    onOpenFile={(path) => {
                      fileEventBus.emit({ type: 'file_open', path });
                    }}
                    onClose={() => handleCloseTaskTab(activeTaskId)}
                  />
                </Suspense>
              ) : showSettings ? (
                <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                  <Suspense fallback={<div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">{t('editor.settingsLoading')}</div>}>
                    <SettingsView onClose={() => setShowSettings(false)} initialSection={settingsInitialSection} />
                  </Suspense>
                </div>
              ) : activeFile ? (
                <>
              {/* 编辑区内容容器：ErrorBoundary 兜底单文件预览崩溃，key 随文件切换以重置；支持水平/垂直分栏 */}
              <div className="flex-1 overflow-hidden relative min-h-0 bg-background/50 shadow-inner flex flex-col">
                {activeFile && !focusModeEnabled && (
                  <div className="flex items-center justify-between gap-2 px-3 h-[22px] shrink-0 border-b border-border/20 bg-background/50 text-[11px] text-muted-foreground/60 overflow-hidden">
                    <div className="flex items-center gap-0.5 min-w-0 flex-1 overflow-hidden">
                      {activeFile.path.split('/').filter(Boolean).map((seg, i, arr) => {
                        const pathPrefix = activeFile.path.startsWith('/') ? '/' : '';
                        return (
                          <React.Fragment key={i}>
                            {i > 0 && <span className="text-muted-foreground/30 mx-0.5 select-none">/</span>}
                            <button
                              type="button"
                              className={cn(
                                "hover:text-foreground truncate transition-colors max-w-[120px]",
                                i === arr.length - 1 && "text-foreground/80 font-medium cursor-default"
                              )}
                              onClick={() => {
                                if (i >= arr.length - 1) return;
                                const path = pathPrefix + arr.slice(0, i + 1).join('/');
                                window.dispatchEvent(new CustomEvent('file_tree_locate', { detail: { path } }));
                              }}
                            >
                              {seg}
                            </button>
                          </React.Fragment>
                        );
                      })}
                    </div>
                    {activeFile.format === 'docx' && (
                      <button
                        type="button"
                        className="shrink-0 flex items-center gap-1 h-5 px-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50"
                        title={t('editor.editAsMarkdown')}
                        aria-label={t('editor.editAsMarkdown')}
                        onClick={async () => {
                          const base64 = getBase64FromCache(activeFile.id);
                          let b64 = base64;
                          if (!b64 && activeFile.path && !activeFile.path.startsWith('/virtual/')) {
                            const res = await fileSystemService.readFileBinary(activeFile.path);
                            b64 = res.success ? res.data?.base64 : undefined;
                          }
                          if (!b64) {
                            toast.error(t('editor.openFailed'), { description: '无法获取文档内容' });
                            return;
                          }
                          try {
                            const clean = b64.replace(/\s/g, '');
                            const buf = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0)).buffer;
                            const md = await fileUtils.convertDocxToMarkdown(buf);
                            const mdPath = activeFile.path.replace(/\.docx?$/i, '.md');
                            const mdName = (activeFile.name || '').replace(/\.docx?$/i, '.md') || 'untitled.md';
                            const typeInfo = getFileTypeInfo(mdName);
                            handleFileOpen({
                              id: crypto.randomUUID(),
                              name: mdName,
                              path: mdPath,
                              content: md,
                              language: typeInfo.language,
                              format: typeInfo.format,
                            });
                            toast.success(t('editor.openedAsMarkdown'));
                          } catch (err) {
                            toast.error(t('editor.openFailed'), { description: err instanceof Error ? err.message : String(err) });
                          }
                        }}
                      >
                        <FileText className="size-3" />
                        <span className="hidden sm:inline">{t('editor.editAsMarkdown')}</span>
                      </button>
                    )}
                    <Popover open={versionHistoryOpen} onOpenChange={setVersionHistoryOpen}>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className="shrink-0 flex items-center gap-1 h-5 px-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50"
                          title={t('editor.versionHistory')}
                          aria-label={t('editor.versionHistory')}
                        >
                          <History className="size-3" />
                          <span className="hidden sm:inline">{t('editor.versionHistory')}</span>
                        </button>
                      </PopoverTrigger>
                      <PopoverContent side="bottom" align="end" className="w-72 p-0" aria-describedby="version-history-desc">
                        <div id="version-history-desc" className="sr-only">{t('editor.versionHistory')}</div>
                        <div className="p-2 border-b border-border/50 text-[11px] font-medium text-foreground/80">
                          {activeFile.name} · {t('editor.versionHistory')}
                        </div>
                        <div className="max-h-64 overflow-y-auto p-1">
                          {(() => {
                            const versions = (fileVersions.get(activeFile.path) || []).slice().reverse();
                            if (versions.length === 0) {
                              return (
                                <p className="px-2 py-4 text-[11px] text-muted-foreground text-center">
                                  {t('editor.noVersionHistory')}
                                </p>
                              );
                            }
                            return versions.map((v, idx) => (
                              <div
                                key={idx}
                                className="flex items-center justify-between gap-2 py-1.5 px-2 rounded hover:bg-muted/50 group"
                              >
                                <div className="min-w-0 flex-1">
                                  <span className="text-[11px] text-muted-foreground">
                                    {v.timestamp instanceof Date
                                      ? v.timestamp.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                                      : String(v.timestamp)}
                                  </span>
                                  {v.description && <span className="ml-1.5 text-[11px] text-foreground/70 truncate block">· {v.description}</span>}
                                </div>
                                <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 px-2 text-[11px]"
                                    title={t('editor.viewChanges')}
                                    onClick={() => {
                                      setEditorState(prev => ({
                                        ...prev,
                                        openFiles: prev.openFiles.map(f =>
                                          f.id === activeFile.id
                                            ? { ...f, diffOriginal: v.content, showDiff: true }
                                            : f
                                        ),
                                      }));
                                      setVersionHistoryOpen(false);
                                      toast.info(t('editor.viewChanges'));
                                    }}
                                  >
                                    {t('editor.viewChanges')}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 px-2 text-[11px]"
                                    onClick={() => {
                                      setEditorState(prev => ({
                                        ...prev,
                                        openFiles: prev.openFiles.map(f =>
                                          f.id === activeFile.id
                                            ? { ...f, content: v.content, originalContent: v.content }
                                            : f
                                        ),
                                      }));
                                      setVersionHistoryOpen(false);
                                      toast.success(t('editor.restoreVersion'));
                                    }}
                                  >
                                    {t('editor.restoreVersion')}
                                  </Button>
                                </div>
                              </div>
                            ));
                          })()}
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>
                )}
                {activeFile.showDiff && (
                  <div className="absolute top-2 right-3 z-10 flex items-center gap-1 rounded-md border border-border/50 bg-background/90 backdrop-blur-sm shadow-sm p-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        setEditorState(prev => ({
                          ...prev,
                          openFiles: prev.openFiles.map(f =>
                            f.id === activeFile.id ? { ...f, diffOriginal: undefined, showDiff: false } : f
                          ),
                        }));
                        handleSaveFile(activeFile.id);
                      }}
                      className="flex items-center gap-1 h-6 px-2 text-[11px] rounded text-emerald-600 hover:bg-emerald-500/10"
                      title={t("editor.acceptSaveTitle")}
                    >
                      <Check className="size-3.5" />
                      <span>接受</span>
                    </button>
                    <div className="w-px h-4 bg-border/50" />
                    <button
                      type="button"
                      onClick={() => {
                        const orig = activeFile.diffOriginal;
                        if (orig == null) return;
                        setEditorState(prev => ({
                          ...prev,
                          openFiles: prev.openFiles.map(f =>
                            f.id === activeFile.id
                              ? { ...f, content: orig, originalContent: orig, diffOriginal: undefined, showDiff: false }
                              : f
                          ),
                        }));
                      }}
                      className="flex items-center gap-1 h-6 px-2 text-[11px] rounded text-destructive/80 hover:bg-destructive/10"
                      title={t("editor.rejectTitle")}
                    >
                      <X className="size-3.5" />
                      <span>拒绝</span>
                    </button>
                  </div>
                )}
                {splitLayout === 'none' ? (
                  <div className="flex-1 min-h-0 overflow-hidden pl-4 flex flex-col h-full">
                    <ErrorBoundary
                      key={activeFile.id}
                      fallback={
                        <EditorViewerErrorFallback
                          file={activeFile}
                          onOpenExternal={handleOpenExternal}
                          onClose={handleFileClose}
                        />
                      }
                    >
                      {(() => {
                        const activeBase64 = getBase64FromCache(activeFile.id) ?? activeFile.base64Data;
                        switch (activeFile.renderAs) {
                          case 'richtext':
                            return (
                              <div className="h-full w-full overflow-hidden min-h-[120px]">
                                <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-muted-foreground">{t('editor.editorLoading')}</div>}>
                                  <MilkdownEditor
                                    value={activeFile.content}
                                    onChange={(newValue) => handleFileContentChange(activeFile.id, newValue)}
                                    readOnly={false}
                                    height="100%"
                                  />
                                </Suspense>
                              </div>
                            );
                          case 'viewer':
                            if (activeFile.path === VIRTUAL_KNOWLEDGE_GRAPH_PATH) {
                              return (
                                <div className="h-full min-h-0 overflow-hidden flex flex-col">
                                  <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-muted-foreground">{t('editor.previewLoading')}</div>}>
                                    <KnowledgeGraphView showToolbar={true} limit={300} />
                                  </Suspense>
                                </div>
                              );
                            }
                            return (
                              <div className="h-full min-h-0 overflow-hidden flex flex-col">
                                <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-muted-foreground">{t('editor.previewLoading')}</div>}>
                                  <UniversalFileViewer
                                    key={activeFile.id}
                                    fileName={activeFile.name}
                                    filePath={activeFile.path}
                                    content={activeFile.format === 'image' && activeBase64
                                      ? `data:${activeFile.mimeType || 'image/png'};base64,${activeBase64}`
                                      : activeFile.content}
                                    base64Data={activeBase64}
                                    mimeType={activeFile.mimeType}
                                    fileSize={activeFile.fileSize}
                                    readOnly={false}
                                    onChange={(c) => handleFileContentChange(activeFile.id, c)}
                                    onDownload={() => handleDownloadFile(activeFile)}
                                    onOpenExternal={() => handleOpenExternal(activeFile)}
                                    onSaveBinary={activeFile.format === 'excel' ? (base64) => Promise.resolve(handleSaveBinaryFile(activeFile.id, activeFile.path, activeFile.name, base64)) : undefined}
                                    embeddedInEditor={true}
                                    height="100%"
                                  />
                                </Suspense>
                              </div>
                            );
                          default:
                            return (
                              <div className="h-full w-full overflow-hidden min-h-[120px]">
                                <MonacoEditorEnhanced
                                  value={activeFile.content}
                                  onChange={(newValue) => handleFileContentChange(activeFile.id, newValue)}
                                  onSelectionChange={handleEditorSelectionChange}
                                  onCursorChange={handleEditorCursorChange}
                                  onLinterErrorsChange={(errs) => setEditorState((prev) => ({ ...prev, linterErrors: errs }))}
                                  scrollToLine={pendingGotoLine}
                                  onRevealedLine={() => setPendingGotoLine(null)}
                                  language={activeFile.language}
                                  filePath={activeFile.path}
                                  fileName={activeFile.name}
                                  fileFormat={activeFile.format as 'markdown' | 'code' | 'text' | 'json'}
                                  readOnly={false}
                                  onSave={() => handleSaveFile(activeFile.id)}
                                  height="100%"
                                  diffOriginal={activeFile.diffOriginal}
                                  showDiff={activeFile.showDiff}
                                  wordWrap={wordWrap}
                                  minimap={minimapEnabled}
                                />
                              </div>
                            );
                        }
                      })()}
                    </ErrorBoundary>
                  </div>
                ) : (
                  <div className={cn("flex-1 min-h-0 flex overflow-hidden", splitLayout === 'vertical' ? 'flex-col' : 'flex-row')}>
                    <div className="flex-1 min-w-0 min-h-0 overflow-hidden pl-4 flex flex-col">
                      <ErrorBoundary
                        key={activeFile.id}
                        fallback={
                          <EditorViewerErrorFallback
                            file={activeFile}
                            onOpenExternal={handleOpenExternal}
                            onClose={handleFileClose}
                          />
                        }
                      >
                        {(() => {
                          const activeBase64 = getBase64FromCache(activeFile.id) ?? activeFile.base64Data;
                          switch (activeFile.renderAs) {
                            case 'richtext':
                              return (
                                <div className="h-full w-full overflow-hidden min-h-[120px]">
                                  <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-muted-foreground">{t('editor.editorLoading')}</div>}>
                                    <MilkdownEditor value={activeFile.content} onChange={(v) => handleFileContentChange(activeFile.id, v)} readOnly={false} height="100%" />
                                  </Suspense>
                                </div>
                              );
                            case 'viewer':
                              return (
                                <div className="h-full min-h-0 overflow-hidden flex flex-col">
                                    <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-muted-foreground">{t('editor.previewLoading')}</div>}>
                                    <UniversalFileViewer
                                      key={activeFile.id}
                                      fileName={activeFile.name}
                                      filePath={activeFile.path}
                                      content={activeFile.format === 'image' && activeBase64 ? `data:${activeFile.mimeType || 'image/png'};base64,${activeBase64}` : activeFile.content}
                                      base64Data={activeBase64}
                                      mimeType={activeFile.mimeType}
                                      fileSize={activeFile.fileSize}
                                      readOnly={false}
                                      onChange={(c) => handleFileContentChange(activeFile.id, c)}
                                      onDownload={() => handleDownloadFile(activeFile)}
                                      onOpenExternal={() => handleOpenExternal(activeFile)}
                                      onSaveBinary={activeFile.format === 'excel' ? (base64) => Promise.resolve(handleSaveBinaryFile(activeFile.id, activeFile.path, activeFile.name, base64)) : undefined}
                                      embeddedInEditor={true}
                                      height="100%"
                                    />
                                  </Suspense>
                                </div>
                              );
                            default:
                              return (
                                <div className="h-full w-full overflow-hidden min-h-[120px]">
                                  <MonacoEditorEnhanced
                                    value={activeFile.content}
                                    onChange={(v) => handleFileContentChange(activeFile.id, v)}
                                    onSelectionChange={handleEditorSelectionChange}
                                    onCursorChange={handleEditorCursorChange}
                                    onLinterErrorsChange={(errs) => setEditorState((prev) => ({ ...prev, linterErrors: errs }))}
                                    scrollToLine={pendingGotoLine}
                                    onRevealedLine={() => setPendingGotoLine(null)}
                                    language={activeFile.language}
                                    filePath={activeFile.path}
                                    fileName={activeFile.name}
                                    fileFormat={activeFile.format as 'markdown' | 'code' | 'text' | 'json'}
                                    readOnly={false}
                                    onSave={() => handleSaveFile(activeFile.id)}
                                    height="100%"
                                    diffOriginal={activeFile.diffOriginal}
                                    showDiff={activeFile.showDiff}
                                    wordWrap={wordWrap}
                                    minimap={minimapEnabled}
                                  />
                                </div>
                              );
                          }
                        })()}
                      </ErrorBoundary>
                    </div>
                    <Resizable
                      size={splitLayout === 'vertical' ? { height: splitSecondHeight, width: '100%' } : { width: splitSecondWidth, height: '100%' }}
                      minWidth={splitLayout === 'vertical' ? undefined : 200}
                      minHeight={splitLayout === 'vertical' ? 120 : undefined}
                      enable={splitLayout === 'vertical' ? { top: true, bottom: false } : { left: true, right: false }}
                      handleStyles={splitLayout === 'vertical' ? { top: { height: '8px', cursor: 'row-resize', background: 'transparent' } } : { left: { width: '10px', left: '-5px', cursor: 'col-resize', background: 'transparent' } }}
                      handleClasses={splitLayout === 'vertical' ? { top: 'hover:bg-primary/20 active:bg-primary/40 rounded-t transition-colors' } : { left: 'hover:bg-primary/20 active:bg-primary/40 rounded-l transition-colors' }}
                      className={splitLayout === 'vertical' ? 'border-t border-border/40 bg-background/50' : 'border-l border-border/40 bg-background/50 shrink-0'}
                      onResizeStop={(_e, _dir, ref) => {
                        if (splitLayout === 'vertical') {
                          const h = Math.max(120, Math.min(800, ref.offsetHeight));
                          setSplitSecondHeight(h);
                          setStorageItem('maibot_editor_split_second_height', String(h));
                        } else {
                          const w = Math.max(200, Math.min(900, ref.offsetWidth));
                          setSplitSecondWidth(w);
                          setStorageItem('maibot_editor_split_second_width', String(w));
                        }
                      }}
                    >
                      <div className="h-full w-full min-w-0 min-h-0 overflow-hidden flex flex-col">
                        {splitSecondFile ? (
                          <ErrorBoundary
                            key={splitSecondFile.id}
                            fallback={
                              <EditorViewerErrorFallback
                                file={splitSecondFile}
                                onOpenExternal={handleOpenExternal}
                                onClose={handleFileClose}
                              />
                            }
                          >
                            {(() => {
                              const base64 = getBase64FromCache(splitSecondFile.id) ?? splitSecondFile.base64Data;
                              switch (splitSecondFile.renderAs) {
                                case 'richtext':
                                  return (
                                    <div className="h-full w-full overflow-hidden min-h-[120px]">
                                      <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-muted-foreground">加载中...</div>}>
                                        <MilkdownEditor value={splitSecondFile.content} onChange={(v) => handleFileContentChange(splitSecondFile.id, v)} readOnly={false} height="100%" />
                                      </Suspense>
                                    </div>
                                  );
                                case 'viewer':
                                  if (splitSecondFile.path === VIRTUAL_KNOWLEDGE_GRAPH_PATH) {
                                    return (
                                      <div className="h-full min-h-0 overflow-hidden flex flex-col">
                                        <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-muted-foreground">加载中...</div>}>
                                          <KnowledgeGraphView showToolbar={true} limit={300} />
                                        </Suspense>
                                      </div>
                                    );
                                  }
                                  return (
                                    <div className="h-full min-h-0 overflow-hidden flex flex-col">
                                      <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-muted-foreground">加载中...</div>}>
                                        <UniversalFileViewer
                                          key={splitSecondFile.id}
                                          fileName={splitSecondFile.name}
                                          filePath={splitSecondFile.path}
                                          content={splitSecondFile.format === 'image' && base64 ? `data:${splitSecondFile.mimeType || 'image/png'};base64,${base64}` : splitSecondFile.content}
                                          base64Data={base64}
                                          mimeType={splitSecondFile.mimeType}
                                          fileSize={splitSecondFile.fileSize}
                                          readOnly={false}
                                          onChange={(c) => handleFileContentChange(splitSecondFile.id, c)}
                                          onDownload={() => handleDownloadFile(splitSecondFile)}
                                          onOpenExternal={() => handleOpenExternal(splitSecondFile)}
                                          onSaveBinary={splitSecondFile.format === 'excel' ? (b64) => Promise.resolve(handleSaveBinaryFile(splitSecondFile.id, splitSecondFile.path, splitSecondFile.name, b64)) : undefined}
                                          embeddedInEditor={true}
                                          height="100%"
                                        />
                                      </Suspense>
                                    </div>
                                  );
                                default:
                                  return (
                                    <div className="h-full w-full overflow-hidden min-h-[120px]">
                                      <MonacoEditorEnhanced
                                        value={splitSecondFile.content}
                                        onChange={(v) => handleFileContentChange(splitSecondFile.id, v)}
                                        language={splitSecondFile.language}
                                        filePath={splitSecondFile.path}
                                        fileName={splitSecondFile.name}
                                        fileFormat={splitSecondFile.format as 'markdown' | 'code' | 'text' | 'json'}
                                        readOnly={false}
                                        onSave={() => handleSaveFile(splitSecondFile.id)}
                                        height="100%"
                                        wordWrap={wordWrap}
                                        minimap={minimapEnabled}
                                      />
                                    </div>
                                  );
                              }
                            })()}
                          </ErrorBoundary>
                        ) : (
                          <div className="h-full flex flex-col items-center justify-center p-4 text-muted-foreground text-sm gap-2">
                            <span>{t('editor.selectFilePlaceholder')}</span>
                            <select
                              className="rounded border border-border bg-background px-2 py-1 text-xs max-w-full"
                              value=""
                              onChange={(e) => {
                                const id = e.target.value;
                                if (id) setSplitSecondFileId(id);
                              }}
                            >
                              <option value="">{t('editor.selectOption')}</option>
                              {editorState.openFiles.filter((f) => f.id !== editorState.activeFileId).map((f) => (
                                <option key={f.id} value={f.id}>{f.name}</option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    </Resizable>
                  </div>
                )}
              </div>

              {/* AI 处理状态提示 - 仅在处理中显示 */}
              {aiActionState.isProcessing && (
                <div className="border-t bg-violet-500/5 px-3 py-2 flex items-center gap-2 shrink-0">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin text-violet-500" />
                  <span className="text-xs text-muted-foreground">{t('editor.aiActionProgress', { action: String(aiActionState.action ?? '') })}</span>
                </div>
              )}
              
              {/* AI 结果预览和确认 - Cursor 风格 */}
              {aiActionState.result && (
                <div className="border-t bg-linear-to-r from-emerald-500/5 to-blue-500/5 shrink-0">
                  <div className="px-3 py-2 flex items-center justify-between border-b border-primary/20">
                    <div className="flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-emerald-500" />
                      <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                        AI {aiActionState.action}结果
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-3 text-xs text-muted-foreground hover:text-foreground"
                        onClick={handleCancelAIResult}
                      >
                        取消
                      </Button>
                      <Button
                        size="sm"
                        className="h-7 px-3 text-xs bg-primary hover:bg-primary/90 text-primary-foreground"
                        onClick={handleApplyAIResult}
                      >
                        应用更改
                      </Button>
                    </div>
                  </div>
                  <div className="p-3 max-h-48 overflow-auto">
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <div className="text-muted-foreground mb-1 flex items-center gap-1">
                          <span className="w-2 h-2 rounded-full bg-destructive" />
                          原始内容
                        </div>
                        <div className="p-2 rounded bg-destructive/5 border border-destructive/20 text-foreground/70 whitespace-pre-wrap max-h-32 overflow-auto">
                          {aiActionState.originalText}
                        </div>
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-1 flex items-center gap-1">
                          <span className="w-2 h-2 rounded-full bg-primary" />
                          新内容
                        </div>
                        <div className="p-2 rounded bg-primary/5 border border-primary/20 text-foreground whitespace-pre-wrap max-h-32 overflow-auto">
                          {aiActionState.result}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
                </>
              ) : (
              <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-muted-foreground">{t('editor.workspacePanelLoading')}</div>}>
                <WorkspaceDashboard
                  workspacePath={currentWorkspace?.path}
                  workspaceName={currentWorkspace?.name || '工作区'}
                  openFiles={editorState.openFiles}
                  onOpenFile={(path) => {
                    // 通过文件事件总线打开文件
                    fileEventBus.emit({ type: 'file_open', path });
                  }}
                  onNewProject={() => {
                    setShowChatState(true);
                    persistShowChat(true);
                    setShowRightPanel(true);
                  }}
                  onContinueProject={(projectId) => {
                    setShowChatState(true);
                    persistShowChat(true);
                    setShowRightPanel(true);
                    if (projectId) {
                      runAfterThreadSwitch(projectId, () => {
                        scheduleUiTimeout(() => window.dispatchEvent(new CustomEvent(EVENTS.FOCUS_COMPOSER)), 100);
                      });
                    }
                  }}
                  onSubmitTask={(prompt) => {
                    setShowChatState(true);
                    persistShowChat(true);
                    setShowRightPanel(true);
                    scheduleUiTimeout(() => {
                      const threadId = getCurrentThreadIdFromStorage();
                      window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, {
                        detail: { prompt: prompt || '', autoSend: false, threadId: threadId || undefined },
                      }));
                    }, 0);
                    if (prompt?.trim()) {
                      toast.success(t("editor.filledTask"), {
                        description: prompt.slice(0, 50) + (prompt.length > 50 ? '...' : ''),
                      });
                    }
                  }}
                />
              </Suspense>
              )}
            </div>

            <AnimatePresence>
              {(showEditor && showChat && showRightPanel) || bidWizardOpen ? (
                <motion.div
                  key="right-panel"
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 12 }}
                  transition={{ duration: 0.18 }}
                  className="h-full shrink-0"
                >
              <Resizable
                size={{ width: rightPanelWidth, height: '100%' }}
                onResizeStop={(_e, _dir, ref) => {
                  const w = Math.max(280, Math.min(900, ref?.offsetWidth ?? 0));
                  setRightPanelWidth(w);
                  setStorageItem('maibot_right_panel_width', String(w));
                }}
                minWidth={280}
                maxWidth={900}
                enable={{ left: true }}
                handleStyles={{ left: { width: '10px', left: '-5px', cursor: 'col-resize', background: 'transparent' } }}
                handleClasses={{ left: 'hover:bg-primary/20 active:bg-primary/40 rounded-l transition-colors duration-150' }}
                className="h-full border-l border-sidebar-border bg-muted/5 shrink-0"
              >
                    {bidWizardOpen ? (
                      <div className="h-full flex flex-col min-h-0 bg-background">
                        <div className="shrink-0 flex border-b border-border/50 px-1">
                          <button
                            type="button"
                            className={cn(
                              "px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px",
                              consoleTab === 'wizard' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                            )}
                            onClick={() => setConsoleTab('wizard')}
                          >
                            {t('console.tabWizard')}
                          </button>
                          <button
                            type="button"
                            className={cn(
                              "px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px",
                              consoleTab === 'execution' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                            )}
                            onClick={() => setConsoleTab('execution')}
                          >
                            {t('console.tabExecution')}
                          </button>
                        </div>
                        <div className="flex-1 min-h-0 overflow-hidden">
                          {consoleTab === 'wizard' ? (
                            <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-muted-foreground">{t('console.loadingWizard')}</div>}>
                              <BidWizard
                                open={true}
                                onOpenChange={(open) => { if (!open) onBidWizardClose?.(); }}
                                variant="panel"
                                onComplete={onBidWizardClose}
                                onTaskCreated={(taskId, task, threadId) => {
                                  setConsoleLinkedTaskId(taskId);
                                  setConsoleLinkedThreadId(threadId ?? null);
                                  setConsoleLinkedSubject(task.subject ?? null);
                                  setConsoleTab('execution');
                                }}
                              />
                            </Suspense>
                          ) : consoleLinkedTaskId ? (
                            <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-muted-foreground">{t('console.loadingExecution')}</div>}>
                              <TaskExecutionPanel
                                taskId={consoleLinkedTaskId}
                                threadId={consoleLinkedThreadId}
                                subject={consoleLinkedSubject ?? undefined}
                                onClose={() => {
                                  setConsoleLinkedTaskId(null);
                                  setConsoleLinkedThreadId(null);
                                  setConsoleLinkedSubject(null);
                                }}
                                onOpenTaskInEditor={handleOpenTaskInEditor}
                              />
                            </Suspense>
                          ) : (
                            <div className="h-full flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
                              <ListTodo className="h-10 w-10 opacity-40" />
                              <p>{t('console.emptyDescription')}</p>
                              <p className="text-xs">{t('console.emptyHint')}</p>
                              <Button variant="outline" size="sm" className="mt-2" onClick={() => setConsoleTab('wizard')}>
                                {t('console.openWizard')}
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <Suspense fallback={<div className="h-full flex items-center justify-center text-xs text-muted-foreground">{t('editor.chatLoading')}</div>}>
                        <ChatAreaEnhanced
                          workspaceId={currentWorkspace?.id}
                          editorContent={activeFile?.content}
                          editorPath={activeFile?.path}
                          selectedText={editorState.selectedText}
                          linterErrors={editorState.linterErrors}
                          workspacePath={currentWorkspace?.path}
                          openFiles={openFilesForChat}
                          recentlyViewedFiles={recentlyViewedFilesForChat}
                          connectionHealthy={connectionHealthy}
                          connectionError={lastConnectionError}
                          className="h-full"
                          onClose={toggleRightPanel}
                          onFileAction={handleFileActionFromChat}
                        />
                      </Suspense>
                    )}
              </Resizable>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
          </>
          )}
        </div>
      </div>

      {/* 底部状态栏（系统感知力）：左侧=连接/认证、模式·角色、运行摘要、工作区路径；右侧=模式、模型；401 时提示「请检查 API Token 配置」 */}
      <footer
        role="status"
        aria-live="polite"
        aria-label={hasGlobalRunSignal ? "状态：AI 运行摘要可用" : connectionHealthy ? t("statusBar.ariaConnected") : t("statusBar.ariaDisconnected")}
        className={cn("h-[24px] statusbar-shell border-t text-muted-foreground flex items-center justify-between px-1.5 sm:px-2 text-[10.5px] sm:text-[11px] shrink-0", MODE_STATUSBAR_BORDER[activeMode])}
      >
        {/* 左侧：连接、任务运行、会话、工作区路径（角色/模式统一在 Composer） */}
        <div className="flex flex-1 items-center h-full min-w-0 gap-0 overflow-hidden">
          {showConnectedState ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded transition-all duration-150 hover:bg-muted/50"
                  title={t("editor.connectionStatusTitle")}
                  onClick={handleConnectionClick}
                  disabled={connectionChecking}
                  aria-label={taskRunning && !connectionHealthy ? t("statusBar.ariaReconnecting") : t("statusBar.connected")}
                >
                  {connectionChecking ? (
                    <RefreshCw className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
                  ) : (
                    <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-emerald-500" aria-hidden />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {taskRunning && !connectionHealthy ? t("statusBar.reconnecting") : t("statusBar.connected")}
              </TooltipContent>
            </Tooltip>
          ) : showDisconnectedState ? (
            <>
              <button
                type="button"
                className="flex items-center gap-1.5 shrink-0 px-2 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 transition-all duration-150"
                title={t("editor.connectionStatusTitle")}
                onClick={handleConnectionClick}
                disabled={connectionChecking}
                aria-label={t("statusBar.disconnected")}
              >
                {connectionChecking ? (
                  <RefreshCw className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
                ) : (
                  <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-amber-500" />
                )}
                <span className="hidden sm:inline">{t("statusBar.disconnected")}</span>
              </button>
              {lastConnectionError && /401|403|unauthorized|token|api key|权限/i.test(lastConnectionError) && (
                <button
                  type="button"
                  className="shrink-0 px-2 py-0.5 rounded text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 text-[10.5px] underline underline-offset-1"
                  onClick={() => {
                    setShowSettings(true);
                    setSettingsInitialSection('agent_profile');
                    setShowRightPanel(true);
                    persistShowChat(true);
                    setShowChatState(true);
                  }}
                >
                  {t("statusBar.checkTokenConfig")}
                </button>
              )}
            </>
          ) : null}
          <span className="w-px h-3 bg-border/40 shrink-0" aria-hidden />
          <span
            className="hidden sm:inline px-2 py-0.5 rounded text-muted-foreground/90 text-[10.5px]"
            title={t("editor.modeRoleTitle")}
          >
            {t("modes." + activeMode)}
            {(statusBarThreadRole || getScopedActiveRoleIdFromStorage()) ? ` · ${statusBarThreadRole || getScopedActiveRoleIdFromStorage()}` : ''}
          </span>
          {isElectronEnv() && (
            <>
              <span className="w-px h-3 bg-border/40 shrink-0" aria-hidden />
              <Popover open={windowPopoverOpen} onOpenChange={setWindowPopoverOpen}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="relative flex items-center shrink-0 px-2 py-0.5 rounded transition-all duration-150 hover:bg-muted/50"
                        title={t("editor.windowManageAria")}
                        aria-label={t("editor.windowManageAria")}
                      >
                        <LayoutGrid className="h-3.5 w-3.5 shrink-0" />
                        {windowList.length > 1 && (
                          <span className="absolute -top-0.5 -right-0.5 h-3.5 min-w-[14px] flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[9px] font-medium">
                            {windowList.length > 9 ? "9+" : windowList.length}
                          </span>
                        )}
                      </button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="top">窗口管理</TooltipContent>
                </Tooltip>
                <PopoverContent side="top" align="start" className="w-56 p-0">
                  <div className="py-1 max-h-[240px] overflow-y-auto">
                    {windowList.map((w) => (
                      <button
                        key={w.id}
                        type="button"
                        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/60 rounded-none"
                        onClick={() => {
                          window.electron?.focusWindow(w.id);
                          setWindowPopoverOpen(false);
                        }}
                      >
                        {w.primary ? <Home className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                        <span className="truncate flex-1">{w.primary ? (w.title || '主窗口') : (w.roleId === 'digital_worker' ? '数字员工' : w.roleId)}</span>
                      </button>
                    ))}
                  </div>
                  <div className="border-t border-border/40 p-1">
                    <button
                      type="button"
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/60 rounded-md"
                      onClick={() => {
                        window.electron?.createWorkerWindow?.({ roleId: 'digital_worker' });
                        setWindowPopoverOpen(false);
                      }}
                    >
                      <LayoutGrid className="h-3.5 w-3.5 shrink-0" />
                      新建数字员工窗口
                    </button>
                  </div>
                </PopoverContent>
              </Popover>
            </>
          )}
          {hasGlobalRunSignal ? (
            <>
              <span className="w-px h-3 bg-border/40 shrink-0" aria-hidden />
              <button
                type="button"
                className={cn(
                  "flex items-center gap-1.5 px-2 py-0.5 rounded transition-all duration-150 max-w-[130px] sm:max-w-[180px] lg:max-w-[220px] min-w-0 shrink-0 pointer-events-auto",
                  statusRunIntentClass,
                  statusRunSummary?.running ? "hover:bg-primary/10" : "hover:bg-muted/50"
                )}
                title={t("editor.runSummaryTitle")}
                onClick={() => {
                  if (statusRunSummary?.linkedTaskId) {
                    handleOpenTaskInEditor(statusRunSummary.linkedTaskId, statusRunSummary.linkedSubject || '任务');
                    return;
                  }
                  setShowChatState(true);
                  persistShowChat(true);
                  setShowRightPanel(true);
                  if (statusRunSummary?.linkedThreadId) {
                    runAfterThreadSwitch(statusRunSummary.linkedThreadId, () => {
                      scheduleUiTimeout(() => window.dispatchEvent(new CustomEvent(EVENTS.FOCUS_COMPOSER)), 100);
                    });
                    return;
                  }
                  scheduleUiTimeout(() => window.dispatchEvent(new CustomEvent(EVENTS.FOCUS_COMPOSER)), 100);
                }}
                aria-label={t("editor.runSummaryAria")}
              >
                <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", statusRunSummary?.running ? "bg-primary animate-pulse" : statusRunSummary?.lastError ? "bg-destructive" : "bg-muted-foreground/70")} />
                <span className="truncate">{statusRunText}</span>
                {todosProgress ? <span className="hidden sm:inline text-[10px] text-muted-foreground/50 tabular-nums ml-1">{todosProgress.done}/{todosProgress.total} 步</span> : null}
                {statusRunSummary?.elapsedSec ? <span className="hidden sm:inline tabular-nums text-[10px] opacity-80">{statusRunSummary.elapsedSec}s</span> : null}
              </button>
            </>
          ) : null}
          {(activeTaskId || activeFile || showSettings) && (
            <>
              <span className="w-px h-3 bg-border/40 shrink-0" aria-hidden />
              <button
                type="button"
                className="inline px-2 py-0.5 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-all duration-150 pointer-events-auto"
                title={t("editor.backToWorkspaceAria")}
                aria-label={t("editor.backToWorkspaceAria")}
                onClick={openWorkspaceDashboard}
              >
                工作区面板
              </button>
            </>
          )}
          {statusBarThreadId && !showChat && !focusModeEnabled && (
            <>
              <span className="w-px h-3 bg-border/40 shrink-0" aria-hidden />
              <button
                type="button"
                className="hidden md:inline truncate max-w-[120px] lg:max-w-[180px] px-2 py-0.5 hover:bg-muted/50 rounded text-left transition-all duration-150"
                title={`当前会话：${statusBarThreadTitle}`}
                aria-label={t("editor.currentSessionAria")}
                onClick={() => {
                  setShowChatState(true);
                  persistShowChat(true);
                  setShowRightPanel(true);
                  runAfterThreadSwitch(statusBarThreadId, () => {
                    scheduleUiTimeout(() => window.dispatchEvent(new CustomEvent(EVENTS.FOCUS_COMPOSER)), 100);
                  });
                }}
              >
                {statusBarThreadTitle}
              </button>
              {statusBarThreadRole && (
                <span
                  className="hidden lg:inline px-2 py-0.5 rounded text-[11px] text-muted-foreground/90"
                  title={`会话角色：${statusBarThreadRole}。切换仅影响后续消息，不改历史记录。`}
                >
                  角色：{statusBarThreadRole}（后续生效）
                </span>
              )}
            </>
          )}
          {currentWorkspace?.path && !focusModeEnabled && (
            <>
              <span className="w-px h-3 bg-border/40 shrink-0" aria-hidden />
              <span
                className="hidden xl:inline truncate max-w-[200px] px-2 py-0.5 rounded text-muted-foreground/90 cursor-default"
                title={currentWorkspace.path}
              >
                {currentWorkspace.path.split(/[\\/]/).filter(Boolean).pop() || currentWorkspace.path}
              </span>
            </>
          )}
        </div>
        {/* 右侧：编辑区相关 - 未保存、当前文件、行列、语言、编码、模型 */}
        <div className="flex items-center h-full min-w-0 gap-0">
          {modifiedOpenFiles.length > 0 && (
            <>
              <button
                type="button"
                className="flex items-center gap-1 px-2 py-0.5 rounded text-amber-600 dark:text-amber-400 shrink-0 hover:bg-amber-500/10 transition-all duration-150"
title={t("editor.saveUnsavedTitle")}
                    aria-label={t("editor.saveUnsavedAria")}
                onClick={() => {
                  if (activeFile && isFileModified(activeFile)) {
                    handleSaveFile(activeFile.id);
                  } else {
                    if (modifiedOpenFiles.length > 0) handleSaveFile(modifiedOpenFiles[0].id);
                  }
                }}
              >
                <span className="w-1 h-1 rounded-full bg-amber-500 animate-pulse" />
                <span className="hidden md:inline">{modifiedOpenFiles.length} 未保存</span>
                <span className="md:hidden">{modifiedOpenFiles.length}</span>
              </button>
              <span className="w-px h-3 bg-border/40 shrink-0" aria-hidden />
            </>
          )}
          {activeFile && !showSettings && (
            <>
              {editorState.cursorPosition != null && (
                <span className="hidden sm:inline xl:hidden text-muted-foreground/60 tabular-nums shrink-0 mr-1" title={t("editor.lineColTitle")}>
                  Ln {editorState.cursorPosition.line}, Col {editorState.cursorPosition.column}
                </span>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="hidden sm:flex truncate max-w-[100px] md:max-w-[140px] px-2 py-0.5 text-foreground/80 shrink-0 hover:bg-muted/50 rounded text-left transition-all duration-150 items-center gap-0.5"
                    title={modifiedOpenFiles.length > 0 ? `未保存：${modifiedOpenFiles.map((f) => f.name).join('、')}` : activeFile.path}
                    aria-label={t("editor.currentFileAria")}
                    onClick={() => {
                      if (!showLeftPanel && activeFile?.path) {
                        setShowLeftPanel(true);
                        setExplorerTab('files');
                        window.dispatchEvent(new CustomEvent('file_tree_locate', { detail: { path: activeFile.path } }));
                      }
                    }}
                    onDoubleClick={(e) => {
                      e.preventDefault();
                      if (activeFile?.path && navigator.clipboard?.writeText) {
                        navigator.clipboard.writeText(activeFile.path);
                        toast.success(t("editor.pathCopiedToClipboard"));
                      }
                    }}
                  >
                    <span className="truncate">{activeFileDisplayPath || activeFile.name}</span>
                    {modifiedOpenFiles.length > 0 && <span className="text-amber-500 shrink-0" title={t("editor.unsavedTitle")}>●</span>}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {modifiedOpenFiles.length > 0 ? (
                    <>
                      <p className="font-medium mb-1">未保存文件</p>
                      <ul className="text-xs text-muted-foreground list-disc list-inside">
                        {modifiedOpenFiles.map((f) => (
                          <li key={f.id}>{f.name}</li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    activeFile.path
                  )}
                </TooltipContent>
              </Tooltip>
              <span className="hidden sm:inline w-px h-3 bg-border/40 shrink-0" aria-hidden />
              <span className="hidden xl:inline shrink-0 px-2 py-0.5 hover:bg-muted/50 rounded transition-all duration-150" title={t("editor.lineColTitle")}>Ln {editorState.cursorPosition?.line ?? 1}, Col {editorState.cursorPosition?.column ?? 1}</span>
              <button
                type="button"
                className="hidden lg:flex items-center gap-1 px-2 h-full text-[11px] text-muted-foreground/60 hover:text-foreground hover:bg-muted/20 transition-colors"
                title={t("editor.encodingTitle")}
              >
                UTF-8
              </button>
              <button
                type="button"
                className="shrink-0 hidden lg:inline px-2 py-0.5 hover:bg-muted/50 rounded transition-all duration-150"
                title={t("editor.langModeTitle")}
                aria-label={t("editor.langModeAria")}
                onClick={() => window.dispatchEvent(new CustomEvent(EVENTS.OPEN_EDITOR_COMMAND_PALETTE as string))}
              >
                {activeFile.language || 'Text'}
              </button>
              <span className="hidden lg:inline w-px h-3 bg-border/40 shrink-0" aria-hidden />
            </>
          )}
          {agentFeatureFlags.tradeable_mode && (
            <>
              <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded text-amber-700 dark:text-amber-300 bg-amber-500/10 shrink-0">
                <Wallet className="h-3 w-3" />
                <span className="hidden md:inline">{agentFeatureFlags.wallet_enabled ? "钱包已启用" : "交易模式"}</span>
              </span>
              <span className="hidden sm:inline w-px h-3 bg-border/40 shrink-0" aria-hidden />
            </>
          )}
          {memoryEntryCount > 0 && (
            <>
              <button
                type="button"
                title={`AI 已记住 ${memoryEntryCount} 条信息`}
                className="hidden md:inline-flex items-center gap-1 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors px-1 shrink-0"
                onClick={() => { setExplorerTab("memory"); setShowLeftPanel(true); }}
              >
                <Brain className="size-3" />
                <span className="tabular-nums">{memoryEntryCount}</span>
              </button>
              <span className="hidden md:inline w-px h-3 bg-border/40 shrink-0" aria-hidden />
            </>
          )}
          <button
            type="button"
            title={t("editor.shortcutHelpTitle")}
            className="hidden md:inline-flex items-center gap-1 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors px-1 shrink-0"
            onClick={() => setShortcutsHelpOpen(true)}
          >
            <span className="font-mono">?</span>
          </button>
          {isElectronEnv() && mcpServerNames.length > 0 && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center gap-1 shrink-0 px-1.5 py-0 rounded text-[10px] text-muted-foreground" title={t("editor.mcpServerTitle")}>
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" aria-hidden />
                    <span>{mcpServerNames.length}</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="font-medium mb-1">MCP 已连接</p>
                  <ul className="text-xs text-muted-foreground list-disc list-inside">
                    {mcpServerNames.map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                  </ul>
                </TooltipContent>
              </Tooltip>
              <span className="w-px h-3 bg-border/40 shrink-0" aria-hidden />
            </>
          )}
          {/* 连接状态 + 模型 合并为一块：一处表示模型名与连接状态（颜色）；断开时点击重试，连接时点击打开模型选择 */}
          {showDisconnectedState ? (
            <button
              type="button"
              className="shrink-0 flex items-center gap-1.5 px-2 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 transition-all duration-150 truncate max-w-[100px] md:max-w-[120px] text-left"
              title={t("editor.connectionErrorTitle")}
              aria-label={t("statusBar.disconnected")}
              onClick={handleConnectionClick}
              disabled={connectionChecking}
            >
              {connectionChecking ? (
                <RefreshCw className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
              ) : (
                <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-amber-500" aria-hidden />
              )}
              <span className="truncate">{getStatusBarModelLabel(statusBarModelId)}</span>
            </button>
          ) : (
            <Popover open={modelPopoverOpen} onOpenChange={setModelPopoverOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "shrink-0 flex items-center gap-1.5 px-2 py-0.5 hover:bg-muted/50 truncate max-w-[84px] md:max-w-[100px] text-left transition-all duration-150 rounded",
                    modelPopoverOpen && "bg-muted/50 text-foreground"
                  )}
                  title={t("editor.modelConnectionTitle")}
                  aria-label={t("editor.modelSwitchAria")}
                >
                  {connectionChecking ? (
                    <RefreshCw className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
                  ) : (
                    <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-emerald-500" aria-hidden />
                  )}
                  <span className="truncate">{getStatusBarModelLabel(statusBarModelId)}</span>
                </button>
              </PopoverTrigger>
              <PopoverContent side="top" align="end" className="w-auto p-0">
                <ModelSelector
                  embedded
                  onClose={() => setModelPopoverOpen(false)}
                />
              </PopoverContent>
            </Popover>
          )}
        </div>
      </footer>

      {/* 编辑器命令面板 Cmd+K：AI / 保存 / 下载等，不占标题栏 */}
      <EditorCommandPalette
        open={showEditorCommandPalette}
        onClose={() => setShowEditorCommandPalette(false)}
        activeFile={activeFile ? { id: activeFile.id, name: activeFile.name, path: activeFile.path, format: activeFile.format } : null}
        selectedText={editorState.selectedText || null}
        isModified={activeFile ? isFileModified(activeFile) : false}
        isSaving={activeFile ? savingFiles.has(activeFile.id) : false}
        onAIAction={handleAIAction}
        onSave={() => activeFile && handleSaveFile(activeFile.id)}
        onDownload={() => activeFile && handleDownloadFile(activeFile)}
        onOpenExternal={() => activeFile && handleOpenExternal(activeFile)}
        onTogglePreview={() => window.dispatchEvent(new CustomEvent('toggle_markdown_preview'))}
      />

      <KeyboardShortcutsHelp open={shortcutsHelpOpen} onOpenChange={setShortcutsHelpOpen} />

      {/* 关闭未保存文件确认（保存 / 不保存 / 取消，对齐 Cursor/VSCode） */}
      <Dialog open={pendingCloseFileId != null} onOpenChange={(open) => { if (!open) setPendingCloseFileId(null); }}>
        <DialogContent className="max-w-sm" onPointerDownOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="text-sm">未保存的更改</DialogTitle>
            <DialogDescription>
              {pendingCloseFileId != null && (() => {
                const file = editorState.openFiles.find((f) => f.id === pendingCloseFileId);
                return file ? `文件 "${file.name}" 有未保存的更改，是否保存？` : "是否保存更改？";
              })()}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => {
                if (pendingCloseFileId == null) return;
                setPendingCloseFileId(null);
              }}
            >
              取消
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (pendingCloseFileId == null) return;
                doCloseFileById(pendingCloseFileId);
                setPendingCloseFileId(null);
              }}
            >
              不保存
            </Button>
            <Button
              onClick={async () => {
                if (pendingCloseFileId == null) return;
                try {
                  await handleSaveFile(pendingCloseFileId);
                } catch {
                  return;
                }
                doCloseFileById(pendingCloseFileId);
                setPendingCloseFileId(null);
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量关闭（关闭其他/右侧）存在未保存文件时的确认 */}
      <AlertDialog open={pendingBatchCloseIds != null} onOpenChange={(open) => { if (!open) setPendingBatchCloseIds(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>关闭未保存的文件</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingBatchCloseIds != null && (() => {
                const modified = editorState.openFiles.filter(f => pendingBatchCloseIds.includes(f.id) && isFileModified(f));
                return modified.length > 0
                  ? `以下 ${modified.length} 个文件有未保存的更改，关闭后将丢失：${modified.map(f => `"${f.name}"`).join('、')}。`
                  : '是否关闭所选文件？';
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingBatchCloseIds == null) return;
                pendingBatchCloseIds.forEach((id) => doCloseFileById(id));
                setPendingBatchCloseIds(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              全部丢弃并关闭
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 从工作区选择文件 → 作为 Composer 附件 */}
      <Dialog open={workspaceFilePickerOpen} onOpenChange={(open) => { if (!open) { workspaceFilePickerCallbackRef.current = null; setWorkspaceFilePickerOpen(false); setWorkspaceFilePickerHighlightedIndex(0); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>选择要加入对话的工作区文件</DialogTitle>
            <DialogDescription>从当前已打开的文件中选一个加入对话上下文，或从本地上传。</DialogDescription>
          </DialogHeader>
          {openFilesForPicker.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 space-y-3">
              <p>暂无已打开的工作区文件。请先在左侧文件树中打开要附加的文件。</p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="gap-2"
                onClick={() => {
                  workspaceFilePickerCallbackRef.current = null;
                  setWorkspaceFilePickerOpen(false);
                  setTimeout(() => {
                    window.dispatchEvent(new CustomEvent(EVENTS.TRIGGER_COMPOSER_FILE_UPLOAD));
                  }, 150);
                }}
              >
                <FileText className="size-4" />
                从本地上传
              </Button>
            </div>
          ) : (
            <div
              ref={workspaceFilePickerListRef}
              tabIndex={0}
              role="listbox"
              aria-label={t("editor.workspaceFileListAria")}
              className="mt-2 max-h-[280px] overflow-y-auto outline-none"
              onKeyDown={(e) => {
                const n = openFilesForPicker.length;
                if (n === 0) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setWorkspaceFilePickerHighlightedIndex((i) => Math.min(i + 1, n - 1));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setWorkspaceFilePickerHighlightedIndex((i) => Math.max(i - 1, 0));
                  return;
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  const item = openFilesForPicker[workspaceFilePickerHighlightedIndex];
                  if (item) handleWorkspaceFilePick(item.path, item.name);
                  return;
                }
              }}
            >
              <ul className="space-y-0.5" role="presentation">
                {openFilesForPicker.map((f, idx) => (
                  <li key={f.id} role="option" aria-selected={idx === workspaceFilePickerHighlightedIndex}>
                    <button
                      type="button"
                      className={cn(
                        "w-full flex items-center gap-2 px-3 py-2 text-left rounded-md transition-colors text-sm focus:outline-none focus:ring-1 focus:ring-ring",
                        idx === workspaceFilePickerHighlightedIndex ? "bg-muted" : "hover:bg-muted/70"
                      )}
                      onClick={() => handleWorkspaceFilePick(f.path, f.name)}
                      onFocus={() => setWorkspaceFilePickerHighlightedIndex(idx)}
                    >
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate flex-1" title={f.path}>{f.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 未保存的 xlsx 另存为到工作区 */}
      <Dialog open={saveAsXlsx != null} onOpenChange={(open) => { if (!open) setSaveAsXlsx(null); }}>
        <DialogContent className="max-w-md" onPointerDownOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>{t('editor.saveAsTitle')}</DialogTitle>
            <DialogDescription>{t('editor.saveAsDescription')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid gap-1.5">
              <label htmlFor="save-as-filename" className="text-sm font-medium">{t('editor.saveAsFilenameLabel')}</label>
              <Input
                id="save-as-filename"
                value={saveAsFilename}
                onChange={(e) => setSaveAsFilename(e.target.value)}
                placeholder={t('editor.saveAsDefaultName')}
                className="font-mono"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t('editor.saveAsWorkspaceHint')}: {(currentWorkspace?.path ?? getCurrentWorkspacePathFromStorage()) || '—'}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSaveAsXlsx(null)} disabled={saveAsSubmitting}>{t('common.cancel')}</Button>
            <Button type="button" onClick={handleSaveAsXlsxConfirm} disabled={saveAsSubmitting}>
              {saveAsSubmitting ? t('viewer.saving') : t('editor.saveAsConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 二进制对比：原 vs 新，接受并覆盖 / 拒绝 */}
      <Dialog open={binaryDiffState != null} onOpenChange={(open) => { if (!open) { setBinaryDiffState(null); setBinaryDiffSaveAsVisible(false); } }}>
        <DialogContent className="max-w-6xl w-[90vw] max-h-[90vh] flex flex-col gap-3" onPointerDownOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>{t('editor.binaryDiffTitle')}</DialogTitle>
            <DialogDescription>{t('editor.binaryDiffDescription')}</DialogDescription>
          </DialogHeader>
          <div className="flex gap-3 flex-1 min-h-0">
            <div className="flex-1 min-w-0 flex flex-col border rounded-lg overflow-hidden bg-muted/20">
              <div className="shrink-0 px-2 py-1.5 text-xs font-medium text-muted-foreground border-b bg-muted/30">
                {t('editor.binaryDiffOriginal')}
              </div>
              <div className="flex-1 min-h-[320px] overflow-hidden">
                {binaryDiffState?.originalBase64 ? (
                  <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">{t('viewer.loadingPreview')}</div>}>
                    <UniversalFileViewer
                      fileName={binaryDiffState.targetPath.replace(/^.*[/\\]/, '')}
                      filePath={binaryDiffState.targetPath}
                      base64Data={binaryDiffState.originalBase64}
                      mimeType={getFileTypeInfo(binaryDiffState.targetPath.replace(/^.*[/\\]/, '')).mimeType}
                      height="100%"
                      embeddedInEditor={true}
                    />
                  </Suspense>
                ) : (
                  <div className="h-full flex items-center justify-center text-sm text-muted-foreground p-4">
                    {t('editor.binaryDiffNoOriginal')}
                  </div>
                )}
              </div>
            </div>
            <div className="flex-1 min-w-0 flex flex-col border rounded-lg overflow-hidden bg-muted/20">
              <div className="shrink-0 px-2 py-1.5 text-xs font-medium text-muted-foreground border-b bg-muted/30">
                {t('editor.binaryDiffNew')}
              </div>
              <div className="flex-1 min-h-[320px] overflow-hidden">
                {binaryDiffState?.newBase64 && (
                  <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">{t('viewer.loadingPreview')}</div>}>
                    <UniversalFileViewer
                      fileName={binaryDiffState.targetPath.replace(/^.*[/\\]/, '')}
                      filePath={binaryDiffState.targetPath}
                      base64Data={binaryDiffState.newBase64}
                      mimeType={getFileTypeInfo(binaryDiffState.targetPath.replace(/^.*[/\\]/, '')).mimeType}
                      height="100%"
                      embeddedInEditor={true}
                    />
                  </Suspense>
                )}
              </div>
            </div>
          </div>
          {binaryDiffSaveAsVisible && (
            <div className="flex items-center gap-2 py-2 px-3 rounded-lg bg-muted/30 border border-border">
              <label htmlFor="binary-diff-save-as-path" className="text-sm shrink-0">{t('editor.saveAsFilenameLabel')}</label>
              <Input
                id="binary-diff-save-as-path"
                value={binaryDiffSaveAsFilename}
                onChange={(e) => setBinaryDiffSaveAsFilename(e.target.value)}
                placeholder={binaryDiffState?.targetPath.replace(/^.*[/\\]/, '') || ''}
                className="font-mono flex-1 min-w-0"
              />
              <Button type="button" size="sm" onClick={handleBinaryDiffSaveAs} disabled={binaryDiffSubmitting}>
                {binaryDiffSubmitting ? t('viewer.saving') : t('editor.saveAsConfirm')}
              </Button>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => { setBinaryDiffState(null); setBinaryDiffSaveAsVisible(false); }} disabled={binaryDiffSubmitting}>
              {t('editor.binaryDiffReject')}
            </Button>
            {!binaryDiffSaveAsVisible ? (
              <Button type="button" variant="outline" onClick={() => setBinaryDiffSaveAsVisible(true)} disabled={binaryDiffSubmitting}>
                {t('editor.saveAsTitle')}
              </Button>
            ) : null}
            <Button type="button" onClick={handleBinaryDiffAccept} disabled={binaryDiffSubmitting}>
              {binaryDiffSubmitting ? t('viewer.saving') : t('editor.binaryDiffAccept')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={refreshConfirmFile != null} onOpenChange={(open) => { if (!open) setRefreshConfirmFile(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认刷新</AlertDialogTitle>
            <AlertDialogDescription>
              {refreshConfirmFile != null
                ? `文件 "${refreshConfirmFile.name}" 已修改，刷新将丢失未保存的更改。是否继续？`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={performRefreshFile}>继续刷新</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});

export default FullEditorV2Enhanced;

