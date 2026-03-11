/**
 * InterruptDialog - Human-in-the-Loop 中断处理对话框
 *
 * 即「LLM 在向用户提问或等待确认」的呈现；当 AI 需要人工确认时显示此对话框。
 * 聊天场景须使用 variant="inline"，在 ViewportFooter 内内联展示，不使用弹窗（与 Cursor 一致）；有 ask_user 时仅工具卡或本 Dialog 一处入口（InterruptDialogGuard 保证单入口）。
 */

import React, { useState, useEffect, useContext, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  AlertTriangle,
  CheckCircle,
  XCircle,
  Loader2,
  MessageSquare,
  Shield,
  FileWarning,
  Zap,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { Badge } from '../ui/badge';
import { toast } from 'sonner';
import { getInterruptState, resumeInterrupt } from '../../lib/api/langserveChat';
import { t } from '../../lib/i18n';
import { EVENTS } from '../../lib/constants';
import { getItem as getStorageItem } from '../../lib/safeStorage';
import { setScopedChatMode } from '../../lib/chatModeState';
import { InlineDiffView } from './inline-diff';
import { InterruptStateContext } from './thread';

interface InterruptDialogProps {
  threadId: string;
  /** 确认/拒绝后回调；若 resume 返回 run_id 则传入，便于父级接流续显（同一会话内连续） */
  onResolved?: (result?: { run_id?: string }) => void;
  className?: string;
  /** 内联模式：在聊天区 ViewportFooter 内渲染，无固定定位；弹窗模式：右下角浮动（fallback） */
  variant?: 'inline' | 'popup';
}

interface InterruptState {
  hasInterrupt: boolean;
  interruptType?: string;
  interruptMessage?: string;
  interruptData?: Record<string, unknown>;
}

// 中断类型配置（暗色模式兼容）；标题通过 t('interrupt.title.<type>') 在组件内渲染
const interruptTypeConfig: Record<string, {
  icon: React.ElementType;
  color: string;
  bgColor: string;
}> = {
  confirmation: { icon: Shield, color: 'text-amber-600 dark:text-amber-400', bgColor: 'bg-amber-500/10' },
  human_checkpoint: { icon: Shield, color: 'text-amber-600 dark:text-amber-400', bgColor: 'bg-amber-500/10' },
  plan_confirmation: { icon: Shield, color: 'text-emerald-600 dark:text-emerald-400', bgColor: 'bg-emerald-500/10' },
  file_operation: { icon: FileWarning, color: 'text-orange-600 dark:text-orange-400', bgColor: 'bg-orange-500/10' },
  dangerous_action: { icon: AlertTriangle, color: 'text-red-600 dark:text-red-400', bgColor: 'bg-red-500/10' },
  input_required: { icon: MessageSquare, color: 'text-blue-600 dark:text-blue-400', bgColor: 'bg-blue-500/10' },
  tool_diff_approval: { icon: FileWarning, color: 'text-amber-600 dark:text-amber-400', bgColor: 'bg-amber-500/10' },
  default: { icon: Zap, color: 'text-purple-600 dark:text-purple-400', bgColor: 'bg-purple-500/10' },
};

const INITIAL_INTERRUPT_STATE: InterruptState = { hasInterrupt: false };

export const InterruptDialog: React.FC<InterruptDialogProps> = ({
  threadId,
  onResolved,
  className = '',
  variant = 'popup',
}) => {
  const ctx = useContext(InterruptStateContext);
  const [localState, setLocalState] = useState<InterruptState>(INITIAL_INTERRUPT_STATE);
  const interruptState = ctx.setState != null ? ctx.state : localState;
  const writeState = useCallback((s: InterruptState | ((prev: InterruptState) => InterruptState)) => {
    const next = typeof s === 'function' ? (s as (p: InterruptState) => InterruptState)(interruptState) : s;
    setLocalState(next);
    ctx.setState?.(next);
  }, [ctx.setState, interruptState]);

  const [userInput, setUserInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  /** 工具审批逐条决策：与 action_requests 一一对应，未选时为 undefined，提交时未选按 approve */
  const [toolDiffDecisions, setToolDiffDecisions] = useState<(undefined | 'approve' | 'reject')[]>([]);
  const pollDelayRef = React.useRef(1200);
  const latestThreadIdRef = React.useRef(threadId);
  const requestSeqRef = React.useRef(0);
  const submittingRef = React.useRef(false);

  useEffect(() => {
    latestThreadIdRef.current = threadId;
  }, [threadId]);

  // 工具审批：同步逐条决策数组长度与 action_requests 一致
  useEffect(() => {
    if (interruptState.interruptType !== 'tool_diff_approval') return;
    const actions = (interruptState.interruptData?.action_requests as unknown[]) ?? [];
    if (actions.length === 0) return;
    setToolDiffDecisions(prev => {
      if (prev.length === actions.length) return prev;
      return Array.from({ length: actions.length }, (_, i) => prev[i]);
    });
  }, [interruptState.interruptType, interruptState.interruptData?.action_requests]);

  // 唯一轮询方：结果写回 Context（Thread 内工具卡/Footer 同源），避免与 Provider 双轮询
  const checkInterrupt = async (silent = false): Promise<boolean> => {
    const capturedThreadId = threadId;
    if (!capturedThreadId) return false;
    const reqSeq = ++requestSeqRef.current;
    if (!silent) setIsChecking(true);
    try {
      const state = await getInterruptState(capturedThreadId);
      if (latestThreadIdRef.current !== capturedThreadId || reqSeq !== requestSeqRef.current) return false;
      const next: InterruptState = {
        hasInterrupt: state.interrupted,
        interruptType: state.interruptType,
        interruptMessage: state.question,
        interruptData: state.interruptData as Record<string, unknown> | undefined,
      };
      writeState(next);
      return !!state.interrupted;
    } catch (error) {
      console.error('[InterruptDialog] 检查中断状态失败:', error);
      return false;
    } finally {
      if (!silent && reqSeq === requestSeqRef.current) setIsChecking(false);
    }
  };

  // 智能轮询：先快后慢，检测到中断后回到快速频率
  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    pollDelayRef.current = 1200;

    const loop = async () => {
      if (!alive) return;
      const interrupted = await checkInterrupt(true);
      if (!alive) return;
      if (interrupted) {
        pollDelayRef.current = 1200;
      } else {
        pollDelayRef.current = Math.min(10000, Math.round(pollDelayRef.current * 1.6));
      }
      timer = window.setTimeout(loop, pollDelayRef.current);
    };

    void checkInterrupt(false);
    timer = window.setTimeout(loop, pollDelayRef.current);
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [threadId]);

  // 处理确认 / 批准（同一会话内连续：确认后 run 继续执行，不中断会话）
  const handleConfirm = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsLoading(true);
    try {
      let runId: string | undefined;
      if (interruptState.interruptType === 'tool_diff_approval') {
        const actions = (interruptState.interruptData?.action_requests as Array<{ name?: string }>) ?? [];
        const decisions = actions.map((_, i) => {
          const choice = toolDiffDecisions[i] ?? 'approve';
          return choice === 'reject'
            ? { type: 'reject' as const, message: userInput || t('interrupt.rejectDefault') }
            : { type: 'approve' as const };
        });
        const result = await resumeInterrupt(threadId, { decisions });
        runId = result?.run_id;
        toast.success(t('interrupt.toast.accepted'));
      } else if (interruptState.interruptType === 'human_checkpoint') {
        const result = await resumeInterrupt(threadId, 'approve', userInput || undefined);
        runId = result?.run_id;
        toast.success(t('interrupt.toast.approved'));
      } else if (interruptState.interruptType === 'plan_confirmation') {
        const result = await resumeInterrupt(threadId, 'approve', userInput || undefined);
        runId = result?.run_id;
        toast.success(t('interrupt.toast.planConfirmed'));
        const shouldSwitchToAgent = (() => {
          try {
            const v = getStorageItem('maibot_plan_confirm_switch_to_agent');
            return v == null || v === '' ? true : v !== 'false';
          } catch {
            return true;
          }
        })();
        if (shouldSwitchToAgent) {
          setScopedChatMode('agent', threadId);
          window.dispatchEvent(new CustomEvent(EVENTS.CHAT_MODE_CHANGED, { detail: { mode: 'agent', threadId } }));
        }
      } else if (interruptState.interruptType === 'input_required') {
        const result = await resumeInterrupt(threadId, (userInput || '').trim() || 'yes');
        runId = result?.run_id;
        toast.success(t('interrupt.toast.confirmed'));
      } else {
        const result = await resumeInterrupt(threadId, true, userInput || undefined);
        runId = result?.run_id;
        toast.success(t('interrupt.toast.confirmed'));
      }
      writeState({ hasInterrupt: false });
      setUserInput('');
      if (interruptState.interruptType === 'tool_diff_approval') setToolDiffDecisions([]);
      onResolved?.(runId ? { run_id: runId } : undefined);
    } catch (error) {
      toast.error(t('interrupt.toast.actionFailed'), {
        description: error instanceof Error ? error.message : t('interrupt.toast.unknownError'),
      });
    } finally {
      submittingRef.current = false;
      setIsLoading(false);
    }
  };

  // 处理拒绝（同一会话内：跳过本操作后 run 继续，不中断会话）
  const handleReject = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsLoading(true);
    try {
      let runId: string | undefined;
      if (interruptState.interruptType === 'tool_diff_approval') {
        const actions = (interruptState.interruptData?.action_requests as Array<{ name?: string }>) ?? [];
        const result = await resumeInterrupt(threadId, {
          decisions: actions.map(() => ({ type: 'reject', message: userInput || t('interrupt.rejectDefault') })),
        });
        runId = result?.run_id;
        toast.info(t('interrupt.toast.rejected'));
      } else if (interruptState.interruptType === 'human_checkpoint') {
        const result = await resumeInterrupt(threadId, 'reject', userInput || t('interrupt.rejectDefault'));
        runId = result?.run_id;
        toast.info(t('interrupt.toast.rejectedShort'));
      } else if (interruptState.interruptType === 'plan_confirmation') {
        const result = await resumeInterrupt(threadId, 'reject', userInput || t('interrupt.planRejectDefault'));
        runId = result?.run_id;
        toast.info(t('interrupt.toast.planRejected'));
      } else {
        const result = await resumeInterrupt(threadId, false, userInput || t('interrupt.rejectDefault'));
        runId = result?.run_id;
        toast.info(t('interrupt.toast.rejectedOp'));
      }
      writeState({ hasInterrupt: false });
      setUserInput('');
      if (interruptState.interruptType === 'tool_diff_approval') setToolDiffDecisions([]);
      onResolved?.(runId ? { run_id: runId } : undefined);
    } catch (error) {
      toast.error(t('interrupt.toast.actionFailed'), {
        description: error instanceof Error ? error.message : t('interrupt.toast.unknownError'),
      });
    } finally {
      submittingRef.current = false;
      setIsLoading(false);
    }
  };

  // 人类检查点：请求修改意见后继续
  const handleRevise = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsLoading(true);
    try {
      const result = await resumeInterrupt(threadId, 'revise', userInput || t('interrupt.reviseDefault'));
      toast.info(t('interrupt.toast.revisionSubmitted'));
      writeState({ hasInterrupt: false });
      setUserInput('');
      onResolved?.(result?.run_id ? { run_id: result.run_id } : undefined);
    } catch (error) {
      toast.error(t('interrupt.toast.submitFailed'), {
        description: error instanceof Error ? error.message : t('interrupt.toast.unknownError'),
      });
    } finally {
      submittingRef.current = false;
      setIsLoading(false);
    }
  };

  const handleDelegate = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsLoading(true);
    try {
      const result = await resumeInterrupt(threadId, 'delegate', userInput || t('interrupt.delegateDefault'));
      toast.info(t('interrupt.toast.delegated'));
      writeState({ hasInterrupt: false });
      setUserInput('');
      onResolved?.(result?.run_id ? { run_id: result.run_id } : undefined);
    } catch (error) {
      toast.error(t('interrupt.toast.submitFailed'), {
        description: error instanceof Error ? error.message : t('interrupt.toast.unknownError'),
      });
    } finally {
      submittingRef.current = false;
      setIsLoading(false);
    }
  };

  const handleSkip = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsLoading(true);
    try {
      const result = await resumeInterrupt(threadId, 'skip', userInput || t('interrupt.skipDefault'));
      toast.info(t('interrupt.toast.skipped'));
      writeState({ hasInterrupt: false });
      setUserInput('');
      onResolved?.(result?.run_id ? { run_id: result.run_id } : undefined);
    } catch (error) {
      toast.error(t('interrupt.toast.submitFailed'), {
        description: error instanceof Error ? error.message : t('interrupt.toast.unknownError'),
      });
    } finally {
      submittingRef.current = false;
      setIsLoading(false);
    }
  };

  // 获取中断类型配置
  const typeConfig = interruptTypeConfig[interruptState.interruptType || 'default'] 
    || interruptTypeConfig.default;
  const TypeIcon = typeConfig.icon;
  const waitContextLabel = React.useMemo(() => {
    const type = interruptState.interruptType || "";
    const d = interruptState.interruptData;
    if (type === "plan_confirmation") return t("interrupt.wait.plan");
    if (type === "human_checkpoint") {
      const cp = d && typeof d === "object" && (d as { checkpoint_id?: string }).checkpoint_id;
      const step = d && typeof d === "object" && (d as { step_id?: string }).step_id;
      if (cp) return t("interrupt.wait.checkpoint", { id: String(cp) });
      if (step) return t("interrupt.wait.step", { id: String(step) });
      return t("interrupt.wait.human");
    }
    if (type === "tool_diff_approval") return t("interrupt.wait.tool_diff");
    if (type) return t("interrupt.wait.other", { type });
    return null;
  }, [interruptState.interruptType, interruptState.interruptData, t]);
  const optionSuggestions = React.useMemo(() => {
    const raw = interruptState.interruptData?.options;
    let list: string[] = [];
    if (Array.isArray(raw)) {
      list = raw.map((x) => String(x).trim()).filter(Boolean);
    } else if (typeof raw === 'string') {
      list = raw.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
    }
    const actionWords = new Set([
      'approve', 'reject', 'revise', 'confirm', 'cancel',
      'yes', 'no', 'true', 'false',
      '批准', '拒绝', '修改', '确认', '取消', '是', '否',
    ]);
    return list.filter((item) => !actionWords.has(item.toLowerCase()));
  }, [interruptState.interruptData]);
  const quickSuggestions = React.useMemo(() => {
    if (optionSuggestions.length > 0) return optionSuggestions.slice(0, 6);
    const type = interruptState.interruptType || 'default';
    if (type === 'human_checkpoint') return [t('interrupt.suggestion.human_1'), t('interrupt.suggestion.human_2'), t('interrupt.suggestion.human_3')];
    if (type === 'plan_confirmation') return [t('interrupt.suggestion.plan_1'), t('interrupt.suggestion.plan_2'), t('interrupt.suggestion.plan_3')];
    if (type === 'file_operation' || type === 'dangerous_action') return [t('interrupt.suggestion.file_1'), t('interrupt.suggestion.file_2'), t('interrupt.suggestion.file_3')];
    if (type === 'input_required') return [t('interrupt.suggestion.input_1'), t('interrupt.suggestion.input_2')];
    return [t('interrupt.suggestion.default_1'), t('interrupt.suggestion.default_2')];
  }, [interruptState.interruptType, optionSuggestions, t]);
  const applySuggestion = (text: string) => {
    setUserInput((prev) => {
      const base = prev.trim();
      if (!base) return text;
      if (base.includes(text)) return base;
      return `${base}\n${text}`;
    });
  };
  const confirmDisabled = isLoading || (interruptState.interruptType === 'input_required' && !userInput.trim());

  if (!interruptState.hasInterrupt) {
    return null;
  }

  const isInline = variant === 'inline';
  const showHintOnly = isInline && (interruptState.interruptType === 'plan_confirmation' || interruptState.interruptType === 'tool_diff_approval');

  // 聊天内确认：plan/tool_diff 仅在 Footer 展示简短提示，主操作在计划卡/工具卡内完成（会话内继续、不中断）
  if (showHintOnly) {
    const hintText = interruptState.interruptType === 'plan_confirmation'
      ? t('thread.waitingConfirmationPlan')
      : t('thread.waitingConfirmationTools');
    return (
      <div className={`w-full mb-2 rounded-lg border border-border/60 bg-muted/10 px-3 py-2 flex items-center gap-2 ${className}`}>
        <TypeIcon className={`w-4 h-4 shrink-0 ${typeConfig.color}`} />
        <p className="text-xs text-muted-foreground flex-1">
          {t('thread.waitingConfirmation')} {hintText}
        </p>
      </div>
    );
  }

  const wrapperClass = isInline
    ? `w-full mb-2 ${className}`.trim()
    : `fixed bottom-20 right-4 z-[var(--z-dialog)] w-96 ${className}`.trim();

  // Cursor/Claude 风格：inline 时卡片更简洁，不展示技术型 Badge
  const cardClass = isInline
    ? `rounded-xl border border-border/80 bg-card shadow-sm ${typeConfig.bgColor}`
    : `rounded-lg border border-border shadow-lg bg-background ${typeConfig.bgColor}`;
  const headerPadding = isInline ? 'px-3 py-2.5' : 'p-4';

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: isInline ? 8 : 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: isInline ? 8 : 20 }}
        className={wrapperClass}
      >
        <div className={cardClass}>
          {/* 头部：inline 时更紧凑 */}
          <div className={`${headerPadding} border-b border-border/60 flex items-center gap-3`}>
            <div className={`shrink-0 p-1.5 rounded-lg ${typeConfig.bgColor}`}>
              <TypeIcon className={`w-4 h-4 ${typeConfig.color}`} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className={`text-sm font-medium ${typeConfig.color}`}>
                {t('interrupt.title.' + (interruptState.interruptType || 'default'))}
              </h3>
              {waitContextLabel && (
                <p className="text-xs text-muted-foreground mt-0.5 truncate">{waitContextLabel}</p>
              )}
              {!isInline && (
                <Badge variant="outline" className="text-xs mt-1">
                  {interruptState.interruptType || 'interrupt'}
                </Badge>
              )}
            </div>
            {isChecking && (
              <Loader2 className="w-4 h-4 shrink-0 animate-spin text-muted-foreground" />
            )}
          </div>

          {/* 内容：inline 时略紧凑 */}
          <div className={isInline ? 'p-3' : 'p-4'}>
            {/* 人类检查点：摘要 + 上下文 */}
            {(interruptState.interruptType === 'human_checkpoint' || interruptState.interruptType === 'plan_confirmation') && interruptState.interruptData && (
              <>
                <div className="mb-3 p-3 bg-muted/30 rounded-lg text-sm">
                  <p className="text-xs text-muted-foreground mb-1">{t('interrupt.sectionSummary')}</p>
                  <p className="whitespace-pre-wrap">
                    {(interruptState.interruptData.summary as string) || '—'}
                  </p>
                </div>
                {(interruptState.interruptData.context as string) && (
                  <div className="mb-3 p-3 bg-muted/20 rounded-lg text-xs overflow-auto max-h-28">
                    <p className="text-muted-foreground mb-1">{t('interrupt.sectionContext')}</p>
                    <pre className="whitespace-pre-wrap font-sans">
                      {String(interruptState.interruptData.context)}
                    </pre>
                  </div>
                )}
              </>
            )}

            {/* 工具执行确认（diff + 接受/拒绝）：同一会话内连续动作，确认后继续执行，不会因确认而中断会话 */}
            {interruptState.interruptType === 'tool_diff_approval' &&
              Array.isArray(interruptState.interruptData?.action_requests) && (
                <div className="mb-4 space-y-3">
                  <p className="text-[11px] text-muted-foreground mb-2">
                    {t('interrupt.toolDiffHint')}
                  </p>
                  {(() => {
                    const action_requestsList = (interruptState.interruptData?.action_requests as Array<{
                      name?: string;
                      args?: Record<string, unknown>;
                      diff?: { original?: string; modified?: string; path?: string; preview?: string };
                    }>) ?? [];
                    return action_requestsList.map((action, idx) => {
                    const rawName = action.name ?? 'tool';
                    const toolLabel = ({ write_file: t('interrupt.tool.write_file'), edit_file: t('interrupt.tool.edit_file'), delete_file: t('interrupt.tool.delete_file'), write_file_binary: t('interrupt.tool.write_file_binary'), shell_run: t('interrupt.tool.shell_run'), python_run: t('interrupt.tool.python_run') } as Record<string, string>)[rawName] ?? rawName;
                    const d = action.diff;
                    const setDecision = (choice: 'approve' | 'reject') => {
                      setToolDiffDecisions(prev => {
                        const next = [...(prev.length ? prev : Array(action_requestsList.length).fill(undefined))];
                        next[idx] = choice;
                        return next;
                      });
                    };
                    return (
                      <div key={idx} className="rounded-lg border border-border/50 bg-muted/20 p-3">
                        <p className="text-xs font-medium text-muted-foreground mb-2">
                          {toolLabel}
                          {d?.path ? ` · ${d.path}` : ''}
                          {toolDiffDecisions[idx] != null && (
                            <span className="ml-2 text-[11px] text-muted-foreground/80">
                              ({toolDiffDecisions[idx] === 'approve' ? t('interrupt.btnAccept') : t('interrupt.btnReject')})
                            </span>
                          )}
                        </p>
                        {d?.original !== undefined && d?.modified !== undefined ? (
                          <InlineDiffView
                            original={d.original}
                            modified={d.modified}
                            filePath={d.path}
                            maxLines={12}
                            onAccept={() => setDecision('approve')}
                            onReject={() => setDecision('reject')}
                          />
                        ) : d?.preview ? (
                          <>
                            <p className="text-sm text-muted-foreground">{d.preview}</p>
                            <div className="mt-2 flex gap-1.5 flex-wrap items-center">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="text-[11px] text-green-700 dark:text-green-400 border-green-500/30"
                                onClick={() => setDecision('approve')}
                              >
                                {t('interrupt.btnAccept')}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="text-[11px] text-red-700 dark:text-red-400 border-red-500/30"
                                onClick={() => setDecision('reject')}
                              >
                                {t('interrupt.btnReject')}
                              </Button>
                              {rawName === 'write_file_binary' && typeof action.args?.file_path === 'string' && typeof action.args?.content === 'string' && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="text-[11px] text-primary"
                                  onClick={() => {
                                    window.dispatchEvent(new CustomEvent(EVENTS.OPEN_BINARY_DIFF, {
                                      detail: { targetPath: action.args?.file_path, newBase64: action.args?.content },
                                    }));
                                  }}
                                >
                                  {t('editor.binaryDiffOpenInEditor')}
                                </Button>
                              )}
                            </div>
                          </>
                        ) : (
                          <>
                            <pre className="text-xs overflow-auto max-h-24 bg-muted/30 p-2 rounded">
                              {JSON.stringify(action.args ?? {}, null, 2)}
                            </pre>
                            <div className="mt-2 flex gap-1.5">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="text-[11px] text-green-700 dark:text-green-400 border-green-500/30"
                                onClick={() => setDecision('approve')}
                              >
                                {t('interrupt.btnAccept')}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="text-[11px] text-red-700 dark:text-red-400 border-red-500/30"
                                onClick={() => setDecision('reject')}
                              >
                                {t('interrupt.btnReject')}
                              </Button>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  });
                  })()}
                </div>
            )}

            {/* 通用中断消息 */}
            {interruptState.interruptType !== 'human_checkpoint' &&
              interruptState.interruptType !== 'plan_confirmation' &&
              interruptState.interruptType !== 'tool_diff_approval' &&
              interruptState.interruptMessage && (
                <div className="mb-4 p-3 bg-muted/30 rounded-lg text-sm">
                  {interruptState.interruptMessage}
                </div>
              )}

            {/* 非检查点：原始中断数据（非 tool_diff_approval） */}
            {interruptState.interruptType !== 'human_checkpoint' &&
              interruptState.interruptType !== 'plan_confirmation' &&
              interruptState.interruptType !== 'tool_diff_approval' &&
              interruptState.interruptData &&
              Object.keys(interruptState.interruptData).length > 0 && (
                <div className="mb-4 p-3 bg-muted/30 rounded-lg">
                  <p className="text-xs text-muted-foreground mb-2">{t('interrupt.details')}</p>
                  <pre className="text-xs overflow-auto max-h-32">
                    {JSON.stringify(interruptState.interruptData, null, 2)}
                  </pre>
                </div>
              )}

            {/* Cursor 风格：可选建议 + 可编辑输入（工具审批时可填拒绝说明） */}
            {interruptState.interruptType !== 'tool_diff_approval' && (
              <div className="mb-4 space-y-2">
                <div className="text-xs text-muted-foreground">{t('interrupt.quickSuggestions')}</div>
                <div className="flex flex-wrap gap-1.5">
                  {quickSuggestions.map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => applySuggestion(item)}
                      className="rounded-md border border-border/50 bg-muted/20 px-2 py-1 text-[11px] text-muted-foreground hover:text-primary hover:border-primary/40 hover:bg-primary/5 transition-colors"
                    >
                      {item}
                    </button>
                  ))}
                </div>
                <Textarea
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !confirmDisabled) {
                      e.preventDefault();
                      void handleConfirm();
                    }
                  }}
                  placeholder={
                    interruptState.interruptType === 'input_required'
                      ? t('interrupt.placeholderRequired')
                      : t('interrupt.placeholderOptional')
                  }
                  className="mb-0"
                  rows={3}
                />
              </div>
            )}
            {interruptState.interruptType === 'tool_diff_approval' && (
              <div className="mb-3">
                <Textarea
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  placeholder={t('interrupt.placeholderReject')}
                  className="text-sm"
                  rows={1}
                />
              </div>
            )}

            {/* 操作按钮：显式 type="button" 避免在表单上下文中误提交 */}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1 min-w-[80px] text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                onClick={handleReject}
                disabled={isLoading}
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : (
                  <XCircle className="w-4 h-4 mr-2" />
                )}
                {t('interrupt.btnReject')}
              </Button>
              {(interruptState.interruptType === 'plan_confirmation' ||
                (interruptState.interruptType === 'human_checkpoint' &&
                  (Array.isArray(interruptState.interruptData?.options)
                    ? (interruptState.interruptData?.options as string[]).includes('revise')
                    : true))) && (
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1 min-w-[80px]"
                  onClick={handleRevise}
                  disabled={isLoading}
                >
                  {t('interrupt.btnRevise')}
                </Button>
              )}
              {interruptState.interruptType === 'human_checkpoint' &&
                Array.isArray(interruptState.interruptData?.options) &&
                (interruptState.interruptData?.options as string[]).includes('delegate') && (
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1 min-w-[80px]"
                    onClick={handleDelegate}
                    disabled={isLoading}
                  >
                    {t('interrupt.btnDelegate')}
                  </Button>
                )}
              {interruptState.interruptType === 'human_checkpoint' &&
                Array.isArray(interruptState.interruptData?.options) &&
                (interruptState.interruptData?.options as string[]).includes('skip') && (
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1 min-w-[80px]"
                    onClick={handleSkip}
                    disabled={isLoading}
                  >
                    {t('interrupt.btnSkip')}
                  </Button>
                )}
              <Button
                type="button"
                className="flex-1 min-w-[80px]"
                onClick={handleConfirm}
                disabled={confirmDisabled}
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : (
                  <CheckCircle className="w-4 h-4 mr-2" />
                )}
                {interruptState.interruptType === 'human_checkpoint'
                  ? t('interrupt.btnApprove')
                  : interruptState.interruptType === 'plan_confirmation'
                    ? t('interrupt.btnConfirmExecute')
                    : interruptState.interruptType === 'tool_diff_approval'
                      ? t('interrupt.btnAccept')
                      : interruptState.interruptType === 'input_required'
                        ? t('interrupt.btnSubmitInput')
                        : t('interrupt.btnConfirm')}
              </Button>
            </div>
            {!isLoading && (
              <div className="mt-2 text-[11px] text-muted-foreground/70">
                {confirmDisabled ? t('interrupt.hintConfirmRequired') : t('interrupt.hintShortcutConfirm')}
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
};

export default InterruptDialog;
