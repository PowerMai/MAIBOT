/**
 * InterruptDialogGuard - 当当前线程存在未完成的 ask_user 工具调用时不展示 InterruptDialog，
 * 避免同一轮对话出现“聊天区内联 Ask + 弹窗”双入口。须在 MyRuntimeProvider 内使用以便 useThread 可用。
 * 聊天区调用时必须传 variant="inline"，保证中断在聊天区域内展示、不使用弹窗。
 */

import React from "react";
import { useThread } from "@assistant-ui/react";
import { InterruptDialog } from "./InterruptDialog";

function hasPendingAskUserInMessages(messages: unknown[]): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; type?: string; content?: unknown[] } | null;
    if (!m || (m.role !== "assistant" && m.type !== "ai")) continue;
    const c = m.content;
    if (!Array.isArray(c)) continue;
    for (const p of c) {
      const part = p as {
        type?: string;
        toolCall?: { name?: string };
        toolName?: string;
        name?: string;
        status?: { type?: string };
        result?: unknown;
      };
      if (part.type !== "tool-call") continue;
      const name = part.toolName ?? part.name ?? part.toolCall?.name;
      if (name !== "ask_user") continue;
      const statusType = part.status?.type;
      const hasResult = part.result != null && part.result !== "";
      if (statusType === "running" || (!hasResult && statusType !== "complete")) {
        return true;
      }
    }
    break;
  }
  return false;
}

interface InterruptDialogGuardProps {
  threadId: string;
  /** 确认/拒绝后回调；若 resume 返回 run_id 则传入，便于父级接流续显（同一会话内连续） */
  onResolved?: (result?: { run_id?: string }) => void;
  /** 内联：在聊天区 footer 内渲染（聊天场景必须用此值）；弹窗：右下角浮动，非聊天场景 fallback */
  variant?: 'inline' | 'popup';
}

export const InterruptDialogGuard: React.FC<InterruptDialogGuardProps> = ({ threadId, onResolved, variant = 'popup' }) => {
  const messages = useThread((s) => s.messages ?? []);
  const hasPendingAskUser = React.useMemo(
    () => hasPendingAskUserInMessages(Array.isArray(messages) ? messages : []),
    [messages]
  );
  if (hasPendingAskUser) return null;
  if (!threadId || !String(threadId).trim()) return null;
  return <InterruptDialog threadId={threadId} onResolved={onResolved} variant={variant} />;
};
