"use client";

import React from "react";
import { getThreadState, isThreadNotFoundError, isValidServerThreadId } from "../../lib/api/langserveChat";
import { setScopedActiveRoleIdInStorage } from "../../lib/roleIdentity";
import { setScopedChatMode } from "../../lib/chatModeState";
import { normalizeToolCallsInMessages } from "../../lib/utils/normalizeToolCalls";
import { normalizeLangChainMessages } from "../../lib/utils/normalizeLangChainMessages";
import type { LangChainMessage } from "@assistant-ui/react-langgraph";

export type ThreadState = Awaited<ReturnType<typeof getThreadState>>;

export interface UseThreadStateLoaderDeps {
  activateThread: (threadId: string, title?: string) => void;
  createAndActivateThread: (firstContent?: string, workspacePath?: string) => Promise<string>;
  resolveThreadTitle: (state: ThreadState | undefined, threadId: string) => string;
  /** 若提供，则在调用 activateThread 前校验：仅当返回值 === externalId 时才激活，避免快速切换会话时旧 load 覆盖当前线程 */
  getLatestRequestedThreadId?: () => string | null;
}

export function useThreadStateLoader(deps: UseThreadStateLoaderDeps) {
  const { activateThread, createAndActivateThread, resolveThreadTitle, getLatestRequestedThreadId } = deps;

  const loadThreadState = React.useCallback(
    async (externalId: string) => {
      // 非服务端 UUID 时直接创建新线程，避免激活无效 ID 导致后续发送报错
      if (!isValidServerThreadId(externalId)) {
        let newThreadId: string;
        try {
          newThreadId = await createAndActivateThread();
        } catch (createErr) {
          throw createErr;
        }
        return { messages: [] as LangChainMessage[], interrupts: [], createdThreadId: newThreadId };
      }
      let state: ThreadState;
      try {
        state = await getThreadState(externalId);
      } catch (error) {
        if (!isThreadNotFoundError(error)) throw error;
        let newThreadId: string;
        try {
          newThreadId = await createAndActivateThread();
        } catch (createErr) {
          throw createErr;
        }
        return { messages: [] as LangChainMessage[], interrupts: [], createdThreadId: newThreadId };
      }
      const values = state.values as { messages?: unknown } | undefined;
      const rawMessages = Array.isArray(values?.messages) ? values.messages : [];
      const toolNormalized = normalizeToolCallsInMessages(
        rawMessages as { tool_calls?: Array<{ id?: string; name?: string | null }> }[]
      );
      const messages = normalizeLangChainMessages(toolNormalized) as LangChainMessage[];
      if (getLatestRequestedThreadId && getLatestRequestedThreadId() !== externalId) {
        if (import.meta.env?.DEV) console.warn("[useThreadStateLoader] 跳过过期加载，当前已请求其他会话", { loadedId: externalId.slice(0, 8) });
        return { messages, interrupts: state.tasks?.[0]?.interrupts ?? [], __stale: true as const };
      }
      const threadTitle = resolveThreadTitle(state, externalId);
      try {
        const metadata = (state?.metadata as Record<string, unknown> | undefined) || {};
        const rawRoleId = metadata.active_role_id ?? metadata.role_id;
        const metadataRoleId = (typeof rawRoleId === "string" ? rawRoleId : "").trim();
        if (metadataRoleId) {
          setScopedActiveRoleIdInStorage(metadataRoleId, externalId);
        }
        const rawMode = metadata.mode;
        const metadataMode = (typeof rawMode === "string" ? rawMode : "").trim().toLowerCase();
        if (
          metadataMode === "agent" ||
          metadataMode === "plan" ||
          metadataMode === "ask" ||
          metadataMode === "debug" ||
          metadataMode === "review"
        ) {
          setScopedChatMode(metadataMode, externalId);
        }
      } catch (metaErr) {
        console.warn("[useThreadStateLoader] metadata parsing failed, role/mode not restored:", metaErr);
      }
      activateThread(externalId, threadTitle);
      return {
        messages,
        interrupts: state.tasks?.[0]?.interrupts ?? [],
      };
    },
    [activateThread, createAndActivateThread, resolveThreadTitle, getLatestRequestedThreadId]
  );

  return { loadThreadState };
}
