/**
 * 知识库管理面板
 * 
 * 设计原则（参考 Cursor/Claude）：
 * - 左边栏只显示用户自己的知识库（类似 Cursor 的项目文件）
 * - 团队/领域/系统知识库对用户透明，Agent 自动使用
 * - 用户只需要管理自己的文档，简化体验
 * 
 * 功能：
 * - 浏览用户知识库文件结构
 * - 上传/删除文档
 * - 搜索知识库（向量检索）
 * - 刷新索引
 * 
 * 使用场景：
 * - 主编辑页面左边栏的知识库文件列表（只显示用户知识库）
 * - 独立的知识库主页面（可选择性显示团队知识库）
 */
import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Badge } from "./ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./ui/tabs";
import { FileText, Plus, Search, FolderOpen, Folder, ChevronRight, ChevronDown, RefreshCw, MoreVertical, Copy, Upload, Trash2, Loader2, Info, Database, File as FileIcon, Network, Download, Link, Cloud, X } from "lucide-react";
import { KnowledgeGraphView } from "./KnowledgeGraphView";
import { getItem as getStorageItem } from "../lib/safeStorage";
import { DEFAULT_ROLE_ID, getScopedActiveRoleIdFromStorage } from "../lib/roleIdentity";
import { knowledgeAPI, type KBItem, type KBStructure, type SearchResult, type OntologyEntity, type OntologyRelation, type GraphStats, getKnowledgePath } from "../lib/api/knowledge";
import { modelsApi } from "../lib/api/modelsApi";
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip as RechartsTooltip } from "recharts";
import { skillsAPI, type SkillProfile, type SkillItem, type MarketSkillItem, type SkillUpdateItem, type SkillTrialItem, type SkillDemoRunResult } from "../lib/api/skillsApi";
import { isHandledApiError } from "../lib/api/errorHandler";
import { getApiUrl } from "../lib/api/langserveChat";
import { getLicenseTier, licenseTierRank } from "../lib/licenseTier";
import { EVENTS } from "../lib/constants";
import type { ContextItem } from "../types/context";
import { t } from "../lib/i18n";
import { toast } from "sonner";
import { ScrollArea } from "./ui/scroll-area";
import { useUserContext } from "../lib/hooks/useUserContext";
import { getCurrentWorkspacePathFromStorage, getCurrentThreadIdFromStorage } from "../lib/sessionState";
import { fileEventBus } from "../lib/events/fileEvents";
import { ComparisonUI } from "./ChatComponents/generative-ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import { Alert, AlertDescription } from "./ui/alert";

/** 文件扩展名 -> 图标（模块级，避免每次 getFileIcon 重建） */
const FILE_ICON_MAP: Record<string, React.ReactNode> = {
  ts: <FileIcon className="h-4 w-4 text-blue-500" />,
  tsx: <FileIcon className="h-4 w-4 text-blue-500" />,
  js: <FileIcon className="h-4 w-4 text-yellow-500" />,
  jsx: <FileIcon className="h-4 w-4 text-yellow-500" />,
  py: <FileIcon className="h-4 w-4 text-green-500" />,
  json: <FileIcon className="h-4 w-4 text-amber-500" />,
  md: <FileText className="h-4 w-4 text-slate-500" />,
  txt: <FileText className="h-4 w-4 text-slate-500" />,
};

/** 文件树节点（ memo 避免每节点新建闭包） */
const FileTreeNode = React.memo(function FileTreeNode({
  item,
  depth,
  isExpanded,
  isLoading,
  children: childItems,
  onFolderToggle,
  onOpenFile,
  renderChild,
}: {
  item: { name: string; path: string; type: 'file' | 'folder' };
  depth: number;
  isExpanded: boolean;
  isLoading: boolean;
  children: Array<{ name: string; path: string; type: 'file' | 'folder' }>;
  onFolderToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  renderChild: (child: { name: string; path: string; type: 'file' | 'folder' }, childDepth: number) => React.ReactNode;
}) {
  const indent = depth * 12;
  const icon = item.type === 'folder'
    ? (isExpanded ? <FolderOpen className="h-4 w-4 text-amber-500" /> : <Folder className="h-4 w-4 text-amber-500" />)
    : (FILE_ICON_MAP[item.name.split('.').pop()?.toLowerCase() || ''] ?? <FileIcon className="h-4 w-4 text-slate-400" />);
  return (
    <div>
      <div
        className="group flex items-center gap-1 py-0.5 px-1 rounded cursor-pointer hover:bg-muted/50"
        style={{ paddingLeft: `${indent}px` }}
        onClick={() => {
          if (item.type === 'folder') onFolderToggle(item.path);
          else onOpenFile(item.path);
        }}
      >
        {item.type === 'folder' ? (
          <button
            onClick={(e) => { e.stopPropagation(); onFolderToggle(item.path); }}
            className="shrink-0 p-0.5 hover:bg-muted rounded"
          >
            {isExpanded ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
          </button>
        ) : (
          <span className="w-4" />
        )}
        <span className="shrink-0">{icon}</span>
        <span className="flex-1 truncate text-xs">{item.name}</span>
        {isLoading && <RefreshCw className="h-3 w-3 text-muted-foreground animate-spin" />}
        {item.type === 'file' && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button onClick={(e) => e.stopPropagation()} className="shrink-0 opacity-0 group-hover:opacity-100 p-0.5 hover:bg-muted rounded transition-opacity">
                <MoreVertical className="h-3 w-3 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="right" className="min-w-[140px]">
              <DropdownMenuItem onClick={() => onOpenFile(item.path)}>
                <FileText className="h-3.5 w-3.5 mr-2" />打开
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { navigator.clipboard.writeText(item.path); toast.success(t("knowledge.pathCopied")); }}>
                <Copy className="h-3.5 w-3.5 mr-2" />复制路径
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {item.type === 'folder' && isExpanded && (
        <div>
          {isLoading ? (
            <div className="pl-6 text-xs text-muted-foreground py-1 flex items-center gap-1">
              <RefreshCw className="h-3 w-3 animate-spin" /><span>{t("common.loading")}</span>
            </div>
          ) : childItems.length > 0 ? (
            childItems.map((child) => <React.Fragment key={child.path}>{renderChild(child, depth + 1)}</React.Fragment>)
          ) : (
            <div className="pl-6 text-xs text-muted-foreground/60 py-1">空文件夹</div>
          )}
        </div>
      )}
    </div>
  );
});

interface KnowledgeBasePanelProps {
  /** 文件打开回调 */
  onFileOpen?: (path: string, content: string) => void;
  /** 左侧栏嵌入模式：展示精简信息，降低认知负担 */
  sidebarMode?: boolean;
  /** 初始激活的 Tab（如 "skills" 用于结晶 Toast 跳转） */
  initialTab?: string;
  /** 结晶建议跳转时传入的技能名，会切换到技能市场并预填草稿名称 */
  initialCrystallizationSkillName?: string;
  /** 在编辑区打开整体知识图谱（虚拟 Tab） */
  onOpenKnowledgeGraphInEditor?: () => void;
}

/** 搜索标签页子组件：检索 + 文档结构弹窗 */
function SearchPanel({
  searchQuery,
  setSearchQuery,
  searchResults,
  loading,
  hasSearched,
  onSearch,
  onOpenDocmap,
  docmapData,
  showDocmapDialog,
  setShowDocmapDialog,
  docmapLoading,
  onFileOpen,
}: {
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  searchResults: SearchResult[];
  loading: boolean;
  hasSearched: boolean;
  onSearch: () => void;
  onOpenDocmap: (source: string) => void;
  docmapData: { path: string; name: string; sections: Array<{ title: string; line: number; level: number }> } | null;
  showDocmapDialog: boolean;
  setShowDocmapDialog: (v: boolean) => void;
  docmapLoading: boolean;
  onFileOpen?: (path: string, content: string) => void;
}) {
  const extractScopeMeta = (result: SearchResult): { workspaceId?: string; threadId?: string } => {
    const md = (result.metadata && typeof result.metadata === "object")
      ? (result.metadata as Record<string, unknown>)
      : {};
    const workspaceId = String(md.workspace_id || "").trim() || undefined;
    const threadId = String(md.thread_id || "").trim() || undefined;
    return { workspaceId, threadId };
  };

  const handleOpenSourceThread = (threadId?: string, prompt?: string) => {
    const target = String(threadId || "").trim();
    if (!target) return;
    window.dispatchEvent(new CustomEvent(EVENTS.OPEN_CHAT_PANEL));
    window.dispatchEvent(new CustomEvent(EVENTS.SWITCH_TO_THREAD, { detail: { threadId: target } }));
    if (prompt) {
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent(EVENTS.FILL_PROMPT, {
            detail: { prompt, autoSend: false, threadId: target },
          }),
        );
      }, 120);
    }
  };

  const handleOpenDocument = async () => {
    if (!docmapData || !onFileOpen) return;
    try {
      const doc = await knowledgeAPI.getDocument(docmapData.path);
      onFileOpen(docmapData.path, doc.content ?? "");
      setShowDocmapDialog(false);
    } catch (e) {
      toast.error(t("knowledge.openDocFailed"), { description: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <>
      <div className="space-y-4">
        <div className="flex gap-2">
          <Input
            placeholder="搜索知识库..."
            value={searchQuery}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && onSearch()}
          />
          <Button onClick={onSearch} disabled={loading}>
            <Search className="h-4 w-4" />
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <div className="space-y-3 pr-2">
            {searchResults.length === 0 && !loading && (
              <p className="text-sm text-muted-foreground py-4">
                {hasSearched
                  ? `未找到与 "${searchQuery}" 相关的内容，请换个关键词。需要基于知识库问答请在主聊天区提问。`
                  : "输入关键词搜索知识库内容；需要基于知识库问答请在主聊天区提问。"}
              </p>
            )}
            {searchResults.map((result, idx) => {
              const scoped = extractScopeMeta(result);
              return (
                <Card key={idx} className="overflow-hidden group">
                  <CardContent className="p-3">
                    <p className="text-sm line-clamp-4">{result.content}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {result.source && (
                        <span className="truncate max-w-[200px]" title={result.source}>
                          来源: {result.source.split("/").slice(-2).join("/")}
                        </span>
                      )}
                      {typeof result.score === "number" && (
                        <Badge variant="secondary" className="text-xs font-normal">
                          {(result.score * 100).toFixed(0)}% 相关
                        </Badge>
                      )}
                      {result.metadata && typeof result.metadata === "object" && (
                        <>
                          {(result.metadata as Record<string, unknown>).file_name && (
                            <span>{(result.metadata as Record<string, unknown>).file_name as string}</span>
                          )}
                          {(result.metadata as Record<string, unknown>).resource_type && (
                            <span>{(result.metadata as Record<string, unknown>).resource_type as string}</span>
                          )}
                          {(result.metadata as Record<string, unknown>).source_scope && (
                            <Badge variant="secondary" className="text-[10px] font-normal">
                              {String((result.metadata as Record<string, unknown>).source_scope)}
                            </Badge>
                          )}
                          {scoped.workspaceId && (
                            <Badge variant="outline" className="text-[10px] font-normal">
                              ws:{scoped.workspaceId}
                            </Badge>
                          )}
                          {scoped.threadId && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 text-xs"
                              onClick={() =>
                                handleOpenSourceThread(
                                  scoped.threadId,
                                  `基于这条知识检索结果继续分析：\n${result.content.slice(0, 300)}`,
                                )
                              }
                            >
                              打开来源会话
                            </Button>
                          )}
                        </>
                      )}
                      {result.source && (
                        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => onOpenDocmap(result.source)}>
                          文档结构
                        </Button>
                      )}
                      {result.source && (
                        <button
                          type="button"
                          title="添加到对话上下文"
                          onClick={() => {
                            window.dispatchEvent(new CustomEvent(EVENTS.ADD_FILE_TO_CONTEXT, { detail: { path: result.source! } }));
                          }}
                          className="opacity-0 group-hover:opacity-100 h-6 w-6 rounded flex items-center justify-center text-muted-foreground hover:text-emerald-500 transition-all shrink-0"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </ScrollArea>
      </div>
      <Dialog open={showDocmapDialog} onOpenChange={setShowDocmapDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>文档结构</DialogTitle>
            <DialogDescription>{docmapData ? docmapData.name : "章节与跳转"}</DialogDescription>
          </DialogHeader>
          {docmapLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : docmapData ? (
            <>
              <ScrollArea className="max-h-64 border rounded-md p-2">
                <ul className="space-y-1 text-sm">
                  {docmapData.sections.map((s, i) => (
                    <li key={i} className="py-0.5" style={{ paddingLeft: `${(s.level - 1) * 12}px` }}>
                      {s.title}
                      <span className="text-muted-foreground ml-1 text-xs">L{s.line}</span>
                    </li>
                  ))}
                </ul>
                {docmapData.sections.length === 0 && <p className="text-muted-foreground text-xs">无章节标题</p>}
              </ScrollArea>
              {onFileOpen && (
                <Button variant="outline" size="sm" className="mt-2" onClick={handleOpenDocument}>
                  <FileText className="h-4 w-4 mr-1" />
                  打开文档
                </Button>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground py-4">未加载到结构数据</p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** 本体管理对话框：列表/查看实体与关系，支持增删改 */
function OntologyManageDialog({
  open,
  onOpenChange,
  onOpenInEditor,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 在编辑区打开知识图谱（关闭对话框并在编辑区显示） */
  onOpenInEditor?: () => void;
}) {
  const [metadata, setMetadata] = useState<{ entity_count: number; relation_count: number } | null>(null);
  const [kbMetrics, setKbMetrics] = useState<{ ontology_build_triggered: number; ontology_build_success_rate: number | null } | null>(null);
  const [entities, setEntities] = useState<OntologyEntity[]>([]);
  const [relations, setRelations] = useState<OntologyRelation[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'entities' | 'relations' | 'graph' | 'stats'>('graph');
  const [graphStats, setGraphStats] = useState<GraphStats | null>(null);
  const [validationResult, setValidationResult] = useState<{ valid: boolean; issues: string[] } | null>(null);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importJson, setImportJson] = useState('');
  const [importing, setImporting] = useState(false);
  const [newEntityName, setNewEntityName] = useState('');
  const [newEntityType, setNewEntityType] = useState('');
  const [newRelSource, setNewRelSource] = useState('');
  const [newRelTarget, setNewRelTarget] = useState('');
  const [newRelType, setNewRelType] = useState('');
  const ontologyMountedRef = useRef(true);

  useEffect(() => {
    ontologyMountedRef.current = true;
    return () => { ontologyMountedRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    if (ontologyMountedRef.current) setLoading(true);
    try {
      const [metaRes, entRes, relRes, metricsRes] = await Promise.all([
        knowledgeAPI.getMetadata(),
        knowledgeAPI.getOntologyEntities(),
        knowledgeAPI.getOntologyRelations(),
        knowledgeAPI.getMetrics().catch(() => null),
      ]);
      if (!ontologyMountedRef.current) return;
      setMetadata({ entity_count: metaRes.entity_count, relation_count: metaRes.relation_count });
      setEntities(entRes.entities || []);
      setRelations(relRes.relations || []);
      if (metricsRes?.success && metricsRes.metrics) {
        setKbMetrics({
          ontology_build_triggered: metricsRes.metrics.ontology_build_triggered ?? 0,
          ontology_build_success_rate: metricsRes.ontology_build_success_rate ?? null,
        });
      } else {
        setKbMetrics(null);
      }
    } catch (e) {
      if (ontologyMountedRef.current) {
        toast.error(t("knowledge.loadOntologyFailed"), { description: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      if (ontologyMountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  useEffect(() => {
    if (open && activeTab === 'stats') {
      (async () => {
        try {
          const [stats, validation] = await Promise.all([
            knowledgeAPI.getGraphStats(),
            knowledgeAPI.validateOntology(),
          ]);
          if (!ontologyMountedRef.current) return;
          setGraphStats(stats);
          setValidationResult({
            valid: validation.valid,
            issues: validation.issues || [],
          });
        } catch {
          if (ontologyMountedRef.current) {
            setGraphStats(null);
            setValidationResult(null);
          }
        }
      })();
    }
  }, [open, activeTab]);

  const handleBatchImport = async () => {
    let payload: { entities?: OntologyEntity[]; relations?: OntologyRelation[] };
    try {
      payload = JSON.parse(importJson) as { entities?: OntologyEntity[]; relations?: OntologyRelation[] };
    } catch {
      toast.error(t("knowledge.jsonInvalid"));
      return;
    }
    if (!payload.entities?.length && !payload.relations?.length) {
      toast.error(t("knowledge.provideEntitiesOrRelations"));
      return;
    }
    setImporting(true);
    try {
      const res = await knowledgeAPI.importOntology({
        entities: payload.entities,
        relations: payload.relations?.filter(
          (r): r is { source: string; target: string; type?: string } => Boolean(r.source && r.target)
        ),
      });
      toast.success(`已导入 ${res.entitiesAdded} 个实体、${res.relationsAdded} 条关系`);
      if (res.errors?.length) toast.warning(res.errors.slice(0, 3).join('；'));
      setShowImportDialog(false);
      setImportJson('');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '导入失败');
    } finally {
      setImporting(false);
    }
  };

  const handleAddEntity = async () => {
    const name = newEntityName.trim() || undefined;
    const type = newEntityType.trim() || undefined;
    if (!name && !type) {
      toast.error(t("knowledge.fillNameOrType"));
      return;
    }
    try {
      await knowledgeAPI.createOntologyEntity({ name, type });
      toast.success(t("knowledge.entityAdded"));
      setNewEntityName('');
      setNewEntityType('');
      load();
    } catch (e) {
      toast.error(t("knowledge.addEntityFailed"), { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleDeleteEntity = async (entityId: string) => {
    try {
      await knowledgeAPI.deleteOntologyEntity(entityId);
      toast.success(t("knowledge.deleted"));
      load();
    } catch (e) {
      toast.error(t("knowledge.deleteFailed"), { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleAddRelation = async () => {
    const source = newRelSource.trim();
    const target = newRelTarget.trim();
    const type = newRelType.trim();
    if (!source || !target) {
      toast.error(t("knowledge.fillSourceAndTarget"));
      return;
    }
    try {
      await knowledgeAPI.createOntologyRelation({ source, target, type: type || undefined });
      toast.success(t("knowledge.relationAdded"));
      setNewRelSource('');
      setNewRelTarget('');
      setNewRelType('');
      load();
    } catch (e) {
      toast.error(t("knowledge.addRelationFailed"), { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleDeleteRelation = async (index: number) => {
    try {
      await knowledgeAPI.deleteOntologyRelation(index);
      toast.success(t("knowledge.deleted"));
      load();
    } catch (e) {
      toast.error(t("knowledge.deleteFailed"), { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <DialogTitle>本体管理</DialogTitle>
              <DialogDescription>知识图谱实体与关系，可增删改。</DialogDescription>
            </div>
            {onOpenInEditor && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => {
                  onOpenInEditor();
                  onOpenChange(false);
                }}
              >
                在编辑区打开
              </Button>
            )}
          </div>
        </DialogHeader>
        {metadata && (
          <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
            <span>实体: {metadata.entity_count}</span>
            <span>关系: {metadata.relation_count}</span>
            {kbMetrics != null && (
              <span>构建触发: {kbMetrics.ontology_build_triggered} 次{kbMetrics.ontology_build_success_rate != null ? `，成功率 ${Math.round(kbMetrics.ontology_build_success_rate * 100)}%` : ''}</span>
            )}
          </div>
        )}
        <div className="flex items-center gap-2 border-b flex-wrap">
          <button
            type="button"
            className={`px-3 py-1.5 text-sm ${activeTab === 'graph' ? 'border-b-2 border-primary font-medium' : ''}`}
            onClick={() => setActiveTab('graph')}
          >
            图谱
          </button>
          <button
            type="button"
            className={`px-3 py-1.5 text-sm ${activeTab === 'entities' ? 'border-b-2 border-primary font-medium' : ''}`}
            onClick={() => setActiveTab('entities')}
          >
            实体
          </button>
          <button
            type="button"
            className={`px-3 py-1.5 text-sm ${activeTab === 'relations' ? 'border-b-2 border-primary font-medium' : ''}`}
            onClick={() => setActiveTab('relations')}
          >
            关系
          </button>
          <button
            type="button"
            className={`px-3 py-1.5 text-sm ${activeTab === 'stats' ? 'border-b-2 border-primary font-medium' : ''}`}
            onClick={() => setActiveTab('stats')}
          >
            统计
          </button>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setShowImportDialog(true)}>
            批量导入
          </Button>
        </div>
        {loading && activeTab !== 'graph' ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {activeTab === 'graph' && (
              <div className="flex-1 min-h-[320px] flex flex-col overflow-hidden">
                <KnowledgeGraphView showToolbar={true} limit={300} />
              </div>
            )}
            {activeTab === 'entities' && (
              <div className="flex flex-col gap-2 overflow-auto">
                <div className="flex gap-2">
                  <Input
                    placeholder="名称"
                    value={newEntityName}
                    onChange={(e) => setNewEntityName(e.target.value)}
                    className="flex-1"
                  />
                  <Input
                    placeholder="类型"
                    value={newEntityType}
                    onChange={(e) => setNewEntityType(e.target.value)}
                    className="flex-1"
                  />
                  <Button size="sm" onClick={handleAddEntity}>添加</Button>
                </div>
                <ScrollArea className="h-48 border rounded-md p-2">
                  {entities.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("knowledge.noEntities")}</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {entities.map((e, i) => (
                        <li key={i} className="flex items-center justify-between gap-2">
                          <span>{e.name ?? e.id ?? JSON.stringify(e)}</span>
                          <span className="text-muted-foreground">{e.type}</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0 text-destructive"
                            onClick={() => handleDeleteEntity((e.id ?? e.name ?? String(i)) as string)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </ScrollArea>
              </div>
            )}
            {activeTab === 'relations' && (
              <div className="flex flex-col gap-2 overflow-auto">
                <div className="flex gap-2 flex-wrap">
                  <Input
                    placeholder="来源"
                    value={newRelSource}
                    onChange={(e) => setNewRelSource(e.target.value)}
                    className="w-24"
                  />
                  <Input
                    placeholder="类型"
                    value={newRelType}
                    onChange={(e) => setNewRelType(e.target.value)}
                    className="w-24"
                  />
                  <Input
                    placeholder="目标"
                    value={newRelTarget}
                    onChange={(e) => setNewRelTarget(e.target.value)}
                    className="w-24"
                  />
                  <Button size="sm" onClick={handleAddRelation}>添加</Button>
                </div>
                <ScrollArea className="h-48 border rounded-md p-2">
                  {relations.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("knowledge.noRelations")}</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {relations.map((r, i) => (
                        <li key={i} className="flex items-center justify-between gap-2">
                          <span>{r.source} — {r.type ?? '?'} — {r.target}</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0 text-destructive"
                            onClick={() => handleDeleteRelation(i)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </ScrollArea>
              </div>
            )}
            {activeTab === 'stats' && (
              <div className="flex flex-col gap-4 overflow-auto py-2">
                {graphStats ? (
                  <>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div className="rounded border p-2 bg-muted/30">
                        <span className="text-muted-foreground">实体总数</span>
                        <div className="font-medium">{graphStats.totalEntities}</div>
                      </div>
                      <div className="rounded border p-2 bg-muted/30">
                        <span className="text-muted-foreground">关系总数</span>
                        <div className="font-medium">{graphStats.totalRelations}</div>
                      </div>
                      <div className="rounded border p-2 bg-muted/30">
                        <span className="text-muted-foreground">关系密度</span>
                        <div className="font-medium">
                          {graphStats.totalEntities > 0
                            ? (graphStats.totalRelations / graphStats.totalEntities).toFixed(2)
                            : '0'} 关系/实体
                        </div>
                      </div>
                      <div className="rounded border p-2 bg-muted/30">
                        <span className="text-muted-foreground">孤立实体</span>
                        <div className="font-medium">{graphStats.isolatedEntitiesCount ?? 0}</div>
                      </div>
                    </div>
                    {Object.keys(graphStats.entitiesByType || {}).length > 0 && (
                      <div className="rounded border p-2">
                        <div className="text-xs font-medium text-muted-foreground mb-2">实体类型分布</div>
                        <ResponsiveContainer width="100%" height={200}>
                          <PieChart>
                            <Pie
                              data={Object.entries(graphStats.entitiesByType || {}).map(([name, value]) => ({ name, value }))}
                              dataKey="value"
                              nameKey="name"
                              cx="50%"
                              cy="50%"
                              outerRadius={70}
                              label={({ name, value }) => `${name}: ${value}`}
                            >
                              {Object.keys(graphStats.entitiesByType || {}).map((_, i) => (
                                <Cell key={i} fill={['#1890ff', '#52c41a', '#faad14', '#722ed1', '#13c2c2', '#eb2f96'][i % 6]} />
                              ))}
                            </Pie>
                            <RechartsTooltip />
                            <Legend />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
                    <Loader2 className="h-5 w-5 animate-spin mr-2" />
                    加载统计中...
                  </div>
                )}
                {validationResult !== null && (
                  <div className="rounded border p-2">
                    <div className="text-xs font-medium text-muted-foreground mb-1">一致性检查</div>
                    <div className={`text-sm ${validationResult.valid ? 'text-green-600' : 'text-amber-600'}`}>
                      {validationResult.valid ? '通过' : '存在问题'}
                    </div>
                    {validationResult.issues.length > 0 && (
                      <ul className="mt-1 text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
                        {validationResult.issues.slice(0, 10).map((issue, i) => (
                          <li key={i}>{issue}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => load()} disabled={loading}>刷新</Button>
          <Button onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={showImportDialog} onOpenChange={setShowImportDialog}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>批量导入</DialogTitle>
          <DialogDescription>
            粘贴 JSON：{"{ \"entities\": [{ \"name\", \"type\" }], \"relations\": [{ \"source\", \"target\", \"type\" }] }"}
          </DialogDescription>
        </DialogHeader>
        <textarea
          className="w-full h-40 rounded border border-input bg-background p-2 text-xs font-mono"
          placeholder='{"entities":[{"name":"示例","type":"PRODUCT"}],"relations":[{"source":"id1","target":"id2","type":"has_spec"}]}'
          value={importJson}
          onChange={(e) => setImportJson(e.target.value)}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowImportDialog(false)}>取消</Button>
          <Button onClick={handleBatchImport} disabled={importing}>
            {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
  );
}

/** 导入文件夹对话框：源路径、目标范围、操作勾选，提交后创建知识构建任务并在任务面板追踪 */
function ImportFolderDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [sourcePath, setSourcePath] = useState("");
  const [targetScope, setTargetScope] = useState("domain/bidding");
  const [opImport, setOpImport] = useState(true);
  const [opIndex, setOpIndex] = useState(true);
  const [opOntology, setOpOntology] = useState(true);
  const [opSkills, setOpSkills] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    const path = sourcePath.trim();
    const operations: string[] = [];
    if (opImport) operations.push("import");
    if (opIndex) operations.push("index");
    if (opOntology) operations.push("ontology");
    if (opSkills) operations.push("skills");
    if (operations.length === 0) {
      toast.error(t("knowledge.selectOneAction"));
      return;
    }
    if (opImport && !path) {
      toast.error(t("knowledge.selectImportPath"));
      return;
    }
    setLoading(true);
    try {
      const res = await knowledgeAPI.createBuildTask({
        source_path: path,
        target_scope: targetScope,
        operations,
      });
      const taskId = res.task_id;
      toast.success(t("knowledge.taskCreated"), {
        description: taskId ? `任务 ID: ${taskId}` : undefined,
        action: taskId
          ? {
              label: "查看任务",
              onClick: () => {
                window.dispatchEvent(
                  new CustomEvent(EVENTS.SWITCH_LEFT_PANEL, { detail: { tab: "tasks" as const } })
                );
                window.dispatchEvent(
                  new CustomEvent("open_task_in_editor", { detail: { taskId, subject: "知识构建" } })
                );
              },
            }
          : undefined,
      });
      onOpenChange(false);
      setSourcePath("");
    } catch (e) {
      toast.error(t("knowledge.createKbTaskFailed"), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>导入文件夹</DialogTitle>
          <DialogDescription>
            可选指定本地文件夹路径进行批量导入；或仅勾选「刷新索引」「构建本体」等对已有知识库执行后续步骤（此时源路径可留空）。任务在后台执行，可在任务面板查看进度。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label className="text-xs">源文件夹路径（勾选「导入文件」时必填）</Label>
            <Input
              value={sourcePath}
              onChange={(e) => setSourcePath(e.target.value)}
              placeholder="项目根或工作区内的绝对路径；仅做索引/本体时可留空"
              className="mt-1"
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              勾选导入时路径须在项目根或当前工作区内；未勾选导入时可留空
            </p>
          </div>
          <div>
            <Label className="text-xs">目标范围</Label>
            <select
              value={targetScope}
              onChange={(e) => setTargetScope(e.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="domain/sales">domain/sales（销售）</option>
              <option value="global/imported">global/imported</option>
              <option value="global/domain/sales">global/domain/sales</option>
            </select>
          </div>
          <div>
            <Label className="text-xs">执行步骤</Label>
            <div className="mt-1 flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={opImport} onChange={(e) => setOpImport(e.target.checked)} className="rounded" />
                导入文件
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={opIndex} onChange={(e) => setOpIndex(e.target.checked)} className="rounded" />
                刷新索引
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={opOntology} onChange={(e) => setOpOntology(e.target.checked)} className="rounded" />
                构建本体
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={opSkills} onChange={(e) => setOpSkills(e.target.checked)} className="rounded" />
                Skills
              </label>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            创建任务
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 构建本体对话框：选择目录与领域，触发后端构建 */
function BuildOntologyDialog({
  open,
  onOpenChange,
  onBuilt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBuilt?: () => void;
}) {
  const [directory, setDirectory] = useState("global/domain/sales/基础资料");
  const [domain, setDomain] = useState("sales");
  const [loading, setLoading] = useState(false);

  const handleBuild = async () => {
    if (!directory.trim()) {
      toast.error(t("knowledge.enterKbPath"));
      return;
    }
    setLoading(true);
    try {
      const result = await knowledgeAPI.buildOntology(directory.trim(), domain.trim());
      if (result.status === "completed" && result.stats) {
        const { filesProcessed, entitiesAdded, relationsAdded, errors } = result.stats;
        toast.success(t("knowledge.ontologyBuilt"), {
          description: `处理 ${filesProcessed} 个文件，新增实体 ${entitiesAdded}，关系 ${relationsAdded}${errors ? `，错误 ${errors}` : ""}`,
        });
        onOpenChange(false);
        onBuilt?.();
      } else {
        toast.error(result.error || "构建失败");
      }
    } catch (e) {
      toast.error(t("knowledge.buildOntologyFailed"), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>构建本体</DialogTitle>
          <DialogDescription>
            从知识库目录中提取实体与关系并写入本体（支持 .md、.txt、.pdf、.docx、.doc）。路径相对于知识库根目录。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label className="text-xs">目录路径</Label>
            <Input
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
              placeholder="例如 global/domain/sales/基础资料"
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-xs">领域</Label>
            <Input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="例如 bidding"
              className="mt-1"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleBuild} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            开始构建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function KnowledgeBasePanel({ onFileOpen, sidebarMode = false, initialTab, initialCrystallizationSkillName, onOpenKnowledgeGraphInEditor }: KnowledgeBasePanelProps) {
  const { userId, teamId } = useUserContext();
  const workspacePath = getCurrentWorkspacePathFromStorage();
  const [tabValue, setTabValue] = useState(initialTab ?? "files");
  useEffect(() => {
    if (initialTab) setTabValue(initialTab);
  }, [initialTab]);
  useEffect(() => {
    if (initialTab === "skills" && initialCrystallizationSkillName?.trim()) {
      setSkillsMarketplaceView(true);
      setDraftName(initialCrystallizationSkillName.trim());
    }
  }, [initialTab, initialCrystallizationSkillName]);

  // ✅ 新 API：使用 KBStructure 和 KBItem
  const [structure, setStructure] = useState<KBStructure | null>(null);
  const [selectedItem, setSelectedItem] = useState<KBItem | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [loadingOperations, setLoadingOperations] = useState<Set<string>>(new Set());
  const loading = loadingOperations.size > 0;
  const [searchLoading, setSearchLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  useEffect(() => {
    if (!searchQuery.trim()) setHasSearched(false);
  }, [searchQuery]);
  const [refreshing, setRefreshing] = useState(false);
  const [docmapData, setDocmapData] = useState<{ path: string; name: string; sections: Array<{ title: string; line: number; level: number }> } | null>(null);
  const [showDocmapDialog, setShowDocmapDialog] = useState(false);
  const [docmapLoading, setDocmapLoading] = useState(false);
  
  // 对话框状态
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [uploadBuildOntology, setUploadBuildOntology] = useState(false);
  const [pendingUploadFiles, setPendingUploadFiles] = useState<File[]>([]);
  const uploadFileInputRef = useRef<HTMLInputElement>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showOntologyDialog, setShowOntologyDialog] = useState(false);
  const [showBuildOntologyDialog, setShowBuildOntologyDialog] = useState(false);
  const [showImportFolderDialog, setShowImportFolderDialog] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [itemToDelete, setItemToDelete] = useState<KBItem | null>(null);

  // 知识库结构 scope：个人 / 团队 / 全局
  const [structureScope, setStructureScope] = useState<'users' | 'teams' | 'global'>('users');

  // 技能管理
  const [skillProfiles, setSkillProfiles] = useState<SkillProfile[]>([]);
  const [skillProfilesLoading, setSkillProfilesLoading] = useState(false);
  const [skillProfileId, setSkillProfileId] = useState<string>('full');
  const [skillsList, setSkillsList] = useState<SkillItem[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [showDraftDialog, setShowDraftDialog] = useState(false);
  const [showDeleteSkillDialog, setShowDeleteSkillDialog] = useState(false);
  const [skillToDelete, setSkillToDelete] = useState<SkillItem | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftSteps, setDraftSteps] = useState('');
  const [draftQualityTier, setDraftQualityTier] = useState<"core" | "pro" | "enterprise" | "community">("core");
  const [skillsMarketplaceView, setSkillsMarketplaceView] = useState(false);
  const [allSkillsForMarketplace, setAllSkillsForMarketplace] = useState<SkillItem[]>([]);
  const [allSkillsLoading, setAllSkillsLoading] = useState(false);
  const [marketSkills, setMarketSkills] = useState<MarketSkillItem[]>([]);
  const [marketSkillsLoading, setMarketSkillsLoading] = useState(false);
  const [marketSourceType, setMarketSourceType] = useState<string>("local");
  const [marketTierFilter, setMarketTierFilter] = useState<"all" | "free" | "pro" | "enterprise">("all");
  const [activeRoleId, setActiveRoleId] = useState<string>(() =>
    typeof window !== "undefined" ? getScopedActiveRoleIdFromStorage() : DEFAULT_ROLE_ID
  );
  const [showInstallSkillDialog, setShowInstallSkillDialog] = useState(false);
  const [showSkillCompareDialog, setShowSkillCompareDialog] = useState(false);
  const [compareQuery, setCompareQuery] = useState("请给出该任务的执行步骤与风险提示。");
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareTarget, setCompareTarget] = useState<MarketSkillItem | null>(null);
  const [compareResult, setCompareResult] = useState<SkillDemoRunResult | null>(null);
  const [expandedMarketPreviewKey, setExpandedMarketPreviewKey] = useState<string | null>(null);
  const [installSkillUrl, setInstallSkillUrl] = useState("");
  const [installSkillContent, setInstallSkillContent] = useState("");
  const [installSkillName, setInstallSkillName] = useState("");
  const [installSkillDomain, setInstallSkillDomain] = useState("general");
  const [installSkillVersion, setInstallSkillVersion] = useState<string | undefined>(undefined);
  const [installSkillMarketId, setInstallSkillMarketId] = useState<string | undefined>(undefined);
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null);
  const [skillTrials, setSkillTrials] = useState<SkillTrialItem[]>([]);
  const [skillTrialsLoading, setSkillTrialsLoading] = useState(false);
  const [trialLimits, setTrialLimits] = useState<{ window_days: number; max_trials: number; used_in_window: number; remaining: number } | null>(null);
  const [skillUpdates, setSkillUpdates] = useState<SkillUpdateItem[]>([]);
  const [updatesLoading, setUpdatesLoading] = useState(false);
  // 知识库同步状态
  const [syncStatus, setSyncStatus] = useState<{
    last_sync_ts: number | null;
    cloud_version: string | null;
    expired: boolean;
    cached: boolean;
  } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncStatusLoading, setSyncStatusLoading] = useState(false);
  const [syncStatusError, setSyncStatusError] = useState<string | null>(null);
  const [embeddingAvailable, setEmbeddingAvailable] = useState<boolean | null>(null);
  const groupedSkillsByDomain = useMemo(() => {
    const byDomain: Record<string, SkillItem[]> = {};
    for (const s of allSkillsForMarketplace) {
      const domain = s.domain || '通用';
      if (!byDomain[domain]) byDomain[domain] = [];
      byDomain[domain].push(s);
    }
    return { byDomain, domains: Object.keys(byDomain).sort() };
  }, [allSkillsForMarketplace]);
  const recommendedMarketSkills = useMemo(() => {
    if (!marketSkills.length) return [];
    const roleDomainMap: Record<string, string[]> = {
      default: ["general", "office", "analytics", "analyst", "contract", "sales"],
      knowledge_builder: ["knowledge", "ontology"],
    };
    const domains = roleDomainMap[activeRoleId] || [];
    if (!domains.length) return marketSkills.slice(0, 3);
    const matched = marketSkills.filter((s) => domains.includes(String(s.domain || "").toLowerCase()));
    return (matched.length ? matched : marketSkills).slice(0, 4);
  }, [activeRoleId, marketSkills]);
  const filteredMarketSkills = useMemo(() => {
    if (marketTierFilter === "all") return marketSkills;
    return marketSkills.filter((s) => {
      const tier = String(s.requires_tier || "").trim().toLowerCase();
      if (marketTierFilter === "free") return tier === "free" || tier === "community" || tier === "";
      return tier === marketTierFilter;
    });
  }, [marketSkills, marketTierFilter]);
  const [currentLicenseTier, setCurrentLicenseTier] = useState<string>(() => getLicenseTier());
  const isTierAllowed = useCallback((requiresTier?: string) => {
    const required = String(requiresTier || "").trim().toLowerCase();
    if (!required || required === "free" || required === "community") return true;
    return licenseTierRank(currentLicenseTier) >= licenseTierRank(required);
  }, [currentLicenseTier]);
  const tierUpgradeHint = useCallback((requiresTier?: string) => {
    const t = String(requiresTier || "").trim().toLowerCase();
    if (t === "enterprise" || t === "business") return "升级到企业版后可用";
    if (t === "pro") return "升级到专业版后可用";
    return "当前可用";
  }, []);

  useEffect(() => {
    let cancelled = false;
    modelsApi.list().then((res) => {
      if (!cancelled) {
        const available = res.capability_models?.embedding?.available;
        setEmbeddingAvailable(available === true ? true : available === false ? false : null);
      }
    }).catch(() => { if (!cancelled) setEmbeddingAvailable(null); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const syncRole = () => {
      try {
        setActiveRoleId(getScopedActiveRoleIdFromStorage());
        setCurrentLicenseTier(getLicenseTier());
      } catch {
        setActiveRoleId(DEFAULT_ROLE_ID);
        setCurrentLicenseTier("free");
      }
    };
    syncRole();
    window.addEventListener("storage", syncRole);
    window.addEventListener(EVENTS.ROLE_CHANGED, syncRole);
    window.addEventListener(EVENTS.COMPOSER_PREFS_CHANGED, syncRole);
    window.addEventListener(EVENTS.LICENSE_TIER_CHANGED, syncRole);
    return () => {
      window.removeEventListener("storage", syncRole);
      window.removeEventListener(EVENTS.ROLE_CHANGED, syncRole);
      window.removeEventListener(EVENTS.COMPOSER_PREFS_CHANGED, syncRole);
      window.removeEventListener(EVENTS.LICENSE_TIER_CHANGED, syncRole);
    };
  }, []);

  // 文件树状态
  const [kbFiles, setKbFiles] = useState<Array<{ name: string; path: string; type: 'file' | 'folder' }>>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadedChildren, setLoadedChildren] = useState<Map<string, Array<{ name: string; path: string; type: 'file' | 'folder' }>>>(new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const expandedPathsRef = useRef<Set<string>>(new Set());
  const loadKnowledgeBaseFilesRef = useRef<() => Promise<void>>(async () => {});
  const loadFolderChildrenRef = useRef<(path: string, force?: boolean) => Promise<void>>(async () => {});

  const addLoading = useCallback((id: string) => {
    setLoadingOperations((prev) => new Set(prev).add(id));
  }, []);
  const removeLoading = useCallback((id: string) => {
    setLoadingOperations((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // 同步状态（提前定义，避免被 handleTriggerSync / useEffect 在初始化前引用）
  const loadSyncStatus = useCallback(async () => {
    setSyncStatusLoading(true);
    setSyncStatusError(null);
    try {
      const status = await knowledgeAPI.getSyncStatus();
      setSyncStatus(status);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "加载同步状态失败";
      setSyncStatusError(msg);
      setSyncStatus(null);
      toast.error(t("knowledge.loadSyncFailed"), { description: e instanceof Error ? e.message : undefined });
    } finally {
      setSyncStatusLoading(false);
    }
  }, []);

  // 加载知识库文件列表
  const loadKnowledgeBaseFiles = useCallback(async () => {
    addLoading("files");
    try {
      // 构建知识库文件列表（路径相对 KB 根）：global / learned / skills / tools / teams / users
      const files: Array<{ name: string; path: string; type: 'file' | 'folder' }> = [
        { name: 'global', path: 'global', type: 'folder' },
        { name: 'learned', path: 'learned', type: 'folder' },
        { name: 'skills', path: 'skills', type: 'folder' },
        { name: 'tools', path: 'tools', type: 'folder' },
      ];

      if (teamId && teamId !== 'default-team') {
        files.push({ name: `teams/${teamId}`, path: `teams/${teamId}`, type: 'folder' });
      } else {
        files.push({ name: 'teams/demo-team', path: 'teams/demo-team', type: 'folder' });
      }

      if (userId && userId !== 'default-user') {
        files.push({ name: `users/${userId}`, path: `users/${userId}`, type: 'folder' });
      } else {
        files.push({ name: 'users/demo-user', path: 'users/demo-user', type: 'folder' });
      }

      setKbFiles(files);
    } catch (error) {
      console.error('[KnowledgeBasePanel] 加载文件列表失败:', error);
      toast.error(t("knowledge.loadKbFilesFailed"));
    } finally {
      removeLoading("files");
    }
  }, [userId, teamId, addLoading, removeLoading]);

  // 加载文件夹子文件；force=true 时跳过缓存（用于 fileEventBus 刷新后强制重载）；workspace 真源一致
  const loadFolderChildren = useCallback(async (folderPath: string, force = false) => {
    if (!force && loadedChildren.has(folderPath)) {
      return;
    }

    setLoadingPaths(prev => new Set(prev).add(folderPath));
    try {
      const items = await knowledgeAPI.listDirectory(folderPath, 1, workspacePath || undefined);
      const children: Array<{ name: string; path: string; type: 'file' | 'folder' }> = items.map((item) => ({
        name: item.name,
        path: item.path,
        type: item.type === 'directory' ? 'folder' : 'file',
      }));

      setLoadedChildren(prev => new Map(prev).set(folderPath, children));
    } catch (error) {
      console.error('[KnowledgeBasePanel] 加载文件夹内容失败:', error);
      toast.error(t("knowledge.loadFolderFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoadingPaths(prev => {
        const newSet = new Set(prev);
        newSet.delete(folderPath);
        return newSet;
      });
    }
  }, [loadedChildren, workspacePath]);

  // 处理文件夹展开/折叠
  const handleFolderToggle = useCallback(async (path: string) => {
    const isExpanded = expandedPaths.has(path);
    
    if (isExpanded) {
      // 折叠：移除展开状态
      setExpandedPaths(prev => {
        const newSet = new Set(prev);
        newSet.delete(path);
        return newSet;
      });
    } else {
      // 展开：添加展开状态并加载子文件
      setExpandedPaths(prev => new Set(prev).add(path));
      await loadFolderChildren(path);
    }
  }, [expandedPaths, loadFolderChildren]);

  // 打开知识库文件（路径均为相对 KB 根，统一走 knowledgeAPI）
  const handleOpenFile = useCallback(async (path: string) => {
    if (!onFileOpen) return;
    try {
      const doc = await knowledgeAPI.getDocument(path);
      onFileOpen(path, doc.content ?? "");
    } catch (error) {
      console.error('[KnowledgeBasePanel] 打开文件失败:', error);
      toast.error(t("knowledge.openFileFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [onFileOpen]);

  // 递归渲染文件树节点（使用 memo 的 FileTreeNode）
  const renderFileTreeNode = useCallback((item: { name: string; path: string; type: 'file' | 'folder' }, depth: number = 0) => (
    <FileTreeNode
      key={item.path}
      item={item}
      depth={depth}
      isExpanded={expandedPaths.has(item.path)}
      isLoading={loadingPaths.has(item.path)}
      children={loadedChildren.get(item.path) || []}
      onFolderToggle={handleFolderToggle}
      onOpenFile={handleOpenFile}
      renderChild={renderFileTreeNode}
    />
  ), [expandedPaths, loadingPaths, loadedChildren, handleFolderToggle, handleOpenFile]);

  // 知识库「懒加载」树：根来自 structure（max_depth=1），子级来自 listDirectory 按展开加载
  const getStructureNodeChildren = useCallback((node: KBItem): Array<{ name: string; path: string; type: 'file' | 'folder' }> => {
    const raw = loadedChildren.get(node.path) ?? (node as KBItem & { children?: KBItem[] }).children ?? [];
    return raw.map((c) => ({
      name: c.name,
      path: c.path,
      type: (c.type === 'directory' ? 'folder' : 'file') as 'file' | 'folder',
    }));
  }, [loadedChildren]);

  const renderStructureTreeNode = useCallback((node: KBItem, depth: number = 0): React.ReactNode => {
    const item = {
      name: node.name,
      path: node.path,
      type: (node.type === 'directory' ? 'folder' : 'file') as 'file' | 'folder',
    };
    const childList = getStructureNodeChildren(node);
    const fullChildren = loadedChildren.get(node.path) ?? (node as KBItem & { children?: KBItem[] }).children ?? [];
    return (
      <FileTreeNode
        key={node.path}
        item={item}
        depth={depth}
        isExpanded={expandedPaths.has(node.path)}
        isLoading={loadingPaths.has(node.path)}
        children={childList}
        onFolderToggle={handleFolderToggle}
        onOpenFile={handleOpenFile}
        renderChild={(childItem, d) => {
          const full = fullChildren.find((c) => c.path === childItem.path) as KBItem | undefined;
          return full ? renderStructureTreeNode(full, d) : null;
        }}
      />
    );
  }, [expandedPaths, loadingPaths, loadedChildren, getStructureNodeChildren, handleFolderToggle, handleOpenFile]);

  // 加载知识库列表（loadKnowledgeBaseFiles 依赖 workspacePath 等，deps 完整以在工作区切换时重拉）
  useEffect(() => {
    loadKnowledgeBaseFiles();
  }, [loadKnowledgeBaseFiles]);

  // 保持 ref 指向最新，供 fileEventBus 回调使用（避免 effect 因 expandedPaths 等频繁重订阅）
  expandedPathsRef.current = expandedPaths;
  loadKnowledgeBaseFilesRef.current = loadKnowledgeBaseFiles;
  loadFolderChildrenRef.current = loadFolderChildren;

  // 订阅文件事件 - 当 AI 操作知识库文件时刷新（单次订阅，通过 ref 读最新值）
  useEffect(() => {
    const unsubscribe = fileEventBus.subscribe((event) => {
      const isKbPath = event.path.startsWith('knowledge_base/') || /^(global|skills|learned|tools|teams|users)(\/|$)/.test(event.path);
      if (isKbPath || event.type === 'refresh') {
        setLoadedChildren(new Map());
        loadKnowledgeBaseFilesRef.current();
        expandedPathsRef.current.forEach((path) => {
          loadFolderChildrenRef.current(path, true);
        });
      }
    });
    return () => unsubscribe();
  }, []);

  // ✅ 加载知识库结构（懒加载：max_depth=1，子级由 listDirectory 按展开加载；workspace 真源一致）
  const loadStructure = useCallback(async () => {
    addLoading("structure");
    try {
      const data = await knowledgeAPI.getStructure(structureScope, teamId, userId, 1, workspacePath || undefined);
      setStructure(data);
    } catch (error) {
      toast.error(t("knowledge.loadKbStructureFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      removeLoading("structure");
    }
  }, [structureScope, teamId, userId, workspacePath, addLoading, removeLoading]);

  // 初始加载
  useEffect(() => {
    loadStructure();
  }, [loadStructure]);

  // ✅ 创建目录（新 API）
  // 只能在用户自己的知识库中创建目录
  const handleCreateDirectory = async () => {
    if (!newDirName.trim()) {
      toast.error(t("knowledge.enterDirName"));
      return;
    }
    // 用户知识库路径：users/{userId}/
    const userBasePath = getKnowledgePath('user', userId || 'demo-user');
    const basePath = selectedItem?.type === 'directory' ? selectedItem.path : userBasePath;
    const newPath = `${basePath}/${newDirName.trim()}`;
    
    try {
      addLoading("create");
      await knowledgeAPI.createDirectory(newPath);
      toast.success(`目录创建成功: ${newDirName}`);
      setShowCreateDialog(false);
      setNewDirName("");
      await loadStructure();
      await loadKnowledgeBaseFiles();
    } catch (error) {
      toast.error(t("knowledge.createDirFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      removeLoading("create");
    }
  };

  // ✅ 刷新知识库索引（新 API）
  const handleRefreshIndex = async () => {
    setRefreshing(true);
    try {
      const result = await knowledgeAPI.refresh('all', teamId, userId, 'incremental', workspacePath || undefined);
      toast.success(`知识库已刷新: ${result.documents_count} 文档, ${result.chunks_count} 分块`);
      await loadStructure();
    } catch (error) {
      toast.error(t("knowledge.refreshFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRefreshing(false);
    }
  };

  const handleTriggerSync = useCallback(async () => {
    setSyncing(true);
    try {
      const result = await knowledgeAPI.triggerSync();
      if (result.success) {
        toast.success(`同步完成，共 ${result.entries_count} 条知识`);
      } else {
        toast.info(result.message || '云端暂不可用');
      }
      await loadSyncStatus();
    } catch (e) {
      toast.error(t("knowledge.syncFailed"), {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSyncing(false);
    }
  }, [loadSyncStatus]);

  useEffect(() => {
    loadSyncStatus();
  }, [loadSyncStatus]);

  // ✅ 删除文档/目录（新 API）
  const handleDelete = async () => {
    if (!itemToDelete) return;
    try {
      addLoading("delete");
      await knowledgeAPI.deleteDocument(itemToDelete.path);
      toast.success(`已删除: ${itemToDelete.name}`);
      setShowDeleteDialog(false);
      setItemToDelete(null);
      setLoadedChildren(new Map());
      await loadStructure();
      await loadKnowledgeBaseFiles();
      setSelectedItem(null);
    } catch (error) {
      toast.error(t("knowledge.deleteFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      removeLoading("delete");
    }
  };

  // 搜索防抖：400ms 内重复触发只执行最后一次
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setHasSearched(true);
    try {
      setSearchLoading(true);
      const results = await knowledgeAPI.search(searchQuery.trim(), 5, 'all', teamId, userId, workspacePath || undefined);
      setSearchResults(results);
      toast.success(`找到 ${results.length} 条结果`);
    } catch (error) {
      toast.error(t("knowledge.searchFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSearchLoading(false);
    }
  }, [searchQuery, teamId, userId]);

  const handleSearch = useCallback(() => {
    if (!searchQuery.trim()) return;
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      searchDebounceRef.current = null;
      doSearch();
    }, 400);
  }, [searchQuery, doSearch]);

  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  /** 路径转为相对知识库根（供 docmap API） */
  const toKbRelativePath = (source: string): string => {
    const kb = "knowledge_base";
    const i = source.indexOf(kb);
    if (i >= 0) return source.slice(i + kb.length).replace(/^[/\\]/, "");
    return source;
  };

  const handleOpenDocmap = async (sourcePath: string) => {
    const path = toKbRelativePath(sourcePath);
    setDocmapLoading(true);
    setDocmapData(null);
    setShowDocmapDialog(true);
    try {
      const data = await knowledgeAPI.getDocumentDocmap(path);
      setDocmapData({ path: data.path, name: data.name, sections: data.sections || [] });
    } catch (e) {
      toast.error(t("knowledge.getDocStructureFailed"), { description: e instanceof Error ? e.message : String(e) });
      setDocmapData(null);
    } finally {
      setDocmapLoading(false);
    }
  };

  // ✅ 文件上传（新 API）
  const handleFileUpload = async (files: File[] | FileList | null) => {
    if (!files || (Array.isArray(files) && files.length === 0)) return;
    
    // 确定目标路径
    const targetPath = selectedItem?.type === 'directory' 
      ? selectedItem.path 
      : `users/${userId || 'demo-user'}`;
    
    const fileArray = Array.isArray(files) ? files : Array.from(files);
    
    try {
      addLoading("upload");
      let synced = 0;
      let failed = 0;
      
      toast.info(`正在上传 ${fileArray.length} 个文件...`);
      
      const results = await Promise.allSettled(
        fileArray.map((file) => knowledgeAPI.uploadDocument(file, targetPath, { buildOntology: uploadBuildOntology }))
      );
      synced = results.filter((r) => r.status === "fulfilled").length;
      failed = results.filter((r) => r.status === "rejected").length;
      let anyOntologyTriggered = false;
      results.forEach((r, i) => {
        if (r.status === "fulfilled") {
          const value = (r as PromiseFulfilledResult<{ ontology_build_triggered?: boolean | null }>).value;
          if (value?.ontology_build_triggered) anyOntologyTriggered = true;
          console.log(`[KnowledgeBasePanel] ✅ 已上传: ${fileArray[i].name}`);
        } else {
          console.error(`[KnowledgeBasePanel] ❌ 上传失败: ${fileArray[i].name}`, (r as PromiseRejectedResult).reason);
        }
      });
      
      // 局部刷新：只清除目标路径及其父级缓存
      setLoadedChildren((prev) => {
        const next = new Map(prev);
        next.delete(targetPath);
        const parts = targetPath.split("/").filter(Boolean);
        for (let i = 1; i < parts.length; i++) {
          next.delete(parts.slice(0, i).join("/"));
        }
        return next;
      });
      await loadStructure();
      await loadKnowledgeBaseFiles();
      
      if (synced > 0) {
        toast.success(`成功上传 ${synced} 个文件${failed > 0 ? `，${failed} 个失败` : ''}${anyOntologyTriggered ? '；已触发本体构建' : ''}`);
      } else {
        toast.error(`所有文件上传失败`);
      }
    } catch (error) {
      toast.error(t("knowledge.uploadFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      removeLoading("upload");
      setShowUploadDialog(false);
      setPendingUploadFiles([]);
      uploadFileInputRef.current && (uploadFileInputRef.current.value = "");
    }
  };

  const loadSkillProfiles = useCallback(async () => {
    setSkillProfilesLoading(true);
    try {
      const res = await skillsAPI.getProfiles();
      if (res.ok && res.profiles?.length) {
        setSkillProfiles(res.profiles);
        if (!res.profiles.find((p) => p.id === skillProfileId)) {
          setSkillProfileId(res.profiles[0].id);
        }
      } else {
        setSkillProfiles([]);
      }
    } catch (e) {
      setSkillProfiles([]);
      toast.error(t("knowledge.loadDomainsFailed"));
    } finally {
      setSkillProfilesLoading(false);
    }
  }, [skillProfileId]);

  const loadSkillsByProfile = useCallback(async () => {
    setSkillsLoading(true);
    try {
      const res = await skillsAPI.getSkillsByProfile(skillProfileId);
      if (res.ok) setSkillsList(res.skills || []);
      else setSkillsList([]);
    } catch (e) {
      setSkillsList([]);
      toast.error(t("knowledge.loadSkillsFailed"), { description: e instanceof Error ? e.message : undefined });
    } finally {
      setSkillsLoading(false);
    }
  }, [skillProfileId]);

  useEffect(() => {
    loadSkillProfiles();
  }, [loadSkillProfiles]);

  useEffect(() => {
    loadSkillsByProfile();
  }, [loadSkillsByProfile]);

  const loadAllSkillsForMarketplace = useCallback(async () => {
    setAllSkillsLoading(true);
    try {
      const res = await skillsAPI.getAllSkills();
      setAllSkillsForMarketplace(res.ok && res.skills ? res.skills : []);
    } catch {
      setAllSkillsForMarketplace([]);
    } finally {
      setAllSkillsLoading(false);
    }
  }, []);

  const loadMarketSkills = useCallback(async () => {
    setMarketSkillsLoading(true);
    try {
      const res = await skillsAPI.getMarketSkills();
      setMarketSkills(res.ok && res.skills ? res.skills : []);
      setMarketSourceType((res as any).source_type || "local");
    } catch {
      setMarketSkills([]);
      setMarketSourceType("local");
    } finally {
      setMarketSkillsLoading(false);
    }
  }, []);

  const loadSkillTrials = useCallback(async () => {
    setSkillTrialsLoading(true);
    try {
      const res = await skillsAPI.listTrials();
      setSkillTrials(res.ok && Array.isArray(res.trials) ? res.trials : []);
      setTrialLimits(res.limits || null);
    } catch {
      setSkillTrials([]);
      setTrialLimits(null);
    } finally {
      setSkillTrialsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!skillsMarketplaceView) return;
    loadSkillTrials();
  }, [skillsMarketplaceView, loadSkillTrials]);

  const activeTrialMap = useMemo(() => {
    const map = new Map<string, SkillTrialItem>();
    for (const t of skillTrials) {
      if ((t.status || "") !== "active") continue;
      const keyById = String(t.market_id || "").trim();
      if (keyById) map.set(`id:${keyById}`, t);
      const keyByName = `${String(t.domain || "general").toLowerCase()}::${String(t.name || "").toLowerCase()}`;
      map.set(`name:${keyByName}`, t);
    }
    return map;
  }, [skillTrials]);

  const formatTrialRemain = useCallback((expiresAt?: string) => {
    const exp = expiresAt ? new Date(expiresAt).getTime() : NaN;
    if (!Number.isFinite(exp)) return "试用中";
    const leftMs = exp - Date.now();
    if (leftMs <= 0) return "已到期";
    const days = Math.floor(leftMs / (24 * 60 * 60 * 1000));
    const hours = Math.floor((leftMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    if (days > 0) return `剩余 ${days}天${hours}小时`;
    const minutes = Math.max(1, Math.floor((leftMs % (60 * 60 * 1000)) / (60 * 1000)));
    return `剩余 ${hours}小时${minutes}分钟`;
  }, []);

  const findActiveTrialForMarket = useCallback((item: MarketSkillItem): SkillTrialItem | undefined => {
    const id = String(item.id || "").trim();
    if (id && activeTrialMap.has(`id:${id}`)) return activeTrialMap.get(`id:${id}`);
    const keyByName = `${String(item.domain || "general").toLowerCase()}::${String(item.name || "").toLowerCase()}`;
    return activeTrialMap.get(`name:${keyByName}`);
  }, [activeTrialMap]);

  const loadSkillUpdates = useCallback(async () => {
    setUpdatesLoading(true);
    try {
      const res = await skillsAPI.checkUpdates();
      setSkillUpdates(res.ok && res.updates ? res.updates : []);
      if (res.ok && res.total > 0) {
        toast.success(`发现 ${res.total} 个可更新技能`);
      } else if (res.ok) {
        const bySrc = res.builtin_by_source;
        const hint = bySrc && (bySrc.official + bySrc.builtin + bySrc.learned) > 0
          ? `（内置 ${(res.builtin_total ?? 0)}：官方 ${bySrc.official} / 内置 ${bySrc.builtin} / 学习 ${bySrc.learned}）`
          : "";
        toast.info(`当前已是最新${hint}`);
      }
    } catch (e) {
      toast.error(t("knowledge.checkUpdateFailed"), { description: e instanceof Error ? e.message : String(e) });
      setSkillUpdates([]);
    } finally {
      setUpdatesLoading(false);
    }
  }, []);

  const handleUpdateSkill = useCallback(async (item: SkillUpdateItem) => {
    const key = `update:${item.market_id ?? item.url ?? item.name}`;
    setInstallingSkillId(key);
    try {
      const res = await skillsAPI.installFromMarket({
        url: item.url,
        name: item.name,
        domain: item.domain,
        version: item.market_version,
        market_id: item.market_id ?? undefined,
      });
      if (res.ok) {
        toast.success(`已更新: ${item.name}`);
        setSkillUpdates((prev) => prev.filter((u) => u.url !== item.url || u.name !== item.name));
        loadAllSkillsForMarketplace();
        loadSkillsByProfile();
        loadMarketSkills();
      } else {
        toast.error(t("knowledge.updateFailed"));
      }
    } catch (e) {
      toast.error(t("knowledge.updateFailed"), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setInstallingSkillId(null);
    }
  }, [loadAllSkillsForMarketplace, loadSkillsByProfile, loadMarketSkills]);

  const handleUpdateAllSkills = useCallback(async () => {
    setInstallingSkillId("__update_all__");
    try {
      const res = await skillsAPI.updateAll(50);
      if (!res.ok) {
        toast.error(t("knowledge.batchUpdateFailed"));
        return;
      }
      if (res.updated_count > 0) {
        toast.success(`已更新 ${res.updated_count} 个技能`);
      } else {
        toast.info(t("knowledge.noSkillsToUpdate"));
      }
      if (res.failed_count > 0) {
        toast.warning(`有 ${res.failed_count} 个更新失败，请查看单项重试`);
      }
      await loadSkillUpdates();
      loadAllSkillsForMarketplace();
      loadSkillsByProfile();
      loadMarketSkills();
    } catch (e) {
      toast.error(t("knowledge.batchUpdateFailed"), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setInstallingSkillId(null);
    }
  }, [loadSkillUpdates, loadAllSkillsForMarketplace, loadSkillsByProfile, loadMarketSkills]);

  const warnQualityGateBeforeInstall = useCallback((item?: Partial<MarketSkillItem> | null) => {
    if (!item) return;
    const missing = Array.isArray(item.quality_gate_missing) ? item.quality_gate_missing.filter(Boolean) : [];
    if (missing.length === 0) return;
    toast.warning(`该技能仍有 ${missing.length} 项质量门未补齐（安装不受影响）`, {
      description: `缺失项：${missing.slice(0, 4).join("、")}`,
    });
  }, []);

  const buildQualityGateTemplate = useCallback((tier: string | undefined, missing: string[]) => {
    const safeTier = String(tier || "core").trim().toLowerCase() || "core";
    const tierChecklistMap: Record<string, string[]> = {
      core: [
        "可执行结论（不是仅描述）",
        "依据引用（来源片段或文件路径）",
        "待确认项/不确定项标注",
      ],
      pro: [
        "风险与回滚策略",
        "验收标准（完成判据）",
        "下一步动作（可分派任务）",
      ],
      enterprise: [
        "安全与合规边界（分级/脱敏/审计）",
        "SLA 指标（时延/可用性/恢复）",
        "灰度上线与回滚方案",
      ],
      community: [
        "使用前提与风险提示（版本/依赖/权限）",
        "可复现实例（输入/步骤/预期输出）",
        "维护信息（作者/版本/更新记录）",
      ],
    };
    const baseline = tierChecklistMap[safeTier] || tierChecklistMap.core;
    const merged = missing.length > 0 ? Array.from(new Set([...missing, ...baseline])) : baseline;
    const lines = merged.map((m) => `- [ ] ${m}`);
    return [
      "",
      "## 质量门补齐",
      "",
      `层级：${safeTier}`,
      "",
      "待补齐清单：",
      ...lines,
      "",
      "验收记录：",
      "- [ ] 已补齐并自检",
      "- [ ] 已通过人工复核",
      "",
    ].join("\n");
  }, []);

  const runQualityGateRecheck = useCallback(async () => {
    await Promise.all([
      loadAllSkillsForMarketplace(),
      loadSkillsByProfile(),
      loadMarketSkills(),
      loadSkillTrials(),
    ]);
    toast.success(t("knowledge.qualityGateRefreshed"));
  }, [loadAllSkillsForMarketplace, loadSkillsByProfile, loadMarketSkills, loadSkillTrials]);

  const attachQualityGateTemplateToSkillFile = useCallback(async (path: string, tier: string) => {
    const base = getApiUrl().replace(/\/$/, "");
    const r = await fetch(`${base}/files/read?path=${encodeURIComponent(path)}`);
    if (!r.ok) throw new Error("读取 Skill 文件失败");
    const data = await r.json();
    const original = String(data?.content || "");
    const marker = "## 质量门补齐";
    if (original.includes(marker)) return original;
    const nextContent = `${original.replace(/\s*$/, "")}\n${buildQualityGateTemplate(tier, [])}`;
    const w = await fetch(`${base}/files/write?path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: nextContent }),
    });
    if (!w.ok) throw new Error("写入 Skill 文件失败");
    return nextContent;
  }, [buildQualityGateTemplate]);

  const openSkillForQualityFix = useCallback(async (path: string | undefined, tier: string | undefined, missing: string[]) => {
    if (!path || !onFileOpen || missing.length === 0) return;
    try {
      const base = getApiUrl().replace(/\/$/, "");
      const r = await fetch(`${base}/files/read?path=${encodeURIComponent(path)}`);
      if (!r.ok) throw new Error("读取 Skill 文件失败");
      const data = await r.json();
      const original = String(data?.content || "");
      const marker = "## 质量门补齐";
      const appended = !original.includes(marker);
      const nextContent = appended ? `${original.replace(/\s*$/, "")}\n${buildQualityGateTemplate(tier, missing)}` : original;
      onFileOpen(path, nextContent);
      if (appended) {
        toast.info(t("knowledge.skillOpenedWithTemplate"), {
          description: "可直接自动保存并刷新质量门状态",
          action: {
            label: "自动保存并校验",
            onClick: async () => {
              try {
                const w = await fetch(`${base}/files/write?path=${encodeURIComponent(path)}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ content: nextContent }),
                });
                if (!w.ok) throw new Error("保存失败");
                await runQualityGateRecheck();
              } catch (e) {
                toast.error(t("knowledge.autoSaveFailed"), { description: e instanceof Error ? e.message : String(e) });
              }
            },
          },
        });
      } else {
        toast.info(t("knowledge.skillOpenedFillAndValidate"), {
          action: {
            label: "立即校验",
            onClick: () => {
              void runQualityGateRecheck();
            },
          },
        });
      }
    } catch (e) {
      toast.warning("安装成功，但自动打开补齐模板失败", { description: e instanceof Error ? e.message : String(e) });
    }
  }, [onFileOpen, buildQualityGateTemplate, runQualityGateRecheck]);

  const handleInstallFromMarket = useCallback(async () => {
    const url = installSkillUrl.trim();
    const content = installSkillContent.trim();
    if (!url && !content) {
      toast.error(t("knowledge.fillUrlOrPasteSkill"));
      return;
    }
    const matchedMarketItem =
      marketSkills.find((s) => installSkillMarketId && s.id && s.id === installSkillMarketId) ||
      marketSkills.find((s) => url && s.url && s.url === url) ||
      marketSkills.find((s) => {
        const n = (installSkillName || "").trim();
        const d = (installSkillDomain || "").trim() || "general";
        return !!n && (s.name || "").trim() === n && ((s.domain || "general").trim() === d);
      });
    warnQualityGateBeforeInstall(matchedMarketItem);
    setInstallingSkillId("__url_install__");
    try {
      const res = await skillsAPI.installFromMarket({
        url: url || undefined,
        content: content || undefined,
        name: installSkillName.trim() || undefined,
        domain: installSkillDomain.trim() || "general",
        version: installSkillVersion,
        market_id: installSkillMarketId,
      });
      if (res.ok) {
        toast.success(res.message || "安装成功");
        if (matchedMarketItem) {
          const missing = Array.isArray(matchedMarketItem.quality_gate_missing) ? matchedMarketItem.quality_gate_missing.filter(Boolean) : [];
          await openSkillForQualityFix(res.path, matchedMarketItem.quality_gate_tier, missing);
        }
        setShowInstallSkillDialog(false);
        setInstallSkillUrl("");
        setInstallSkillContent("");
        setInstallSkillName("");
        setInstallSkillDomain("general");
        setInstallSkillVersion(undefined);
        setInstallSkillMarketId(undefined);
        await runQualityGateRecheck();
      } else {
        toast.error(t("knowledge.installFailed"));
      }
    } catch (e) {
      if (isHandledApiError(e)) return;
      toast.error(t("knowledge.installFailed"), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setInstallingSkillId(null);
    }
  }, [installSkillUrl, installSkillContent, installSkillName, installSkillDomain, installSkillVersion, installSkillMarketId, marketSkills, warnQualityGateBeforeInstall, openSkillForQualityFix, runQualityGateRecheck]);

  const handleInstallMarketItem = useCallback(async (item: MarketSkillItem) => {
    if (!isTierAllowed(item.requires_tier)) {
      toast.error(t("knowledge.cannotInstallSkillTier"), { description: tierUpgradeHint(item.requires_tier) });
      return;
    }
    warnQualityGateBeforeInstall(item);
    if (item.url) {
      setInstallSkillUrl(item.url);
      setInstallSkillName(item.name || "");
      setInstallSkillDomain(item.domain || "general");
      setInstallSkillContent("");
      setInstallSkillVersion(item.version);
      setInstallSkillMarketId(item.id);
      setShowInstallSkillDialog(true);
      return;
    }
    const skillId = item.id ?? item.name ?? "";
    setInstallingSkillId(skillId);
    try {
      const res = await skillsAPI.installFromMarket({
        name: item.name,
        domain: item.domain || "general",
        content: item.description ? `---\nname: ${item.name}\ndescription: ${item.description}\n---\n\n# ${item.name}\n\n（从市场安装，请编辑完善）` : undefined,
        url: item.url,
        version: item.version,
        market_id: item.id,
      });
      if (res.ok) {
        toast.success(t("knowledge.installSuccess"));
        const missing = Array.isArray(item.quality_gate_missing) ? item.quality_gate_missing.filter(Boolean) : [];
        await openSkillForQualityFix(res.path, item.quality_gate_tier, missing);
        await runQualityGateRecheck();
      } else {
        toast.error(t("knowledge.installFailed"));
      }
    } catch (e) {
      if (isHandledApiError(e)) return;
      toast.error(t("knowledge.installFailed"), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setInstallingSkillId(null);
    }
  }, [isTierAllowed, tierUpgradeHint, warnQualityGateBeforeInstall, openSkillForQualityFix, runQualityGateRecheck]);

  const handleTrialMarketItem = useCallback(async (item: MarketSkillItem) => {
    if (!isTierAllowed(item.requires_tier)) {
      toast.error(t("knowledge.cannotTrialSkillTier"), { description: tierUpgradeHint(item.requires_tier) });
      return;
    }
    const skillId = item.id ?? item.name ?? "";
    setInstallingSkillId(skillId);
    try {
      const res = await skillsAPI.createTrial({
        name: item.name,
        domain: item.domain || "general",
        content: item.url ? undefined : (item.description ? `---\nname: ${item.name}\ndescription: ${item.description}\n---\n\n# ${item.name}\n\n（试用安装，请按需完善）` : undefined),
        url: item.url,
        version: item.version,
        market_id: item.id,
      });
      if (res.ok) {
        toast.success(t("knowledge.trialInstalled"));
        await Promise.all([loadSkillTrials(), loadAllSkillsForMarketplace(), loadSkillsByProfile()]);
      } else {
        toast.error(t("knowledge.trialInstallFailed"));
      }
    } catch (e) {
      if (isHandledApiError(e)) return;
      toast.error(t("knowledge.trialInstallFailed"), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setInstallingSkillId(null);
    }
  }, [isTierAllowed, tierUpgradeHint, loadSkillTrials, loadAllSkillsForMarketplace, loadSkillsByProfile]);

  const handlePromoteTrial = useCallback(async (trialId: string) => {
    setInstallingSkillId(`trial:${trialId}`);
    try {
      const res = await skillsAPI.promoteTrial(trialId);
      if (res.ok) {
        toast.success(t("knowledge.trialConverted"));
        await Promise.all([loadSkillTrials(), loadAllSkillsForMarketplace(), loadSkillsByProfile()]);
      } else {
        toast.error(t("knowledge.convertFailed"));
      }
    } catch (e) {
      toast.error(t("knowledge.convertFailed"), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setInstallingSkillId(null);
    }
  }, [loadSkillTrials, loadAllSkillsForMarketplace, loadSkillsByProfile]);

  const handleCleanupTrial = useCallback(async (trialId: string) => {
    setInstallingSkillId(`trial:${trialId}`);
    try {
      const res = await skillsAPI.cleanupTrial(trialId);
      if (res.ok) {
        toast.success(t("knowledge.trialCleaned"));
        await Promise.all([loadSkillTrials(), loadAllSkillsForMarketplace(), loadSkillsByProfile()]);
      } else {
        toast.error(t("knowledge.cleanFailed"));
      }
    } catch (e) {
      toast.error(t("knowledge.cleanFailed"), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setInstallingSkillId(null);
    }
  }, [loadSkillTrials, loadAllSkillsForMarketplace, loadSkillsByProfile]);

  const runSkillDemoCompare = useCallback(async (target: MarketSkillItem, query: string) => {
    setCompareLoading(true);
    try {
      const res = await skillsAPI.demoRun({
        market_id: target.id,
        name: target.name,
        domain: target.domain,
        user_query: query,
      });
      if (res.ok) {
        setCompareResult(res.comparison);
      } else {
        toast.error(t("knowledge.effectCompareFailed"));
      }
    } catch (e) {
      toast.error(t("knowledge.effectCompareFailed"), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setCompareLoading(false);
    }
  }, []);

  const handleOpenCompareDialog = useCallback(async (target: MarketSkillItem) => {
    setCompareTarget(target);
    setShowSkillCompareDialog(true);
    setCompareResult(null);
    await runSkillDemoCompare(target, compareQuery.trim() || "请给出该任务的执行步骤与风险提示。");
  }, [runSkillDemoCompare, compareQuery]);

  const handleOpenSkill = useCallback(
    async (item: SkillItem) => {
      const path = item.path;
      if (!path || !onFileOpen) return;
      try {
        const base = getApiUrl().replace(/\/$/, "");
        const res = await fetch(`${base}/files/read?path=${encodeURIComponent(path)}`);
        if (!res.ok) throw new Error("读取失败");
        const data = await res.json();
        onFileOpen(path, data.content ?? "");
      } catch (e) {
        toast.error(t("knowledge.openSkillFileFailed"), {
          description: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [onFileOpen]
  );

  const handleDeleteSkill = useCallback(async () => {
    const item = skillToDelete;
    if (!item) return;
    const kbPath = item.kb_relative_path;
    setShowDeleteSkillDialog(false);
    setSkillToDelete(null);
    if (!kbPath) {
      toast.error(t("knowledge.cannotDeleteNoPath"));
      return;
    }
    try {
      await knowledgeAPI.deleteDocument(kbPath);
      toast.success(t("knowledge.deleted"));
      loadSkillsByProfile();
    } catch (e) {
      toast.error(t("knowledge.deleteFailed"), { description: e instanceof Error ? e.message : String(e) });
    }
  }, [skillToDelete, loadSkillsByProfile]);

  const handleGenerateDraftSubmit = useCallback(async () => {
    if (!draftName.trim()) {
      toast.error(t("knowledge.enterSkillName"));
      return;
    }
    try {
      const threadId = typeof window !== "undefined" ? getCurrentThreadIdFromStorage() || null : null;
      const res = await skillsAPI.generateDraft({
        name: draftName.trim(),
        description: draftDescription.trim() || undefined,
        steps_summary: draftSteps.trim() || undefined,
        ...(threadId ? { thread_id: threadId } : {}),
      });
      if (res.ok && res.relative_path) {
        toast.success(res.message || "草稿已生成");
        setShowDraftDialog(false);
        setDraftName("");
        setDraftDescription("");
        setDraftSteps("");
        const selectedTier = draftQualityTier;
        setDraftQualityTier("core");
        loadSkillsByProfile();
        if (res.path && onFileOpen) {
          try {
            const nextContent = await attachQualityGateTemplateToSkillFile(res.path, selectedTier);
            onFileOpen(res.path, nextContent);
            toast.info(`已按 ${selectedTier} 层自动补齐质量门模板`);
          } catch (e) {
            toast.warning("草稿已生成，但质量门模板自动补齐失败", {
              description: e instanceof Error ? e.message : String(e),
            });
            // 打开失败不阻塞
          }
        }
      } else {
        toast.error(t("knowledge.generateFailed"));
      }
    } catch (e) {
      toast.error(t("knowledge.generateFailed"), { description: e instanceof Error ? e.message : String(e) });
    }
  }, [draftName, draftDescription, draftSteps, draftQualityTier, loadSkillsByProfile, onFileOpen, attachQualityGateTemplateToSkillFile]);

  return (
    <TooltipProvider>
    <div className="h-full min-h-0 overflow-hidden flex flex-col bg-background">
      {/* 简洁的标题栏 - 更紧凑 */}
      <div className="h-8 px-2 border-b border-border/40 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1">
          <Database className="h-3 w-3 text-emerald-500" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            知识库
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-2.5 w-2.5 text-muted-foreground/60 cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs text-xs">
              <p className="font-medium mb-1">知识库层级说明</p>
              <ul className="space-y-1 text-muted-foreground">
                <li>• <span className="text-foreground">我的知识库</span>：您上传的文档（可编辑）</li>
                <li>• <span className="text-foreground">团队知识库</span>：团队共享文档（只读）</li>
                <li>• <span className="text-foreground">领域/系统知识</span>：Agent 自动使用</li>
              </ul>
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center gap-0">
          <Button
            onClick={() => setShowOntologyDialog(true)}
            size="sm"
            variant="ghost"
            className="h-5 w-5 p-0"
            title="本体管理"
            aria-label="本体管理"
          >
            <Network className="h-3 w-3" />
          </Button>
          <Button
            onClick={() => setShowImportFolderDialog(true)}
            size="sm"
            variant="ghost"
            className="h-5 w-5 p-0"
            title="导入文件夹"
            aria-label="导入文件夹"
          >
            <FolderOpen className="h-3 w-3" />
          </Button>
          <Button
            onClick={() => setShowUploadDialog(true)}
            size="sm"
            variant="ghost"
            className="h-5 w-5 p-0"
            title="上传文档"
            aria-label="上传文档"
          >
            <Upload className="h-3 w-3" />
          </Button>
          <Button
            onClick={() => setShowCreateDialog(true)}
            size="sm"
            variant="ghost"
            className="h-5 w-5 p-0"
            title="新建目录"
            aria-label="新建目录"
          >
            <Plus className="h-3 w-3" />
          </Button>
          <Button
            onClick={handleRefreshIndex}
            size="sm"
            variant="ghost"
            className="h-5 w-5 p-0"
            disabled={refreshing}
            title="刷新索引"
            aria-label="刷新索引"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {embeddingAvailable === false && (
        <Alert variant="destructive" className="mx-2 mt-2 py-1.5 text-xs shrink-0">
          <AlertDescription>
            向量检索（Embedding）服务不可用，知识库搜索可能受限。请检查设置中的 Embedding 模型或本地推理服务。
          </AlertDescription>
        </Alert>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        <Tabs value={tabValue} onValueChange={setTabValue} className="h-full flex flex-col">
          <TabsList className="w-full justify-start rounded-none border-b bg-transparent p-0 h-8">
            <TabsTrigger value="files" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent text-xs h-8 px-3">
              文件
            </TabsTrigger>
            {!sidebarMode && (
              <TabsTrigger value="bases" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent text-xs h-8 px-3">
                知识库
              </TabsTrigger>
            )}
            <TabsTrigger value="skills" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent text-xs h-8 px-3">
              技能
            </TabsTrigger>
            <TabsTrigger value="search" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent text-xs h-8 px-3">
              搜索
            </TabsTrigger>
          </TabsList>

          {/* ✅ 管理标签页：上传、刷新索引 */}
          {!sidebarMode && (
          <TabsContent value="bases" className="flex-1 flex flex-col p-3 pt-2">
            {/* scope 筛选：个人 / 团队 / 全局 */}
            <div className="flex items-center gap-2 mb-2">
              <Label className="text-xs text-muted-foreground shrink-0">范围</Label>
              <div className="flex rounded-md border border-border overflow-hidden">
                {(['users', 'teams', 'global'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`px-2 py-1 text-xs border-r border-border last:border-r-0 ${structureScope === s ? 'bg-primary text-primary-foreground' : 'bg-muted/50 hover:bg-muted'}`}
                    onClick={() => setStructureScope(s)}
                  >
                    {s === 'users' ? '个人' : s === 'teams' ? '团队' : '全局'}
                  </button>
                ))}
              </div>
            </div>
            {/* 工具栏 */}
            <div className="flex items-center gap-2 mb-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowUploadDialog(true)}
                disabled={!selectedItem || selectedItem.type !== 'directory' || structureScope !== 'users'}
              >
                <Upload className="h-4 w-4 mr-1" />
                上传
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowBuildOntologyDialog(true)}
                title="从选定目录提取实体与关系并写入本体"
              >
                <Network className="h-4 w-4 mr-1" />
                构建本体
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefreshIndex}
                disabled={refreshing}
              >
                {refreshing ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-1" />
                )}
                刷新索引
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => {
                  if (selectedItem) {
                    setItemToDelete(selectedItem);
                    setShowDeleteDialog(true);
                  }
                }}
                disabled={!selectedItem}
              >
                <Trash2 className="h-4 w-4 mr-1" />
                删除
              </Button>
            </div>

            {/* 同步状态卡片 */}
            <div className={`flex items-center justify-between gap-2 mb-3 p-2 rounded-lg border ${syncStatus?.expired && syncStatus?.cached ? 'bg-amber-500/10 border-amber-500/30' : syncStatusError ? 'bg-destructive/10 border-destructive/30' : 'bg-muted/30'}`}>
              <div className="flex items-center gap-2 min-w-0">
                <Cloud className="h-4 w-4 shrink-0 text-muted-foreground" />
                {syncStatusLoading ? (
                  <span className="text-xs flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t("common.loading")}
                  </span>
                ) : syncStatusError ? (
                  <span className="text-xs text-destructive truncate" title={syncStatusError}>{syncStatusError}</span>
                ) : (
                  <>
                    <span className="text-xs truncate">
                      {syncStatus === null
                        ? '—'
                        : !syncStatus.cached
                          ? '未同步'
                          : syncStatus.expired
                            ? '已过期'
                            : '已同步'}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {syncStatus?.last_sync_ts
                        ? (() => {
                            const s = Math.floor(Date.now() / 1000 - syncStatus.last_sync_ts);
                            if (s < 60) return '刚刚';
                            if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
                            if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
                            if (s < 2592000) return `${Math.floor(s / 86400)} 天前`;
                            return `${Math.floor(s / 2592000)} 个月前`;
                          })()
                        : '—'}
                    </span>
                  </>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 h-7 text-xs"
                onClick={handleTriggerSync}
                disabled={syncing || syncStatusLoading}
              >
                {syncing ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : null}
                同步
              </Button>
            </div>

            {/* 选中项信息 */}
            {selectedItem && (
              <div className="p-2 mb-3 border rounded-lg bg-muted/30 text-xs">
                <div className="flex items-center gap-2">
                  {selectedItem.type === 'directory' ? (
                    <FolderOpen className="h-4 w-4" />
                  ) : (
                    <FileText className="h-4 w-4" />
                  )}
                  <span className="font-medium">{selectedItem.name}</span>
                </div>
                <p className="text-muted-foreground mt-1 truncate">
                  路径: {selectedItem.path}
                </p>
                {selectedItem.type !== 'directory' && selectedItem.path && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="mt-2 w-full text-xs"
                    onClick={() => {
                      const kbPath = selectedItem.path!.startsWith("knowledge_base") ? selectedItem.path! : `knowledge_base/${selectedItem.path!}`;
                      const contextItem: ContextItem = {
                        id: `kb-ask-${Date.now()}`,
                        type: "file",
                        name: selectedItem.name,
                        path: kbPath,
                        status: "success",
                      };
                      window.dispatchEvent(new CustomEvent(EVENTS.OPEN_CHAT_PANEL));
                      window.dispatchEvent(new CustomEvent(EVENTS.CONTEXT_ITEMS_CHANGED, { detail: { contextItems: [contextItem] } }));
                      window.setTimeout(() => {
                        window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, {
                          detail: { prompt: t("knowledge.askWithDocPrompt"), threadId: getCurrentThreadIdFromStorage() || undefined },
                        }));
                        window.dispatchEvent(new CustomEvent(EVENTS.FOCUS_COMPOSER));
                      }, 150);
                    }}
                  >
                    {t("knowledge.askWithDoc")}
                  </Button>
                )}
              </div>
            )}
            
            {/* 知识库结构树：懒加载，根来自 structure(max_depth=1)，子级展开时 listDirectory */}
            <ScrollArea className="flex-1 border rounded-lg">
              {loading ? (
                <div className="flex items-center justify-center h-32">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : structure?.structure.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-32 text-muted-foreground text-sm">
                  <FileText className="h-8 w-8 mb-2 opacity-50" />
                  <p>知识库为空</p>
                </div>
              ) : (
                <div className="p-2">
                  {structure?.structure.map((item) => (
                    <div key={item.path} onClick={() => setSelectedItem(item)}>
                      {renderStructureTreeNode(item, 0)}
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>
          )}

          {/* 技能管理：按领域列出 / 技能市场 */}
          <TabsContent value="skills" className="flex-1 flex flex-col p-3 pt-2">
            <div className="flex items-center gap-2 mb-2">
              <div className="flex rounded-md border border-border overflow-hidden">
                <button
                  type="button"
                  className={`px-2 py-1 text-xs border-r border-border ${!skillsMarketplaceView ? 'bg-primary text-primary-foreground' : 'bg-muted/50 hover:bg-muted'}`}
                  onClick={() => setSkillsMarketplaceView(false)}
                >
                  按领域
                </button>
                <button
                  type="button"
                  className={`px-2 py-1 text-xs ${skillsMarketplaceView ? 'bg-primary text-primary-foreground' : 'bg-muted/50 hover:bg-muted'}`}
                  onClick={() => {
                    setSkillsMarketplaceView(true);
                    loadAllSkillsForMarketplace();
                    loadMarketSkills();
                    loadSkillTrials();
                  }}
                >
                  技能市场
                </button>
              </div>
            </div>

            {skillsMarketplaceView ? (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <Button variant="default" size="sm" onClick={() => setShowDraftDialog(true)}>
                    <Plus className="h-3 w-3 mr-1" />
                    创建新 Skill
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowInstallSkillDialog(true)}>
                    <Link className="h-3 w-3 mr-1" />
                    从 URL 安装
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => { loadAllSkillsForMarketplace(); loadMarketSkills(); loadSkillTrials(); }} disabled={allSkillsLoading || marketSkillsLoading || skillTrialsLoading}>
                    {allSkillsLoading || marketSkillsLoading || skillTrialsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                    刷新
                  </Button>
                  <Button variant="outline" size="sm" onClick={loadSkillUpdates} disabled={updatesLoading}>
                    {updatesLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                    检查更新
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleUpdateAllSkills} disabled={installingSkillId === "__update_all__" || skillUpdates.length === 0}>
                    {installingSkillId === "__update_all__" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3 mr-1" />}
                    全部更新
                  </Button>
                </div>
                {skillUpdates.length > 0 && (
                  <div className="mb-4">
                    <div className="text-xs font-medium text-muted-foreground mb-2">可更新</div>
                    <div className="grid gap-2 mb-4">
                      {skillUpdates.map((u, i) => (
                        <Card key={i} className="overflow-hidden">
                          <CardContent className="p-2">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <span className="font-medium text-sm block">{u.name}</span>
                                <span className="text-xs text-muted-foreground">
                                  {u.current_version ? `当前 ${u.current_version}` : "未记录版本"} → {u.market_version}
                                </span>
                                {u.domain && <Badge variant="secondary" className="text-xs mt-1">{u.domain}</Badge>}
                              </div>
                              <Button size="sm" variant="default" className="h-7 shrink-0" onClick={() => handleUpdateSkill(u)} disabled={installingSkillId === `update:${u.market_id ?? u.url ?? u.name}`}>
                                {installingSkillId === `update:${u.market_id ?? u.url ?? u.name}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3 mr-1" />}
                                更新
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </div>
                )}
                <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-2 mb-3 text-xs text-amber-800 dark:text-amber-200">
                  <span>招投标类技能可先构建产品知识图谱以增强效果。</span>
                  <Button variant="link" size="sm" className="h-auto p-0 ml-1 text-amber-700 dark:text-amber-300" onClick={() => setShowBuildOntologyDialog(true)}>
                    构建本体
                  </Button>
                </div>
                {trialLimits && (
                  <div className="mb-3 rounded-md border border-primary/20 bg-primary/5 p-2 text-xs text-muted-foreground">
                    试用额度：最近 {trialLimits.window_days} 天内 {trialLimits.used_in_window}/{trialLimits.max_trials}，剩余 {trialLimits.remaining}
                  </div>
                )}
                {recommendedMarketSkills.length > 0 && (
                  <div className="mb-3 rounded-md border border-primary/20 bg-primary/5 p-2">
                    <div className="text-xs font-medium text-muted-foreground mb-1">
                      角色推荐（{activeRoleId || "未指定角色"}）
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {recommendedMarketSkills.map((s, i) => (
                        <Button
                          key={`${s.id || s.name}-${i}`}
                          size="sm"
                          variant="outline"
                          className="h-6 text-[11px]"
                          onClick={() => handleInstallMarketItem(s)}
                          disabled={installingSkillId === (s.id ?? s.name) || !isTierAllowed(s.requires_tier)}
                          title={!isTierAllowed(s.requires_tier) ? tierUpgradeHint(s.requires_tier) : undefined}
                        >
                          {s.name}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
                {marketSkills.length > 0 && (
                  <div className="mb-4">
                    <div className="text-xs font-medium text-muted-foreground mb-2">
                      市场可安装（当前来源：{marketSourceType === "remote" ? "远程市场" : "本地市场"}）
                    </div>
                    <div className="mb-2 flex items-center gap-1 flex-wrap">
                      {(["all", "free", "pro", "enterprise"] as const).map((tier) => (
                        <Button
                          key={tier}
                          size="sm"
                          variant={marketTierFilter === tier ? "default" : "outline"}
                          className="h-6 px-2 text-[11px]"
                          onClick={() => setMarketTierFilter(tier)}
                        >
                          {tier === "all" ? "全部" : tier === "free" ? "免费" : tier === "pro" ? "专业版" : "企业版"}
                        </Button>
                      ))}
                    </div>
                    <div className="grid gap-2 mb-4">
                      {filteredMarketSkills.map((s, i) => {
                        const trial = findActiveTrialForMarket(s);
                        const previewKey = `${s.id || `${s.domain || "general"}-${s.name || i}`}`;
                        const isPreviewOpen = expandedMarketPreviewKey === previewKey;
                        const previewText = (s.preview || s.preview_output || s.description || "").trim();
                        const requiresTier = String(s.requires_tier || "").trim().toLowerCase();
                        const requiresTierLabel =
                          requiresTier === "enterprise" ? "企业版" : requiresTier === "pro" ? "专业版" : "免费";
                        return (
                        <Card key={i} className="overflow-hidden">
                          <CardContent className="p-2">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <span className="font-medium text-sm block">
                                  {s.name}
                                  {s.quality_gate_passed === true && (
                                    <span className="ml-1.5 text-[11px] font-normal px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/25">已校验</span>
                                  )}
                                </span>
                                {s.version && <span className="text-[11px] text-muted-foreground ml-1">v{s.version}</span>}
                                {s.description && <span className="text-xs text-muted-foreground line-clamp-2 block">{s.description}</span>}
                                <div className="flex items-center gap-1">
                                  {s.domain && <Badge variant="secondary" className="text-xs mt-1">{s.domain}</Badge>}
                                  <Badge variant="outline" className="text-xs mt-1">
                                    {requiresTierLabel}
                                  </Badge>
                                  <Badge variant="outline" className="text-xs mt-1">
                                    {(s.source_type || marketSourceType) === "remote" ? "远程市场" : "本地市场"}
                                  </Badge>
                                  {s.quality_gate_tier && (
                                    <Badge variant="outline" className="text-xs mt-1">
                                      质量门 {s.quality_gate_tier}
                                    </Badge>
                                  )}
                                  {s.quality_gate_passed === true ? (
                                    <Badge className="text-xs mt-1 bg-emerald-500/15 text-emerald-700 border border-emerald-500/25">
                                      质量门通过
                                    </Badge>
                                  ) : (
                                    <Badge className="text-xs mt-1 bg-amber-500/15 text-amber-700 border border-amber-500/25">
                                      缺失 {Array.isArray(s.quality_gate_missing) ? s.quality_gate_missing.length : 0} 项
                                    </Badge>
                                  )}
                                  {trial && (
                                    <Badge className="text-xs mt-1 bg-blue-500/15 text-blue-700 border border-blue-500/25">
                                      试用中
                                    </Badge>
                                  )}
                                </div>
                                {Array.isArray(s.quality_gate_missing) && s.quality_gate_missing.length > 0 && (
                                  <p className="mt-1 text-[11px] text-amber-700/90 dark:text-amber-300/90 line-clamp-2">
                                    待补齐：{s.quality_gate_missing.slice(0, 3).join("、")}
                                  </p>
                                )}
                                {trial && (
                                  <p className="mt-1 text-[11px] text-blue-700/90 dark:text-blue-300/90">
                                    {formatTrialRemain(trial.expires_at)}
                                  </p>
                                )}
                              </div>
                              <div className="flex flex-col gap-1 shrink-0">
                                <Button
                                  size="sm"
                                  variant="default"
                                  className="h-7"
                                  onClick={() => handleInstallMarketItem(s)}
                                  disabled={installingSkillId === (s.id ?? s.name) || !isTierAllowed(s.requires_tier)}
                                  title={!isTierAllowed(s.requires_tier) ? tierUpgradeHint(s.requires_tier) : undefined}
                                >
                                  {installingSkillId === (s.id ?? s.name) ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3 mr-1" />}
                                  安装
                                </Button>
                                <Button size="sm" variant="outline" className="h-7" onClick={() => handleOpenCompareDialog(s)} disabled={compareLoading}>
                                  对比
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7"
                                  onClick={() => setExpandedMarketPreviewKey((prev) => (prev === previewKey ? null : previewKey))}
                                >
                                  {isPreviewOpen ? "收起预览" : "效果预览"}
                                </Button>
                                {trial ? (
                                  <>
                                    <Button size="sm" variant="outline" className="h-7" onClick={() => handlePromoteTrial(trial.id)} disabled={installingSkillId === `trial:${trial.id}`}>
                                      转正
                                    </Button>
                                    <Button size="sm" variant="ghost" className="h-7" onClick={() => handleCleanupTrial(trial.id)} disabled={installingSkillId === `trial:${trial.id}`}>
                                      清理
                                    </Button>
                                  </>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    className="h-7"
                                    onClick={() => handleTrialMarketItem(s)}
                                    disabled={installingSkillId === (s.id ?? s.name) || !isTierAllowed(s.requires_tier) || !!trialLimits && trialLimits.remaining <= 0}
                                    title={!isTierAllowed(s.requires_tier) ? tierUpgradeHint(s.requires_tier) : undefined}
                                  >
                                    试用
                                  </Button>
                                )}
                              </div>
                            </div>
                            {isPreviewOpen && (
                              <div className="mt-2 rounded-md border border-border/50 bg-muted/20 p-2 text-xs whitespace-pre-wrap leading-relaxed">
                                {previewText || t("knowledge.noPreview")}
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      )})}
                    </div>
                    {filteredMarketSkills.length === 0 && (
                      <div className="rounded-md border border-dashed border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
                        {t("knowledge.noSkillsInFilter")}
                      </div>
                    )}
                  </div>
                )}
                {marketSkills.length === 0 && !marketSkillsLoading && (
                  <div className="mb-4 rounded-md border border-dashed border-border/60 bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground">{t("knowledge.noInstallableSkills")}</p>
                    <div className="mt-2 flex items-center gap-2">
                      <Button variant="outline" size="sm" className="h-7" onClick={() => setShowInstallSkillDialog(true)}>
                        从 URL 安装
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7" onClick={() => setShowDraftDialog(true)}>
                        创建草稿
                      </Button>
                    </div>
                  </div>
                )}
                <div className="text-xs font-medium text-muted-foreground mb-2">本地已安装（按领域）</div>
                {allSkillsLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <ScrollArea className="flex-1">
                    <div className="space-y-4 pr-2">
                      {groupedSkillsByDomain.domains.map((domain) => (
                        <div key={domain}>
                          <div className="text-xs font-medium text-muted-foreground mb-2">{domain}</div>
                          <div className="grid gap-2">
                            {groupedSkillsByDomain.byDomain[domain].map((s, i) => (
                              <Card key={i} className="overflow-hidden">
                                <CardContent className="p-2">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                      <span className="font-medium text-sm block">{s.display_name || s.name}</span>
                                      {s.installed_version && <span className="text-[11px] text-muted-foreground ml-1">v{s.installed_version}</span>}
                                      {s.description && (
                                        <span className="text-xs text-muted-foreground line-clamp-2 block">{s.description}</span>
                                      )}
                                      <div className="mt-1 flex items-center gap-1 flex-wrap">
                                        {s.quality_gate_tier && (
                                          <Badge variant="outline" className="text-xs">
                                            质量门 {s.quality_gate_tier}
                                          </Badge>
                                        )}
                                        {s.quality_gate_passed === true ? (
                                          <Badge className="text-xs bg-emerald-500/15 text-emerald-700 border border-emerald-500/25">
                                            通过
                                          </Badge>
                                        ) : (
                                          <Badge className="text-xs bg-amber-500/15 text-amber-700 border border-amber-500/25">
                                            待补齐 {Array.isArray(s.quality_gate_missing) ? s.quality_gate_missing.length : 0} 项
                                          </Badge>
                                        )}
                                      </div>
                                    </div>
                                    <Button size="sm" variant="ghost" className="h-7 shrink-0" onClick={() => handleOpenSkill(s)}>
                                      打开
                                    </Button>
                                  </div>
                                </CardContent>
                              </Card>
                            ))}
                          </div>
                        </div>
                      ))}
                      {groupedSkillsByDomain.domains.length === 0 && !allSkillsLoading && (
                        <div className="p-4 text-center text-sm text-muted-foreground">{t("knowledge.noSkills")}</div>
                      )}
                    </div>
                  </ScrollArea>
                )}
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <Label className="text-xs text-muted-foreground shrink-0">领域</Label>
                  <select
                    className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs disabled:opacity-60"
                    value={skillProfileId}
                    onChange={(e) => setSkillProfileId(e.target.value)}
                    disabled={skillProfilesLoading}
                  >
                    {skillProfilesLoading && (
                      <option value="">{t("common.loading")}</option>
                    )}
                    {!skillProfilesLoading && skillProfiles.length === 0 && (
                      <option value="">{t("knowledge.noDomain")}</option>
                    )}
                    {skillProfiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-2 mb-2">
                  <Button variant="outline" size="sm" onClick={() => setShowDraftDialog(true)} disabled={skillProfilesLoading}>
                    <Plus className="h-3 w-3 mr-1" />
                    生成草稿
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => loadSkillsByProfile()} disabled={skillsLoading || skillProfiles.length === 0}>
                    {skillsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                    刷新
                  </Button>
                </div>
                {skillProfilesLoading && skillProfiles.length === 0 ? (
                  <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin mr-2" />
                    加载领域列表...
                  </div>
                ) : skillProfiles.length === 0 ? (
                  <div className="p-4 text-center text-sm text-muted-foreground border rounded-md">
                    {t("knowledge.noDomainData")}
                  </div>
                ) : skillsLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <ScrollArea className="flex-1 border rounded-md">
                    <ul className="p-2 space-y-1">
                      {skillsList.map((s, i) => (
                        <li
                          key={i}
                          className="flex items-center justify-between gap-2 py-1.5 px-2 rounded hover:bg-muted/50 text-sm"
                        >
                          <div className="min-w-0 flex-1">
                            <span className="font-medium truncate block">{s.display_name || s.name}</span>
                            {s.description && (
                              <span className="text-xs text-muted-foreground truncate block">{s.description}</span>
                            )}
                          </div>
                          <div className="flex shrink-0 gap-1">
                            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => handleOpenSkill(s)}>
                              打开
                            </Button>
                            {s.kb_relative_path && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-destructive"
                                onClick={() => {
                                  setSkillToDelete(s);
                                  setShowDeleteSkillDialog(true);
                                }}
                              >
                                删除
                              </Button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                    {!skillsLoading && skillsList.length === 0 && (
                      <div className="p-4 text-center text-sm text-muted-foreground">{t("knowledge.noSkillsInDomain")}</div>
                    )}
                  </ScrollArea>
                )}
              </>
            )}
          </TabsContent>

          <TabsContent value="files" className="flex-1 overflow-hidden m-0 p-0 flex flex-col">
            {sidebarMode && (
              <div className="shrink-0 flex items-center justify-end gap-0 px-1 py-0.5 border-b border-border/40">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      onClick={() => setShowUploadDialog(true)}
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0"
                      title="上传文档"
                      aria-label="上传文档"
                    >
                      <Upload className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">上传文档</TooltipContent>
                </Tooltip>
              </div>
            )}
            <ScrollArea className="h-full flex-1 min-h-0">
              <div className="py-1">
                {kbFiles.map((item) => renderFileTreeNode(item, 0))}
                {kbFiles.length === 0 && !loading && (
                  <div className="flex flex-col items-center justify-center py-10 px-4 text-center" role="status" aria-live="polite" aria-label={t("knowledge.noFiles")}>
                    <div className="w-14 h-14 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
                      <FileText className="h-7 w-7 text-muted-foreground" />
                    </div>
                    <p className="text-sm font-medium text-foreground mb-1">{t("knowledge.noFiles")}</p>
                    <p className="text-xs text-muted-foreground mb-4">{t("knowledge.uploadHint")}</p>
                    <Button size="sm" variant="outline" className="mt-2" onClick={() => setShowUploadDialog(true)}>
                      {t("knowledge.uploadFirstDoc")}
                    </Button>
                  </div>
                )}
                {loading && kbFiles.length === 0 && (
                  <div className="space-y-1 p-2">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="flex items-center gap-2 p-2 rounded">
                        <div className="h-4 w-4 rounded bg-muted/60 animate-pulse shrink-0" />
                        <div className="flex-1 h-3 rounded bg-muted/50 animate-pulse" />
                        <div className="h-3 w-14 rounded bg-muted/40 animate-pulse" />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          {/* ✅ 搜索标签页：仅检索；问答请在主聊天区进行，Agent 会使用知识库 */}
          <TabsContent value="search" className="flex-1 flex flex-col p-3 pt-2">
            <SearchPanel
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              searchResults={searchResults}
              loading={searchLoading}
              hasSearched={hasSearched}
              onSearch={handleSearch}
              onOpenDocmap={handleOpenDocmap}
              docmapData={docmapData}
              showDocmapDialog={showDocmapDialog}
              setShowDocmapDialog={setShowDocmapDialog}
              docmapLoading={docmapLoading}
              onFileOpen={onFileOpen}
            />
          </TabsContent>
        </Tabs>
      </div>

      {/* ✅ 创建目录对话框 */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建目录</DialogTitle>
            <DialogDescription>
              在 {selectedItem?.path || 'users/demo-user'} 下创建新目录
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label>目录名称</Label>
            <Input
              value={newDirName}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewDirName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateDirectory()}
              placeholder="输入目录名称"
              className="mt-2"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              取消
            </Button>
            <Button onClick={handleCreateDirectory} disabled={loading || !newDirName.trim()}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ✅ 上传文件对话框 */}
      <Dialog open={showUploadDialog} onOpenChange={(open) => {
        setShowUploadDialog(open);
        if (!open) {
          setPendingUploadFiles([]);
          if (uploadFileInputRef.current) uploadFileInputRef.current.value = "";
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>上传文档</DialogTitle>
            <DialogDescription>
              上传到: {selectedItem?.type === 'directory' ? selectedItem.path : (selectedItem?.path || '请先选择目录')}。选择文件后点击「确定」上传。
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-3">
            <Input
              ref={uploadFileInputRef}
              type="file"
              accept=".md,.txt,.pdf,.docx,.doc"
              multiple
              onChange={(e) => {
                const list = e.target.files;
                if (!list?.length) return;
                setPendingUploadFiles((prev) => [...prev, ...Array.from(list)]);
                e.target.value = "";
              }}
            />
            {pendingUploadFiles.length > 0 && (
              <ul className="border rounded-md divide-y divide-border max-h-40 overflow-y-auto">
                {pendingUploadFiles.map((file, idx) => (
                  <li key={`${file.name}-${idx}`} className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm">
                    <span className="truncate min-w-0" title={file.name}>{file.name}</span>
                    <span className="text-muted-foreground shrink-0 text-xs">{(file.size / 1024).toFixed(1)} KB</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0"
                      onClick={() => setPendingUploadFiles((prev) => prev.filter((_, i) => i !== idx))}
                      aria-label="移除"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={uploadBuildOntology}
                onChange={(e) => setUploadBuildOntology(e.target.checked)}
                className="rounded"
              />
              上传后构建知识图谱
            </label>
            <p className="text-xs text-muted-foreground">
              上传后需执行构建才能生成图谱；勾选则在上传完成后自动触发构建。支持 .md, .txt, .pdf, .docx, .doc
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowUploadDialog(false); setPendingUploadFiles([]); if (uploadFileInputRef.current) uploadFileInputRef.current.value = ""; }}>
              取消
            </Button>
            <Button
              onClick={() => pendingUploadFiles.length > 0 && handleFileUpload(pendingUploadFiles)}
              disabled={pendingUploadFiles.length === 0 || loading}
            >
              确定上传
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ✅ 删除确认对话框 */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>
              确定要删除 "{itemToDelete?.name}" 吗？此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              取消
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={loading}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除技能确认 */}
      <Dialog open={showDeleteSkillDialog} onOpenChange={setShowDeleteSkillDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除技能</DialogTitle>
            <DialogDescription>
              确定要删除「{skillToDelete?.display_name ?? skillToDelete?.name}」吗？对应的 SKILL 文件将被删除，此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowDeleteSkillDialog(false); setSkillToDelete(null); }}>取消</Button>
            <Button variant="destructive" onClick={handleDeleteSkill}>删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 生成 SKILL 草稿对话框 */}
      <Dialog open={showDraftDialog} onOpenChange={setShowDraftDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>生成技能草稿</DialogTitle>
            <DialogDescription>
              将刚才的流程存成技能草稿，写入 knowledge_base/learned/skills/，可后续编辑完善。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>技能名称</Label>
              <Input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="例如：招标分析"
                className="mt-1"
              />
            </div>
            <div>
              <Label>描述（可选）</Label>
              <Input
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                placeholder="简要描述该技能的用途"
                className="mt-1"
              />
            </div>
            <div>
              <Label>步骤摘要（可选）</Label>
              <textarea
                value={draftSteps}
                onChange={(e) => setDraftSteps(e.target.value)}
                placeholder="可粘贴或简述执行步骤，供草稿正文使用"
                className="mt-1 w-full min-h-[80px] rounded border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <Label>质量门层级</Label>
              <select
                value={draftQualityTier}
                onChange={(e) => setDraftQualityTier((e.target.value || "core") as "core" | "pro" | "enterprise" | "community")}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="core">core（免费体验）</option>
                <option value="pro">pro（专业交付）</option>
                <option value="enterprise">enterprise（企业定制）</option>
                <option value="community">community（社区共建）</option>
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDraftDialog(false)}>取消</Button>
            <Button onClick={handleGenerateDraftSubmit}>生成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 技能效果对比 */}
      <Dialog open={showSkillCompareDialog} onOpenChange={setShowSkillCompareDialog}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>技能效果对比</DialogTitle>
            <DialogDescription>
              {compareTarget ? `对比技能：${compareTarget.name}` : "对比通用回答与技能增强回答"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div>
              <Label className="text-xs">测试问题</Label>
              <Input
                value={compareQuery}
                onChange={(e) => setCompareQuery(e.target.value)}
                placeholder="输入你要对比的任务问题"
                className="mt-1"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!compareTarget || compareLoading}
                onClick={() => {
                  if (!compareTarget) return;
                  void runSkillDemoCompare(compareTarget, compareQuery.trim() || "请给出该任务的执行步骤与风险提示。");
                }}
              >
                {compareLoading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                重新对比
              </Button>
            </div>
            {compareResult?.metrics && compareResult.metrics.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                {compareResult.metrics.map((m, idx) => (
                  <div key={`${m.label}-${idx}`} className="rounded border border-border/50 bg-muted/20 p-2 text-xs">
                    <div className="text-muted-foreground">{m.label}</div>
                    <div className="mt-1 font-medium">通用 {m.baseline} / 技能 {m.skill}</div>
                  </div>
                ))}
              </div>
            )}
            {compareResult && (
              <ComparisonUI
                title={compareResult.title}
                leftTitle={compareResult.left_title}
                rightTitle={compareResult.right_title}
                left={compareResult.left}
                right={compareResult.right}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* 从 URL 或内容安装 Skill（技能市场） */}
      <Dialog open={showInstallSkillDialog} onOpenChange={setShowInstallSkillDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>从 URL 或内容安装 Skill</DialogTitle>
            <DialogDescription>
              填写可访问的 SKILL.md 地址，或直接粘贴 SKILL 文档内容，安装到本地 knowledge_base/skills/。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className="text-xs">URL（可选）</Label>
              <Input
                value={installSkillUrl}
                onChange={(e) => setInstallSkillUrl(e.target.value)}
                placeholder="https://... 或留空并粘贴内容"
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">或粘贴 SKILL 内容</Label>
              <textarea
                value={installSkillContent}
                onChange={(e) => setInstallSkillContent(e.target.value)}
                placeholder={'---\nname: xxx\ndescription: ...\n---\n\n# 标题\n...'}
                className="mt-1 w-full min-h-[120px] rounded border border-input bg-background px-3 py-2 text-sm font-mono"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">技能名称（可选，可从内容解析）</Label>
                <Input value={installSkillName} onChange={(e) => setInstallSkillName(e.target.value)} placeholder="name" className="mt-1" />
              </div>
              <div>
                <Label className="text-xs">领域</Label>
                <Input value={installSkillDomain} onChange={(e) => setInstallSkillDomain(e.target.value)} placeholder="general" className="mt-1" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowInstallSkillDialog(false); setInstallSkillUrl(""); setInstallSkillContent(""); }}>取消</Button>
            <Button onClick={handleInstallFromMarket} disabled={installingSkillId === "__url_install__" || (!installSkillUrl.trim() && !installSkillContent.trim())}>
              {installingSkillId === "__url_install__" ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              安装
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OntologyManageDialog
        open={showOntologyDialog}
        onOpenChange={setShowOntologyDialog}
        onOpenInEditor={onOpenKnowledgeGraphInEditor}
      />
      <BuildOntologyDialog
        open={showBuildOntologyDialog}
        onOpenChange={setShowBuildOntologyDialog}
        onBuilt={() => {
          if (showOntologyDialog) setShowOntologyDialog(true);
        }}
      />
      <ImportFolderDialog open={showImportFolderDialog} onOpenChange={setShowImportFolderDialog} />
    </div>
    </TooltipProvider>
  );
}

