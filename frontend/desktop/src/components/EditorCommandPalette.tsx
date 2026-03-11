/**
 * EditorCommandPalette - 编辑器内 Cmd+K 命令面板
 *
 * Cursor 风格：浮动在编辑区中央，根据当前文件类型和选中状态展示 AI / 文件 / 视图 等命令。
 * 不占用标题栏面积，通过快捷键调出。
 */

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Save,
  Download,
  ExternalLink,
  Sparkles,
  Languages,
  FileText,
  Maximize,
  Search,
  Type,
  FileCode,
  Eye,
} from 'lucide-react';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { cn } from './ui/utils';

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-primary/20 text-primary rounded-sm">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export type EditorAIAction = 'expand' | 'rewrite' | 'fix' | 'explain' | 'translate' | 'summary';

export interface OpenFileForPalette {
  id: string;
  name: string;
  path: string;
  format: string;
  content?: string;
}

export interface EditorCommandPaletteProps {
  open: boolean;
  onClose: () => void;
  activeFile: OpenFileForPalette | null;
  selectedText: string | null;
  isModified?: boolean;
  isSaving?: boolean;
  onAIAction: (action: EditorAIAction, text: string) => void;
  onSave: () => void;
  onDownload: () => void;
  onOpenExternal: () => void;
  onTogglePreview?: () => void;
}

interface CommandItem {
  id: string;
  label: string;
  description?: string;
  icon: React.ElementType;
  category: 'ai-text' | 'ai-media' | 'file' | 'view' | 'edit';
  keywords: string[];
  run: () => void;
  disabled?: boolean;
}

export function EditorCommandPalette({
  open,
  onClose,
  activeFile,
  selectedText,
  isModified = false,
  isSaving = false,
  onAIAction,
  onSave,
  onDownload,
  onOpenExternal,
  onTogglePreview,
}: EditorCommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const hasSelection = !!selectedText?.trim();
  const format = activeFile?.format ?? 'text';

  const commands = useMemo((): CommandItem[] => {
    const items: CommandItem[] = [];

    // AI Text（有选中时）
    if (hasSelection && selectedText) {
      items.push(
        {
          id: 'ai-rewrite',
          label: '润色',
          icon: Type,
          category: 'ai-text',
          keywords: ['润色', 'rewrite', 'polish'],
          run: () => onAIAction('rewrite', selectedText),
        },
        {
          id: 'ai-translate',
          label: '翻译',
          icon: Languages,
          category: 'ai-text',
          keywords: ['翻译', 'translate'],
          run: () => onAIAction('translate', selectedText),
        },
        {
          id: 'ai-summary',
          label: '摘要',
          icon: FileText,
          category: 'ai-text',
          keywords: ['摘要', 'summary'],
          run: () => onAIAction('summary', selectedText),
        },
        {
          id: 'ai-fix',
          label: '优化选中',
          icon: FileCode,
          category: 'ai-text',
          keywords: ['优化', 'fix', 'refactor'],
          run: () => onAIAction('fix', selectedText),
        },
        {
          id: 'ai-explain',
          label: '解释',
          icon: Sparkles,
          category: 'ai-text',
          keywords: ['解释', 'explain'],
          run: () => onAIAction('explain', selectedText),
        },
      );
    }

    // 用 AI 分析当前文件（编辑区 → 对话区联动）
    if (activeFile) {
      items.push({
        id: 'ai-ask-file',
        label: '用 AI 分析当前文件',
        description: '打开对话并带入文件上下文',
        icon: Sparkles,
        category: 'ai-text',
        keywords: ['分析', 'ask', 'ai', '文件', '对话'],
        run: () => {
          window.dispatchEvent(new CustomEvent('editor_ai_action', {
            detail: { action: 'ask_about_file', text: selectedText || '' },
          }));
        },
      });
    }

    // File
    items.push(
      {
        id: 'file-save',
        label: '保存',
        description: '⌘S',
        icon: Save,
        category: 'file',
        keywords: ['保存', 'save'],
        run: onSave,
        disabled: !isModified || isSaving,
      },
      {
        id: 'file-download',
        label: '下载',
        icon: Download,
        category: 'file',
        keywords: ['下载', 'download'],
        run: onDownload,
      },
      {
        id: 'file-open-external',
        label: '在外部打开',
        icon: ExternalLink,
        category: 'file',
        keywords: ['外部', 'external', '打开'],
        run: onOpenExternal,
      },
    );

    // View（按格式）
    if (format === 'markdown' && onTogglePreview) {
      items.push({
        id: 'view-toggle-preview',
        label: '切换预览 / 源码',
        description: '⌘\\',
        icon: Eye,
        category: 'view',
        keywords: ['预览', 'preview', '源码'],
        run: onTogglePreview,
      });
    }
    items.push({
      id: 'view-fullscreen',
      label: '全屏',
      description: 'F11',
      icon: Maximize,
      category: 'view',
      keywords: ['全屏', 'fullscreen'],
      run: () => {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen?.();
        } else {
          document.exitFullscreen?.();
        }
        onClose();
      },
    });

    return items;
  }, [
    hasSelection,
    selectedText,
    format,
    isModified,
    isSaving,
    activeFile,
    onAIAction,
    onSave,
    onDownload,
    onOpenExternal,
    onTogglePreview,
    onClose,
  ]);

  const filtered = useMemo(() => {
    if (!query.trim()) return commands;
    const q = query.toLowerCase();
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.keywords.some((k) => k.toLowerCase().includes(q))
    );
  }, [commands, query]);

  const selectIndex = useCallback(
    (delta: number) => {
      setSelectedIndex((i) => {
        if (filtered.length === 0) return 0;
        const next = i + delta;
        if (next < 0) return filtered.length - 1;
        if (next >= filtered.length) return 0;
        return next;
      });
    },
    [filtered.length]
  );

  const runSelected = useCallback(() => {
    const item = filtered[selectedIndex];
    if (item && !item.disabled) {
      item.run();
      onClose();
    }
  }, [filtered, selectedIndex, onClose]);

  useEffect(() => {
    let focusTimer: ReturnType<typeof setTimeout> | null = null;
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      focusTimer = setTimeout(() => inputRef.current?.focus(), 50);
    }
    return () => {
      if (focusTimer) clearTimeout(focusTimer);
    };
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    setSelectedIndex((prev) => Math.min(prev, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.key === 'Process') return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectIndex(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectIndex(-1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        runSelected();
        return;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose, selectIndex, runSelected]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || filtered.length === 0) return;
    const child = el.children[selectedIndex] as HTMLElement;
    child?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, [selectedIndex, filtered.length]);

  return (
    <AnimatePresence>
      {open && (
      <motion.div
        className="fixed inset-0 z-[var(--z-dialog)]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      >
        <motion.div
          className="absolute top-24 left-1/2 -translate-x-1/2 w-full max-w-lg rounded-xl border border-border bg-popover/95 shadow-2xl backdrop-blur-md overflow-hidden"
          initial={{ scale: 0.96, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.96, opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="输入命令或搜索..."
              className="border-0 bg-transparent shadow-none focus-visible:ring-0 h-9 text-sm"
              aria-label="命令搜索"
            />
            <kbd className="hidden sm:inline text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-muted">
              Esc
            </kbd>
          </div>
          <ScrollArea className="max-h-[280px] overflow-y-auto">
            <div ref={listRef} className="py-1">
              {filtered.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  无匹配命令
                </div>
              ) : (
                filtered.map((item, index) => {
                  const Icon = item.icon;
                  const isSelected = index === selectedIndex;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={cn(
                        'w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors',
                        isSelected && 'bg-accent text-accent-foreground',
                        item.disabled && 'opacity-50 pointer-events-none'
                      )}
                      onMouseEnter={() => setSelectedIndex(index)}
                      onClick={() => {
                        if (!item.disabled) {
                          item.run();
                          onClose();
                        }
                      }}
                    >
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="flex-1">{highlightMatch(item.label, query)}</span>
                      {item.description && (
                        <span className="text-[10px] text-muted-foreground">
                          {item.description}
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </ScrollArea>
          {activeFile && (
            <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground truncate">
              {activeFile.name}
              {hasSelection && ` · 已选 ${selectedText?.length ?? 0} 字`}
            </div>
          )}
        </motion.div>
      </motion.div>
      )}
    </AnimatePresence>
  );
}
