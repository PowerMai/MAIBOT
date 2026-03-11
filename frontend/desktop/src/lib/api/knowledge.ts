/**
 * 知识库 API
 * 
 * 统一的知识库管理 API，对接后端 knowledge_api.py
 * 
 * 功能：
 * - 知识库结构管理（文件夹、文件）
 * - 文档上传/删除
 * - 知识库搜索（向量检索）
 * - 索引刷新
 * 
 * 设计原则（参考 Cursor/Claude）：
 * - 用户只管理自己的知识库（左边栏显示）
 * - 团队知识库用户可见但只读
 * - 领域/系统知识库对用户透明，Agent 自动使用
 */

import { NetworkError, NotFoundError, ServiceUnavailableError } from './errors';
import { getApiBase } from './langserveChat';
import { getInternalAuthHeaders } from './internalAuth';

export type KnowledgeScope = 'user' | 'team' | 'domain' | 'system';

export interface KnowledgeScopeConfig {
  scope: KnowledgeScope;
  label: string;
  description: string;
  userVisible: boolean;
  userEditable: boolean;
  showInSidebar: boolean;
  showInBrowser: boolean;
  basePath: string;
}

export const KNOWLEDGE_SCOPES: Record<KnowledgeScope, KnowledgeScopeConfig> = {
  user: {
    scope: 'user',
    label: '我的知识库',
    description: '个人上传的文档和笔记',
    userVisible: true,
    userEditable: true,
    showInSidebar: true,
    showInBrowser: true,
    basePath: 'users',
  },
  team: {
    scope: 'team',
    label: '团队知识库',
    description: '团队共享的文档（只读）',
    userVisible: true,
    userEditable: false,
    showInSidebar: false,
    showInBrowser: true,
    basePath: 'teams',
  },
  domain: {
    scope: 'domain',
    label: '领域知识',
    description: '招投标、合同等专业知识（Agent 自动使用）',
    userVisible: false,
    userEditable: false,
    showInSidebar: false,
    showInBrowser: false,
    basePath: 'global/domains',
  },
  system: {
    scope: 'system',
    label: '系统知识',
    description: 'Skills、工具指南等（完全透明）',
    userVisible: false,
    userEditable: false,
    showInSidebar: false,
    showInBrowser: false,
    basePath: 'global/system',
  },
};

export function getSidebarScopes(): KnowledgeScope[] {
  return Object.values(KNOWLEDGE_SCOPES)
    .filter(config => config.showInSidebar)
    .map(config => config.scope);
}

export function canUserEdit(scope: KnowledgeScope): boolean {
  return KNOWLEDGE_SCOPES[scope]?.userEditable ?? false;
}

export function getKnowledgePath(scope: KnowledgeScope, identifier?: string): string {
  const config = KNOWLEDGE_SCOPES[scope];
  if (!config) return '';
  if (identifier) {
    return `${config.basePath}/${identifier}`;
  }
  return config.basePath;
}

// ============================================================
// 错误处理辅助函数
// ============================================================

async function handleApiError(response: Response, defaultMessage: string): Promise<never> {
  let errorMessage = defaultMessage;
  
  try {
    const error = await response.json();
    errorMessage = error.detail || error.message || defaultMessage;
  } catch {
    // JSON 解析失败，使用默认消息
  }
  
  switch (response.status) {
    case 404:
      throw new NotFoundError(errorMessage);
    case 503:
      throw new ServiceUnavailableError(errorMessage);
    default:
      throw new Error(errorMessage);
  }
}

async function safeFetch(url: string, options?: RequestInit): Promise<Response> {
  const headers = { ...getInternalAuthHeaders(), ...(options?.headers as Record<string, string> || {}) };
  try {
    return await fetch(url, { ...options, headers });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const isNetwork =
      (error instanceof TypeError && msg.includes('fetch')) ||
      (error instanceof Error && error.name === 'AbortError') ||
      /network|failed to fetch|load failed|timeout|econnrefused|enotfound/i.test(msg);
    if (isNetwork) {
      throw new NetworkError('无法连接到知识库服务');
    }
    throw error;
  }
}

// ============================================================
// 类型定义
// ============================================================

export interface KBItem {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  extension?: string;
  children?: KBItem[];
  count?: number;
  scope?: KnowledgeScope;  // 知识库层级
}

export interface KBStructure {
  scope: string;
  structure: KBItem[];
}

export interface SearchResult {
  content: string;
  source: string;
  score: number;
  metadata: Record<string, unknown>;
  scope?: KnowledgeScope;  // 结果来自哪个层级
}

export interface UploadResponse {
  success: boolean;
  path: string;
  message: string;
  ontology_build_triggered?: boolean | null;
}

/** 知识库/本体可观测指标（GET /knowledge/metrics） */
export interface KnowledgeMetricsResponse {
  success: boolean;
  metrics: {
    upload_count: number;
    import_count: number;
    ontology_build_triggered: number;
    ontology_build_success: number;
    ontology_build_failure: number;
  };
  ontology_build_success_rate: number | null;
}

export interface RefreshResponse {
  success: boolean;
  documents_count: number;
  chunks_count: number;
  message: string;
}

/** 知识库元数据（scopes 文档数、本体实体/关系数） */
export interface KnowledgeMetadataResponse {
  success: boolean;
  scopes: Record<string, { path: string; document_count: number }>;
  entity_count: number;
  relation_count: number;
}

/** 本体实体 */
export interface OntologyEntity {
  id?: string;
  name?: string;
  type?: string;
  [key: string]: unknown;
}

/** 本体关系 */
export interface OntologyRelation {
  source?: string;
  target?: string;
  type?: string;
  [key: string]: unknown;
}

/** 图谱节点（可视化） */
export interface GraphNode {
  id: string;
  label: string;
  type: string;
  properties?: Record<string, unknown>;
  size?: number;
  mentionCount?: number;
}

/** 图谱边（可视化） */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  type: string;
  confidence?: number;
}

/** 图谱数据（可视化） */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    totalEntities: number;
    totalRelations: number;
    entitiesByType: Record<string, number>;
    relationsByType: Record<string, number>;
  };
}

/** 图谱统计 */
export interface GraphStats {
  totalEntities: number;
  totalRelations: number;
  entitiesByType: Record<string, number>;
  relationsByType: Record<string, number>;
  topConnectedEntities: Array<{ id: string; name: string; connections: number }>;
  isolatedEntitiesCount: number;
}

/** 本体构建结果 */
export interface BuildResult {
  taskId: string;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  stats: {
    filesProcessed: number;
    entitiesAdded: number;
    relationsAdded: number;
    errors: number;
  };
  progress?: number;
  error?: string;
}

// ============================================================
// API 函数
// ============================================================

export const knowledgeAPI = {
  /**
   * 获取知识库结构。maxDepth=1 仅返回根及直接子项（懒加载用），子级由 listDirectory 按需加载。
   */
  getStructure: async (
    scope: string = 'all',
    teamId?: string,
    userId?: string,
    maxDepth: number = 1,
    workspacePath?: string
  ): Promise<KBStructure> => {
    const params = new URLSearchParams({ scope, max_depth: String(maxDepth) });
    if (teamId) params.append('team_id', teamId);
    if (userId) params.append('user_id', userId);
    if (workspacePath) params.append('workspace_path', workspacePath);

    const response = await safeFetch(`${getApiBase()}/knowledge/structure?${params}`);
    if (!response.ok) {
      await handleApiError(response, '获取知识库结构失败');
    }
    return response.json();
  },

  /**
   * 仅返回知识库根节点列表，无 children。子级由 listDirectory 按需加载。
   */
  getTreeRoots: async (
    scope: string = 'all',
    teamId?: string,
    userId?: string,
    workspacePath?: string
  ): Promise<KBItem[]> => {
    const params = new URLSearchParams({ scope });
    if (teamId) params.append('team_id', teamId);
    if (userId) params.append('user_id', userId);
    if (workspacePath) params.append('workspace_path', workspacePath);

    const response = await safeFetch(`${getApiBase()}/knowledge/tree/roots?${params}`);
    if (!response.ok) {
      await handleApiError(response, '获取知识库根节点失败');
    }
    const raw = await response.json() as Array<{ path: string; name: string; type: string }>;
    return raw.map((item) => ({
      path: item.path,
      name: item.name,
      type: (item.type === 'directory' ? 'directory' : 'file') as 'file' | 'directory',
    }));
  },

  /**
   * 列出知识库指定目录内容（懒加载，相对 KB 根路径）
   */
  listDirectory: async (path: string = '', maxDepth: number = 1, workspacePath?: string): Promise<KBItem[]> => {
    const params = new URLSearchParams({ path, max_depth: String(maxDepth) });
    if (workspacePath) params.append('workspace_path', workspacePath);
    const response = await safeFetch(`${getApiBase()}/knowledge/list?${params}`);
    if (!response.ok) {
      await handleApiError(response, '列出目录失败');
    }
    const raw = await response.json() as Array<{ path: string; name: string; type: string; size?: number; extension?: string }>;
    return raw.map((item) => ({
      path: item.path,
      name: item.name,
      type: (item.type === 'directory' ? 'directory' : 'file') as 'file' | 'directory',
      size: item.size,
      ...(item.type === 'file' && item.extension != null && { extension: item.extension }),
    }));
  },

  /**
   * 上传文档到知识库。可选上传后触发本体构建（buildOntology=true）。
   */
  uploadDocument: async (
    file: File,
    targetPath: string,
    options?: { buildOntology?: boolean }
  ): Promise<UploadResponse> => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('target_path', targetPath);
    if (options?.buildOntology === true) {
      formData.append('build_ontology', 'true');
    }
    const response = await safeFetch(`${getApiBase()}/knowledge/upload`, {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) {
      await handleApiError(response, '上传失败');
    }
    return response.json();
  },

  /**
   * 从 URL 导入资源到知识库（抓取 URL 内容并保存为文件）
   */
  importFromUrl: async (params: {
    url: string;
    target_path?: string;
    filename?: string;
  }): Promise<{ success: boolean; path: string; message: string }> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/import-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: params.url,
        target_path: params.target_path ?? 'global/imported',
        filename: params.filename,
      }),
    });
    if (!response.ok) {
      await handleApiError(response, 'URL 导入失败');
    }
    return response.json();
  },

  /**
   * 从本地文件夹批量导入到知识库（复制文件到 target_scope，并触发索引刷新）。可选导入后触发本体构建（build_ontology=true）。
   */
  importFolder: async (params: {
    source_path: string;
    target_scope?: string;
    recursive?: boolean;
    file_types?: string[];
    build_ontology?: boolean;
  }): Promise<{
    imported_count: number;
    skipped_count: number;
    errors: string[];
    imported_files: string[];
    index_rebuilt?: boolean;
    ontology_build_triggered?: boolean;
    message?: string;
  }> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/import-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_path: params.source_path,
        target_scope: params.target_scope ?? 'domain/bidding',
        recursive: params.recursive ?? true,
        file_types: params.file_types ?? ['.md', '.txt', '.pdf', '.docx'],
        ...(params.build_ontology !== undefined && { build_ontology: params.build_ontology }),
      }),
    });
    if (!response.ok) {
      await handleApiError(response, '文件夹导入失败');
    }
    return response.json();
  },

  /**
   * 创建知识构建看板任务（异步执行：导入 → 刷新索引 → 构建本体 → 可选 Skills），返回 task_id，可在任务面板查看进度
   */
  createBuildTask: async (params: {
    source_path: string;
    target_scope?: string;
    operations?: string[];
  }): Promise<{ task_id: string; message?: string }> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/build-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_path: params.source_path,
        target_scope: params.target_scope ?? 'domain/bidding',
        operations: params.operations ?? ['import', 'index', 'ontology'],
      }),
    });
    if (!response.ok) {
      await handleApiError(response, '创建知识构建任务失败');
    }
    return response.json();
  },

  /**
   * 删除知识库文档或目录
   */
  deleteDocument: async (path: string): Promise<{ success: boolean; message: string }> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/document?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    });
    
    if (!response.ok) {
      await handleApiError(response, '删除失败');
    }
    return response.json();
  },

  /**
   * 刷新知识库索引
   */
  refresh: async (
    scope: string = 'all',
    teamId?: string,
    userId?: string,
    mode: 'cache-only' | 'incremental' | 'full' = 'incremental',
    workspacePath?: string
  ): Promise<RefreshResponse> => {
    const params = new URLSearchParams({ scope });
    if (teamId) params.append('team_id', teamId);
    if (userId) params.append('user_id', userId);
    params.append('mode', mode);
    if (workspacePath) params.append('workspace_path', workspacePath);

    const response = await safeFetch(`${getApiBase()}/knowledge/refresh?${params}`, {
      method: 'POST',
    });
    
    if (!response.ok) {
      await handleApiError(response, '刷新失败');
    }
    return response.json();
  },

  /**
   * 搜索知识库
   */
  search: async (
    query: string,
    k: number = 5,
    scope: string = 'all',
    teamId?: string,
    userId?: string,
    workspacePath?: string
  ): Promise<SearchResult[]> => {
    const params = new URLSearchParams({
      query,
      k: k.toString(),
      scope,
    });
    if (teamId) params.append('team_id', teamId);
    if (userId) params.append('user_id', userId);
    if (workspacePath) params.append('workspace_path', workspacePath);

    const response = await safeFetch(`${getApiBase()}/knowledge/search?${params}`);
    if (!response.ok) {
      await handleApiError(response, '搜索失败');
    }
    return response.json();
  },

  /**
   * 获取文档结构（DocMap）：章节与行号
   */
  getDocumentDocmap: async (path: string): Promise<{
    path: string;
    name: string;
    sections: Array<{ title: string; line: number; level: number }>;
    keywords: string[];
    message?: string;
  }> => {
    const response = await safeFetch(
      `${getApiBase()}/knowledge/document/docmap?path=${encodeURIComponent(path)}`
    );
    if (!response.ok) {
      await handleApiError(response, '获取文档结构失败');
    }
    return response.json();
  },

  /**
   * 获取文档内容
   */
  getDocument: async (path: string): Promise<{
    path: string;
    name: string;
    type: string;
    content: string | null;
    message?: string;
  }> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/document?path=${encodeURIComponent(path)}`);
    if (!response.ok) {
      await handleApiError(response, '获取文档失败');
    }
    return response.json();
  },

  /**
   * 创建目录
   */
  createDirectory: async (path: string): Promise<{ success: boolean; path: string; message: string }> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/directory?path=${encodeURIComponent(path)}`, {
      method: 'POST',
    });
    
    if (!response.ok) {
      await handleApiError(response, '创建目录失败');
    }
    return response.json();
  },

  /**
   * 获取知识库元数据（scopes 文档数、本体实体/关系数）
   */
  getMetadata: async (): Promise<KnowledgeMetadataResponse> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/metadata`);
    if (!response.ok) {
      await handleApiError(response, '获取元数据失败');
    }
    return response.json();
  },

  /**
   * 获取知识库/本体可观测指标（上传与构建计数、构建成功率）
   */
  getMetrics: async (): Promise<KnowledgeMetricsResponse> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/metrics`);
    if (!response.ok) {
      await handleApiError(response, '获取指标失败');
    }
    return response.json();
  },

  /**
   * 获取本体实体列表
   */
  getOntologyEntities: async (): Promise<{ success: boolean; entities: OntologyEntity[]; total: number }> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/ontology/entities`);
    if (!response.ok) {
      await handleApiError(response, '获取实体列表失败');
    }
    return response.json();
  },

  /**
   * 获取本体关系列表
   */
  getOntologyRelations: async (): Promise<{ success: boolean; relations: OntologyRelation[]; total: number }> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/ontology/relations`);
    if (!response.ok) {
      await handleApiError(response, '获取关系列表失败');
    }
    return response.json();
  },

  /**
   * 新增本体实体
   */
  createOntologyEntity: async (entity: OntologyEntity): Promise<{ success: boolean; entity: OntologyEntity }> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/ontology/entities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entity),
    });
    if (!response.ok) {
      await handleApiError(response, '创建实体失败');
    }
    return response.json();
  },

  /**
   * 更新本体实体
   */
  updateOntologyEntity: async (entityId: string, entity: OntologyEntity): Promise<{ success: boolean; entity: OntologyEntity }> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/ontology/entities/${encodeURIComponent(entityId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entity),
    });
    if (!response.ok) {
      await handleApiError(response, '更新实体失败');
    }
    return response.json();
  },

  /**
   * 删除本体实体
   */
  deleteOntologyEntity: async (entityId: string): Promise<{ success: boolean; message: string }> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/ontology/entities/${encodeURIComponent(entityId)}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      await handleApiError(response, '删除实体失败');
    }
    return response.json();
  },

  /**
   * 新增本体关系
   */
  createOntologyRelation: async (relation: OntologyRelation): Promise<{ success: boolean; relation: OntologyRelation }> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/ontology/relations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(relation),
    });
    if (!response.ok) {
      await handleApiError(response, '创建关系失败');
    }
    return response.json();
  },

  /**
   * 按索引删除本体关系
   */
  deleteOntologyRelation: async (index: number): Promise<{ success: boolean; message: string }> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/ontology/relations/${index}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      await handleApiError(response, '删除关系失败');
    }
    return response.json();
  },

  // ---------- 知识图谱可视化 API ----------
  getGraphData: async (
    limit?: number,
    entityType?: string,
    relationType?: string
  ): Promise<GraphData> => {
    const params = new URLSearchParams();
    if (limit != null) params.set('limit', String(limit));
    if (entityType) params.set('entity_type', entityType);
    if (relationType) params.set('relation_type', relationType);
    const response = await safeFetch(`${getApiBase()}/knowledge/graph/data?${params}`);
    if (!response.ok) {
      await handleApiError(response, '获取图谱数据失败');
    }
    return response.json();
  },

  getSubgraph: async (
    entityId: string,
    depth?: number,
    maxNodes?: number
  ): Promise<GraphData> => {
    const params = new URLSearchParams();
    if (depth != null) params.set('depth', String(depth));
    if (maxNodes != null) params.set('max_nodes', String(maxNodes));
    const response = await safeFetch(
      `${getApiBase()}/knowledge/graph/subgraph/${encodeURIComponent(entityId)}?${params}`
    );
    if (!response.ok) {
      await handleApiError(response, '获取子图失败');
    }
    return response.json();
  },

  getGraphStats: async (): Promise<GraphStats> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/graph/stats`);
    if (!response.ok) {
      await handleApiError(response, '获取图谱统计失败');
    }
    const raw = await response.json() as {
      total_entities?: number;
      total_relations?: number;
      entities_by_type?: Record<string, number>;
      relations_by_type?: Record<string, number>;
      top_connected_entities?: Array<{ id: string; name: string; connections: number }>;
      isolated_entities_count?: number;
    };
    return {
      totalEntities: raw.total_entities ?? 0,
      totalRelations: raw.total_relations ?? 0,
      entitiesByType: raw.entities_by_type ?? {},
      relationsByType: raw.relations_by_type ?? {},
      topConnectedEntities: raw.top_connected_entities ?? [],
      isolatedEntitiesCount: raw.isolated_entities_count ?? 0,
    };
  },

  searchGraph: async (
    query: string,
    entityType?: string,
    limit?: number
  ): Promise<{ entities: Array<{ id: string; name: string; type: string; properties?: Record<string, unknown> }>; total: number }> => {
    const params = new URLSearchParams({ q: query });
    if (entityType) params.set('entity_type', entityType);
    if (limit != null) params.set('limit', String(limit));
    const response = await safeFetch(`${getApiBase()}/knowledge/graph/search?${params}`);
    if (!response.ok) {
      await handleApiError(response, '图谱搜索失败');
    }
    return response.json();
  },

  getEntityNeighbors: async (
    entityId: string,
    relationTypes?: string[],
    direction?: string
  ): Promise<GraphData> => {
    const params = new URLSearchParams();
    if (relationTypes?.length) params.set('relation_types', relationTypes.join(','));
    if (direction) params.set('direction', direction);
    const response = await safeFetch(
      `${getApiBase()}/knowledge/graph/entity/${encodeURIComponent(entityId)}/neighbors?${params}`
    );
    if (!response.ok) {
      await handleApiError(response, '获取邻居失败');
    }
    return response.json();
  },

  // ---------- 本体构建 API ----------
  buildOntology: async (
    directory: string,
    domain: string,
    useLlm?: boolean
  ): Promise<BuildResult> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/ontology/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory, domain, use_llm: useLlm, recursive: true }),
    });
    if (!response.ok) {
      await handleApiError(response, '构建本体失败');
    }
    const data = await response.json();
    const raw = data.stats ?? {};
    return {
      taskId: data.task_id,
      status: data.status || 'completed',
      stats: {
        filesProcessed: raw.files_processed ?? 0,
        entitiesAdded: raw.entities_added ?? 0,
        relationsAdded: raw.relations_added ?? 0,
        errors: raw.errors ?? 0,
      },
      error: data.error,
    };
  },

  getBuildStatus: async (taskId: string): Promise<BuildResult> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/ontology/build/status/${taskId}`);
    if (!response.ok) {
      return { taskId, status: 'unknown', stats: { filesProcessed: 0, entitiesAdded: 0, relationsAdded: 0, errors: 0 } };
    }
    const data = await response.json();
    const raw = data.stats ?? {};
    return {
      taskId: data.task_id || taskId,
      status: data.status || 'unknown',
      stats: {
        filesProcessed: raw.files_processed ?? 0,
        entitiesAdded: raw.entities_added ?? 0,
        relationsAdded: raw.relations_added ?? 0,
        errors: raw.errors ?? 0,
      },
      error: data.error,
    };
  },

  validateOntology: async (): Promise<{ valid: boolean; issues: string[]; stats: Record<string, number> }> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/ontology/validate`, {
      method: 'POST',
    });
    if (!response.ok) {
      await handleApiError(response, '验证本体失败');
    }
    return response.json();
  },

  getOntologySchema: async (): Promise<Record<string, unknown>> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/ontology/schema`);
    if (!response.ok) {
      return { entity_types: {}, relation_types: {}, domain: 'general' };
    }
    return response.json();
  },

  updateOntologySchema: async (schema: Record<string, unknown>): Promise<{ success: boolean }> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/ontology/schema`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(schema),
    });
    if (!response.ok) {
      await handleApiError(response, '更新模式失败');
    }
    return response.json();
  },

  /** 批量导入实体与关系 */
  importOntology: async (payload: {
    entities?: Array<{ id?: string; name?: string; type?: string; [key: string]: unknown }>;
    relations?: Array<{ source: string; target: string; type?: string }>;
  }): Promise<{ success: boolean; entitiesAdded: number; relationsAdded: number; errors: string[] }> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/ontology/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      await handleApiError(response, '批量导入失败');
    }
    const data = await response.json();
    return {
      success: data.success ?? false,
      entitiesAdded: data.entities_added ?? 0,
      relationsAdded: data.relations_added ?? 0,
      errors: data.errors ?? [],
    };
  },

  /** 获取知识库同步状态 */
  getSyncStatus: async (userId = 'default', domain = 'bidding'): Promise<{
    last_sync_ts: number | null;
    cloud_version: string | null;
    expired: boolean;
    cached: boolean;
  }> => {
    const params = new URLSearchParams({ user_id: userId, domain });
    const response = await safeFetch(`${getApiBase()}/knowledge/sync/status?${params}`);
    if (!response.ok) {
      return { last_sync_ts: null, cloud_version: null, expired: true, cached: false };
    }
    return response.json();
  },

  /** 触发知识库云端同步 */
  triggerSync: async (userId = 'default', domain = 'bidding'): Promise<{
    success: boolean;
    message: string;
    entries_count: number;
  }> => {
    const response = await safeFetch(`${getApiBase()}/knowledge/sync/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, domain }),
    });
    if (!response.ok) {
      return { success: false, message: '同步请求失败', entries_count: 0 };
    }
    return response.json();
  },
};

export default knowledgeAPI;