/**
 * 知识图谱可视化组件
 *
 * 使用力导向图展示本体实体与关系，支持点击节点查看详情、筛选类型、搜索。
 */
import React, { useState, useEffect, useCallback, useRef, useReducer, useDeferredValue, useMemo } from "react";
import { knowledgeAPI, type GraphData, type GraphNode, type GraphEdge } from "../lib/api/knowledge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { RefreshCw, ZoomIn, ZoomOut, Maximize2, Loader2, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { t } from "../lib/i18n";

const ENTITY_TYPE_COLORS: Record<string, string> = {
  organization: "#1890ff",
  product: "#52c41a",
  product_series: "#13c2c2",
  certification: "#faad14",
  requirement: "#f5222d",
  scoring_item: "#eb2f96",
  personnel: "#722ed1",
  service: "#2f54eb",
  technical_spec: "#a0d911",
  project: "#fa8c16",
  other: "#8c8c8c",
};

function nodeColor(node: { type?: string }) {
  const t = (node.type || "other").toLowerCase();
  return ENTITY_TYPE_COLORS[t] ?? ENTITY_TYPE_COLORS.other;
}

/** 将 hex 颜色附加 alpha 后缀，已有 alpha 时替换 */
function dimHex(hex: string, alpha: string) {
  const base = hex.length === 9 ? hex.slice(0, 7) : hex;
  return `${base}${alpha}`;
}

interface KnowledgeGraphViewProps {
  /** 是否显示工具栏 */
  showToolbar?: boolean;
  /** 初始节点数量限制 */
  limit?: number;
  /** 实体类型筛选 */
  entityTypeFilter?: string;
  /** 选中节点时回调 */
  onNodeSelect?: (node: GraphNode | null) => void;
  className?: string;
}

type GraphState = { current: GraphData | null; history: GraphData[] };
type GraphAction =
  | { type: "SET"; payload: GraphData | null }
  | { type: "PUSH_AND_SET"; payload: GraphData }
  | { type: "BACK" };

function graphReducer(state: GraphState, action: GraphAction): GraphState {
  switch (action.type) {
    case "SET":
      return { current: action.payload, history: state.history };
    case "PUSH_AND_SET":
      return {
        current: action.payload,
        history: state.current ? [...state.history, state.current] : state.history,
      };
    case "BACK": {
      if (state.history.length === 0) return state;
      const prev = state.history[state.history.length - 1];
      return { current: prev, history: state.history.slice(0, -1) };
    }
    default:
      return state;
  }
}

export function KnowledgeGraphView({
  showToolbar = true,
  limit = 300,
  entityTypeFilter,
  onNodeSelect,
  className = "",
}: KnowledgeGraphViewProps) {
  const [graphState, dispatchGraph] = useReducer(graphReducer, { current: null, history: [] });
  const graphData = graphState.current;
  const graphHistory = graphState.history;
  const [loading, setLoading] = useState(true);
  const [subgraphLoading, setSubgraphLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchQueryDeferred = useDeferredValue(searchQuery);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [stats, setStats] = useState<GraphData["stats"] | null>(null);
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const graphRef = useRef<{ zoom: (n: number, duration?: number) => void; centerAt: (x: number, y: number, duration?: number) => void; zoomToFit?: (duration?: number, padding?: number) => void } | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadGraph = useCallback(async () => {
    if (mountedRef.current) setLoading(true);
    try {
      const data = await knowledgeAPI.getGraphData(limit, entityTypeFilter || undefined, undefined);
      if (!mountedRef.current) return;
      dispatchGraph({ type: "SET", payload: data });
      setStats(data.stats || null);
    } catch (e) {
      if (mountedRef.current) {
        toast.error(t("knowledge.loadFailed"), { description: e instanceof Error ? e.message : String(e) });
        dispatchGraph({ type: "SET", payload: { nodes: [], edges: [], stats: { totalEntities: 0, totalRelations: 0, entitiesByType: {}, relationsByType: {} } } });
        setStats(null);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [limit, entityTypeFilter]);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  const graphDataForViz = useMemo(() => {
    if (!graphData?.nodes?.length) return { nodes: [], links: [] };
    const nodes = graphData.nodes.map((n) => ({
      ...n,
      id: n.id,
      name: n.label || n.id,
      type: n.type,
      _degree: 0,
    }));
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const linkCount = new Map<string, number>();
    for (const n of nodes) linkCount.set(n.id, 0);
    const links = (graphData.edges || []).map((e: GraphEdge) => {
      const src = nodeMap.get(e.source);
      const tgt = nodeMap.get(e.target);
      if (!src || !tgt) return null;
      linkCount.set(e.source, (linkCount.get(e.source) ?? 0) + 1);
      linkCount.set(e.target, (linkCount.get(e.target) ?? 0) + 1);
      return { source: src, target: tgt, id: e.id, type: e.type || e.label, label: e.label || e.type };
    }).filter(Boolean) as Array<{ source: typeof nodes[0]; target: typeof nodes[0]; id: string; type?: string; label?: string }>;
    nodes.forEach((n) => { n._degree = linkCount.get(n.id) ?? 0; });
    return { nodes, links };
  }, [graphData]);

  const searchMatchIds = useMemo(() => {
    if (!searchQueryDeferred.trim() || !graphData?.nodes?.length) return new Set<string>();
    const q = searchQueryDeferred.toLowerCase();
    return new Set(
      graphData.nodes
        .filter((n) => (n.label || n.id).toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
        .map((n) => n.id)
    );
  }, [graphData?.nodes, searchQueryDeferred]);

  const handleNodeClick = useCallback(
    (node: { id: string; name?: string; type?: string; [k: string]: unknown } | null) => {
      if (!node) {
        setSelectedNode(null);
        onNodeSelect?.(null);
        return;
      }
      const gn: GraphNode = {
        id: node.id,
        label: (node.name as string) || node.id,
        type: (node.type as string) || "other",
        properties: (node.properties as Record<string, unknown>) || {},
        size: node.size as number | undefined,
        mentionCount: node.mentionCount as number | undefined,
      };
      setSelectedNode(gn);
      onNodeSelect?.(gn);
    },
    [onNodeSelect]
  );

  const handleNodeDoubleClick = useCallback(
    async (node: { id: string; name?: string; type?: string }) => {
      if (!node?.id) return;
      setSubgraphLoading(true);
      try {
        const sub = await knowledgeAPI.getSubgraph(node.id, 2, 100);
        if (sub?.nodes?.length || sub?.edges?.length) {
          dispatchGraph({ type: "PUSH_AND_SET", payload: sub });
          toast.success(`已展开「${(node.name as string) || node.id}」的邻居子图`);
        }
      } catch (e) {
        toast.error(t("knowledge.subgraphLoadFailed"), { description: e instanceof Error ? e.message : String(e) });
      } finally {
        setSubgraphLoading(false);
      }
    },
    [dispatchGraph]
  );

  const handleBack = useCallback(() => {
    dispatchGraph({ type: "BACK" });
  }, [dispatchGraph]);

  const zoomIn = () => graphRef.current?.zoom(1.5, 300);
  const zoomOut = () => graphRef.current?.zoom(0.67, 300);
  const centerView = () => {
    if (graphRef.current?.zoomToFit) {
      graphRef.current.zoomToFit(300, 20);
    } else if (graphRef.current) {
      graphRef.current.centerAt(0, 0, 300);
    }
  };

  if (loading) {
    return (
      <div className={`flex items-center justify-center min-h-[320px] ${className}`}>
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const hasData = graphDataForViz.nodes.length > 0;

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {showToolbar && (
        <div className="flex items-center gap-2 py-2 border-b flex-wrap">
          <Input
            placeholder="搜索节点..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="max-w-[200px] h-8"
          />
          <Button variant="outline" size="sm" onClick={loadGraph}>
            <RefreshCw className="h-4 w-4 mr-1" />
            刷新
          </Button>
          <Button variant="outline" size="sm" onClick={zoomIn}>
            <ZoomIn className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={zoomOut}>
            <ZoomOut className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={centerView} title={t("knowledge.fitCanvas")}>
            <Maximize2 className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleBack}
            disabled={graphHistory.length === 0}
            title={t("knowledge.backView")}
            className={graphHistory.length === 0 ? "opacity-50 pointer-events-none" : undefined}
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            返回
          </Button>
          {stats && (
            <span className="text-xs text-muted-foreground ml-2">
              {stats.totalEntities} 节点 · {stats.totalRelations ?? graphDataForViz.links.length} 边
            </span>
          )}
        </div>
      )}
      {showToolbar && hasData && (
        <div className="flex flex-wrap gap-2 px-2 py-1 border-b text-xs items-center">
          <span className="text-muted-foreground">{t('knowledge.graphTypeLabel')}:</span>
          {Object.entries(ENTITY_TYPE_COLORS).map(([type, color]) => (
            <span key={type} className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
              <span>{type}</span>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 relative">
          {subgraphLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/60 z-10">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {hasData ? (
            <ForceGraph2DWrapper
              graphData={graphDataForViz}
              onNodeClick={handleNodeClick}
              onNodeDoubleClick={handleNodeDoubleClick}
              onNodeHover={setHoverNodeId}
              hoverNodeId={hoverNodeId}
              searchMatchIds={searchMatchIds}
              nodeColor={nodeColor}
              graphRef={graphRef}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
              {t('knowledge.graphEmpty')}
            </div>
          )}
        </div>
        {selectedNode && (
          <ScrollArea className="w-64 border-l bg-muted/30 p-3">
            <div className="space-y-2">
              <div className="font-medium truncate" title={selectedNode.label}>
                {selectedNode.label}
              </div>
              <div className="text-xs text-muted-foreground">
                {t('knowledge.graphTypeLabel')}: {selectedNode.type}
              </div>
              {selectedNode.mentionCount != null && (
                <div className="text-xs">提及: {selectedNode.mentionCount}</div>
              )}
              {selectedNode.properties && Object.keys(selectedNode.properties).length > 0 && (
                <div className="text-xs">
                  <div className="font-medium mb-1">属性</div>
                  <pre className="whitespace-pre-wrap break-all text-xs">
                    {JSON.stringify(selectedNode.properties, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

const DBL_CLICK_MS = 400;

/** 包装 ForceGraph2D，动态 import 以支持未安装时降级 */
const ForceGraph2DWrapper = React.memo(function ForceGraph2DWrapper({
  graphData,
  onNodeClick,
  onNodeDoubleClick,
  onNodeHover,
  hoverNodeId,
  searchMatchIds,
  nodeColor,
  graphRef,
}: {
  graphData: { nodes: Array<{ id: string; name?: string; type?: string; _degree?: number; [k: string]: unknown }>; links: Array<{ source: { id: string }; target: { id: string }; id?: string; type?: string; label?: string }> };
  onNodeClick: (node: unknown) => void;
  onNodeDoubleClick?: (node: { id: string; name?: string; type?: string }) => void;
  onNodeHover?: (id: string | null) => void;
  hoverNodeId: string | null;
  searchMatchIds: Set<string>;
  nodeColor: (node: { type?: string }) => string;
  graphRef: React.MutableRefObject<{ zoom: (n: number, duration?: number) => void; centerAt: (x: number, y: number, duration?: number) => void; zoomToFit?: (duration?: number, padding?: number) => void } | null>;
}) {
  const lastClickRef = useRef<{ id: string; node: { id: string; name?: string; type?: string }; t: number } | null>(null);

  const handleClick = useCallback(
    (node: unknown) => {
      const n = node as { id: string; name?: string; type?: string } | null;
      if (!n) {
        onNodeClick(null);
        lastClickRef.current = null;
        return;
      }
      const now = Date.now();
      const prev = lastClickRef.current;
      if (prev && prev.id === n.id && now - prev.t < DBL_CLICK_MS && onNodeDoubleClick) {
        onNodeDoubleClick(n);
        lastClickRef.current = null;
        return;
      }
      lastClickRef.current = { id: n.id, node: n, t: now };
      onNodeClick(node);
    },
    [onNodeClick, onNodeDoubleClick]
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [ForceGraph2D, setForceGraph2D] = useState<React.ComponentType<any> | null>(null);

  useEffect(() => {
    let cancelled = false;
    import("react-force-graph-2d").then((mod) => {
      if (!cancelled) {
        setForceGraph2D(() => mod.default);
      }
    }).catch(() => {
      if (!cancelled) {
        setForceGraph2D(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const neighborIds = useMemo(() => {
    if (!hoverNodeId) return new Set<string>();
    const set = new Set<string>();
    for (const l of graphData.links) {
      const sid = typeof l.source === "object" ? (l.source as { id: string }).id : l.source;
      const tid = typeof l.target === "object" ? (l.target as { id: string }).id : l.target;
      if (sid === hoverNodeId) set.add(tid);
      if (tid === hoverNodeId) set.add(sid);
    }
    return set;
  }, [hoverNodeId, graphData.links]);

  const nodeColorWithHover = useCallback(
    (node: { id?: string; type?: string }) => {
      const base = nodeColor(node);
      if (!hoverNodeId || !node.id) return base;
      if (node.id === hoverNodeId || neighborIds.has(node.id)) return base;
      return dimHex(base, "40");
    },
    [nodeColor, hoverNodeId, neighborIds]
  );

  const nodeColorWithSearch = useCallback(
    (node: { id?: string; type?: string }) => {
      const c = nodeColorWithHover(node);
      if (searchMatchIds.size > 0 && node.id && !searchMatchIds.has(node.id)) {
        return dimHex(c, "50");
      }
      return c;
    },
    [nodeColorWithHover, searchMatchIds]
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 600, height: 400 });

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0]?.contentRect ?? { width: 600, height: 400 };
      setSize({ width, height });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const handleNodeHover = useCallback(
    (node: unknown) => {
      onNodeHover?.(node ? (node as { id: string }).id : null);
    },
    [onNodeHover]
  );

  const handleNodeDragEnd = useCallback((node: unknown) => {
    const n = node as { x?: number; y?: number; fx?: number; fy?: number };
    if (n != null) {
      n.fx = n.x;
      n.fy = n.y;
    }
  }, []);

  const nodeValCb = useCallback((node: unknown) => {
    const n = node as { _degree?: number };
    return 2 + Math.min(6, n._degree ?? 0);
  }, []);

  const nodeLabelCb = useCallback((node: { id?: string; name?: string }) => node.name ?? node.id ?? "", []);
  const linkLabelCb = useCallback(
    (link: unknown) =>
      (link as { type?: string; label?: string }).type || (link as { label?: string }).label || "",
    []
  );

  if (!ForceGraph2D) {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
        加载图谱组件中…
      </div>
    );
  }

  return (
    <div ref={containerRef} className="absolute inset-0">
      <ForceGraph2D
        ref={graphRef as React.RefObject<unknown>}
        graphData={graphData}
        onNodeClick={handleClick}
        onNodeHover={handleNodeHover}
        onNodeDragEnd={handleNodeDragEnd}
        nodeColor={nodeColorWithSearch}
        nodeVal={nodeValCb}
        nodeLabel={nodeLabelCb}
        linkLabel={linkLabelCb}
        linkDirectionalArrowLength={4}
        linkDirectionalParticles={0}
        width={size.width}
        height={size.height}
      />
    </div>
  );
});

export default KnowledgeGraphView;
