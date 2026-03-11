"use client";

import React from "react";
import { Resizable } from "re-resizable";
import { Copy, X, ExternalLink, Download, Maximize2, Minimize2, Save } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { remarkPluginsWithMath, rehypePluginsMath } from "../../lib/markdownRender";
import { toast } from "sonner";
import { toolStreamEventBus, type ToolStreamEvent } from "../../lib/events/toolStreamEvents";
import { EVENTS } from "../../lib/constants";
import { t } from "../../lib/i18n";
import { getItem as getStorageItem, setItem as setStorageItem } from "../../lib/safeStorage";
import { getCurrentWorkspacePathFromStorage } from "../../lib/sessionState";
import langgraphApi from "../../lib/langgraphApi";
import { cn } from "../ui/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import MonacoEditorEnhanced from "../MonacoEditorEnhanced";

type ArtifactItem = {
  id: string;
  title: string;
  artifactType: string;
  content: unknown;
  messageId?: string;
  createdAt: number;
};

const DEFAULT_WIDTH = 360;
const MIN_WIDTH = 260;
const MAX_WIDTH = 800;
const MAXIMIZED_WIDTH_VW = 80;
const ARTIFACT_PANEL_WIDTH_KEY = "maibot_artifact_panel_width";
const ARTIFACT_PANEL_MAXIMIZED_KEY = "maibot_artifact_panel_maximized";

function getArtifactText(item: ArtifactItem): string {
  const c = item.content;
  if (c == null) return "";
  if (typeof c === "string") return c;
  try {
    return JSON.stringify(c, null, 2);
  } catch {
    return "[无法序列化]";
  }
}

const TABLE_PAGE = 50;
const ArtifactTable: React.FC<{ rows: Array<Record<string, unknown>>; headers: string[] }> = ({ rows, headers }) => {
  const [showCount, setShowCount] = React.useState(TABLE_PAGE);
  const visible = rows.slice(0, showCount);
  const hasMore = rows.length > showCount;
  return (
    <div className="overflow-auto rounded border border-border/50">
      <table className="w-full text-xs">
        <thead className="bg-muted/40">
          <tr>{headers.map((h) => <th key={h} className="px-2 py-1 text-left font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>
          {visible.map((r, idx) => (
            <tr key={idx} className="border-t border-border/40">
              {headers.map((h) => <td key={h} className="px-2 py-1 align-top">{String(r[h] ?? "")}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {hasMore && (
        <button
          type="button"
          className="w-full py-1.5 text-[11px] text-muted-foreground hover:bg-muted/40 border-t border-border/40"
          onClick={() => setShowCount((c) => c + TABLE_PAGE)}
          aria-label={t("artifact.showMore", { visible: visible.length, total: rows.length })}
        >
          + {t("artifact.showMore", { visible: visible.length, total: rows.length })}
        </button>
      )}
    </div>
  );
};

function renderArtifactContent(item: ArtifactItem) {
  const text = getArtifactText(item);
  const type = (item.artifactType || "code").toLowerCase();

  if (type === "table" && item.content != null && Array.isArray(item.content) && item.content.length > 0 && typeof item.content[0] === "object") {
    const rows = item.content as Array<Record<string, unknown>>;
    const headers = Object.keys(rows[0] || {});
    return <ArtifactTable rows={rows} headers={headers} />;
  }

  if (type === "markdown") {
    return (
      <div
        className="prose prose-sm dark:prose-invert max-w-none overflow-x-auto overflow-y-auto rounded border border-border/50 bg-muted/10 p-3 text-xs prose-p:leading-[1.65] prose-p:my-0.5 prose-headings:font-semibold prose-headings:tracking-tight prose-blockquote:border-l-primary prose-blockquote:bg-muted/30 prose-blockquote:py-0.5 prose-code:rounded prose-code:bg-muted/60 prose-code:px-1 prose-code:py-0.5 prose-li:my-0.5 [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full"
        style={{ maxHeight: "min(60vh, 600px)" }}
      >
        <ReactMarkdown remarkPlugins={[...remarkPluginsWithMath]} rehypePlugins={[...rehypePluginsMath]}>{text}</ReactMarkdown>
      </div>
    );
  }

  if (type === "html") {
    return (
      <iframe
        srcDoc={text}
        sandbox=""
        title="HTML 预览"
        className="w-full h-[60vh] min-h-48 rounded border border-border/50 bg-background"
      />
    );
  }

  return (
    <div className="h-[50vh] min-h-[120px] rounded border border-border/50 bg-muted/20 overflow-hidden">
      <MonacoEditorEnhanced value={text} readOnly height="100%" language="plaintext" />
    </div>
  );
}

function loadSavedWidth(): number {
  const raw = getStorageItem(ARTIFACT_PANEL_WIDTH_KEY, "");
  if (!raw) return DEFAULT_WIDTH;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, n));
}

function loadSavedMaximized(): boolean {
  return getStorageItem(ARTIFACT_PANEL_MAXIMIZED_KEY, "") === "true";
}

export const ArtifactPanel: React.FC = () => {
  const [open, setOpen] = React.useState(false);
  const [width, setWidth] = React.useState(loadSavedWidth);
  const [isMaximized, setIsMaximized] = React.useState(loadSavedMaximized);
  const [items, setItems] = React.useState<ArtifactItem[]>([]);
  const [activeItemId, setActiveItemId] = React.useState<string | null>(null);
  const itemsRef = React.useRef<ArtifactItem[]>(items);
  const scrollTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const widthBeforeMaximizeRef = React.useRef(width);

  itemsRef.current = items;

  const [windowWidth, setWindowWidth] = React.useState(() => (typeof window !== "undefined" ? window.innerWidth : 1200));
  React.useEffect(() => {
    if (!isMaximized) return;
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [isMaximized]);

  const effectiveWidth = isMaximized
    ? Math.floor(windowWidth * (MAXIMIZED_WIDTH_VW / 100))
    : width;
  const toggleMaximize = React.useCallback(() => {
    if (isMaximized) {
      setWidth(widthBeforeMaximizeRef.current);
      setStorageItem(ARTIFACT_PANEL_MAXIMIZED_KEY, "false");
    } else {
      widthBeforeMaximizeRef.current = width;
      setStorageItem(ARTIFACT_PANEL_MAXIMIZED_KEY, "true");
    }
    setIsMaximized((v) => !v);
  }, [isMaximized, width]);

  const activeItem = items.find((i) => i.id === activeItemId) ?? items[0] ?? null;
  const artifactType = activeItem ? (activeItem.artifactType || "code").toLowerCase() : "code";

  const handleCopy = React.useCallback(() => {
    if (!activeItem) return;
    if (!navigator.clipboard?.writeText) {
      toast.error("当前环境不支持复制");
      return;
    }
    const text = getArtifactText(activeItem);
    navigator.clipboard.writeText(text).then(
      () => toast.success("已复制"),
      () => toast.error("复制失败")
    );
  }, [activeItem]);

  const handleSaveToWorkspace = React.useCallback(async () => {
    if (!activeItem) return;
    const workspacePath = getCurrentWorkspacePathFromStorage().trim();
    if (!workspacePath) {
      toast.error("请先选择工作区（设置 → 项目文件夹）");
      return;
    }
    const text = getArtifactText(activeItem);
    const ext = ["code", "document", "markdown"].includes((activeItem.artifactType || "code").toLowerCase())
      ? (activeItem.artifactType || "code").toLowerCase() === "markdown"
        ? "md"
        : "txt"
      : "txt";
    const defaultName = (activeItem.title ?? "artifact").replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, "_").slice(0, 40) + "." + ext;
    const relativeInput = window.prompt("保存路径（相对于工作区根），例如：output/note.md", defaultName);
    if (relativeInput == null) return;
    const relative = relativeInput.trim().replace(/^[/\\]+/, "") || defaultName;
    const fullPath = workspacePath.replace(/[/\\]+$/, "") + "/" + relative.replace(/\\/g, "/");
    try {
      await langgraphApi.writeFile(fullPath, text);
      toast.success("已保存到工作区");
      const openInEditor = window.confirm("是否在编辑区打开该文件？");
      if (openInEditor) {
        window.dispatchEvent(
          new CustomEvent(EVENTS.OPEN_FILE_IN_EDITOR, { detail: { path: fullPath } })
        );
      }
    } catch (e) {
      toast.error("保存失败", { description: e instanceof Error ? e.message : String(e) });
    }
  }, [activeItem]);

  React.useEffect(() => {
    const unsub = toolStreamEventBus.on("artifact", (ev: ToolStreamEvent) => {
      const artifactType = String((ev as any).artifact_type || (ev as any).type_hint || "document");
      const title = String((ev as any).title || "Artifact");
      const rawContent = (ev as any).content ?? (ev as any).data ?? "";
      let content: string | unknown[] =
        rawContent == null
          ? ""
          : typeof rawContent === "string"
            ? rawContent
            : Array.isArray(rawContent)
              ? rawContent
              : (() => {
                  try {
                    return JSON.stringify(rawContent, null, 2);
                  } catch {
                    return "[无法序列化]";
                  }
                })();
      const messageId = String((ev as any).msg_id || "").trim() || undefined;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      React.startTransition(() => {
        setItems((prev) => [{ id, title, artifactType, content, messageId, createdAt: Date.now() }, ...prev].slice(0, 20));
        setActiveItemId(id);
        setOpen(true);
      });
    });
    return unsub;
  }, []);

  React.useEffect(() => {
    const onArtifactFocus = (ev: Event) => {
      const detail = (ev as CustomEvent<{ messageId?: string }>).detail;
      const messageId = String(detail?.messageId || "").trim();
      if (!messageId) return;
      const currentItems = itemsRef.current;
      const matched = currentItems.find((item) => item.messageId === messageId);
      if (!matched) return;
      setOpen(true);
      setActiveItemId(matched.id);
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = setTimeout(() => {
        scrollTimerRef.current = null;
        const target = document.querySelector(`[data-artifact-id="${matched.id}"]`);
        if (target instanceof HTMLElement) {
          target.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      }, 80);
    };
    window.addEventListener(EVENTS.ARTIFACT_FOCUS_REQUEST, onArtifactFocus);
    return () => {
      window.removeEventListener(EVENTS.ARTIFACT_FOCUS_REQUEST, onArtifactFocus);
      if (scrollTimerRef.current) {
        clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = null;
      }
    };
  }, []);

  return (
    <div className={cn("h-full flex flex-row-reverse shrink-0 transition-all duration-200 border-l border-border/50", open ? "" : "w-10")}>
      <button
        className="h-10 w-10 shrink-0 text-xs hover:bg-muted/50 flex items-center justify-center"
        onClick={() => setOpen((v) => !v)}
        title={t("artifact.panel.title")}
      >
        {open ? "Artifact" : "A"}
      </button>
      {open && (
        <Resizable
          size={{ width: effectiveWidth, height: "100%" }}
          minWidth={MIN_WIDTH}
          maxWidth={isMaximized ? effectiveWidth + 1 : MAX_WIDTH}
          onResizeStop={(_e, _dir, ref) => {
            if (isMaximized) return;
            const w = ref.offsetWidth;
            setWidth(w);
            setStorageItem(ARTIFACT_PANEL_WIDTH_KEY, String(w));
          }}
          enable={{ left: !isMaximized }}
          handleClasses={{ left: "hover:bg-primary/20 active:bg-primary/40 rounded-l transition-colors duration-150 w-1 cursor-ew-resize" }}
          className="border-l border-border/50 bg-background/95 backdrop-blur-sm flex flex-col shrink-0"
        >
          <div className="flex items-center gap-2 px-3 h-9 border-b border-border/40 shrink-0">
            <span className="text-[11px] font-mono text-muted-foreground/70 truncate flex-1">{activeItem?.title ?? "Artifact"}</span>
            <Badge variant="secondary" className="text-[10px] font-normal">{artifactType}</Badge>
            <button
              type="button"
              title={isMaximized ? t("artifact.panel.restore") : t("artifact.panel.maximize")}
              aria-label={isMaximized ? t("artifact.panel.restore") : t("artifact.panel.maximize")}
              className="h-6 w-6 rounded hover:bg-muted/60 flex items-center justify-center"
              onClick={toggleMaximize}
            >
              {isMaximized ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
            </button>
            {["code", "document", "markdown"].includes(artifactType) && (
              <>
                <button
                  type="button"
                  title={t("toolCard.openInEditor")}
                  aria-label={t("toolCard.openInEditor")}
                  className="h-6 w-6 rounded hover:bg-muted/60 flex items-center justify-center"
                  onClick={() => {
                    const text = activeItem ? getArtifactText(activeItem) : "";
                    const ext = artifactType === "markdown" ? "md" : "txt";
                    const safeTitle = (activeItem?.title ?? "output").replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, "_").slice(0, 40);
                    window.dispatchEvent(new CustomEvent(EVENTS.OPEN_FILE_IN_EDITOR, {
                      detail: {
                        path: `__artifact__/${safeTitle}.${ext}`,
                        content: text,
                        isVirtual: true,
                      },
                    }));
                    toast.success("已在编辑器中打开");
                  }}
                >
                  <ExternalLink className="size-3" />
                </button>
                <button
                  type="button"
                  title="下载为文件"
                  aria-label="下载为文件"
                  className="h-6 w-6 rounded hover:bg-muted/60 flex items-center justify-center"
                  onClick={() => {
                    const text = activeItem ? getArtifactText(activeItem) : "";
                    const ext = artifactType === "markdown" ? "md" : "txt";
                    const safeTitle = (activeItem?.title ?? "output").replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, "_").slice(0, 40);
                    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${safeTitle}.${ext}`;
                    a.click();
                    URL.revokeObjectURL(url);
                    toast.success("已下载");
                  }}
                >
                  <Download className="size-3" />
                </button>
                <button
                  type="button"
                  title="保存到工作区"
                  className="h-6 w-6 rounded hover:bg-muted/60 flex items-center justify-center"
                  onClick={handleSaveToWorkspace}
                >
                  <Save className="size-3" />
                </button>
              </>
            )}
            {artifactType === "table" && activeItem && Array.isArray(activeItem.content) && (activeItem.content as Array<Record<string, unknown>>).length > 0 && (
              <button
                type="button"
                title="下载为 CSV"
                className="h-6 w-6 rounded hover:bg-muted/60 flex items-center justify-center"
                onClick={() => {
                  const rows = activeItem.content as Array<Record<string, unknown>>;
                  const headers = Object.keys(rows[0] || {});
                  const escape = (v: unknown) => {
                    const s = String(v ?? "");
                    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
                  };
                  const csv = [headers.map(escape).join(","), ...rows.map((r) => headers.map((h) => escape(r[h])).join(","))].join("\n");
                  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `${activeItem.title ?? "table"}.csv`;
                  a.click();
                  URL.revokeObjectURL(url);
                  toast.success("已下载 CSV");
                }}
              >
                <Download className="size-3" />
              </button>
            )}
            <button type="button" onClick={handleCopy} className="h-6 w-6 rounded hover:bg-muted/60 flex items-center justify-center" title={t("common.copy")} aria-label={t("artifact.copyAria")}>
              <Copy className="size-3" />
            </button>
            <button type="button" onClick={() => setOpen(false)} className="h-6 w-6 rounded hover:bg-muted/60 flex items-center justify-center" title={t("common.close")} aria-label={t("artifact.panel.closeAria")}>
              <X className="size-3" />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-auto p-2 space-y-2">
            {items.length === 0 && (
              <div className="text-xs text-muted-foreground space-y-2 py-4 px-2 text-center">
                <p>{t("artifact.emptyTitle")}</p>
                <p className="text-[10px] opacity-80">{t("artifact.emptyHint")}</p>
                <Button size="sm" variant="outline" className="text-xs" onClick={() => window.dispatchEvent(new CustomEvent(EVENTS.OPEN_CHAT_PANEL))} aria-label={t("artifact.openChat")}>
                  {t("artifact.openChat")}
                </Button>
              </div>
            )}
            {items.length > 0 && !activeItem && <div className="text-xs text-muted-foreground">{t("artifact.selectOne")}</div>}
            {items.map((item) => (
              <div
                key={item.id}
                data-artifact-id={item.id}
                role="button"
                tabIndex={0}
                onClick={() => setActiveItemId(item.id)}
                onKeyDown={(e) => e.key === "Enter" && setActiveItemId(item.id)}
                className={cn(
                  "rounded-md border border-border/60 p-2 cursor-pointer",
                  activeItemId === item.id && "border-primary/50 bg-primary/5"
                )}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium truncate">{item.title}</span>
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-muted-foreground">{item.artifactType}</span>
                    {item.messageId ? (
                      <button
                        type="button"
                        className="text-[10px] text-primary hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveItemId(item.id);
                          window.dispatchEvent(new CustomEvent(EVENTS.MESSAGE_FOCUS_REQUEST, { detail: { messageId: item.messageId } }));
                        }}
                      >
                        {t("artifact.focusMessage")}
                      </button>
                    ) : null}
                  </div>
                </div>
                {activeItemId === item.id ? renderArtifactContent(item) : null}
              </div>
            ))}
          </div>
        </Resizable>
      )}
    </div>
  );
};

export default ArtifactPanel;
