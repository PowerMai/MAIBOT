/**
 * 工作区文件树组件
 * 
 * 功能：
 * - 打开本地文件夹创建工作区
 * - 显示工作区文件结构
 * - 支持展开/折叠目录
 * - 双击打开文件到编辑器
 * - 右键菜单操作
 * - 实时同步后端文件系统
 * - 集成 LangGraph API 进行文件操作
 */
/// <reference types="vite/client" />

import React, { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import langgraphApi from "../lib/langgraphApi";
import { getApiBase } from "../lib/api/langserveChat";
import { EVENTS } from "../lib/constants";
import { t } from "../lib/i18n";
import { getItem as getStorageItem, setItem as setStorageItem } from "../lib/safeStorage";
import { getCurrentWorkspacePathFromStorage } from "../lib/sessionState";
import { motion, AnimatePresence } from "motion/react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "./ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import {
  Folder,
  FolderOpen,
  File,
  FileText,
  ChevronRight,
  ChevronDown,
  ChevronsUpDown,
  Trash2,
  Edit,
  RefreshCw,
  FilePlus,
  MoreVertical,
  Plus,
  Cloud,
  Copy,
  Clock,
  Search,
  X,
  Settings,
} from "lucide-react";

// 自定义 FileCode 图标（代码文件）
const FileCode = ({ className }: { className?: string }) => (
  <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
    <polyline points="14 2 14 8 20 8"/>
    <path d="m10 13-2 2 2 2"/>
    <path d="m14 17 2-2-2-2"/>
  </svg>
);

// 自定义图标（lucide-react 兼容）
const FolderPlus2 = ({ className }: { className?: string }) => (
  <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>
    <line x1="12" y1="10" x2="12" y2="16"/><line x1="9" y1="13" x2="15" y2="13"/>
  </svg>
);

const FolderOpen2 = ({ className }: { className?: string }) => (
  <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/>
  </svg>
);

const FileJson = ({ className }: { className?: string }) => (
  <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
    <polyline points="14 2 14 8 20 8"/>
    <path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1"/>
    <path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1"/>
  </svg>
);
import { 
  workspaceService, 
  workspaceAPI,
  switchWorkspaceByPath,
  type FileNode, 
  type WorkspaceInfo 
} from "../lib/api/workspace";
import { fileEventBus } from "../lib/events/fileEvents";
import { parseWorkspaceFile, serializeWorkspaceFile, WORKSPACE_FILE_EXT, type CCBWorkspaceFolder } from "../lib/workspaceFile";
import { fileSystemService } from "../lib/services/electronService";
// import { UnifiedFileUploadDialog } from "./UnifiedFileUploadDialog";

// ============= 类型定义 =============

interface WorkspaceFileTreeProps {
  /** 文件选中回调 */
  onFileSelect?: (path: string, content: string) => void;
  /** 文件打开回调 */
  onFileOpen?: (path: string, content: string) => void;
  /** 当前选中的文件路径（与编辑器 Tab 双向同步） */
  selectedPath?: string;
  /** 已在编辑器中打开的文件路径列表，用于选中时切换 Tab */
  openFilePaths?: string[];
  /** 聚焦已打开文件（仅切换 Tab，不加载内容） */
  onFocusOpenFile?: (path: string) => void;
  /** 紧凑模式 */
  compact?: boolean;
  /** 工作区变更回调 */
  onWorkspaceChange?: (workspace: WorkspaceInfo | null) => void;
}

// ============= 辅助函数 =============

/** 轻量级树指纹（递归 name:type，djb2 压缩，用于轮询比较） */
function treeFingerprint(node: FileNode | null): string {
  if (!node) return '';
  const parts: string[] = [];
  function walk(n: FileNode) {
    parts.push(n.name, n.type, String((n as { size?: number }).size ?? 0));
    (n.children ?? []).forEach(walk);
  }
  walk(node);
  const str = parts.join('|');
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return String(hash);
}

/** 按关键词过滤文件树（保留名称匹配的节点及包含匹配子节点的文件夹） */
function filterFileNode(node: FileNode, query: string): FileNode | null {
  const q = query.trim().toLowerCase();
  if (!q) return node;
  if (node.type === "file") {
    return node.name.toLowerCase().includes(q) ? node : null;
  }
  const filteredChildren = (node.children ?? [])
    .map((c) => filterFileNode(c, query))
    .filter((n): n is FileNode => n != null);
  const nameMatch = node.name.toLowerCase().includes(q);
  if (filteredChildren.length > 0 || nameMatch) {
    return {
      ...node,
      children: filteredChildren.length > 0 ? filteredChildren : [],
    };
  }
  return null;
}

/** 高亮文件名中的匹配关键词 */
function highlightName(name: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return name;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    const re = new RegExp(`(${escaped})`, "gi");
    const parts = name.split(re);
    return parts.map((part, i) =>
      i % 2 === 1 ? (
        <mark key={i} className="bg-primary/25 text-foreground rounded px-0.5 font-medium">
          {part}
        </mark>
      ) : (
        part
      )
    );
  } catch {
    return name;
  }
}

/**
 * 从 Web File System Access API 的 DirectoryHandle 读取目录结构
 */
async function readDirectoryFromHandle(
  dirHandle: FileSystemDirectoryHandle,
  name: string,
  maxDepth: number,
  currentDepth: number = 0,
  parentPath: string = ''
): Promise<FileNode> {
  const currentPath = parentPath ? `${parentPath}/${name}` : name;
  
  const node: FileNode = {
    name,
    path: currentPath,
    type: 'folder',
    size: 0,
    children: [],
  };

  if (currentDepth >= maxDepth) {
    if (import.meta.env?.DEV) console.log('[readDirectoryFromHandle] Max depth at', currentPath);
    return node;
  }

  try {
    const entries: Array<{ name: string; kind: 'file' | 'directory'; handle: FileSystemHandle }> = [];
    
    // 遍历目录
    for await (const [entryName, handle] of (dirHandle as any).entries()) {
      // 过滤隐藏文件和 node_modules
      if (entryName.startsWith('.') || entryName === 'node_modules' || entryName === '__pycache__') {
        continue;
      }
      entries.push({ name: entryName, kind: handle.kind, handle });
    }

    if (import.meta.env?.DEV) console.log('[readDirectoryFromHandle] Found', entries.length, 'entries in', currentPath);

    // 排序：目录在前，文件在后
    entries.sort((a, b) => {
      if (a.kind === 'directory' && b.kind !== 'directory') return -1;
      if (a.kind !== 'directory' && b.kind === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });

    // 递归处理子项
    for (const entry of entries) {
      if (entry.kind === 'directory') {
        const childNode = await readDirectoryFromHandle(
          entry.handle as FileSystemDirectoryHandle,
          entry.name,
          maxDepth,
          currentDepth + 1,
          currentPath
        );
        node.children!.push(childNode);
      } else {
        const fileHandle = entry.handle as FileSystemFileHandle;
        let fileSize = 0;
        try {
          const file = await fileHandle.getFile();
          fileSize = file.size;
        } catch (e) {
          if (import.meta.env?.DEV) console.warn(`Cannot get file size for ${entry.name}:`, e);
        }
        node.children!.push({
          name: entry.name,
          path: `${currentPath}/${entry.name}`,
          type: 'file',
          size: fileSize,
        });
      }
    }
  } catch (err) {
    console.error(`[readDirectoryFromHandle] Error reading directory ${name}:`, err);
  }

  if (import.meta.env?.DEV) console.log('[readDirectoryFromHandle] Node for', currentPath, 'children', node.children?.length || 0);
  return node;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getFileIcon = (fileName: string): any => {
  const ext = fileName.split('.').pop()?.toLowerCase();
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const iconMap: Record<string, any> = {
    'ts': <FileCode className="h-4 w-4 text-blue-500" />,
    'tsx': <FileCode className="h-4 w-4 text-blue-500" />,
    'js': <FileCode className="h-4 w-4 text-yellow-500" />,
    'jsx': <FileCode className="h-4 w-4 text-yellow-500" />,
    'py': <FileCode className="h-4 w-4 text-green-500" />,
    'json': <FileJson className="h-4 w-4 text-amber-500" />,
    'md': <FileText className="h-4 w-4 text-slate-500" />,
    'txt': <FileText className="h-4 w-4 text-slate-500" />,
    'html': <FileCode className="h-4 w-4 text-orange-500" />,
    'css': <FileCode className="h-4 w-4 text-blue-400" />,
    'yml': <FileText className="h-4 w-4 text-purple-500" />,
    'yaml': <FileText className="h-4 w-4 text-purple-500" />,
  };
  
  return iconMap[ext || ''] || <File className="h-4 w-4 text-slate-400" />;
};

// ============= 内联输入组件（VSCode 风格） =============

interface InlineInputProps {
  level: number;
  type: 'file' | 'folder';
  onSubmit: (name: string) => void;
  onCancel: () => void;
  compact?: boolean;
  /** 重命名时传入当前名称，新建时省略 */
  initialValue?: string;
}

function InlineInput({ level, type, onSubmit, onCancel, compact, initialValue = '' }: InlineInputProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const submittedRef = React.useRef(false);
  const indent = level * (compact ? 12 : 16);
  
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    if (initialValue !== undefined) setValue(initialValue);
  }, [initialValue]);
  
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && value.trim()) {
      onSubmit(value.trim());
      submittedRef.current = true;
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };
  
  const handleBlur = () => {
    if (submittedRef.current) {
      submittedRef.current = false;
      return;
    }
    if (value.trim()) {
      onSubmit(value.trim());
    } else {
      onCancel();
    }
  };
  
  return (
    <div
      className="flex items-center gap-1 py-0.5 px-1"
      style={{ paddingLeft: `${indent}px` }}
    >
      <span className="w-4" />
      <span className="shrink-0">
        {type === 'folder' ? (
          <Folder className="h-4 w-4 text-amber-500" />
        ) : (
          <File className="h-4 w-4 text-slate-400" />
        )}
      </span>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder={type === 'folder' ? '文件夹名称' : '文件名'}
        className={`flex-1 bg-background border border-emerald-500 rounded px-1.5 py-0.5 outline-none ${compact ? 'text-xs' : 'text-sm'}`}
      />
    </div>
  );
}

// ============= 文件树节点组件 =============

interface FileTreeNodeProps {
  key?: string;  // React key prop
  node: FileNode;
  level: number;
  selectedPath?: string;
  /** 搜索关键词，用于高亮匹配部分 */
  searchQuery?: string;
  /** 已在编辑器中打开的文件路径，用于加粗显示 */
  openFilePaths?: string[];
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onMove?: (fromPath: string, toDirPath: string) => Promise<void>;
  onCreateFile?: (parentPath: string, name: string) => void;
  onCreateFolder?: (parentPath: string, name: string) => void;
  /** 内联重命名：当前正在重命名的路径 */
  renamingPath?: string | null;
  renamingDraft?: string;
  onRenamingDraftChange?: (v: string) => void;
  onRenameConfirm?: (path: string, newName: string) => void;
  onRenameCancel?: () => void;
  compact?: boolean;
}

const FileTreeNode = React.memo(function FileTreeNode({
  node,
  level,
  selectedPath,
  searchQuery,
  openFilePaths,
  expandedPaths,
  onToggle,
  onSelect,
  onOpen,
  onRename,
  onDelete,
  onMove,
  onCreateFile,
  onCreateFolder,
  compact,
  renamingPath,
  renamingDraft,
  onRenamingDraftChange,
  onRenameConfirm,
  onRenameCancel,
}: FileTreeNodeProps) {
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = selectedPath === node.path;
  const isFolder = node.type === 'folder';
  const isOpenInEditor = !isFolder && openFilePaths?.includes(node.path);
  const indent = level * (compact ? 10 : 12);
  
  const [inlineCreate, setInlineCreate] = useState<'file' | 'folder' | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const renameSubmittedRef = React.useRef(false);
  
  return (
    <div>
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', node.path);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={isFolder && onMove ? (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setDragOver(true);
        } : undefined}
        onDragLeave={isFolder ? () => setDragOver(false) : undefined}
        onDrop={isFolder && onMove ? (e) => {
          e.preventDefault();
          setDragOver(false);
          const fromPath = e.dataTransfer.getData('text/plain');
          if (!fromPath || fromPath === node.path) return;
          if (node.path.startsWith(fromPath + '/') || node.path.startsWith(fromPath + '\\')) return;
          onMove(fromPath, node.path);
        } : undefined}
        className={`
          group flex items-center gap-0.5 h-[22px] px-1 rounded-sm cursor-pointer transition-colors duration-150 border-l-2
          ${isSelected ? 'bg-primary/15 text-foreground border-l-primary' : 'border-l-transparent hover:bg-sidebar-accent text-foreground/80'}
          ${isFolder && dragOver ? 'bg-primary/10' : ''}
        `}
        style={{ paddingLeft: `${indent}px` }}
        onClick={() => {
          if (isFolder) {
            onToggle(node.path);
          } else {
            // 单击文件直接打开（Cursor 风格）
            onSelect(node.path);
            onOpen(node.path);
          }
        }}
        onDoubleClick={() => {
          if (!isFolder) {
            onOpen(node.path);
          }
        }}
      >
        {/* 展开/折叠图标 */}
        {isFolder ? (
          <button
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onClick={(e: any) => {
              e.stopPropagation();
              onToggle(node.path);
            }}
            className="shrink-0 w-4 h-4 flex items-center justify-center hover:bg-muted/50 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            aria-label={isExpanded ? "折叠" : "展开"}
            aria-expanded={isExpanded}
          >
            {isExpanded ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            )}
          </button>
        ) : (
          <span className="w-4" />
        )}
        
        {/* 文件/文件夹图标 */}
        <span className="shrink-0 w-4 h-4 flex items-center justify-center">
          {isFolder ? (
            isExpanded ? (
              <FolderOpen className="h-3.5 w-3.5 text-amber-500" />
            ) : (
              <Folder className="h-3.5 w-3.5 text-amber-500" />
            )
          ) : (
            getFileIcon(node.name)
          )}
        </span>
        
        {/* 文件名（重命名时显示内联输入，否则显示名称） */}
        {renamingPath === node.path && onRenameConfirm && onRenameCancel ? (
          <input
            type="text"
            value={renamingDraft ?? node.name}
            onChange={(e) => onRenamingDraftChange?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const v = (e.target as HTMLInputElement).value.trim();
                if (v) onRenameConfirm(node.path, v);
              } else if (e.key === 'Escape') {
                onRenameCancel();
              }
            }}
            onBlur={(e) => {
              const v = (e.target as HTMLInputElement).value.trim();
              if (v) onRenameConfirm(node.path, v);
              else onRenameCancel();
            }}
            className={`flex-1 min-w-0 bg-background border border-emerald-500 rounded px-1 py-0.5 outline-none ${compact ? 'text-[11px]' : 'text-[12px]'}`}
            autoFocus
          />
        ) : (
          <span className={`flex-1 truncate ${compact ? 'text-[11px]' : 'text-[12px]'} ${isOpenInEditor ? 'font-medium' : ''}`}>
            {searchQuery ? highlightName(node.name, searchQuery) : node.name}
          </span>
        )}
        
        {/* 操作菜单（重命名时不显示） */}
        {renamingPath !== node.path && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onClick={(e: any) => e.stopPropagation()}
              className="shrink-0 opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center hover:bg-muted/50 rounded-sm transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              aria-label={t("workspace.moreActionsAria")}
            >
              <MoreVertical className="h-3 w-3 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="right" className="min-w-[140px]">
            {!isFolder && (
              <>
                <DropdownMenuItem onClick={() => onOpen(node.path)}>
                  <FileText className="h-3.5 w-3.5 mr-2" />
                  打开
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => {
                  navigator.clipboard.writeText(node.path);
                }}>
                  <Copy className="h-3.5 w-3.5 mr-2" />
                  复制路径
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent(EVENTS.ADD_FILE_TO_CONTEXT, { detail: { path: node.path } }));
                  }}
                  className="text-xs gap-2"
                >
                  <Plus className="h-3.5 w-3.5 mr-2 text-emerald-500" />
                  添加到对话上下文
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {isFolder && (
              <>
                <DropdownMenuItem onClick={() => onToggle(node.path)}>
                  {isExpanded ? (
                    <>
                      <ChevronDown className="h-3.5 w-3.5 mr-2" />
                      折叠
                    </>
                  ) : (
                    <>
                      <ChevronRight className="h-3.5 w-3.5 mr-2" />
                      展开
                    </>
                  )}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => {
                  // 展开文件夹并显示内联输入
                  if (!isExpanded) onToggle(node.path);
                  setInlineCreate('file');
                }}>
                  <FilePlus className="h-3.5 w-3.5 mr-2" />
                  新建文件
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => {
                  // 展开文件夹并显示内联输入
                  if (!isExpanded) onToggle(node.path);
                  setInlineCreate('folder');
                }}>
                  <FolderPlus2 className="h-3.5 w-3.5 mr-2" />
                  新建文件夹
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent(EVENTS.ADD_FOLDER_TO_CONTEXT, { detail: { path: node.path } }));
                  }}
                  className="text-xs gap-2"
                >
                  <Plus className="h-3.5 w-3.5 mr-2 text-emerald-500" />
                  添加到对话上下文
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onClick={() => onRename(node.path)}>
              <Edit className="h-3.5 w-3.5 mr-2" />
              重命名
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem 
              onClick={() => onDelete(node.path)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        )}
      </div>
      
      {/* 子节点 */}
      <AnimatePresence>
        {isFolder && isExpanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
          >
            {/* VSCode 风格：内联创建输入框 */}
            {inlineCreate && (
              <InlineInput
                level={level + 1}
                type={inlineCreate}
                compact={compact}
                onSubmit={(name) => {
                  if (inlineCreate === 'file') {
                    onCreateFile?.(node.path, name);
                  } else {
                    onCreateFolder?.(node.path, name);
                  }
                  setInlineCreate(null);
                }}
                onCancel={() => setInlineCreate(null)}
              />
            )}
            
            {node.children?.map((child) => (
              <FileTreeNode
                key={child.path}
                node={child}
                level={level + 1}
                selectedPath={selectedPath}
                searchQuery={searchQuery}
                openFilePaths={openFilePaths}
                expandedPaths={expandedPaths}
                onToggle={onToggle}
                onSelect={onSelect}
                onOpen={onOpen}
                onRename={onRename}
                onDelete={onDelete}
                onMove={onMove}
                onCreateFile={onCreateFile}
                onCreateFolder={onCreateFolder}
                renamingPath={renamingPath}
                renamingDraft={renamingDraft}
                onRenamingDraftChange={onRenamingDraftChange}
                onRenameConfirm={onRenameConfirm}
                onRenameCancel={onRenameCancel}
                compact={compact}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}, (prev, next) => {
  if (prev.node !== next.node) return false;
  if (prev.level !== next.level || prev.compact !== next.compact) return false;
  if (prev.searchQuery !== next.searchQuery) return false;
  const prevOpen = prev.openFilePaths?.includes(prev.node.path);
  const nextOpen = next.openFilePaths?.includes(next.node.path);
  if (prevOpen !== nextOpen) return false;
  if (prev.expandedPaths.has(prev.node.path) !== next.expandedPaths.has(next.node.path)) return false;
  if ((prev.selectedPath === prev.node.path) !== (next.selectedPath === next.node.path)) return false;
  if (next.node.type === 'folder' && next.expandedPaths.has(next.node.path)) {
    if (prev.expandedPaths !== next.expandedPaths) return false;
    if (prev.selectedPath !== next.selectedPath) return false;
  }
  if (prev.renamingPath === prev.node.path || next.renamingPath === next.node.path) {
    if (prev.renamingPath !== next.renamingPath || prev.renamingDraft !== next.renamingDraft) return false;
  }
  return true;
});

function findNodeInTree(tree: FileNode | null, path: string): FileNode | null {
  if (!tree) return null;
  if (tree.path === path) return tree;
  for (const child of tree.children ?? []) {
    const found = findNodeInTree(child, path);
    if (found) return found;
  }
  return null;
}

// 工作区树形选择器内联树节点（仅用于「从工作区浏览文件」弹窗）
function TreePickerNode({ node, level = 0, onSelectFile }: { node: FileNode; level?: number; onSelectFile: (path: string, name: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const isFolder = node.type === 'folder';
  const indent = level * 14;
  if (!isFolder) {
    return (
      <button
        type="button"
        className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-left text-sm hover:bg-muted/60 truncate"
        style={{ paddingLeft: `${indent + 8}px` }}
        onClick={() => onSelectFile(node.path, node.name)}
      >
        {getFileIcon(node.name)}
        <span className="truncate">{node.name}</span>
      </button>
    );
  }
  return (
    <div>
      <button
        type="button"
        className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-left text-sm hover:bg-muted/60 truncate"
        style={{ paddingLeft: `${indent + 8}px` }}
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <Folder className="h-3.5 w-3.5 text-amber-500 shrink-0" />
        <span className="truncate">{node.name}</span>
      </button>
      {expanded &&
        (node.children ?? []).map((child) => (
          <TreePickerNode key={child.path} node={child} level={level + 1} onSelectFile={onSelectFile} />
        ))}
    </div>
  );
}

// ============= 主组件 =============

export function WorkspaceFileTree({
  onFileSelect,
  onFileOpen,
  selectedPath,
  openFilePaths,
  onFocusOpenFile,
  compact = false,
  onWorkspaceChange,
}: WorkspaceFileTreeProps) {
  // 工作区状态
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceInfo | null>(null);
  const [fileTree, setFileTree] = useState<FileNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [showLoadingSpinner, setShowLoadingSpinner] = useState(false);
  const loadingDelayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [internalSelectedPath, setInternalSelectedPath] = useState<string | undefined>(selectedPath);
  const mountedRef = useRef(true);
  const lastSelectFolderAtRef = useRef(0);
  const lastSwitchWorkspaceAtRef = useRef(0);
  const workspaceTreeContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 与编辑器 Tab 双向同步：外部 selectedPath 变化时更新内部选中
  useEffect(() => {
    if (selectedPath !== undefined) setInternalSelectedPath(selectedPath);
  }, [selectedPath]);
  
  // 展开文件夹状态 - 从 workspaceService 恢复
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    const saved = workspaceService.getExpandedFolders();
    return new Set(saved.length > 0 ? saved : ['.']);
  });
  
  // 保存展开状态到 workspaceService
  useEffect(() => {
    if (expandedPaths.size > 0) {
      workspaceService.saveExpandedFolders(Array.from(expandedPaths));
    }
  }, [expandedPaths]);

  useEffect(() => {
    if (loading) {
      loadingDelayTimerRef.current = setTimeout(() => {
        loadingDelayTimerRef.current = null;
        if (mountedRef.current) setShowLoadingSpinner(true);
      }, 200);
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

  // Web File System API 状态 - 保存 DirectoryHandle 以便后续操作
  const [webDirHandle, setWebDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  
  // 根目录内联新建（VSCode 风格，无对话框）
  const [rootInlineCreate, setRootInlineCreate] = useState<'file' | 'folder' | null>(null);
  // 文件搜索（⌘P 快速打开聚焦）
  const [fileSearchQuery, setFileSearchQuery] = useState("");
  const fileSearchInputRef = useRef<HTMLInputElement>(null);
  // 对话框状态
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renamingDraft, setRenamingDraft] = useState('');
  const [showWorkspaceSelector, setShowWorkspaceSelector] = useState(false);
  const [recentWorkspaces, setRecentWorkspaces] = useState<Array<{ id: string; name: string; path?: string; lastOpened: string | number }>>([]);
  const [recentForBar, setRecentForBar] = useState<Array<{ id: string; name: string; path?: string; lastOpened: string | number }>>([]);
  const [quickSwitchPath, setQuickSwitchPath] = useState<string | null>(null);
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [deleteConfirmPath, setDeleteConfirmPath] = useState<string | null>(null);
  const [showWorkspaceTreePicker, setShowWorkspaceTreePicker] = useState(false);
  const workspaceTreePickerCallbackRef = useRef<((path: string, name: string) => void) | null>(null);
  
  // 加载工作区列表
  const loadWorkspaces = useCallback(async () => {
    try {
      const list = await workspaceAPI.listWorkspaces();
      if (mountedRef.current) setWorkspaces(list);
    } catch (e) {
      console.error('Failed to load workspaces:', e);
      if (mountedRef.current) toast.error(t('workspace.listLoadFailed'), { description: e instanceof Error ? e.message : String(e) });
    }
  }, [t]);
  
  // 加载文件树
  const loadFileTree = useCallback(async () => {
    if (!activeWorkspace) {
      if (mountedRef.current) setFileTree(null);
      return;
    }
    
    if (mountedRef.current) setLoading(true);
    try {
      const tree = await workspaceService.getFileTree(true);
      if (mountedRef.current) {
        setFileTree(tree);
      }
    } catch (e) {
      console.error('Failed to load file tree:', e);
      if (mountedRef.current) {
        setFileTree(null);
        toast.error(t('workspace.fileTreeLoadFailed'), { description: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [activeWorkspace, t]);

  const loadFileTreeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadFileTreeDebounced = useCallback(() => {
    if (loadFileTreeDebounceRef.current) clearTimeout(loadFileTreeDebounceRef.current);
    loadFileTreeDebounceRef.current = setTimeout(() => {
      loadFileTreeDebounceRef.current = null;
      loadFileTree();
    }, 200);
  }, [loadFileTree]);
  
  // 检测运行环境 - 必须在 useEffect 之前声明
  const electron = (window as any)?.electron;
  const isElectron = !!electron?.selectDirectory;
  const hasFileSystemAPI = typeof window !== "undefined" && "showDirectoryPicker" in window;
  
  // Electron 本地工作区状态
  const [localWorkspacePath, setLocalWorkspacePath] = useState<string | null>(null);
  const [localFileTree, setLocalFileTree] = useState<FileNode | null>(null);
  // 多根工作区：.ccb-workspace 或「添加文件夹」后的多文件夹
  const [workspaceFolders, setWorkspaceFolders] = useState<CCBWorkspaceFolder[]>([]);
  const [localFileTrees, setLocalFileTrees] = useState<(FileNode | null)[]>([]);

  // 使用 Electron 读取本地目录
  const loadLocalFileTree = useCallback(
    async (dirPath: string) => {
      if (!electron || typeof electron.readDirectory !== "function") return;

      if (mountedRef.current) setLoading(true);
      try {
        const result = await electron.readDirectory({ dirPath, depth: 5 });
        if (!mountedRef.current) return;
        if (result && result.success && result.tree) {
          setLocalFileTree(result.tree);
          setLocalWorkspacePath(dirPath);
        } else {
          toast.error('读取目录失败', { description: result?.error });
        }
      } catch (e: unknown) {
        if (mountedRef.current) toast.error('读取目录失败', { description: e instanceof Error ? e.message : String(e) });
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [electron]
  );

  const lastMultiTreeFingerprintRef = useRef<string>("");
  // 多根：加载多棵文件树（用于 .ccb-workspace 多文件夹）；skipSetIfUnchanged 为 true 时指纹未变不 setState，用于轮询减抖
  const loadLocalFileTrees = useCallback(
    async (folders: CCBWorkspaceFolder[], skipSetIfUnchanged = false) => {
      if (!electron?.readDirectory || folders.length === 0) return;
      if (mountedRef.current && !skipSetIfUnchanged) setLoading(true);
      try {
        const trees: (FileNode | null)[] = await Promise.all(
          folders.map((f) =>
            electron.readDirectory({ dirPath: f.path, depth: 5 }).then(
              (r: any) => (r?.success && r?.tree ? r.tree : null),
              () => null
            )
          )
        );
        const fp = trees.map((t) => treeFingerprint(t)).join(";");
        if (skipSetIfUnchanged && fp === lastMultiTreeFingerprintRef.current) return;
        lastMultiTreeFingerprintRef.current = fp;
        if (mountedRef.current) setLocalFileTrees(trees);
      } catch (e) {
        console.error('[WorkspaceFileTree] loadLocalFileTrees failed:', e);
        if (mountedRef.current) setLocalFileTrees([]);
      } finally {
        if (mountedRef.current && !skipSetIfUnchanged) setLoading(false);
      }
    },
    [electron]
  );

  const workspaceFoldersRef = useRef(workspaceFolders);
  const localWorkspacePathRef = useRef(localWorkspacePath);
  workspaceFoldersRef.current = workspaceFolders;
  localWorkspacePathRef.current = localWorkspacePath;

  const refreshLocalTree = useCallback(() => {
    const folders = workspaceFoldersRef.current;
    const path = localWorkspacePathRef.current;
    if (folders.length > 1) loadLocalFileTrees(folders);
    else if (path) loadLocalFileTree(path);
  }, [loadLocalFileTrees, loadLocalFileTree]);

  const localRefreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedRefreshLocalTree = useCallback(() => {
    if (localRefreshDebounceRef.current) clearTimeout(localRefreshDebounceRef.current);
    localRefreshDebounceRef.current = setTimeout(() => {
      localRefreshDebounceRef.current = null;
      refreshLocalTree();
    }, 200);
  }, [refreshLocalTree]);
  
  const WORKSPACE_FOLDERS_KEY = 'localWorkspaceFolders';

  // 初始化 - 恢复工作区状态（优先多根持久化，再单路径）
  useEffect(() => {
    loadWorkspaces();
    
    // 1. 优先恢复本地工作区（Electron）：先尝试多根，再单路径
    try {
      if (!electron?.readDirectory) {
        workspaceService.restoreFromStorage().then((ws) => {
          if (!mountedRef.current) return;
          if (ws) {
            setActiveWorkspace(ws);
            onWorkspaceChange?.(ws);
          }
        }).catch(() => { if (mountedRef.current) toast.error(t("workspace.restoreFailed")); });
        return;
      }
      const savedFoldersRaw = localStorage.getItem(WORKSPACE_FOLDERS_KEY);
      let savedFolders: CCBWorkspaceFolder[] = [];
      if (savedFoldersRaw) {
        try {
          const arr = JSON.parse(savedFoldersRaw);
          if (Array.isArray(arr) && arr.length > 0 && arr.every((f: unknown) => f && typeof f === 'object' && 'path' in f && typeof (f as CCBWorkspaceFolder).path === 'string')) {
            savedFolders = arr as CCBWorkspaceFolder[];
          }
        } catch { /* ignore */ }
      }
      if (savedFolders.length > 0) {
        // 验证路径存在性，过滤无效路径
        (async () => {
          const validFolders: CCBWorkspaceFolder[] = [];
          for (const f of savedFolders) {
            try {
              const r = await electron.readDirectory({ dirPath: f.path, depth: 1 });
              if (r?.success) validFolders.push(f);
              else if (import.meta.env?.DEV) console.warn('[WorkspaceFileTree] 路径不存在，已移除:', f.path);
            } catch {
              if (import.meta.env?.DEV) console.warn('[WorkspaceFileTree] 路径不可访问，已移除:', f.path);
            }
          }
          if (validFolders.length === 0) {
            // 所有路径都无效，清除持久化
            try {
              localStorage.removeItem(WORKSPACE_FOLDERS_KEY);
              localStorage.removeItem('localWorkspacePath');
            } catch { /* ignore */ }
            toast.info('上次打开的工作区文件夹已不存在');
            return;
          }
          // 若有路径被移除，更新持久化
          if (validFolders.length < savedFolders.length) {
            try {
              localStorage.setItem(WORKSPACE_FOLDERS_KEY, JSON.stringify(validFolders));
            } catch { /* ignore */ }
            toast.info(`已移除 ${savedFolders.length - validFolders.length} 个不存在的文件夹`);
          }
          const firstPath = validFolders[0].path;
          if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] 恢复工作区:', validFolders.length, '个文件夹');
          setWorkspaceFolders(validFolders);
          setLocalWorkspacePath(firstPath);
          try {
            localStorage.setItem('localWorkspacePath', firstPath);
          } catch { /* ignore */ }
          if (validFolders.length === 1) {
            setLocalFileTrees([]);
            loadLocalFileTree(firstPath);
          } else {
            setLocalFileTree(null);
            loadLocalFileTrees(validFolders);
          }
          const workspaces = JSON.parse(localStorage.getItem('workspaces') || '[]');
          const ws = workspaces.find((w: any) => w.path === firstPath);
          if (ws) {
            setActiveWorkspace(ws);
            onWorkspaceChange?.(ws);
          } else {
            const now = new Date().toISOString();
            const newWs: WorkspaceInfo = {
              id: firstPath,
              name: validFolders[0].name ?? firstPath.split('/').pop() ?? '工作区',
              path: firstPath,
              mode: 'linked',
              created_at: now,
              updated_at: now,
              file_count: 0,
            };
            setActiveWorkspace(newWs);
            onWorkspaceChange?.(newWs);
          }
        })();
        return;
      }
      // 工作区真源：优先读 getCurrentWorkspacePathFromStorage（与设置页一致），其次 localWorkspacePath
      const savedLocalPath = getCurrentWorkspacePathFromStorage().trim() || localStorage.getItem('localWorkspacePath');
      if (savedLocalPath) {
        if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] 恢复本地工作区:', savedLocalPath);
        setLocalWorkspacePath(savedLocalPath);
        if (getCurrentWorkspacePathFromStorage() && !localStorage.getItem('localWorkspacePath')) {
          try { localStorage.setItem('localWorkspacePath', savedLocalPath); } catch { /* ignore */ }
        }
        setWorkspaceFolders([{ path: savedLocalPath, name: savedLocalPath.split('/').pop() ?? undefined }]);
        setLocalFileTrees([]);
        loadLocalFileTree(savedLocalPath);
        const workspaces = JSON.parse(localStorage.getItem('workspaces') || '[]');
        const ws = workspaces.find((w: any) => w.path === savedLocalPath);
        if (ws) {
          setActiveWorkspace(ws);
          onWorkspaceChange?.(ws);
        }
        return;
      }
      
      // 2. 尝试从 workspaceService 恢复（云端/虚拟工作区）
      workspaceService.restoreFromStorage().then((ws) => {
        if (!mountedRef.current) return;
        if (ws) {
          setActiveWorkspace(ws);
          onWorkspaceChange?.(ws);
        }
      }).catch(() => { if (mountedRef.current) toast.error(t("workspace.restoreFailed")); });
    } catch (e) {
      if (import.meta.env?.DEV) console.warn('[WorkspaceFileTree] 恢复工作区失败:', e);
      toast.error(t("workspace.restoreFailed"));
    }
  }, [loadWorkspaces, onWorkspaceChange, electron, loadLocalFileTree]);
  
  // 工作区变化时重新加载文件树
  useEffect(() => {
    if (activeWorkspace) {
      loadFileTree();
    }
  }, [activeWorkspace, loadFileTree]);
  
  // 工作区真源：设置页修改 maibot_workspace_path 后同步到本组件并刷新
  useEffect(() => {
    const onWorkspaceContextChanged = (e: Event) => {
      const path = (e as CustomEvent<{ workspacePath?: string }>)?.detail?.workspacePath ?? '';
      if (path && electron?.readDirectory) {
        setLocalWorkspacePath(path);
        try { localStorage.setItem('localWorkspacePath', path); } catch { /* ignore */ }
        loadLocalFileTree(path);
      } else if (!path) {
        setLocalWorkspacePath(null);
        setFileTree(null);
        setLocalFileTree(null);
        try { localStorage.removeItem('localWorkspacePath'); } catch { /* ignore */ }
      }
    };
    window.addEventListener(EVENTS.WORKSPACE_CONTEXT_CHANGED, onWorkspaceContextChanged);
    return () => window.removeEventListener(EVENTS.WORKSPACE_CONTEXT_CHANGED, onWorkspaceContextChanged);
  }, [electron, loadLocalFileTree]);

  useEffect(() => {
    setRecentForBar(workspaceService.getRecentWorkspaces());
    const onChanged = () => setRecentForBar(workspaceService.getRecentWorkspaces());
    window.addEventListener(EVENTS.WORKSPACE_CONTEXT_CHANGED, onChanged);
    return () => window.removeEventListener(EVENTS.WORKSPACE_CONTEXT_CHANGED, onChanged);
  }, []);

  const handleQuickSwitchPath = useCallback(async (path: string) => {
    if (!path.trim() || quickSwitchPath) return;
    setQuickSwitchPath(path);
    try {
      await switchWorkspaceByPath(path);
      if (!mountedRef.current) return;
      setStorageItem('maibot_workspace_path', path);
      try { localStorage.setItem('localWorkspacePath', path); } catch { /* ignore */ }
      window.dispatchEvent(new CustomEvent(EVENTS.WORKSPACE_CONTEXT_CHANGED, { detail: { workspacePath: path } }));
      setLocalWorkspacePath(path);
      loadLocalFileTree(path);
      toast.success(t('workspace.workspaceSwitched'));
    } catch (e) {
      if (mountedRef.current) toast.error(t('settings.workspaceSwitchFailed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      if (mountedRef.current) setQuickSwitchPath(null);
    }
  }, [loadLocalFileTree, quickSwitchPath]);

  // 订阅文件事件 - 统一处理所有文件变更（防抖 200ms，避免事件风暴多次刷新）
  useEffect(() => {
    const unsubscribeWs = workspaceService.subscribe(() => {
      loadFileTreeDebounced();
    });

    const unsubscribeFile = fileEventBus.subscribe((event) => {
      if (import.meta.env?.DEV) console.log('[FileTree] 文件事件:', event.type, event.path);
      loadFileTreeDebounced();

      if (event.source === 'ai' && event.path) {
        const fileName = String(event.path).split('/').pop() || event.path;
        switch (event.type) {
          case 'file_created':
            toast.success(`文件已创建: ${fileName}`);
            break;
          case 'file_modified':
            toast.info(`文件已更新: ${fileName}`);
            break;
          case 'file_deleted':
            toast.info(`文件已删除: ${fileName}`);
            break;
          case 'dir_created':
            toast.success(`文件夹已创建: ${fileName}`);
            break;
          case 'file_renamed':
            toast.info(`文件已重命名: ${fileName}`);
            break;
        }
      }
    });

    return () => {
      if (loadFileTreeDebounceRef.current) {
        clearTimeout(loadFileTreeDebounceRef.current);
        loadFileTreeDebounceRef.current = null;
      }
      unsubscribeWs();
      unsubscribeFile();
    };
  }, [loadFileTreeDebounced]);
  // 刷新本地文件树
  const refreshLocalFileTree = useCallback(() => {
    if (localWorkspacePath) {
      if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] 手动刷新');
      loadLocalFileTree(localWorkspacePath);
    }
  }, [localWorkspacePath, loadLocalFileTree]);
  
  // 订阅文件事件 - 刷新本地文件树（防抖 200ms，与上处订阅统一节奏，避免重复刷新）
  useEffect(() => {
    if (!localWorkspacePath && workspaceFolders.length === 0) return;

    const unsubscribe = fileEventBus.subscribe(() => {
      if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] 文件事件刷新');
      debouncedRefreshLocalTree();
    });

    return () => {
      if (localRefreshDebounceRef.current) {
        clearTimeout(localRefreshDebounceRef.current);
        localRefreshDebounceRef.current = null;
      }
      unsubscribe();
    };
  }, [localWorkspacePath, workspaceFolders.length, debouncedRefreshLocalTree]);
  
  // ⌘P 快速打开：聚焦文件搜索框
  useEffect(() => {
    const handler = () => {
      setFileSearchQuery("");
      fileSearchInputRef.current?.focus();
    };
    window.addEventListener("focus_file_search" as any, handler);
    return () => window.removeEventListener("focus_file_search" as any, handler);
  }, []);

  // 在文件树中定位：Tab 右键「在文件树中定位」或状态栏单击
  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent<{ path: string }>).detail?.path;
      if (!path) return;
      setInternalSelectedPath(path);
      const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
      if (parts.length > 1) {
        const parentDirs = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
        setExpandedPaths((prev) => new Set([...prev, ...parentDirs]));
      }
    };
    window.addEventListener("file_tree_locate" as any, handler);
    return () => window.removeEventListener("file_tree_locate" as any, handler);
  }, []);

  // 定时轮询刷新文件树（每 5 秒检查一次，降低 IO/CPU；指纹未变时不 setState）
  useEffect(() => {
    if (workspaceFolders.length > 1) {
      const intervalId = setInterval(() => {
        loadLocalFileTrees(workspaceFolders, true);
      }, 5000);
      return () => clearInterval(intervalId);
    }
    if (!localWorkspacePath) return;
    
    const pollFailToastRef = { current: false };
    const intervalId = setInterval(() => {
      if (electron?.readDirectory) {
        electron.readDirectory({ dirPath: localWorkspacePath, depth: 4 })
          .then((result: any) => {
            if (!mountedRef.current) return;
            if (result?.success && result?.tree) {
              const newFp = treeFingerprint(result.tree);
              const oldFp = treeFingerprint(localFileTree);
              if (newFp !== oldFp) {
                if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] 文件变化自动刷新');
                setLocalFileTree(result.tree);
              }
            }
          })
          .catch((err) => {
            if (import.meta.env?.DEV) console.warn('[WorkspaceFileTree] 轮询读取目录失败:', err);
            if (mountedRef.current && !pollFailToastRef.current) {
              pollFailToastRef.current = true;
              toast.error(t('workspace.fileTreeLoadFailed'), { description: err instanceof Error ? err.message : String(err) });
            }
          });
      }
    }, 5000);
    
    return () => clearInterval(intervalId);
  }, [localWorkspacePath, localFileTree, workspaceFolders, electron, loadLocalFileTrees]);
  
  // 同步本地文件到后端（使用 LangGraph 工具）
  // 充分利用 LangGraph Server 的能力：通过 Agent 调用 WriteFileTool
  const syncLocalFilesToBackend = useCallback(async (basePath: string, tree: FileNode | null) => {
    if (!tree || !electron) return;
    
    let synced = 0;
    let failed = 0;
    
    // 提取工作区名称（用于路径前缀）
    const workspaceName = basePath.split('/').pop() || basePath.split('\\').pop() || 'workspace';
    
    // 递归遍历文件树，上传所有文件
    async function traverseAndUpload(node: FileNode, relativePath: string = '') {
      const currentPath = relativePath ? `${relativePath}/${node.name}` : node.name;
      // 使用统一的工作区路径前缀：workspace/{workspaceName}/...
      const backendPath = `workspace/${workspaceName}/${currentPath}`;
      
      if (node.type === 'file') {
        try {
          // 使用 Electron 读取文件内容
          const result = await electron.readFile({ filePath: node.path });
          if (result.success && result.content) {
            // 使用 LangGraph API 写入文件到后端
            // Agent 会自动调用 WriteFileTool，无需手动实现
            await langgraphApi.writeFile(backendPath, result.content);
            synced++;
            if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] 已同步:', backendPath);
          }
        } catch (error) {
          failed++;
          console.error(`[WorkspaceFileTree] ❌ 同步失败: ${backendPath}`, error);
        }
      } else if (node.children) {
        // 递归处理子节点
        for (const child of node.children) {
          await traverseAndUpload(child, currentPath);
        }
      }
    }
    
    try {
      await traverseAndUpload(tree);
      toast.success(`同步完成：${synced} 个文件成功${failed > 0 ? `，${failed} 个失败` : ''}`);
    } catch (error) {
      console.error('[WorkspaceFileTree] 同步过程出错:', error);
      toast.error('同步失败', { description: String(error) });
    }
  }, [electron]);
  
  // 选择本地文件夹 - Cursor 风格（打开 → 加载 → 同步）；防抖避免连续点击导致重复执行与崩溃
  const SELECT_FOLDER_DEBOUNCE_MS = 1200;
  const handleSelectFolder = async () => {
    const now = Date.now();
    if (now - lastSelectFolderAtRef.current < SELECT_FOLDER_DEBOUNCE_MS) return;
    lastSelectFolderAtRef.current = now;
    if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] handleSelectFolder', { isElectron: !!electron?.selectDirectory });
    try {
      if (electron?.selectDirectory) {
        const result = await electron.selectDirectory();
        if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] selectDirectory result:', result?.success);
        if (result.success && result.path) {
          const folderName = result.path.split('/').pop() || result.path.split('\\').pop() || '工作区';
          if (mountedRef.current) toast.info(`正在加载: ${folderName}...`);
          if (mountedRef.current) setLoading(true);
          let loadedTree: FileNode | null = null;
          try {
            // 首次打开仅读 4 层，减轻大仓库时渲染进程内存压力，避免切换文件夹后崩溃/重启
            const readResult = await electron.readDirectory({ dirPath: result.path, depth: 4 });
            if (!mountedRef.current) return;
            if (readResult && readResult.success && readResult.tree) {
              loadedTree = readResult.tree;
              setLocalFileTree(readResult.tree);
              setLocalWorkspacePath(result.path);
              const singleFolder = [{ path: result.path, name: folderName }];
              setWorkspaceFolders(singleFolder);
              setLocalFileTrees([]);
              try {
                localStorage.setItem(WORKSPACE_FOLDERS_KEY, JSON.stringify(singleFolder));
              } catch { /* ignore */ }
            }
          } catch (e: any) {
            console.error('[WorkspaceFileTree] 读取目录失败:', e);
          } finally {
            if (mountedRef.current) setLoading(false);
          }
          if (!mountedRef.current) return;
          const ws: WorkspaceInfo = {
            id: `local-${Date.now()}`,
            name: folderName,
            path: result.path,
            mode: 'linked',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            file_count: 0,
          };
          try {
            const workspaces = JSON.parse(getStorageItem('workspaces') || '[]') as WorkspaceInfo[];
            const existingIndex = workspaces.findIndex((w: WorkspaceInfo) => w.path === result.path);
            if (existingIndex >= 0) {
              workspaces[existingIndex] = ws;
            } else {
              workspaces.push(ws);
            }
            setStorageItem('workspaces', JSON.stringify(workspaces));
          } catch (e) {
            if (import.meta.env?.DEV) console.warn('[WorkspaceFileTree] Failed to save workspace:', e);
          }
          // linked 模式：setActiveWorkspace 内会先调后端 /workspace/switch 再写本地，避免重复调用
          try {
            await workspaceService.setActiveWorkspace(ws.id);
          } catch (e) {
            if (mountedRef.current) toast.error(t('settings.workspaceSwitchFailed', { msg: e instanceof Error ? e.message : 'unknown error' }));
            return;
          }
          if (!mountedRef.current) return;
          try {
            setStorageItem('maibot_workspace_path', result.path);
            localStorage.setItem('localWorkspacePath', result.path);
          } catch { /* ignore */ }
          // 延后派发与 setState，避免同一调用栈内触发大量监听器更新导致崩溃/重启
          setTimeout(() => {
            if (!mountedRef.current) return;
            window.dispatchEvent(new CustomEvent(EVENTS.WORKSPACE_CONTEXT_CHANGED, { detail: { workspacePath: result.path } }));
            setActiveWorkspace(ws);
            onWorkspaceChange?.(ws);
            if (loadedTree) {
              if (mountedRef.current) toast.info('正在同步文件到后端...');
              // 再延后执行同步，让窗口/监听器先稳定，避免同步期间内存与 CPU 峰值触发崩溃
              setTimeout(() => {
                if (!mountedRef.current) return;
                syncLocalFilesToBackend(result.path, loadedTree).then(() => {
                  if (mountedRef.current) toast.success(`已打开并同步: ${folderName}`);
                }).catch((err) => {
                  console.error('[WorkspaceFileTree] Sync failed:', err);
                  if (mountedRef.current) toast.warning(`已打开: ${folderName}（同步失败，AI 可能无法访问文件）`);
                });
              }, 400);
            } else {
              if (mountedRef.current) toast.success(`已打开: ${folderName}`);
            }
          }, 0);
        } else if (result.canceled) {
          if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] User canceled');
        } else {
          if (mountedRef.current) toast.error('打开文件夹失败', { description: result.error });
        }
        return;
      }
      
      // 2. Web 环境 - 尝试使用 File System Access API
      if (hasFileSystemAPI) {
        try {
          const dirHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
          const folderName = dirHandle.name;
          
          toast.info(`正在加载: ${folderName}...`);
          
          setWebDirHandle(dirHandle);
          
          const tree = await readDirectoryFromHandle(dirHandle, folderName, 5);
          if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] Directory loaded:', folderName);
          
          // 设置本地文件树
          setLocalFileTree(tree);
          setLocalWorkspacePath(folderName);
          const singleFolder = [{ path: folderName, name: folderName }];
          setWorkspaceFolders(singleFolder);
          setLocalFileTrees([]);
          try {
            localStorage.setItem(WORKSPACE_FOLDERS_KEY, JSON.stringify(singleFolder));
          } catch { /* ignore */ }
          
          // 先后端后写入：Web 路径也先调后端 /workspace/switch，成功后再写本地，避免前后端分叉
          try {
            await switchWorkspaceByPath(folderName);
          } catch (err) {
            toast.error(t('settings.workspaceSwitchFailed', { msg: err instanceof Error ? err.message : 'unknown error' }));
            return;
          }

          // 创建工作区记录并保存到本地存储
          const ws: WorkspaceInfo = {
            id: `web-${Date.now()}`,
            name: folderName,
            path: folderName,
            mode: 'linked',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            file_count: tree.children?.length || 0,
          };
          
          // 保存到工作区列表（与 workspace API 同源：safeStorage）
          try {
            const workspaces = JSON.parse(getStorageItem('workspaces') || '[]') as WorkspaceInfo[];
            const existingIndex = workspaces.findIndex((w: WorkspaceInfo) => w.name === folderName);
            if (existingIndex >= 0) {
              workspaces[existingIndex] = ws;
            } else {
              workspaces.push(ws);
            }
            setStorageItem('workspaces', JSON.stringify(workspaces));
            setStorageItem('activeWorkspaceId', ws.id);
            setStorageItem('maibot_workspace_path', folderName);
            localStorage.setItem('localWorkspacePath', folderName); // Web 模式用名称作为路径
          } catch (e) {
            if (import.meta.env?.DEV) console.warn('[WorkspaceFileTree] Failed to save workspace:', e);
          }
          // 延后派发与 setState，与 Electron 路径一致，避免同一调用栈内大量更新导致卡顿或异常
          setTimeout(async () => {
            if (!mountedRef.current) return;
            setActiveWorkspace(ws);
            onWorkspaceChange?.(ws);
            window.dispatchEvent(new CustomEvent(EVENTS.WORKSPACE_CONTEXT_CHANGED, { detail: { workspacePath: folderName } }));
            await loadWorkspaces();
            if (mountedRef.current) toast.success(`已打开: ${folderName}`);
            if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] Folder opened successfully');
          }, 0);
        } catch (e: unknown) {
          if (e instanceof Error && e.name !== 'AbortError') {
            console.error('[WorkspaceFileTree] File System Access API error:', e);
            toast.error('打开文件夹失败', { description: e.message });
          }
        }
      } else {
        // 不支持 File System Access API，提示用户
        toast.error('浏览器不支持打开本地文件夹', {
          description: '请使用 Electron 桌面版，或使用 Chrome/Edge 浏览器',
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[WorkspaceFileTree] handleSelectFolder error:', e);
      const is400Path = /400|工作区路径不存在|不是目录/i.test(msg);
      toast.error(is400Path ? t('settings.workspaceSwitchFailed', { msg: '工作区路径在后端不存在或不是目录。若后端在远程服务器，请确保选择服务器可访问的路径。' }) : '选择文件夹失败', {
        description: is400Path ? undefined : (msg.length <= 120 ? msg : `${msg.slice(0, 117)}…`),
      });
    }
  };
  
  // 工作区树形选择器：Composer「从工作区浏览文件」触发，选文件后回调加入对话上下文
  useEffect(() => {
    const handler = (e: CustomEvent<{ callback: (path: string, name: string) => void }>) => {
      const cb = e.detail?.callback;
      if (!cb) return;
      workspaceTreePickerCallbackRef.current = cb;
      setShowWorkspaceTreePicker(true);
    };
    window.addEventListener(EVENTS.OPEN_WORKSPACE_TREE_PICKER, handler as EventListener);
    return () => {
      window.removeEventListener(EVENTS.OPEN_WORKSPACE_TREE_PICKER, handler as EventListener);
      workspaceTreePickerCallbackRef.current = null;
    };
  }, []);

  // 快捷键：在文件树内选中文件时 Cmd+Shift+A / Ctrl+Shift+A 添加到对话上下文（多根时在任一棵树中查找）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'a' || (!e.metaKey && !e.ctrlKey) || !e.shiftKey) return;
      const el = document.activeElement;
      if (!workspaceTreeContainerRef.current?.contains(el)) return;
      if (!internalSelectedPath?.trim()) return;
      const trees = [fileTree, localFileTree, ...(localFileTrees ?? [])].filter(Boolean) as FileNode[];
      let node: FileNode | null = null;
      for (const tree of trees) {
        node = findNodeInTree(tree, internalSelectedPath);
        if (node) break;
      }
      if (node?.type === 'file') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(EVENTS.ADD_FILE_TO_CONTEXT, { detail: { path: internalSelectedPath } }));
        toast.success(t('composer.addedFileToContext'), { description: node.name });
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [internalSelectedPath, fileTree, localFileTree, localFileTrees]);

  // 切换到最近打开的文件夹（与 handleSelectFolder 一致：捕获错误并友好提示，避免未捕获导致崩溃/重启）；防抖
  const SWITCH_WORKSPACE_DEBOUNCE_MS = 800;
  const handleSwitchWorkspace = async (wsId: string) => {
    const now = Date.now();
    if (now - lastSwitchWorkspaceAtRef.current < SWITCH_WORKSPACE_DEBOUNCE_MS) return;
    lastSwitchWorkspaceAtRef.current = now;
    try {
      const ws = await workspaceService.setActiveWorkspace(wsId);
      const pathToSync = (ws.path ?? '').trim();
      setTimeout(() => {
        if (!mountedRef.current) return;
        setActiveWorkspace(ws);
        onWorkspaceChange?.(ws);
        setShowWorkspaceSelector(false);
        try {
          setStorageItem('maibot_workspace_path', pathToSync);
          if (pathToSync) {
            try { localStorage.setItem('localWorkspacePath', pathToSync); } catch { /* ignore */ }
          } else {
            try { localStorage.removeItem('localWorkspacePath'); } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
        window.dispatchEvent(new CustomEvent(EVENTS.WORKSPACE_CONTEXT_CHANGED, { detail: { workspacePath: pathToSync } }));
        toast.success(`已切换到 "${ws.name}"`);
      }, 0);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const is400Path = /400|工作区路径不存在|不是目录/i.test(msg);
      toast.error(is400Path ? t('settings.workspaceSwitchFailed', { msg: '工作区路径在后端不存在或不可用。若后端在远程，请确保选择服务器可访问的路径。' }) : '切换工作区失败', {
        description: is400Path ? undefined : (msg.length <= 120 ? msg : `${msg.slice(0, 117)}…`),
      });
    }
  };
  
  // 展开/折叠
  const handleToggle = (path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };
  
  // 文件类型分析（从路径取 basename 再取扩展名，避免 query 或多点的干扰）
  const analyzeFileType = (filePath: string) => {
    const basename = filePath.replace(/^.*[/\\]/, '').split('?')[0] || '';
    const ext = (basename.includes('.') ? (basename.split('.').pop() ?? '') : '').toLowerCase() || '';
    const binaryExts = new Set(['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'zip', 'rar', '7z']);
    const convertibleExts = new Set(['docx', 'doc']);
    const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico']);
    const svgExts = new Set(['svg']); // SVG 是文本格式
    
    return {
      extension: ext,
      isBinary: binaryExts.has(ext),
      isConvertible: convertibleExts.has(ext),
      isImage: imageExts.has(ext),
      isSvg: svgExts.has(ext),
      isPdf: ext === 'pdf',
    };
  };
  
  // 将 base64 转换为 ArrayBuffer
  const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  };
  
  // 读取文件内容（优先使用 Electron API，支持二进制转换）
  const readFileContent = async (filePath: string): Promise<string> => {
    if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] readFileContent:', filePath);
    
    const fileType = analyzeFileType(filePath);
    const fileName = filePath.split('/').pop() || filePath;
    if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] File type:', fileType);
    
    // 处理 docx：返回 base64 预览包（本地用 Electron IPC，否则走后端 readFileBinary）
    if (fileType.isConvertible) {
      const isLocal = fileSystemService.isLocalAbsolutePath(filePath);
      if (electron?.readFileBinary && isLocal) {
        if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] Reading docx for preview:', filePath);
        const result = await electron.readFileBinary({ filePath });
        if (!result.success) throw new Error(result.error || '读取失败');
        const base64Clean = (result.base64 || '').replace(/\s/g, '');
        if (!base64Clean.length) throw new Error('文件内容为空');
        return `__DOCX_PREVIEW__
${JSON.stringify({ fileName, filePath, base64: base64Clean, size: result.size ?? 0 })}
__DOCX_PREVIEW_END__`;
      }
      const result = await fileSystemService.readFileBinary(filePath);
      if (result.success && result.data?.base64) {
        const base64Clean = (result.data.base64 || '').replace(/\s/g, '');
        if (base64Clean.length) {
          return `__DOCX_PREVIEW__
${JSON.stringify({ fileName, filePath, base64: base64Clean, size: result.data.size ?? 0 })}
__DOCX_PREVIEW_END__`;
        }
      }
      throw new Error(result.error || '读取 Word 失败');
    }
    
    // 处理图片：返回 __IMAGE_PREVIEW__ 包供编辑区用 base64 渲染（与 PDF/DOCX 一致，避免仅传 markdown 导致 ImageViewer 无 src）
    if (fileType.isImage) {
      if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] Reading image:', filePath);
      const isLocal = fileSystemService.isLocalAbsolutePath(filePath);
      if (electron?.readFileBinary && isLocal) {
        const result = await electron.readFileBinary({ filePath });
        if (!result.success) throw new Error(result.error || '读取图片失败');
        const base64Clean = (result.base64 || '').replace(/\s/g, '');
        if (!base64Clean.length) throw new Error('文件内容为空');
        return `__IMAGE_PREVIEW__
${JSON.stringify({ fileName, filePath, base64: base64Clean, size: result.size ?? 0, extension: fileType.extension })}
__IMAGE_PREVIEW_END__`;
      }
      const result = await fileSystemService.readFileBinary(filePath);
      if (result.success && result.data?.base64) {
        const base64Clean = (result.data.base64 || '').replace(/\s/g, '');
        if (base64Clean.length) {
          return `__IMAGE_PREVIEW__
${JSON.stringify({ fileName, filePath, base64: base64Clean, size: result.data.size ?? 0, extension: fileType.extension })}
__IMAGE_PREVIEW_END__`;
        }
      }
      throw new Error((result as { error?: string })?.error || '读取图片失败');
    }
    
    // 处理 SVG（文本格式，可直接读取）
    if (fileType.isSvg && electron?.readFile) {
      if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] Reading SVG:', filePath);
      const result = await electron.readFile({ filePath });

      if (result && result.success && typeof result.content === 'string') {
        // 为 SVG 添加预览包装
        return `# 🎨 SVG 矢量图

<div style="text-align: center; padding: 20px; background: #f5f5f5; border-radius: 8px; margin-bottom: 16px;">
${result.content}
</div>

---

**源代码：**

\`\`\`xml
${result.content}
\`\`\`

> 💡 提示：SVG 是矢量图格式，可以直接编辑源代码。
`;
      }
      throw new Error(result && result.error ? result.error : '读取失败');
    }
    
    // 处理 PDF（本地用 Electron IPC，否则走后端 readFileBinary）
    if (fileType.isPdf) {
      const isLocal = fileSystemService.isLocalAbsolutePath(filePath);
      if (electron?.readFileBinary && isLocal) {
        if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] Reading PDF:', filePath);
        const result = await electron.readFileBinary({ filePath });
        if (!result?.success) throw new Error(result?.error || '读取 PDF 失败');
        return `__PDF_PREVIEW__
${JSON.stringify({ fileName, filePath, base64: result.base64, size: result.size })}
__PDF_PREVIEW_END__`;
      }
      const result = await fileSystemService.readFileBinary(filePath);
      if (result.success && result.data?.base64) {
        const base64Clean = (result.data.base64 || '').replace(/\s/g, '');
        if (base64Clean.length) {
          return `__PDF_PREVIEW__
${JSON.stringify({ fileName, filePath, base64: base64Clean, size: result.data.size ?? 0 })}
__PDF_PREVIEW_END__`;
        }
      }
      throw new Error(result.error || '读取 PDF 失败');
    }

    // Excel：返回 base64 预览包（本地路径用 Electron IPC，否则走后端 readFileBinary）
    const excelExts = ['xlsx', 'xls'];
    if (excelExts.includes(fileType.extension)) {
      const isLocal = fileSystemService.isLocalAbsolutePath(filePath);
      if (electron?.readFileBinary && isLocal) {
        const result = await electron.readFileBinary({ filePath });
        if (!result?.success) throw new Error(result?.error || '读取 Excel 失败');
        const base64Clean = (result.base64 || '').replace(/\s/g, '');
        if (!base64Clean.length) throw new Error('文件内容为空');
        return `__EXCEL_PREVIEW__
${JSON.stringify({ fileName, filePath, base64: base64Clean, size: result.size ?? 0 })}
__EXCEL_PREVIEW_END__`;
      }
      const result = await fileSystemService.readFileBinary(filePath);
      if (result.success && result.data?.base64) {
        const base64Clean = (result.data.base64 || '').replace(/\s/g, '');
        if (base64Clean.length) {
          return `__EXCEL_PREVIEW__
${JSON.stringify({ fileName, filePath, base64: base64Clean, size: result.data.size ?? 0 })}
__EXCEL_PREVIEW_END__`;
        }
      }
      const errMsg = result.error || '读取 Excel 失败';
      throw new Error(
        errMsg.includes('404') || errMsg.includes('not found')
          ? `文件不在工作区内或路径有误，请用「打开文件夹」打开包含该文件的目录后重试`
          : errMsg
      );
    }

    // PPT：返回 base64 预览包（本地用 Electron IPC，否则走后端 readFileBinary）
    const pptExts = ['pptx', 'ppt'];
    if (pptExts.includes(fileType.extension)) {
      const isLocal = fileSystemService.isLocalAbsolutePath(filePath);
      if (electron?.readFileBinary && isLocal) {
        const result = await electron.readFileBinary({ filePath });
        if (!result?.success) throw new Error(result?.error || '读取 PPT 失败');
        const base64Clean = (result.base64 || '').replace(/\s/g, '');
        if (!base64Clean.length) throw new Error('文件内容为空');
        return `__PPT_PREVIEW__
${JSON.stringify({ fileName, filePath, base64: base64Clean, size: result.size ?? 0 })}
__PPT_PREVIEW_END__`;
      }
      const result = await fileSystemService.readFileBinary(filePath);
      if (result.success && result.data?.base64) {
        const base64Clean = (result.data.base64 || '').replace(/\s/g, '');
        if (base64Clean.length) {
          return `__PPT_PREVIEW__
${JSON.stringify({ fileName, filePath, base64: base64Clean, size: result.data.size ?? 0 })}
__PPT_PREVIEW_END__`;
        }
      }
      throw new Error(result.error || '读取 PPT 失败');
    }

    // 处理其他二进制文件（未单独实现预览的格式，如部分音视频、压缩包等）
    if (fileType.isBinary) {
      return `# ⚠️ 二进制文件

文件：\`${filePath}\`

此文件是二进制格式（.${fileType.extension}），当前无法在编辑区预览。

**已支持预览的格式：**
- ✅ Markdown、纯文本、代码（.md、.txt、.js、.ts、.py、.json 等）
- ✅ Word（.docx）、Excel（.xlsx、.xls）、PPT（.pptx、.ppt）
- ✅ 图片（.png、.jpg、.gif、.webp 等）、SVG、PDF
`;
    }
    // 读取普通文本文件
    if (electron?.readFile) {
      if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] Using Electron readFile for text');
      const result = await electron.readFile({ filePath });
      if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] readFile result:', { success: result.success, contentLength: result.content?.length, error: result.error });
      if (result.success) {
        return result.content;
      }
      throw new Error(result.error || '读取失败');
    }
    
    // 降级到 LangGraph API
    if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] Using LangGraph API');
    try {
      const content = await langgraphApi.readFile(filePath);
      if (content) {
        return content;
      }
      throw new Error('读取失败：内容为空');
    } catch (e) {
      console.error('[WorkspaceFileTree] LangGraph readFile failed:', e);
      return `# ⚠️ 无法读取文件

文件：\`${filePath}\`

在 Web 模式下，需要使用 Electron 版本才能读取本地文件。

**解决方案：**
1. 使用 Electron 版本：\`npm run electron:dev\`
2. 或者将文件上传到工作区

> 提示：Electron 版本提供完整的本地文件系统访问能力。
`;
    }
  };
  
  // 选择文件（若已在编辑器中打开则仅切换 Tab，否则走 onFileSelect）
  const handleSelect = async (path: string) => {
    setInternalSelectedPath(path);
    if (openFilePaths?.includes(path) && onFocusOpenFile) {
      onFocusOpenFile(path);
      return;
    }
    if (onFileSelect) {
      try {
        const content = await readFileContent(path);
        onFileSelect(path, content);
      } catch (e) {
        console.error('[WorkspaceFileTree] handleSelect error:', e);
        toast.error('读取文件失败', { description: String(e) });
      }
    }
  };
  
  // 打开文件
  const handleOpen = async (path: string) => {
    if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] handleOpen:', path);
    if (onFileOpen) {
      try {
        const content = await readFileContent(path);
        if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] File content loaded for open, length:', content?.length);
        onFileOpen(path, content);
      } catch (e) {
        console.error('[WorkspaceFileTree] handleOpen error:', e);
        toast.error('打开文件失败', { description: String(e) });
      }
    }
  };
  
  // 重命名（内联输入，不再弹框）
  const handleRename = (path: string) => {
    const name = path.split('/').pop() || path.split('\\').pop() || '';
    setRenamingPath(path);
    setRenamingDraft(name);
  };
  const handleRenameConfirm = async (path: string, newName: string) => {
    if (!newName.trim()) {
      setRenamingPath(null);
      setRenamingDraft('');
      return;
    }
    try {
      const dir = path.includes('/') ? path.substring(0, path.lastIndexOf('/') + 1) : '';
      const newPath = dir + newName;
      await langgraphApi.renameFile(path, newPath);
      toast.success('重命名成功');
      if (workspaceFolders.length > 1) await loadLocalFileTrees(workspaceFolders);
      else if (localWorkspacePath) await loadLocalFileTree(localWorkspacePath);
      else await loadFileTree();
      if (onFileOpen) onFileOpen(path, `__FILE_RENAMED__:${newPath}`);
    } catch (e) {
      toast.error('重命名失败', { description: String(e) });
    } finally {
      setRenamingPath(null);
      setRenamingDraft('');
    }
  };
  const handleRenameCancel = () => {
    setRenamingPath(null);
    setRenamingDraft('');
  };
  
  // 删除：先打开确认弹窗，确认后执行
  const handleDelete = (path: string) => {
    setDeleteConfirmPath(path);
  };

  const performDelete = useCallback(async () => {
    const path = deleteConfirmPath;
    setDeleteConfirmPath(null);
    if (!path) return;
    try {
      await langgraphApi.deleteFile(path);
      toast.success('删除成功');
      if (workspaceFolders.length > 1) loadLocalFileTrees(workspaceFolders);
      else if (localWorkspacePath) loadLocalFileTree(localWorkspacePath);
      else loadFileTree();
      if (onFileOpen) onFileOpen(path, '__FILE_DELETED__');
    } catch (e) {
      toast.error('删除失败', { description: String(e) });
    }
  }, [deleteConfirmPath, workspaceFolders.length, localWorkspacePath, loadLocalFileTrees, loadLocalFileTree, loadFileTree, onFileOpen]);

  // 拖拽移动：将 fromPath 移动到 toDirPath 目录下
  const handleMove = async (fromPath: string, toDirPath: string) => {
    const base = fromPath.split('/').pop() || fromPath.split('\\').pop() || '';
    const sep = toDirPath.includes('\\') ? '\\' : '/';
    const newPath = (toDirPath.endsWith(sep) ? toDirPath : toDirPath + sep) + base;
    if (fromPath === newPath) return;
    try {
      await langgraphApi.renameFile(fromPath, newPath);
      toast.success('已移动');
      if (workspaceFolders.length > 1) await loadLocalFileTrees(workspaceFolders);
      else if (localWorkspacePath) await loadLocalFileTree(localWorkspacePath);
      else await loadFileTree();
      if (onFileOpen) onFileOpen(fromPath, `__FILE_RENAMED__:${newPath}`);
    } catch (e) {
      toast.error('移动失败', { description: String(e) });
    }
  };
  
  // 上传文件
  const handleUploadFiles = () => {
    if (!activeWorkspace) {
      toast.error('请先选择工作区');
      return;
    }
    setShowUploadDialog(true);
  };

  // 多根时根据路径解析所属工作区根
  const getRootForPath = useCallback((path: string): CCBWorkspaceFolder | null => {
    if (workspaceFolders.length > 0) {
      const root = workspaceFolders.find((f) => path === f.path || path.startsWith(f.path + '/') || path.startsWith(f.path + '\\'));
      if (root) return root;
    }
    if (localWorkspacePath) return { path: localWorkspacePath, name: localWorkspacePath.split('/').pop() ?? undefined };
    return null;
  }, [workspaceFolders, localWorkspacePath]);

  // 创建新文件（内联创建）
  const handleCreateFileInline = async (parentPath: string, name: string) => {
    if (!name.trim()) return;
    
    try {
      const fullPath = `${parentPath}/${name}`;
      const root = getRootForPath(parentPath);
      const basePath = root?.path ?? localWorkspacePath ?? activeWorkspace?.path ?? '';
      const workspaceName = root?.name ?? basePath.split('/').pop() ?? basePath.split('\\').pop() ?? 'default';
      const relativePath = fullPath.replace(basePath, '').replace(/^\//, '').replace(/^\\/, '');
      const backendPath = `workspace/${workspaceName}/${relativePath}`;
      
      // 1. Electron 环境：写入本地文件
      if (electron?.writeFile && basePath) {
        const result = await electron.writeFile({ filePath: fullPath, content: '' });
        if (!result.success) {
          throw new Error(result.error || '写入本地文件失败');
        }
        if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] 本地文件已创建:', fullPath);
      }
      
      // 2. 同步到后端
      await langgraphApi.writeFile(backendPath, '');
      if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] 后端文件已创建:', backendPath);
      
      // 3. 刷新文件树
      if (workspaceFolders.length > 1) {
        await loadLocalFileTrees(workspaceFolders);
      } else if (localWorkspacePath) {
        await loadLocalFileTree(localWorkspacePath);
      } else {
        await loadFileTree();
      }
      
      toast.success(`文件 "${name}" 已创建`);
      
      // 4. 自动打开新创建的文件
      if (onFileOpen) {
        onFileOpen(fullPath, '');
      }
    } catch (e) {
      console.error('[WorkspaceFileTree] 创建文件失败:', e);
      toast.error('创建文件失败', { description: String(e) });
    }
  };
  
  // 创建新文件夹（支持内联创建）
  const handleCreateFolderInline = async (parentPath: string, name: string) => {
    if (!name.trim()) return;
    
    try {
      const fullPath = `${parentPath}/${name}`;
      const root = getRootForPath(parentPath);
      const basePath = root?.path ?? localWorkspacePath ?? activeWorkspace?.path ?? '';
      const workspaceName = root?.name ?? basePath.split('/').pop() ?? basePath.split('\\').pop() ?? 'default';
      const relativePath = fullPath.replace(basePath, '').replace(/^\//, '').replace(/^\\/, '');
      const backendPath = `workspace/${workspaceName}/${relativePath}`;
      
      // 1. Electron 环境：创建本地文件夹
      if (electron?.createDirectory && basePath) {
        const result = await electron.createDirectory({ dirPath: fullPath });
        if (!result.success) {
          throw new Error(result.error || '创建本地文件夹失败');
        }
        if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] 本地文件夹已创建:', fullPath);
      }
      
      // 2. 同步到后端（通过创建一个 .gitkeep 文件来创建目录）
      await langgraphApi.writeFile(`${backendPath}/.gitkeep`, '');
      if (import.meta.env?.DEV) console.log('[WorkspaceFileTree] 后端文件夹已创建:', backendPath);
      
      // 3. 刷新文件树
      if (workspaceFolders.length > 1) {
        await loadLocalFileTrees(workspaceFolders);
      } else if (localWorkspacePath) {
        await loadLocalFileTree(localWorkspacePath);
      } else {
        await loadFileTree();
      }
      
      toast.success(`文件夹 "${name}" 已创建`);
    } catch (e) {
      console.error('[WorkspaceFileTree] 创建文件夹失败:', e);
      toast.error('创建文件夹失败', { description: String(e) });
    }
  };

  // 关闭工作区
  const handleCloseWorkspace = useCallback(() => {
    setLocalWorkspacePath(null);
    setActiveWorkspace(null);
    setLocalFileTree(null);
    setFileTree(null);
    setWorkspaceFolders([]);
    setLocalFileTrees([]);
    try {
      localStorage.removeItem('localWorkspacePath');
      localStorage.removeItem(WORKSPACE_FOLDERS_KEY);
    } catch { /* ignore */ }
    onWorkspaceChange?.(null);
    toast.info('工作区已关闭');
  }, [onWorkspaceChange]);

  // 打开工作区文件（.ccb-workspace）
  const handleOpenWorkspaceFile = useCallback(async () => {
    if (!electron?.selectDirectory || !electron?.readDirectory || !electron?.readFile) {
      toast.error('当前环境不支持打开工作区文件');
      return;
    }
    const result = await electron.selectDirectory();
    if (!result.success || result.canceled || !result.path) return;
    const dirPath = result.path;
    const dirResult = await electron.readDirectory({ dirPath, depth: 1 });
    if (!dirResult.success || !dirResult.tree?.children) {
      toast.error('无法读取文件夹');
      return;
    }
    const workspaceFile = dirResult.tree.children.find(
      (c) => c.type === 'file' && c.name.endsWith(WORKSPACE_FILE_EXT)
    );
    if (!workspaceFile) {
      toast.error('该文件夹中无 .ccb-workspace 文件');
      return;
    }
    const filePath = `${dirPath}/${workspaceFile.name}`;
    const readResult = await electron.readFile({ filePath });
    if (!readResult.success || readResult.content == null) {
      toast.error('读取工作区文件失败');
      return;
    }
    const workspace = parseWorkspaceFile(readResult.content);
    if (workspace.folders.length === 0) {
      toast.error('工作区文件为空');
      return;
    }
    setWorkspaceFolders(workspace.folders);
    const firstPath = workspace.folders[0].path;
    if (workspace.folders.length === 1) {
      setLocalWorkspacePath(firstPath);
      loadLocalFileTree(firstPath);
      setLocalFileTrees([]);
    } else {
      setLocalWorkspacePath(firstPath);
      setLocalFileTree(null);
      loadLocalFileTrees(workspace.folders);
    }
    const now = new Date().toISOString();
    const ws: WorkspaceInfo = {
      id: firstPath,
      name: workspaceFile.name.replace(WORKSPACE_FILE_EXT, ''),
      path: firstPath,
      mode: 'linked',
      created_at: now,
      updated_at: now,
      file_count: 0,
    };
    setActiveWorkspace(ws);
    onWorkspaceChange?.(ws);
    try {
      localStorage.setItem('localWorkspacePath', firstPath);
      localStorage.setItem(WORKSPACE_FOLDERS_KEY, JSON.stringify(workspace.folders));
    } catch { /* ignore */ }
    toast.success(workspace.folders.length > 1 ? `已打开工作区（${workspace.folders.length} 个文件夹）` : '已打开工作区');
  }, [electron, loadLocalFileTree, loadLocalFileTrees, onWorkspaceChange]);

  // 添加文件夹到当前工作区（多根）
  const handleAddFolder = useCallback(async () => {
    if (!electron?.selectDirectory) {
      toast.error('当前环境不支持添加文件夹');
      return;
    }
    const result = await electron.selectDirectory();
    if (!result.success || result.canceled || !result.path) return;
    const newFolder: CCBWorkspaceFolder = {
      path: result.path,
      name: result.path.split('/').pop() ?? result.path.split('\\').pop() ?? undefined,
    };
    const nextFolders =
      workspaceFolders.length > 0
        ? [...workspaceFolders, newFolder]
        : localWorkspacePath
          ? [{ path: localWorkspacePath, name: localWorkspacePath.split('/').pop() ?? undefined }, newFolder]
          : [newFolder];
    setWorkspaceFolders(nextFolders);
    if (nextFolders.length === 2 && localFileTree) {
      setLocalFileTree(null);
    }
    await loadLocalFileTrees(nextFolders);
    try {
      localStorage.setItem(WORKSPACE_FOLDERS_KEY, JSON.stringify(nextFolders));
      if (nextFolders.length === 1) localStorage.setItem('localWorkspacePath', nextFolders[0].path);
    } catch { /* ignore */ }
    toast.success('已添加文件夹');
  }, [workspaceFolders, localWorkspacePath, localFileTree, loadLocalFileTrees]);

  // 从工作区移除文件夹
  const handleRemoveFolder = useCallback(
    (folderPath: string) => {
      const next = workspaceFolders.filter((f) => f.path !== folderPath);
      if (next.length === 0) {
        handleCloseWorkspace();
        return;
      }
      setWorkspaceFolders(next);
      try {
        if (next.length === 0) {
          localStorage.removeItem(WORKSPACE_FOLDERS_KEY);
          localStorage.removeItem('localWorkspacePath');
        } else {
          localStorage.setItem(WORKSPACE_FOLDERS_KEY, JSON.stringify(next));
          localStorage.setItem('localWorkspacePath', next[0].path);
        }
      } catch { /* ignore */ }
      if (next.length === 1) {
        setLocalFileTrees([]);
        setLocalWorkspacePath(next[0].path);
        loadLocalFileTree(next[0].path);
      } else {
        loadLocalFileTrees(next);
      }
      toast.info('已从工作区移除该文件夹');
    },
    [workspaceFolders, loadLocalFileTree, loadLocalFileTrees, handleCloseWorkspace]
  );

  // 保存工作区为 .ccb-workspace（多根时保存所有文件夹）
  const handleSaveWorkspaceAs = useCallback(async () => {
    const basePath = localWorkspacePath || activeWorkspace?.path;
    if (!basePath) {
      toast.error('请先打开文件夹');
      return;
    }
    if (!electron?.writeFile) {
      toast.error('当前环境不支持保存工作区文件');
      return;
    }
    const folders =
      workspaceFolders.length > 0
        ? workspaceFolders
        : [{ path: basePath, name: basePath.split('/').pop() || basePath.split('\\').pop() || 'workspace' }];
    const name = basePath.split('/').pop() || basePath.split('\\').pop() || 'workspace';
    const filePath = `${basePath}/${name}${WORKSPACE_FILE_EXT}`;
    const content = serializeWorkspaceFile({ folders, settings: {} });
    const result = await electron.writeFile({ filePath, content });
    if (result.success) {
      toast.success(folders.length > 1 ? `已保存工作区（${folders.length} 个文件夹）` : `已保存到 ${name}${WORKSPACE_FILE_EXT}`);
    } else {
      toast.error('保存失败', { description: result.error });
    }
  }, [localWorkspacePath, activeWorkspace, workspaceFolders, electron]);

  const displayWorkspacePath = getCurrentWorkspacePathFromStorage().trim() || activeWorkspace?.path || localWorkspacePath || (workspaceFolders.length === 1 ? workspaceFolders[0].path : '');
  const hasWorkspace = Boolean(displayWorkspacePath || (workspaceFolders.length > 1));
  const displayName = workspaceFolders.length > 1
    ? `多文件夹 (${workspaceFolders.length})`
    : displayWorkspacePath
      ? (displayWorkspacePath.split('/').filter(Boolean).pop() || displayWorkspacePath.split('\\').filter(Boolean).pop() || displayWorkspacePath)
      : '';

  return (
    <div ref={workspaceTreeContainerRef} className="h-full min-h-0 overflow-hidden flex flex-col bg-background" tabIndex={-1}>
      {/* 当前工作区条：单源展示，切换入口唯一 */}
      <div className={`shrink-0 border-b border-border/40 ${compact ? 'px-1.5 py-1' : 'px-2 py-1.5'}`}>
        <div className="flex items-center justify-between gap-1.5">
          {hasWorkspace ? (
            <>
              <span className={`shrink-0 text-muted-foreground ${compact ? 'text-[10px]' : 'text-[11px]'}`}>
                当前工作区
              </span>
              <button
                onClick={handleSelectFolder}
                className="flex items-center gap-1.5 text-left hover:bg-muted/50 rounded px-1 py-0.5 flex-1 min-w-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                title={workspaceFolders.length > 1 ? workspaceFolders.map((f) => f.path).join('\n') : displayWorkspacePath}
                aria-label={t("workspace.switchWorkspaceAria")}
              >
                <Folder className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                <span className={`font-medium truncate ${compact ? 'text-[11px]' : 'text-xs'}`}>
                  {displayName || '工作区'}
                </span>
              </button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 shrink-0 text-xs"
                onClick={handleSelectFolder}
                title="切换工作区 (⌘O)"
                aria-label={t("workspace.switchWorkspaceAria")}
              >
                切换
              </Button>
            </>
          ) : (
            <>
              <span className={`text-muted-foreground ${compact ? 'text-[11px]' : 'text-xs'}`}>
                未选择工作区
              </span>
              <Button
                size="sm"
                variant="default"
                className="h-6 gap-1 shrink-0 text-xs"
                onClick={handleSelectFolder}
                aria-label={t("workspace.selectFolderAria")}
              >
                <FolderOpen2 className="h-3 w-3" />
                选择文件夹
              </Button>
            </>
          )}
        </div>
        {hasWorkspace && (
          <div className="flex items-center justify-between gap-1.5 mt-0.5">
            <button
              onClick={() => {
                const path = displayWorkspacePath || (workspaceFolders.length === 1 ? workspaceFolders[0].path : '');
                if (path) {
                  navigator.clipboard.writeText(path);
                  toast.success('路径已复制');
                }
              }}
              className="text-[9px] text-muted-foreground/70 truncate hover:text-muted-foreground transition-colors flex-1 min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
              title={`点击复制: ${displayWorkspacePath || (workspaceFolders[0]?.path ?? '')}`}
              aria-label={t("workspace.copyPathAria")}
            >
              {displayWorkspacePath || (workspaceFolders[0]?.path ?? '')}
            </button>
            {/* 工具栏：新建文件/文件夹、折叠、更多 */}
            <div className="flex items-center gap-0 shrink-0">
              <Button
                size="icon"
                variant="ghost"
                className="h-5 w-5 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                onClick={() => setRootInlineCreate('file')}
                aria-label={t("workspace.createFileAria")}
                title="新建文件 (⌘N)"
              >
                <FilePlus className="h-3 w-3" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-5 w-5 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                onClick={() => setRootInlineCreate('folder')}
                title="新建文件夹"
                aria-label={t("workspace.newFolderAria")}
              >
                <FolderPlus2 className="h-3 w-3" />
              </Button>
              {expandedPaths.size > 0 && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-5 w-5 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                  onClick={() => setExpandedPaths(new Set())}
                  title="折叠全部"
                  aria-label={t("workspace.collapseAllAria")}
                >
                  <ChevronsUpDown className="h-3 w-3" />
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-5 w-5 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                    title="更多"
                    aria-label={t("workspace.workspaceMoreActionsAria")}
                  >
                    <MoreVertical className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[180px]">
                  <DropdownMenuItem
                    onClick={() => window.dispatchEvent(new CustomEvent(EVENTS.COMMAND_PALETTE_COMMAND, { detail: { commandId: 'settings.workspaces' } }))}
                  >
                    <Settings className="h-3.5 w-3.5 mr-2" />
                    工作区设置…
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleOpenWorkspaceFile}>
                    <FolderOpen2 className="h-3.5 w-3.5 mr-2" />
                    打开工作区文件
                  </DropdownMenuItem>
                  {electron?.selectDirectory && (
                    <DropdownMenuItem onClick={handleAddFolder}>
                      <FolderPlus2 className="h-3.5 w-3.5 mr-2" />
                      添加文件夹
                    </DropdownMenuItem>
                  )}
                  {workspaceFolders.length > 1 && (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <Folder className="h-3.5 w-3.5 mr-2" />
                        从工作区移除
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {workspaceFolders.map((f) => (
                          <DropdownMenuItem
                            key={f.path}
                            onClick={() => handleRemoveFolder(f.path)}
                            className="text-muted-foreground"
                          >
                            {f.name || f.path.split('/').pop() || f.path.split('\\').pop() || f.path}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  )}
                  <DropdownMenuItem onClick={handleSaveWorkspaceAs}>
                    <File className="h-3.5 w-3.5 mr-2" />
                    保存工作区为...
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleCloseWorkspace} className="text-muted-foreground">
                    <X className="h-3.5 w-3.5 mr-2" />
                    关闭工作区
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )}
      </div>

      {/* 可选：最近工作区快捷行（最多 2 个，排除当前） */}
      {hasWorkspace && (() => {
        const currentPath = displayWorkspacePath || (workspaceFolders[0]?.path ?? '');
        const quickRecent = recentForBar
          .filter((r) => r.path && r.path !== currentPath)
          .slice(0, 2);
        if (quickRecent.length === 0) return null;
        return (
          <div className={`shrink-0 border-b border-border/30 ${compact ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}>
            <div className="flex items-center gap-1 flex-wrap">
              <Clock className="h-3 w-3 text-muted-foreground/70 shrink-0" aria-hidden />
              {quickRecent.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  disabled={quickSwitchPath !== null}
                  className="text-[10px] text-muted-foreground hover:text-foreground truncate max-w-[120px] px-1 py-0.5 rounded hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50 disabled:pointer-events-none"
                  title={r.path || r.name}
                  onClick={() => r.path && handleQuickSwitchPath(r.path)}
                  aria-label={`切换到 ${r.name}`}
                >
                  {r.name || (r.path?.split(/[/\\]/).filter(Boolean).pop() || r.path) || r.id}
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {/* 文件搜索（⌘P 快速打开时聚焦，支持模糊过滤） */}
      {(localFileTree || fileTree || (workspaceFolders.length > 1 && localFileTrees.length > 0)) && (localWorkspacePath || activeWorkspace || workspaceFolders.length > 0) && (
        <div className="shrink-0 px-2 pb-1.5">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              ref={fileSearchInputRef}
              type="text"
              placeholder={t("workspace.searchFilesPlaceholder")}
              value={fileSearchQuery}
              onChange={(e) => setFileSearchQuery(e.target.value)}
              className={`h-7 pl-7 text-xs bg-muted/30 border-border/50 focus-visible:ring-1 ${fileSearchQuery ? "pr-7" : "pr-2"}`}
              aria-label={t("workspace.searchFilesAria")}
            />
            {fileSearchQuery ? (
              <button
                type="button"
                onClick={() => setFileSearchQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary focus-visible:outline-none"
                aria-label={t("workspace.clearSearch")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      )}
      
      {/* 文件树 - 使用 overflow-auto 确保可滚动 */}
      <div className="flex-1 min-h-0 overflow-auto">
        <div className={compact ? 'p-1' : 'p-2'}>
          {/* 优先显示 Electron 本地文件树（单根或多根） */}
          {(localFileTree || (workspaceFolders.length > 1 && localFileTrees.length > 0)) ? (
            <>
              {/* 根目录内联新建（VSCode 风格，仅单根时显示） */}
              {rootInlineCreate && (localWorkspacePath || activeWorkspace?.path) && localFileTree && (
                <InlineInput
                  level={0}
                  type={rootInlineCreate}
                  compact={compact}
                  onSubmit={(name) => {
                    const basePath = localWorkspacePath || activeWorkspace?.path || '';
                    if (rootInlineCreate === 'file') {
                      handleCreateFileInline(basePath, name);
                    } else {
                      handleCreateFolderInline(basePath, name);
                    }
                    setRootInlineCreate(null);
                  }}
                  onCancel={() => setRootInlineCreate(null)}
                />
              )}
              {workspaceFolders.length > 1 ? (
                workspaceFolders.map((folder, i) => {
                  const tree = localFileTrees[i];
                  const children = tree?.children ?? [];
                  const filtered = children
                    .map((node) => filterFileNode(node, fileSearchQuery))
                    .filter((n): n is FileNode => n != null);
                  const showEmpty = fileSearchQuery.trim() ? filtered.length === 0 : children.length === 0;
                  return (
                    <div key={folder.path} className={compact ? 'mb-2' : 'mb-3'}>
                      <div className="flex items-center gap-1 px-1 py-0.5 text-xs font-medium text-muted-foreground border-b border-border/50 mb-1">
                        <Folder className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                        <span className="truncate">{folder.name || folder.path.split('/').pop() || folder.path.split('\\').pop() || '文件夹'}</span>
                      </div>
                      {showEmpty ? (
                        fileSearchQuery.trim() && filtered.length === 0 ? (
                          <div className="text-center py-4 text-muted-foreground text-xs" role="status" aria-live="polite" aria-label={t("workspace.noMatchAria")}>
                            <p>{t("workspace.noMatchFiles")}</p>
                            <Button variant="ghost" size="sm" className="mt-1" onClick={() => setFileSearchQuery('')} aria-label={t("workspace.clearSearch")}>
                              {t("workspace.clearSearch")}
                            </Button>
                          </div>
                        ) : (
                          <div className="text-center py-4 text-muted-foreground text-xs" role="status" aria-live="polite" aria-label={t("workspace.emptyFolderAria")}>{t("workspace.emptyFolder")}</div>
                        )
                      ) : (
                        filtered.map((node) => (
                          <FileTreeNode
                            key={node.path}
                            node={node}
                            level={0}
                            selectedPath={internalSelectedPath}
                            searchQuery={fileSearchQuery}
                            openFilePaths={openFilePaths}
                            expandedPaths={expandedPaths}
                            onToggle={handleToggle}
                            onSelect={handleSelect}
                            onOpen={handleOpen}
                            onRename={handleRename}
                            onDelete={handleDelete}
                            onMove={handleMove}
                            onCreateFile={handleCreateFileInline}
                            onCreateFolder={handleCreateFolderInline}
                            renamingPath={renamingPath}
                            renamingDraft={renamingDraft}
                            onRenamingDraftChange={setRenamingDraft}
                            onRenameConfirm={handleRenameConfirm}
                            onRenameCancel={handleRenameCancel}
                            compact={compact}
                          />
                        ))
                      )}
                    </div>
                  );
                })
              ) : localFileTree ? (
                <>
                  {localFileTree.children?.length ? (
                    (() => {
                      const filtered = localFileTree.children
                        .map((node) => filterFileNode(node, fileSearchQuery))
                        .filter((n): n is FileNode => n != null);
                      if (fileSearchQuery.trim() && filtered.length === 0) {
                        return (
                          <div className="text-center py-6 text-muted-foreground" role="status" aria-live="polite" aria-label={t("workspace.noMatchAria")}>
                            <Search className="h-6 w-6 mx-auto mb-2 opacity-50" aria-hidden />
                            <p className={compact ? 'text-xs' : 'text-sm'}>{t("workspace.noMatchFiles")}</p>
                            <p className="text-[10px] mt-1">{t("workspace.tryOtherKeywords")}</p>
                            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setFileSearchQuery('')} aria-label={t("workspace.clearSearch")}>
                              {t("workspace.clearSearch")}
                            </Button>
                          </div>
                        );
                      }
                      return filtered.map((node) => (
                        <FileTreeNode
                          key={node.path}
                          node={node}
                          level={0}
                          selectedPath={internalSelectedPath}
                          searchQuery={fileSearchQuery}
                          openFilePaths={openFilePaths}
                          expandedPaths={expandedPaths}
                          onToggle={handleToggle}
                          onSelect={handleSelect}
                          onOpen={handleOpen}
                          onRename={handleRename}
                          onDelete={handleDelete}
                          onMove={handleMove}
                          onCreateFile={handleCreateFileInline}
                          onCreateFolder={handleCreateFolderInline}
                          renamingPath={renamingPath}
                          renamingDraft={renamingDraft}
                          onRenamingDraftChange={setRenamingDraft}
                          onRenameConfirm={handleRenameConfirm}
                          onRenameCancel={handleRenameCancel}
                          compact={compact}
                        />
                      ));
                    })()
                  ) : (
                    <div className="text-center py-8 text-muted-foreground" role="status" aria-live="polite">
                      <FolderOpen className="h-8 w-8 mx-auto mb-2 opacity-50" aria-hidden />
                      <p className={compact ? 'text-xs' : 'text-sm'}>文件夹为空</p>
                    </div>
                  )}
                </>
              ) : null}
            </>
          ) : !getCurrentWorkspacePathFromStorage().trim() && !activeWorkspace && !localWorkspacePath ? (
            /* 未选择工作区时的空状态（与全局空状态结构统一） */
            <div className="flex flex-col items-center justify-center py-10 px-4 text-center text-muted-foreground" role="status" aria-live="polite">
              <div className="w-14 h-14 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
                <Folder className="h-7 w-7 text-amber-500" />
              </div>
              <p className={`${compact ? 'text-xs' : 'text-sm'} font-medium text-foreground mb-1`}>
                未选择工作区
              </p>
              <p className="text-xs text-muted-foreground mb-4">
                选择文件夹开始工作
              </p>
              <Button
                size="sm"
                variant="default"
                onClick={handleSelectFolder}
                className="gap-1.5 shadow-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                aria-label={t("workspace.selectFolderAria")}
              >
                <FolderOpen2 className="h-3.5 w-3.5" />
                选择文件夹
              </Button>
              
              {/* 最近打开 */}
              {workspaces.length > 0 && (
                <div className="mt-6 w-full border-t border-border/50 pt-4">
                  <p className="text-xs text-muted-foreground/70 mb-2 flex items-center gap-1.5">
                    <Clock className="h-3 w-3" />
                    最近打开
                  </p>
                  <div className="space-y-0.5">
                    {workspaces.slice(0, 5).map((ws) => (
                      <button
                        key={ws.id}
                        onClick={() => handleSwitchWorkspace(ws.id)}
                        className="w-full flex items-center gap-2 p-2 rounded-md text-left hover:bg-muted/50 text-xs group transition-colors"
                      >
                        <Folder className="h-3.5 w-3.5 text-amber-500 shrink-0 group-hover:scale-105 transition-transform" />
                        <span className="truncate flex-1 text-foreground/80 group-hover:text-foreground">{ws.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              
              {/* 快捷键提示 */}
              <div className="mt-4 text-[10px] text-muted-foreground/50 flex items-center gap-1">
                <kbd className="px-1 py-0.5 bg-muted/50 rounded text-[9px] font-mono">⌘</kbd>
                <span>+</span>
                <kbd className="px-1 py-0.5 bg-muted/50 rounded text-[9px] font-mono">O</kbd>
                <span className="ml-1">打开文件夹</span>
              </div>
            </div>
          ) : showLoadingSpinner && !fileTree ? (
            <div className="text-center py-8 text-muted-foreground" role="status" aria-live="polite">
              <RefreshCw className="h-6 w-6 mx-auto mb-2 animate-spin" aria-hidden />
              <p className={compact ? 'text-xs' : 'text-sm'}>加载中...</p>
            </div>
          ) : fileTree ? (
            fileTree.children?.length ? (
              (() => {
                const filtered = fileTree.children
                  .map((node) => filterFileNode(node, fileSearchQuery))
                  .filter((n): n is FileNode => n != null);
                if (fileSearchQuery.trim() && filtered.length === 0) {
                  return (
                    <div className="text-center py-6 text-muted-foreground" role="status" aria-live="polite" aria-label={t("workspace.noMatchAria")}>
                      <Search className="h-6 w-6 mx-auto mb-2 opacity-50" aria-hidden />
                      <p className={compact ? 'text-xs' : 'text-sm'}>{t("workspace.noMatchFiles")}</p>
                      <p className="text-[10px] mt-1">{t("workspace.tryOtherKeywords")}</p>
                      <Button variant="ghost" size="sm" className="mt-2" onClick={() => setFileSearchQuery('')} aria-label={t("workspace.clearSearch")}>
                        {t("workspace.clearSearch")}
                      </Button>
                    </div>
                  );
                }
                return filtered.map((node) => (
                  <FileTreeNode
                    key={node.path}
                    node={node}
                    level={0}
                    selectedPath={internalSelectedPath}
                    searchQuery={fileSearchQuery}
                    openFilePaths={openFilePaths}
                    expandedPaths={expandedPaths}
                    onToggle={handleToggle}
                    onSelect={handleSelect}
                    onOpen={handleOpen}
                    onRename={handleRename}
                    onDelete={handleDelete}
                    onMove={handleMove}
                    onCreateFile={handleCreateFileInline}
                    onCreateFolder={handleCreateFolderInline}
                    renamingPath={renamingPath}
                    renamingDraft={renamingDraft}
                    onRenamingDraftChange={setRenamingDraft}
                    onRenameConfirm={handleRenameConfirm}
                    onRenameCancel={handleRenameCancel}
                    compact={compact}
                  />
                ));
              })()
            ) : (
              <div className="text-center py-8 text-muted-foreground" role="status" aria-live="polite">
                <FolderOpen className="h-8 w-8 mx-auto mb-2 opacity-50" aria-hidden />
                <p className={compact ? 'text-xs' : 'text-sm'}>文件夹为空</p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  onClick={() => setRootInlineCreate('file')}
                  aria-label={t("workspace.createFileAria")}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  创建文件
                </Button>
              </div>
            )
          ) : (
            <div className="text-center py-8 text-muted-foreground" role="status" aria-live="polite">
              <p className={compact ? 'text-xs' : 'text-sm'}>无法加载文件</p>
              <Button
                size="sm"
                variant="ghost"
                className="mt-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                onClick={loadFileTree}
                aria-label={t("workspace.retryLoadAria")}
              >
                <RefreshCw className="h-3.5 w-3.5 mr-1" />
                重试
              </Button>
            </div>
          )}
        </div>
      </div>
      
      {/* 最近打开的文件夹 - VSCode 风格 */}
      <Dialog open={showWorkspaceSelector} onOpenChange={(open) => {
        setShowWorkspaceSelector(open);
        if (open) setRecentWorkspaces(workspaceService.getRecentWorkspaces());
      }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Folder className="h-5 w-5 text-amber-500" />
              最近打开
            </DialogTitle>
            <DialogDescription>选择一个最近打开的文件夹</DialogDescription>
          </DialogHeader>
          <div className="py-2 space-y-1 max-h-60 overflow-y-auto">
            {recentWorkspaces.length > 0 ? (
              recentWorkspaces.map((recent) => (
                <button
                  key={recent.id}
                  type="button"
                  onClick={() => {
                    const ws = workspaces.find(w => w.id === recent.id);
                    if (ws) {
                      handleSwitchWorkspace(ws.id);
                    } else {
                      if (recent.path && electron?.readDirectory) {
                        setLocalWorkspacePath(recent.path);
                        loadLocalFileTree(recent.path);
                      }
                    }
                    setShowWorkspaceSelector(false);
                  }}
                  className={`group w-full flex items-center gap-2 p-2 rounded text-left transition-colors ${
                    activeWorkspace?.id === recent.id 
                      ? 'bg-muted' 
                      : 'hover:bg-muted/50'
                  }`}
                >
                  <Folder className="h-4 w-4 text-amber-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{recent.name}</div>
                    {recent.path && (
                      <div className="text-[10px] text-muted-foreground truncate">{recent.path}</div>
                    )}
                    <div className="text-[9px] text-muted-foreground/70">
                      {new Date(recent.lastOpened).toLocaleDateString()}
                    </div>
                  </div>
                  <span
                    role="button"
                    tabIndex={0}
                    className="p-1 hover:bg-destructive/10 rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                    title="从最近列表移除"
                    onClick={(e) => {
                      e.stopPropagation();
                      workspaceService.removeFromRecent(recent.id);
                      setRecentWorkspaces(workspaceService.getRecentWorkspaces());
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        workspaceService.removeFromRecent(recent.id);
                        setRecentWorkspaces(workspaceService.getRecentWorkspaces());
                      }
                    }}
                  >
                    <Trash2 className="h-3 w-3 text-muted-foreground" />
                  </span>
                </button>
              ))
            ) : (
              <div className="text-center py-4 text-muted-foreground text-sm" role="status" aria-live="polite">
                {t("workspace.noRecentFolders")}
              </div>
            )}
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => {
                workspaceService.clearRecentWorkspaces();
                setRecentWorkspaces([]);
                setShowWorkspaceSelector(false);
                toast.info('已清空最近打开列表');
              }}
              className="text-xs"
            >
              清空列表
            </Button>
            <Button onClick={() => { setShowWorkspaceSelector(false); handleSelectFolder(); }}>
              <FolderOpen2 className="h-4 w-4 mr-1.5" />
              打开其他文件夹
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 从工作区浏览文件（Composer 右键/菜单「从工作区浏览文件」） */}
      <Dialog open={showWorkspaceTreePicker} onOpenChange={(open) => { if (!open) { workspaceTreePickerCallbackRef.current = null; setShowWorkspaceTreePicker(false); } }}>
        <DialogContent className="max-w-md max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-sky-500" />
              从工作区选择文件
            </DialogTitle>
            <DialogDescription>点击文件可加入对话上下文，无需先打开该文件</DialogDescription>
          </DialogHeader>
          <ScrollArea className="flex-1 min-h-0 border rounded-md p-1 max-h-[min(60vh,400px)]">
            {(fileTree ?? localFileTree ?? localFileTrees?.[0] ?? null) ? (
              <TreePickerNode
                node={fileTree ?? localFileTree ?? localFileTrees?.[0]!}
                onSelectFile={(path, name) => {
                  workspaceTreePickerCallbackRef.current?.(path, name);
                  workspaceTreePickerCallbackRef.current = null;
                  setShowWorkspaceTreePicker(false);
                }}
              />
            ) : (
              <div className="py-8 text-center text-sm text-muted-foreground">
                请先打开工作区文件夹
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
      
      <AlertDialog open={deleteConfirmPath !== null} onOpenChange={(open) => !open && setDeleteConfirmPath(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteConfirmPath != null ? `确定要删除 "${deleteConfirmPath}" 吗？` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={performDelete}>确定删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 文件上传对话框 */}
      {/* 
      {activeWorkspace && (
        <UnifiedFileUploadDialog ... />
      )}
      */}
    </div>
  );
}

export default WorkspaceFileTree;
