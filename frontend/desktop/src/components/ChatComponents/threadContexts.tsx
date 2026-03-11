"use client";

import React from "react";
import type { ChatMode } from "./cursor-style-composer";

export const ChatModeContext = React.createContext<{
  mode: ChatMode;
  setMode: (mode: ChatMode) => void;
}>({
  mode: "agent",
  setMode: () => {},
});

export const TurnModeContext = React.createContext<ChatMode | null>(null);
