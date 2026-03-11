import React, { useState, useEffect, useRef, useMemo } from "react";
import { ScrollArea } from "./ui/scroll-area";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "./ui/sheet";
import {
  Bell,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Info,
  Zap,
  Clock,
  Trash2,
  CheckCheck,
} from "lucide-react";
import { toast } from "sonner";
import { EVENTS } from "../lib/constants";
import { t } from "../lib/i18n";
import { formatTimeForSummary, getTimeGroupLabel } from "../lib/utils/formatters";
import { subscribeAutonomousScheduleEvent } from "../lib/events/autonomousScheduleEvent";
import { getCurrentThreadIdFromStorage, getCurrentWorkspacePathFromStorage } from "../lib/sessionState";

type NotificationType = "success" | "error" | "warning" | "info" | "task" | "trigger" | "evolution";

interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  description: string;
  createdAt: number;
  timestamp?: string;
  read: boolean;
  /** 关联的对话 threadId，用于「查看全文」跳转 */
  threadId?: string;
  /** 关联任务，用于任务链路跳转 */
  taskId?: string;
  taskStatus?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

const NOTIFICATIONS_KEY_PREFIX = "notifications";

function getNotificationsStorageKey(): string {
  try {
    const workspacePath = getCurrentWorkspacePathFromStorage();
    return workspacePath ? `${NOTIFICATIONS_KEY_PREFIX}:${workspacePath}` : NOTIFICATIONS_KEY_PREFIX;
  } catch {
    return NOTIFICATIONS_KEY_PREFIX;
  }
}

function normalizeNotification(raw: unknown): Notification | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Partial<Notification>;
  if (!input.id || !input.type || !input.title || !input.description) return null;
  const createdAt =
    typeof input.createdAt === "number" && Number.isFinite(input.createdAt)
      ? input.createdAt
      : Date.now();
  return {
    id: String(input.id),
    type: input.type,
    title: String(input.title),
    description: String(input.description),
    createdAt,
    timestamp: typeof input.timestamp === "string" ? input.timestamp : undefined,
    read: Boolean(input.read),
    threadId: input.threadId,
    taskId: typeof input.taskId === "string" ? input.taskId : undefined,
    taskStatus: typeof input.taskStatus === "string" ? input.taskStatus : undefined,
    action: input.action,
  };
}

interface NotificationCenterProps {
  onClose: () => void;
  onClearAll: () => void;
}

/** 通知行时间展示：对齐 UI_CURSOR_STYLE_SPEC，2 分钟内显示「刚刚」，2–15 分钟显示「15分钟内」+ HH:mm，更早显示 HH:mm */
function formatNotificationTime(createdAt: number): string {
  const group = getTimeGroupLabel(createdAt);
  const timeStr = formatTimeForSummary(createdAt);
  if (group === "刚刚") return t("common.justNow");
  if (group === "15分钟内") return `${t("runTracker.timeAgoWithin15")} ${timeStr}`;
  return timeStr;
}

// 加载通知
function loadNotifications(): Notification[] {
  try {
    const saved = localStorage.getItem(getNotificationsStorageKey());
    if (saved) {
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeNotification).filter((item): item is Notification => item !== null);
    }
  } catch (err) {
    if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
      console.warn("[NotificationCenter] loadNotifications failed", err);
    }
  }
  return [];
}

// 保存通知
function saveNotifications(notifications: Notification[]): void {
  try {
    localStorage.setItem(getNotificationsStorageKey(), JSON.stringify(notifications));
  } catch (err) {
    if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
      console.warn("[NotificationCenter] saveNotifications failed", err);
    }
  }
}

// 添加通知（全局函数，供其他组件调用）
export function addNotification(notification: Omit<Notification, 'id' | 'timestamp' | 'createdAt' | 'read'>): void {
  const newNotification: Notification = {
    ...notification,
    id: `notif-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    createdAt: Date.now(),
    read: false,
  };
  
  const existing = loadNotifications();
  const updated = [newNotification, ...existing].slice(0, 50); // 最多保留 50 条
  saveNotifications(updated);
  
  // 触发事件通知 NotificationCenter 更新
  window.dispatchEvent(new CustomEvent('notification-added', { detail: newNotification }));
}

export const NotificationCenter = React.memo(function NotificationCenter({
  onClose,
  onClearAll,
}: NotificationCenterProps) {
  const toastedIdsRef = useRef<Set<string>>(new Set());
  const notificationsRef = useRef<Notification[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>(() => {
    const saved = loadNotifications();
    if (saved.length > 0) return saved;
    const hasSeenWelcomeGuide =
      typeof window !== "undefined" &&
      (localStorage.getItem("hasSeenWelcomeGuide") === "true" ||
        localStorage.getItem("hasSeenWelcomeGuide") === "1");
    if (hasSeenWelcomeGuide) return [];
    return [
      {
        id: "welcome-1",
        type: "info",
        title: "欢迎使用 CCB 智能助手",
        description: "在右侧对话框输入任务描述，或从 Dashboard 选择角色开始",
        createdAt: Date.now(),
        read: false,
      },
    ];
  });
  notificationsRef.current = notifications;

  // 监听新通知事件
  useEffect(() => {
    const handleNewNotification = (e: CustomEvent) => {
      const notification = e.detail as Notification;
      const prev = notificationsRef.current;
      const updated = [notification, ...prev].slice(0, 50);
      setNotifications(updated);
      saveNotifications(updated);
      if (notification.type !== "info" && !toastedIdsRef.current.has(notification.id)) {
        if (notification.title === "AI 回复已生成") return;
        toastedIdsRef.current.add(notification.id);
        if (toastedIdsRef.current.size > 200) toastedIdsRef.current.clear();
        const toastFn =
          notification.type === "error" ? toast.error
          : notification.type === "warning" ? toast.warning
          : toast.success;
        toastFn(notification.title, {
          description: notification.description?.slice(0, 80),
          duration: 4000,
        });
      }
    };
    const handleStorage = (e: StorageEvent) => {
      if (e.key !== getNotificationsStorageKey()) return;
      setNotifications(loadNotifications());
    };

    window.addEventListener('notification-added', handleNewNotification as EventListener);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener('notification-added', handleNewNotification as EventListener);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  // 监听后端事件并转化为通知
  useEffect(() => {
    const handleVoiceReply = (e: CustomEvent) => {
      const { accumulatedText, threadId } = e.detail ?? {};
      if (accumulatedText && accumulatedText.length > 20) {
        const tid = threadId ?? (typeof window !== "undefined" ? getCurrentThreadIdFromStorage() || null : null);
        addNotification({
          type: "success",
          title: "AI 回复已生成",
          description: accumulatedText.slice(0, 50) + (accumulatedText.length > 50 ? "..." : ""),
          threadId: tid || undefined,
        });
      }
    };

    window.addEventListener('voice-message-reply', handleVoiceReply as EventListener);
    return () => window.removeEventListener('voice-message-reply', handleVoiceReply as EventListener);
  }, []);

  useEffect(() => {
    const unsub = subscribeAutonomousScheduleEvent(({ run }) => {
      if (!run) return;
      addNotification({
        type: "task",
        title: "自治任务已触发",
        description: `${run.subject || "未命名任务"} · ${run.slot || "unscheduled"}`,
        threadId: run.thread_id,
        taskId: (run as any).matched_task_id || (run as any).task_id || undefined,
        taskStatus: "triggered",
      });
    });
    return unsub;
  }, []);

  useEffect(() => {
    const onTrigger = (event: Event) => {
      const e = event as CustomEvent<{ title?: string; description?: string; threadId?: string; taskId?: string; status?: string }>;
      addNotification({
        type: "trigger",
        title: e.detail?.title || "触发器事件",
        description: e.detail?.description || "已收到新的触发事件。",
        threadId: e.detail?.threadId,
        taskId: e.detail?.taskId,
        taskStatus: e.detail?.status,
      });
    };
    const onEvolution = (event: Event) => {
      const e = event as CustomEvent<{ title?: string; description?: string; threadId?: string; taskId?: string; status?: string }>;
      addNotification({
        type: "evolution",
        title: e.detail?.title || "自我进化事件",
        description: e.detail?.description || "系统已执行一次自我进化步骤。",
        threadId: e.detail?.threadId,
        taskId: e.detail?.taskId,
        taskStatus: e.detail?.status,
      });
    };
    window.addEventListener("autonomy-trigger" as any, onTrigger as any);
    window.addEventListener("autonomy-evolution" as any, onEvolution as any);
    return () => {
      window.removeEventListener("autonomy-trigger" as any, onTrigger as any);
      window.removeEventListener("autonomy-evolution" as any, onEvolution as any);
    };
  }, []);

  const getNotificationIcon = (type: NotificationType) => {
    switch (type) {
      case "success":
        return <CheckCircle2 className="h-4 w-4 text-green-500" />;
      case "error":
        return <XCircle className="h-4 w-4 text-red-500" />;
      case "warning":
        return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
      case "task":
        return <Zap className="h-4 w-4 text-emerald-500" />;
      case "trigger":
        return <Clock className="h-4 w-4 text-blue-500" />;
      case "evolution":
        return <Zap className="h-4 w-4 text-violet-500" />;
      case "info":
        return <Info className="h-4 w-4 text-gray-500" />;
    }
  };

  const getNotificationBg = (type: NotificationType, read: boolean) => {
    if (read) return "bg-muted/30";
    switch (type) {
      case "success":
        return "bg-green-500/5 border-green-500/20";
      case "error":
        return "bg-red-500/5 border-red-500/20";
      case "warning":
        return "bg-yellow-500/5 border-yellow-500/20";
      case "task":
        return "bg-emerald-500/5 border-emerald-500/20";
      case "trigger":
        return "bg-blue-500/5 border-blue-500/20";
      case "evolution":
        return "bg-violet-500/5 border-violet-500/20";
      case "info":
        return "bg-gray-500/5 border-gray-500/20";
    }
  };

  const handleMarkAsRead = (id: string) => {
    setNotifications(prev => {
      const updated = prev.map((n) => (n.id === id ? { ...n, read: true } : n));
      saveNotifications(updated);
      return updated;
    });
  };

  const handleMarkAllAsRead = () => {
    setNotifications(prev => {
      const updated = prev.map((n) => ({ ...n, read: true }));
      saveNotifications(updated);
      return updated;
    });
  };

  const handleDelete = (id: string) => {
    setNotifications(prev => {
      const updated = prev.filter((n) => n.id !== id);
      saveNotifications(updated);
      return updated;
    });
  };

  const handleClearAll = () => {
    setNotifications(prev => {
      const updated = prev.filter((n) => !n.read);
      saveNotifications(updated);
      return updated;
    });
    toast.success(t("notification.clearedRead"));
    onClearAll?.();
  };

  const [typeFilter, setTypeFilter] = useState<'all' | 'task' | 'system' | 'message'>('all');

  const { unreadCount, unreadNotifications, readNotifications, filteredAll, filteredUnread } = useMemo(() => {
    const unread = notifications.filter((n) => !n.read);
    const read = notifications.filter((n) => n.read);
    const matchType = (n: Notification) => {
      if (typeFilter === 'all') return true;
      if (typeFilter === 'task') return n.type === 'task';
      if (typeFilter === 'system') return ['success', 'error', 'warning', 'info', 'evolution', 'trigger'].includes(n.type);
      if (typeFilter === 'message') return Boolean(n.threadId);
      return true;
    };
    return {
      unreadCount: unread.length,
      unreadNotifications: unread,
      readNotifications: read,
      filteredAll: typeFilter === 'all' ? notifications : notifications.filter(matchType),
      filteredUnread: typeFilter === 'all' ? unread : unread.filter(matchType),
    };
  }, [notifications, typeFilter]);

  const handleCardNavigate = (notification: Notification) => {
    if (notification.taskId) {
      window.dispatchEvent(new CustomEvent(EVENTS.OPEN_TASK_IN_EDITOR, { detail: { taskId: notification.taskId, subject: notification.title || "任务" } }));
      onClose();
    } else if (notification.threadId) {
      window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_TO_THREAD, { detail: { threadId: notification.threadId } }));
      onClose();
    }
  };

  const renderNotificationCard = (notification: Notification, showUnreadDot: boolean) => {
    const isNavigable = !!(notification.taskId || notification.threadId);
    return (
    <div
      key={notification.id}
      role={isNavigable ? "button" : undefined}
      tabIndex={isNavigable ? 0 : undefined}
      aria-label={isNavigable ? (notification.taskId ? t("notification.openTaskAria", { title: notification.title }) : t("notification.openThreadAria", { title: notification.title })) : undefined}
      onClick={() => isNavigable && handleCardNavigate(notification)}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && isNavigable) {
          e.preventDefault();
          handleCardNavigate(notification);
        }
      }}
      className={`border rounded-lg p-2.5 transition-all hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${getNotificationBg(
        notification.type,
        notification.read
      )} ${showUnreadDot ? "border-l-2" : ""} ${notification.taskId || notification.threadId ? "cursor-pointer" : ""}`}
    >
      <div className="flex items-start gap-2">
        <div className="shrink-0 mt-0.5">
          {getNotificationIcon(notification.type)}
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-start justify-between gap-2">
            <h4 className={`text-sm leading-tight ${showUnreadDot ? "font-medium" : ""}`}>
              {notification.title}
            </h4>
            {showUnreadDot && (
              <div className="h-1.5 w-1.5 rounded-full bg-primary shrink-0 mt-1" />
            )}
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {notification.description}
            {notification.taskStatus ? (
              <span className="ml-1 inline-flex items-center rounded border border-border/50 px-1 py-0 text-[10px] text-muted-foreground/85">
                {notification.taskStatus}
              </span>
            ) : null}
            {notification.taskId && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  window.dispatchEvent(new CustomEvent(EVENTS.OPEN_TASK_IN_EDITOR, { detail: { taskId: notification.taskId, subject: notification.title || "任务" } }));
                  onClose();
                }}
                className="text-xs text-primary hover:underline mt-1 block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
                aria-label={t("notification.openTaskAria", { title: notification.title })}
              >
                {t("notification.openTask")}
              </button>
            )}
            {notification.threadId && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_TO_THREAD, { detail: { threadId: notification.threadId } }));
                  onClose();
                }}
                className="text-xs text-primary hover:underline mt-1 block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
                aria-label={t("notification.openThreadAria", { title: notification.title })}
              >
                {t("notification.openThread")}
              </button>
            )}
          </p>
          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Clock className="h-2.5 w-2.5" />
              <span>{formatNotificationTime(notification.createdAt)}</span>
            </div>
            <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
              {notification.action && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={notification.action.onClick}
                  className="h-6 px-2 text-xs"
                >
                  {notification.action.label}
                </Button>
              )}
              {!notification.read && (
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => handleMarkAsRead(notification.id)}
                  title={t("notification.markRead")}
                  className="h-6 w-6"
                >
                  <CheckCircle2 className="h-3 w-3" />
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                onClick={() => handleDelete(notification.id)}
                title={t("notification.delete")}
                className="h-6 w-6"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
  };

  return (
    <Sheet open={true} onOpenChange={onClose}>
      <SheetContent side="right" className="w-[360px] p-0 flex flex-col">
        <SheetHeader className="px-4 py-3 border-b shrink-0">
          <SheetTitle className="flex items-center justify-between text-base">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4" />
              <span>{t("notification.title")}</span>
              {unreadCount > 0 && (
                <Badge className="bg-red-500 h-4 px-1.5 text-[10px]">{unreadCount}</Badge>
              )}
            </div>
            <div className="flex gap-0.5">
              <Button
                size="icon"
                variant="ghost"
                onClick={handleMarkAllAsRead}
                disabled={unreadCount === 0}
                title={t("notification.markAllRead")}
                className="h-7 w-7"
              >
                <CheckCheck className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={handleClearAll}
                disabled={readNotifications.length === 0}
                title={t("notification.clearRead")}
                className="h-7 w-7"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </SheetTitle>
        </SheetHeader>

        <Tabs defaultValue="all" className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="mx-4 mt-2 grid grid-cols-2 h-8 shrink-0">
            <TabsTrigger value="all" className="text-xs">
              {t("notification.tabAll")} ({notifications.length})
            </TabsTrigger>
            <TabsTrigger value="unread" className="text-xs">
              {t("notification.tabUnread")} ({unreadCount})
            </TabsTrigger>
          </TabsList>
          <div className="mx-4 mt-2 flex flex-wrap gap-1 shrink-0">
            {(['all', 'task', 'system', 'message'] as const).map((filterKey) => (
              <Button
                key={filterKey}
                size="sm"
                variant={typeFilter === filterKey ? 'secondary' : 'outline'}
                className="h-6 px-2 text-[11px]"
                onClick={() => setTypeFilter(filterKey)}
              >
                {filterKey === 'all' ? t("notification.filterAllTypes") : filterKey === 'task' ? t("notification.filterTask") : filterKey === 'system' ? t("notification.filterSystem") : t("notification.filterMessage")}
              </Button>
            ))}
          </div>

          <ScrollArea className="flex-1">
            <TabsContent value="all" className="px-4 py-2 space-y-2 mt-2">
              {filteredAll.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <Bell className="h-12 w-12 mx-auto mb-3 opacity-20" />
                  <p className="text-sm">{notifications.length === 0 ? t("notification.noNotifications") : t("notification.noNotificationsOfType")}</p>
                </div>
              ) : (
                filteredAll.map((n) => renderNotificationCard(n, !n.read))
              )}
            </TabsContent>

            <TabsContent value="unread" className="px-4 py-2 space-y-2 mt-2">
              {filteredUnread.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <CheckCircle2 className="h-12 w-12 mx-auto mb-3 opacity-20" />
                  <p className="text-sm">{unreadNotifications.length === 0 ? t("notification.noUnread") : t("notification.noUnreadOfType")}</p>
                </div>
              ) : (
                filteredUnread.map((n) => renderNotificationCard(n, true))
              )}
            </TabsContent>
          </ScrollArea>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
});