/**
 * 键盘快捷键 Hook
 * 
 * 提供全局和局部键盘快捷键支持
 */

import { useEffect, useCallback, useRef } from 'react';

const monacoSuggestKeys = new Set(['Tab', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown']);

// 快捷键定义
export interface KeyboardShortcut {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean; // Command on Mac
  description: string;
  action: () => void;
  enabled?: boolean;
}

// 预定义的快捷键
export const DefaultShortcuts = {
  // 文件操作
  SAVE: { key: 's', ctrl: true, description: '保存文件' },
  SAVE_ALL: { key: 's', ctrl: true, shift: true, description: '保存所有文件' },
  OPEN: { key: 'o', ctrl: true, description: '打开文件' },
  CLOSE_TAB: { key: 'w', ctrl: true, description: '关闭标签页' },
  NEW_FILE: { key: 'n', ctrl: true, description: '新建文件' },
  
  // 编辑操作
  UNDO: { key: 'z', ctrl: true, description: '撤销' },
  REDO: { key: 'z', ctrl: true, shift: true, description: '重做' },
  CUT: { key: 'x', ctrl: true, description: '剪切' },
  COPY: { key: 'c', ctrl: true, description: '复制' },
  PASTE: { key: 'v', ctrl: true, description: '粘贴' },
  SELECT_ALL: { key: 'a', ctrl: true, description: '全选' },
  FIND: { key: 'f', ctrl: true, description: '查找' },
  REPLACE: { key: 'h', ctrl: true, description: '替换' },
  
  // 视图操作
  TOGGLE_SIDEBAR: { key: 'b', ctrl: true, description: '切换侧边栏' },
  TOGGLE_TERMINAL: { key: '`', ctrl: true, description: '切换终端' },
  ZOOM_IN: { key: '=', ctrl: true, description: '放大' },
  ZOOM_OUT: { key: '-', ctrl: true, description: '缩小' },
  RESET_ZOOM: { key: '0', ctrl: true, description: '重置缩放' },
  
  // 导航
  GO_TO_LINE: { key: 'g', ctrl: true, description: '跳转到行' },
  GO_TO_FILE: { key: 'p', ctrl: true, description: '快速打开文件' },
  COMMAND_PALETTE: { key: 'p', ctrl: true, shift: true, description: '命令面板' },
  
  // 对话
  NEW_CHAT: { key: 'o', ctrl: true, shift: true, description: '新建对话' },
  FOCUS_CHAT: { key: 'l', ctrl: true, description: '聚焦到对话输入' },
  SEND_MESSAGE: { key: 'Enter', ctrl: true, description: '发送消息' },
  STOP_GENERATION: { key: 'Escape', description: '停止生成' },
  
  // 设置
  OPEN_SETTINGS: { key: ',', ctrl: true, description: '打开设置' },
};

/**
 * 检查事件是否匹配快捷键
 */
function matchesShortcut(event: KeyboardEvent, shortcut: KeyboardShortcut): boolean {
  const { key, ctrl, shift, alt, meta } = shortcut;
  
  // 检查修饰键
  const ctrlMatch = ctrl ? (event.ctrlKey || event.metaKey) : (!event.ctrlKey && !event.metaKey);
  const shiftMatch = shift ? event.shiftKey : !event.shiftKey;
  const altMatch = alt ? event.altKey : !event.altKey;
  const metaMatch = meta ? event.metaKey : true; // meta 是可选的
  
  // 检查主键
  const keyMatch = event.key.toLowerCase() === key.toLowerCase();
  
  return keyMatch && ctrlMatch && shiftMatch && altMatch && metaMatch;
}

/**
 * 使用键盘快捷键
 */
export function useKeyboardShortcuts(
  shortcuts: KeyboardShortcut[],
  options?: {
    enabled?: boolean;
    preventDefault?: boolean;
    stopPropagation?: boolean;
  }
) {
  const { enabled = true, preventDefault = true, stopPropagation = false } = options || {};
  const shortcutsRef = useRef(shortcuts);
  
  // 更新 ref 以避免重新注册事件
  useEffect(() => {
    shortcutsRef.current = shortcuts;
  }, [shortcuts]);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (!enabled) return;
    if (event.isComposing || event.key === 'Process') return;
    
    // 忽略在输入框中的快捷键（除非是特定的快捷键）
    const target = event.target as HTMLElement;
    const targetInMonaco = !!target.closest?.('.monaco-editor, .suggest-widget, .monaco-list');
    if (monacoSuggestKeys.has(event.key)) {
      // Monaco 补全浮窗激活时，优先交给 Monaco 处理导航/接受候选
      const suggestWidgetVisible = !!document.querySelector(
        '.monaco-editor.focused .suggest-widget.visible, .monaco-editor:focus-within .suggest-widget.visible'
      );
      const monacoFocused = !!document.activeElement?.closest?.('.monaco-editor');
      if (suggestWidgetVisible && (targetInMonaco || monacoFocused)) return;
    }
    const isInputElement = 
      target.tagName === 'INPUT' || 
      target.tagName === 'TEXTAREA' || 
      target.isContentEditable;
    
    for (const shortcut of shortcutsRef.current) {
      if (shortcut.enabled === false) continue;
      
      if (matchesShortcut(event, shortcut)) {
        // 某些快捷键在输入框中也应该工作
        const allowInInput = ['Escape', 'Enter'].includes(shortcut.key) || 
                            shortcut.ctrl || shortcut.meta;
        
        if (isInputElement && !allowInInput) continue;
        
        if (preventDefault) {
          event.preventDefault();
        }
        if (stopPropagation) {
          event.stopPropagation();
        }
        
        shortcut.action();
        return;
      }
    }
  }, [enabled, preventDefault, stopPropagation]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}

/**
 * 使用单个快捷键
 */
export function useShortcut(
  shortcut: Omit<KeyboardShortcut, 'action' | 'description'> & { description?: string },
  action: () => void,
  deps: any[] = []
) {
  const memoizedAction = useCallback(action, deps);
  
  useKeyboardShortcuts([
    {
      ...shortcut,
      description: shortcut.description || '',
      action: memoizedAction,
    },
  ]);
}

/**
 * 获取快捷键显示文本
 */
export function getShortcutText(shortcut: Partial<KeyboardShortcut>): string {
  const parts: string[] = [];
  const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac');
  
  if (shortcut.ctrl) {
    parts.push(isMac ? '⌘' : 'Ctrl');
  }
  if (shortcut.shift) {
    parts.push(isMac ? '⇧' : 'Shift');
  }
  if (shortcut.alt) {
    parts.push(isMac ? '⌥' : 'Alt');
  }
  if (shortcut.meta) {
    parts.push(isMac ? '⌘' : 'Win');
  }
  if (shortcut.key) {
    // 特殊键名转换
    const keyMap: Record<string, string> = {
      'Enter': '↵',
      'Escape': 'Esc',
      'ArrowUp': '↑',
      'ArrowDown': '↓',
      'ArrowLeft': '←',
      'ArrowRight': '→',
      ' ': 'Space',
      'Backspace': '⌫',
      'Delete': 'Del',
      'Tab': '⇥',
    };
    parts.push(keyMap[shortcut.key] || shortcut.key.toUpperCase());
  }
  
  return parts.join(isMac ? '' : '+');
}

export default useKeyboardShortcuts;
