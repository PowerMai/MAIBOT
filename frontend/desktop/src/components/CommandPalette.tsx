/**
 * CommandPalette - 命令面板
 * 
 * Cursor/VSCode 风格的命令面板，支持：
 * - 快速搜索命令
 * - 文件搜索
 * - 设置搜索
 * - 快捷键提示
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Search,
  File,
  Settings,
  Keyboard,
  MessageSquare,
  FolderOpen,
  Code,
  Terminal,
  Play,
  Save,
  Undo,
  Redo,
  Copy,
  Clipboard,
  Trash2,
  Plus,
  RefreshCw,
  Download,
  Upload,
  Eye,
  EyeOff,
  Maximize,
  Minimize,
  X,
  ChevronRight,
  Command,
  Hash,
  AtSign,
  ListTodo,
  Sparkles,
} from 'lucide-react';
import { Dialog, DialogContent } from './ui/dialog';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { Badge } from './ui/badge';
import { cn } from './ui/utils';
import { toast } from 'sonner';
import { getItem as getStorageItem } from '../lib/safeStorage';
import { getShortcutText } from '../lib/hooks/useKeyboardShortcuts';
import { listThreads, getThreadState } from '../lib/api/langserveChat';
import { workspaceAPI } from '../lib/api/workspace';
import { EVENTS } from '../lib/constants';
import { t } from '../lib/i18n';
import { getCurrentThreadIdFromStorage } from '../lib/runSummaryState';
import { useRunSummarySync } from '../lib/hooks/useRunSummarySync';

// 命令类型
type CommandType = 'action' | 'file' | 'setting' | 'navigation';

// 命令接口（可扩展）
export interface Command {
  id: string;
  label: string;
  description?: string;
  icon?: React.ElementType;
  type: CommandType;
  shortcut?: { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean };
  action?: () => void;
  keywords?: string[];
}

// 命令注册表（支持运行时注册）
const commandRegistry: Command[] = [];

/** 注册命令（供扩展使用） */
export function registerCommand(cmd: Command): void {
  if (!commandRegistry.some((c) => c.id === cmd.id)) {
    commandRegistry.push(cmd);
  }
}

/** 获取当前所有命令（内置 + 已注册） */
function getAllCommands(): Command[] {
  return [...builtinCommands, ...commandRegistry];
}

// 预定义命令（内置）
const builtinCommands: Command[] = [
  // 文件操作
  {
    id: 'file.new',
    label: '新建文件',
    icon: Plus,
    type: 'action',
    shortcut: { key: 'n', ctrl: true },
    keywords: ['create', 'new', 'file'],
  },
  {
    id: 'file.open',
    label: '打开文件',
    icon: FolderOpen,
    type: 'action',
    shortcut: { key: 'o', ctrl: true },
    keywords: ['open', 'file'],
  },
  {
    id: 'file.save',
    label: '保存文件',
    icon: Save,
    type: 'action',
    shortcut: { key: 's', ctrl: true },
    keywords: ['save', 'file'],
  },
  {
    id: 'file.saveAll',
    label: '保存所有文件',
    icon: Save,
    type: 'action',
    shortcut: { key: 's', ctrl: true, shift: true },
    keywords: ['save', 'all', 'files'],
  },
  {
    id: 'file.close',
    label: '关闭文件',
    icon: X,
    type: 'action',
    shortcut: { key: 'w', ctrl: true },
    keywords: ['close', 'file', 'tab'],
  },

  // 编辑操作
  {
    id: 'edit.undo',
    label: '撤销',
    icon: Undo,
    type: 'action',
    shortcut: { key: 'z', ctrl: true },
    keywords: ['undo', 'back'],
  },
  {
    id: 'edit.redo',
    label: '重做',
    icon: Redo,
    type: 'action',
    shortcut: { key: 'z', ctrl: true, shift: true },
    keywords: ['redo', 'forward'],
  },
  {
    id: 'edit.copy',
    label: '复制',
    icon: Copy,
    type: 'action',
    shortcut: { key: 'c', ctrl: true },
    keywords: ['copy'],
  },
  {
    id: 'edit.paste',
    label: '粘贴',
    icon: Clipboard,
    type: 'action',
    shortcut: { key: 'v', ctrl: true },
    keywords: ['paste'],
  },
  {
    id: 'edit.find',
    label: '查找',
    icon: Search,
    type: 'action',
    shortcut: { key: 'f', ctrl: true },
    keywords: ['find', 'search'],
  },
  {
    id: 'edit.replace',
    label: '替换',
    icon: RefreshCw,
    type: 'action',
    shortcut: { key: 'h', ctrl: true },
    keywords: ['replace'],
  },

  // 视图操作
  {
    id: 'view.sidebar',
    label: '切换侧边栏',
    icon: Eye,
    type: 'action',
    shortcut: { key: 'b', ctrl: true },
    keywords: ['sidebar', 'toggle', 'panel'],
  },
  {
    id: 'view.terminal',
    label: '切换终端',
    icon: Terminal,
    type: 'action',
    shortcut: { key: '`', ctrl: true },
    keywords: ['terminal', 'console'],
  },
  {
    id: 'view.fullscreen',
    label: '全屏',
    icon: Maximize,
    type: 'action',
    shortcut: { key: 'F11' },
    keywords: ['fullscreen', 'maximize'],
  },

  // 对话操作
  {
    id: 'chat.new',
    label: '新建对话',
    icon: MessageSquare,
    type: 'action',
    shortcut: { key: 'o', ctrl: true, shift: true },
    keywords: ['new', 'chat', 'conversation'],
  },
  {
    id: 'chat.focus',
    label: '聚焦到对话输入',
    icon: MessageSquare,
    type: 'action',
    shortcut: { key: 'l', ctrl: true },
    keywords: ['focus', 'chat', 'input'],
  },
  {
    id: 'chat.stop',
    label: '停止生成',
    icon: X,
    type: 'action',
    shortcut: { key: 'Escape' },
    keywords: ['stop', 'cancel', 'generation'],
  },

  // 导航
  {
    id: 'nav.goToLine',
    label: '跳转到行',
    icon: Hash,
    type: 'navigation',
    shortcut: { key: 'g', ctrl: true },
    keywords: ['go', 'line', 'jump'],
  },
  {
    id: 'nav.goToFile',
    label: '快速打开文件',
    icon: File,
    type: 'navigation',
    shortcut: { key: 'p', ctrl: true },
    keywords: ['quick', 'open', 'file'],
  },
  {
    id: 'nav.goToSymbol',
    label: '跳转到符号',
    icon: AtSign,
    type: 'navigation',
    shortcut: { key: 'o', ctrl: true, shift: true },
    keywords: ['symbol', 'function', 'class'],
  },

  // 知识库
  {
    id: 'knowledge.open',
    label: '打开知识库',
    icon: FolderOpen,
    type: 'action',
    keywords: ['knowledge', 'kb', '知识库', '知识', 'library'],
  },
  // 任务面板
  {
    id: 'open-task-panel',
    label: '打开任务面板',
    icon: ListTodo,
    type: 'action',
    shortcut: { key: 't', ctrl: true, shift: true },
    keywords: ['task', '任务', '看板', 'panel', 'board'],
  },
  {
    id: 'open-collab-center',
    label: '打开协作中心',
    icon: ListTodo,
    type: 'action',
    keywords: ['collab', '协作', '中心', '任务链路', 'checkpoint'],
  },
  {
    id: 'recovery.retry',
    label: '恢复：从恢复点继续',
    icon: RefreshCw,
    type: 'action',
    keywords: ['recovery', 'resume', 'retry', '失败恢复', '断点续跑'],
  },
  {
    id: 'recovery.ask_diagnose',
    label: t('runTracker.recoveryAskDiagnoseLabel'),
    icon: MessageSquare,
    type: 'action',
    keywords: ['recovery', 'diagnose', 'ask', '诊断', '恢复'],
  },
  {
    id: 'recovery.open_task',
    label: '恢复：打开关联任务',
    icon: ListTodo,
    type: 'action',
    keywords: ['recovery', 'task', '关联任务', '恢复'],
  },
  {
    id: 'recovery.open_thread',
    label: '恢复：回到关联对话',
    icon: MessageSquare,
    type: 'action',
    keywords: ['recovery', 'thread', '关联对话', '恢复'],
  },
  {
    id: 'search.threads',
    label: '搜索对话',
    icon: Search,
    type: 'action',
    keywords: ['search', 'thread', '对话', '会话', '全文'],
  },
  {
    id: 'view.focus_mode',
    label: '切换专注态',
    icon: EyeOff,
    type: 'action',
    keywords: ['focus', '专注态', '信息密度', 'layout'],
  },

  // 设置
  {
    id: 'settings.open',
    label: '打开设置',
    icon: Settings,
    type: 'setting',
    shortcut: { key: ',', ctrl: true },
    keywords: ['settings', 'preferences', 'config'],
  },
  {
    id: 'settings.agent_profile',
    label: '进化设置',
    icon: Sparkles,
    type: 'setting',
    keywords: ['evolution', 'agent', 'profile', '自我进化', '进化', '档案'],
  },
  {
    id: 'settings.keyboard',
    label: '键盘快捷键',
    icon: Keyboard,
    type: 'setting',
    shortcut: { key: 'k', ctrl: true, shift: true },
    keywords: ['keyboard', 'shortcuts', 'keybindings'],
  },
  {
    id: 'open-bid-wizard',
    label: '打开招投标向导',
    description: '投标方案多步骤向导；执行前确认在聊天区展示',
    icon: Sparkles,
    type: 'action',
    keywords: ['招投标', '向导', '投标', 'bidding', 'wizard'],
  },

  // 运行
  {
    id: 'run.code',
    label: '运行代码',
    icon: Play,
    type: 'action',
    shortcut: { key: 'F5' },
    keywords: ['run', 'execute', 'code'],
  },
];

const COMMAND_STATIC_DISABLED_REASON: Record<string, string> = {
  'edit.undo': '当前版本未接入统一撤销命令执行器',
  'edit.redo': '当前版本未接入统一重做命令执行器',
  'edit.copy': '当前版本未接入统一复制命令执行器',
  'edit.paste': '当前版本未接入统一粘贴命令执行器',
  'edit.find': '当前版本未接入统一查找命令执行器',
  'edit.replace': '当前版本未接入统一替换命令执行器',
  'view.terminal': '当前版本未集成终端面板',
  'view.fullscreen': '当前版本未接入全屏切换命令',
  'nav.goToLine': '当前版本未接入跳行命令',
  'nav.goToSymbol': '当前版本未接入符号导航命令',
  'run.code': '当前版本未接入一键运行代码命令',
};

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCommand?: (
    commandId: string,
    payload?: { type: 'command' | 'thread' | 'file'; threadId?: string; filePath?: string }
  ) => void;
}

type SearchResult =
  | { kind: 'command'; command: Command }
  | { kind: 'thread'; threadId: string; title: string; subtitle?: string }
  | { kind: 'file'; filePath: string; title: string; subtitle?: string };

type SearchKind = SearchResult['kind'];
type RecentMap = Record<string, number>;
const RECENT_SEARCH_KEY = 'maibot_global_search_recent';

function loadRecentMap(): RecentMap {
  try {
    const raw = localStorage.getItem(RECENT_SEARCH_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveRecentMap(map: RecentMap) {
  localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(map));
}

function recentBoost(map: RecentMap, key: string): number {
  const ts = Number(map[key] ?? 0);
  if (!ts) return 0;
  const ageMs = Date.now() - ts;
  const decay = Math.max(0, 1 - ageMs / (7 * 24 * 3600 * 1000));
  return Math.round(36 * decay);
}

function isRecentlyUsed(map: RecentMap, key: string): boolean {
  const ts = Number(map[key] ?? 0);
  if (!ts) return false;
  return Date.now() - ts < 72 * 3600 * 1000;
}

function formatRelativeTime(input?: string): string {
  if (!input) return '未知时间';
  const ts = new Date(input).getTime();
  if (!Number.isFinite(ts)) return '未知时间';
  const delta = Date.now() - ts;
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))} 分钟前`;
  if (delta < 86_400_000) return `${Math.max(1, Math.floor(delta / 3_600_000))} 小时前`;
  if (delta < 7 * 86_400_000) return `${Math.max(1, Math.floor(delta / 86_400_000))} 天前`;
  return new Date(ts).toLocaleDateString();
}

function compactPath(path: string): string {
  const normalized = String(path || '').replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 4) return normalized;
  return `…/${parts.slice(-4).join('/')}`;
}

function highlightMatch(text: string, keyword: string): React.ReactNode {
  const q = keyword.trim();
  if (!q) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    const re = new RegExp(`(${escaped})`, 'ig');
    const parts = text.split(re);
    return parts.map((part, idx) =>
      idx % 2 === 1 ? (
        <mark key={`${part}-${idx}`} className="rounded bg-primary/20 px-0.5 text-current">
          {part}
        </mark>
      ) : (
        part
      )
    );
  } catch {
    return text;
  }
}

function getMatchScore(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  if (t === q) return 120;
  if (t.startsWith(q)) return 90;
  if (t.includes(` ${q}`)) return 70;
  if (t.includes(q)) return 50;
  return 0;
}

export function CommandPalette({ open, onOpenChange, onCommand }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const threadCacheRef = useRef<{ ts: number; items: Array<{ id: string; title: string; updatedAt: string }> }>({
    ts: 0,
    items: [],
  });
  const fileCacheRef = useRef<{ ts: number; workspaceId: string; entries: Array<{ path: string; name: string }> }>({
    ts: 0,
    workspaceId: '',
    entries: [],
  });
  const [recentMap, setRecentMap] = useState<RecentMap>(() => loadRecentMap());
  const [threadResults, setThreadResults] = useState<Array<{ id: string; title: string; subtitle?: string }>>([]);
  const [fileResults, setFileResults] = useState<Array<{ path: string; title: string; subtitle?: string }>>([]);
  const [threadSearching, setThreadSearching] = useState(false);
  const [fileSearching, setFileSearching] = useState(false);
  const [recoveryContext, setRecoveryContext] = useState<{
    lastError?: string;
    linkedTaskId?: string;
    linkedThreadId?: string;
  } | null>(null);

  // 前缀模式：">" 为命令模式（VSCode 风格），无前缀时也显示命令列表
  const searchQuery = query.startsWith('>') ? query.slice(1).trim() : query.trim();
  const isCommandMode = query.startsWith('>');
  const shouldSearchEntities = !isCommandMode && searchQuery.trim().length >= 2;

  // 过滤命令（模糊：每个词都需在 label/keywords/description 中出现，不区分顺序）
  const filteredCommands = useMemo(() => {
    const commands = getAllCommands();
    if (!searchQuery) {
      const hasError = Boolean(String(recoveryContext?.lastError || '').trim());
      if (!hasError) return commands;
      const priorityMap: Record<string, number> = {
        'recovery.ask_diagnose': 100,
        'recovery.retry': 99,
        'recovery.open_task': 98,
        'recovery.open_thread': 97,
      };
      return [...commands].sort((a, b) => (priorityMap[b.id] || 0) - (priorityMap[a.id] || 0));
    }

    const lowerQuery = searchQuery.toLowerCase();
    const terms = lowerQuery.split(/\s+/).filter(Boolean);
    return commands
      .map((cmd) => {
        const labelLower = cmd.label.toLowerCase();
        const descLower = (cmd.description ?? "").toLowerCase();
        const keywordStr = (cmd.keywords ?? []).join(" ").toLowerCase();
        const searchable = `${labelLower} ${descLower} ${keywordStr}`;
        const matched = terms.every(term => searchable.includes(term));
        if (!matched) return null;
        const score =
          getMatchScore(labelLower, lowerQuery) * 2 +
          getMatchScore(keywordStr, lowerQuery) +
          recentBoost(recentMap, `command:${cmd.id}`);
        return { cmd, score };
      })
      .filter((row): row is { cmd: Command; score: number } => row != null)
      .sort((a, b) => b.score - a.score)
      .map((row) => row.cmd);
  }, [searchQuery, recentMap, recoveryContext]);

  // 搜索会话（标题命中 + 轻量消息兜底）
  useEffect(() => {
    if (!open) return;
    if (isCommandMode) {
      setThreadResults([]);
      setThreadSearching(false);
      return;
    }
    if (!shouldSearchEntities) {
      setThreadResults([]);
      setThreadSearching(false);
      return;
    }
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      setThreadResults([]);
      setThreadSearching(false);
      return;
    }
    let cancelled = false;
    setThreadSearching(true);
    const timer = window.setTimeout(() => {
      const now = Date.now();
      const cacheFresh = now - threadCacheRef.current.ts < 20_000;
      const loadThreads = cacheFresh
        ? Promise.resolve(threadCacheRef.current.items)
        : listThreads({ limit: 120 }).then((list) => {
            const items = Array.isArray(list)
              ? list
                  .map((t: any) => {
                    const id = String(t.thread_id ?? t.id ?? '');
                    const title = String(t.metadata?.title ?? t.title ?? id.slice(0, 8) ?? '未命名对话');
                    const updatedAt = String(t.updated_at ?? t.updatedAt ?? t.created_at ?? t.createdAt ?? '');
                    return { id, title, updatedAt };
                  })
                  .filter((t) => !!t.id)
              : [];
            threadCacheRef.current = { ts: Date.now(), items };
            return items;
          });
      loadThreads
        .then(async (items) => {
          if (cancelled) return;
          const titleMatches = items.filter((t) => t.title.toLowerCase().includes(q));
          let merged = titleMatches;
          if (titleMatches.length < 8) {
            const candidates = items.slice(0, 15);
            const contentMatched: Array<{ id: string; title: string; updatedAt: string }> = [];
            await Promise.all(
              candidates.map(async (item) => {
                try {
                  const state = await getThreadState(item.id);
                  const values = state?.values as { messages?: unknown[] } | undefined;
                  const messages = Array.isArray(values?.messages) ? values.messages : [];
                  const hit = messages.some((m: any) => String(m?.content ?? '').toLowerCase().includes(q));
                  if (hit) contentMatched.push(item);
                } catch {
                  // ignore single-thread failure
                }
              })
            );
            merged = [...titleMatches, ...contentMatched].filter(
              (v, idx, arr) => arr.findIndex((x) => x.id === v.id) === idx
            );
          }

          const ranked = merged
            .map((item) => ({
              ...item,
              score:
                getMatchScore(item.title, q) * 2 +
                getMatchScore(item.id, q) +
                recentBoost(recentMap, `thread:${item.id}`),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 12);

          setThreadResults(
            ranked.map((item) => ({
              id: item.id,
              title: item.title,
              subtitle: `会话 · ${formatRelativeTime((item as { updatedAt?: string }).updatedAt)} · ${item.id.slice(0, 8)}`,
            }))
          );
        })
        .catch(() => {
          setThreadResults([]);
          if (!cancelled) toast.error(t("commandPalette.threadSearchError"));
        })
        .finally(() => {
          if (!cancelled) setThreadSearching(false);
        });
    }, 240);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, searchQuery, recentMap, isCommandMode, shouldSearchEntities]);

  // 搜索文件（当前工作区）
  useEffect(() => {
    if (!open) return;
    if (isCommandMode) {
      setFileResults([]);
      setFileSearching(false);
      return;
    }
    if (!shouldSearchEntities) {
      setFileResults([]);
      setFileSearching(false);
      return;
    }
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      setFileResults([]);
      setFileSearching(false);
      return;
    }
    let cancelled = false;
    setFileSearching(true);
    const timer = window.setTimeout(() => {
      const workspaceId = getStorageItem('activeWorkspaceId') || '';
      if (!workspaceId) {
        setFileResults([]);
        setFileSearching(false);
        return;
      }
      const now = Date.now();
      const cacheFresh = now - fileCacheRef.current.ts < 30_000 && fileCacheRef.current.workspaceId === workspaceId;
      const loadFiles = cacheFresh
        ? Promise.resolve(fileCacheRef.current.entries)
        : workspaceAPI.listFiles(workspaceId, '.', true).then((entries) => {
            const next = (Array.isArray(entries) ? entries : [])
              .filter((f) => !f.is_dir)
              .map((f) => ({ path: String(f.path), name: String(f.name) }));
            fileCacheRef.current = { ts: Date.now(), workspaceId, entries: next };
            return next;
          });
      loadFiles
        .then((entries) => {
          if (cancelled) return;
          const rows = (Array.isArray(entries) ? entries : [])
            .filter((f) => {
              const haystack = `${f.name} ${f.path}`.toLowerCase();
              return haystack.includes(q);
            })
            .map((f) => ({
              ...f,
              score:
                getMatchScore(f.name, q) * 2 +
                getMatchScore(f.path, q) -
                Math.min(20, f.path.length / 30) +
                recentBoost(recentMap, `file:${f.path}`),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 20)
            .map((f) => ({ path: f.path, title: f.name, subtitle: compactPath(f.path) }));
          setFileResults(rows);
        })
        .catch(() => {
          setFileResults([]);
          if (!cancelled) toast.error(t("commandPalette.fileSearchError"));
        })
        .finally(() => {
          if (!cancelled) setFileSearching(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, searchQuery, recentMap, isCommandMode, shouldSearchEntities]);

  const results = useMemo<SearchResult[]>(() => {
    const commandResults: SearchResult[] = filteredCommands.map((command) => ({ kind: 'command', command }));
    if (!searchQuery.trim() || isCommandMode) return commandResults;
    const threadRows: SearchResult[] = threadResults.map((t) => ({
      kind: 'thread',
      threadId: t.id,
      title: t.title,
      subtitle: t.subtitle,
    }));
    const fileRows: SearchResult[] = fileResults.map((f) => ({
      kind: 'file',
      filePath: f.path,
      title: f.title,
      subtitle: f.subtitle,
    }));
    return [...commandResults, ...threadRows, ...fileRows];
  }, [filteredCommands, searchQuery, isCommandMode, threadResults, fileResults]);

  const groupedRows = useMemo<Array<{ type: 'header'; label: string } | { type: 'result'; item: SearchResult; index: number }>>(() => {
    const rows: Array<{ type: 'header'; label: string } | { type: 'result'; item: SearchResult; index: number }> = [];
    let lastKind: SearchResult['kind'] | null = null;
    const kindLabel: Record<SearchResult['kind'], string> = {
      command: '命令',
      thread: '会话',
      file: '文件',
    };
    for (let index = 0; index < results.length; index++) {
      const item = results[index];
      if (item.kind !== lastKind) {
        rows.push({ type: 'header', label: kindLabel[item.kind] });
        lastKind = item.kind;
      }
      rows.push({ type: 'result', item, index });
    }
    return rows;
  }, [results]);

  const commandDisabledReason = useMemo(() => {
    const linkedTaskId = String(recoveryContext?.linkedTaskId || '').trim();
    const linkedThreadId = String(recoveryContext?.linkedThreadId || '').trim();
    const hasError = Boolean(String(recoveryContext?.lastError || '').trim());
    return {
      ...COMMAND_STATIC_DISABLED_REASON,
      'recovery.retry': linkedThreadId ? '' : '暂无可恢复的关联对话',
      'recovery.ask_diagnose': linkedThreadId && hasError ? '' : '需要最近失败且存在关联对话',
      'recovery.open_task': linkedTaskId ? '' : '暂无可恢复的关联任务',
      'recovery.open_thread': linkedThreadId ? '' : '暂无可恢复的关联对话',
    } as Record<string, string>;
  }, [recoveryContext]);

  const commandDynamicDescription = useMemo(() => {
    const errorSnippet = String(recoveryContext?.lastError || '').trim().slice(0, 48);
    const taskBrief = String(recoveryContext?.linkedTaskId || '').trim();
    const threadBrief = String(recoveryContext?.linkedThreadId || '').trim();
    const taskSuffix = taskBrief ? `任务 ${taskBrief.slice(0, 8)}` : '';
    const threadSuffix = threadBrief ? `会话 ${threadBrief.slice(0, 8)}` : '';
    const scopeSuffix = [taskSuffix, threadSuffix].filter(Boolean).join(' · ');
    return {
      'recovery.retry': commandDisabledReason['recovery.retry']
        ? `不可用：${commandDisabledReason['recovery.retry']}`
        : `按最近失败上下文重试${scopeSuffix ? `（${scopeSuffix}）` : ''}`,
      'recovery.ask_diagnose': commandDisabledReason['recovery.ask_diagnose']
        ? `不可用：${commandDisabledReason['recovery.ask_diagnose']}`
        : `先诊断再给方案${errorSnippet ? ` · ${errorSnippet}${String(recoveryContext?.lastError || '').length > 48 ? '…' : ''}` : ''}`,
      'recovery.open_task': commandDisabledReason['recovery.open_task']
        ? `不可用：${commandDisabledReason['recovery.open_task']}`
        : `打开关联任务详情${taskBrief ? ` · ${taskBrief.slice(0, 12)}` : ''}`,
      'recovery.open_thread': commandDisabledReason['recovery.open_thread']
        ? `不可用：${commandDisabledReason['recovery.open_thread']}`
        : `返回关联对话并聚焦输入${threadBrief ? ` · ${threadBrief.slice(0, 12)}` : ''}`,
    } as Record<string, string>;
  }, [commandDisabledReason, recoveryContext]);

  const commandImpactHints = useMemo(() => {
    return {
      'recovery.retry': { eta: '~10秒', gain: '快速恢复流程' },
      'recovery.ask_diagnose': { eta: '~30秒', gain: '降低重复试错' },
      'recovery.open_task': { eta: '~20秒', gain: '提升复盘质量' },
      'recovery.open_thread': { eta: '~8秒', gain: '回到执行上下文' },
    } as Record<string, { eta: string; gain: string }>;
  }, []);

  const recommendedRecoveryCommandId = useMemo(() => {
    const hasError = Boolean(String(recoveryContext?.lastError || '').trim());
    const hasThread = Boolean(String(recoveryContext?.linkedThreadId || '').trim());
    const hasTask = Boolean(String(recoveryContext?.linkedTaskId || '').trim());
    if (!hasError) return '';
    if (hasThread) return 'recovery.ask_diagnose';
    if (hasTask) return 'recovery.open_task';
    return 'recovery.retry';
  }, [recoveryContext]);

  const kindFirstIndex = useMemo<Partial<Record<SearchKind, number>>>(
    () =>
      results.reduce<Partial<Record<SearchKind, number>>>((acc, item, idx) => {
        if (acc[item.kind] == null) acc[item.kind] = idx;
        return acc;
      }, {}),
    [results]
  );

  // 重置选中索引
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery, results.length]);

  // 打开时聚焦输入框，默认进入全局搜索
  useEffect(() => {
    let focusTimer: ReturnType<typeof setTimeout> | null = null;
    if (open) {
      setRecentMap(loadRecentMap());
      setQuery('');
      setSelectedIndex(0);
      focusTimer = setTimeout(() => inputRef.current?.focus(), 0);
    }
    return () => {
      if (focusTimer) clearTimeout(focusTimer);
    };
  }, [open]);

  useRunSummarySync((norm) => {
    setRecoveryContext(
      norm
        ? {
            lastError: norm.lastError?.trim() || undefined,
            linkedTaskId: norm.linkedTaskId,
            linkedThreadId: norm.linkedThreadId,
          }
        : null
    );
  }, { listenStorage: true });

  const markRecent = useCallback((kind: SearchKind | 'command', id: string) => {
    setRecentMap((prev) => {
      const now = Date.now();
      const next: RecentMap = { ...prev, [`${kind}:${id}`]: now };
      const entries = Object.entries(next).sort((a, b) => b[1] - a[1]).slice(0, 200);
      const compact = Object.fromEntries(entries) as RecentMap;
      saveRecentMap(compact);
      return compact;
    });
  }, []);

  // 处理键盘导航
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.key === 'Process') return;
    switch (e.key) {
      case 'Home':
        e.preventDefault();
        if (results.length > 0) setSelectedIndex(0);
        break;
      case 'End':
        e.preventDefault();
        if (results.length > 0) setSelectedIndex(results.length - 1);
        break;
      case 'PageDown':
        e.preventDefault();
        if (results.length > 0) {
          setSelectedIndex((i) => Math.min(results.length - 1, i + 5));
        }
        break;
      case 'PageUp':
        e.preventDefault();
        if (results.length > 0) {
          setSelectedIndex((i) => Math.max(0, i - 5));
        }
        break;
      case 'Tab': {
        e.preventDefault();
        if (results.length === 0) break;
        const order: SearchKind[] = ['command', 'thread', 'file'];
        const currentKind = results[selectedIndex]?.kind ?? results[0]?.kind;
        const currentPos = Math.max(0, order.indexOf(currentKind));
        const direction = e.shiftKey ? -1 : 1;
        for (let step = 1; step <= order.length; step++) {
          const idx = (currentPos + direction * step + order.length) % order.length;
          const nextKind = order[idx];
          const first = kindFirstIndex[nextKind];
          if (typeof first === 'number') {
            setSelectedIndex(first);
            break;
          }
        }
        break;
      }
      case 'ArrowDown':
        e.preventDefault();
        if (results.length > 0) {
          setSelectedIndex((i) => (i + 1) % results.length);
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (results.length > 0) {
          setSelectedIndex((i) => (i - 1 + results.length) % results.length);
        }
        break;
      case 'Enter':
        e.preventDefault();
        if (results[selectedIndex]) {
          executeResult(results[selectedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        onOpenChange(false);
        break;
    }
  }, [results, selectedIndex, onOpenChange, kindFirstIndex]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || results.length === 0) return;
    const active = list.querySelector<HTMLElement>(`[data-result-index="${selectedIndex}"]`);
    active?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, [selectedIndex, results.length]);

  // 执行命令
  const executeCommand = (cmd: Command) => {
    const reason = commandDisabledReason[cmd.id];
    if (reason) {
      toast.info(reason);
      onOpenChange(false);
      return;
    }
    onOpenChange(false);
    markRecent('command', cmd.id);
    if (cmd.action) {
      cmd.action();
    }
    onCommand?.(cmd.id, { type: 'command' });
  };

  const executeResult = (result: SearchResult) => {
    if (result.kind === 'command') {
      executeCommand(result.command);
      return;
    }
    onOpenChange(false);
    if (result.kind === 'thread') {
      markRecent('thread', result.threadId);
      onCommand?.('search.switch-thread', { type: 'thread', threadId: result.threadId });
      return;
    }
    markRecent('file', result.filePath);
    onCommand?.('search.open-file', { type: 'file', filePath: result.filePath });
  };

  // 获取命令类型图标
  const getTypeIcon = (type: CommandType) => {
    switch (type) {
      case 'file':
        return File;
      case 'setting':
        return Settings;
      case 'navigation':
        return ChevronRight;
      default:
        return Command;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl p-0 gap-0 overflow-hidden" aria-label={t("commandPalette.dialogAria")} aria-describedby="command-palette-list">
        {/* 搜索框 */}
        <div className="flex items-center border-b px-3">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isCommandMode ? t("commandPalette.placeholderCommandMode") : t("commandPalette.placeholder")}
            className="border-0 focus-visible:ring-0 h-12"
            aria-label={t("commandPalette.searchAria")}
            aria-controls="command-palette-list"
            aria-activedescendant={results.length > 0 ? `command-palette-option-${selectedIndex}` : undefined}
          />
          <Badge variant="outline" className="shrink-0">
            ⇧⌘P
          </Badge>
        </div>
        {/* 结果列表 - 无障碍：listbox + option + aria-selected */}
        <ScrollArea className="max-h-[400px]">
          <div id="command-palette-list" role="listbox" aria-label={t("commandPalette.listAria")} className="p-2" ref={listRef}>
            {results.length > 0 ? (
              groupedRows.map((rowEntry) => {
                if (rowEntry.type === 'header') {
                  return (
                    <div
                      key={`header:${rowEntry.label}`}
                      className="sticky top-0 z-10 -mx-2 mb-0.5 border-y border-border/40 bg-background/85 px-5 py-1.5 text-[11px] font-medium text-muted-foreground/80 backdrop-blur-sm"
                    >
                      {rowEntry.label}
                    </div>
                  );
                }
                const row = rowEntry.item;
                const index = rowEntry.index;
                const isSelected = index === selectedIndex;
                const Icon =
                  row.kind === 'command'
                    ? row.command.icon || getTypeIcon(row.command.type)
                    : row.kind === 'thread'
                      ? MessageSquare
                      : File;
                const title =
                  row.kind === 'command'
                    ? row.command.label
                    : row.title;
                const desc =
                  row.kind === 'command'
                    ? (commandDynamicDescription[row.command.id] || row.command.description)
                    : row.subtitle;
                const shortcut = row.kind === 'command' ? row.command.shortcut : undefined;
                const rightBadge =
                  row.kind === 'thread' ? '会话' : row.kind === 'file' ? '文件' : null;
                const key =
                  row.kind === 'command'
                    ? row.command.id
                    : row.kind === 'thread'
                      ? `thread:${row.threadId}`
                      : `file:${row.filePath}`;
                const recentKey =
                  row.kind === 'command'
                    ? `command:${row.command.id}`
                    : row.kind === 'thread'
                      ? `thread:${row.threadId}`
                      : `file:${row.filePath}`;
                const recentlyUsed = isRecentlyUsed(recentMap, recentKey);
                const disabledReason = row.kind === 'command' ? (commandDisabledReason[row.command.id] || '') : '';
                const isDisabled = Boolean(disabledReason);
                const impactHint = row.kind === 'command' ? commandImpactHints[row.command.id] : undefined;
                const isRecommended = row.kind === 'command' && row.command.id === recommendedRecoveryCommandId;

                return (
                  <button
                    key={key}
                    id={`command-palette-option-${index}`}
                    data-result-index={index}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => executeResult(row)}
                    onMouseEnter={() => setSelectedIndex(index)}
                    disabled={isDisabled}
                    title={isDisabled ? disabledReason : undefined}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30",
                      isSelected ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                      isDisabled && "opacity-55 cursor-not-allowed hover:bg-transparent"
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <div className="flex-1 text-left">
                      <div className="font-medium">{highlightMatch(title, searchQuery)}</div>
                      {desc && (
                        <div className={cn(
                          "text-xs",
                          isSelected ? "text-primary-foreground/70" : "text-muted-foreground"
                        )}>
                          {highlightMatch(desc, searchQuery)}
                        </div>
                      )}
                      {impactHint && !isDisabled && (
                        <div className={cn(
                          "mt-1 inline-flex items-center gap-1.5 text-[10px]",
                          isSelected ? "text-primary-foreground/75" : "text-muted-foreground/80"
                        )}>
                          <span>预估 {impactHint.eta}</span>
                          <span>收益 {impactHint.gain}</span>
                        </div>
                      )}
                    </div>
                    {shortcut && (
                      <Badge
                        variant={isSelected ? "secondary" : "outline"}
                        className="shrink-0 font-mono text-xs"
                      >
                        {getShortcutText(shortcut)}
                      </Badge>
                    )}
                    {recentlyUsed && (
                      <Badge
                        variant={isSelected ? "secondary" : "outline"}
                        className="shrink-0 text-[11px] text-muted-foreground/80 border-border/50"
                      >
                        最近
                      </Badge>
                    )}
                    {!shortcut && rightBadge && (
                      <Badge variant={isSelected ? "secondary" : "outline"} className="shrink-0 text-[11px]">
                        {rightBadge}
                      </Badge>
                    )}
                    {isDisabled && (
                      <Badge variant={isSelected ? "secondary" : "outline"} className="shrink-0 text-[11px]">
                        {t("commandPalette.unavailable")}
                      </Badge>
                    )}
                    {isRecommended && !isDisabled && (
                      <Badge variant={isSelected ? "secondary" : "outline"} className="shrink-0 text-[11px]">
                        {t("commandPalette.recommended")}
                      </Badge>
                    )}
                  </button>
                );
              })
            ) : (
              <div className="text-center text-muted-foreground py-8">
                <Search className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>{isCommandMode ? t('commandPalette.noMatchCommand') : t('commandPalette.noMatchResult')}</p>
                <div className="mt-1 text-[11px] text-muted-foreground/80">
                  {isCommandMode
                    ? t('commandPalette.hintCommandMode')
                    : shouldSearchEntities
                      ? t('commandPalette.hintGlobalSearch')
                      : t('commandPalette.hintMinChars')}
                </div>
                <div className="mt-3 flex items-center justify-center gap-2 text-[11px] flex-wrap px-4">
                  {isCommandMode ? (
                    <>
                      <button
                        type="button"
                        className="rounded border border-border/50 px-2 py-1 hover:bg-muted/50 transition-all duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
                        onClick={() => setQuery('')}
                      >
                        切回全局搜索
                      </button>
                      <button
                        type="button"
                        className="rounded border border-border/50 px-2 py-1 hover:bg-muted/50 transition-all duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
                        onClick={() => {
                          onOpenChange(false);
                          onCommand?.('settings.open', { type: 'command' });
                        }}
                      >
                        打开设置
                      </button>
                      <button
                        type="button"
                        className="rounded border border-border/50 px-2 py-1 hover:bg-muted/50 transition-all duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
                        onClick={() => {
                          onOpenChange(false);
                          onCommand?.('settings.agent_profile', { type: 'command' });
                        }}
                      >
                        进化设置
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="rounded border border-border/50 px-2 py-1 hover:bg-muted/50 transition-all duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
                        onClick={() => {
                          onOpenChange(false);
                          onCommand?.('chat.new', { type: 'command' });
                        }}
                      >
                        新建对话
                      </button>
                      <button
                        type="button"
                        className="rounded border border-border/50 px-2 py-1 hover:bg-muted/50 transition-all duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
                        onClick={() => {
                          onOpenChange(false);
                          onCommand?.('open-task-panel', { type: 'command' });
                        }}
                      >
                        任务面板
                      </button>
                      <button
                        type="button"
                        className="rounded border border-border/50 px-2 py-1 hover:bg-muted/50 transition-all duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
                        onClick={() => {
                          onOpenChange(false);
                          onCommand?.('chat.focus', { type: 'command' });
                        }}
                      >
                        聚焦输入
                      </button>
                      <button
                        type="button"
                        className="rounded border border-border/50 px-2 py-1 hover:bg-muted/50 transition-all duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
                        onClick={() => {
                          onOpenChange(false);
                          onCommand?.('settings.open', { type: 'command' });
                        }}
                      >
                        打开设置
                      </button>
                      <button
                        type="button"
                        className="rounded border border-border/50 px-2 py-1 hover:bg-muted/50 transition-all duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
                        onClick={() => {
                          onOpenChange(false);
                          onCommand?.('settings.agent_profile', { type: 'command' });
                        }}
                      >
                        进化设置
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* 底部提示 */}
        <div className="border-t px-3 py-2 flex items-center justify-between text-[11px] text-muted-foreground">
          <div className="flex items-center gap-4">
            <span>↑↓ 导航</span>
            <span>Home/End 首尾</span>
            <span>PgUp/PgDn 翻页</span>
            <span>Tab/Shift+Tab 分组跳转</span>
            <span>↵ 执行</span>
            <span>Esc 关闭</span>
            <span>⌘K 编辑器命令</span>
            {isCommandMode && <span className="text-primary/80">命令模式</span>}
            {!isCommandMode && !shouldSearchEntities && <span className="text-primary/80">输入 2+ 字符搜索文件/会话</span>}
            {(threadSearching || fileSearching) && <span className="text-primary/80">检索中</span>}
          </div>
          <span>{results.length} 条结果</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default CommandPalette;
