"use client";

import React from "react";

/**
 * 取消运行上下文（独立文件以保持 MyRuntimeProvider 仅导出组件，避免 Vite Fast Refresh 警告）
 */
export const CancelContext = React.createContext<{
  cancelRun: () => Promise<void>;
  threadId: string | null;
}>({
  cancelRun: async () => {},
  threadId: null,
});
