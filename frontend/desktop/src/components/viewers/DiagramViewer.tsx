/**
 * DiagramViewer - Mermaid 图表查看/编辑
 *
 * 支持 .mmd 文件及 Mermaid 源码；loading、暗色主题、Ctrl+滚轮缩放、右键导出 SVG。
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { t } from '../../lib/i18n';

export interface DiagramViewerProps {
  /** Mermaid 源码 */
  content: string;
  /** 文件名 */
  fileName?: string;
  /** 是否只读（仅预览） */
  readOnly?: boolean;
  /** 内容变更回调（编辑模式） */
  onChange?: (value: string) => void;
  /** 高度 */
  height?: string;
  /** 嵌入编辑区时隐藏工具栏中的文件名，避免与 Tab 重复 */
  embeddedInEditor?: boolean;
}

function useIsDark(): boolean {
  const [dark, setDark] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  );
  useEffect(() => {
    const el = document.documentElement;
    const ob = new MutationObserver(() => setDark(el.classList.contains('dark')));
    ob.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => ob.disconnect();
  }, []);
  return dark;
}

export function DiagramViewer({
  content,
  fileName,
  readOnly = true,
  onChange,
  height = '100%',
  embeddedInEditor,
}: DiagramViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [showSource, setShowSource] = useState(false);
  const [source, setSource] = useState(content);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [scale, setScale] = useState(1);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const isDark = useIsDark();

  useEffect(() => {
    setSource(content);
  }, [content]);

  const initMermaid = useCallback((m: { default: import('mermaid').Mermaid }) => {
    m.default.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      theme: isDark ? 'dark' : 'default',
    });
  }, [isDark]);

  const mermaidInitRef = useRef(false);
  useEffect(() => {
    if (mermaidInitRef.current) return;
    let mounted = true;
    import('mermaid').then((m) => {
      if (mounted) {
        initMermaid(m);
        mermaidInitRef.current = true;
      }
    });
    return () => { mounted = false; };
  }, [initMermaid]);

  useEffect(() => {
    if (!showSource && source?.trim()) {
      let cancelled = false;
      setRendering(true);
      const run = async () => {
        if (!containerRef.current || !source.trim()) {
          setRendering(false);
          return;
        }
        setError(null);
        try {
          const mermaid = await import('mermaid');
          if (cancelled) return;
          initMermaid(mermaid);
          mermaidInitRef.current = true;
          const id = 'mermaid-diagram-' + Math.random().toString(36).slice(2);
          if (!containerRef.current) return;
          containerRef.current.innerHTML = '';
          const { svg } = await mermaid.default.render(id, source);
          if (cancelled || !containerRef.current) return;
          containerRef.current.innerHTML = svg;
        } catch (err) {
          if (!cancelled) setError(err instanceof Error ? err.message : t('viewer.diagramRenderFailed'));
        } finally {
          if (!cancelled) setRendering(false);
        }
      };
      run();
      return () => {
        cancelled = true;
        setRendering(false);
      };
    } else {
      setRendering(false);
    }
  }, [showSource, source, initMermaid]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setScale((s) => (e.deltaY < 0 ? Math.min(s + 0.15, 3) : Math.max(s - 0.15, 0.3)));
    }
  }, []);

  const exportSvg = useCallback(() => {
    setContextMenu(null);
    const wrap = wrapRef.current;
    const svg = wrap?.querySelector('svg');
    if (!svg) return;
    const str = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([str], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (fileName && fileName.replace(/\.[^.]+$/, '')) ? `${fileName.replace(/\.[^.]+$/, '')}.svg` : 'diagram.svg';
    a.click();
    URL.revokeObjectURL(url);
  }, [fileName]);

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden bg-background" style={{ height }}>
      <div className="flex-1 min-h-0 overflow-hidden">
        {showSource ? (
          <textarea
            className="w-full h-full p-4 font-mono text-sm bg-muted/30 border-0 resize-none focus:outline-none focus:ring-0"
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              onChange?.(e.target.value);
            }}
            readOnly={readOnly}
            spellCheck={false}
          />
        ) : (
          <div
            ref={wrapRef}
            className="h-full overflow-auto p-4 flex items-center justify-center bg-muted/10"
            onWheel={handleWheel}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            {rendering && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-10">
                <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
              </div>
            )}
            {error ? (
              <div className="text-center max-w-md">
                <p className="text-sm text-destructive mb-2">{error}</p>
                <pre className="text-left text-xs bg-muted/50 p-4 rounded overflow-auto max-h-48">
                  {source}
                </pre>
              </div>
            ) : (
              <div
                ref={containerRef}
                className="[&>svg]:max-w-full [&>svg]:max-h-full [&>svg]:m-auto origin-center transition-transform duration-150"
                style={{ transform: `scale(${scale})` }}
              />
            )}
          </div>
        )}
      </div>
      {contextMenu && (
        <div
          className="fixed z-[var(--z-dropdown)] min-w-[120px] py-1 rounded-md border bg-popover text-popover-foreground shadow-md"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
            onClick={exportSvg}
          >
            导出 SVG
          </button>
        </div>
      )}
    </div>
  );
}

export default DiagramViewer;
