import React, { type FC, useState, useEffect, createContext, useContext, useRef, useCallback, useMemo } from "react";
import { Skeleton } from "../ui/skeleton";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import {
  AssistantIf,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useThreadListItemRuntime,
  useAssistantState,
} from "@assistant-ui/react";
import { PlusIcon, XIcon, Trash2, History, MoreHorizontal, MessageSquare, Loader2, Download, Search, Pin, PinOff, Pencil } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/context-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { listThreads, cleanupExpiredThreads, deleteThread, updateThreadTitle } from "../../lib/api/langserveChat";
import { t } from "../../lib/i18n";
import { toast } from "sonner";
import { cn } from "../ui/utils";
import { EVENTS, type SessionChangedDetail } from "../../lib/constants";
import { getItem as getStorageItem, setItem as setStorageItem } from "../../lib/safeStorage";
import { setScopedChatMode } from "../../lib/chatModeState";
import { getCurrentThreadIdFromStorage, getCurrentWorkspacePathFromStorage } from "../../lib/sessionState";
import { readThreadHealthMap } from "../../lib/runSummaryState";

/** 线程状态上下文：用于在列表中显示 running 等状态，不引入 Task 层级 */
export const ThreadStatusContext = createContext<{
  taskRunning: boolean;
  activeThreadId: string | null;
}>({ taskRunning: false, activeThreadId: null });

export const useThreadStatus = () => useContext(ThreadStatusContext);

/** 每分钟递增，用于驱动列表项相对时间戳自动刷新 */
const RelativeTimeRefreshContext = createContext(0);
/** threadId -> 最后活动时间戳（用于列表项显示相对时间） */
const ThreadUpdatedAtContext = createContext<Record<string, number>>({});
const useThreadUpdatedAt = () => useContext(ThreadUpdatedAtContext);
/** 供历史按钮等子组件更新 threadId -> 时间戳 的 setter */
const ThreadUpdatedAtSetContext = createContext<React.Dispatch<React.SetStateAction<Record<string, number>>>>(() => {});

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const d = new Date(ts);
  const todayStart = new Date(now).setHours(0, 0, 0, 0);
  const diff = now - ts;
  if (diff < 60_000) return "刚刚";
  if (ts >= todayStart) return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const yesterdayStart = todayStart - 86400_000;
  if (ts >= yesterdayStart) return "昨天";
  if (diff < 7 * 86400_000) return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query.trim()) return <span>{text}</span>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, idx)}
      <mark className="bg-primary/20 text-foreground rounded-[2px] px-0.5">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </span>
  );
}

export interface ThreadListProps {
  /** 关闭面板（如关闭右侧对话区），显示在按钮组最右侧 */
  onClose?: () => void;
}

const PINNED_THREADS_KEY = "maibot_pinned_threads";
const THREAD_HISTORY_CACHE_KEY = "maibot_thread_history_cache";
const THREAD_LABEL_KEY_PREFIX = "maibot_thread_label_";
const LABEL_COLORS = ["gray", "blue", "green", "amber", "red", "purple"] as const;
const LABEL_BORDER_CLASS: Record<string, string> = {
  gray: "border-l-2 border-gray-500/70",
  blue: "border-l-2 border-blue-500/70",
  green: "border-l-2 border-green-500/70",
  amber: "border-l-2 border-amber-500/70",
  red: "border-l-2 border-red-500/70",
  purple: "border-l-2 border-purple-500/70",
};
const THREAD_HISTORY_COUNT_CACHE_TTL_MS = 20_000;
const THREAD_HISTORY_RECENT_CACHE_TTL_MS = 12_000;

/** 切换到指定线程，完成后可选执行 next。返回 cancel() 用于组件卸载时清理监听与定时器。 */
function switchThreadThen(threadId: string, next?: () => void): () => void {
  const targetThreadId = String(threadId || "").trim();
  const noop = () => {};
  if (!targetThreadId) {
    next?.();
    return noop;
  }
  let done = false;
  const cancel = () => {
    if (done) return;
    done = true;
    window.removeEventListener(EVENTS.SESSION_CHANGED, onSessionChanged as EventListener);
    window.clearTimeout(fallbackTimer);
  };
  const finish = () => {
    if (done) return;
    done = true;
    window.removeEventListener(EVENTS.SESSION_CHANGED, onSessionChanged as EventListener);
    window.clearTimeout(fallbackTimer);
    next?.();
  };
  const fail = () => {
    if (done) return;
    done = true;
    window.removeEventListener(EVENTS.SESSION_CHANGED, onSessionChanged as EventListener);
    window.clearTimeout(fallbackTimer);
  };
  const onSessionChanged = (event: Event) => {
    const detail = (event as CustomEvent<SessionChangedDetail>).detail;
    if (String(detail?.threadId || "").trim() === targetThreadId) {
      finish();
    }
  };
  const fallbackTimer = window.setTimeout(fail, 5000);
  window.addEventListener(EVENTS.SESSION_CHANGED, onSessionChanged as EventListener);
  window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_TO_THREAD, { detail: { threadId: targetThreadId } }));
  return cancel;
}

const switchThreadThenCancelRef: { current: (() => void) | null } = { current: null };

type ThreadHistoryCache = {
  count?: number;
  countOverflow?: boolean;
  recentThreads?: { id: string; title: string }[];
  countUpdatedAt?: number;
  recentUpdatedAt?: number;
};

function getThreadHistoryCache(workspacePath: string): ThreadHistoryCache {
  try {
    const key = `${THREAD_HISTORY_CACHE_KEY}:${workspacePath || "__global__"}`;
    const raw = getStorageItem(key);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function patchThreadHistoryCache(
  workspacePath: string,
  patch: Partial<ThreadHistoryCache>
) {
  try {
    const key = `${THREAD_HISTORY_CACHE_KEY}:${workspacePath || "__global__"}`;
    const prev = getThreadHistoryCache(workspacePath);
    setStorageItem(key, JSON.stringify({ ...prev, ...patch }));
  } catch {
    // ignore cache write failure
  }
}

function loadPinnedThreadIds(): string[] {
  try {
    const raw = getStorageItem(PINNED_THREADS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function savePinnedThreadIds(ids: string[]) {
  setStorageItem(PINNED_THREADS_KEY, JSON.stringify(Array.from(new Set(ids))));
}

const ThreadPinContext = createContext<{
  pinnedIds: string[];
  togglePin: (threadId: string) => void;
}>({
  pinnedIds: [],
  togglePin: () => {},
});

const DeleteDialogContext = createContext<{
  requestDelete: (threadId: string) => void;
}>({ requestDelete: () => {} });

type ThreadHealthMap = Record<string, { lastError?: string; updatedAt?: number; failureCount?: number }>;
const ThreadHealthMapContext = createContext<ThreadHealthMap>({});

/**
 * ThreadList - Cursor 风格聊天标签
 * 
 * 特点：
 * - 紧凑的标签设计
 * - 当前对话高亮显示
 * - 支持多对话切换
 * - 右侧按钮顺序：加号 | 历史 | 三点 | 关闭（由 onClose 提供时）
 */
const THREAD_SEARCH_RECENT_LIMIT = 30;

export const ThreadList: FC<ThreadListProps> = ({ onClose }) => {
  const newThreadButtonRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => loadPinnedThreadIds());
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [threadHealthMap, setThreadHealthMap] = useState<ThreadHealthMap>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [recentThreadsForSearch, setRecentThreadsForSearch] = useState<{ id: string; title: string }[]>([]);
  const [threadUpdatedAtMap, setThreadUpdatedAtMap] = useState<Record<string, number>>({});
  const [relativeTimeTick, setRelativeTimeTick] = useState(0);

  useEffect(() => {
    const syncHealthMap = () => {
      try {
        setThreadHealthMap(readThreadHealthMap());
      } catch {
        setThreadHealthMap({});
      }
    };
    syncHealthMap();
    window.addEventListener("storage", syncHealthMap);
    window.addEventListener(EVENTS.RUN_SUMMARY_UPDATED, syncHealthMap);
    return () => {
      window.removeEventListener("storage", syncHealthMap);
      window.removeEventListener(EVENTS.RUN_SUMMARY_UPDATED, syncHealthMap);
    };
  }, []);

  const deleteUndoTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const requestDelete = useCallback((threadId: string) => {
    setDeleteTargetId(threadId);
    setDeleteDialogOpen(true);
  }, []);

  const handleDeleteConfirm = useCallback(() => {
    if (!deleteTargetId) return;
    const id = deleteTargetId;
    const wasActive = getCurrentThreadIdFromStorage() === id;
    setDeleteDialogOpen(false);
    setDeleteTargetId(null);

    const performDelete = () => {
      deleteThread(id).then((ok) => {
        if (!mountedRef.current) return;
        if (ok) {
          setRecentThreadsForSearch((prev) => prev.filter((t) => t.id !== id));
          if (wasActive) {
            window.dispatchEvent(new CustomEvent(EVENTS.NEW_THREAD_REQUEST));
          }
        } else {
          toast.error(t("threadList.deleteFailed"));
        }
      }).catch((err) => {
        if (!mountedRef.current) return;
        console.error(err);
        toast.error(t("threadList.deleteFailed"));
      });
    };

    toast.success(t("threadList.threadDeleted"), {
      action: {
        label: t("common.undo"),
        onClick: () => {
          if (deleteUndoTimerRef.current != null) {
            clearTimeout(deleteUndoTimerRef.current);
            deleteUndoTimerRef.current = null;
          }
        },
      },
    });
    deleteUndoTimerRef.current = setTimeout(() => {
      deleteUndoTimerRef.current = null;
      performDelete();
    }, 5000);
  }, [deleteTargetId]);

  React.useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  React.useEffect(() => () => {
    if (deleteUndoTimerRef.current != null) clearTimeout(deleteUndoTimerRef.current);
  }, []);

  useEffect(() => () => {
    switchThreadThenCancelRef.current?.();
    switchThreadThenCancelRef.current = null;
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const threadId = (e as CustomEvent<SessionChangedDetail>)?.detail?.threadId;
      if (threadId) setRecentThreadsForSearch((prev) => prev.filter((t) => t.id !== threadId));
    };
    window.addEventListener(EVENTS.THREAD_DELETED, handler);
    return () => window.removeEventListener(EVENTS.THREAD_DELETED, handler);
  }, []);

  useEffect(() => {
    const handler = () => {
      newThreadButtonRef.current?.click();
    };
    window.addEventListener(EVENTS.NEW_THREAD_REQUEST, handler);
    return () => window.removeEventListener(EVENTS.NEW_THREAD_REQUEST, handler);
  }, []);

  useEffect(() => {
    const handler = () => setSearchOpen(true);
    window.addEventListener(EVENTS.THREAD_LIST_FOCUS_SEARCH, handler);
    return () => window.removeEventListener(EVENTS.THREAD_LIST_FOCUS_SEARCH, handler);
  }, []);

  const togglePin = React.useCallback((threadId: string) => {
    setPinnedIds((prev) => {
      const next = prev.includes(threadId) ? prev.filter((id) => id !== threadId) : [threadId, ...prev];
      savePinnedThreadIds(next);
      return next;
    });
  }, []);

  const threadIds = useAssistantState(({ threads }) => threads.threadIds);
  const { activeThreadId } = useThreadStatus();
  const orderedIds = useMemo(() => {
    const ids = threadIds ?? [];
    const pinned = pinnedIds.filter((id) => ids.includes(id));
    const rest = ids.filter((id) => !pinnedIds.includes(id));
    return [...pinned, ...rest];
  }, [threadIds, pinnedIds]);

  const listboxRef = useRef<HTMLDivElement>(null);
  const handleListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter" && e.key !== "Escape") return;
      if (orderedIds.length === 0) return;
      const currentIndex = activeThreadId != null ? orderedIds.indexOf(activeThreadId) : -1;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const nextIndex = currentIndex < orderedIds.length - 1 ? currentIndex + 1 : 0;
        const nextId = orderedIds[nextIndex];
        window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_TO_THREAD, { detail: { threadId: nextId } }));
        setTimeout(() => listboxRef.current?.querySelector<HTMLElement>("[aria-selected=\"true\"]")?.focus(), 0);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const prevIndex = currentIndex <= 0 ? orderedIds.length - 1 : currentIndex - 1;
        const prevId = orderedIds[prevIndex];
        window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_TO_THREAD, { detail: { threadId: prevId } }));
        setTimeout(() => listboxRef.current?.querySelector<HTMLElement>("[aria-selected=\"true\"]")?.focus(), 0);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (currentIndex >= 0 && orderedIds[currentIndex]) {
          window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_TO_THREAD, { detail: { threadId: orderedIds[currentIndex] } }));
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        (e.currentTarget as HTMLElement).blur();
      }
    },
    [orderedIds, activeThreadId]
  );

  useEffect(() => {
    if (!searchOpen) return;
    let cancelled = false;
    const workspacePath = getCurrentWorkspacePathFromStorage();
    listThreads({
      limit: THREAD_SEARCH_RECENT_LIMIT,
      metadata: workspacePath ? { workspace_path: workspacePath } : undefined,
    })
      .then((list) => {
        if (cancelled || !Array.isArray(list)) return;
        const filtered = workspacePath
          ? list.filter((t: any) => String(t?.metadata?.workspace_path || "").trim() === workspacePath)
          : list;
        const items = filtered.slice(0, THREAD_SEARCH_RECENT_LIMIT).map((t: any) => {
          const id = t.thread_id ?? t.id ?? "";
          const title = t.metadata?.title ?? t.title ?? id?.slice(0, 8) ?? "未命名";
          return { id, title: String(title).slice(0, 40) || "未命名" };
        });
        setRecentThreadsForSearch(items);
        setThreadUpdatedAtMap((prev) => {
          const next = { ...prev };
          const slice = filtered.slice(0, THREAD_SEARCH_RECENT_LIMIT) as Array<{ thread_id?: string; id?: string; metadata?: { last_active_at?: unknown; updated_at?: unknown }; created_at?: unknown }>;
          for (const t of slice) {
            const id = t.thread_id ?? t.id ?? "";
            const raw = t.metadata?.last_active_at ?? t.metadata?.updated_at ?? t.created_at;
            if (raw != null && (typeof raw === "string" || typeof raw === "number" || raw instanceof Date)) {
              next[id] = new Date(raw).getTime();
            }
          }
          return next;
        });
      })
      .catch(() => {
        if (!cancelled) toast.error(t("threadList.loadListError"));
      });
    return () => { cancelled = true; };
  }, [searchOpen]);

  useEffect(() => {
    const id = setInterval(() => setRelativeTimeTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const filteredSearchThreads = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return recentThreadsForSearch;
    return recentThreadsForSearch.filter((t) => t.title.toLowerCase().includes(q));
  }, [recentThreadsForSearch, searchQuery]);

  const handleSearchSelectThread = useCallback((threadId: string) => {
    switchThreadThenCancelRef.current?.();
    switchThreadThenCancelRef.current = switchThreadThen(threadId);
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  return (
    <ThreadPinContext.Provider value={{ pinnedIds, togglePin }}>
    <DeleteDialogContext.Provider value={{ requestDelete }}>
    <ThreadHealthMapContext.Provider value={threadHealthMap}>
    <ThreadUpdatedAtSetContext.Provider value={setThreadUpdatedAtMap}>
    <ThreadUpdatedAtContext.Provider value={threadUpdatedAtMap}>
    <RelativeTimeRefreshContext.Provider value={relativeTimeTick}>
    <div ref={listboxRef} className="contents">
    <ThreadListPrimitive.Root
      className="aui-root aui-thread-list-root flex flex-row items-center h-full w-full min-w-0 overflow-x-auto scrollbar-hide gap-0.5"
      role="listbox"
      aria-label={t("threadList.sessionListAria")}
      tabIndex={-1}
      onKeyDown={handleListKeyDown}
    >
      <AssistantIf condition={({ threads }) => !threads.isLoading}>
        <ThreadListPrimitive.Items components={{ ThreadListItem }} />
      </AssistantIf>
      
      <AssistantIf condition={({ threads }) => threads.isLoading}>
        <ThreadListSkeleton />
      </AssistantIf>
      
      {/* 弹性空间：把加号/历史/三点/关闭推到最右侧 */}
      <div className="flex-1 min-w-0" />
      
      {/* 最右侧按钮顺序：加号 | 历史 | 搜索 | 三点 | 关闭 */}
      <ThreadListNew ref={newThreadButtonRef} />
      <ThreadListHistoryButton />
      <div className="relative flex items-center shrink-0">
        {!searchOpen ? (
          <button
            type="button"
            className="flex items-center justify-center w-8 h-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            title={t("threadList.searchThreadsTitle")}
            aria-label={t("threadList.searchThreadsAria")}
            onClick={() => setSearchOpen(true)}
          >
            <Search className="size-3.5" />
          </button>
        ) : (
          <>
            <div className="relative">
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearchOpen(false);
                    setSearchQuery("");
                  }
                }}
                placeholder={t("thread.search.placeholder")}
                className="h-6 w-32 text-[11px] rounded-md border-border/50 bg-background pr-7"
                autoFocus
                aria-label={t("thread.search.placeholder")}
              />
              {searchQuery.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5 rounded"
                  aria-label={t("threadList.clearSearchAria")}
                >
                  <XIcon className="size-3" />
                </button>
              )}
            </div>
            {searchOpen && (
              <div className="absolute left-0 right-0 top-full mt-0.5 z-[var(--z-dropdown)] rounded-md border bg-background shadow-md max-h-56 overflow-y-auto min-w-[160px]">
                {!searchQuery.trim() ? (
                  <div className="px-3 py-4 text-[11px] text-muted-foreground text-center">
                    <div>{t("thread.search.inputHint")}</div>
                    <div className="mt-1 text-[10px] opacity-80">{t("thread.search.titleOnlyHint")}</div>
                  </div>
                ) : filteredSearchThreads.length === 0 ? (
                  <div className="px-3 py-4 text-[11px] text-muted-foreground text-center">{t("thread.search.empty")}</div>
                ) : (
                  filteredSearchThreads.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] hover:bg-muted/60 truncate"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleSearchSelectThread(t.id);
                      }}
                    >
                      <MessageSquare className="size-3.5 opacity-60 shrink-0" />
                      <span className="truncate">{highlightMatch(t.title, searchQuery.trim())}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </>
        )}
      </div>
      <ThreadListMenu />
      {onClose && (
        <button
          type="button"
          className="flex items-center justify-center w-8 h-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-all duration-150 border-l border-border/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          onClick={onClose}
          title={t("threadList.closePanelTitle")}
          aria-label={t("common.close")}
        >
          <XIcon className="size-4" />
        </button>
      )}
    </ThreadListPrimitive.Root>
    </div>
    </RelativeTimeRefreshContext.Provider>
    </ThreadUpdatedAtContext.Provider>
    </ThreadUpdatedAtSetContext.Provider>
    </ThreadHealthMapContext.Provider>
    <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除对话</AlertDialogTitle>
          <AlertDialogDescription>确定要彻底删除该对话吗？此操作不可恢复。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction onClick={handleDeleteConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">删除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </DeleteDialogContext.Provider>
    </ThreadPinContext.Provider>
  );
};

const ThreadListNew = React.forwardRef<HTMLButtonElement>((_, ref) => {
  return (
    <ThreadListPrimitive.New asChild>
      <button
        ref={ref}
        type="button"
        className="flex items-center justify-center w-8 h-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-all duration-150 border-l border-border/20 ml-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        title={t("threadList.newThreadTitle")}
        aria-label={t("threadList.newThreadAria")}
      >
        <PlusIcon className="size-4" />
      </button>
    </ThreadListPrimitive.New>
  );
});

/** 线程列表上限（可配置，避免高线程量下截断导致任务不可见） */
const THREAD_LIST_MAX_LIMIT = 100;
/** 历史对话：下拉首屏条数，支持「加载更多」分页 */
const RECENT_THREADS_PAGE_SIZE = 30;
/** 历史对话：下拉展示最近条数（首屏），点击可切换 */
const RECENT_THREADS_LIMIT = 10;
const HISTORY_COUNT_LIMIT = THREAD_LIST_MAX_LIMIT;

const ThreadListHistoryButton: FC = () => {
  const setThreadUpdatedAtMap = useContext(ThreadUpdatedAtSetContext);
  const [count, setCount] = useState<number | null>(null);
  const [countOverflow, setCountOverflow] = useState(false);
  const [recentThreads, setRecentThreads] = useState<{ id: string; title: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showLoadingSpinner, setShowLoadingSpinner] = useState(false);
  const loadingDelayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (loadingDelayTimerRef.current) {
        clearTimeout(loadingDelayTimerRef.current);
        loadingDelayTimerRef.current = null;
      }
    };
  }, []);

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

  useEffect(() => {
    let mounted = true;
    const workspacePath = getCurrentWorkspacePathFromStorage();
    const cached = getThreadHistoryCache(workspacePath);
    if (
      typeof cached.count === "number" &&
      typeof cached.countUpdatedAt === "number" &&
      Date.now() - cached.countUpdatedAt < THREAD_HISTORY_COUNT_CACHE_TTL_MS
    ) {
      setCount(cached.count);
      setCountOverflow(Boolean(cached.countOverflow));
    }
    listThreads({
      limit: HISTORY_COUNT_LIMIT,
      offset: 0,
      metadata: workspacePath ? { workspace_path: workspacePath } : undefined,
    }).then((list) => {
      if (mounted && Array.isArray(list)) {
        const filtered = workspacePath
          ? list.filter((t: any) => String(t?.metadata?.workspace_path || "").trim() === workspacePath)
          : list;
        setCount(filtered.length);
        setCountOverflow(filtered.length >= HISTORY_COUNT_LIMIT);
        patchThreadHistoryCache(workspacePath, {
          count: filtered.length,
          countOverflow: filtered.length >= HISTORY_COUNT_LIMIT,
          countUpdatedAt: Date.now(),
        });
      }
    }).catch(() => {
      if (mounted) toast.error(t("threadList.loadHistoryError"));
    });
    return () => { mounted = false; };
  }, []);

  const loadMore = useCallback(() => {
    const workspacePath = getCurrentWorkspacePathFromStorage();
    setLoadingMore(true);
    listThreads({
      limit: RECENT_THREADS_PAGE_SIZE,
      offset: recentThreads.length,
      metadata: workspacePath ? { workspace_path: workspacePath } : undefined,
    })
      .then((list) => {
        if (!mountedRef.current || !Array.isArray(list)) return;
        const filtered = workspacePath
          ? list.filter((t: any) => String(t?.metadata?.workspace_path || "").trim() === workspacePath)
          : list;
        const next = filtered.map((t: any) => {
          const id = t.thread_id ?? t.id ?? '';
          const title = t.metadata?.title ?? t.title ?? id?.slice(0, 8) ?? '未命名';
          return { id, title: String(title).slice(0, 40) || '未命名' };
        });
        setRecentThreads((prev) => [...prev, ...next]);
        setHasMore(next.length >= RECENT_THREADS_PAGE_SIZE && recentThreads.length + next.length < THREAD_LIST_MAX_LIMIT);
        setThreadUpdatedAtMap((prev) => {
          const out = { ...prev };
          for (const t of filtered as Array<{ thread_id?: string; id?: string; metadata?: { last_active_at?: unknown; updated_at?: unknown }; created_at?: unknown }>) {
            const id = t.thread_id ?? t.id ?? '';
            const raw = t.metadata?.last_active_at ?? t.metadata?.updated_at ?? t.created_at;
            if (raw != null && (typeof raw === "string" || typeof raw === "number" || raw instanceof Date)) {
              out[id] = new Date(raw).getTime();
            }
          }
          return out;
        });
      })
      .catch(() => { if (mountedRef.current) toast.error(t("threadList.loadMoreError")); })
      .finally(() => { if (mountedRef.current) setLoadingMore(false); });
  }, [recentThreads.length]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      const workspacePath = getCurrentWorkspacePathFromStorage();
      const cached = getThreadHistoryCache(workspacePath);
      const hasFreshRecent =
        Array.isArray(cached.recentThreads) &&
        typeof cached.recentUpdatedAt === "number" &&
        Date.now() - cached.recentUpdatedAt < THREAD_HISTORY_RECENT_CACHE_TTL_MS;
      if (hasFreshRecent && (cached.recentThreads?.length ?? 0) > 0) {
        setRecentThreads((cached.recentThreads || []).slice(0, THREAD_LIST_MAX_LIMIT));
        setHasMore((cached.recentThreads?.length ?? 0) >= RECENT_THREADS_PAGE_SIZE);
      } else {
        setRecentThreads([]);
        setHasMore(false);
      }
      setLoading(!hasFreshRecent);
      listThreads({
        limit: RECENT_THREADS_PAGE_SIZE,
        offset: 0,
        metadata: workspacePath ? { workspace_path: workspacePath } : undefined,
      })
        .then((list) => {
          if (!mountedRef.current || !Array.isArray(list)) return;
          const filtered = workspacePath
            ? list.filter((t: any) => String(t?.metadata?.workspace_path || "").trim() === workspacePath)
            : list;
          const mapped = filtered.map((t: any) => {
            const id = t.thread_id ?? t.id ?? '';
            const title = t.metadata?.title ?? t.title ?? id?.slice(0, 8) ?? '未命名';
            return { id, title: String(title).slice(0, 40) || '未命名' };
          });
          setRecentThreads(mapped);
          setHasMore(mapped.length >= RECENT_THREADS_PAGE_SIZE && mapped.length < THREAD_LIST_MAX_LIMIT);
          setThreadUpdatedAtMap((prev) => {
            const nextMap = { ...prev };
            const listTyped = filtered as Array<{ thread_id?: string; id?: string; metadata?: { last_active_at?: unknown; updated_at?: unknown }; created_at?: unknown }>;
            for (const t of listTyped) {
              const id = t.thread_id ?? t.id ?? '';
              const raw = t.metadata?.last_active_at ?? t.metadata?.updated_at ?? t.created_at;
              if (raw != null && (typeof raw === "string" || typeof raw === "number" || raw instanceof Date)) {
                nextMap[id] = new Date(raw).getTime();
              }
            }
            return nextMap;
          });
          patchThreadHistoryCache(workspacePath, {
            recentThreads: mapped,
            recentUpdatedAt: Date.now(),
          });
        })
        .catch(() => { if (mountedRef.current) toast.error(t("threadList.fetchHistoryError")); })
        .finally(() => { if (mountedRef.current) setLoading(false); });
    }
  };

  const handleSelectThread = (threadId: string) => {
    switchThreadThenCancelRef.current?.();
    switchThreadThenCancelRef.current = switchThreadThen(threadId);
    setOpen(false);
  };

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative flex items-center justify-center w-8 h-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          title={count != null ? `当前工作区历史对话 (约 ${countOverflow ? `${HISTORY_COUNT_LIMIT}+` : count} 个)` : "当前工作区历史对话"}
          aria-label={t("threadList.historyAria")}
        >
          <History className="size-4" />
          {count != null && count > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 px-1 rounded-full bg-primary/90 text-primary-foreground text-[11px] font-medium flex items-center justify-center">
              {countOverflow ? `${HISTORY_COUNT_LIMIT}+` : (count >= HISTORY_COUNT_LIMIT ? `${HISTORY_COUNT_LIMIT}+` : count)}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56 max-h-[280px] overflow-y-auto">
        {showLoadingSpinner ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground text-sm">
            <Loader2 className="size-4 animate-spin mr-2" />
            {t("common.loading")}
          </div>
        ) : recentThreads.length === 0 ? (
          <div className="py-6 px-4 text-center text-muted-foreground text-sm space-y-2">
            <p>{t("threadList.noHistory")}</p>
            <Button size="sm" variant="outline" className="text-xs" onClick={() => window.dispatchEvent(new CustomEvent(EVENTS.NEW_THREAD_REQUEST))} aria-label={t("thread.newSession")}>
              <PlusIcon className="size-3.5 mr-1.5" />
              {t("thread.newSession")}
            </Button>
          </div>
        ) : (
          <>
            {recentThreads.map((t) => (
              <DropdownMenuItem
                key={t.id}
                onClick={() => handleSelectThread(t.id)}
                className="text-[12px] h-8 truncate"
              >
                <MessageSquare className="size-3.5 opacity-60 shrink-0 mr-2" />
                <span className="truncate">{t.title}</span>
              </DropdownMenuItem>
            ))}
            {hasMore && (
              <div className="p-1 border-t border-border">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-[12px] h-8"
                  disabled={loadingMore}
                  onClick={(e) => { e.preventDefault(); loadMore(); }}
                >
                  {loadingMore ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
                  {loadingMore ? t("common.loading") : t("threadList.loadMore")}
                </Button>
              </div>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const ThreadListSkeleton: FC = () => {
  return (
    <>
      {Array.from({ length: 3 }, (_, i) => (
        <div
          key={i}
          role="status"
          aria-label={t("threadList.loadingSessionsAria")}
          className="aui-thread-list-skeleton-wrapper flex h-full items-center px-3 shrink-0"
        >
          <Skeleton className="aui-thread-list-skeleton h-4 w-24" />
        </div>
      ))}
    </>
  );
};

const DeleteButton: FC<{ threadId: string }> = ({ threadId }) => {
  const { requestDelete } = useContext(DeleteDialogContext);
  return (
    <button
      className="mr-1 size-5 p-0 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-destructive/15 text-destructive/80 rounded focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      title={t("threadList.deleteThreadTitle")}
      aria-label={t("threadList.deleteThisThreadAria")}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        requestDelete(threadId);
      }}
    >
      <Trash2 className="size-3" />
    </button>
  );
};

const ThreadListItem: FC = () => {
  const listItemRuntime = useThreadListItemRuntime({ optional: true });
  const { taskRunning, activeThreadId } = useThreadStatus();
  const { requestDelete } = useContext(DeleteDialogContext);
  const threadUpdatedAtMap = useThreadUpdatedAt();
  useContext(RelativeTimeRefreshContext);
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [renaming, setRenaming] = useState(false);
  const submittedRef = useRef(false);
  const { pinnedIds, togglePin } = React.useContext(ThreadPinContext);
  const threadHealthMap = React.useContext(ThreadHealthMapContext);

  const state = listItemRuntime?.getState?.() as { id?: string; threadId?: string; title?: string } | undefined;
  const threadId = state?.id ?? state?.threadId ?? null;
  const relativeTime = threadId && threadUpdatedAtMap[threadId] ? formatRelativeTime(threadUpdatedAtMap[threadId]) : null;
  const isActive = threadId != null && threadId === activeThreadId;
  const showRunning = isActive && taskRunning;
  const isPinned = !!threadId && pinnedIds.includes(threadId);
  const [labelColor, setLabelColor] = useState<string | null>(null);
  useEffect(() => {
    if (!threadId || typeof window === "undefined") {
      setLabelColor(null);
      return;
    }
    try {
      const raw = getStorageItem(THREAD_LABEL_KEY_PREFIX + threadId);
      if (!raw) {
        setLabelColor(null);
        return;
      }
      const parsed = JSON.parse(raw) as { color?: string };
      setLabelColor(parsed?.color && LABEL_COLORS.includes(parsed.color as any) ? parsed.color : null);
    } catch {
      setLabelColor(null);
    }
  }, [threadId]);
  const threadHealth = threadId ? threadHealthMap[threadId] : undefined;
  const hasRecentFailure = Boolean(threadHealth?.lastError) && (Date.now() - Number(threadHealth?.updatedAt || 0) < 24 * 60 * 60 * 1000);
  const recoveryPriorityLabel = (threadHealth?.failureCount || 0) > 2 ? "高优先级" : "中优先级";

  const setThreadLabel = useCallback((color: string) => {
    if (!threadId) return;
    setStorageItem(THREAD_LABEL_KEY_PREFIX + threadId, JSON.stringify({ color }));
    setLabelColor(color);
  }, [threadId]);

  // 双击进入编辑模式，同步当前标题
  const handleDoubleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (renaming) return;
    submittedRef.current = false;
    const currentTitle = state?.title ?? '';
    setEditTitle(currentTitle);
    setIsEditing(true);
  };

  // 保存标题并持久化到后端（仅当标题实际变更时请求）
  const handleSaveTitle = () => {
    if (submittedRef.current) {
      submittedRef.current = false;
      return;
    }
    const trimmed = editTitle.trim();
    if (!listItemRuntime) {
      setIsEditing(false);
      return;
    }
    const currentTitle = (state?.title ?? '').trim();
    if (!trimmed) {
      setEditTitle(currentTitle);
      setIsEditing(false);
      return;
    }
    if (trimmed === currentTitle) {
      setIsEditing(false);
      return;
    }
    if (!threadId) {
      setIsEditing(false);
      return;
    }
    setRenaming(true);
    // 先持久化到后端 metadata.title，再更新本地 runtime 标题
    updateThreadTitle(threadId, trimmed)
      .then(() => listItemRuntime.rename(trimmed))
      .then(() => {
        toast.success(t("threadList.titleUpdated"));
        setIsEditing(false);
      })
      .catch(() => {
        toast.error(t("threadList.titleUpdateFailed"));
      })
      .finally(() => {
        setRenaming(false);
      });
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
    <ThreadListItemPrimitive.Root
      className={cn(
        "aui-thread-list-item group relative flex h-full shrink-0 items-center rounded-none transition-all duration-150 text-muted-foreground hover:text-foreground hover:bg-muted/30 min-w-0 max-w-[180px]",
        isActive && "bg-primary/5 text-foreground border-l-2 border-primary shadow-[inset_0_-1px_0_hsl(var(--background))]",
        !isActive && !labelColor && isPinned && "border-l-2 border-primary/50",
        !isActive && labelColor && LABEL_BORDER_CLASS[labelColor]
      )}
      style={isPinned ? { order: -1 } : undefined}
      role="option"
      tabIndex={isActive ? 0 : -1}
      aria-label={state?.title?.trim() ? `${state.title.trim()}${isActive ? "（当前会话）" : ""}` : isActive ? "当前会话" : "新对话"}
      aria-selected={isActive}
    >
      {isActive && <div className="absolute top-0 left-0 right-0 h-[1.5px] bg-primary/80 z-10" aria-hidden />}
      {isEditing ? (
        <div className="flex items-center gap-1 px-2 min-w-0">
          <Input
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            disabled={renaming}
            className="h-5 w-24 text-[11px] px-1.5 bg-background border border-border/50 rounded focus-visible:ring-1"
            placeholder={t("threadList.threadTitlePlaceholder")}
            aria-label={t("threadList.editThreadTitleAria")}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleSaveTitle();
                submittedRef.current = true;
              }
              if (e.key === 'Escape') {
                setIsEditing(false);
                setRenaming(false);
              }
            }}
            onBlur={handleSaveTitle}
          />
        </div>
      ) : (
        <ThreadListItemPrimitive.Trigger 
          className="aui-thread-list-item-trigger flex h-full items-center gap-1.5 truncate px-2.5 text-start text-[11px] min-w-0 flex-1"
          onDoubleClick={handleDoubleClick}
        >
          {isActive && <span className="shrink-0 text-[10px] font-medium text-primary bg-primary/15 px-1 rounded" aria-hidden>当前</span>}
          {showRunning ? (
            <Loader2 className="size-3 shrink-0 text-primary animate-spin" aria-hidden />
          ) : (
            <MessageSquare className="size-3 shrink-0 opacity-50" />
          )}
          {hasRecentFailure ? (
            <span
              className="inline-block size-1.5 rounded-full bg-destructive shrink-0"
              title={`${recoveryPriorityLabel}恢复${threadHealth?.failureCount ? `（${threadHealth.failureCount}次）` : ""}：${threadHealth?.lastError || ""}`}
            />
          ) : null}
          <span className="truncate min-w-0 flex-1" title={t("threadList.doubleClickEditTitle")}>
            <ThreadListItemPrimitive.Title fallback="新对话" />
          </span>
          {relativeTime && (
            <span className="text-[10px] text-muted-foreground/40 shrink-0 tabular-nums ml-1 opacity-100 group-hover:opacity-0 transition-opacity duration-150">
              {relativeTime}
            </span>
          )}
        </ThreadListItemPrimitive.Trigger>
      )}
      {threadId && hasRecentFailure && (
        <button
          className="mr-0.5 h-5 px-1.5 text-[10px] flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-destructive/15 text-destructive/90 rounded focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          title={t("runTracker.recoveryTitle", { priority: (threadHealth?.failureCount || 0) > 2 ? t("runTracker.recoveryPriorityHigh") : t("runTracker.recoveryPriorityMid") })}
          aria-label={t("runTracker.recoveryAria")}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            switchThreadThenCancelRef.current?.();
            switchThreadThenCancelRef.current = switchThreadThen(threadId, () => {
              setScopedChatMode("ask", threadId);
              window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, {
                detail: {
                  prompt: `请先诊断该会话最近失败根因，再给可执行重试方案：\n${threadHealth?.lastError || "（无错误详情）"}`,
                  threadId,
                },
              }));
            });
          }}
        >
          {(threadHealth?.failureCount || 0) > 2 ? t("runTracker.recoveryButtonPriority") : t("runTracker.recoveryButton")}
        </button>
      )}
      {threadId && (
        <button
          className={cn(
            "mr-0.5 size-5 p-0 flex items-center justify-center transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-muted/60 rounded focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            isPinned ? "opacity-60" : "opacity-0"
          )}
          title={isPinned ? "取消固定" : "固定到顶部"}
          aria-label={isPinned ? "取消固定" : "固定线程"}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            togglePin(threadId);
          }}
        >
          {isPinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
        </button>
      )}
      {threadId && (
        <DeleteButton threadId={threadId} />
      )}
      <ThreadListItemArchive />
    </ThreadListItemPrimitive.Root>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onClick={() => threadId && togglePin(threadId)}>
          {isPinned ? <PinOff className="size-3.5 mr-2" /> : <Pin className="size-3.5 mr-2" />}
          {isPinned ? "取消固定" : "固定"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => { setEditTitle(state?.title ?? ''); setIsEditing(true); }}>
          <Pencil className="size-3.5 mr-2" />
          重命名
        </ContextMenuItem>
        <ContextMenuSeparator />
        {LABEL_COLORS.map((c) => (
          <ContextMenuItem key={c} onClick={() => setThreadLabel(c)} className="flex items-center gap-2">
            <span className={cn("size-3.5 rounded-full shrink-0", c === "gray" && "bg-gray-500", c === "blue" && "bg-blue-500", c === "green" && "bg-green-500", c === "amber" && "bg-amber-500", c === "red" && "bg-red-500", c === "purple" && "bg-purple-500")} />
            {c === "gray" ? "灰" : c === "blue" ? "蓝" : c === "green" ? "绿" : c === "amber" ? "琥珀" : c === "red" ? "红" : "紫"}
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => threadId && requestDelete(threadId)} className="text-destructive">
          <Trash2 className="size-3.5 mr-2" />
          删除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

const ThreadListItemArchive: FC = () => {
  return (
    <ThreadListItemPrimitive.Archive asChild>
      <button
        className="aui-thread-list-item-archive mr-1 size-5 p-0 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-muted/60 rounded focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        title={t("threadList.closeThreadTitle")}
        aria-label={t("threadList.closeThisThreadAria")}
      >
        <XIcon className="size-3" />
      </button>
    </ThreadListItemPrimitive.Archive>
  );
};

/**
 * 线程管理菜单（横放三点）
 */
const ThreadListMenu: FC = () => {
  const [isCleaningUp, setIsCleaningUp] = useState(false);
  const [showPruneConfirm, setShowPruneConfirm] = useState(false);

  const handlePruneConfirmed = async () => {
    setShowPruneConfirm(false);
    setIsCleaningUp(true);
    try {
      const count = await cleanupExpiredThreads(7);
      if (count > 0) {
        toast.success(`已清理 ${count} 个过期对话`);
      } else {
        toast.info(t("threadList.noExpiredToClean"));
      }
    } catch (error) {
      toast.error(t("threadList.cleanFailed"));
    } finally {
      setIsCleaningUp(false);
    }
  };

  const handleViewHistory = async () => {
    try {
      const limit = 50;
      const workspacePath = getCurrentWorkspacePathFromStorage();
      const threads = await listThreads({
        limit,
        metadata: workspacePath ? { workspace_path: workspacePath } : undefined,
      });
      const msg =
        threads.length >= limit
          ? t("thread.history.countTruncated", { n: threads.length, limit })
          : t("thread.history.count", { n: threads.length });
      toast.info(msg);
    } catch (error) {
      toast.error(t("threadList.fetchHistoryError"));
    }
  };

  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center justify-center w-8 h-7 shrink-0 rounded-md hover:bg-muted/40 text-muted-foreground hover:text-foreground transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          title={t("threadList.moreActionsTitle")}
          aria-label={t("threadList.moreActionsAria")}
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onClick={handleViewHistory} className="text-[12px] h-8 gap-2">
          <History className="size-4 opacity-60" />
          历史对话
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => window.dispatchEvent(new CustomEvent('export_chat'))}
          className="text-[12px] h-8 gap-2"
        >
          <Download className="size-4 opacity-60" />
          导出对话
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => window.dispatchEvent(new CustomEvent('export_chat_json'))}
          className="text-[12px] h-8 gap-2"
        >
          <Download className="size-4 opacity-60" />
          导出 JSON
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            const threadId = getCurrentThreadIdFromStorage();
            if (!threadId) {
              toast.error(t("threadList.noActiveThread"));
              return;
            }
            navigator.clipboard.writeText(threadId).then(() => toast.success(t("runTracker.toastCopiedThreadId"))).catch(() => toast.error(t("runTracker.diagnosticsCopyFailed")));
          }}
          className="text-[12px] h-8 gap-2"
        >
          <MessageSquare className="size-4 opacity-60" />
          {t("threadList.copyThreadId")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => window.dispatchEvent(new CustomEvent(EVENTS.OPEN_COMMAND_PALETTE))}
          className="text-[12px] h-8 gap-2"
        >
          <Search className="size-4 opacity-60" />
          打开全局搜索
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => setShowPruneConfirm(true)}
          disabled={isCleaningUp}
          className="text-[12px] h-8 gap-2 text-destructive focus:text-destructive"
        >
          <Trash2 className="size-4 opacity-60" />
          {isCleaningUp ? '清理中...' : '清理过期对话 (7天)'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <AlertDialog open={showPruneConfirm} onOpenChange={setShowPruneConfirm}>
      <AlertDialogContent>
        <AlertDialogTitle>清理过期对话</AlertDialogTitle>
        <AlertDialogDescription>确定清理 7 天前的过期对话吗？此操作不可恢复。</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction onClick={handlePruneConfirmed}>确认清理</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
  );
};
