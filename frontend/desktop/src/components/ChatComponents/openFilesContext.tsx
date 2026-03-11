"use client";

import React from "react";

/** 供 Composer @ 文件 mention 使用：候选文件 = 当前打开的文件（优先） + 工作区内的文件列表，去重后限制条数；由 MyRuntimeProvider 提供。 */
export const OpenFilesContext = React.createContext<Array<{ path: string; name: string }>>([]);
