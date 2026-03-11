/**
 * Monaco Editor 增强版组件
 *
 * 仅处理纯文本/代码/Markdown。Word/PDF/Excel/PPT 由 FullEditorV2Enhanced 路由到专用查看器。
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import Editor, { loader as monacoLoader, OnMount, OnChange } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { Button } from './ui/button';
import { Eye, Edit } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { remarkPluginsWithMath, rehypePluginsMath, PROSE_CLASSES_EDITOR_PREVIEW } from '../lib/markdownRender';
import { useTheme } from 'next-themes';
import type { Components } from 'react-markdown';
import { EVENTS } from '../lib/constants';
import { getItem as getStorageItem } from '../lib/safeStorage';

/** Cmd+K 内联编辑输入框（嵌在 ViewZone 中），Cursor 风格 */
const InlineEditInput: React.FC<{
  onSubmit: (prompt: string) => void;
  onCancel: () => void;
}> = ({ onSubmit, onCancel }) => {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const v = value.trim();
      if (v) onSubmit(v);
      else onCancel();
    }
  };
  return (
    <div className="flex items-center w-full gap-2 h-full px-3 border-l-2 border-primary/60 bg-muted/40">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="用 AI 编辑… (Esc 取消)"
        className="flex-1 min-w-0 h-7 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        aria-label="AI 编辑指令"
      />
    </div>
  );
};

interface MonacoEditorEnhancedProps {
  value: string;
  onChange?: (value: string) => void;
  /** 选中变化：选中文本与行范围（用于 get_selected_code / 加入对话） */
  onSelectionChange?: (selectedText: string, range?: { startLine: number; endLine: number }) => void;
  /** 光标位置变化（用于 open_files.cursor_line 与聊天联动） */
  onCursorChange?: (line: number, column: number) => void;
  /** 打开文件后跳转到该行（如来自工具卡片「打开到第 N 行」），显示后由父组件清除 */
  scrollToLine?: number | null;
  onRevealedLine?: () => void;
  language?: string;
  filePath?: string;
  fileName?: string;
  fileFormat?: 'markdown' | 'code' | 'text' | 'json' | 'word' | 'excel' | 'ppt' | 'pdf';
  readOnly?: boolean;
  onSave?: () => void;
  height?: string;
  /** diff 模式：显示原始内容与当前内容的对比 */
  diffOriginal?: string;
  /** 是否处于 diff 模式 */
  showDiff?: boolean;
  /** 接受 diff（关闭 diff 模式） */
  onAcceptDiff?: () => void;
  /** 拒绝 diff（恢复原始内容） */
  onRejectDiff?: () => void;
  /** 自动换行（未传时使用 localStorage maibot_editor_word_wrap） */
  wordWrap?: 'on' | 'off';
  /** 是否显示 minimap（未传时默认 false） */
  minimap?: boolean;
  /** Lint 诊断变化时回调（供 Agent config.linter_errors 使用，最多 20 条） */
  onLinterErrorsChange?: (errors: Array<{ path: string; line: number; col: number; severity: number; message: string }>) => void;
}

// 文件类型检测
const getFileType = (fileName: string, content: string): {
  format: 'markdown' | 'code' | 'text' | 'json' | 'word' | 'excel' | 'ppt' | 'pdf';
  language: string;
  isEditable: boolean;
} => {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  
  // 文档格式
  if (['doc', 'docx'].includes(ext)) {
    return { format: 'word', language: 'plaintext', isEditable: false };
  }
  if (['xls', 'xlsx'].includes(ext)) {
    return { format: 'excel', language: 'plaintext', isEditable: false };
  }
  if (['ppt', 'pptx'].includes(ext)) {
    return { format: 'ppt', language: 'plaintext', isEditable: false };
  }
  if (ext === 'pdf') {
    return { format: 'pdf', language: 'plaintext', isEditable: false };
  }
  
  // 代码格式
  const codeExtensions: Record<string, string> = {
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'py': 'python',
    'java': 'java',
    'cpp': 'cpp',
    'c': 'c',
    'go': 'go',
    'rs': 'rust',
    'html': 'html',
    'css': 'css',
    'scss': 'scss',
    'json': 'json',
    'xml': 'xml',
    'yaml': 'yaml',
    'yml': 'yaml',
    'sql': 'sql',
    'sh': 'shell',
    'bash': 'shell',
    'md': 'markdown',
  };
  
  if (codeExtensions[ext]) {
    return {
      format: ext === 'md' ? 'markdown' : ext === 'json' ? 'json' : 'code',
      language: codeExtensions[ext],
      isEditable: true,
    };
  }
  
  return { format: 'text', language: 'plaintext', isEditable: true };
};

/** Markdown 预览中的 Mermaid 代码块渲染 */
const MermaidBlock: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const code = typeof children === 'string' ? children : String(children ?? '');
  useEffect(() => {
    if (!containerRef.current || !code.trim()) return;
    setError(null);
    import('mermaid')
      .then(({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });
        const id = 'mermaid-' + Math.random().toString(36).slice(2);
        mermaid.render(id, code)
          .then(({ svg }) => {
            if (containerRef.current) {
              containerRef.current.innerHTML = svg;
            }
          })
          .catch((err) => setError(err?.message ?? 'Mermaid 渲染失败'));
      })
      .catch(() => setError('Mermaid 未加载'));
  }, [code]);
  if (error) {
    return (
      <pre className="my-4 p-4 rounded-lg bg-muted text-sm overflow-x-auto">
        <code>{code}</code>
        <div className="mt-2 text-destructive text-xs">{error}</div>
      </pre>
    );
  }
  return <div ref={containerRef} className="my-4 flex justify-center [&>svg]:max-w-full" />;
};

const markdownPreviewComponents: Components = {
  code({ node, className, children, ...props }) {
    const inline = (props as { inline?: boolean }).inline;
    if (!inline && className?.includes('language-mermaid')) {
      return <MermaidBlock>{children}</MermaidBlock>;
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

export const MonacoEditorEnhanced: React.FC<MonacoEditorEnhancedProps> = ({
  value,
  onChange,
  onSelectionChange,
  onCursorChange,
  scrollToLine,
  onRevealedLine,
  language,
  filePath,
  fileName = 'untitled',
  fileFormat,
  readOnly = false,
  onSave,
  height = '100%',
  diffOriginal,
  showDiff = false,
  onAcceptDiff,
  onRejectDiff,
  wordWrap,
  minimap = false,
  onLinterErrorsChange,
}) => {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const diffEditorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const diffContainerRef = useRef<HTMLDivElement>(null);
  const [diffEditorReady, setDiffEditorReady] = useState(false);
  const scrollToLineRef = useRef<number | null>(null);
  const inlineCompletionsDisposableRef = useRef<{ dispose(): void } | null>(null);
  const markersDisposableRef = useRef<{ dispose(): void } | null>(null);
  const inlineCompleteDebounceRef = useRef<{ timer: ReturnType<typeof setTimeout>; controller: AbortController } | null>(null);
  const isMarkdownDefault = fileFormat === 'markdown' || (typeof fileName === 'string' && fileName.toLowerCase().endsWith('.md'));
  const [isPreviewMode, setIsPreviewMode] = useState(isMarkdownDefault);
  const { theme: appTheme } = useTheme();
  const [detectedType, setDetectedType] = useState<{
    format: 'markdown' | 'code' | 'text' | 'json' | 'word' | 'excel' | 'ppt' | 'pdf';
    language: string;
    isEditable: boolean;
  } | null>(null);

  // 根据应用主题选择编辑器主题
  const editorTheme = appTheme === 'dark' || (appTheme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches) 
    ? 'vs-dark' 
    : 'vs';

  // 检测文件类型
  useEffect(() => {
    if (fileFormat) {
      // 使用传入的格式
      const type = getFileType(fileName, value);
      setDetectedType({
        format: fileFormat,
        language: language || type.language,
        isEditable: type.isEditable,
      });
    } else {
      // 自动检测
      const type = getFileType(fileName, value);
      setDetectedType({
        format: type.format,
        language: language || type.language,
        isEditable: type.isEditable,
      });
    }
  }, [fileName, value, fileFormat, language]);

  // 当切换到 markdown 文件时，默认显示预览（仅当从非 md 切到 md 时重置一次）
  const prevFormatRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const fmt = detectedType?.format;
    if (fmt === 'markdown' && prevFormatRef.current !== 'markdown') {
      setIsPreviewMode(true);
    }
    prevFormatRef.current = fmt;
  }, [detectedType?.format]);

  // Cmd+\ 切换 Markdown 预览/源码（由 FullEditor 全局快捷键触发）
  useEffect(() => {
    const handler = () => {
      if (fileFormat === 'markdown' || (typeof fileName === 'string' && fileName.toLowerCase().endsWith('.md'))) {
        setIsPreviewMode((p) => !p);
      }
    };
    window.addEventListener('toggle_markdown_preview' as any, handler);
    return () => window.removeEventListener('toggle_markdown_preview' as any, handler);
  }, [fileFormat, fileName]);

  // 卸载时释放 Monaco 实例与 markers 监听，避免内存泄漏
  useEffect(() => {
    return () => {
      if (markersDisposableRef.current) {
        markersDisposableRef.current.dispose();
        markersDisposableRef.current = null;
      }
      if (editorRef.current) {
        editorRef.current.dispose();
        editorRef.current = null;
      }
    };
  }, []);

  // Diff 模式：使用 monaco.editor.createDiffEditor 显示左右对比
  const lang = detectedType?.language || language || 'plaintext';
  useEffect(() => {
    if (!showDiff || !diffContainerRef.current) {
      setDiffEditorReady(false);
      if (diffEditorRef.current) {
        diffEditorRef.current.dispose();
        diffEditorRef.current = null;
      }
      return;
    }
    setDiffEditorReady(false);
    let disposed = false;
    monacoLoader.init().then((monaco) => {
      if (disposed || !diffContainerRef.current) return;
      const diffEd = monaco.editor.createDiffEditor(diffContainerRef.current, {
        readOnly: true,
        renderSideBySide: true,
        theme: editorTheme,
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false,
      });
      const originalModel = monaco.editor.createModel(diffOriginal ?? '', lang);
      const modifiedModel = monaco.editor.createModel(value ?? '', lang);
      diffEd.setModel({ original: originalModel, modified: modifiedModel });
      diffEditorRef.current = diffEd;
      if (!disposed) setDiffEditorReady(true);
    });
    return () => {
      disposed = true;
      if (diffEditorRef.current) {
        diffEditorRef.current.dispose();
        diffEditorRef.current = null;
      }
    };
  }, [showDiff, lang, editorTheme]);

  useEffect(() => {
    if (!showDiff || !diffEditorRef.current) return;
    const model = diffEditorRef.current.getModel();
    if (model?.original) model.original.setValue(diffOriginal ?? '');
    if (model?.modified) model.modified.setValue(value ?? '');
  }, [showDiff, diffOriginal, value]);

  const revealLineAt = useCallback((ed: editor.IStandaloneCodeEditor, line: number) => {
    const lineNum = Math.max(1, line);
    ed.revealLineInCenter(lineNum);
    ed.setPosition({ lineNumber: lineNum, column: 1 });
    ed.focus();
    onRevealedLine?.();
  }, [onRevealedLine]);

  const editorTabSize = React.useMemo(() => {
    const raw = getStorageItem('maibot_editor_tab_size');
    const n = raw ? parseInt(raw, 10) : 2;
    return Number.isNaN(n) ? 2 : n;
  }, []);
  const editorWordWrapFromStorage = React.useMemo(() => {
    const raw = (getStorageItem('maibot_editor_word_wrap') || 'off').toLowerCase();
    return raw === 'on' ? 'on' : 'off';
  }, []);
  const effectiveWordWrap = wordWrap ?? editorWordWrapFromStorage;

  // 编辑器挂载
  const handleEditorDidMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    if (scrollToLine != null) {
      scrollToLineRef.current = scrollToLine;
      revealLineAt(editor, scrollToLine);
    }
    // 配置编辑器选项 - 优化显示效果
    editor.updateOptions({
      minimap: { enabled: minimap },
      fontSize: 14,
      lineNumbers: 'on',
      automaticLayout: true,
      scrollBeyondLastLine: false,
      tabSize: editorTabSize,
      insertSpaces: true,
      formatOnPaste: true,
      formatOnType: true,
      padding: { top: 8, bottom: 8 },  // 添加内边距
      smoothScrolling: true,  // 平滑滚动
      cursorBlinking: 'smooth',  // 平滑光标闪烁
      cursorSmoothCaretAnimation: 'on',  // 平滑光标动画
      wordWrap: effectiveWordWrap,
      inlineSuggest: { enabled: true, mode: 'prefix' as const },
    });

    // 添加保存快捷键
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (onSave) {
        onSave();
      }
    });

    // 建议浮窗激活且存在候选焦点时，优先接受补全；否则保留编辑器默认行为（缩进/换行）
    const suggestAcceptContext = 'suggestWidgetVisible && suggestWidgetHasFocusedSuggestion';
    editor.addCommand(monaco.KeyCode.Tab, () => {
      editor.trigger('keyboard', 'acceptSelectedSuggestion', {});
    }, suggestAcceptContext);
    editor.addCommand(monaco.KeyCode.Enter, () => {
      editor.trigger('keyboard', 'acceptSelectedSuggestion', {});
    }, suggestAcceptContext);
    editor.addCommand(monaco.KeyCode.UpArrow, () => {
      editor.trigger('keyboard', 'selectPrevSuggestion', {});
    }, 'suggestWidgetVisible');
    editor.addCommand(monaco.KeyCode.DownArrow, () => {
      editor.trigger('keyboard', 'selectNextSuggestion', {});
    }, 'suggestWidgetVisible');
    editor.addCommand(monaco.KeyCode.Escape, () => {
      editor.trigger('keyboard', 'hideSuggestWidget', {});
    }, 'suggestWidgetVisible');
    
    // Cmd+K：内联 ViewZone 输入框（Cursor 风格），嵌在当前光标行下方
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
      const pos = editor.getPosition();
      if (!pos) return;
      const domNode = document.createElement('div');
      domNode.style.height = '40px';
      domNode.style.display = 'flex';
      domNode.style.alignItems = 'center';
      domNode.style.padding = '0 12px';
      domNode.style.background = 'var(--muted)';
      domNode.style.borderTop = '1px solid var(--border)';
      let zoneId: string;
      editor.changeViewZones((accessor) => {
        zoneId = accessor.addZone({
          afterLineNumber: pos.lineNumber,
          heightInPx: 40,
          domNode,
        });
      });
      const root = createRoot(domNode);
      root.render(
        <InlineEditInput
          onSubmit={(prompt) => {
            editor.changeViewZones((accessor) => accessor.removeZone(zoneId));
            root.unmount();
            const selection = editor.getSelection();
            const selectedText = selection ? editor.getModel()?.getValueInRange(selection) ?? '' : '';
            window.dispatchEvent(new CustomEvent(EVENTS.OPEN_EDITOR_COMMAND_PALETTE, {
              detail: { prompt, selection: selectedText },
            }));
          }}
          onCancel={() => {
            editor.changeViewZones((accessor) => accessor.removeZone(zoneId));
            root.unmount();
            editor.focus();
          }}
        />
      );
    });

    // Tab Ghost Text：Monaco InlineCompletionsProvider，500ms debounce，调用 /api/editor/complete
    if (inlineCompletionsDisposableRef.current) {
      inlineCompletionsDisposableRef.current.dispose();
      inlineCompletionsDisposableRef.current = null;
    }
    const disposable = monaco.languages.registerInlineCompletionsProvider({ pattern: '**' }, {
      provideInlineCompletions: async (model, position, _ctx, token) => {
        const prefix = model.getValueInRange({
          startLineNumber: Math.max(1, position.lineNumber - 5),
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });
        const suffix = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: Math.min(model.getLineCount(), position.lineNumber + 5),
          endColumn: model.getLineMaxColumn(Math.min(model.getLineCount(), position.lineNumber + 5)),
        });
        if (prefix.trim().length < 3) return { items: [] };

        const prev = inlineCompleteDebounceRef.current;
        if (prev) {
          clearTimeout(prev.timer);
          prev.controller.abort();
        }
        const controller = new AbortController();
        return new Promise((resolve) => {
          const timer = window.setTimeout(async () => {
            inlineCompleteDebounceRef.current = null;
            if (token.isCancellationRequested) {
              resolve({ items: [] });
              return;
            }
            try {
              const apiBase = (window as any).__LANGGRAPH_API_URL__ || getStorageItem('maibot_settings_baseURL') || 'http://127.0.0.1:2024';
              const res = await fetch(`${String(apiBase).replace(/\/$/, '')}/editor/complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  prefix,
                  suffix,
                  language: model.getLanguageId?.() ?? 'plaintext',
                }),
                signal: controller.signal,
              });
              if (token.isCancellationRequested || !res.ok) {
                resolve({ items: [] });
                return;
              }
              const data = await res.json();
              const completion = typeof data?.completion === 'string' ? data.completion : '';
              if (!completion || token.isCancellationRequested) {
                resolve({ items: [] });
                return;
              }
              const endColumn = model.getLineMaxColumn(position.lineNumber);
              resolve({
                items: [{
                  insertText: completion,
                  range: {
                    startLineNumber: position.lineNumber,
                    startColumn: position.column,
                    endLineNumber: position.lineNumber,
                    endColumn,
                  },
                }],
              });
            } catch {
              resolve({ items: [] });
            }
          }, 500);
          inlineCompleteDebounceRef.current = { timer, controller };
        });
      },
    });
    inlineCompletionsDisposableRef.current = disposable;
    
    // 添加 AI 上下文菜单项
    editor.addAction({
      id: 'ai-explain',
      label: 'AI: 解释代码',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyE],
      contextMenuGroupId: 'ai',
      contextMenuOrder: 1,
      run: (ed) => {
        const selection = ed.getSelection();
        if (selection && !selection.isEmpty()) {
          const selectedText = ed.getModel()?.getValueInRange(selection) || '';
          window.dispatchEvent(new CustomEvent('editor_ai_action', {
            detail: { action: 'explain', text: selectedText },
          }));
        }
      },
    });
    
    editor.addAction({
      id: 'ai-optimize',
      label: 'AI: 优化代码',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyO],
      contextMenuGroupId: 'ai',
      contextMenuOrder: 2,
      run: (ed) => {
        const selection = ed.getSelection();
        if (selection && !selection.isEmpty()) {
          const selectedText = ed.getModel()?.getValueInRange(selection) || '';
          window.dispatchEvent(new CustomEvent('editor_ai_action', {
            detail: { action: 'fix', text: selectedText },
          }));
        }
      },
    });
    
    editor.addAction({
      id: 'ai-document',
      label: 'AI: 生成文档',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyD],
      contextMenuGroupId: 'ai',
      contextMenuOrder: 3,
      run: (ed) => {
        const selection = ed.getSelection();
        if (selection && !selection.isEmpty()) {
          const selectedText = ed.getModel()?.getValueInRange(selection) || '';
          window.dispatchEvent(new CustomEvent('editor_ai_action', {
            detail: { action: 'document', text: selectedText },
          }));
        }
      },
    });
    
    editor.addAction({
      id: 'ai-test',
      label: 'AI: 生成测试',
      contextMenuGroupId: 'ai',
      contextMenuOrder: 4,
      run: (ed) => {
        const selection = ed.getSelection();
        if (selection && !selection.isEmpty()) {
          const selectedText = ed.getModel()?.getValueInRange(selection) || '';
          window.dispatchEvent(new CustomEvent('editor_ai_action', {
            detail: { action: 'test', text: selectedText },
          }));
        }
      },
    });

    // Cursor 风格：选中内容加入对话（打开右侧面板并填入输入框）
    editor.addAction({
      id: 'send-to-chat',
      label: '加入对话',
      contextMenuGroupId: 'ai',
      contextMenuOrder: 5,
      run: (ed) => {
        const selection = ed.getSelection();
        const text = selection && !selection.isEmpty()
          ? ed.getModel()?.getValueInRange(selection) || ''
          : ed.getModel()?.getValue() || '';
        if (text.trim()) {
          window.dispatchEvent(new CustomEvent('send_selection_to_chat', {
            detail: { text: text.trim(), filePath },
          }));
        }
      },
    });

    // 监听文本选择变化（含行范围，供 get_selected_code / 加入对话）
    if (onSelectionChange) {
      editor.onDidChangeCursorSelection(() => {
        const selection = editor.getSelection();
        if (selection && !selection.isEmpty()) {
          const selectedText = editor.getModel()?.getValueInRange(selection) || '';
          onSelectionChange(selectedText, {
            startLine: selection.startLineNumber,
            endLine: selection.endLineNumber,
          });
        } else {
          onSelectionChange('', undefined);
        }
      });
    }
    // 光标位置变化（供 open_files.cursor_line）
    if (onCursorChange) {
      editor.onDidChangeCursorPosition((e) => {
        onCursorChange(e.position.lineNumber, e.position.column);
      });
    }

    // Lint 诊断变化 → 回调（供 Agent config.linter_errors，最多 20 条）
    if (onLinterErrorsChange) {
      const updateMarkers = () => {
        const model = editor.getModel();
        if (!model) return;
        const markers = monaco.editor.getModelMarkers({ resource: model.uri });
        const list = markers.slice(0, 20).map((m) => ({
          path: filePath || model.uri.path,
          line: m.startLineNumber,
          col: m.startColumn,
          severity: (m.severity ?? 0) as number,
          message: m.message || '',
        }));
        onLinterErrorsChange(list);
      };
      const disp = monaco.editor.onDidChangeMarkers((uris) => {
        const model = editor.getModel();
        if (!model || !uris.some((u) => u.toString() === model.uri.toString())) return;
        updateMarkers();
      });
      markersDisposableRef.current = disp;
      updateMarkers();
    }
  }, [onSave, onSelectionChange, onCursorChange, filePath, scrollToLine, revealLineAt, editorTabSize, effectiveWordWrap, minimap, onLinterErrorsChange]);

  // 外部 wordWrap 变化时同步到已挂载的编辑器（如工具栏切换）
  useEffect(() => {
    const ed = editorRef.current;
    if (ed && !showDiff) ed.updateOptions({ wordWrap: effectiveWordWrap });
  }, [effectiveWordWrap, showDiff]);

  // 外部 minimap 变化时同步
  useEffect(() => {
    const ed = editorRef.current;
    if (ed && !showDiff) ed.updateOptions({ minimap: { enabled: minimap } });
  }, [minimap, showDiff]);

  // 挂载后若 scrollToLine 才传入（如异步打开文件），在此响应
  useEffect(() => {
    if (scrollToLine == null || scrollToLineRef.current === scrollToLine) return;
    const ed = editorRef.current;
    if (!ed) return;
    scrollToLineRef.current = scrollToLine;
    revealLineAt(ed, scrollToLine);
  }, [scrollToLine, revealLineAt]);

  // 卸载时清理 InlineCompletionsProvider 与 debounce 定时器
  useEffect(() => {
    return () => {
      const prev = inlineCompleteDebounceRef.current;
      if (prev) {
        clearTimeout(prev.timer);
        prev.controller.abort();
        inlineCompleteDebounceRef.current = null;
      }
      inlineCompletionsDisposableRef.current?.dispose();
      inlineCompletionsDisposableRef.current = null;
    };
  }, []);

  // 内容变更
  const handleEditorChange: OnChange = useCallback((newValue) => {
    if (onChange && newValue !== undefined) {
      onChange(newValue);
    }
  }, [onChange]);

  // 二进制/文档格式由父组件路由到专用查看器，此处不处理
  if (detectedType && !detectedType.isEditable) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        此文件类型由专用查看器打开
      </div>
    );
  }

  // Diff 模式：左右对比（接受/拒绝由父组件 diff 操作栏处理）
  if (showDiff && diffOriginal !== undefined) {
    return (
      <div className="h-full flex flex-col overflow-hidden relative">
        {!diffEditorReady && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
              <span>加载变更对比...</span>
            </div>
          </div>
        )}
        <div ref={diffContainerRef} className="flex-1 min-h-0 w-full relative" style={{ height: height ?? '100%' }} />
      </div>
    );
  }

  // Markdown 预览模式 - 优化文档显示效果（支持滚动）
  if (detectedType?.format === 'markdown' && isPreviewMode) {
    return (
      <div className="h-full flex flex-col bg-background overflow-hidden">
        <div className="h-9 border-b bg-card/50 px-2 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Markdown 预览</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7"
            onClick={() => setIsPreviewMode(false)}
          >
            <Edit className="h-4 w-4 mr-2" />
            编辑
          </Button>
        </div>
        {/* 使用原生滚动替代 ScrollArea，解决滚动问题 */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="p-8 max-w-4xl mx-auto">
            <article className={PROSE_CLASSES_EDITOR_PREVIEW}>
              <ReactMarkdown
                remarkPlugins={[...remarkPluginsWithMath]}
                rehypePlugins={[...rehypePluginsMath]}
                components={markdownPreviewComponents}
              >
                {value}
              </ReactMarkdown>
            </article>
          </div>
        </div>
      </div>
    );
  }

  // Monaco Editor 编辑模式 - Cursor/VSCode 风格
  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 工具栏 */}
      {detectedType?.format === 'markdown' && (
        <div className="h-9 border-b bg-card/50 px-2 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Edit className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Markdown 编辑</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7"
            onClick={() => setIsPreviewMode(true)}
          >
            <Eye className="h-4 w-4 mr-2" />
            预览
          </Button>
        </div>
      )}
      
      {/* 编辑器容器 - 确保可以正确滚动 */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <Editor
          height={height}
          language={detectedType?.language || 'plaintext'}
          value={value}
          onChange={handleEditorChange}
          onMount={handleEditorDidMount}
          theme={editorTheme}
          loading={
            <div className="h-full flex items-center justify-center">
              <div className="flex items-center gap-2 text-muted-foreground">
                <div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
                <span className="text-sm">加载编辑器...</span>
              </div>
            </div>
          }
          options={{
            readOnly,
            // ===== 布局和显示 - 高密度，不占有效面积 =====
            minimap: { enabled: minimap },
            fontSize: 13,
            fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace',
            fontLigatures: true,
            lineHeight: 21,
            letterSpacing: 0.2,
            lineNumbers: 'on',
            glyphMargin: false,
            lineDecorationsWidth: 4,
            lineNumbersMinChars: 2,
            
            // ===== 滚动优化 - 关键配置 =====
            scrollbar: {
              vertical: 'visible',
              horizontal: 'auto',
              useShadows: false,
              verticalHasArrows: false,
              horizontalHasArrows: false,
              verticalScrollbarSize: 10,
              horizontalScrollbarSize: 10,
              arrowSize: 0,
              alwaysConsumeMouseWheel: false, // 允许滚动穿透
            },
            scrollBeyondLastLine: false,
            scrollBeyondLastColumn: 5,
            smoothScrolling: true,  // 平滑滚动
            mouseWheelScrollSensitivity: 1.5,  // 鼠标滚轮灵敏度
            fastScrollSensitivity: 7,  // 快速滚动灵敏度
            
            // ===== 编辑体验 =====
            wordWrap: effectiveWordWrap,
            wordWrapColumn: 120,
            wrappingIndent: 'indent',
            automaticLayout: true,
            tabSize: editorTabSize,
            insertSpaces: true,
            formatOnPaste: true,
            formatOnType: true,
            autoClosingBrackets: 'languageDefined',
            autoClosingQuotes: 'languageDefined',
            autoSurround: 'languageDefined',
            autoIndent: 'full',
            
            // ===== 代码建议 =====
            suggestOnTriggerCharacters: true,
            quickSuggestions: {
              other: 'on',
              comments: 'off',
              strings: 'on',
            },
            acceptSuggestionOnCommitCharacter: true,
            acceptSuggestionOnEnter: 'on',
            tabCompletion: 'on',
            snippetSuggestions: 'top',
            suggest: {
              insertMode: 'replace',
              filterGraceful: true,
              showMethods: true,
              showFunctions: true,
              showConstructors: true,
              showFields: true,
              showVariables: true,
              showClasses: true,
              showStructs: true,
              showInterfaces: true,
              showModules: true,
              showProperties: true,
              showEvents: true,
              showOperators: true,
              showUnits: true,
              showValues: true,
              showConstants: true,
              showEnums: true,
              showEnumMembers: true,
              showKeywords: true,
              showWords: true,
              showColors: true,
              showFiles: true,
              showReferences: true,
              showFolders: true,
              showTypeParameters: true,
              showSnippets: true,
              showUsers: true,
              showIssues: true,
              preview: true,
              previewMode: 'subwordSmart',
            },
            quickSuggestionsDelay: 50,
            parameterHints: { 
              enabled: true,
              cycle: true,
            },
            
            // ===== 视觉效果 - Cursor 风格 =====
            renderWhitespace: 'selection',  // 选中时显示空白字符
            renderLineHighlight: 'all',  // 高亮当前行（包括行号）
            renderLineHighlightOnlyWhenFocus: false,
            cursorBlinking: 'smooth',
            cursorSmoothCaretAnimation: 'on',
            cursorStyle: 'line',
            cursorWidth: 2,
            padding: { top: 8, bottom: 8 },
            roundedSelection: true,
            
            // ===== 代码折叠 - 增强显示 =====
            folding: true,
            foldingStrategy: 'auto',
            foldingHighlight: true,
            showFoldingControls: 'always',  // 始终显示折叠控件
            unfoldOnClickAfterEndOfLine: true,
            foldingImportsByDefault: false,  // 不默认折叠 imports
            
            // ===== 括号匹配 - 彩虹括号 =====
            matchBrackets: 'always',
            bracketPairColorization: {
              enabled: true,
              independentColorPoolPerBracketType: true,
            },
            
            // ===== 缩进导引线 - 关键优化 =====
            guides: {
              bracketPairs: 'active',  // 活动括号对导引线
              bracketPairsHorizontal: 'active',
              highlightActiveBracketPair: true,
              indentation: true,  // 显示缩进导引线
              highlightActiveIndentation: true,  // 高亮活动缩进
            },
            
            // ===== 选择和高亮 =====
            selectionHighlight: true,  // 高亮相同选择
            occurrencesHighlight: 'singleFile',  // 高亮相同单词
            renderControlCharacters: false,
            columnSelection: false,  // 禁用列选择（避免误操作）
            
            // ===== 粘性滚动 (Cursor 特色) =====
            stickyScroll: {
              enabled: true,
              maxLineCount: 5,
              defaultModel: 'outlineModel',
            },
            
            // ===== 悬停提示 =====
            hover: {
              enabled: true,
              delay: 200,  // 更快的响应
              sticky: true,
              above: false,  // 提示显示在下方
            },
            
            // ===== 链接和定义跳转 =====
            links: true,
            definitionLinkOpensInPeek: false,  // 定义跳转直接打开
            
            // ===== 内联建议 (Cursor 特色) =====
            inlineSuggest: {
              enabled: true,
              showToolbar: 'onHover',
              suppressSuggestions: false,
            },
            
            // ===== 其他优化 =====
            colorDecorators: true,  // 显示颜色装饰器
            colorDecoratorsActivatedOn: 'clickAndHover',
            dragAndDrop: true,  // 允许拖放文本
            dropIntoEditor: { enabled: true },
            emptySelectionClipboard: false,  // 空选择不复制整行
            find: {
              addExtraSpaceOnTop: true,
              autoFindInSelection: 'multiline',
              seedSearchStringFromSelection: 'selection',
            },
          }}
        />
      </div>
    </div>
  );
};

export default MonacoEditorEnhanced;

