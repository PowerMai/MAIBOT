/**
 * InlineDiffView - 聊天区内联文件变更对比组件
 * 
 * 轻量级行级 diff 展示，用于在聊天区内联显示 edit_file 的变更。
 * 不依赖外部 diff 库，使用简单的 LCS 行级 diff 算法。
 */

import React, { useState, useMemo, useCallback } from "react";
import { cn } from "../ui/utils";
import { CheckIcon, XIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { fileEventBus } from "../../lib/events/fileEvents";

interface InlineDiffViewProps {
  /** 原始文本 */
  original: string;
  /** 修改后文本 */
  modified: string;
  /** 文件路径 */
  filePath?: string;
  /** 最大显示行数 */
  maxLines?: number;
  /** 接受变更回调 */
  onAccept?: () => void;
  /** 拒绝变更回调 */
  onReject?: () => void;
  className?: string;
}

type DiffLineType = "equal" | "add" | "remove";

interface DiffLine {
  type: DiffLineType;
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

/**
 * 简单的行级 diff 算法（基于 LCS）
 * 对于聊天区内联展示足够用，不需要完整的 Myers diff
 */
function computeLineDiff(original: string, modified: string): DiffLine[] {
  const oldLines = original.split("\n");
  const newLines = modified.split("\n");
  
  // LCS 表
  const m = oldLines.length;
  const n = newLines.length;
  
  // 优化：如果行数太多，只做简单的前后匹配
  if (m + n > 2000) {
    return simpleDiff(oldLines, newLines);
  }
  
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  
  // 回溯生成 diff
  const result: DiffLine[] = [];
  let i = m, j = n;
  const stack: DiffLine[] = [];
  
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({ type: "equal", content: oldLines[i - 1], oldLineNum: i, newLineNum: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: "add", content: newLines[j - 1], newLineNum: j });
      j--;
    } else {
      stack.push({ type: "remove", content: oldLines[i - 1], oldLineNum: i });
      i--;
    }
  }
  
  // 反转（因为是从后往前回溯的）
  stack.reverse();
  return stack;
}

/** 简单 diff：用于大文件，只标记不同的行 */
function simpleDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const result: DiffLine[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  
  for (let i = 0; i < maxLen; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;
    
    if (oldLine === newLine) {
      result.push({ type: "equal", content: oldLine!, oldLineNum: i + 1, newLineNum: i + 1 });
    } else {
      if (oldLine !== undefined) {
        result.push({ type: "remove", content: oldLine, oldLineNum: i + 1 });
      }
      if (newLine !== undefined) {
        result.push({ type: "add", content: newLine, newLineNum: i + 1 });
      }
    }
  }
  
  return result;
}

/** 过滤 diff 行：只保留变更行及其上下文 */
function filterWithContext(lines: DiffLine[], contextLines: number = 3): DiffLine[] {
  if (lines.length <= 20) return lines; // 短 diff 直接全部显示
  
  const changeIndices = new Set<number>();
  lines.forEach((line, i) => {
    if (line.type !== "equal") {
      for (let j = Math.max(0, i - contextLines); j <= Math.min(lines.length - 1, i + contextLines); j++) {
        changeIndices.add(j);
      }
    }
  });
  
  const result: DiffLine[] = [];
  let lastIdx = -1;
  
  for (const idx of Array.from(changeIndices).sort((a, b) => a - b)) {
    if (lastIdx >= 0 && idx - lastIdx > 1) {
      // 插入省略标记
      result.push({ type: "equal", content: `... (${idx - lastIdx - 1} 行未变更)` });
    }
    result.push(lines[idx]);
    lastIdx = idx;
  }
  
  return result;
}

export const InlineDiffView: React.FC<InlineDiffViewProps> = ({
  original,
  modified,
  filePath,
  maxLines = 30,
  onAccept,
  onReject,
  className,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);

  const diffLines = useMemo(() => {
    const allLines = computeLineDiff(original, modified);
    const filtered = filterWithContext(allLines);
    return filtered.slice(0, maxLines);
  }, [original, modified, maxLines]);

  const stats = useMemo(() => {
    let added = 0, removed = 0;
    diffLines.forEach(l => {
      if (l.type === "add") added++;
      if (l.type === "remove") removed++;
    });
    return { added, removed };
  }, [diffLines]);

  const handleAccept = useCallback(() => {
    onAccept?.();
    if (filePath) {
      fileEventBus.openFile(filePath);
    }
  }, [onAccept, filePath]);

  if (!original && !modified) return null;

  const hasChanges = stats.added > 0 || stats.removed > 0;

  return (
    <div className={cn("my-1.5 rounded-md border border-border/50 overflow-hidden text-xs", className)}>
      {/* 头部 */}
      <div className="flex items-center justify-between px-2.5 py-1.5 bg-muted/30">
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? "收起变更对比" : "展开变更对比"}
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
        >
          <span className={cn("shrink-0 transition-transform duration-200", isExpanded && "rotate-90")}>
            <ChevronRightIcon className="size-3.5" />
          </span>
          <span className="text-[12px] font-medium">变更对比</span>
          {hasChanges ? (
            <span className="text-[11px] text-muted-foreground/70">
              <span className="text-green-600 dark:text-green-400">+{stats.added}</span>
              {" "}
              <span className="text-red-600 dark:text-red-400">-{stats.removed}</span>
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground/70">无变更</span>
          )}
        </button>
        <div className="flex items-center gap-1">
          {onAccept && (
            <button
              type="button"
              onClick={handleAccept}
              aria-label="接受变更"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-green-700 dark:text-green-400 bg-green-500/10 hover:bg-green-500/20 transition-colors"
            >
              <CheckIcon className="size-3" />
              接受
            </button>
          )}
          {onReject && (
            <button
              type="button"
              onClick={onReject}
              aria-label="拒绝变更"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-red-700 dark:text-red-400 bg-red-500/10 hover:bg-red-500/20 transition-colors"
            >
              <XIcon className="size-3" />
              拒绝
            </button>
          )}
        </div>
      </div>

      {/* Diff 内容 */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="border-t border-border/30 font-mono text-[12px] leading-[1.6] overflow-x-auto max-h-[300px] overflow-y-auto">
            {!hasChanges ? (
              <div className="px-2.5 py-2 text-muted-foreground/80">内容无差异</div>
            ) : (
            diffLines.map((line, i) => (
              <div
                key={i}
                className={cn(
                  "flex",
                  line.type === "add" && "bg-green-500/10",
                  line.type === "remove" && "bg-red-500/10",
                )}
              >
                <span className="shrink-0 w-8 text-right pr-1.5 text-muted-foreground/50 select-none tabular-nums border-r border-border/30">
                  {line.type === "remove" ? line.oldLineNum : line.type === "add" ? line.newLineNum : line.oldLineNum}
                </span>
                <span className={cn(
                  "shrink-0 w-4 text-center select-none",
                  line.type === "add" && "text-green-600 dark:text-green-400",
                  line.type === "remove" && "text-red-600 dark:text-red-400",
                )}>
                  {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
                </span>
                <span className="flex-1 px-1.5 whitespace-pre">{line.content}</span>
              </div>
            ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
