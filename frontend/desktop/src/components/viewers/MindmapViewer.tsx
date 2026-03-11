/**
 * MindmapViewer - Markdown 思维导图预览
 *
 * 使用 markmap-lib + markmap-view 将 Markdown 渲染为可交互思维导图。
 * 支持 .mm 文件或任意 Markdown 内容。
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { t } from '../../lib/i18n';

export interface MindmapViewerProps {
  /** Markdown 内容 */
  content: string;
  /** 文件名 */
  fileName?: string;
  /** 高度 */
  height?: string;
  /** 嵌入编辑区时隐藏文件名栏，避免与 Tab 重复 */
  embeddedInEditor?: boolean;
}

export function MindmapViewer({
  content,
  fileName,
  height = '100%',
  embeddedInEditor,
}: MindmapViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const markmapRef = useRef<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const run = async () => {
      if (!content?.trim() || !containerRef.current) {
        setLoading(false);
        return;
      }
      setError(null);
      try {
        const [{ Transformer }, { Markmap, loadCSS, loadJS }] = await Promise.all([
          import('markmap-lib'),
          import('markmap-view'),
        ]);
        if (cancelled) return;
        const transformer = new Transformer();
        const { root, features } = transformer.transform(content);
        const assets = transformer.getUsedAssets(features);

        if (assets.styles) loadCSS(assets.styles);
        if (assets.scripts) {
          const markmap = await import('markmap-view');
          loadJS(assets.scripts, { getMarkmap: () => markmap });
        }
        if (cancelled || !containerRef.current) return;
        const container = containerRef.current;
        container.innerHTML = '';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'w-full h-full');
        container.appendChild(svg);
        svgRef.current = svg;
        markmapRef.current = Markmap.create(svg, undefined, root);
        if (!cancelled) setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('viewer.mindmapRenderFailed'));
          setLoading(false);
        }
      }
    };
    run();
    return () => {
      cancelled = true;
      setLoading(false);
      if (markmapRef.current?.destroy) {
        try {
          markmapRef.current.destroy();
        } catch (e) {
          if (import.meta.env?.DEV) console.warn("[MindmapViewer] markmap destroy:", e);
        }
      }
      markmapRef.current = null;
      svgRef.current = null;
    };
  }, [content]);

  if (loading && !error) {
    return (
      <div className="h-full min-h-0 flex items-center justify-center bg-muted/10" style={{ height }}>
        <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full min-h-0 flex flex-col items-center justify-center p-8" style={{ height }}>
        <p className="text-sm text-destructive mb-4">{error}</p>
        <pre className="text-left text-xs bg-muted/50 p-4 rounded overflow-auto max-h-64 w-full">
          {content}
        </pre>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden bg-background" style={{ height }}>
      {/* 无工具栏：思维导图全屏显示，markmap 自带缩放/平移 */}
      <div ref={containerRef} className="flex-1 min-h-0 w-full bg-muted/10 [&>svg]:min-h-[400px]" />
    </div>
  );
}

export default MindmapViewer;
