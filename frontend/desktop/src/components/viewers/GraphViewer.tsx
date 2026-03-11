/**
 * GraphViewer - 知识图谱 / 网络拓扑图
 *
 * 渲染 JSON 图数据 { nodes: [], links: [] }，支持拖拽、缩放、悬停；暗色主题随系统/应用主题。
 */

import React, { useState, useCallback, useEffect } from 'react';
import { t } from '../../lib/i18n';

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

export interface GraphViewerProps {
  /** JSON 字符串，格式 { nodes: Array<{id?: string, ...}>, links: Array<{source, target, ...}> } */
  content: string;
  /** 文件名 */
  fileName?: string;
  /** 高度 */
  height?: string;
  /** 嵌入编辑区时隐藏文件名栏，避免与 Tab 重复 */
  embeddedInEditor?: boolean;
}

interface GraphNode {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  [key: string]: unknown;
}

interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

function parseGraphContent(content: string): GraphData | null {
  try {
    const raw = JSON.parse(content);
    const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
    const links = Array.isArray(raw.links) ? raw.links : [];
    const normalized = nodes.map((n: GraphNode, i: number) =>
      typeof n === 'object' && n !== null
        ? { ...n, id: n.id ?? String(i) }
        : { id: String(i), name: String(n) }
    );
    return { nodes: normalized, links };
  } catch {
    return null;
  }
}

const EMPTY_GRAPH: GraphData = { nodes: [], links: [] };

export function GraphViewer({
  content,
  fileName,
  height = '100%',
  embeddedInEditor,
}: GraphViewerProps) {
  const [error, setError] = useState<string | null>(null);
  const [graphData, setGraphData] = useState<GraphData>(EMPTY_GRAPH);
  const [ForceGraph2D, setForceGraph2D] = useState<React.ComponentType<any> | null>(null);
  const isDark = useIsDark();

  useEffect(() => {
    import('react-force-graph-2d').then((m) => setForceGraph2D(() => m.default));
  }, []);

  useEffect(() => {
    const data = parseGraphContent(content);
    if (data) {
      setError(null);
      setGraphData(data);
    } else {
      setError(t('viewer.graphInvalidData'));
      setGraphData(EMPTY_GRAPH);
    }
  }, [content]);

  const nodeLabel = useCallback((node: GraphNode) => {
    return (node.name ?? node.id ?? '') as string;
  }, []);

  if (error) {
    return (
      <div className="h-full min-h-0 flex flex-col items-center justify-center p-8" style={{ height }}>
        <p className="text-sm text-destructive mb-4">{error}</p>
        <pre className="text-left text-xs bg-muted/50 p-4 rounded overflow-auto max-h-64 w-full">
          {content.slice(0, 2000)}
          {content.length > 2000 ? '\n...' : ''}
        </pre>
      </div>
    );
  }

  if (!ForceGraph2D) {
    return (
      <div className="h-full min-h-0 flex items-center justify-center" style={{ height }}>
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden bg-background" style={{ height }}>
      <div className="flex-1 min-h-0 w-full bg-muted/10">
        <ForceGraph2D
          graphData={graphData}
          nodeLabel={nodeLabel}
          nodeAutoColorBy="group"
          backgroundColor={isDark ? 'hsl(220 15% 12%)' : 'hsl(0 0% 98%)'}
          linkColor={isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'}
          linkDirectionalArrowLength={3.5}
          linkDirectionalArrowRelPos={1}
          linkCurvature={0.25}
        />
      </div>
    </div>
  );
}

export default GraphViewer;
