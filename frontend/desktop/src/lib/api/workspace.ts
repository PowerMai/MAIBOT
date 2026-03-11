/**
 * 工作区文件系统 API 客户端
 * 
 * 与后端影子工作区 API 通信，提供：
 * - 工作区管理（创建、列表、删除）
 * - 文件操作（读写、目录操作）
 * - 文件树同步
 */

import { getApiBase } from './langserveChat';
import { getInternalAuthHeaders } from './internalAuth';
import { getItem as getStorageItem, setItem as setStorageItem, removeItem as removeStorageItem } from '../safeStorage';
import { EVENTS } from '../constants';

// 获取后端基础 URL（与 LangGraph 同机，统一使用 2024）
const getBaseUrl = () => {
  return getApiBase();
};

// ============= 类型定义 =============

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  mode: 'virtual' | 'linked';
  created_at: string;
  updated_at: string;
  file_count: number;
  domain?: string;
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  size: number;
  modified_at?: string;
  children?: FileNode[];
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

// ============= API 函数 =============

const API_PREFIX = '';

const normalizeJoin = (base: string, rel: string): string => {
  const cleanBase = String(base || '').replace(/[\\/]+$/, '');
  let cleanRel = String(rel || '').trim();
  if (cleanRel.includes('..')) return cleanBase;
  cleanRel = cleanRel.replace(/^[\\/]/, '');
  if (!cleanRel) return cleanBase;
  if (!cleanBase) return cleanRel;
  return `${cleanBase}/${cleanRel}`;
};

const isAbsolutePath = (value: string): boolean => {
  return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value);
};

async function resolveWorkspacePath(workspaceId: string, rawPath: string): Promise<string> {
  const input = String(rawPath || '.').trim();
  if (!input || input === '.') {
    const ws = await getWorkspace(workspaceId);
    return ws.path || '.';
  }
  if (input.startsWith('workspace/')) return input;
  if (isAbsolutePath(input)) {
    const ws = await getWorkspace(workspaceId);
    return ws.path || '.';
  }
  const ws = await getWorkspace(workspaceId);
  if (!ws.path) return input;
  return normalizeJoin(ws.path, input);
}

const decodeApiError = async (response: Response): Promise<string> => {
  const body = await response.json().catch(() => ({} as any));
  return String((body as any)?.detail || (body as any)?.error || `HTTP ${response.status}`);
};

/** 先调后端切换工作区，失败则抛出，供「先确认后写入」流程使用 */
async function syncWorkspaceRoot(path: string): Promise<void> {
  const target = String(path || '').trim();
  if (!target || !isAbsolutePath(target)) return;
  const resp = await fetch(`${getBaseUrl()}${API_PREFIX}/workspace/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: target }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(text || `HTTP ${resp.status}`);
  }
}

/** 供 WorkspaceFileTree 等调用：先调后端切换工作区，成功后再写前端 storage，避免分叉 */
export async function switchWorkspaceByPath(path: string): Promise<void> {
  const target = String(path || '').trim();
  if (!target) return;
  const resp = await fetch(`${getBaseUrl()}${API_PREFIX}/workspace/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: target }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(text || `HTTP ${resp.status}`);
  }
}

/**
 * 获取所有工作区
 * ✅ 从本地存储读取
 */
export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  try {
    const workspaces = JSON.parse(getStorageItem('workspaces') || '[]') as WorkspaceInfo[];
    return workspaces;
  } catch {
    return [];
  }
}

/**
 * 创建新工作区
 * ✅ 使用本地存储，不依赖后端 API
 */
export async function createWorkspace(params: {
  name: string;
  mode?: 'virtual' | 'linked';
  linked_path?: string;
  domain?: string;
}): Promise<WorkspaceInfo> {
  // 生成唯一 ID
  const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  
  const workspace: WorkspaceInfo = {
    id,
    name: params.name,
    path: params.linked_path || `workspace/${id}`,
    mode: params.mode || 'virtual',
    created_at: now,
    updated_at: now,
    file_count: 0,
    domain: params.domain,
  };
  
  // 保存到本地存储
  try {
    const workspaces = JSON.parse(getStorageItem('workspaces') || '[]') as WorkspaceInfo[];
    workspaces.push(workspace);
    setStorageItem('workspaces', JSON.stringify(workspaces));
  } catch (e) {
    console.error('[workspace] Failed to save workspace to localStorage:', e);
  }
  
  return workspace;
}

/**
 * 获取工作区详情
 * ✅ 从本地存储读取
 */
export async function getWorkspace(workspaceId: string): Promise<WorkspaceInfo> {
  let workspace: WorkspaceInfo | undefined;
  try {
    const workspaces = JSON.parse(getStorageItem('workspaces') || '[]') as WorkspaceInfo[];
    workspace = workspaces.find(ws => ws.id === workspaceId);
  } catch (e) {
    throw new Error(`Failed to get workspace: ${e}`);
  }
  if (!workspace) throw new Error('Workspace not found');
  return workspace;
}

/**
 * 删除工作区
 * ✅ 从本地存储删除
 */
export async function deleteWorkspace(workspaceId: string, _deleteFiles = false): Promise<void> {
  try {
    const workspaces = JSON.parse(getStorageItem('workspaces') || '[]') as WorkspaceInfo[];
    const filtered = workspaces.filter(ws => ws.id !== workspaceId);
    setStorageItem('workspaces', JSON.stringify(filtered));
  } catch (e) {
    throw new Error(`Failed to delete workspace: ${e}`);
  }
}

/**
 * 获取文件树
 * ✅ 从本地存储获取工作区信息，返回空树或使用 Electron 本地文件系统
 */
export async function getFileTree(
  workspaceId: string,
  depth = 3,
  _showHidden = false
): Promise<FileNode> {
  const workspace = await getWorkspace(workspaceId);
  const rootPath = workspace.path || '.';
  const url = `${getBaseUrl()}${API_PREFIX}/files/tree?path=${encodeURIComponent(rootPath)}&max_depth=${Math.max(1, depth)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await decodeApiError(response));
  }
  const data = await response.json().catch(() => {
    throw new Error('响应解析失败');
  });
  const toNode = (node: any): FileNode => ({
    name: String(node?.name || ''),
    path: String(node?.path || ''),
    type: node?.type === 'folder' ? 'folder' : 'file',
    size: Number(node?.size || 0),
    children: Array.isArray(node?.children) ? node.children.map(toNode) : [],
  });
  return toNode(data || {});
}

/**
 * 按绝对路径获取文件树（不依赖 workspaceId），供 @ 文件候选等使用。
 */
export async function getFileTreeByPath(
  rootPath: string,
  depth = 4
): Promise<FileNode> {
  const trimmed = String(rootPath || '').trim();
  if (!trimmed) {
    return { name: '', path: '', type: 'folder', size: 0, children: [] };
  }
  const url = `${getBaseUrl()}${API_PREFIX}/files/tree?path=${encodeURIComponent(trimmed)}&max_depth=${Math.max(1, depth)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await decodeApiError(response));
  }
  const data = await response.json().catch(() => {
    throw new Error('响应解析失败');
  });
  const root = data && typeof data === 'object' ? data : {};
  const toNode = (node: any): FileNode => ({
    name: String(node?.name || ''),
    path: String(node?.path || ''),
    type: node?.type === 'folder' ? 'folder' : 'file',
    size: Number(node?.size || 0),
    children: Array.isArray(node?.children) ? node.children.map(toNode) : [],
  });
  return toNode(root);
}

/**
 * 将文件树扁平化为文件列表（仅 file 节点），用于 @ 候选等；限制数量避免大项目卡顿。
 */
export function flattenFileTreeToFiles(
  node: FileNode,
  maxFiles = 200
): Array<{ path: string; name: string }> {
  const out: Array<{ path: string; name: string }> = [];
  const walk = (n: FileNode): boolean => {
    if (out.length >= maxFiles) return true;
    if (n.type === 'file') {
      out.push({ path: n.path, name: n.name });
      return out.length >= maxFiles;
    }
    if (Array.isArray(n.children)) {
      for (const c of n.children) {
        if (walk(c)) return true;
      }
    }
    return false;
  };
  walk(node);
  return out;
}

/**
 * 列出目录内容
 * 通过后端 /files/tree 拉取并展开为平铺列表。
 */
export async function listFiles(
  workspaceId: string,
  path = '.',
  recursive = false
): Promise<FileEntry[]> {
  const targetPath = await resolveWorkspacePath(workspaceId, path);
  const maxDepth = recursive ? 8 : 2;
  const response = await fetch(
    `${getBaseUrl()}${API_PREFIX}/files/tree?path=${encodeURIComponent(targetPath)}&max_depth=${maxDepth}`
  );
  if (!response.ok) {
    throw new Error(await decodeApiError(response));
  }
  const data = await response.json().catch(() => {
    throw new Error('响应解析失败');
  });
  const out: FileEntry[] = [];
  const walk = (node: any, depth: number) => {
    if (!node || !Array.isArray(node.children)) return;
    for (const child of node.children) {
      out.push({
        name: String(child?.name || ''),
        path: String(child?.path || ''),
        is_dir: child?.type === 'folder',
        size: Number(child?.size || 0),
      });
      if (recursive && child?.type === 'folder') walk(child, depth + 1);
    }
  };
  walk(data, 0);
  return out;
}

/**
 * 读取文件内容
 * 通过后端 /files/read 读取。
 */
export async function readFile(workspaceId: string, path: string): Promise<string> {
  const targetPath = await resolveWorkspacePath(workspaceId, path);
  const response = await fetch(
    `${getBaseUrl()}${API_PREFIX}/files/read?path=${encodeURIComponent(targetPath)}`
  );
  if (!response.ok) {
    throw new Error(await decodeApiError(response));
  }
  const data = await response.json().catch(() => {
    throw new Error('响应解析失败');
  });
  return String(data?.content ?? '');
}

/**
 * 写入文件
 * 通过后端 /files/write 写入。
 */
export async function writeFile(
  workspaceId: string,
  path: string,
  content: string
): Promise<{ path: string; size: number }> {
  const targetPath = await resolveWorkspacePath(workspaceId, path);
  const response = await fetch(
    `${getBaseUrl()}${API_PREFIX}/files/write?path=${encodeURIComponent(targetPath)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }
  );
  if (!response.ok) {
    throw new Error(await decodeApiError(response));
  }
  const data = await response.json().catch(() => {
    throw new Error('响应解析失败');
  });
  return {
    path: String(data?.path || targetPath),
    size: Number(data?.size || content.length),
  };
}

/**
 * 删除文件或目录
 * 通过后端 /files/delete 删除。
 */
export async function deleteFile(
  workspaceId: string,
  path: string,
  _recursive = false
): Promise<void> {
  const targetPath = await resolveWorkspacePath(workspaceId, path);
  const response = await fetch(
    `${getBaseUrl()}${API_PREFIX}/files/delete?path=${encodeURIComponent(targetPath)}`,
    { method: 'DELETE', headers: getInternalAuthHeaders() }
  );
  if (!response.ok) {
    throw new Error(await decodeApiError(response));
  }
}

/**
 * 移动/重命名文件
 * 通过后端 /files/rename 完成。
 */
export async function moveFile(
  workspaceId: string,
  src: string,
  dest: string
): Promise<void> {
  const srcPath = await resolveWorkspacePath(workspaceId, src);
  const dstPath = await resolveWorkspacePath(workspaceId, dest);
  const response = await fetch(
    `${getBaseUrl()}${API_PREFIX}/files/rename?old_path=${encodeURIComponent(srcPath)}&new_path=${encodeURIComponent(dstPath)}`,
    { method: 'POST', headers: getInternalAuthHeaders() }
  );
  if (!response.ok) {
    throw new Error(await decodeApiError(response));
  }
}

/**
 * 创建目录
 * 通过后端 /files/mkdir 完成。
 */
export async function createDirectory(workspaceId: string, path: string): Promise<void> {
  const targetPath = await resolveWorkspacePath(workspaceId, path);
  const response = await fetch(
    `${getBaseUrl()}${API_PREFIX}/files/mkdir?path=${encodeURIComponent(targetPath)}`,
    { method: 'POST', headers: getInternalAuthHeaders() }
  );
  if (!response.ok) {
    throw new Error(await decodeApiError(response));
  }
}

// ============= 工作区服务类 =============

/**
 * 最近打开的工作区记录
 */
interface RecentWorkspace {
  id: string;
  name: string;
  path: string;
  lastOpened: string;
}

/**
 * 工作区服务 - 管理活动工作区状态
 * 
 * 按照 VSCode/Cursor 的业务逻辑实现：
 * 1. 支持多工作区管理
 * 2. 记录最近打开的工作区
 * 3. 自动恢复上次打开的工作区
 * 4. 工作区设置持久化
 */
export class WorkspaceService {
  private activeWorkspaceId: string | null = null;
  private fileTreeCache: FileNode | null = null;
  private listeners: Set<() => void> = new Set();
  private static readonly RECENT_LIMIT = 10;
  private static readonly STORAGE_KEYS = {
    activeWorkspace: 'activeWorkspaceId',
    recentWorkspaces: 'recentWorkspaces',
    workspaceSettings: 'workspaceSettings',
    expandedFolders: 'expandedFolders',
  };

  /**
   * 获取当前活动工作区 ID
   */
  getActiveWorkspaceId(): string | null {
    return this.activeWorkspaceId;
  }

  /**
   * 获取最近打开的工作区列表
   */
  getRecentWorkspaces(): RecentWorkspace[] {
    try {
      return JSON.parse(getStorageItem(WorkspaceService.STORAGE_KEYS.recentWorkspaces) || '[]');
    } catch {
      return [];
    }
  }

  /**
   * 添加到最近打开列表
   */
  private addToRecent(workspace: WorkspaceInfo): void {
    try {
      const recent = this.getRecentWorkspaces();
      // 移除已存在的记录
      const filtered = recent.filter(r => r.id !== workspace.id);
      // 添加到开头
      filtered.unshift({
        id: workspace.id,
        name: workspace.name,
        path: workspace.path,
        lastOpened: new Date().toISOString(),
      });
      // 限制数量
      const limited = filtered.slice(0, WorkspaceService.RECENT_LIMIT);
      setStorageItem(WorkspaceService.STORAGE_KEYS.recentWorkspaces, JSON.stringify(limited));
    } catch (e) {
      if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
        console.warn("[WorkspaceService] addToRecent failed", e);
      }
    }
  }

  /**
   * 从最近列表移除
   */
  removeFromRecent(workspaceId: string): void {
    try {
      const recent = this.getRecentWorkspaces();
      const filtered = recent.filter(r => r.id !== workspaceId);
      setStorageItem(WorkspaceService.STORAGE_KEYS.recentWorkspaces, JSON.stringify(filtered));
    } catch (e) {
      if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
        console.warn("[WorkspaceService] removeFromRecent failed", e);
      }
    }
  }

  /**
   * 清空最近列表
   */
  clearRecentWorkspaces(): void {
    try {
      removeStorageItem(WorkspaceService.STORAGE_KEYS.recentWorkspaces);
    } catch (e) {
      if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
        console.warn("[WorkspaceService] clearRecentWorkspaces failed", e);
      }
    }
  }

  /**
   * 设置活动工作区。linked 模式先调后端确认成功再写本地 storage，失败不写入防分叉。
   */
  async setActiveWorkspace(workspaceId: string): Promise<WorkspaceInfo> {
    const ws = await getWorkspace(workspaceId);
    if (ws.mode === 'linked') {
      await syncWorkspaceRoot(ws.path);
    }
    this.fileTreeCache = null;
    this.activeWorkspaceId = workspaceId;
    try {
      setStorageItem(WorkspaceService.STORAGE_KEYS.activeWorkspace, workspaceId);
    } catch (e) {
      if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
        console.warn("[WorkspaceService] setActiveWorkspace write failed", e);
      }
    }
    this.addToRecent(ws);
    this.notifyListeners();
    try {
      setStorageItem('maibot_workspace_path', ws.path ?? '');
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(EVENTS.WORKSPACE_CONTEXT_CHANGED, { detail: { workspacePath: ws.path ?? '' } }));
      }
    } catch (e) {
      if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
        console.warn("[WorkspaceService] setActiveWorkspace maibot_workspace_path write failed", e);
      }
    }
    return ws;
  }

  /**
   * 关闭当前工作区
   */
  closeWorkspace(): void {
    this.activeWorkspaceId = null;
    this.fileTreeCache = null;
    try {
      removeStorageItem(WorkspaceService.STORAGE_KEYS.activeWorkspace);
    } catch (e) {
      if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
        console.warn("[WorkspaceService] closeWorkspace clear failed", e);
      }
    }
    this.notifyListeners();
  }

  /**
   * 创建并激活新工作区
   */
  async createAndActivate(params: {
    name: string;
    mode?: 'virtual' | 'linked';
    linked_path?: string;
    domain?: string;
  }): Promise<WorkspaceInfo> {
    const ws = await createWorkspace(params);
    await this.setActiveWorkspace(ws.id);
    return ws;
  }

  /**
   * 获取文件树（带缓存）
   */
  async getFileTree(forceRefresh = false): Promise<FileNode | null> {
    if (!this.activeWorkspaceId) return null;
    
    if (this.fileTreeCache && !forceRefresh) {
      return this.fileTreeCache;
    }
    
    try {
      this.fileTreeCache = await getFileTree(this.activeWorkspaceId);
      return this.fileTreeCache;
    } catch (e) {
      if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
        console.warn("[WorkspaceService] getFileTree failed:", e);
      }
      return null;
    }
  }

  /**
   * 刷新文件树
   */
  async refreshFileTree(): Promise<FileNode | null> {
    this.fileTreeCache = null;
    return this.getFileTree(true);
  }

  /**
   * 读取文件
   */
  async readFile(path: string): Promise<string> {
    if (!this.activeWorkspaceId) throw new Error('No active workspace');
    return readFile(this.activeWorkspaceId, path);
  }

  /**
   * 写入文件
   */
  async writeFile(path: string, content: string): Promise<void> {
    if (!this.activeWorkspaceId) throw new Error('No active workspace');
    await writeFile(this.activeWorkspaceId, path, content);
    // 文件变更后刷新缓存
    this.fileTreeCache = null;
    this.notifyListeners();
  }

  /**
   * 删除文件
   */
  async deleteFile(path: string, recursive = false): Promise<void> {
    if (!this.activeWorkspaceId) throw new Error('No active workspace');
    await deleteFile(this.activeWorkspaceId, path, recursive);
    this.fileTreeCache = null;
    this.notifyListeners();
  }

  /**
   * 创建目录
   */
  async createDirectory(path: string): Promise<void> {
    if (!this.activeWorkspaceId) throw new Error('No active workspace');
    await createDirectory(this.activeWorkspaceId, path);
    this.fileTreeCache = null;
    this.notifyListeners();
  }

  /**
   * 监听变更
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    this.listeners.forEach(fn => {
      try {
        fn();
      } catch (e) {
        if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
          console.warn("[WorkspaceService] listener threw", e);
        }
      }
    });
  }

  /**
   * 从 localStorage 恢复状态
   */
  async restoreFromStorage(): Promise<WorkspaceInfo | null> {
    try {
      const savedId = getStorageItem(WorkspaceService.STORAGE_KEYS.activeWorkspace);
      if (savedId) {
        return await this.setActiveWorkspace(savedId);
      }
    } catch (e) {
      if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
        console.warn("[WorkspaceService] restoreFromStorage failed", e);
      }
    }
    return null;
  }

  // ============= 工作区设置管理 =============

  /**
   * 获取工作区设置
   */
  getWorkspaceSettings(workspaceId?: string): Record<string, unknown> {
    const id = workspaceId || this.activeWorkspaceId;
    if (!id) return {};
    try {
      const allSettings = JSON.parse(getStorageItem(WorkspaceService.STORAGE_KEYS.workspaceSettings) || '{}');
      return allSettings[id] || {};
    } catch {
      return {};
    }
  }

  /**
   * 保存工作区设置
   */
  saveWorkspaceSettings(settings: Record<string, unknown>, workspaceId?: string): void {
    const id = workspaceId || this.activeWorkspaceId;
    if (!id) return;
    try {
      const allSettings = JSON.parse(getStorageItem(WorkspaceService.STORAGE_KEYS.workspaceSettings) || '{}');
      allSettings[id] = { ...allSettings[id], ...settings };
      setStorageItem(WorkspaceService.STORAGE_KEYS.workspaceSettings, JSON.stringify(allSettings));
    } catch (e) {
      if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
        console.warn("[WorkspaceService] saveWorkspaceSettings failed", e);
      }
    }
  }

  /**
   * 获取展开的文件夹列表
   */
  getExpandedFolders(workspaceId?: string): string[] {
    const id = workspaceId || this.activeWorkspaceId;
    if (!id) return [];
    try {
      const allExpanded = JSON.parse(getStorageItem(WorkspaceService.STORAGE_KEYS.expandedFolders) || '{}');
      return allExpanded[id] || [];
    } catch {
      return [];
    }
  }

  /**
   * 保存展开的文件夹列表
   */
  saveExpandedFolders(folders: string[], workspaceId?: string): void {
    const id = workspaceId || this.activeWorkspaceId;
    if (!id) return;
    try {
      const allExpanded = JSON.parse(getStorageItem(WorkspaceService.STORAGE_KEYS.expandedFolders) || '{}');
      allExpanded[id] = folders;
      setStorageItem(WorkspaceService.STORAGE_KEYS.expandedFolders, JSON.stringify(allExpanded));
    } catch (e) {
      if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
        console.warn("[WorkspaceService] saveExpandedFolders failed", e);
      }
    }
  }

  // ============= 工作区清理 =============

  /**
   * 清理无效的工作区数据
   * 删除不存在的工作区的相关数据
   */
  async cleanupInvalidData(): Promise<number> {
    let cleaned = 0;
    try {
      const workspaces = await listWorkspaces();
      const validIds = new Set(workspaces.map(w => w.id));

      // 清理最近列表中的无效项
      const recent = this.getRecentWorkspaces();
      const validRecent = recent.filter(r => validIds.has(r.id));
      if (validRecent.length !== recent.length) {
        cleaned += recent.length - validRecent.length;
        setStorageItem(WorkspaceService.STORAGE_KEYS.recentWorkspaces, JSON.stringify(validRecent));
      }

      // 清理设置中的无效项
      const allSettings = JSON.parse(getStorageItem(WorkspaceService.STORAGE_KEYS.workspaceSettings) || '{}');
      for (const id of Object.keys(allSettings)) {
        if (!validIds.has(id)) {
          delete allSettings[id];
          cleaned++;
        }
      }
      setStorageItem(WorkspaceService.STORAGE_KEYS.workspaceSettings, JSON.stringify(allSettings));

      // 清理展开文件夹中的无效项
      const allExpanded = JSON.parse(getStorageItem(WorkspaceService.STORAGE_KEYS.expandedFolders) || '{}');
      for (const id of Object.keys(allExpanded)) {
        if (!validIds.has(id)) {
          delete allExpanded[id];
          cleaned++;
        }
      }
      setStorageItem(WorkspaceService.STORAGE_KEYS.expandedFolders, JSON.stringify(allExpanded));

      // 如果当前活动工作区无效，清除它
      if (this.activeWorkspaceId && !validIds.has(this.activeWorkspaceId)) {
        this.closeWorkspace();
        cleaned++;
      }
    } catch (e) {
      if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
        console.warn("[WorkspaceService] cleanupInvalidData failed", e);
      }
    }
    return cleaned;
  }
}

// 全局单例
export const workspaceService = new WorkspaceService();

// ============= 导出 =============

export const workspaceAPI = {
  // 工作区管理
  listWorkspaces,
  createWorkspace,
  getWorkspace,
  deleteWorkspace,
  // 文件操作
  getFileTree,
  getFileTreeByPath,
  flattenFileTreeToFiles,
  listFiles,
  readFile,
  writeFile,
  deleteFile,
  moveFile,
  createDirectory,
};

export default workspaceAPI;
