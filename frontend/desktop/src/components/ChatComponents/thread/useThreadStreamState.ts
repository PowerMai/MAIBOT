import React, { useState, useMemo, useEffect, useRef } from "react";
import { validServerThreadIdOrUndefined } from "../../../lib/api/langserveChat";
import { toolStreamEventBus, getCurrentRunReasoning, CURRENT_RUN_REASONING_UPDATED } from "../../../lib/events/toolStreamEvents";
import { EVENTS } from "../../../lib/constants";

export const SUBAGENT_LABELS: Record<string, string> = {
  "explore-agent": "正在探索文件…",
  "bash-agent": "正在执行命令…",
  "browser-agent": "正在操作浏览器…",
  "general-purpose": "正在执行多步任务…",
};

export type AgentPhase = "thinking" | "explore" | "general" | null;

export function useAgentProgress(
  isRunning: boolean,
  tr: (key: string) => string = (k) => k
): { phase: AgentPhase; label: string; summary: string } {
  const phaseLabels: Record<string, string> = useMemo(
    () => ({
      prepare: tr("status.preparing"),
      build_ready: tr("status.starting"),
      stream_open: tr("status.waitingResponse"),
      first_visible_wait: tr("status.thinkingEllipsis"),
      first_token: tr("status.generatingEllipsis"),
    }),
    [tr]
  );
  const [phase, setPhase] = useState<AgentPhase>(null);
  const [label, setLabel] = useState("");
  const [summary, setSummary] = useState("");
  useEffect(() => {
    if (!isRunning) {
      setPhase(null);
      setLabel("");
      setSummary("");
      return;
    }
    type Ev = {
      type?: string;
      status?: string;
      phase?: string;
      subagent_type?: string;
      message?: string;
      data?: { message?: string; phase?: string; subagent_type?: string; summary?: string; step?: string };
    };
    const onReasoning = (ev: Ev) => {
      const phaseVal = ev.data?.phase ?? ev.phase;
      if (phaseVal === "start") {
        setPhase("thinking");
        setLabel(tr("status.thinking"));
      } else if (phaseVal === "end") {
        setPhase(null);
        setLabel("");
      }
    };
    const onSubagentStart = (ev: Ev) => {
      if (ev.data?.subagent_type) {
        const st = ev.data.subagent_type;
        const key = st as keyof typeof SUBAGENT_LABELS;
        const phaseMap: Record<string, AgentPhase> = {
          "explore-agent": "explore",
          "general-purpose": "general",
        };
        setPhase(phaseMap[st] ?? "general");
        setLabel(SUBAGENT_LABELS[key] ?? tr("status.executingToolEllipsis"));
      }
    };
    const onSubagentEnd = (ev: Ev) => {
      setPhase(null);
      setLabel("");
      const s = (ev as { data?: { summary?: string } }).data?.summary;
      if (s) setSummary(String(s).slice(0, 150));
    };
    const onTaskProgress = (ev: Ev) => {
      const msg = ev.message ?? ev.data?.message;
      const phaseVal = String(ev.phase ?? ev.data?.phase ?? "").toLowerCase();
      if (phaseVal === "tool_call") {
        setPhase("thinking");
        const stepLabel = ev.data?.step ?? (ev as { step?: string }).step ?? msg;
        setLabel(stepLabel ?? tr("status.executingToolEllipsis"));
        return;
      }
      const mapped = phaseLabels[phaseVal];
      if (mapped) {
        setPhase("thinking");
        setLabel(mapped);
      } else if (msg) {
        setLabel(msg);
      }
    };
    const unsubReasoning = toolStreamEventBus.on("reasoning", onReasoning as (e: unknown) => void);
    const unsubSubagentStart = toolStreamEventBus.on("subagent_start", onSubagentStart as (e: unknown) => void);
    const unsubSubagentEnd = toolStreamEventBus.on("subagent_end", onSubagentEnd as (e: unknown) => void);
    const unsubTaskProgress = toolStreamEventBus.on(EVENTS.TASK_PROGRESS, onTaskProgress as (e: unknown) => void);
    return () => {
      unsubReasoning();
      unsubSubagentStart();
      unsubSubagentEnd();
      unsubTaskProgress();
    };
  }, [isRunning, tr, phaseLabels]);
  return { phase, label, summary };
}

export function useNativeReasoningBlocks(
  messageId: string | undefined,
  isRunning: boolean,
  threadId?: string
): { blocks: string[]; tokenCount: number } {
  const [reasoningText, setReasoningText] = useState<string>("");
  const [currentRunText, setCurrentRunText] = useState<string>("");
  const lastChunkRef = useRef<string>("");
  const pendingRef = useRef<string>("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 当前 run 思考流（Cursor 式）：仅用服务端 UUID 作 key，与 MyRuntimeProvider 写入一致，避免占位 id 导致读不到内容
  const effectiveThreadId = validServerThreadIdOrUndefined(threadId);
  const pendingReasoningRef = useRef<{ threadId: string; content: string } | null>(null);
  const rafIdRef = useRef<number>(0);
  useEffect(() => {
    if (!effectiveThreadId) {
      setCurrentRunText("");
      return () => {};
    }
    setCurrentRunText(getCurrentRunReasoning(effectiveThreadId));
    const flush = () => {
      rafIdRef.current = 0;
      const p = pendingReasoningRef.current;
      if (p && p.threadId === effectiveThreadId) setCurrentRunText(p.content);
      pendingReasoningRef.current = null;
    };
    const handler = (e: Event) => {
      const d = (e as CustomEvent<{ threadId?: string; content?: string }>).detail;
      if (d?.threadId !== effectiveThreadId) return;
      pendingReasoningRef.current = { threadId: d.threadId!, content: String(d?.content ?? "") };
      if (rafIdRef.current) return;
      rafIdRef.current = requestAnimationFrame(flush);
    };
    window.addEventListener(CURRENT_RUN_REASONING_UPDATED, handler);
    return () => {
      window.removeEventListener(CURRENT_RUN_REASONING_UPDATED, handler);
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = 0;
      pendingReasoningRef.current = null;
    };
  }, [isRunning, effectiveThreadId]);

  useEffect(() => {
    setReasoningText("");
    if (!messageId) {
      lastChunkRef.current = "";
      pendingRef.current = "";
      return;
    }
    let active = true;
    const flush = () => {
      if (pendingRef.current && active) {
        const batch = pendingRef.current;
        pendingRef.current = "";
        setReasoningText((prev) => `${prev}${batch}`);
      }
      flushTimerRef.current = null;
    };
    const handler = (ev: {
      type?: string;
      msg_id?: string;
      content?: string;
      phase?: string;
      data?: { msg_id?: string; content?: string; phase?: string };
    }) => {
      const phase = ev.data?.phase ?? ev.phase;
      if ((phase || "").toLowerCase() !== "content") return;
      const targetMsgId = ev.data?.msg_id ?? ev.msg_id;
      const text = String((ev.data?.content ?? ev.content) || "");
      if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV && text.length > 0) {
        const match = Boolean(!targetMsgId || targetMsgId === messageId);
        console.log("[useNativeReasoningBlocks] reasoning content", {
          targetMsgId,
          messageId,
          match,
          contentLen: text.length,
        });
      }
      if (messageId && targetMsgId && targetMsgId !== messageId && !isRunning) return;
      if (!text) return;
      if (text === lastChunkRef.current) return;
      lastChunkRef.current = text;
      pendingRef.current += text;
      if (!flushTimerRef.current) {
        flushTimerRef.current = setTimeout(flush, 80);
      }
    };
    const unsub = toolStreamEventBus.on("reasoning", handler as (e: unknown) => void);
    return () => {
      active = false;
      unsub();
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      pendingRef.current = "";
    };
  }, [messageId, isRunning]);
  const prevIsRunningRef = useRef<boolean>(false);
  useEffect(() => {
    const justStarted = isRunning && !prevIsRunningRef.current;
    prevIsRunningRef.current = isRunning;
    if (justStarted) {
      setReasoningText("");
      lastChunkRef.current = "";
      pendingRef.current = "";
    }
  }, [isRunning]);

  /** run 结束后仍展示已保留的思考内容（不清空），与 Cursor 一致 */
  const effectiveText = effectiveThreadId && currentRunText.length > 0 ? currentRunText : reasoningText;
  const loggedReasoningRef = useRef(false);
  useEffect(() => {
    if (!isRunning) {
      loggedReasoningRef.current = false;
      return;
    }
    if (!(import.meta as { env?: { DEV?: boolean } }).env?.DEV || !effectiveText.length) return;
    if (loggedReasoningRef.current) return;
    loggedReasoningRef.current = true;
    const source = isRunning && effectiveThreadId && currentRunText.length > 0 ? 'currentRun' : 'reasoningText';
    console.log('[useNativeReasoningBlocks] effectiveText 首次有效', { source, messageId: messageId?.slice(0, 8), threadId: effectiveThreadId?.slice(0, 8), len: effectiveText.length });
  }, [effectiveText.length, isRunning, messageId, effectiveThreadId, currentRunText.length]);
  const tokenCount = useMemo(() => {
    if (!effectiveText) return 0;
    return Math.max(1, Math.round(effectiveText.length / 2.6));
  }, [effectiveText]);

  const blocks = useMemo(() => (effectiveText ? [effectiveText] : []), [effectiveText]);

  return { blocks, tokenCount };
}
