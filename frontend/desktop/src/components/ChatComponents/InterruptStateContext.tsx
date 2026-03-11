"use client";

import React from "react";

/** 等待确认状态（HITL）：供工具卡与 Footer 统一展示「会话内确认」，不中断会话 */
export type InterruptState = {
  hasInterrupt: boolean;
  interruptType?: string;
  interruptMessage?: string;
  interruptData?: Record<string, unknown>;
};

export type InterruptStateContextValue = {
  state: InterruptState;
  setState: React.Dispatch<React.SetStateAction<InterruptState>> | null;
};

export const InterruptStateContext = React.createContext<InterruptStateContextValue>({
  state: { hasInterrupt: false },
  setState: null,
});
