/**
 * ErrorBoundary - 生产级错误边界组件
 *
 * 功能：
 * - 捕获React组件树中的JavaScript错误
 * - 显示友好的错误界面
 * - 提供错误恢复选项（不刷新页面的软恢复）
 * - 自动清理内存和缓存
 * - 记录错误信息用于调试
 */

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { AlertTriangle, RefreshCw, Home, Bug, RotateCcw } from 'lucide-react';
import { removeItem as removeStorageItem } from '../../lib/safeStorage';
import { clearActiveThreadSession } from '../../lib/sessionState';
import { t } from '../../lib/i18n';

interface Props {
  children?: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** 是否启用自动恢复尝试 */
  autoRecover?: boolean;
  /** 自动恢复延迟（毫秒） */
  autoRecoverDelay?: number;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: ErrorInfo;
  errorCount: number;
  lastErrorTime: number;
  /** 上次自动恢复时间，用于限频避免「错误→软恢复→再错误」循环 */
  lastAutoRecoverTime: number;
  /** 用于检测 children 身份变化时重置错误状态 */
  lastChildren: ReactNode;
}

/** 根据错误信息返回 i18n 键（用于 t(key)）或 null */
function getFriendlyErrorHintKey(error: Error): string | null {
  const msg = (error?.message || "").toLowerCase();
  if (msg.includes("tool call") && (msg.includes("does not match") || msg.includes("write_todos"))) {
    return "errorBoundary.hint.sync";
  }
  if (msg.includes("before initialization") || msg.includes("cannot access")) {
    return "errorBoundary.hint.init";
  }
  if (msg.includes("loading chunk") || msg.includes("chunk load failed") || msg.includes("dynamically imported module") || msg.includes("failed to fetch dynamically")) {
    return "errorBoundary.hint.chunk";
  }
  if (msg.includes("network request failed") || msg.includes("failed to fetch") || msg.includes("networkerror")) {
    return "errorBoundary.hint.network";
  }
  if (msg.includes("resizeobserver loop")) {
    return "errorBoundary.hint.resizeObserver";
  }
  if (msg.includes("eacces") || msg.includes("eperm") || msg.includes("permission") || msg.includes("权限") || msg.includes("拒绝")) {
    return "errorBoundary.hint.permission";
  }
  if (msg.includes("context size") || msg.includes("context_exceeded") || msg.includes("context size has been exceeded")) {
    return "errorBoundary.hint.contextExceeded";
  }
  if (msg.includes("runnablebinding") && msg.includes("streaming")) {
    return "errorBoundary.hint.streaming";
  }
  return null;
}

// 全局错误计数（用于检测频繁错误）
let globalErrorCount = 0;
let lastGlobalErrorTime = 0;

export class ErrorBoundary extends Component<Props, State> {
  private autoRecoverTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: Props) {
    super(props);
    this.state = { 
      hasError: false,
      errorCount: 0,
      lastErrorTime: 0,
      lastAutoRecoverTime: 0,
      lastChildren: props.children,
    };
  }

  static getDerivedStateFromProps(nextProps: Props, prevState: State): Partial<State> | null {
    const nextChildren = nextProps.children;
    if (nextChildren !== prevState.lastChildren) {
      return {
        lastChildren: nextChildren,
        ...(prevState.hasError ? { hasError: false, error: undefined, errorInfo: undefined } : {}),
      };
    }
    return null;
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const now = Date.now();
    
    // 更新全局错误计数
    if (now - lastGlobalErrorTime > 60000) {
      // 超过1分钟，重置计数
      globalErrorCount = 1;
    } else {
      globalErrorCount++;
    }
    lastGlobalErrorTime = now;

    if (typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'development') {
      console.error('[ErrorBoundary] 捕获错误:', error.message);
      console.error('[ErrorBoundary] 组件堆栈:', errorInfo.componentStack?.slice(0, 500));
    }

    const lastAuto = this.state.lastAutoRecoverTime || 0;
    const allowAutoRecover = this.props.autoRecover && (now - lastAuto > 120000); // 2 分钟内不重复自动恢复
    this.setState(prev => ({
      error,
      errorInfo,
      errorCount: prev.errorCount + 1,
      lastErrorTime: now,
      lastAutoRecoverTime: allowAutoRecover ? now : prev.lastAutoRecoverTime,
    }));

    // 调用外部错误处理函数
    this.props.onError?.(error, errorInfo);

    // 若启用自动恢复：仅做软恢复（不 reload），避免「崩溃→reload→再崩溃」反复重启
    if (this.props.autoRecover && allowAutoRecover) {
      if (this.autoRecoverTimer) clearTimeout(this.autoRecoverTimer);
      const delay = this.props.autoRecoverDelay ?? 3000;
      this.autoRecoverTimer = setTimeout(() => {
        this.autoRecoverTimer = null;
        this.handleSoftRecover();
      }, delay);
    }

    // 如果错误频繁（1分钟内超过5次），清理内存
    if (globalErrorCount > 5) {
      if (typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'development') {
        console.warn('[ErrorBoundary] 检测到频繁错误，执行内存清理');
      }
      this.cleanupMemory();
    }
  }

  componentWillUnmount() {
    if (this.autoRecoverTimer) {
      clearTimeout(this.autoRecoverTimer);
    }
  }

  /**
   * 清理内存和缓存
   */
  cleanupMemory = () => {
    try {
      // 清理 localStorage 中的大型缓存
      const keysToClean = [
        'chat_sessions',
        'editor_content', 
        'file_cache',
        'maibot_thread_history',
      ];
      keysToClean.forEach(key => {
        try {
          const item = localStorage.getItem(key);
          if (item && item.length > 100000) { // 超过100KB的清理
            localStorage.removeItem(key);
            if (typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'development') {
              console.log(`[ErrorBoundary] 已清理 localStorage: ${key}`);
            }
          }
        } catch (e) {
          // 忽略
        }
      });

      // 触发垃圾回收（如果可用）
      if (typeof window !== 'undefined' && (window as any).gc) {
        (window as any).gc();
      }
    } catch (e) {
      if (typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'development') {
        console.warn('[ErrorBoundary] 内存清理失败:', e);
      }
    }
  };

  /**
   * 软恢复：不刷新页面，只重置错误状态
   */
  handleSoftRecover = () => {
    this.cleanupMemory();
    this.setState({ 
      hasError: false, 
      error: undefined, 
      errorInfo: undefined 
    });
  };

  handleReload = () => {
    window.location.reload();
  };

  handleReset = () => {
    try {
      clearActiveThreadSession();
      localStorage.removeItem('chat_sessions');
      localStorage.removeItem('editor_content');
      removeStorageItem('maibot_thread_history');
      localStorage.removeItem('file_cache');
    } catch (e) {
      console.warn('Failed to clear localStorage:', e);
    }
    this.handleReload();
  };

  handleGoHome = () => {
    // 先清理再跳转
    this.cleanupMemory();
    window.location.href = '/';
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const isFrequentError = this.state.errorCount > 3;

      return (
        <div className="min-h-screen bg-background flex items-center justify-center p-4">
          <Card className="max-w-2xl w-full border-destructive/20">
            <CardHeader className="text-center">
              <div className="mx-auto w-12 h-12 bg-destructive/10 rounded-full flex items-center justify-center mb-4">
                <AlertTriangle className="w-6 h-6 text-destructive" />
              </div>
              <CardTitle className="text-xl text-destructive">
                {t("errorBoundary.title")}
              </CardTitle>
              {isFrequentError && (
                <p className="text-sm text-amber-600 mt-2">
                  {t("errorBoundary.frequentHint")}
                </p>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-muted-foreground text-center">
                {this.state.error && getFriendlyErrorHintKey(this.state.error)
                  ? t(getFriendlyErrorHintKey(this.state.error)!)
                  : t("errorBoundary.fallbackMessage")}
              </p>

              {/* 错误详情（开发环境显示） */}
              {import.meta.env?.DEV && this.state.error && (
                <details className="bg-muted p-3 rounded text-sm">
                  <summary className="cursor-pointer font-medium text-foreground mb-2">
                    {t("errorBoundary.detailSummary")}
                  </summary>
                  <div className="space-y-2">
                    <div>
                      <strong>{t("errorBoundary.errorMessage")}:</strong>
                      <pre className="mt-1 p-2 bg-background rounded text-xs overflow-auto">
                        {this.state.error.message}
                      </pre>
                    </div>
                    {this.state.error.stack && (
                      <div>
                        <strong>{t("errorBoundary.errorStack")}:</strong>
                        <pre className="mt-1 p-2 bg-background rounded text-xs overflow-auto max-h-40">
                          {this.state.error.stack}
                        </pre>
                      </div>
                    )}
                    {this.state.errorInfo?.componentStack && (
                      <div>
                        <strong>{t("errorBoundary.componentStack")}:</strong>
                        <pre className="mt-1 p-2 bg-background rounded text-xs overflow-auto max-h-40">
                          {this.state.errorInfo.componentStack}
                        </pre>
                      </div>
                    )}
                  </div>
                </details>
              )}

              {/* 操作按钮 */}
              <div className="flex flex-col sm:flex-row gap-2 justify-center">
                {/* 软恢复（推荐首选） */}
                <Button 
                  onClick={this.handleSoftRecover} 
                  className="flex items-center gap-2"
                  variant="default"
                >
                  <RotateCcw className="w-4 h-4" />
                  {t("errorBoundary.tryRecover")}
                </Button>
                <Button 
                  onClick={this.handleReload} 
                  variant="outline"
                  className="flex items-center gap-2"
                >
                  <RefreshCw className="w-4 h-4" />
                  {t("errorBoundary.reloadPage")}
                </Button>
                <Button
                  onClick={this.handleReset}
                  variant={isFrequentError ? "destructive" : "outline"}
                  className="flex items-center gap-2"
                >
                  <Bug className="w-4 h-4" />
                  {t("errorBoundary.resetData")}
                </Button>
                <Button
                  onClick={this.handleGoHome}
                  variant="outline"
                  className="flex items-center gap-2"
                >
                  <Home className="w-4 h-4" />
                  {t("errorBoundary.goHome")}
                </Button>
              </div>

              <p className="text-xs text-muted-foreground text-center">
                {t("errorBoundary.errorCount")}: {this.state.errorCount} | {t("errorBoundary.resetHint")}
              </p>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
