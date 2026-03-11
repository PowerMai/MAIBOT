/**
 * App.tsx - AI 工作舞台
 * 
 * 设计理念：
 * - 整个页面是一个通用的 AI 工作舞台
 * - 不是特定业务的工具，而是通用的 AI 交互平台
 * - 任何任务、任何场景都可用
 * - 通过 Skills 扩展专业能力
 * 
 * 架构：
 * - 单页面架构，不再有视图切换
 * - 左侧：工作区导航（文件树、项目、快捷入口）
 * - 中央：内容舞台（文件、面板、AI 结果）
 * - 右侧：对话交互（指令、过程、生成式 UI）
 */

import React, { useState, useEffect, useRef, Suspense, lazy, useCallback } from "react";
import { AppProvider } from "./components/AppContext";
import { SessionContextProvider } from "./lib/contexts/SessionContext";
import { fileSyncManager } from "./lib/fileSyncManager";
import { Toaster } from "./components/ui/sonner";
import { boardApi } from "./lib/api/boardApi";
import { EVENTS, SESSION_SWITCH_TIMEOUT_MS, type SessionChangedDetail } from "./lib/constants";
import { fileEventBus } from "./lib/events/fileEvents";
import { menuService } from "./lib/services/electronService";
import { migrateLegacyChatMode, setScopedChatMode } from "./lib/chatModeState";
import { getCurrentThreadIdFromStorage, readRunSummary, writeRunSummary, normalizeRunSummaryDetail } from "./lib/runSummaryState";
import { initCrossWindowSessionBridge, getCurrentWorkspacePathFromStorage } from "./lib/sessionState";
import { getItem as getStorageItem } from "./lib/safeStorage";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { TooltipProvider } from "./components/ui/tooltip";
import FullEditorV2Enhanced from "./components/FullEditorV2Enhanced";
const CommandPalette = lazy(() =>
  import("./components/CommandPalette").then((m) => ({ default: m.CommandPalette }))
);
const WelcomeGuide = lazy(() =>
  import("./components/WelcomeGuide").then((m) => ({ default: m.WelcomeGuide }))
);
const NotificationCenter = lazy(() =>
  import("./components/NotificationCenter").then((m) => ({ default: m.NotificationCenter }))
);
import { useKeyboardShortcuts } from "./lib/hooks/useKeyboardShortcuts";
import { applySavedThemeAccent } from "./lib/themeAccent";
import { toast } from "sonner";
import { AnimatePresence } from "motion/react";
import { t } from "./lib/i18n";

const WELCOME_GUIDE_SEEN_KEY = "hasSeenWelcomeGuide";
const ONBOARDING_SAMPLE_CREATED_KEY = "maibot_onboarding_sample_created";
const ONBOARDING_SAMPLE_STATUS_KEY = "maibot_onboarding_sample_status";

export default function App() {
  useEffect(() => {
    migrateLegacyChatMode();
    initCrossWindowSessionBridge();
  }, []);

  const readLastRunSummary = (): { lastError: string; linkedTaskId: string; linkedThreadId: string; linkedSubject: string } | null => {
    try {
      const raw = readRunSummary(getCurrentThreadIdFromStorage());
      const norm = normalizeRunSummaryDetail(raw);
      if (!norm) return null;
      return {
        lastError: norm.lastError,
        linkedTaskId: norm.linkedTaskId ?? "",
        linkedThreadId: norm.linkedThreadId ?? "",
        linkedSubject: norm.linkedSubject ?? "",
      };
    } catch {
      return null;
    }
  };

  // 全局状态
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showNotificationCenter, setShowNotificationCenter] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [showBidWizard, setShowBidWizard] = useState(false);
  const [showWelcomeGuide, setShowWelcomeGuide] = useState(false);
  const [showBootSplash, setShowBootSplash] = useState(true);
  const [bootMinElapsed, setBootMinElapsed] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
  const [bootPhase, setBootPhase] = useState(0);
  const editorContainerRef = useRef<HTMLDivElement>(null);

  // 编辑器容器挂载后标记就绪（避免在 ref 回调中 setState 触发额外渲染）
  useEffect(() => {
    if (editorContainerRef.current && !editorReady) setEditorReady(true);
  }, [editorReady]);

  // 全局事件：打开设置（如从任务详情「查看执行日志」）
  useEffect(() => {
    const onOpen = () => setShowSettingsDialog(true);
    window.addEventListener(EVENTS.OPEN_SETTINGS, onOpen);
    return () => window.removeEventListener(EVENTS.OPEN_SETTINGS, onOpen);
  }, []);

  // 在控制台查看任务执行（左侧任务列表「在控制台查看」触发，打开招投标/控制台面板并切到执行监控）
  useEffect(() => {
    const handler = () => setShowBidWizard(true);
    window.addEventListener(EVENTS.OPEN_TASK_IN_CONSOLE, handler);
    return () => window.removeEventListener(EVENTS.OPEN_TASK_IN_CONSOLE, handler);
  }, []);

  // 全局快捷键
  useKeyboardShortcuts([
    {
      key: 'p',
      ctrl: true,
      shift: true,
      description: t('app.shortcutSearch'),
      action: () => setShowCommandPalette(true),
    },
    {
      key: ',',
      ctrl: true,
      description: t('app.shortcutSettings'),
      action: () => setShowSettingsDialog(true),
    },
  ]);

  // 启动时应用已保存的深色/浅色主题（与 Settings 一致，避免配置深色但页面仍白底）
  useEffect(() => {
    try {
      const dark = getStorageItem("maibot_settings_darkMode", "") === "true";
      if (dark) {
        document.documentElement.classList.add("dark");
      } else {
        document.documentElement.classList.remove("dark");
      }
    } catch {
      document.documentElement.classList.remove("dark");
    }
  }, []);
  // 启动时应用已保存的主题色
  useEffect(() => {
    applySavedThemeAccent();
  }, []);

  // 检查是否首次使用
  useEffect(() => {
    const hasSeenGuide = localStorage.getItem(WELCOME_GUIDE_SEEN_KEY);
    const sampleCreated = localStorage.getItem(ONBOARDING_SAMPLE_CREATED_KEY);
    const sampleStatus = localStorage.getItem(ONBOARDING_SAMPLE_STATUS_KEY);
    // 引导是否展示与“示例任务创建状态”解耦：创建失败时允许再次进入引导修复首条体验闭环。
    setShowWelcomeGuide(!hasSeenGuide || (!sampleCreated && sampleStatus === "failed"));
  }, []);

  // 空闲时预加载 CommandPalette，降低首次唤起延迟
  useEffect(() => {
    let cancelled = false;
    let idleId: number | undefined;
    let timerId: number | undefined;
    const prefetch = () => {
      if (cancelled) return;
      void import("./components/CommandPalette").catch((err) => {
        if (import.meta.env?.DEV) console.warn("[App] CommandPalette 预加载失败:", err);
      });
    };
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof win.requestIdleCallback === "function") {
      idleId = win.requestIdleCallback(() => prefetch());
    } else {
      timerId = window.setTimeout(prefetch, 1200);
    }
    return () => {
      cancelled = true;
      if (idleId !== undefined && typeof win.cancelIdleCallback === "function") {
        win.cancelIdleCallback(idleId);
      }
      if (timerId !== undefined) {
        window.clearTimeout(timerId);
      }
    };
  }, []);

  // 轻量启动页：最小时长 + 编辑器就绪双条件，避免闪烁/过早消失
  useEffect(() => {
    const minTimer = window.setTimeout(() => setBootMinElapsed(true), 650);
    const watchdog = window.setTimeout(() => setShowBootSplash(false), 3500);
    const phase1 = window.setTimeout(() => setBootPhase(1), 250);
    const phase2 = window.setTimeout(() => setBootPhase(2), 900);
    const phase3 = window.setTimeout(() => setBootPhase(3), 1600);
    return () => {
      window.clearTimeout(minTimer);
      window.clearTimeout(watchdog);
      window.clearTimeout(phase1);
      window.clearTimeout(phase2);
      window.clearTimeout(phase3);
    };
  }, []);

  useEffect(() => {
    if (bootMinElapsed && editorReady) {
      setShowBootSplash(false);
    }
  }, [bootMinElapsed, editorReady]);

  // 后端错误全局展示（流式/工具执行中的错误事件）
  useEffect(() => {
    let lastMsg = "";
    let lastAt = 0;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ message?: string; error?: string }>)?.detail;
      const msg = detail?.message || detail?.error || t('app.unknownError');
      const now = Date.now();
      if (msg === lastMsg && now - lastAt < 2000) return;
      lastMsg = msg;
      lastAt = now;
      toast.error(t('app.backendError'), { description: msg });
    };
    window.addEventListener(EVENTS.BACKEND_ERROR, handler);
    return () => window.removeEventListener(EVENTS.BACKEND_ERROR, handler);
  }, []);

  // 前端运行时错误可视化（避免“没有调试信息”）
  useEffect(() => {
    let lastMsg = "";
    let lastAt = 0;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ message?: string; source?: string; lineno?: number; colno?: number }>)?.detail;
      const msg = String(detail?.message || t('app.frontendRuntimeError'));
      const now = Date.now();
      if (msg === lastMsg && now - lastAt < 2000) return;
      lastMsg = msg;
      lastAt = now;
      const loc = detail?.source ? `${detail.source}${detail.lineno ? `:${detail.lineno}` : ""}` : "";
      toast.error(t('app.frontendError'), {
        description: loc ? `${msg} (${loc})` : msg,
      });
    };
    window.addEventListener("renderer_runtime_error", handler as EventListener);
    return () => window.removeEventListener("renderer_runtime_error", handler as EventListener);
  }, []);

  // Electron 顶部菜单动作映射到现有命令链路
  useEffect(() => {
    menuService.onMenuAction((action) => {
      switch (action) {
        case "command-palette":
          setShowCommandPalette(true);
          break;
        case "open-settings":
          setShowSettingsDialog(true);
          break;
        case "new-chat":
          window.dispatchEvent(new CustomEvent(EVENTS.COMMAND_PALETTE_COMMAND, { detail: { commandId: "chat.new" } }));
          break;
        case "stop-generation":
          window.dispatchEvent(new CustomEvent(EVENTS.STOP_GENERATION_REQUEST));
          break;
        case "save":
          window.dispatchEvent(new CustomEvent(EVENTS.COMMAND_PALETTE_COMMAND, { detail: { commandId: "file.save" } }));
          break;
        case "save-all":
          window.dispatchEvent(new CustomEvent(EVENTS.COMMAND_PALETTE_COMMAND, { detail: { commandId: "file.saveAll" } }));
          break;
        default:
          break;
      }
    });
    return () => menuService.removeMenuActionListener();
  }, []);

  // 初始化文件同步管理器（延迟一帧执行，避免阻塞首屏渲染）
  const fileSyncInitialized = useRef(false);
  useEffect(() => {
    if (fileSyncInitialized.current) return;
    fileSyncInitialized.current = true;
    const t = requestAnimationFrame(() => {
      fileSyncManager.initialize()
        .then(() => {
          if (import.meta.env?.DEV) console.log('[App] ✅ 文件同步管理器初始化完成');
        })
        .catch((error) => {
          if (import.meta.env?.DEV) console.warn('[App] ⚠️ 文件同步管理器初始化失败:', error);
        });
    });
    return () => {
      cancelAnimationFrame(t);
      fileSyncManager.stopAutoSync();
    };
  }, []);

  const tryCreateOnboardingSampleTask = React.useCallback(async (): Promise<boolean> => {
    try {
      const res = await boardApi.createTask({
        subject: t('onboarding.sampleTaskSubject'),
        description: t('onboarding.sampleTaskDescription'),
        priority: 3,
        scope: "personal",
        source_channel: "onboarding",
        cost_tier: "low",
        skill_profile: "full",
        required_skills: ["knowledge-building", "text_analysis"],
        human_checkpoints: [
          { after_step: "计划草案", action: "review", description: "确认优先级与时间安排" },
        ],
        workspace_path: getCurrentWorkspacePathFromStorage() || undefined,
      });
      if (res.ok && res.task_id) {
        localStorage.setItem(ONBOARDING_SAMPLE_CREATED_KEY, "true");
        localStorage.setItem(ONBOARDING_SAMPLE_STATUS_KEY, "success");
        toast.success(t("onboarding.sampleTaskCreated"), { description: t("onboarding.sampleTaskCreatedDesc") });
        window.dispatchEvent(
          new CustomEvent(EVENTS.OPEN_TASK_IN_EDITOR, {
            detail: { taskId: res.task_id, subject: t('onboarding.sampleTaskSubject') },
          })
        );
        return true;
      }
    } catch {
      // noop
    }
    localStorage.setItem(ONBOARDING_SAMPLE_STATUS_KEY, "failed");
    toast.error(t("onboarding.sampleTaskFailed"), {
      description: t("onboarding.sampleTaskFailedDesc"),
    });
    return false;
  }, []);

  const handleCloseWelcomeGuide = () => {
    localStorage.setItem(WELCOME_GUIDE_SEEN_KEY, "true");
    setShowWelcomeGuide(false);
    const sampleCreated = localStorage.getItem(ONBOARDING_SAMPLE_CREATED_KEY);
    if (!sampleCreated) {
      void tryCreateOnboardingSampleTask();
    } else {
      localStorage.setItem(ONBOARDING_SAMPLE_STATUS_KEY, "success");
    }
    toast.success(t("onboarding.welcomeDone"), {
      description: t("onboarding.welcomeDoneDesc"),
      className: "dark:text-foreground",
      style: {
        background: "hsl(var(--background))",
        border: "1px solid hsl(var(--border))",
      },
    });
  };

  // 全局事件：创建引导示例任务（设置页/工作台空态「创建示例任务」触发）
  useEffect(() => {
    const onCreate = () => void tryCreateOnboardingSampleTask();
    window.addEventListener(EVENTS.CREATE_ONBOARDING_SAMPLE_TASK, onCreate);
    return () => window.removeEventListener(EVENTS.CREATE_ONBOARDING_SAMPLE_TASK, onCreate);
  }, [tryCreateOnboardingSampleTask]);

  const runAfterThreadSwitchPendingRef = useRef<Array<{ targetThreadId: string; next: () => void; failTimer: number }>>([]);
  const runAfterThreadSwitchListenerRef = useRef<((e: Event) => void) | null>(null);

  const runAfterThreadSwitch = useCallback((threadId: string | undefined, next: () => void) => {
    const targetThreadId = String(threadId || "").trim();
    if (!targetThreadId) {
      next();
      return;
    }
    const fail = () => {
      const entry = runAfterThreadSwitchPendingRef.current.find((p) => p.targetThreadId === targetThreadId && p.next === next);
      if (entry) window.clearTimeout(entry.failTimer);
      runAfterThreadSwitchPendingRef.current = runAfterThreadSwitchPendingRef.current.filter((p) => p.targetThreadId !== targetThreadId || p.next !== next);
      if (runAfterThreadSwitchPendingRef.current.length === 0 && runAfterThreadSwitchListenerRef.current) {
        window.removeEventListener(EVENTS.SESSION_CHANGED, runAfterThreadSwitchListenerRef.current as EventListener);
        runAfterThreadSwitchListenerRef.current = null;
      }
      toast.error(t("session.switchIncomplete"), { description: t("session.switchIncompleteDescApp") });
    };
    const failTimer = window.setTimeout(fail, SESSION_SWITCH_TIMEOUT_MS) as unknown as number;
    runAfterThreadSwitchPendingRef.current.push({ targetThreadId, next, failTimer });

    if (!runAfterThreadSwitchListenerRef.current) {
      const handler = (event: Event) => {
        const detail = (event as CustomEvent<SessionChangedDetail>).detail;
        const switchedId = String(detail?.threadId || "").trim();
        const toResolve = runAfterThreadSwitchPendingRef.current.filter((p) => p.targetThreadId === switchedId);
        runAfterThreadSwitchPendingRef.current = runAfterThreadSwitchPendingRef.current.filter((p) => p.targetThreadId !== switchedId);
        toResolve.forEach((p) => {
          window.clearTimeout(p.failTimer);
          p.next();
        });
        if (runAfterThreadSwitchPendingRef.current.length === 0 && runAfterThreadSwitchListenerRef.current) {
          window.removeEventListener(EVENTS.SESSION_CHANGED, runAfterThreadSwitchListenerRef.current as EventListener);
          runAfterThreadSwitchListenerRef.current = null;
        }
      };
      runAfterThreadSwitchListenerRef.current = handler;
      window.addEventListener(EVENTS.SESSION_CHANGED, handler as EventListener);
    }

    window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_TO_THREAD, { detail: { threadId: targetThreadId } }));
  }, []);

  const dispatchCapabilityAction = useCallback((actionType: string, payload?: Record<string, unknown>) => {
    if (!actionType) return;
    const summary = readLastRunSummary();
    if (actionType === "open_collab_center") {
      window.dispatchEvent(new CustomEvent(EVENTS.COMMAND_PALETTE_COMMAND, { detail: { commandId: 'open-collab-center' } }));
      return;
    }
    if (actionType === "ask_diagnose") {
      runAfterThreadSwitch(summary?.linkedThreadId, () => {
        setScopedChatMode('ask', summary?.linkedThreadId || undefined);
        window.dispatchEvent(new CustomEvent(EVENTS.COMMAND_PALETTE_COMMAND, { detail: { commandId: 'chat.focus' } }));
        window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, {
          detail: {
            prompt: `请先诊断上一轮失败根因，再给可执行重试方案：\n${summary?.lastError || "（无错误详情）"}`,
            threadId: summary?.linkedThreadId || undefined,
          },
        }));
      });
      return;
    }
    if (actionType === "retry_last_run") {
      const message = summary?.lastError
        ? `请按原参数重试上一轮任务，并优先修复该错误：${summary.lastError}`
        : "请按原参数继续上一轮任务并补齐未完成步骤。";
      runAfterThreadSwitch(summary?.linkedThreadId, () => {
        window.dispatchEvent(new CustomEvent(EVENTS.COMMAND_PALETTE_COMMAND, { detail: { commandId: 'chat.focus' } }));
        const linkedTaskId = String(summary?.linkedTaskId || "");
        if (linkedTaskId) {
          boardApi
            .resumeTask(linkedTaskId, {
              reason: "manual_retry_last_run",
              thread_id: summary?.linkedThreadId || undefined,
            })
            .then((res) => {
              if (res.ok && res.resumed) {
                const effectiveThreadId = summary?.linkedThreadId || undefined;
                const mergedSummary = {
                  ...(summary || {}),
                  threadId: effectiveThreadId,
                  running: true,
                  phaseLabel: "恢复中",
                  recoveryMode: res.mode || "resume_api",
                  recoveryPoint: (res.state?.execution as any)?.recovery_point || null,
                  linkedTaskId: linkedTaskId,
                };
                writeRunSummary(mergedSummary as Record<string, unknown>, effectiveThreadId);
                window.dispatchEvent(new CustomEvent(EVENTS.RUN_SUMMARY_UPDATED, { detail: mergedSummary }));
                toast.success(t("runTracker.recoveryContinued"));
                return;
              }
              toast.info(t("runTracker.recoveryPointUnavailable"));
              window.dispatchEvent(new CustomEvent(EVENTS.FOLLOWUP_MESSAGE, { detail: { message, threadId: summary?.linkedThreadId || undefined } }));
            })
            .catch(() => {
              toast.info(t("runTracker.recoveryApiUnavailable"));
              window.dispatchEvent(new CustomEvent(EVENTS.FOLLOWUP_MESSAGE, { detail: { message, threadId: summary?.linkedThreadId || undefined } }));
            });
          return;
        }
        window.dispatchEvent(new CustomEvent(EVENTS.FOLLOWUP_MESSAGE, { detail: { message, threadId: summary?.linkedThreadId || undefined } }));
      });
      return;
    }
    if (actionType === "open_linked_task") {
      const taskId = String(payload?.taskId || summary?.linkedTaskId || "");
      if (!taskId) return;
      window.dispatchEvent(new CustomEvent(EVENTS.OPEN_TASK_IN_EDITOR, {
        detail: { taskId, subject: String(payload?.subject || summary?.linkedSubject || "任务") },
      }));
      return;
    }
    if (actionType === "open_linked_thread") {
      const threadId = String(payload?.threadId || summary?.linkedThreadId || "");
      if (!threadId) return;
      runAfterThreadSwitch(threadId, () => {
        window.dispatchEvent(new CustomEvent(EVENTS.COMMAND_PALETTE_COMMAND, { detail: { commandId: 'chat.focus' } }));
      });
    }
  }, [runAfterThreadSwitch]);

  useEffect(() => {
    const onCapabilityAction = (event: Event) => {
      const detail = (event as CustomEvent<{ actionType?: string; payload?: Record<string, unknown> }>).detail;
      const actionType = String(detail?.actionType || "");
      dispatchCapabilityAction(actionType, detail?.payload || {});
    };
    window.addEventListener(EVENTS.CAPABILITY_ACTION, onCapabilityAction);
    return () => window.removeEventListener(EVENTS.CAPABILITY_ACTION, onCapabilityAction);
  }, [dispatchCapabilityAction]);

  const handleCommandSelect = (
    commandId: string,
    payload?: { type: 'command' | 'thread' | 'file'; threadId?: string; filePath?: string }
  ) => {
    switch (commandId) {
      case "settings.open":
        setShowSettingsDialog(true);
        break;
      case "settings.agent_profile":
        window.dispatchEvent(new CustomEvent(EVENTS.COMMAND_PALETTE_COMMAND, { detail: { commandId } }));
        break;
      case "open-bid-wizard":
        setShowBidWizard(true);
        break;
      case "open-notifications":
        setShowNotificationCenter(true);
        break;
      case "knowledge.open":
        window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_LEFT_PANEL, { detail: { tab: 'knowledge' } }));
        break;
      case "open-task-panel":
        window.dispatchEvent(new CustomEvent(EVENTS.COMMAND_PALETTE_COMMAND, { detail: { commandId: 'open-task-panel' } }));
        break;
      case "open-collab-center":
      case "view.focus_mode":
        window.dispatchEvent(new CustomEvent(EVENTS.COMMAND_PALETTE_COMMAND, { detail: { commandId } }));
        break;
      case "file.new":
      case "file.open":
      case "view.sidebar":
      case "chat.new":
      case "chat.focus":
      case "chat.stop":
      case "file.save":
      case "file.saveAll":
      case "file.close":
      case "nav.goToFile":
      case "settings.keyboard":
        // 由 FullEditorV2Enhanced 监听并执行
        window.dispatchEvent(new CustomEvent(EVENTS.COMMAND_PALETTE_COMMAND, { detail: { commandId } }));
        break;
      case "recovery.retry": {
        window.dispatchEvent(new CustomEvent(EVENTS.CAPABILITY_ACTION, { detail: { actionType: 'retry_last_run' } }));
        break;
      }
      case "recovery.ask_diagnose": {
        window.dispatchEvent(new CustomEvent(EVENTS.CAPABILITY_ACTION, { detail: { actionType: 'ask_diagnose' } }));
        break;
      }
      case "recovery.open_task": {
        window.dispatchEvent(new CustomEvent(EVENTS.CAPABILITY_ACTION, { detail: { actionType: 'open_linked_task' } }));
        break;
      }
      case "recovery.open_thread": {
        window.dispatchEvent(new CustomEvent(EVENTS.CAPABILITY_ACTION, { detail: { actionType: 'open_linked_thread' } }));
        break;
      }
      case "search.threads":
        window.dispatchEvent(new CustomEvent(EVENTS.OPEN_CHAT_PANEL));
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent(EVENTS.THREAD_LIST_FOCUS_SEARCH));
        }, 200);
        break;
      case "search.switch-thread":
        if (payload?.threadId) {
          runAfterThreadSwitch(payload.threadId, () => {
            window.dispatchEvent(new CustomEvent(EVENTS.COMMAND_PALETTE_COMMAND, { detail: { commandId: 'chat.focus' } }));
          });
        }
        break;
      case "search.open-file":
        if (payload?.filePath) {
          fileEventBus.emit({ type: 'file_open', path: payload.filePath });
        }
        break;
    }
    setShowCommandPalette(false);
  };

  return (
    <AppProvider>
      <SessionContextProvider>
      <TooltipProvider delayDuration={300} skipDelayDuration={150}>
      <div className="h-screen flex flex-col bg-background">
        {/* 
          AI 工作舞台 - 单页面架构
          FullEditorV2Enhanced 包含：
          - 左侧：工作区导航（文件树）
          - 中央：内容舞台（编辑器/Dashboard/面板/AI结果）
          - 右侧：对话交互
        */}
        <ErrorBoundary autoRecover autoRecoverDelay={2500}>
          <Suspense fallback={<div className="flex-1 min-h-0 flex items-center justify-center text-muted-foreground">加载中…</div>}>
            <div className="flex-1 min-h-0 overflow-hidden" ref={editorContainerRef}>
              <FullEditorV2Enhanced
                onOpenCommandPalette={() => setShowCommandPalette(true)}
                commandPaletteOpen={showCommandPalette}
                openSettingsRequest={showSettingsDialog}
                onOpenSettingsHandled={() => setShowSettingsDialog(false)}
                bidWizardOpen={showBidWizard}
                onBidWizardClose={() => setShowBidWizard(false)}
              />
            </div>
          </Suspense>
        </ErrorBoundary>

        {showBootSplash && (
          <div className="absolute inset-0 z-120 flex items-center justify-center bg-linear-to-b from-background/95 via-background/90 to-muted/30 backdrop-blur-md pointer-events-none transition-opacity duration-300">
            <div className="w-[min(520px,90vw)] rounded-2xl border border-border/50 bg-card/75 px-6 py-5 shadow-2xl">
              <div className="mb-4 flex items-center gap-3">
                <div className="inline-flex size-9 items-center justify-center rounded-xl border border-primary/30 bg-primary/10 text-primary font-semibold">
                  M
                </div>
                <div>
                  <div className="text-sm font-semibold tracking-wide">MAIBOT</div>
                  <div className="text-xs text-muted-foreground">个人 AI 竞争力平台</div>
                </div>
              </div>
              <div className="mb-3 text-sm text-foreground/90">
                {bootPhase <= 1 && "正在初始化引擎..."}
                {bootPhase === 2 && "正在加载知识库..."}
                {bootPhase >= 3 && "正在准备就绪..."}
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/70">
                <div
                  className="h-full rounded-full bg-linear-to-r from-primary/60 via-primary to-emerald-400 transition-all duration-500 ease-out"
                  style={{ width: `${bootPhase <= 0 ? 12 : bootPhase === 1 ? 42 : bootPhase === 2 ? 76 : 100}%` }}
                />
              </div>
            </div>
          </div>
        )}

        {/* 命令面板 */}
        {showCommandPalette && (
          <Suspense fallback={null}>
            <CommandPalette
              open={showCommandPalette}
              onOpenChange={setShowCommandPalette}
              onCommand={handleCommandSelect}
            />
          </Suspense>
        )}

        {/* 通知中心 */}
        <AnimatePresence>
          {showNotificationCenter && (
            <Suspense fallback={null}>
              <NotificationCenter
                onClose={() => setShowNotificationCenter(false)}
                onClearAll={() => toast.success("已清除所有通知")}
              />
            </Suspense>
          )}
        </AnimatePresence>

        {/* 欢迎引导 */}
        <AnimatePresence>
          {showWelcomeGuide && (
            <Suspense fallback={null}>
              <WelcomeGuide onComplete={handleCloseWelcomeGuide} />
            </Suspense>
          )}
        </AnimatePresence>

        {/* Toast 通知 */}
        <Toaster position="top-right" />
      </div>
      </TooltipProvider>
      </SessionContextProvider>
    </AppProvider>
  );
}
