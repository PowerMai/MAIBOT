/**
 * 生成式 UI 组件 - Claude/Cursor 顶级实现（单一实现，无重复）
 *
 * 使用边界：消息内带 part.ui 的 Part 由 GenerativeUIMessagePart 渲染；工具结果、任务详情、视觉分析等直接使用 GenerativeUI。
 *
 * 设计原则：
 * 1. 每个组件都是多功能的交互组件，不仅仅是显示
 * 2. 支持用户操作：复制、下载、编辑、导出、在编辑器中打开
 * 3. 与 Agent 双向交互：用户操作可以触发 Agent 响应
 * 4. 响应式设计：适应不同屏幕尺寸
 * 5. 可访问性：支持键盘导航和屏幕阅读器
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from "react";
import type { FC } from "react";
import { cn } from "../ui/utils";
import { Button } from "../ui/button";
import { ErrorBoundary } from "../common/ErrorBoundary";
import { 
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  CheckIcon,
  FileTextIcon,
  TableIcon,
  CodeIcon,
  ImageIcon,
  BarChart3,
  QuoteIcon,
  ListChecksIcon,
  ExternalLinkIcon,
  DownloadIcon,
  EditIcon,
  RefreshCwIcon,
  MaximizeIcon,
  FilterIcon,
  SortAscIcon,
  SearchIcon,
  PlayIcon,
  PauseIcon,
  RotateCcwIcon,
  SaveIcon,
  ShareIcon,
  MoreHorizontalIcon,
  ZoomInIcon,
  ZoomOutIcon,
  XIcon,
  Columns3Icon,
  CalendarClockIcon,
  FormInputIcon,
  Loader2,
  GitCompare,
  CircleDot,
  Terminal,
} from "lucide-react";
import { fileEventBus } from "../../lib/events/fileEvents";
import { EVENTS } from "../../lib/constants";
import { toast } from "sonner";
import { t } from "../../lib/i18n";
import ReactMarkdown from "react-markdown";
import { remarkPluginsWithMath, rehypePluginsMath } from "../../lib/markdownRender";
import "katex/dist/katex.min.css";

interface GenerativeUIProps {
  ui: {
    type: string;
    [key: string]: any;
  };
  onAction?: (action: string, data: any) => void;
}

// ============================================================
// 通用工具栏组件
// ============================================================
interface ToolbarAction {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "destructive";
}

const TOOLBAR_VISIBILITY_CLASS =
  "opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity";

const copyWithFeedback = (text: string, successText = t("genUI.copiedToClipboard")) => {
  if (!navigator.clipboard?.writeText) {
    toast.error(t("genUI.copyNotSupported"));
    return;
  }
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success(successText))
    .catch(() => toast.error(t("common.copyFailedManual")));
};

const onEnterOrSpace = (event: React.KeyboardEvent, action: () => void) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
};

const Toolbar: FC<{
  actions: ToolbarAction[];
  className?: string;
}> = ({ actions, className }) => {
  return (
    <TooltipProvider delayDuration={300}>
      <div className={cn("flex items-center gap-0.5", className)}>
        {actions.map((action, idx) => (
          <Tooltip key={idx}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => { e.stopPropagation(); action.onClick(); }}
                disabled={action.disabled}
                aria-label={action.label}
                title={action.label}
                className={cn(
                  "h-6 w-6 p-0 text-muted-foreground hover:text-foreground",
                  action.variant === "destructive" && "hover:text-red-500"
                )}
              >
                {action.icon}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {action.label}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
};

// ============================================================
// 表格组件 - 多功能版
// ============================================================
const MAX_TABLE_ROWS = 50;
const MAX_TABLE_COLUMNS = 10;

const TableUI: FC<{ 
  columns: string[]; 
  data: any[];
  title?: string;
  caption?: string;
  onAction?: (action: string, data: any) => void;
}> = ({ columns, data, title, caption, onAction }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [filterText, setFilterText] = useState("");
  const [showFilter, setShowFilter] = useState(false);
  
  // 过滤和排序数据
  const processedData = useMemo(() => {
    let result = [...data];
    
    // 过滤
    if (filterText) {
      const lower = filterText.toLowerCase();
      result = result.filter(row => 
        columns.some(col => String(row[col] ?? "").toLowerCase().includes(lower))
      );
    }
    
    // 排序
    if (sortColumn) {
      result.sort((a, b) => {
        const aVal = a[sortColumn] ?? "";
        const bVal = b[sortColumn] ?? "";
        const cmp = String(aVal).localeCompare(String(bVal), undefined, { numeric: true });
        return sortDirection === "asc" ? cmp : -cmp;
      });
    }
    
    return result;
  }, [data, columns, filterText, sortColumn, sortDirection]);
  
  const limitedColumns = columns.slice(0, MAX_TABLE_COLUMNS);
  const limitedData = showAll ? processedData : processedData.slice(0, MAX_TABLE_ROWS);
  const hasMoreRows = processedData.length > MAX_TABLE_ROWS;
  const hasMoreColumns = columns.length > MAX_TABLE_COLUMNS;
  
  // 复制表格数据
  const handleCopy = useCallback(() => {
    const header = columns.join("\t");
    const rows = data.map(row => columns.map(col => row[col] ?? "").join("\t"));
    const text = [header, ...rows].join("\n");
    copyWithFeedback(text, t("genUI.tableCopied"));
    setCopied(true);
    if (copiedResetTimerRef.current) clearTimeout(copiedResetTimerRef.current);
    copiedResetTimerRef.current = setTimeout(() => {
      copiedResetTimerRef.current = null;
      setCopied(false);
    }, 2000);
    onAction?.("copy_table", { title: title || "table", text });
  }, [columns, data, onAction, title]);

  useEffect(() => {
    return () => {
      if (copiedResetTimerRef.current) clearTimeout(copiedResetTimerRef.current);
    };
  }, []);
  
  // 导出为 CSV
  const handleExportCSV = useCallback(() => {
    const header = columns.join(",");
    const rows = data.map(row => 
      columns.map(col => {
        const val = String(row[col] ?? "");
        return val.includes(",") ? `"${val}"` : val;
      }).join(",")
    );
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title || "table"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    onAction?.("export_table_csv", { title: title || "table", rows: data.length, columns: columns.length });
  }, [columns, data, onAction, title]);
  
  // 请求 Agent 分析
  const handleAnalyze = useCallback(() => {
    onAction?.("analyze_table", { columns, data, title });
  }, [columns, data, title, onAction]);
  
  // 排序处理
  const handleSort = useCallback((col: string) => {
    if (sortColumn === col) {
      setSortDirection(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortColumn(col);
      setSortDirection("asc");
    }
  }, [sortColumn]);
  
  // 在编辑器中打开为 CSV
  const handleOpenInEditor = useCallback(() => {
    const header = columns.join(",");
    const rows = data.map(row =>
      columns.map(col => {
        const val = String(row[col] ?? "");
        return val.includes(",") || val.includes('"') ? `"${val.replace(/"/g, '""')}"` : val;
      }).join(",")
    );
    const csvContent = [header, ...rows].join("\n");
    const tempName = `${(title || "table").replace(/\s+/g, "_")}_${Date.now()}.csv`;
    fileEventBus.openFile(`__artifact__/${tempName}`, csvContent);
    onAction?.("open_table_in_editor", { filename: tempName, content: csvContent });
  }, [columns, data, onAction, title]);

  const toolbarActions: ToolbarAction[] = [
    { icon: <FilterIcon className="size-3" />, label: t("genUI.filter"), onClick: () => setShowFilter(!showFilter) },
    { icon: copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />, label: t("common.copy"), onClick: handleCopy },
    { icon: <DownloadIcon className="size-3" />, label: t("genUI.exportCsv"), onClick: handleExportCSV },
    { icon: <ExternalLinkIcon className="size-3" />, label: t("toolCard.openInEditor"), onClick: handleOpenInEditor },
    { icon: <RefreshCwIcon className="size-3" />, label: t("genUI.analyzeData"), onClick: handleAnalyze },
  ];
  
  return (
    <div className={cn(
      "my-2 rounded-md border overflow-hidden",
      "bg-muted/30 border-border/50",
    )}>
      {/* 头部 */}
      <div className="group flex items-center justify-between px-2.5 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors">
        <div 
          className="flex items-center gap-2 flex-1"
          onClick={() => setIsExpanded(!isExpanded)}
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          onKeyDown={(e) => onEnterOrSpace(e, () => setIsExpanded(!isExpanded))}
        >
          <div className="text-muted-foreground">
            {isExpanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
          </div>
          <TableIcon className="size-3.5 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">
            {title || t("genUI.table")}
          </span>
          <span className="text-xs text-muted-foreground">
            {filterText ? `${processedData.length}/${data.length}` : data.length} × {columns.length}
          </span>
        </div>
        <div className={TOOLBAR_VISIBILITY_CLASS}>
          <Toolbar actions={toolbarActions} />
        </div>
      </div>
      
      {/* 可折叠区域：筛选 + 表格（grid 平滑过渡） */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out overflow-hidden"
        style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}
      >
        <div className="min-h-0">
          {/* 筛选栏 */}
          {showFilter && (
            <div className="px-2.5 py-1.5 border-t border-border/30 bg-muted/20">
              <div className="flex items-center gap-2">
                <SearchIcon className="size-3.5 text-muted-foreground" />
                <input
                  type="text"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder={t("genUI.searchTable")}
                  className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  autoFocus
                />
                {filterText && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setFilterText("")}
                    className="h-5 w-5 p-0"
                  >
                    <XIcon className="size-3" />
                  </Button>
                )}
              </div>
            </div>
          )}
          <div className="max-h-[400px] overflow-y-auto border-t border-border/30 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/30">
                {limitedColumns.map((col, idx) => (
                  <th 
                    key={idx} 
                    className="px-2.5 py-1.5 text-left text-xs font-medium text-muted-foreground border-b border-border/30 cursor-pointer hover:bg-muted/50 select-none"
                    onClick={() => handleSort(col)}
                    role="button"
                    tabIndex={0}
                    aria-label={`按 ${col} 排序`}
                    onKeyDown={(e) => onEnterOrSpace(e, () => handleSort(col))}
                  >
                    <div className="flex items-center gap-1">
                      {col}
                      {sortColumn === col && (
                        <SortAscIcon className={cn("size-3", sortDirection === "desc" && "rotate-180")} />
                      )}
                    </div>
                  </th>
                ))}
                {hasMoreColumns && (
                  <th className="px-2.5 py-1.5 text-left text-xs font-medium text-muted-foreground border-b border-border/30">
                    ...
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {limitedData.map((row, rowIdx) => (
                <tr key={rowIdx} className="border-b border-border/20 last:border-b-0 hover:bg-muted/20">
                  {limitedColumns.map((col, colIdx) => (
                    <td key={colIdx} className="px-2.5 py-1.5 text-foreground">
                      {String(row[col] ?? "")}
                    </td>
                  ))}
                  {hasMoreColumns && (
                    <td className="px-2.5 py-1.5 text-muted-foreground">...</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          
          {hasMoreRows && !showAll && (
            <div className="px-2.5 py-1.5 text-center border-t border-border/30">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAll(true)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                显示全部 {processedData.length} 行
              </Button>
            </div>
          )}
          {processedData.length > 100 && (
            <div className="px-2.5 py-1 text-[11px] text-muted-foreground border-t border-border/30 bg-muted/20">
              大数据量已启用滚动预览，后续可切换虚拟滚动以进一步优化性能。
            </div>
          )}
          </div>
          {caption && (
            <div className="px-2.5 py-1 border-t border-border/30 text-xs text-muted-foreground">
              {caption}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// Shiki 语言别名 -> 规范 lang
const SHIKI_LANG_MAP: Record<string, string> = {
  py: "python",
  python: "python",
  js: "javascript",
  javascript: "javascript",
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  json: "json",
  sql: "sql",
  bash: "bash",
  sh: "shell",
  shell: "shell",
  md: "markdown",
  markdown: "markdown",
  yaml: "yaml",
  yml: "yaml",
  html: "html",
  css: "css",
};

function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

let shikiPromise: Promise<typeof import("shiki")> | null = null;
const loadShiki = () => {
  if (!shikiPromise) shikiPromise = import("shiki");
  return shikiPromise;
};

async function renderCodeToHtml(code: string, lang: string): Promise<string> {
  try {
    const { codeToHtml } = await loadShiki();
    const isDark =
      typeof document !== "undefined" && document.documentElement.classList.contains("dark");
    return await codeToHtml(code, {
      lang,
      theme: isDark ? "github-dark-default" : "light-plus",
    });
  } catch {
    const safe = escapeHtml(code);
    return `<pre class="shiki"><code class="language-${lang}">${safe}</code></pre>`;
  }
}

// ============================================================
// 代码组件 - 多功能版（Shiki 语法高亮）
// ============================================================
const MAX_CODE_LINES = 100;

const CodeUI: FC<{
  code: string;
  language?: string;
  filename?: string;
  title?: string;
  onAction?: (action: string, data: any) => void;
}> = ({ code, language, filename, title, onAction }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [copied, setCopied] = useState(false);
  const copiedResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const [isHighlighting, setIsHighlighting] = useState(true);
  const appliedResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rawLang = language ? language.toLowerCase() : "plaintext";
  const safeLang = rawLang && SHIKI_LANG_MAP[rawLang] ? SHIKI_LANG_MAP[rawLang] : "text";
  const codeLines = useMemo(() => code.split("\n"), [code]);
  const displayCode = useMemo(
    () => (showAll ? code : codeLines.slice(0, MAX_CODE_LINES).join("\n")),
    [code, codeLines, showAll],
  );
  const displayCodeLines = useMemo(() => displayCode.split("\n"), [displayCode]);
  const hasMoreLines = codeLines.length > MAX_CODE_LINES;

  useEffect(() => {
    if (!displayCode) {
      setHighlightedHtml(null);
      setIsHighlighting(false);
      return;
    }
    let cancelled = false;
    setIsHighlighting(true);
    const isDark =
      typeof document !== "undefined" && document.documentElement.classList.contains("dark");
    const theme = isDark ? "github-dark-default" : "light-plus";
    renderCodeToHtml(displayCode, safeLang)
      .then((html) => {
        if (!cancelled) { setHighlightedHtml(html); setIsHighlighting(false); }
      })
      .catch(() => {
        if (!cancelled) { setHighlightedHtml(null); setIsHighlighting(false); }
      });
    return () => { cancelled = true; };
  }, [displayCode, safeLang]);
  
  const handleCopy = useCallback(() => {
    copyWithFeedback(code, t("genUI.codeCopied"));
    setCopied(true);
    if (copiedResetTimerRef.current) clearTimeout(copiedResetTimerRef.current);
    copiedResetTimerRef.current = setTimeout(() => {
      copiedResetTimerRef.current = null;
      setCopied(false);
    }, 2000);
    onAction?.("copy_code", { code, filename, language: language || "text" });
  }, [code, filename, language, onAction]);
  
  // 在编辑器中打开（无工作区路径时用虚拟路径前缀）
  const handleOpenInEditor = useCallback(() => {
    if (filename) {
      fileEventBus.openFile(filename, code);
      onAction?.("open_code_in_editor", { filename, language: language || "text" });
    } else {
      const ext = language === "python" ? "py" : language === "javascript" ? "js" : language === "typescript" ? "ts" : "txt";
      const tempName = `untitled-${Date.now()}.${ext}`;
      fileEventBus.openFile(`__artifact__/${tempName}`, code);
      onAction?.("open_code_in_editor", { filename: tempName, language: language || "text" });
    }
  }, [filename, language, code, onAction]);

  // Apply：将代码写入目标文件（与 markdown 代码块一致：先读原内容再写，应用后派发 diff 在编辑区展示）
  const [applied, setApplied] = useState(false);
  const handleApply = useCallback(async () => {
    if (!filename || !code) return;
    try {
      const { default: langgraphApi } = await import("../../lib/langgraphApi");
      let originalContent = "";
      try {
        originalContent = await langgraphApi.readFile(filename);
      } catch {
        // 文件可能不存在，视为空
      }
      await langgraphApi.writeFile(filename, code);
      fileEventBus.openFile(filename);
      setApplied(true);
      if (appliedResetTimerRef.current) clearTimeout(appliedResetTimerRef.current);
      appliedResetTimerRef.current = setTimeout(() => {
        appliedResetTimerRef.current = null;
        setApplied(false);
      }, 3000);
      toast.success(t("genUI.appliedToFile"), { description: filename });
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent(EVENTS.OPEN_FILE_IN_EDITOR, {
            detail: { path: filename, showDiff: true, diffOriginal: originalContent, diffContent: code },
          })
        );
      }
    } catch (e) {
      console.error("Apply code failed:", e);
      toast.error(t("genUI.applyToFileFailed"), { description: e instanceof Error ? e.message : String(e) });
    }
  }, [filename, code]);

  useEffect(() => {
    return () => {
      if (copiedResetTimerRef.current) clearTimeout(copiedResetTimerRef.current);
      if (appliedResetTimerRef.current) clearTimeout(appliedResetTimerRef.current);
    };
  }, []);
  
  // 运行代码
  const handleRun = useCallback(async () => {
    if (language === "python" || !language) {
      setIsRunning(true);
      try {
        await Promise.resolve(onAction?.("run_code", { code, language: language || "python" }));
      } finally {
        setIsRunning(false);
      }
    }
  }, [code, language, onAction]);
  
  // 保存到文件
  const handleSave = useCallback(() => {
    const ext = language === "python" ? ".py" : language === "javascript" ? ".js" : ".txt";
    const blob = new Blob([code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || `code${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    onAction?.("download_code", { filename: filename || `code${ext}`, language: language || "text" });
  }, [code, language, filename, onAction]);
  
  const toolbarActions: ToolbarAction[] = [
    ...(filename ? [{
      icon: applied ? <CheckIcon className="size-3" /> : <PlayIcon className="size-3" />,
      label: applied ? t("genUI.applied") : t("genUI.apply"),
      onClick: handleApply,
    }] : []),
    { 
      icon: isRunning ? <PauseIcon className="size-3" /> : <PlayIcon className="size-3" />, 
      label: isRunning ? t("genUI.running") : t("genUI.runCode"), 
      onClick: handleRun,
      disabled: isRunning || (language !== "python" && language !== undefined),
    },
    { icon: <EditIcon className="size-3" />, label: t("toolCard.openInEditor"), onClick: handleOpenInEditor },
    { icon: copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />, label: t("common.copy"), onClick: handleCopy },
    { icon: <SaveIcon className="size-3" />, label: t("genUI.saveFile"), onClick: handleSave },
  ];
  
  return (
    <div className={cn(
      "my-2 rounded-md border overflow-hidden",
      "bg-muted/30 border-border/50",
    )}>
      {/* 头部 */}
      <div className="group flex items-center justify-between px-2.5 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors">
        <div 
          className="flex items-center gap-2 flex-1"
          onClick={() => setIsExpanded(!isExpanded)}
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          onKeyDown={(e) => onEnterOrSpace(e, () => setIsExpanded(!isExpanded))}
        >
          <div className="text-muted-foreground">
            {isExpanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
          </div>
          <CodeIcon className="size-3.5 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">
            {title || filename || language || t("genUI.code")}
          </span>
          <span className="text-xs text-muted-foreground">
            {codeLines.length} 行
          </span>
          {language && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              {language}
            </span>
          )}
        </div>
        <div className={TOOLBAR_VISIBILITY_CLASS}>
          <Toolbar actions={toolbarActions} />
        </div>
      </div>
      
      {/* 代码内容（grid 平滑过渡） */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out overflow-hidden"
        style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}
      >
        <div className="min-h-0 border-t border-border/30 overflow-x-auto">
          {isHighlighting ? (
            <div className="p-2 text-xs font-mono leading-relaxed">
              {displayCodeLines.slice(0, 15).map((_, idx) => (
                <div key={idx} className="flex">
                  <span className="select-none text-muted-foreground/50 w-8 text-right pr-3 shrink-0">{idx + 1}</span>
                  <span className="flex-1 h-4 rounded bg-muted/50 animate-pulse max-w-[80%]" />
                </div>
              ))}
              {displayCodeLines.length > 15 && (
                <div className="text-muted-foreground/60 text-[11px] mt-1">加载中...</div>
              )}
            </div>
          ) : highlightedHtml ? (
            <div
              className="p-2 text-xs [&_pre]:p-0! [&_pre]:bg-transparent! [&_pre]:text-[13px]! [&_code]:block [&_code]:leading-relaxed"
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          ) : (
            <pre className="p-2 text-xs font-mono leading-relaxed">
              <code className="block">
                {displayCodeLines.map((line, idx) => (
                  <div key={idx} className="flex">
                    <span className="select-none text-muted-foreground w-8 text-right pr-3 shrink-0">
                      {idx + 1}
                    </span>
                    <span className="flex-1">{line}</span>
                  </div>
                ))}
              </code>
            </pre>
          )}

          {hasMoreLines && !showAll && (
            <div className="px-2.5 py-1.5 text-center border-t border-border/30">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAll(true)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                显示全部 {codeLines.length} 行
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================
// 图片组件 - 多功能版
// ============================================================
const ImageUI: FC<{
  src: string;
  alt?: string;
  caption?: string;
  onAction?: (action: string, data: any) => void;
}> = ({ src, alt, caption, onAction }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [isZoomed, setIsZoomed] = useState(false);
  const [scale, setScale] = useState(1);
  
  const handleDownload = useCallback(() => {
    const a = document.createElement("a");
    a.href = src;
    a.download = alt || "image";
    a.click();
  }, [src, alt]);
  
  const handleZoomIn = useCallback(() => setScale(s => Math.min(s + 0.25, 3)), []);
  const handleZoomOut = useCallback(() => setScale(s => Math.max(s - 0.25, 0.5)), []);
  const handleResetZoom = useCallback(() => setScale(1), []);

  useEffect(() => {
    if (!isZoomed) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsZoomed(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isZoomed]);
  
  const handleOpenInEditor = useCallback(() => {
    // 如果是本地文件路径，在编辑器中打开
    if (src.startsWith("outputs/") || src.startsWith("/")) {
      fileEventBus.openFile(src);
    }
  }, [src]);
  
  const handleAnalyze = useCallback(() => {
    onAction?.("analyze_image", { src, alt });
  }, [src, alt, onAction]);
  
  const toolbarActions: ToolbarAction[] = [
    { icon: <ZoomInIcon className="size-3" />, label: t("genUI.zoomIn"), onClick: handleZoomIn },
    { icon: <ZoomOutIcon className="size-3" />, label: t("genUI.zoomOut"), onClick: handleZoomOut },
    { icon: <RotateCcwIcon className="size-3" />, label: t("genUI.reset"), onClick: handleResetZoom },
    { icon: <MaximizeIcon className="size-3" />, label: t("genUI.fullscreen"), onClick: () => setIsZoomed(true) },
    { icon: <DownloadIcon className="size-3" />, label: t("genUI.download"), onClick: handleDownload },
    { icon: <RefreshCwIcon className="size-3" />, label: t("genUI.analyzeImage"), onClick: handleAnalyze },
  ];
  
  return (
    <>
      <div className={cn(
        "my-2 rounded-md border overflow-hidden",
        "bg-muted/30 border-border/50",
      )}>
        {/* 头部 */}
        <div className="group flex items-center justify-between px-2.5 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors">
          <div 
            className="flex items-center gap-2 flex-1"
            onClick={() => setIsExpanded(!isExpanded)}
            role="button"
            tabIndex={0}
            aria-expanded={isExpanded}
            onKeyDown={(e) => onEnterOrSpace(e, () => setIsExpanded(!isExpanded))}
          >
            <div className="text-muted-foreground">
              {isExpanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
            </div>
            <ImageIcon className="size-3.5 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">
              {alt || t("genUI.image")}
            </span>
          </div>
          <div className={TOOLBAR_VISIBILITY_CLASS}>
            <Toolbar actions={toolbarActions} />
          </div>
        </div>
        
        {/* 图片内容（grid 平滑过渡） */}
        <div
          className="grid transition-[grid-template-rows] duration-200 ease-out overflow-hidden"
          style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}
        >
          <div className="min-h-0">
            <div className="border-t border-border/30 p-2 flex justify-center">
              <img 
                src={src} 
                alt={alt || t("genUI.image")} 
                className="max-h-[400px] object-contain cursor-pointer transition-transform"
                style={{ transform: `scale(${scale})` }}
                onClick={() => setIsZoomed(true)}
                loading="lazy"
                onError={(e) => { e.currentTarget.alt = t("genUI.imageLoadFailed"); e.currentTarget.style.opacity = "0.4"; }}
              />
            </div>
            {caption && (
              <div className="px-2.5 py-1 border-t border-border/30 text-xs text-muted-foreground">
                {caption}
              </div>
            )}
          </div>
        </div>
      </div>
      
      {/* 全屏模态框 */}
      {isZoomed && (
        <div 
          className="fixed inset-0 z-[var(--z-dialog)] bg-black/80 flex items-center justify-center"
          onClick={() => setIsZoomed(false)}
        >
          <Button
            variant="ghost"
            size="sm"
            className="absolute top-4 right-4 text-white hover:bg-white/20"
            onClick={() => setIsZoomed(false)}
          >
            <XIcon className="size-5" />
          </Button>
          <img 
            src={src} 
            alt={alt || t("genUI.image")} 
            className="max-w-[90vw] max-h-[90vh] object-contain"
            onClick={(e) => e.stopPropagation()}
            onError={(e) => { e.currentTarget.alt = t("genUI.imageLoadFailed"); e.currentTarget.style.opacity = "0.4"; }}
          />
        </div>
      )}
    </>
  );
};

// ============================================================
// 步骤组件 - 多功能版
// ============================================================
const StepsUI: FC<{ 
  steps: Array<{ 
    title: string; 
    description?: string;
    status?: 'pending' | 'running' | 'completed' | 'error';
    output?: string;
  }>;
  title?: string;
  onAction?: (action: string, data: any) => void;
}> = ({ steps, title, onAction }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());
  
  const completedCount = steps.filter(s => s.status === 'completed').length;
  const hasError = steps.some(s => s.status === 'error');
  const isRunning = steps.some(s => s.status === 'running');
  
  const toggleStep = useCallback((idx: number) => {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  }, []);
  
  const handleRetry = useCallback((stepIdx: number) => {
    onAction?.("retry_step", { stepIdx, step: steps[stepIdx] });
  }, [steps, onAction]);
  
  const handleCopyOutput = useCallback((output: string) => {
    copyWithFeedback(output, t("genUI.stepsOutputCopied"));
  }, []);
  
  return (
    <div className={cn(
      "my-2 rounded-md border overflow-hidden",
      "bg-muted/30 border-border/50",
    )}>
      {/* 头部 */}
      <div 
        className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onKeyDown={(e) => onEnterOrSpace(e, () => setIsExpanded(!isExpanded))}
      >
        <div className="text-muted-foreground">
          {isExpanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
        </div>
        <ListChecksIcon className={cn(
          "size-3.5",
          hasError ? "text-red-500" : isRunning ? "text-violet-500" : "text-muted-foreground"
        )} />
        <span className="text-sm font-medium text-foreground">
          {title || t("genUI.steps")}
        </span>
        <span className={cn(
          "text-xs",
          hasError ? "text-red-500" : completedCount === steps.length ? "text-emerald-500" : "text-muted-foreground"
        )}>
          {completedCount}/{steps.length}
        </span>
        {isRunning && (
          <span className="text-xs text-violet-500 animate-pulse">运行中...</span>
        )}
      </div>
      
      {/* 步骤列表（grid 平滑过渡） */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out overflow-hidden"
        style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}
      >
        <div className="min-h-0 border-t border-border/30 px-2.5 py-1.5 space-y-1">
          {steps.map((step, idx) => {
            const isCompleted = step.status === 'completed';
            const isStepRunning = step.status === 'running';
            const isError = step.status === 'error';
            const isStepExpanded = expandedSteps.has(idx);
            
            return (
              <div key={idx} className="space-y-1">
                <div
                  className={cn(
                    "flex items-start gap-2 py-1.5 rounded px-2 cursor-pointer",
                    isStepRunning && "bg-violet-500/5",
                    isError && "bg-red-500/5",
                  )}
                  onClick={() => step.output && toggleStep(idx)}
                  role={step.output ? "button" : undefined}
                  tabIndex={step.output ? 0 : -1}
                  aria-expanded={step.output ? isStepExpanded : undefined}
                  onKeyDown={(e) => {
                    if (!step.output) return;
                    onEnterOrSpace(e, () => toggleStep(idx));
                  }}
                >
                  {/* 状态图标 */}
                  <div className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-medium mt-0.5",
                    isCompleted && "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400",
                    isStepRunning && "bg-violet-500/20 text-violet-600 dark:text-violet-400",
                    isError && "bg-red-500/20 text-red-600 dark:text-red-400",
                    !isCompleted && !isStepRunning && !isError && "bg-muted text-muted-foreground",
                  )}>
                    {isCompleted ? (
                      <CheckIcon className="size-3" />
                    ) : isStepRunning ? (
                      <RefreshCwIcon className="size-3 animate-spin" />
                    ) : isError ? (
                      <XIcon className="size-3" />
                    ) : (
                      idx + 1
                    )}
                  </div>
                  
                  {/* 内容 */}
                  <div className="flex-1 min-w-0">
                    <div className={cn(
                      "text-sm flex items-center gap-2",
                      isCompleted && "text-emerald-600 dark:text-emerald-400",
                      isStepRunning && "text-violet-600 dark:text-violet-400 font-medium",
                      isError && "text-red-600 dark:text-red-400",
                      !isCompleted && !isStepRunning && !isError && "text-foreground",
                    )}>
                      {step.title}
                      {step.output && (
                        <ChevronRightIcon className={cn(
                          "size-3 transition-transform",
                          isStepExpanded && "rotate-90"
                        )} />
                      )}
                    </div>
                    {step.description && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {step.description}
                      </div>
                    )}
                  </div>
                  
                  {/* 操作按钮 */}
                  {isError && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => { e.stopPropagation(); handleRetry(idx); }}
                      className="h-6 text-xs text-red-500 hover:text-red-600"
                    >
                      <RotateCcwIcon className="size-3 mr-1" />
                      重试
                    </Button>
                  )}
                </div>
                
                {/* 展开的输出 */}
                {isStepExpanded && step.output && (
                  <div className="ml-7 p-2 rounded bg-muted/50 text-xs font-mono relative group">
                    <pre className="whitespace-pre-wrap">{step.output}</pre>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleCopyOutput(step.output!)}
                      className="absolute top-1 right-1 h-6 w-6 p-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
                    >
                      <CopyIcon className="size-3" />
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// ============================================================
// 文档预览组件 - 多功能版
// ============================================================
const DocumentUI: FC<{
  filename: string;
  preview?: string;
  size?: string;
  url?: string;
  path?: string;
  type?: string;
  onAction?: (action: string, data: any) => void;
}> = ({ filename, preview, size, url, path, type, onAction }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  
  const handleOpenInEditor = useCallback(() => {
    const filePath = path || filename;
    fileEventBus.openFile(filePath);
  }, [path, filename]);
  
  const handleDownload = useCallback(() => {
    if (url) {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
    }
  }, [url, filename]);
  
  const handleAnalyze = useCallback(() => {
    onAction?.("analyze_document", { filename, path, type });
  }, [filename, path, type, onAction]);
  
  const toolbarActions: ToolbarAction[] = [
    { icon: <EditIcon className="size-3" />, label: t("toolCard.openInEditor"), onClick: handleOpenInEditor },
    { icon: <RefreshCwIcon className="size-3" />, label: t("genUI.analyzeDoc"), onClick: handleAnalyze },
  ];
  
  if (url) {
    toolbarActions.push({ icon: <DownloadIcon className="size-3" />, label: t("genUI.download"), onClick: handleDownload });
  }
  
  return (
    <div className={cn(
      "my-2 rounded-md border overflow-hidden",
      "bg-muted/30 border-border/50",
    )}>
      <div className="group flex items-center justify-between px-2.5 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors">
        <div 
          className="flex items-center gap-2 flex-1"
          onClick={() => preview && setIsExpanded(!isExpanded)}
          role={preview ? "button" : undefined}
          tabIndex={preview ? 0 : -1}
          aria-expanded={preview ? isExpanded : undefined}
          onKeyDown={(e) => {
            if (!preview) return;
            onEnterOrSpace(e, () => setIsExpanded(!isExpanded));
          }}
        >
          <FileTextIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">{filename}</span>
          {size && <span className="text-xs text-muted-foreground">{size}</span>}
        </div>
        <div className={TOOLBAR_VISIBILITY_CLASS}>
          <Toolbar actions={toolbarActions} />
        </div>
      </div>
      
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out overflow-hidden"
        style={{ gridTemplateRows: isExpanded && preview ? "1fr" : "0fr" }}
      >
        {preview ? (
          <div className="min-h-0 border-t border-border/30 px-2.5 py-1.5 max-h-[200px] overflow-y-auto">
            <p className="text-xs text-muted-foreground whitespace-pre-wrap">{preview}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
};

// ============================================================
// 证据/引用组件 - 多功能版
// ============================================================
const EvidenceUI: FC<{ 
  evidences: Array<{
    source: string;
    content: string;
    page?: number;
    relevance?: number;
    url?: string;
    path?: string;
    line?: number;
  }>;
  title?: string;
  onAction?: (action: string, data: any) => void;
}> = ({ evidences, title, onAction }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  
  const handleOpenSource = useCallback((evidence: typeof evidences[0]) => {
    if (evidence.path) {
      if (typeof evidence.line === "number" && Number.isFinite(evidence.line)) {
        fileEventBus.openFile(evidence.path, Math.max(1, Math.floor(evidence.line)));
      } else {
        fileEventBus.openFile(evidence.path);
      }
    } else if (evidence.url) {
      window.open(evidence.url, '_blank');
    }
  }, []);
  
  const handleCopyContent = useCallback((content: string) => {
    copyWithFeedback(content, t("genUI.quoteCopied"));
  }, []);
  
  const handleVerify = useCallback((evidence: typeof evidences[0]) => {
    onAction?.("verify_evidence", evidence);
  }, [onAction]);
  
  return (
    <div className={cn(
      "my-2 rounded-md border overflow-hidden",
      "bg-muted/30 border-border/50",
    )}>
      {/* 头部 */}
      <div 
        className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onKeyDown={(e) => onEnterOrSpace(e, () => setIsExpanded(!isExpanded))}
      >
        <div className="text-muted-foreground">
          {isExpanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
        </div>
        <QuoteIcon className="size-3.5 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">
          {title || t("genUI.quote")}
        </span>
        <span className="text-xs text-muted-foreground">
          {evidences.length} 条
        </span>
      </div>
      
      {/* 引用列表（grid 平滑过渡） */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out overflow-hidden"
        style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}
      >
        <div className="min-h-0 border-t border-border/30 divide-y divide-border/20">
          {evidences.map((evidence, idx) => (
            <div 
              key={idx}
              className="px-2.5 py-1.5 hover:bg-muted/30 transition-colors"
            >
              <div 
                className="flex items-start gap-2 cursor-pointer"
                onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
                role="button"
                tabIndex={0}
                aria-expanded={expandedIdx === idx}
                onKeyDown={(e) => onEnterOrSpace(e, () => setExpandedIdx(expandedIdx === idx ? null : idx))}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                  {idx + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground truncate">
                      {evidence.source}
                    </span>
                    {evidence.page && (
                      <span className="text-xs text-muted-foreground">
                        p.{evidence.page}
                      </span>
                    )}
                    {typeof evidence.line === "number" && (
                      <span className="text-xs text-muted-foreground">
                        L{evidence.line}
                      </span>
                    )}
                    {evidence.relevance && (
                      <span className={cn(
                        "text-xs px-1 rounded",
                        evidence.relevance > 0.8 ? "bg-green-500/20 text-green-600" :
                        evidence.relevance > 0.5 ? "bg-yellow-500/20 text-yellow-600" :
                        "bg-muted text-muted-foreground"
                      )}>
                        {Math.round(evidence.relevance * 100)}%
                      </span>
                    )}
                  </div>
                  <p className={cn(
                    "text-xs text-muted-foreground mt-0.5",
                    expandedIdx !== idx && "line-clamp-2",
                  )}>
                    {evidence.content}
                  </p>
                </div>
              </div>
              
              {expandedIdx === idx && (
                <div className="mt-2 ml-7 flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => handleOpenSource(evidence)}
                  >
                    <ExternalLinkIcon className="size-3 mr-1" />
                    查看原文
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => handleCopyContent(evidence.content)}
                  >
                    <CopyIcon className="size-3 mr-1" />
                    复制
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => handleVerify(evidence)}
                  >
                    <RefreshCwIcon className="size-3 mr-1" />
                    验证
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ============================================================
// Markdown 组件 - 多功能版
// ============================================================
const MAX_MARKDOWN_CHARS = 5000;

const MarkdownUI: FC<{
  content: string;
  title?: string;
  onAction?: (action: string, data: any) => void;
}> = ({ content, title, onAction }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  const displayContent = showAll ? content : content.slice(0, MAX_MARKDOWN_CHARS);
  const hasMore = content.length > MAX_MARKDOWN_CHARS;
  
  const handleCopy = useCallback(() => {
    copyWithFeedback(content, t("genUI.docCopied"));
    setCopied(true);
    if (copiedResetTimerRef.current) clearTimeout(copiedResetTimerRef.current);
    copiedResetTimerRef.current = setTimeout(() => {
      copiedResetTimerRef.current = null;
      setCopied(false);
    }, 2000);
  }, [content]);

  useEffect(() => {
    return () => {
      if (copiedResetTimerRef.current) clearTimeout(copiedResetTimerRef.current);
    };
  }, []);
  
  const handleSave = useCallback(() => {
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title || "document"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [content, title]);
  
  const handleEdit = useCallback(() => {
    onAction?.("edit_markdown", { content, title });
  }, [content, title, onAction]);

  // 在编辑器中编辑（MilkdownEditor）
  const handleOpenInEditor = useCallback(() => {
    const mdName = `${(title || "document").replace(/\s+/g, "_")}_${Date.now()}.md`;
    fileEventBus.openFile(`__artifact__/${mdName}`, content);
  }, [content, title]);
  
  const toolbarActions: ToolbarAction[] = [
    { icon: copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />, label: t("common.copy"), onClick: handleCopy },
    { icon: <ExternalLinkIcon className="size-3" />, label: t("genUI.editInEditor"), onClick: handleOpenInEditor },
    { icon: <SaveIcon className="size-3" />, label: t("common.save"), onClick: handleSave },
    { icon: <EditIcon className="size-3" />, label: t("common.edit"), onClick: handleEdit },
  ];
  
  return (
    <div className={cn(
      "my-2 rounded-md border overflow-hidden",
      "bg-muted/30 border-border/50",
    )}>
      {/* 头部 */}
      <div className="group flex items-center justify-between px-2.5 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors">
        <div 
          className="flex items-center gap-2 flex-1"
          onClick={() => setIsExpanded(!isExpanded)}
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          onKeyDown={(e) => onEnterOrSpace(e, () => setIsExpanded(!isExpanded))}
        >
          <div className="text-muted-foreground">
            {isExpanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
          </div>
          <FileTextIcon className="size-3.5 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">
            {title || t("genUI.doc")}
          </span>
        </div>
        <div className={TOOLBAR_VISIBILITY_CLASS}>
          <Toolbar actions={toolbarActions} />
        </div>
      </div>
      
      {/* 内容 - 使用 Markdown 渲染（grid 平滑过渡） */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out overflow-hidden"
        style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}
      >
        <div className="min-h-0 border-t border-border/30 px-2.5 py-1.5 prose prose-sm dark:prose-invert max-w-none overflow-x-auto max-h-[400px] overflow-y-auto aui-md text-sm leading-relaxed prose-p:leading-[1.65] prose-headings:font-semibold prose-headings:tracking-tight prose-blockquote:border-l-primary prose-blockquote:bg-muted/30 prose-blockquote:py-1 prose-code:rounded prose-code:bg-muted/60 prose-code:px-1.5 prose-code:py-0.5 [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full">
          <ReactMarkdown remarkPlugins={[...remarkPluginsWithMath]} rehypePlugins={[...rehypePluginsMath]}>{displayContent}</ReactMarkdown>
          {hasMore && !showAll && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowAll(true)}
              className="mt-2 text-xs text-muted-foreground hover:text-foreground"
            >
              显示更多
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================
// 图表组件 - 数据分析产出
// ============================================================
const ChartUI: FC<{
  src: string;
  alt?: string;
  caption?: string;
  title?: string;
  data?: { columns?: string[]; rows?: Record<string, unknown>[] };
  onAction?: (action: string, data: any) => void;
}> = ({ src, alt, caption, title, data, onAction }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [showData, setShowData] = useState(false);

  const handleDownload = useCallback(() => {
    const a = document.createElement("a");
    a.href = src;
    a.download = alt || title || "chart";
    a.click();
  }, [src, alt, title]);

  // 在编辑器中查看图表
  const handleOpenInEditor = useCallback(() => {
    const chartName = (title || alt || "chart").replace(/\s+/g, "_");
    // 通过 base64 data URL 或直接路径打开（虚拟路径）
    fileEventBus.openFile(`__artifact__/${chartName}.png`, src);
  }, [src, title, alt]);

  const toolbarActions: ToolbarAction[] = [
    { icon: <TableIcon className="size-3" />, label: showData ? "显示图表" : "查看数据", onClick: () => setShowData((v) => !v) },
    { icon: <ExternalLinkIcon className="size-3" />, label: "在编辑器中查看", onClick: handleOpenInEditor },
    { icon: <DownloadIcon className="size-3" />, label: "下载", onClick: handleDownload },
  ];
  if (onAction) {
    toolbarActions.push({ icon: <RefreshCwIcon className="size-3" />, label: "重新分析", onClick: () => onAction("reanalyze_chart", { src, title }) });
  }

  return (
    <div className={cn("my-2 rounded-md border overflow-hidden", "bg-muted/30 border-border/50")}>
      <div className="group flex items-center justify-between px-2.5 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors">
        <div
          className="flex items-center gap-2 flex-1"
          onClick={() => setIsExpanded(!isExpanded)}
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          onKeyDown={(e) => onEnterOrSpace(e, () => setIsExpanded(!isExpanded))}
        >
          <div className="text-muted-foreground">
            {isExpanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
          </div>
          <BarChart3 className="size-3.5 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">{title || alt || "图表"}</span>
        </div>
        <div className={TOOLBAR_VISIBILITY_CLASS}>
          <Toolbar actions={toolbarActions} />
        </div>
      </div>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out overflow-hidden"
        style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}
      >
        <div className="min-h-0">
          {!showData ? (
            <div className="border-t border-border/30 p-2 flex justify-center">
              <img src={src} alt={alt || "图表"} className="max-h-[400px] object-contain rounded" loading="lazy" onError={(e) => { e.currentTarget.alt = "图表加载失败"; e.currentTarget.style.opacity = "0.4"; }} />
            </div>
          ) : data && Array.isArray(data.columns) && Array.isArray(data.rows) && data.rows.length > 0 ? (() => {
            const cols = data.columns;
            const rows = data.rows;
            return (
            <div className="border-t border-border/30 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/30">
                    {cols.map((col, i) => (
                      <th key={i} className="px-2.5 py-1 text-left text-xs font-medium text-muted-foreground border-b border-border/30">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 50).map((row, ri) => (
                    <tr key={ri} className="border-b border-border/20 hover:bg-muted/20">
                      {cols.map((col, ci) => (
                        <td key={ci} className="px-2.5 py-1 text-foreground">
                          {String(row[col] ?? "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 50 && (
                <div className="px-2.5 py-1 text-xs text-muted-foreground text-center">仅显示前 50 行，共 {rows.length} 行</div>
              )}
            </div>
            );
          })() : (
            <div className="border-t border-border/30 p-2 flex justify-center">
              <img src={src} alt={alt || "图表"} className="max-h-[400px] object-contain rounded" loading="lazy" onError={(e) => { e.currentTarget.alt = "图表加载失败"; e.currentTarget.style.opacity = "0.4"; }} />
            </div>
          )}
          {caption && (
            <div className="px-2.5 py-1 border-t border-border/30 text-xs text-muted-foreground">{caption}</div>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================
// 指标卡片组件 - KPI 摘要
// ============================================================
const MetricsUI: FC<{
  metrics: Array<{
    label: string;
    value: string | number;
    change?: number;
    changeLabel?: string;
    baseline?: string;
  }>;
  title?: string;
  columns?: 2 | 3 | 4;
  onAction?: (action: string, data: any) => void;
}> = ({ metrics, title, columns = 3 }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const gridCols = columns === 2 ? "grid-cols-2" : columns === 4 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-2 sm:grid-cols-3";

  return (
    <div className={cn("my-2 rounded-md border overflow-hidden", "bg-muted/30 border-border/50")}>
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setIsExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onKeyDown={(e) => onEnterOrSpace(e, () => setIsExpanded((v) => !v))}
      >
        <div className="text-muted-foreground">
          {isExpanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
        </div>
        <BarChart3 className="size-3.5 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{title || "关键指标"}</span>
        <span className="text-xs text-muted-foreground">{metrics.length} 项</span>
      </div>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out overflow-hidden"
        style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}
      >
        <div className={cn("min-h-0 border-t border-border/30 p-2 grid gap-2", gridCols)}>
          {metrics.map((m, idx) => (
            <div
              key={idx}
              className="rounded-lg border border-border/30 bg-background/50 p-2 flex flex-col gap-0.5"
            >
              <span className="text-xs text-muted-foreground">{m.label}</span>
              <span className="text-lg font-semibold text-foreground tabular-nums">{m.value}</span>
              {m.change !== undefined && (
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    m.change > 0 ? "text-emerald-600 dark:text-emerald-400" : m.change < 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"
                  )}
                >
                  {m.change > 0 ? "↑" : m.change < 0 ? "↓" : ""} {m.change !== 0 ? `${Math.abs(m.change)}%` : ""} {m.changeLabel ?? ""}
                </span>
              )}
              {m.baseline && <span className="text-[11px] text-muted-foreground">对比: {m.baseline}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ============================================================
// 对比视图组件
// ============================================================
const ComparisonUI: FC<{
  title?: string;
  leftTitle?: string;
  rightTitle?: string;
  left: string;
  right: string;
}> = ({ title, leftTitle = "方案 A", rightTitle = "方案 B", left, right }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  return (
    <div className={cn("my-2 rounded-md border overflow-hidden", "bg-muted/30 border-border/50")}>
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setIsExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onKeyDown={(e) => onEnterOrSpace(e, () => setIsExpanded((v) => !v))}
      >
        <div className="text-muted-foreground">
          {isExpanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
        </div>
        <Columns3Icon className="size-3.5 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{title || "对比视图"}</span>
      </div>
      <div className="grid transition-[grid-template-rows] duration-200 ease-out overflow-hidden" style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}>
        <div className="min-h-0 border-t border-border/30 p-2 grid grid-cols-1 md:grid-cols-2 gap-2">
          <div className="rounded border border-border/30 bg-background/50 p-2">
            <div className="text-xs text-muted-foreground mb-1">{leftTitle}</div>
            <div className="text-sm whitespace-pre-wrap">{left}</div>
          </div>
          <div className="rounded border border-border/30 bg-background/50 p-2">
            <div className="text-xs text-muted-foreground mb-1">{rightTitle}</div>
            <div className="text-sm whitespace-pre-wrap">{right}</div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================
// 时间线组件
// ============================================================
const TimelineUI: FC<{
  title?: string;
  items: Array<{ time?: string; title: string; description?: string; status?: "done" | "doing" | "todo" }>;
}> = ({ title, items }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  return (
    <div className={cn("my-2 rounded-md border overflow-hidden", "bg-muted/30 border-border/50")}>
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setIsExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onKeyDown={(e) => onEnterOrSpace(e, () => setIsExpanded((v) => !v))}
      >
        <div className="text-muted-foreground">
          {isExpanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
        </div>
        <CalendarClockIcon className="size-3.5 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{title || "时间线"}</span>
      </div>
      <div className="grid transition-[grid-template-rows] duration-200 ease-out overflow-hidden" style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}>
        <div className="min-h-0 border-t border-border/30 p-2 space-y-2">
          {items.map((it, idx) => (
            <div key={idx} className="flex gap-2">
              <div className="flex flex-col items-center pt-1">
                <div className={cn("h-2.5 w-2.5 rounded-full", it.status === "done" ? "bg-emerald-500" : it.status === "doing" ? "bg-violet-500" : "bg-muted-foreground/40")} />
                {idx < items.length - 1 && <div className="w-px flex-1 bg-border/60 mt-1" />}
              </div>
              <div className="pb-2">
                <div className="text-xs text-muted-foreground">{it.time || `Step ${idx + 1}`}</div>
                <div className="text-sm font-medium text-foreground">{it.title}</div>
                {it.description && <div className="text-xs text-muted-foreground mt-0.5">{it.description}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ============================================================
// 表单组件
// ============================================================
const FormUI: FC<{
  title?: string;
  fields: Array<{ name: string; label: string; type?: "text" | "number" | "textarea"; placeholder?: string; required?: boolean }>;
  submitLabel?: string;
  onAction?: (action: string, data: any) => void | Promise<void>;
}> = ({ title, fields, submitLabel = "提交", onAction }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [values, setValues] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const requiredFields = useMemo(() => fields.filter((field) => field.required), [fields]);
  const missingRequiredLabels = useMemo(
    () =>
      requiredFields
        .filter((field) => !(values[field.name] || "").trim())
        .map((field) => field.label),
    [requiredFields, values]
  );
  const canSubmit = !isSubmitting && missingRequiredLabels.length === 0;
  const setField = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));
  const handleSubmit = async () => {
    if (isSubmitting) return;
    if (missingRequiredLabels.length > 0) {
      toast.error("请先填写必填项", { description: missingRequiredLabels.join("、") });
      return;
    }
    setIsSubmitting(true);
    try {
      await Promise.resolve(onAction?.("submit_form", { values }));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className={cn("my-2 rounded-md border overflow-hidden", "bg-muted/30 border-border/50")}>
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setIsExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onKeyDown={(e) => onEnterOrSpace(e, () => setIsExpanded((v) => !v))}
      >
        <div className="text-muted-foreground">
          {isExpanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
        </div>
        <FormInputIcon className="size-3.5 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{title || "表单输入"}</span>
      </div>
      <div className="grid transition-[grid-template-rows] duration-200 ease-out overflow-hidden" style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}>
        <div className="min-h-0 border-t border-border/30 p-2 space-y-2">
          {fields.map((f, idx) => (
            <div key={idx} className="space-y-1">
              <label className="text-xs text-muted-foreground">{f.label}{f.required ? " *" : ""}</label>
              {f.type === "textarea" ? (
                <textarea
                  value={values[f.name] || ""}
                  onChange={(e) => setField(f.name, e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      void handleSubmit();
                    }
                  }}
                  placeholder={f.placeholder}
                  className="w-full min-h-[70px] rounded border border-border/40 bg-background/60 px-2 py-1 text-sm outline-none"
                />
              ) : (
                <input
                  type={f.type || "text"}
                  value={values[f.name] || ""}
                  onChange={(e) => setField(f.name, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleSubmit();
                    }
                  }}
                  placeholder={f.placeholder}
                  className="w-full rounded border border-border/40 bg-background/60 px-2 py-1 text-sm outline-none"
                />
              )}
            </div>
          ))}
          <div className="pt-1">
            <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
              {isSubmitting ? "提交中..." : submitLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================
// System Status 组件
// ============================================================
const SystemStatusUI: FC<{
  title?: string;
  healthScore?: number;
  statuses?: Array<{ name: string; status: "healthy" | "degraded" | "down"; detail?: string }>;
  summary?: string;
  onAction?: (action: string, data: any) => void;
}> = ({ title, healthScore = 0, statuses = [], summary, onAction }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [pendingAction, setPendingAction] = useState<"" | "refresh" | "path_check">("");
  const normalizedScore = Math.max(0, Math.min(100, Number(healthScore) || 0));
  const strokeOffset = 188.5 - (188.5 * normalizedScore) / 100;
  const actionBusy = pendingAction !== "";

  const triggerAction = useCallback(async (type: "refresh" | "path_check") => {
    if (actionBusy) return;
    setPendingAction(type);
    try {
      if (type === "refresh") {
        await Promise.resolve(onAction?.("refresh_system_status", {}));
      } else {
        await Promise.resolve(onAction?.("check_path_normalization", {}));
      }
    } finally {
      setPendingAction("");
    }
  }, [actionBusy, onAction]);

  return (
    <div className={cn("my-2 rounded-md border overflow-hidden", "bg-muted/30 border-border/50")}>
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setIsExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onKeyDown={(e) => onEnterOrSpace(e, () => setIsExpanded((v) => !v))}
      >
        <div className="text-muted-foreground">
          {isExpanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
        </div>
        <BarChart3 className="size-3.5 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{title || "系统状态"}</span>
      </div>
      <div className="grid transition-[grid-template-rows] duration-200 ease-out overflow-hidden" style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}>
        <div className="min-h-0 border-t border-border/30 p-3 space-y-3">
          <div className="flex items-center gap-3">
            <div className="relative h-18 w-18 shrink-0">
              <svg viewBox="0 0 72 72" className="h-18 w-18 -rotate-90">
                <circle cx="36" cy="36" r="30" stroke="currentColor" strokeWidth="6" fill="none" className="text-muted/60" />
                <circle
                  cx="36"
                  cy="36"
                  r="30"
                  stroke="currentColor"
                  strokeWidth="6"
                  fill="none"
                  strokeDasharray="188.5"
                  strokeDashoffset={strokeOffset}
                  className={cn(
                    "transition-all duration-500",
                    normalizedScore >= 85 ? "text-emerald-500" : normalizedScore >= 60 ? "text-amber-500" : "text-red-500"
                  )}
                />
              </svg>
              <div className="absolute inset-0 grid place-items-center text-sm font-semibold tabular-nums">{normalizedScore}</div>
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">健康分数</div>
              <div className="text-sm text-foreground">
                {normalizedScore >= 85 ? "系统健康" : normalizedScore >= 60 ? "系统有风险" : "系统异常"}
              </div>
              {summary && <div className="text-xs text-muted-foreground">{summary}</div>}
            </div>
          </div>

          {statuses.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {statuses.map((item, idx) => {
                const statusColor =
                  item.status === "healthy"
                    ? "bg-emerald-500"
                    : item.status === "degraded"
                      ? "bg-amber-500"
                      : "bg-red-500";
                return (
                  <div key={idx} className="rounded border border-border/30 bg-background/50 p-2">
                    <div className="flex items-center gap-2">
                      <span className={cn("size-2 rounded-full", statusColor)} />
                      <span className="text-sm text-foreground">{item.name}</span>
                    </div>
                    {item.detail && <div className="mt-1 text-xs text-muted-foreground">{item.detail}</div>}
                  </div>
                );
              })}
            </div>
          )}
          <div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={actionBusy}
                onClick={() => triggerAction("refresh")}
              >
                {pendingAction === "refresh" ? (
                  <RefreshCwIcon className="mr-1 size-3.5 animate-spin" />
                ) : null}
                刷新
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={actionBusy}
                onClick={() => triggerAction("path_check")}
              >
                {pendingAction === "path_check" ? (
                  <RefreshCwIcon className="mr-1 size-3.5 animate-spin" />
                ) : null}
                路径检查
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================
// JSON Viewer 组件
// ============================================================
const JsonNode: FC<{ k?: string; value: any; depth?: number }> = ({ k, value, depth = 0 }) => {
  const [open, setOpen] = useState(depth < 1);
  const isObject = value && typeof value === "object";
  const isArray = Array.isArray(value);

  if (!isObject) {
    const rendered =
      typeof value === "string"
        ? <span className="text-emerald-600 dark:text-emerald-400">"{value}"</span>
        : typeof value === "number"
          ? <span className="text-blue-600 dark:text-blue-400">{String(value)}</span>
          : typeof value === "boolean"
            ? <span className="text-violet-600 dark:text-violet-400">{String(value)}</span>
            : <span className="text-muted-foreground">null</span>;
    return (
      <div className="text-xs font-mono leading-5">
        {k && <span className="text-foreground/80">{k}: </span>}
        {rendered}
      </div>
    );
  }

  const entries = isArray ? value.map((v: any, i: number) => [String(i), v]) : Object.entries(value);
  return (
    <div className="text-xs font-mono">
      <button type="button" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
        {k && <span>{k}: </span>}
        <span>{isArray ? `[${entries.length}]` : `{${entries.length}}`}</span>
      </button>
      {open && (
        <div className="ml-4 border-l border-border/40 pl-2 mt-1 space-y-0.5">
          {entries.map(([ek, ev]) => (
            <JsonNode key={String(ek)} k={String(ek)} value={ev} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
};

const JsonViewerUI: FC<{
  title?: string;
  data: any;
  onAction?: (action: string, data: any) => void;
}> = ({ title, data, onAction }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [query, setQuery] = useState("");
  const jsonText = useMemo(() => {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return "{}";
    }
  }, [data]);
  const filtered = useMemo(() => {
    if (!query.trim()) return data;
    try {
      const q = query.toLowerCase();
      if (jsonText.toLowerCase().includes(q)) return data;
      return {};
    } catch {
      return data;
    }
  }, [data, jsonText, query]);

  return (
    <div className={cn("my-2 rounded-md border overflow-hidden", "bg-muted/30 border-border/50")}>
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setIsExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onKeyDown={(e) => onEnterOrSpace(e, () => setIsExpanded((v) => !v))}
      >
        <div className="text-muted-foreground">
          {isExpanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
        </div>
        <CodeIcon className="size-3.5 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{title || "JSON 视图"}</span>
      </div>
      <div className="grid transition-[grid-template-rows] duration-200 ease-out overflow-hidden" style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}>
        <div className="min-h-0 border-t border-border/30 p-2 space-y-2">
          <div className="flex items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索 key/value..."
              className="flex-1 rounded border border-border/40 bg-background/60 px-2 py-1 text-xs outline-none"
            />
            <Button size="sm" variant="outline" onClick={() => onAction?.("copy_json", { text: jsonText })}>
              复制
            </Button>
          </div>
          <div className="rounded border border-border/40 bg-zinc-900/95 text-zinc-100 p-2 max-h-[320px] overflow-auto">
            <JsonNode value={filtered} />
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================
// Diff 视图 - 代码差异 Accept/Reject
// ============================================================
type DiffLine = { type: "add" | "remove" | "context"; content: string; lineNumber?: number };
const DiffViewUI: FC<{
  filename?: string;
  lines?: DiffLine[] | string[];
  patch?: string;
  onAction?: (action: string, data: any) => void;
}> = ({ filename, lines: linesProp, patch, onAction }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const lines = useMemo((): DiffLine[] => {
    if (Array.isArray(linesProp)) {
      if (linesProp.length === 0) return [];
      const first = linesProp[0];
      if (typeof first === "string") {
        return (linesProp as string[]).map((s) => ({
          type: s.startsWith("+") ? "add" : s.startsWith("-") ? "remove" : "context",
          content: s,
        }));
      }
      return linesProp as DiffLine[];
    }
    if (patch && typeof patch === "string") {
      return patch.split("\n").map((s) => ({
        type: s.startsWith("+") ? "add" : s.startsWith("-") ? "remove" : "context",
        content: s,
      }));
    }
    return [];
  }, [linesProp, patch]);
  const addCount = lines.filter((l) => l.type === "add").length;
  const removeCount = lines.filter((l) => l.type === "remove").length;
  const handleAcceptAll = useCallback(() => {
    onAction?.("accept_all", { filename, lines });
  }, [filename, lines, onAction]);
  const handleRejectAll = useCallback(() => {
    onAction?.("reject_all", { filename, lines });
  }, [filename, lines, onAction]);
  const handleCopyPatch = useCallback(() => {
    const text = lines.map((l) => l.content).join("\n");
    copyWithFeedback(text, "Patch 已复制");
  }, [lines]);
  const toolbarActions: ToolbarAction[] = [
    { icon: <CheckIcon className="size-3" />, label: "全部接受", onClick: handleAcceptAll },
    { icon: <XIcon className="size-3" />, label: "全部拒绝", onClick: handleRejectAll, variant: "destructive" },
    { icon: <CopyIcon className="size-3" />, label: "复制 patch", onClick: handleCopyPatch },
  ];
  return (
    <div className={cn("my-2 rounded-md border overflow-hidden", "bg-muted/30 border-border/50")}>
      <div className="group flex items-center justify-between px-2.5 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors">
        <div className="flex items-center gap-2 flex-1" onClick={() => setIsExpanded(!isExpanded)} role="button" tabIndex={0} aria-expanded={isExpanded} onKeyDown={(e) => onEnterOrSpace(e, () => setIsExpanded(!isExpanded))}>
          <div className="text-muted-foreground">{isExpanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}</div>
          <GitCompare className="size-3.5 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">文件差异 · {filename || "diff"} · +{addCount}/-{removeCount}</span>
        </div>
        <div className={TOOLBAR_VISIBILITY_CLASS}><Toolbar actions={toolbarActions} /></div>
      </div>
      <div className="grid transition-[grid-template-rows] duration-200 ease-out overflow-hidden" style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}>
        <div className="min-h-0 border-t border-border/30 max-h-64 overflow-auto">
          {lines.map((line, i) => (
            <div
              key={i}
              className={cn(
                "font-mono text-xs px-2 py-0.5 border-b border-border/20",
                line.type === "add" && "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200",
                line.type === "remove" && "bg-red-500/15 text-red-800 dark:text-red-200",
                line.type === "context" && "text-muted-foreground"
              )}
            >
              {line.content}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ============================================================
// 计划审批卡片 - 等待人工确认
// ============================================================
const PlanConfirmUI: FC<{
  title?: string;
  steps?: { description: string; duration?: string }[];
  onAction?: (action: string, data: any) => void;
}> = ({ title, steps = [], onAction }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const handleConfirm = useCallback(() => onAction?.("confirm", {}), [onAction]);
  const handleModify = useCallback(() => onAction?.("modify", {}), [onAction]);
  const handleCancel = useCallback(() => onAction?.("cancel", {}), [onAction]);
  return (
    <div className={cn("my-2 rounded-md border overflow-hidden", "bg-muted/30 border-border/50")}>
      <div className="group flex items-center justify-between px-2.5 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors">
        <div className="flex items-center gap-2 flex-1" onClick={() => setIsExpanded(!isExpanded)} role="button" tabIndex={0} aria-expanded={isExpanded} onKeyDown={(e) => onEnterOrSpace(e, () => setIsExpanded(!isExpanded))}>
          <div className="text-muted-foreground">{isExpanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}</div>
          <ListChecksIcon className="size-3.5 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">执行计划 · {title || "待确认"}</span>
        </div>
      </div>
      <div className="grid transition-[grid-template-rows] duration-200 ease-out overflow-hidden" style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}>
        <div className="min-h-0 border-t border-border/30 px-2.5 py-2 space-y-2">
          <ol className="list-decimal list-inside text-sm text-foreground space-y-1">
            {steps.map((s, i) => (
              <li key={i}>
                {s.description}
                {s.duration && <span className="text-muted-foreground text-xs ml-1">({s.duration})</span>}
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button size="sm" onClick={handleConfirm}>确认执行</Button>
            <Button size="sm" variant="outline" onClick={handleModify}>修改计划</Button>
            <Button size="sm" variant="destructive" onClick={handleCancel}>取消</Button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================
// 审批卡片 - 单选/多选 CTA
// ============================================================
const ApprovalCardUI: FC<{
  question?: string;
  options?: { id: string; label: string; description?: string; icon?: string }[];
  multiple?: boolean;
  onAction?: (action: string, data: any) => void;
}> = ({ question, options = [], multiple, onAction }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const handleToggle = useCallback((id: string) => {
    setSelected((prev) =>
      multiple ? (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
        : (prev.includes(id) ? [] : [id])
    );
  }, [multiple]);
  const handleSubmit = useCallback(() => {
    onAction?.("submit", { selected });
  }, [selected, onAction]);
  return (
    <div className={cn("my-2 rounded-md border overflow-hidden", "bg-muted/30 border-border/50")}>
      <div className="group flex items-center justify-between px-2.5 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors">
        <div className="flex items-center gap-2 flex-1" onClick={() => setIsExpanded(!isExpanded)} role="button" tabIndex={0} aria-expanded={isExpanded} onKeyDown={(e) => onEnterOrSpace(e, () => setIsExpanded(!isExpanded))}>
          <div className="text-muted-foreground">{isExpanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}</div>
          <CircleDot className="size-3.5 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">{question || "请选择"}</span>
        </div>
      </div>
      <div className="grid transition-[grid-template-rows] duration-200 ease-out overflow-hidden" style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}>
        <div className="min-h-0 border-t border-border/30 px-2.5 py-2 space-y-2">
          <div className="space-y-1.5">
            {options.map((opt) => (
              <label key={opt.id} className="flex items-start gap-2 cursor-pointer rounded px-2 py-1.5 hover:bg-muted/40">
                <input
                  type={multiple ? "checkbox" : "radio"}
                  name="approval-option"
                  checked={selected.includes(opt.id)}
                  onChange={() => handleToggle(opt.id)}
                  className="mt-1"
                />
                <div>
                  <span className="text-sm font-medium">{opt.label}</span>
                  {opt.description && <p className="text-xs text-muted-foreground">{opt.description}</p>}
                </div>
              </label>
            ))}
          </div>
          <Button size="sm" disabled={selected.length === 0} onClick={handleSubmit}>提交选择</Button>
        </div>
      </div>
    </div>
  );
};

// ============================================================
// 日志流 - 实时输出
// ============================================================
type LogEntry = { timestamp?: string; level?: string; text: string };
const LogStreamUI: FC<{
  title?: string;
  lines?: LogEntry[] | string[];
  running?: boolean;
  onAction?: (action: string, data: any) => void;
}> = ({ title, lines: linesProp = [], running, onAction }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const lines = useMemo((): LogEntry[] => {
    if (!Array.isArray(linesProp)) return [];
    if (linesProp.length === 0) return [];
    const first = linesProp[0];
    if (typeof first === "string") return (linesProp as string[]).map((text) => ({ text }));
    return linesProp as LogEntry[];
  }, [linesProp]);
  useEffect(() => {
    if (!containerRef.current || !isExpanded) return;
    containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [lines.length, isExpanded]);
  const handleCopyAll = useCallback(() => {
    const text = lines.map((l) => (typeof l === "string" ? l : l.timestamp ? `[${l.timestamp}] ${l.text}` : l.text)).join("\n");
    copyWithFeedback(text, "日志已复制");
  }, [lines]);
  const handleClear = useCallback(() => onAction?.("clear", {}), [onAction]);
  const toolbarActions: ToolbarAction[] = [
    { icon: <CopyIcon className="size-3" />, label: "复制全部", onClick: handleCopyAll },
    { icon: <XIcon className="size-3" />, label: "清空", onClick: handleClear, variant: "destructive" },
  ];
  const levelClass = (level: string | undefined) => {
    if (level === "warn") return "text-amber-600 dark:text-amber-400";
    if (level === "error") return "text-destructive";
    return "text-muted-foreground";
  };
  return (
    <div className={cn("my-2 rounded-md border overflow-hidden", "bg-muted/30 border-border/50")}>
      <div className="group flex items-center justify-between px-2.5 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors">
        <div className="flex items-center gap-2 flex-1" onClick={() => setIsExpanded(!isExpanded)} role="button" tabIndex={0} aria-expanded={isExpanded} onKeyDown={(e) => onEnterOrSpace(e, () => setIsExpanded(!isExpanded))}>
          <div className="text-muted-foreground">{isExpanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}</div>
          <Terminal className="size-3.5 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">{title || "日志"} · {lines.length} 行</span>
          {running && <Loader2 className="size-3.5 animate-spin text-primary" />}
        </div>
        <div className={TOOLBAR_VISIBILITY_CLASS}><Toolbar actions={toolbarActions} /></div>
      </div>
      <div className="grid transition-[grid-template-rows] duration-200 ease-out overflow-hidden" style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}>
        <div ref={containerRef} className="min-h-0 border-t border-border/30 max-h-64 overflow-auto font-mono text-xs p-2">
          {lines.map((l, i) => (
            <div key={i} className={cn("flex gap-2 py-0.5", levelClass(l.level))}>
              {l.timestamp && <span className="text-muted-foreground/70 shrink-0">{l.timestamp}</span>}
              {l.level && <span className="shrink-0">{l.level}</span>}
              <span className="min-w-0 wrap-break-word">{l.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ============================================================
// 主渲染组件
// ============================================================
export const GenerativeUI: FC<GenerativeUIProps> = ({ ui, onAction }) => {
  const handleAction = useCallback((action: string, data: any) => {
    if (typeof import.meta !== "undefined" && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) console.log("[GenerativeUI] Action:", action, data);
    onAction?.(action, data);
  }, [onAction]);

  if (!ui || !ui.type) {
    return null;
  }

  let inner: React.ReactNode = null;
  switch (ui.type) {
    case "chart":
      if (ui.src) {
        inner = <ChartUI src={ui.src} alt={ui.alt} caption={ui.caption} title={ui.title} data={ui.data} onAction={handleAction} />;
      }
      break;
    case "metrics":
      if (ui.metrics && Array.isArray(ui.metrics)) {
        inner = <MetricsUI metrics={ui.metrics} title={ui.title} columns={ui.columns} onAction={handleAction} />;
      }
      break;
    case "comparison":
      if (ui.left && ui.right) {
        inner = <ComparisonUI title={ui.title} leftTitle={ui.leftTitle} rightTitle={ui.rightTitle} left={ui.left} right={ui.right} />;
      }
      break;
    case "timeline":
      if (ui.items && Array.isArray(ui.items)) {
        inner = <TimelineUI title={ui.title} items={ui.items} />;
      }
      break;
    case "form":
      if (ui.fields && Array.isArray(ui.fields)) {
        inner = <FormUI title={ui.title} fields={ui.fields} submitLabel={ui.submitLabel} onAction={handleAction} />;
      }
      break;
    case "table":
      if (ui.columns && ui.data && Array.isArray(ui.data)) {
        inner = <TableUI columns={ui.columns} data={ui.data} title={ui.title} caption={ui.caption} onAction={handleAction} />;
      }
      break;
    case "system_status":
      inner = (
        <SystemStatusUI
          title={ui.title}
          healthScore={ui.healthScore}
          statuses={ui.statuses}
          summary={ui.summary}
          onAction={handleAction}
        />
      );
      break;
    case "json_viewer":
      if (ui.data !== undefined) {
        inner = <JsonViewerUI title={ui.title} data={ui.data} onAction={handleAction} />;
      }
      break;
    case "code":
      if (ui.code) {
        inner = <CodeUI code={ui.code} language={ui.language} filename={ui.filename} title={ui.title} onAction={handleAction} />;
      }
      break;
    case "markdown":
      if (ui.content) {
        inner = <MarkdownUI content={ui.content} title={ui.title} onAction={handleAction} />;
      }
      break;
    case "steps":
      if (ui.steps && Array.isArray(ui.steps)) {
        inner = <StepsUI steps={ui.steps} title={ui.title} onAction={handleAction} />;
      }
      break;
    case "evidence":
      if (ui.evidences && Array.isArray(ui.evidences)) {
        inner = <EvidenceUI evidences={ui.evidences} title={ui.title} onAction={handleAction} />;
      }
      break;
    case "document":
      if (ui.filename) {
        inner = <DocumentUI filename={ui.filename} preview={ui.preview} size={ui.size} url={ui.url} path={ui.path} type={ui.type} onAction={handleAction} />;
      }
      break;
    case "image":
      if (ui.src) {
        inner = <ImageUI src={ui.src} alt={ui.alt} caption={ui.caption} onAction={handleAction} />;
      }
      break;
    case "diff_view":
      inner = <DiffViewUI filename={ui.filename} lines={ui.lines} patch={ui.patch} onAction={handleAction} />;
      break;
    case "plan_confirm":
      inner = <PlanConfirmUI title={ui.title} steps={ui.steps} onAction={handleAction} />;
      break;
    case "approval_card":
      inner = <ApprovalCardUI question={ui.question} options={ui.options} multiple={ui.multiple} onAction={handleAction} />;
      break;
    case "log_stream":
      inner = <LogStreamUI title={ui.title} lines={ui.lines} running={ui.running} onAction={handleAction} />;
      break;
    default:
      break;
  }

  if (!inner) return null;

  return (
    <ErrorBoundary
      fallback={
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          生成式组件渲染失败，已降级显示。
        </div>
      }
    >
      <div className="my-1 animate-genui-enter">
        {inner}
      </div>
    </ErrorBoundary>
  );
};

export { TableUI, CodeUI, MarkdownUI, StepsUI, EvidenceUI, DocumentUI, ImageUI, ChartUI, MetricsUI, ComparisonUI, TimelineUI, FormUI, SystemStatusUI, JsonViewerUI };

/**
 * 用于 MessagePrimitive.Parts 的生成式UI组件
 */
export const GenerativeUIMessagePart: FC<{ part: { type: string; ui?: any }; onAction?: (action: string, data: any) => void }> = React.memo(({ part, onAction }) => {
  if (part.type !== "ui" || !part.ui) {
    return null;
  }
  return <GenerativeUI ui={part.ui} onAction={onAction} />;
});

export default GenerativeUI;
