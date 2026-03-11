/**
 * ChatArea - Cursor 风格对话面板
 */

import React, { useState, useEffect } from 'react';
import { MyRuntimeProvider } from './ChatComponents/MyRuntimeProvider';
import { Thread } from './ChatComponents/thread';
import { ThreadList, ThreadStatusContext } from './ChatComponents/thread-list';
import { ErrorBoundary } from './common/ErrorBoundary';
import { CrystallizationToast } from './CrystallizationToast';
import { BackendHealthBanner } from './ChatComponents/BackendHealthBanner';
import { EVENTS } from '../lib/constants';
import { t } from '../lib/i18n';
import { Button } from './ui/button';
import { RefreshCw } from 'lucide-react';
import { TooltipProvider, TooltipVariantContext } from './ui/tooltip';
import { getItem as getStorageItem } from '../lib/safeStorage';

// ============================================================================
// 类型定义
// ============================================================================

/** 单条 Lint 诊断（与 Monaco 对齐，供 config.linter_errors） */
export type LinterErrorItem = { path: string; line: number; col: number; severity: number; message: string };

interface ChatAreaProps {
  workspaceId?: string;
  editorContent?: string;
  editorPath?: string;
  selectedText?: string;
  linterErrors?: LinterErrorItem[];
  workspaceFiles?: string[];
  workspacePath?: string;
  openFiles?: Array<{ path: string; totalLines?: number; cursorLine?: number }>;
  /** 最近查看的文件路径（Cursor 风格环境感知），由编辑区传入 */
  recentlyViewedFiles?: string[];
  className?: string;
  onClose?: () => void;
  onFileAction?: (action: {
    type: 'open' | 'refresh' | 'close';
    filePath: string;
    content?: string;
  }) => void;
  connectionHealthy?: boolean;
  /** 连接异常时的错误信息（由父组件健康检查提供），用于在横幅中展示 */
  connectionError?: string | null;
}

// ============================================================================
// 主组件
// ============================================================================

export const ChatArea: React.FC<ChatAreaProps> = ({
  workspaceId,
  editorContent,
  editorPath,
  selectedText,
  linterErrors,
  workspaceFiles = [],
  workspacePath,
  openFiles,
  recentlyViewedFiles,
  className = '',
  onClose,
  onFileAction,
  connectionHealthy = true,
  connectionError = null,
}) => {
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [taskRunning, setTaskRunning] = useState(false);

  useEffect(() => {
    const handler = (e: CustomEvent<{ running: boolean }>) => {
      setTaskRunning(e.detail?.running ?? false);
    };
    window.addEventListener('task_running' as any, handler);
    return () => window.removeEventListener('task_running' as any, handler);
  }, []);

  const editorContext = React.useMemo(() => ({
    editorContent,
    editorPath,
    selectedText,
    linterErrors,
    workspaceFiles,
    workspacePath,
    workspaceId,
  }), [editorContent, editorPath, selectedText, linterErrors, workspaceFiles, workspacePath, workspaceId]);

  const threadStatusValue = React.useMemo(
    () => ({ taskRunning, activeThreadId: currentThreadId }),
    [taskRunning, currentThreadId]
  );

  const displayEditorPath = React.useMemo(() => {
    if (!editorPath) return '';
    if (workspacePath && editorPath.startsWith(workspacePath)) {
      const relative = editorPath.slice(workspacePath.length).replace(/^[/\\]+/, '');
      return relative || editorPath;
    }
    return editorPath;
  }, [editorPath, workspacePath]);

  /** 当前工作区短路径（最后一段目录名），用于 context strip */
  const displayWorkspacePath = React.useMemo(() => {
    if (!workspacePath?.trim()) return '';
    const segments = workspacePath.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : workspacePath;
  }, [workspacePath]);

  /** 传给 MyRuntimeProvider：有则转成 { path, name }[]，无或空则 undefined 由 Provider 按 workspacePath 拉取 */
  const workspaceFilesForMention = React.useMemo(
    () =>
      workspaceFiles?.length
        ? workspaceFiles.map((p) => ({ path: p, name: p.split('/').pop() || p }))
        : undefined,
    [workspaceFiles]
  );

  const [chatNarrowScrollbar, setChatNarrowScrollbar] = useState(() =>
    getStorageItem('maibot_chat_narrow_scrollbar') === 'true'
  );
  const [chatFadingAnimation, setChatFadingAnimation] = useState(() =>
    getStorageItem('maibot_chat_fading_animation') !== 'false'
  );
  useEffect(() => {
    const sync = () => {
      setChatNarrowScrollbar(getStorageItem('maibot_chat_narrow_scrollbar') === 'true');
      setChatFadingAnimation(getStorageItem('maibot_chat_fading_animation') !== 'false');
    };
    window.addEventListener(EVENTS.COMPOSER_PREFS_CHANGED, sync);
    return () => window.removeEventListener(EVENTS.COMPOSER_PREFS_CHANGED, sync);
  }, []);

  return (
    <div
      className={`flex flex-col h-full min-h-0 bg-background ${className}`}
      data-chat-narrow-scrollbar={chatNarrowScrollbar ? 'true' : 'false'}
      data-chat-fading={chatFadingAnimation ? 'true' : 'false'}
    >
      <MyRuntimeProvider
        editorContext={editorContext}
        onFileAction={onFileAction}
        onThreadChange={setCurrentThreadId}
        openFiles={openFiles}
        recentlyViewedFiles={recentlyViewedFiles}
        workspacePath={workspacePath}
        workspaceFiles={workspaceFilesForMention}
      >
        {/* 顶部标签栏：ThreadList 占满一行，与编辑区 Tab 栏高度一致 32px */}
        <div
          className="shrink-0 h-(--tabbar-height) panel-header flex items-center w-full min-w-0 border-b border-border bg-muted/5"
          role="region"
          aria-label="对话线程与操作"
        >
          <ThreadStatusContext.Provider value={threadStatusValue}>
            <ErrorBoundary
              fallback={
                <div className="flex items-center justify-center gap-2 px-3 py-2 text-xs text-muted-foreground border-b border-border/20">
                  {t('chat.threadListLoadError')}
                </div>
              }
            >
              <ThreadList onClose={onClose} />
            </ErrorBoundary>
          </ThreadStatusContext.Provider>
        </div>
        {(displayEditorPath || displayWorkspacePath) && (
          <div className="context-strip shrink-0 panel-header border-b border-border flex flex-wrap items-center gap-x-4 gap-y-1">
            {displayEditorPath && (
              <>
                <span className="shrink-0 context-secondary">{t('chat.contextStripFile')}</span>
                <span className="truncate context-secondary min-w-0 max-w-[50%]" title={editorPath}>{displayEditorPath}</span>
              </>
            )}
            {displayWorkspacePath && (
              <>
                {displayEditorPath && <span className="shrink-0 text-border">|</span>}
                <span className="shrink-0 context-secondary">{t('chat.contextStripWorkspace')}</span>
                <span className="truncate context-secondary min-w-0 max-w-[50%]" title={workspacePath}>{displayWorkspacePath}</span>
              </>
            )}
          </div>
        )}
        {/* 连接异常时在聊天区顶部显示横幅，不整块替换；保留 todo 栏与运行控制栏结构 */}
        {!connectionHealthy && (
          <div
            className="shrink-0 flex items-center justify-between gap-3 px-4 py-2.5 border-b border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200"
            role="alert"
            aria-live="assertive"
          >
            <p className="text-sm flex-1 min-w-0 truncate">
              {t('chat.connectionDegraded')}
              {connectionError && <span className="text-muted-foreground/90 ml-1">（{connectionError}）</span>}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 h-8 text-xs border-amber-500/50 hover:bg-amber-500/20"
              onClick={() => window.dispatchEvent(new CustomEvent(EVENTS.CONNECTION_RETRY_REQUEST))}
              aria-label={t('chat.connectionRetryAria')}
            >
              <RefreshCw className="size-3.5 mr-1.5" />
              {t('connection.retry')}
            </Button>
          </div>
        )}
        {connectionHealthy && <BackendHealthBanner />}
        {/* 聊天区域（含 todo 栏、运行控制栏、Composer）；Cursor 一致：统一 Tooltip 延迟 350ms + 轻量 popover 样式 */}
        <TooltipProvider delayDuration={350} skipDelayDuration={200}>
        <TooltipVariantContext.Provider value="popover">
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <ErrorBoundary
            fallback={
              <div className="flex flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
                <p>{t('chat.threadLoadError')}</p>
                <p className="text-xs">{t('errorBoundary.hint.sessionContext')}</p>
              </div>
            }
            autoRecover
            autoRecoverDelay={2000}
          >
            <Thread connectionHealthy={connectionHealthy} />
          </ErrorBoundary>
        </div>
        </TooltipVariantContext.Provider>
        </TooltipProvider>

        {/* 中断已在 thread ViewportFooter 内以内联形式展示，此处不再挂载弹窗 */}
        <CrystallizationToast threadId={currentThreadId} taskRunning={taskRunning} workspaceId={workspaceId} />
      </MyRuntimeProvider>
    </div>
  );
};

export default ChatArea;
