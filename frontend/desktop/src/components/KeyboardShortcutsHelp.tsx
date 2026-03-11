"use client";

import React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { DefaultShortcuts, getShortcutText } from "../lib/hooks/useKeyboardShortcuts";

type ShortcutDef = { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean; description: string };

const GROUPS: { label: string; keys: (keyof typeof DefaultShortcuts)[] }[] = [
  { label: "文件", keys: ["SAVE", "SAVE_ALL", "OPEN", "CLOSE_TAB", "NEW_FILE"] },
  { label: "编辑", keys: ["UNDO", "REDO", "CUT", "COPY", "PASTE", "SELECT_ALL", "FIND", "REPLACE"] },
  { label: "视图", keys: ["TOGGLE_SIDEBAR", "TOGGLE_TERMINAL", "ZOOM_IN", "ZOOM_OUT", "RESET_ZOOM"] },
  { label: "导航", keys: ["GO_TO_LINE", "GO_TO_FILE", "COMMAND_PALETTE"] },
  { label: "AI 对话", keys: ["NEW_CHAT", "FOCUS_CHAT", "SEND_MESSAGE", "STOP_GENERATION"] },
  { label: "设置", keys: ["OPEN_SETTINGS"] },
];

/** Composer 内生效的聊天模式快捷键（焦点在输入框时） */
const CHAT_MODE_SHORTCUTS: { description: string; keys: string }[] = [
  { description: "Agent 模式", keys: "⌘1" },
  { description: "Ask 模式", keys: "⌘2" },
  { description: "Plan 模式", keys: "⌘3" },
  { description: "Debug / Review（按角色）", keys: "⌘4" },
  { description: "添加上下文", keys: "⌘/" },
];

export interface KeyboardShortcutsHelpProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function KeyboardShortcutsHelp({ open, onOpenChange }: KeyboardShortcutsHelpProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">键盘快捷键</DialogTitle>
        </DialogHeader>
        <p className="text-[11px] text-muted-foreground mb-3">
          按 <kbd className="px-1 py-0.5 rounded bg-muted border border-border/50 font-mono">?</kbd> 可随时打开此帮助（焦点不在输入框时）。聊天模式快捷键需焦点在对话输入框内生效。
        </p>
        <div className="overflow-y-auto pr-1 -mr-1 space-y-4">
          {GROUPS.map((group) => {
            const items = group.keys
              .map((k) => {
                const s = DefaultShortcuts[k] as ShortcutDef | undefined;
                if (!s) return null;
                return { key: k, ...s };
              })
              .filter(Boolean) as (ShortcutDef & { key: string })[];
            if (items.length === 0) return null;
            return (
              <div key={group.label}>
                <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
                  {group.label}
                </p>
                <ul className="space-y-1">
                  {items.map((item) => (
                    <li
                      key={item.key}
                      className="flex items-center justify-between gap-4 py-1.5 px-2 rounded hover:bg-muted/50 text-xs"
                    >
                      <span className="text-foreground/90">{item.description}</span>
                      <kbd className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-muted border border-border/50 font-mono tabular-nums">
                        {getShortcutText(item)}
                      </kbd>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <div>
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
              聊天模式（焦点在输入框时）
            </p>
            <ul className="space-y-1">
              {CHAT_MODE_SHORTCUTS.map((item) => (
                <li
                  key={item.description}
                  className="flex items-center justify-between gap-4 py-1.5 px-2 rounded hover:bg-muted/50 text-xs"
                >
                  <span className="text-foreground/90">{item.description}</span>
                  <kbd className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-muted border border-border/50 font-mono tabular-nums">
                    {item.keys}
                  </kbd>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
