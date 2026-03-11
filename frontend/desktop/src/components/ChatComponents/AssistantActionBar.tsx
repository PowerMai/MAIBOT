"use client";

import React, { useCallback, useMemo, useRef, useState, memo } from "react";
import type { FC } from "react";
import {
  ActionBarPrimitive,
  AssistantIf,
  useMessage,
  useThread,
} from "@assistant-ui/react";
import { TooltipIconButton } from "./tooltip-icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { cn } from "../ui/utils";
import {
  CheckIcon,
  CopyIcon,
  RefreshCwIcon,
  ChevronsRight,
  ThumbsUpIcon,
  ThumbsDownIcon,
  MoreHorizontal,
  Star,
  Share2,
  WrenchIcon,
  Loader2,
  Bug,
} from "lucide-react";
import { getItem as getStorageItem, setItem as setStorageItem, removeItem as removeStorageItem } from "../../lib/safeStorage";
import { useSessionContext } from "../../lib/contexts/SessionContext";
import {
  bookmarkMessage,
  unbookmarkMessage,
  isMessageBookmarked,
  saveMessageFeedback,
  deleteMessageFeedback,
} from "../../lib/api/langserveChat";
import { EVENTS } from "../../lib/constants";
import { toast } from "sonner";
import { t } from "../../lib/i18n";

export function extractMessageText(state: { content?: unknown }): string {
  const content = state.content;
  if (!content || !Array.isArray(content)) return "";
  let result = "";
  for (let i = 0; i < content.length; i++) {
    const part = content[i];
    if (part?.type === "text" && typeof (part as { text?: string }).text === "string") {
      if (result) result += "\n";
      result += (part as { text: string }).text;
    }
  }
  return result;
}

const FEEDBACK_STORAGE_PREFIX = "maibot_msg_feedback_";
const FEEDBACK_PERSIST_DELAY_MS = 120;
const FEEDBACK_CACHE_MAX = 500;
const BOOKMARK_STATUS_CACHE_TTL_MS = 15000;
const BOOKMARK_STATUS_DELAY_MS = 120;
const BOOKMARK_STATUS_CACHE_MAX = 500;
const bookmarkStatusCache = new Map<string, { value: boolean; ts: number }>();
const bookmarkStatusInFlight = new Map<string, Promise<boolean>>();
const feedbackCache = new Map<string, "up" | "down" | null>();

function makeBookmarkCacheKey(userId: string, threadId: string, messageId: string): string {
  return `${userId}::${threadId}::${messageId}`;
}

function setBookmarkStatusCache(key: string, value: boolean): void {
  bookmarkStatusCache.set(key, { value, ts: Date.now() });
  if (bookmarkStatusCache.size <= BOOKMARK_STATUS_CACHE_MAX) return;
  const overflow = bookmarkStatusCache.size - BOOKMARK_STATUS_CACHE_MAX;
  let removed = 0;
  for (const oldestKey of bookmarkStatusCache.keys()) {
    bookmarkStatusCache.delete(oldestKey);
    removed += 1;
    if (removed >= overflow) break;
  }
}

function setFeedbackCache(key: string, value: "up" | "down" | null): void {
  feedbackCache.set(key, value);
  if (feedbackCache.size <= FEEDBACK_CACHE_MAX) return;
  const overflow = feedbackCache.size - FEEDBACK_CACHE_MAX;
  let removed = 0;
  for (const oldestKey of feedbackCache.keys()) {
    feedbackCache.delete(oldestKey);
    removed += 1;
    if (removed >= overflow) break;
  }
}

async function readBookmarkStatusCached(userId: string, threadId: string, messageId: string): Promise<boolean> {
  const key = makeBookmarkCacheKey(userId, threadId, messageId);
  const now = Date.now();
  const cached = bookmarkStatusCache.get(key);
  if (cached && now - cached.ts <= BOOKMARK_STATUS_CACHE_TTL_MS) {
    return cached.value;
  }
  const pending = bookmarkStatusInFlight.get(key);
  if (pending) return pending;

  const req = isMessageBookmarked(userId, threadId, messageId)
    .then((ok) => {
      const value = !!ok;
      setBookmarkStatusCache(key, value);
      return value;
    })
    .finally(() => {
      bookmarkStatusInFlight.delete(key);
    });

  bookmarkStatusInFlight.set(key, req);
  return req;
}

export const AssistantActionBar: FC = memo(function AssistantActionBar() {
  const { setMode } = useSessionContext();
  const messageId = useMessage((s) => s.id);
  const threadId = useThread((s) => (s as { threadId?: string; id?: string })?.threadId ?? (s as { id?: string })?.id ?? null);
  const messageText = useMessage(extractMessageText);
  const messageErrorText = useMessage((s) => {
    const st = (s as unknown as { status?: { type?: string; reason?: string; error?: unknown } }).status;
    if (st?.type !== "incomplete" || st?.reason !== "error") return "";
    const err = st.error as { message?: string } | string | undefined;
    if (typeof err === "string") return err;
    if (err && typeof err === "object" && typeof err.message === "string") return err.message;
    return "";
  });
  const isIncompleteNotError = useMessage((s) => {
    const st = (s as unknown as { status?: { type?: string; reason?: string } }).status;
    return st?.type === "incomplete" && st?.reason !== "error";
  });
  const userId = useMemo(() => getStorageItem("maibot_user_id", "local-user") || "local-user", []);
  const feedbackPersistTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const bookmarkInFlightRef = useRef(false);
  const feedbackInFlightRef = useRef(false);
  const continueFiringTimerRef = useRef<number | null>(null);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (continueFiringTimerRef.current !== null) {
        window.clearTimeout(continueFiringTimerRef.current);
        continueFiringTimerRef.current = null;
      }
    };
  }, []);
  const [bookmarkLoading, setBookmarkLoading] = useState(false);
  const [continueFiring, setContinueFiring] = useState(false);
  const [feedback, setFeedback] = useState<"up" | "down" | null>(() => {
    const key = messageId ? FEEDBACK_STORAGE_PREFIX + messageId : "";
    const cached = key ? feedbackCache.get(key) : undefined;
    if (cached === "up" || cached === "down" || cached === null) return cached ?? null;
    const v = messageId ? getStorageItem(key) : "";
    if (key) setFeedbackCache(key, v === "up" || v === "down" ? v : null);
    return v === "up" || v === "down" ? v : null;
  });
  const [bookmarked, setBookmarked] = useState(false);

  React.useEffect(() => {
    if (!messageId) return;
    const key = FEEDBACK_STORAGE_PREFIX + messageId;
    const cached = feedbackCache.get(key);
    if (cached === "up" || cached === "down" || cached === null) {
      setFeedback(cached ?? null);
      return;
    }
    const v = getStorageItem(key);
    setFeedbackCache(key, v === "up" || v === "down" ? v : null);
    setFeedback(v === "up" || v === "down" ? v : null);
  }, [messageId]);

  React.useEffect(() => {
    if (!messageId || !threadId) {
      setBookmarked(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void readBookmarkStatusCached(userId, String(threadId), String(messageId))
        .then((ok) => {
          if (!cancelled) setBookmarked(!!ok);
        })
        .catch(() => {
          if (!cancelled) setBookmarked(false);
        });
    }, BOOKMARK_STATUS_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [messageId, threadId, userId]);

  React.useEffect(() => {
    if (!messageId) return;
    const key = FEEDBACK_STORAGE_PREFIX + messageId;
    setFeedbackCache(key, feedback ?? null);
    if (feedbackPersistTimerRef.current !== null) {
      window.clearTimeout(feedbackPersistTimerRef.current);
    }
    feedbackPersistTimerRef.current = window.setTimeout(() => {
      const latest = feedbackCache.get(key);
      if (latest) setStorageItem(key, latest);
      else removeStorageItem(key);
    }, FEEDBACK_PERSIST_DELAY_MS);
    return () => {
      if (feedbackPersistTimerRef.current !== null) {
        window.clearTimeout(feedbackPersistTimerRef.current);
      }
    };
  }, [feedback, messageId]);

  const handleFeedback = useCallback(
    async (value: "up" | "down") => {
      if (feedbackInFlightRef.current) return;
      feedbackInFlightRef.current = true;
      const next = feedback === value ? null : value;
      const prev = feedback;
      setFeedback(next);
      if (messageId) {
        setFeedbackCache(FEEDBACK_STORAGE_PREFIX + messageId, next ?? null);
        window.dispatchEvent(new CustomEvent("message_feedback", { detail: { messageId, value: next } }));
      }
      try {
        if (messageId && threadId) {
          if (next) {
            await saveMessageFeedback(userId, {
              messageId: String(messageId),
              threadId: String(threadId),
              type: next,
              timestamp: new Date().toISOString(),
            });
          } else {
            await deleteMessageFeedback(userId, String(threadId), String(messageId));
          }
        }
      } catch {
        setFeedback(prev);
        if (messageId) setFeedbackCache(FEEDBACK_STORAGE_PREFIX + messageId, prev ?? null);
        toast.error(next ? "反馈提交失败，请重试" : "取消反馈失败，请重试");
      } finally {
        feedbackInFlightRef.current = false;
      }
    },
    [feedback, messageId, threadId, userId]
  );

  const handleBookmark = useCallback(async () => {
    if (!messageId || !threadId || bookmarkInFlightRef.current) return;
    bookmarkInFlightRef.current = true;
    setBookmarkLoading(true);
    try {
      if (bookmarked) {
        const ok = await unbookmarkMessage(userId, String(threadId), String(messageId));
        if (!mountedRef.current) return;
        if (ok) {
          setBookmarkStatusCache(makeBookmarkCacheKey(userId, String(threadId), String(messageId)), false);
          setBookmarked(false);
          toast.success("已取消收藏");
        } else {
          toast.error("取消收藏失败");
        }
        return;
      }
      const ok = await bookmarkMessage(userId, {
        messageId: String(messageId),
        threadId: String(threadId),
        content: messageText.slice(0, 4000),
        timestamp: new Date().toISOString(),
      });
      if (!mountedRef.current) return;
      if (ok) {
        setBookmarkStatusCache(makeBookmarkCacheKey(userId, String(threadId), String(messageId)), true);
        setBookmarked(true);
        toast.success("已收藏消息");
      } else {
        toast.error("收藏失败");
      }
    } finally {
      bookmarkInFlightRef.current = false;
      if (mountedRef.current) setBookmarkLoading(false);
    }
  }, [bookmarked, messageId, threadId, userId, messageText]);

  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      autohideFloat="single-branch"
      className="aui-assistant-action-bar-root flex gap-0.5 text-muted-foreground"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="复制" className="size-7 hover:text-foreground hover:bg-muted/40 transition-all duration-150">
          <AssistantIf condition={({ message }) => message.isCopied}>
            <CheckIcon className="size-3.5 text-emerald-500" />
          </AssistantIf>
          <AssistantIf condition={({ message }) => !message.isCopied}>
            <CopyIcon className="size-3.5" />
          </AssistantIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>

      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip={t("error.retryRegenerate")} className="size-7 hover:text-foreground hover:bg-muted/40 transition-all duration-150">
          <RefreshCwIcon className="size-3.5" />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>

      {isIncompleteNotError && (
        <TooltipIconButton
          tooltip={t("action.continueGenerate")}
          className="size-7 hover:text-foreground hover:bg-muted/40 transition-all duration-150"
          disabled={continueFiring}
          onClick={() => {
              if (continueFiring) return;
              if (continueFiringTimerRef.current !== null) {
                window.clearTimeout(continueFiringTimerRef.current);
                continueFiringTimerRef.current = null;
              }
              setContinueFiring(true);
              window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, {
                detail: { prompt: t("action.continuePrompt"), threadId: threadId || undefined },
              }));
              continueFiringTimerRef.current = window.setTimeout(() => {
                if (mountedRef.current) setContinueFiring(false);
                continueFiringTimerRef.current = null;
              }, 1000);
            }}
          >
            <ChevronsRight className="size-3.5" />
        </TooltipIconButton>
      )}

      <TooltipIconButton
        tooltip={feedback === "up" ? "已标记有帮助" : "标记有帮助"}
        className={cn("size-7 hover:text-foreground hover:bg-muted/40 transition-all duration-150", feedback === "up" && "text-emerald-500")}
        onClick={() => handleFeedback("up")}
      >
        <ThumbsUpIcon className="size-3.5" />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip={feedback === "down" ? "已标记无帮助" : "没有帮助"}
        className={cn("size-7 hover:text-foreground hover:bg-muted/40 transition-all duration-150", feedback === "down" && "text-destructive")}
        onClick={() => handleFeedback("down")}
      >
        <ThumbsDownIcon className="size-3.5" />
      </TooltipIconButton>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="size-7 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-all duration-150"
            title="更多操作"
            aria-label="更多操作"
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={handleBookmark} disabled={bookmarkLoading}>
            {bookmarkLoading ? (
              <Loader2 className="mr-2 size-3.5 animate-spin" />
            ) : (
              <Star className={cn("mr-2 size-3.5", bookmarked && "text-amber-500")} />
            )}
            {bookmarked ? "取消收藏" : "收藏消息"}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              const text = `Thread: ${threadId || "-"}\nMessage: ${messageId || "-"}\n\n${messageText || ""}`;
              navigator.clipboard.writeText(text).then(() => toast.success(t("action.copyShareableSuccess"))).catch(() => toast.error(t("common.copyFailedManual")));
            }}
          >
            <Share2 className="mr-2 size-3.5" />
            复制分享内容
          </DropdownMenuItem>
          {messageId ? (
            <DropdownMenuItem
              onClick={() => {
                window.dispatchEvent(new CustomEvent(EVENTS.ARTIFACT_FOCUS_REQUEST, { detail: { messageId: String(messageId) } }));
              }}
            >
              <WrenchIcon className="mr-2 size-3.5" />
              在 Artifact 面板查看
            </DropdownMenuItem>
          ) : null}
          {messageErrorText ? (
            <DropdownMenuItem
              onClick={() => {
                setMode("ask");
                window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, {
                  detail: {
                    prompt: `请先诊断这条失败回复，再给我可执行修复方案：\n${messageErrorText}`,
                    threadId: threadId || undefined,
                  },
                }));
              }}
            >
              <Bug className="mr-2 size-3.5" />
              {t("runTracker.askDiagnose")}
            </DropdownMenuItem>
          ) : null}
          {messageErrorText ? (
            <DropdownMenuItem
              onClick={() => {
                window.dispatchEvent(new CustomEvent(EVENTS.FOLLOWUP_MESSAGE, {
                  detail: {
                    message: `请仅重试失败步骤，并说明修复策略：\n${messageErrorText}`,
                    threadId: threadId || undefined,
                  },
                }));
              }}
            >
              <RefreshCwIcon className="mr-2 size-3.5" />
              仅重试失败步骤
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </ActionBarPrimitive.Root>
  );
});
