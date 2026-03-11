"use client";

// 移除 dot.css - 使用自定义的流式输出样式
// import "@assistant-ui/react-markdown/styles/dot.css";

import {
  type CodeHeaderProps,
  type SyntaxHighlighterProps,
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import { makePrismLightSyntaxHighlighter } from "@assistant-ui/react-syntax-highlighter";
import { makePrismSyntaxHighlighter } from "@assistant-ui/react-syntax-highlighter/full";
import { useMessage } from "@assistant-ui/react";
import React, { type FC, memo, useState, useEffect, useRef, useCallback, useMemo } from "react";
import DOMPurify from "dompurify";
import {
  oneDark,
  oneLight,
} from "react-syntax-highlighter/dist/esm/styles/prism/index.js";
import { CheckIcon, CopyIcon, PlayIcon, ExternalLinkIcon, FileIcon } from "lucide-react";
import { remarkPluginsWithMath, rehypePluginsMath } from "../../lib/markdownRender";

import { TooltipIconButton } from "./tooltip-icon-button";
import { cn } from "../ui/utils";
import { fileEventBus } from "../../lib/events/fileEvents";
import langgraphApi from "../../lib/langgraphApi";
import { EVENTS } from "../../lib/constants";
import { toast } from "sonner";
import { t } from "../../lib/i18n";

// 初始化 Mermaid（暗色/亮色主题随系统或 next-themes）
let mermaidModulePromise: Promise<typeof import("mermaid")> | null = null;
const loadMermaid = () => {
  if (!mermaidModulePromise) mermaidModulePromise = import("mermaid");
  return mermaidModulePromise;
};
const initMermaid = async () => {
  const isDark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const { default: mermaid } = await loadMermaid();
  mermaid.initialize({
    startOnLoad: false,
    theme: isDark ? "dark" : "default",
    securityLevel: "sandbox",
  });
  return mermaid;
};
if (typeof window !== "undefined") {
  void initMermaid();
}

// ============================================================================
// 思考内容提取与过滤（导出供 thread.tsx AssistantMessage 使用）
// ============================================================================

export interface ParsedContent {
  /** 提取出的思考内容（可能多段） */
  thinkingBlocks: string[];
  /** 过滤后的正文 */
  mainText: string;
  /** 是否有未闭合的思考标签（流式中） */
  isThinking: boolean;
}

type CoverageChecklistData = {
  done: string[];
  pending: string[];
};

const COVERAGE_MARKER_PREFIX = "[[COVERAGE_CHECKLIST::";
const COVERAGE_MARKER_SUFFIX = "]]";

function _parseCoverageChecklistSection(text: string): { transformed: string; hasChecklist: boolean } {
  if (!text.includes("需求覆盖清单")) return { transformed: text, hasChecklist: false };
  const lines = text.split("\n");
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() || "";
    if (/^(#{1,6}\s*)?需求覆盖清单\b/.test(line)) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx < 0) return { transformed: text, hasChecklist: false };

  let endIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const line = lines[i]?.trim() || "";
    if (/^#{1,6}\s+/.test(line)) {
      endIdx = i;
      break;
    }
  }

  const body = lines.slice(headingIdx + 1, endIdx);
  const done: string[] = [];
  const pending: string[] = [];
  for (const rawLine of body) {
    const line = (rawLine || "").trim();
    if (!line) continue;
    const cleaned = line
      .replace(/^[-*]\s*/, "")
      .replace(/^\[(x|X|√)\]\s*/, "")
      .replace(/^\[\s*\]\s*/, "")
      .trim();
    if (!cleaned) continue;
    if (/\[(x|X|√)\]/.test(line) || cleaned.startsWith("已完成")) {
      done.push(cleaned);
    } else if (/\[\s*\]/.test(line) || /待澄清|未完成|待补充/.test(cleaned)) {
      pending.push(cleaned);
    }
  }

  if (done.length === 0 && pending.length === 0) {
    return { transformed: text, hasChecklist: false };
  }
  const payload: CoverageChecklistData = {
    done: done.slice(0, 5),
    pending: pending.slice(0, 5),
  };
  const marker = `${COVERAGE_MARKER_PREFIX}${encodeURIComponent(JSON.stringify(payload))}${COVERAGE_MARKER_SUFFIX}`;
  const rebuilt = [
    ...lines.slice(0, headingIdx),
    marker,
    ...lines.slice(endIdx),
  ].join("\n");
  return { transformed: rebuilt, hasChecklist: true };
}

function _extractPlainText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(_extractPlainText).join("");
  if (React.isValidElement(node)) {
    return _extractPlainText((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

const CompactCoverageBadge: FC<{ done: string[] }> = ({ done }) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <span className="my-2 inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="inline-flex items-center rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[12px] text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/15 transition-colors"
      >
        需求已覆盖（{done.length}）{expanded ? " · 收起" : " · 查看"}
      </button>
      {expanded && (
        <span className="rounded border border-border/40 bg-muted/20 px-2 py-1 text-[12px] text-muted-foreground">
          {done.join("；")}
        </span>
      )}
    </span>
  );
};

/**
 * 从消息文本中提取思考内容和正文
 * 支持 <think>、<reasoning> 标签格式
 */
export function parseThinkingContent(text: string): ParsedContent {
  if (typeof text !== 'string') {
    return { thinkingBlocks: [], mainText: text, isThinking: false };
  }

  const thinkingBlocks: string[] = [];
  let mainText = text;

  // 提取 <think>...</think> 内容（含 redacted_reasoning 变体）
  const thinkMatches = mainText.matchAll(/<think>([\s\S]*?)<\/(?:think|redacted_reasoning)>/gi);
  for (const match of thinkMatches) {
    const content = match[1].trim();
    if (content) thinkingBlocks.push(content);
  }
  mainText = mainText.replace(/<think>[\s\S]*?<\/(?:think|redacted_reasoning)>/gi, '');

  // 提取 <reasoning>...</reasoning> 内容
  const reasoningMatches = mainText.matchAll(/<reasoning>([\s\S]*?)<\/reasoning>/gi);
  for (const match of reasoningMatches) {
    const content = match[1].trim();
    if (content) thinkingBlocks.push(content);
  }
  mainText = mainText.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');

  // 移除 <debug>...</debug> 和 <system>...</system>（不显示）
  mainText = mainText.replace(/<debug>[\s\S]*?<\/debug>/gi, '');
  mainText = mainText.replace(/<system>[\s\S]*?<\/system>/gi, '');

  // 移除工具调用的详细参数
  mainText = mainText.replace(/Tool call:\s*\{[\s\S]*?\}/gi, '');

  // 检测未闭合的思考标签（流式输出中）
  const hasUnclosedThink = /<think>/gi.test(mainText) && !/<\/think>/gi.test(mainText);
  const hasUnclosedReasoning = /<reasoning>/gi.test(mainText) && !/<\/reasoning>/gi.test(mainText);
  const isThinking = hasUnclosedThink || hasUnclosedReasoning;

  if (isThinking) {
    // 提取未闭合标签中的内容作为正在进行的思考
    const unclosedThinkMatch = mainText.match(/<think>([\s\S]*)$/i);
    const unclosedReasoningMatch = mainText.match(/<reasoning>([\s\S]*)$/i);
    if (unclosedThinkMatch?.[1]?.trim()) {
      thinkingBlocks.push(unclosedThinkMatch[1].trim());
    }
    if (unclosedReasoningMatch?.[1]?.trim()) {
      thinkingBlocks.push(unclosedReasoningMatch[1].trim());
    }
    // 移除未闭合部分
    mainText = mainText.replace(/<think>[\s\S]*$/gi, '');
    mainText = mainText.replace(/<reasoning>[\s\S]*$/gi, '');
  }

  // 清理多余空白行
  mainText = mainText.replace(/\n{3,}/g, '\n\n').trim();

  return { thinkingBlocks, mainText, isThinking };
}

/**
 * 过滤消息内容 - 移除思考/调试标签
 * 用于 MarkdownTextPrimitive 的 preprocess
 */
const _FILTER_FAST_CHECK = /<(?:think|reasoning|debug|system)>|Tool call:\s*\{/i;

function filterReasoningContent(text: string): string {
  if (typeof text !== 'string') return text;
  if (!_FILTER_FAST_CHECK.test(text) && !/\n{3,}/.test(text)) return text;
  let filtered = text;
  filtered = filtered.replace(/<think>[\s\S]*?<\/(?:think|redacted_reasoning)>/gi, '');
  filtered = filtered.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
  filtered = filtered.replace(/<debug>[\s\S]*?<\/debug>/gi, '');
  filtered = filtered.replace(/<system>[\s\S]*?<\/system>/gi, '');
  filtered = filtered.replace(/Tool call:\s*\{[\s\S]*?\}/gi, '');
  const hasUnclosed = (/<think>/gi.test(filtered) && !/<\/think>/gi.test(filtered)) ||
                      (/<reasoning>/gi.test(filtered) && !/<\/reasoning>/gi.test(filtered));
  if (hasUnclosed) {
    filtered = filtered.replace(/<think>[\s\S]*$/gi, '');
    filtered = filtered.replace(/<reasoning>[\s\S]*$/gi, '');
  }
  const checklist = _parseCoverageChecklistSection(filtered);
  filtered = checklist.transformed;
  filtered = filtered.replace(/\n{3,}/g, '\n\n').trim();
  return filtered;
}

const MarkdownTextImpl = () => {
  const isStreaming = useMessage((state) => state.status?.type === "running");
  return (
    <div className={cn("aui-md-wrapper min-w-0 overflow-x-auto wrap-break-word", isStreaming && "aui-md-streaming")}>
      <MarkdownTextPrimitive
        remarkPlugins={[...remarkPluginsWithMath]}
        rehypePlugins={[...rehypePluginsMath]}
        className="aui-md prose prose-sm dark:prose-invert max-w-none overflow-x-auto [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full prose-p:leading-[1.65] prose-headings:font-semibold prose-headings:tracking-tight prose-h1:text-lg prose-h1:border-b prose-h1:pb-1 prose-h1:mb-2 prose-h2:text-base prose-h2:mt-4 prose-h2:mb-1.5 prose-h3:text-sm prose-h3:mt-3 prose-h3:mb-1 prose-blockquote:border-l-primary prose-blockquote:bg-muted/30 prose-blockquote:py-1 prose-blockquote:pl-3 prose-pre:bg-muted/50 dark:prose-pre:bg-muted/30 prose-pre:border prose-pre:border-border/50 prose-pre:rounded-md prose-code:rounded prose-code:bg-muted/60 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.9em] prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-li:leading-relaxed prose-table:text-sm prose-table:border-collapse prose-th:bg-muted/50 prose-th:px-3 prose-th:py-2 prose-th:border prose-th:border-border prose-th:font-medium prose-td:px-3 prose-td:py-2 prose-td:border prose-td:border-border"
        components={defaultComponents}
        componentsByLanguage={componentsByLanguage}
        preprocess={filterReasoningContent}
      />
    </div>
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

/** 从 language 字段中提取文件路径（如 `python:path/to/file.py` 或 `path/to/file.py`） */
function extractFilePathFromLanguage(language: string | undefined): { lang: string; filePath: string | null } {
  if (!language) return { lang: "", filePath: null };
  // 格式: lang:path/to/file.ext
  const colonIdx = language.indexOf(":");
  if (colonIdx > 0) {
    const lang = language.slice(0, colonIdx).trim();
    const path = language.slice(colonIdx + 1).trim();
    if (path && /\.\w+$/.test(path)) {
      return { lang, filePath: path };
    }
  }
  // 纯文件路径（如 `src/utils.ts`）
  if (/[/\\]/.test(language) && /\.\w+$/.test(language)) {
    return { lang: "", filePath: language };
  }
  return { lang: language, filePath: null };
}

const _LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  js: "javascript", ts: "typescript", tsx: "tsx", jsx: "jsx",
  py: "python", python: "python", sh: "shell", bash: "bash",
  json: "json", md: "markdown", sql: "sql", css: "css",
  html: "html", yaml: "yaml", yml: "yaml",
};

const ACTIVE_FILE_PATH_KEY = "maibot_editor_active_file_path";

const CodeHeader: FC<CodeHeaderProps> = memo(({ language, code }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const [isApplying, setIsApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const [showPathInput, setShowPathInput] = useState(false);
  const [pathInputValue, setPathInputValue] = useState("");
  const applyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const { lang, filePath } = extractFilePathFromLanguage(language);

  const onCopy = () => {
    if (!code || isCopied) return;
    copyToClipboard(code);
  };

  const applyToPath = useCallback(async (targetPath: string) => {
    if (!code || !targetPath.trim() || isApplying) return;
    const path = targetPath.trim();
    setIsApplying(true);
    setShowPathInput(false);
    setPathInputValue("");
    try {
      let originalContent = "";
      try {
        originalContent = await langgraphApi.readFile(path);
      } catch {
        // 文件可能不存在，视为空
      }
      await langgraphApi.writeFile(path, code);
      if (!mountedRef.current) return;
      fileEventBus.openFile(path);
      setApplied(true);
      if (applyResetTimerRef.current) clearTimeout(applyResetTimerRef.current);
      applyResetTimerRef.current = setTimeout(() => {
        applyResetTimerRef.current = null;
        if (mountedRef.current) setApplied(false);
      }, 3000);
      toast.success("已应用到文件", { description: path });
      window.dispatchEvent(
        new CustomEvent(EVENTS.OPEN_FILE_IN_EDITOR, {
          detail: { path, showDiff: true, diffOriginal: originalContent },
        })
      );
    } catch (e) {
      console.error("Apply code failed:", e);
      if (mountedRef.current) toast.error("应用到文件失败", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      if (mountedRef.current) setIsApplying(false);
    }
  }, [code, isApplying]);

  const onApply = useCallback(() => {
    if (!code || isApplying) return;
    const fallbackPath =
      typeof sessionStorage !== "undefined" ? sessionStorage.getItem(ACTIVE_FILE_PATH_KEY) : null;
    const targetPath = filePath ?? fallbackPath;
    if (targetPath) {
      applyToPath(targetPath);
    } else {
      setShowPathInput(true);
    }
  }, [code, filePath, isApplying, applyToPath]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (applyResetTimerRef.current) clearTimeout(applyResetTimerRef.current);
    };
  }, []);

  const onOpenInEditor = useCallback(() => {
    if (!code) return;
    const ext = lang === "python" ? "py" : lang === "typescript" ? "ts" : lang === "javascript" ? "js" : lang || "txt";
    const path = `__code__/snippet.${ext}`;
    window.dispatchEvent(
      new CustomEvent(EVENTS.OPEN_FILE_IN_EDITOR, {
        detail: { path, content: code, isVirtual: true },
      })
    );
    toast.success("已在编辑器中打开");
  }, [code, lang]);

  const displayLanguage = lang ? (_LANGUAGE_DISPLAY_NAMES[lang.toLowerCase()] || lang) : "";
  const lineCount = React.useMemo(() => {
    if (!code) return 0;
    return code.split("\n").length;
  }, [code]);

  // Cursor 风格：代码头信息 + 操作区
  return (
    <div className="aui-code-header-root mt-3 flex items-center justify-between rounded-t-lg bg-muted/85 dark:bg-muted/40 border border-b-0 border-border/50 px-2.5 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="inline-flex items-center rounded border border-border/40 bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {t("codeBlock.label")}
        </span>
        <span className="aui-code-header-language text-[12px] text-muted-foreground">
          {displayLanguage || "text"}
        </span>
        {lineCount > 0 && (
          <span className="text-[10px] text-muted-foreground/80 rounded border border-border/35 bg-background/50 px-1 py-0.5">
            {lineCount} 行
          </span>
        )}
        {filePath && (
          <span className="text-[11px] text-primary/80 truncate max-w-[220px] rounded border border-primary/20 bg-primary/8 px-1.5 py-0.5" title={filePath}>
            {filePath}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 flex-wrap">
        {showPathInput ? (
          <>
            <input
              type="text"
              value={pathInputValue}
              onChange={(e) => setPathInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyToPath(pathInputValue);
                if (e.key === "Escape") setShowPathInput(false);
              }}
              placeholder={t("codeBlock.pathPlaceholder")}
              className="h-6 w-40 text-[11px] px-1.5 rounded border border-border bg-background outline-none"
              autoFocus
            />
            <button
              type="button"
              onClick={() => applyToPath(pathInputValue)}
              disabled={!pathInputValue.trim() || isApplying}
              className="text-[12px] px-1.5 py-0.5 rounded text-primary/80 hover:text-primary hover:bg-primary/10"
            >
              {t("common.confirm")}
            </button>
            <button
              type="button"
              onClick={() => { setShowPathInput(false); setPathInputValue(""); }}
              className="text-[12px] px-1.5 py-0.5 rounded text-muted-foreground hover:text-foreground"
            >
              {t("common.cancel")}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onApply}
            disabled={isApplying}
            aria-label={applied ? "已应用" : "应用到文件"}
            className={cn(
              "flex items-center gap-1 text-[12px] px-1.5 py-0.5 rounded transition-colors",
              applied
                ? "text-green-600 dark:text-green-400"
                : "text-primary/80 hover:text-primary hover:bg-primary/10"
            )}
            title={applied ? "已应用" : "应用到文件"}
          >
            {applied ? (
              <CheckIcon className="size-3.5" />
            ) : isApplying ? (
              <div className="size-3.5 border-2 border-primary/50 border-t-transparent rounded-full animate-spin" />
            ) : (
              <PlayIcon className="size-3.5" />
            )}
            <span>{applied ? "已应用" : "应用"}</span>
          </button>
        )}
        <button
          type="button"
          onClick={onOpenInEditor}
          aria-label="Apply"
          className="flex items-center gap-1 text-[12px] text-primary/80 hover:text-primary hover:bg-primary/10 rounded px-1.5 py-0.5 transition-colors"
          title={t("codeBlock.openInEditorApply")}
        >
          <ExternalLinkIcon className="size-3.5" />
          <span>Apply</span>
        </button>
        <button
          type="button"
          onClick={onCopy}
          aria-label={isCopied ? t("codeBlock.copied") : t("codeBlock.copy")}
          className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground transition-colors px-1"
          title={isCopied ? t("codeBlock.copied") : t("codeBlock.copy")}
        >
          {isCopied ? (
            <CheckIcon className="size-3.5" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
        </button>
      </div>
    </div>
  );
});

const useCopyToClipboard = ({
  copiedDuration = 3000,
}: {
  copiedDuration?: number;
} = {}) => {
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const copyToClipboard = (value: string) => {
    if (!value) return;

    navigator.clipboard.writeText(value).then(() => {
      if (!mountedRef.current) return;
      setIsCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => {
        copiedTimerRef.current = null;
        if (mountedRef.current) setIsCopied(false);
      }, copiedDuration);
    }).catch(() => toast.error(t("common.copyFailed")));
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  return { isCopied, copyToClipboard };
};

/** 500ms 防抖 */
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}

/** Mermaid 图表组件：防抖 500ms、淡入、保留上次 SVG 直至新图就绪 */
const MermaidDiagram: FC<{ source: string; className?: string }> = memo(({ source, className }) => {
  const debouncedSource = useDebounce(source?.trim() ?? "", 500);
  const workerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSvgHtml, setLastSvgHtml] = useState<string | null>(null);
  const [lastRenderedFor, setLastRenderedFor] = useState<string>("");

  useEffect(() => {
    if (!debouncedSource || !workerRef.current) return;
    let cancelled = false;
    setError(null);
    const run = async () => {
      try {
        const mermaid = await initMermaid();
        if (cancelled || !workerRef.current) return;
        await mermaid.run({
          nodes: [workerRef.current],
          suppressErrors: true,
        });
        if (cancelled) return;
        const svg = workerRef.current?.querySelector?.("svg");
        if (svg) {
          svg.setAttribute("width", "100%");
          svg.setAttribute("height", "auto");
          setLastSvgHtml(svg.outerHTML);
          setLastRenderedFor(debouncedSource);
        }
      } catch (err) {
        if (!cancelled) setError(String((err as { message?: string })?.message || err));
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [debouncedSource]);

  if (error) {
    return (
      <div className={cn("my-3 rounded-lg border border-border/50 bg-muted/30 p-3", className)}>
        <pre className="text-xs text-muted-foreground whitespace-pre-wrap">{source}</pre>
        <p className="mt-2 text-xs text-red-500">Mermaid 渲染失败: {error}</p>
      </div>
    );
  }

  return (
    <div className={cn("aui-mermaid-wrapper my-3 flex justify-center overflow-x-auto rounded-lg border border-border/30 bg-muted/20 p-3 relative", className)}>
      {lastSvgHtml ? (
        <div
          className="animate-genui-enter w-full flex justify-center"
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(lastSvgHtml, { USE_PROFILES: { svg: true, svgFilters: true } }) }}
        />
      ) : null}
      <div
        ref={workerRef}
        className="absolute left-0 top-0 w-px h-px overflow-hidden opacity-0 pointer-events-none"
        aria-hidden
      >
        <pre className="mermaid">{debouncedSource}</pre>
      </div>
    </div>
  );
});

const PrismDark = makePrismSyntaxHighlighter({ style: oneDark });
const PrismLight = makePrismLightSyntaxHighlighter({ style: oneLight });

function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const el = document.documentElement;
    const check = () => setIsDark(el.classList.contains("dark"));
    const obs = new MutationObserver(check);
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return isDark;
}

const ThemeAwareSyntaxHighlighter: FC<SyntaxHighlighterProps> = (props) => {
  const isDark = useIsDark();
  const SH = isDark ? PrismDark : PrismLight;
  return <SH {...props} />;
};

const MermaidSyntaxHighlighter: FC<SyntaxHighlighterProps> = memo(({ code }) => (
  <MermaidDiagram source={code} className="aui-md-pre" />
));

const defaultComponents = memoizeMarkdownComponents({
  // 图片 - 支持 matplotlib 生成的图表和其他图片
  img: ({ className, src, alt, ...props }) => (
    <span className="aui-md-img-wrapper block my-3">
      <img
        className={cn(
          "aui-md-img max-w-full h-auto rounded-lg border border-border/30 shadow-sm",
          className,
        )}
        src={src}
        alt={alt || "图片"}
        loading="lazy"
        onError={(e) => {
          // 图片加载失败时显示占位符（使用 textContent 避免 XSS）
          const target = e.target as HTMLImageElement;
          target.style.display = 'none';
          const span = document.createElement('span');
          span.className = 'text-muted-foreground text-sm';
          span.textContent = `📷 图片加载失败: ${alt || src}`;
          target.parentElement?.appendChild(span);
        }}
        {...props}
      />
      {alt && (
        <span className="block text-center text-xs text-muted-foreground mt-1">
          {alt}
        </span>
      )}
    </span>
  ),
  // 标题 - Cursor 风格：紧凑间距，清晰层次
  h1: ({ className, ...props }) => (
    <h1
      className={cn(
        "aui-md-h1 mb-3 mt-4 font-semibold text-[18px] tracking-tight first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }) => (
    <h2
      className={cn(
        "aui-md-h2 mt-4 mb-2 font-semibold text-[16px] tracking-tight first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }) => (
    <h3
      className={cn(
        "aui-md-h3 mt-3 mb-2 font-semibold text-[15px] tracking-tight first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h4: ({ className, ...props }) => (
    <h4
      className={cn(
        "aui-md-h4 mt-3 mb-1.5 font-medium text-[14px] first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h5: ({ className, ...props }) => (
    <h5
      className={cn(
        "aui-md-h5 mt-2 mb-1 font-medium text-[14px] first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h6: ({ className, ...props }) => (
    <h6
      className={cn(
        "aui-md-h6 mt-2 mb-1 font-medium text-[13px] text-muted-foreground first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  // 段落 - 继承外层字号
  p: ({ className, children, ...props }) => {
    const text = _extractPlainText(children).trim();
    if (text.startsWith(COVERAGE_MARKER_PREFIX) && text.endsWith(COVERAGE_MARKER_SUFFIX)) {
      const encoded = text.slice(COVERAGE_MARKER_PREFIX.length, -COVERAGE_MARKER_SUFFIX.length);
      try {
        const parsed = JSON.parse(decodeURIComponent(encoded)) as CoverageChecklistData;
        const done = Array.isArray(parsed.done) ? parsed.done : [];
        const pending = Array.isArray(parsed.pending) ? parsed.pending : [];
        // 极简场景：无待澄清且条目很少时，仅显示单行状态标签，避免折叠块占空间
        if (pending.length === 0 && done.length > 0 && done.length <= 2) {
          return <CompactCoverageBadge done={done} />;
        }
        return (
          <details className="my-2 rounded-md border border-border/40 bg-muted/20 px-3 py-2">
            <summary className="cursor-pointer text-[12px] text-muted-foreground">
              需求覆盖清单（已完成 {done.length}，待澄清 {pending.length}）
            </summary>
            <div className="mt-2 text-sm">
              {done.length > 0 && (
                <div className="mb-1">
                  <div className="text-[12px] text-emerald-600 dark:text-emerald-400">已完成</div>
                  <ul className="ml-4 list-disc">
                    {done.map((item, idx) => (
                      <li key={`done-${idx}`}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
              {pending.length > 0 && (
                <div>
                  <div className="text-[12px] text-amber-600 dark:text-amber-400">待澄清</div>
                  <ul className="ml-4 list-disc">
                    {pending.map((item, idx) => (
                      <li key={`pending-${idx}`}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </details>
        );
      } catch {
        // marker 解析失败时回退普通段落
      }
    }
    return (
      <p
        className={cn(
          "aui-md-p mt-2 mb-2 leading-[1.65] first:mt-0 last:mb-0",
          className,
        )}
        {...props}
      >
        {children}
      </p>
    );
  },
  // 链接 - 跟随主题色
  a: ({ className, ...props }) => (
    <a
      className={cn(
        "aui-md-a text-primary hover:text-primary/80 hover:underline underline-offset-2 transition-colors",
        className,
      )}
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    />
  ),
  strong: ({ className, ...props }) => (
    <strong className={cn("aui-md-strong font-semibold text-foreground", className)} {...props} />
  ),
  em: ({ className, ...props }) => (
    <em className={cn("aui-md-em italic", className)} {...props} />
  ),
  del: ({ className, ...props }) => (
    <del className={cn("aui-md-del line-through text-muted-foreground", className)} {...props} />
  ),
  // 引用块
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn(
        "aui-md-blockquote border-l-[3px] border-l-primary/60 pl-4 my-2 py-0.5 text-muted-foreground bg-muted/30 rounded-r",
        className,
      )}
      {...props}
    />
  ),
  // 列表（含嵌套：子列表缩进与层次）
  ul: ({ className, ...props }) => (
    <ul
      className={cn(
        "aui-md-ul my-2 ml-4 list-disc [&>li]:mt-0.5 [&_ul]:ml-4 [&_ul]:mt-0.5 [&_ol]:ml-4 [&_ol]:mt-0.5 [&_ul]:list-[circle] [&_ul_ul]:list-[square]",
        className,
      )}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      className={cn(
        "aui-md-ol my-2 ml-4 list-decimal [&>li]:mt-0.5 [&_ul]:ml-4 [&_ul]:mt-0.5 [&_ol]:ml-4 [&_ol]:mt-0.5",
        className,
      )}
      {...props}
    />
  ),
  li: ({ className, ...props }) => (
    <li className={cn("aui-md-li leading-[1.65]", className)} {...props} />
  ),
  // 分隔线
  hr: ({ className, ...props }) => (
    <hr className={cn("aui-md-hr my-3 border-border/50", className)} {...props} />
  ),
  // 表格 - 更紧凑，表头/表体区分样式
  table: ({ className, ...props }) => (
    <div className="aui-md-table-wrapper my-3 w-full overflow-x-auto overflow-y-auto">
      <table
        className={cn(
          "aui-md-table w-full border-separate border-spacing-0 text-sm",
          className,
        )}
        {...props}
      />
    </div>
  ),
  thead: ({ className, ...props }) => (
    <thead className={cn("aui-md-thead", className)} {...props} />
  ),
  tbody: ({ className, ...props }) => (
    <tbody className={cn("aui-md-tbody", className)} {...props} />
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "aui-md-th bg-muted/50 px-3 py-1.5 text-left font-semibold text-xs first:rounded-tl-lg last:rounded-tr-lg [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn(
        "aui-md-td border-b border-l border-border/30 px-3 py-1.5 text-left text-sm last:border-r [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }) => (
    <tr
      className={cn(
        "aui-md-tr m-0 border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-bl-lg [&:last-child>td:last-child]:rounded-br-lg hover:bg-muted/20 transition-colors",
        className,
      )}
      {...props}
    />
  ),
  sup: ({ className, ...props }) => (
    <sup
      className={cn("aui-md-sup [&>a]:text-xs [&>a]:no-underline", className)}
      {...props}
    />
  ),
  // 代码块容器：由 CodeHeader 提供复制等操作，SyntaxHighlighter 提供高亮；>50 行可折叠
  pre: function Pre({ className, children, ...props }) {
    const preRef = useRef<HTMLPreElement>(null);
    const [lineCount, setLineCount] = useState(0);
    const [collapsed, setCollapsed] = useState(false);
    const [hasActiveFile, setHasActiveFile] = useState(false);
    useEffect(() => {
      const text = preRef.current?.textContent ?? "";
      const n = text.split(/\n/).length;
      setLineCount(n);
      setCollapsed((prev) => prev || n > 50);
    }, [children]);
    useEffect(() => {
      if (typeof sessionStorage === "undefined") return;
      const update = () => setHasActiveFile(!!sessionStorage.getItem(ACTIVE_FILE_PATH_KEY));
      update();
      window.addEventListener(EVENTS.ACTIVE_FILE_PATH_CHANGED, update);
      return () => window.removeEventListener(EVENTS.ACTIVE_FILE_PATH_CHANGED, update);
    }, []);
    const over50 = lineCount > 50;
    const isBlock = lineCount > 2;
    return (
      <div className="relative group rounded-lg overflow-hidden shadow-sm">
        {isBlock && (
          <button
            type="button"
            onClick={() => {
              const storedPath =
                typeof sessionStorage !== "undefined" ? sessionStorage.getItem(ACTIVE_FILE_PATH_KEY) : null;
              setHasActiveFile(!!storedPath);
              if (!storedPath) return;
              const path = storedPath || undefined;
              window.dispatchEvent(
                new CustomEvent(EVENTS.OPEN_FILE_IN_EDITOR, {
                  detail: {
                    showDiff: true,
                    diffContent: preRef.current?.textContent ?? "",
                    ...(path ? { path } : {}),
                  },
                })
              );
            }}
            disabled={!hasActiveFile}
            className={cn(
              "absolute top-1 right-8 z-10 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded text-primary",
              hasActiveFile ? "bg-primary/15 hover:bg-primary/25" : "cursor-not-allowed opacity-60 bg-muted"
            )}
            title={hasActiveFile ? t("codeBlock.applyToFileTitle") : t("codeBlock.applyToFileTitleNoFile")}
          >
            <PlayIcon className="size-3" />
            Apply
          </button>
        )}
        <pre
          ref={preRef}
          className={cn(
            "aui-md-pre chat-code-block overflow-x-auto rounded-t-none! rounded-b-lg bg-muted/60 dark:bg-muted/40 border border-t-0 border-border/50 p-3 pt-9 text-[13px] text-foreground leading-normal",
            over50 && collapsed && "max-h-48 overflow-hidden",
            className,
          )}
          {...props}
        >
          {children}
        </pre>
        {over50 && (
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="mt-1 text-[12px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {collapsed ? t("toolCard.expand") : t("toolCard.collapse")}
          </button>
        )}
      </div>
    );
  },
  // 行内代码 - Cursor 风格，文件路径自动渲染为可点击芯片
  code: function Code({ className, children, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    // 行内代码中检测文件路径
    if (!isCodeBlock && typeof children === "string") {
      const text = children.trim();
      // 匹配文件路径：扩展名白名单，排除版本号等误判
      const FILE_EXTENSIONS = /\.(tsx?|jsx?|py|go|rs|java|cs|cpp?|c|h|rb|php|swift|kt|md|json|ya?ml|toml|sh|env|txt|css|s?css|html?|vue|svelte|sql|proto|lock|cfg|ini|conf|log)$/i;
      const isFilePath =
        FILE_EXTENSIONS.test(text) &&
        /^[\w./@:-]+$/.test(text) &&
        !text.startsWith("http") &&
        !/^\d+(\.\d+)+$/.test(text);
      if (isFilePath) {
        const fileName = text.split("/").pop() || text;
        return (
          <button
            type="button"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent(EVENTS.OPEN_FILE_IN_EDITOR, { detail: { path: text } })
              );
            }}
            aria-label={`打开文件 ${fileName}`}
            className={cn(
              "aui-md-file-chip inline-flex items-center gap-1 rounded px-1.5 py-0.5 bg-primary/10 hover:bg-primary/20 text-primary text-[13px] font-mono cursor-pointer transition-colors border border-primary/20",
              className,
            )}
            title={`打开 ${text}`}
          >
            <FileIcon className="size-3 shrink-0" />
            <span className="truncate max-w-[200px]">{fileName}</span>
          </button>
        );
      }
    }
    return (
      <code
        className={cn(
          !isCodeBlock &&
            "aui-md-inline-code rounded px-1 py-0.5 bg-muted/60 text-[13px] font-mono",
          className,
        )}
        {...props}
      >
        {children}
      </code>
    );
  },
  CodeHeader,
  SyntaxHighlighter: ThemeAwareSyntaxHighlighter,
});

const componentsByLanguage: Record<string, { SyntaxHighlighter: FC<SyntaxHighlighterProps> }> = {
  mermaid: { SyntaxHighlighter: MermaidSyntaxHighlighter },
};
