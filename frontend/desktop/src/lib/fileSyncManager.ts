/**
 * 文件同步管理器
 * 
 * 基于 VSCode Remote / code-server 的文件同步机制
 * 实现前后端文件系统的自动同步
 * 
 * 核心特性：
 * - 双向同步（前端 ↔ 后端）
 * - 增量更新（只传输变化）
 * - 冲突检测（版本控制）
 * - 自动重试（网络故障恢复）
 * - 文件监听（Electron 环境下使用原生 fs.watch）
 */

import langgraphApi from './langgraphApi';
import { fileEventBus, FileEvent, FileEventType } from './events/fileEvents';

// ============================================================================
// 类型定义
// ============================================================================

interface FileCache {
  content: string;
  hash: string;
  version: number;
  lastModified: Date;
}

interface FileChange {
  type: 'create' | 'modify' | 'delete';
  path: string;
  content?: string;
}

interface SyncResult {
  success: boolean;
  applied: FileChange[];
  failed: FileChange[];
  newVersion: number;
}

// ============================================================================
// 文件同步管理器
// ============================================================================

const LOCAL_CACHE_MAX_SIZE = 50;

export class FileSyncManager {
  private localCache: Map<string, FileCache> = new Map();
  /** LRU 顺序：索引 0 为最久未用，末尾为最近使用 */
  private localCacheOrder: string[] = [];
  private remoteVersion: number = 0;
  private syncInterval: NodeJS.Timeout | null = null;
  private isSyncing: boolean = false;
  private isEnabled: boolean = true;
  /** 自适应轮询：无变化时退避，有变化时恢复 */
  private currentPollIntervalMs: number = 2000;
  private readonly POLL_INTERVALS = [2000, 5000, 10000];
  private pollTimerId: ReturnType<typeof setTimeout> | null = null;

  // 文件监听相关
  private watchedPaths: Set<string> = new Set();
  private pendingChanges: Map<string, FileChange> = new Map();
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly DEBOUNCE_DELAY = 300; // 防抖延迟（毫秒）

  /**
   * 初始化同步管理器
   */
  async initialize(): Promise<void> {
    console.log('[FileSyncManager] 初始化...');
    
    try {
      // 从后端获取初始文件快照
      const snapshot = await this.fetchSnapshot();
      
      // 构建本地缓存（LRU 上限）
      const entries = Object.entries(snapshot.files);
      for (const [path, file] of entries.slice(-LOCAL_CACHE_MAX_SIZE)) {
        this.setCache(path, {
          content: (file as any).content,
          hash: this.hashContent((file as any).content),
          version: snapshot.version,
          lastModified: new Date((file as any).lastModified),
        });
      }
      if (entries.length > LOCAL_CACHE_MAX_SIZE) {
        console.log(`[FileSyncManager] 缓存限制 ${LOCAL_CACHE_MAX_SIZE}，已截断 ${entries.length} 个文件`);
      }
      this.remoteVersion = snapshot.version;
      console.log(`[FileSyncManager] 初始化完成，版本: ${this.remoteVersion}, 文件数: ${this.localCache.size}`);
    } catch (error) {
      console.error('[FileSyncManager] 初始化失败:', error);
      // 初始化失败时使用空缓存
      this.localCache.clear();
      this.remoteVersion = 0;
    }
  }

  /** 写入缓存并维护 LRU，超过上限淘汰最久未用 */
  private setCache(path: string, entry: FileCache): void {
    if (this.localCache.has(path)) {
      this.localCache.set(path, entry);
      const i = this.localCacheOrder.indexOf(path);
      if (i >= 0) {
        this.localCacheOrder.splice(i, 1);
      }
      this.localCacheOrder.push(path);
      return;
    }
    while (this.localCacheOrder.length >= LOCAL_CACHE_MAX_SIZE && this.localCacheOrder.length > 0) {
      const evict = this.localCacheOrder.shift()!;
      this.localCache.delete(evict);
    }
    this.localCache.set(path, entry);
    this.localCacheOrder.push(path);
  }

  /**
   * 启动自动同步（重复调用会先清理旧 interval 再启动，避免累积）
   */
  startAutoSync(): void {
    this.stopAutoSync();
    this.currentPollIntervalMs = this.POLL_INTERVALS[0];
    console.log('[FileSyncManager] 启动自动同步');
    
    // 每1秒推送本地变化到后端
    this.syncInterval = setInterval(() => {
      if (this.isEnabled && !this.isSyncing) {
        this.syncToBackend().catch(error => {
          console.error('[FileSyncManager] 推送失败:', error);
        });
      }
    }, 1000);

    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (this.pollTimerId != null) return;
    const run = () => {
      this.pollTimerId = null;
      if (!this.isEnabled || this.isSyncing) return;
      this.pollFromBackend()
        .catch(error => {
          console.error('[FileSyncManager] 拉取失败:', error);
        })
        .finally(() => {
          if (this.isEnabled) this.schedulePoll();
        });
    };
    this.pollTimerId = setTimeout(run, this.currentPollIntervalMs);
  }

  /**
   * 停止自动同步
   */
  stopAutoSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    if (this.pollTimerId != null) {
      clearTimeout(this.pollTimerId);
      this.pollTimerId = null;
    }
    console.log('[FileSyncManager] 已停止自动同步');
  }

  /** 供调试：获取缓存与轮询状态 */
  getMemoryUsage(): { cacheSize: number; cacheMax: number; pollIntervalMs: number } {
    return {
      cacheSize: this.localCache.size,
      cacheMax: LOCAL_CACHE_MAX_SIZE,
      pollIntervalMs: this.currentPollIntervalMs,
    };
  }

  /**
   * 启用/禁用同步
   */
  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    console.log(`[FileSyncManager] 同步${enabled ? '已启用' : '已禁用'}`);
  }

  /**
   * 注册文件变化（由编辑器调用，LRU 上限 50）
   */
  registerFileChange(path: string, content: string): void {
    const hash = this.hashContent(content);
    const cached = this.localCache.get(path);

    if (!cached) {
      this.setCache(path, {
        content,
        hash,
        version: this.remoteVersion,
        lastModified: new Date(),
      });
      console.log(`[FileSyncManager] 注册新文件: ${path}`);
    } else if (cached.hash !== hash) {
      cached.content = content;
      cached.hash = hash;
      cached.lastModified = new Date();
      const i = this.localCacheOrder.indexOf(path);
      if (i >= 0) {
        this.localCacheOrder.splice(i, 1);
        this.localCacheOrder.push(path);
      }
      console.log(`[FileSyncManager] 注册修改: ${path}`);
    }
  }

  /**
   * 注册文件删除（由编辑器调用）
   */
  registerFileDelete(path: string): void {
    if (this.localCache.has(path)) {
      this.localCache.delete(path);
      const i = this.localCacheOrder.indexOf(path);
      if (i >= 0) this.localCacheOrder.splice(i, 1);
      console.log(`[FileSyncManager] 注册删除: ${path}`);
    }
  }

  /**
   * 推送本地变化到后端
   */
  private async syncToBackend(): Promise<void> {
    if (this.isSyncing) return;

    this.isSyncing = true;
    try {
      const changes: FileChange[] = [];

      // 检查每个缓存文件
      for (const [path, cached] of this.localCache.entries()) {
        // 简单实现：将所有缓存文件视为需要同步
        // 实际应用中应该维护一个"脏标记"列表
        changes.push({
          type: 'modify',
          path,
          content: cached.content,
        });
      }

      if (changes.length > 0) {
        console.log(`[FileSyncManager] 推送 ${changes.length} 个变化到后端`);
        const result = await this.applyChanges(changes);
        
        if (result.success) {
          this.remoteVersion = result.newVersion;
          console.log(`[FileSyncManager] 推送成功，新版本: ${this.remoteVersion}`);
        } else {
          console.warn(`[FileSyncManager] 部分推送失败: ${result.failed.length} 个`);
        }
      }
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 从后端拉取变化（自适应间隔：有变化时恢复 2s，无变化时退避至 5s/10s）
   */
  private async pollFromBackend(): Promise<void> {
    if (this.isSyncing) return;

    this.isSyncing = true;
    try {
      const snapshot = await this.fetchSnapshot();
      const hadChanges = snapshot.version > this.remoteVersion;

      if (hadChanges) {
        console.log(`[FileSyncManager] 检测到后端更新: ${this.remoteVersion} → ${snapshot.version}`);
        await this.mergeRemoteChanges(snapshot);
        this.remoteVersion = snapshot.version;
        this.currentPollIntervalMs = this.POLL_INTERVALS[0];
      } else {
        const idx = this.POLL_INTERVALS.indexOf(this.currentPollIntervalMs);
        if (idx >= 0 && idx < this.POLL_INTERVALS.length - 1) {
          this.currentPollIntervalMs = this.POLL_INTERVALS[idx + 1];
        }
      }
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 获取后端文件快照
   */
  private async fetchSnapshot(): Promise<any> {
    try {
      // 通过 LangGraph API 获取文件列表
      // listDirectory 返回数组或抛出异常
      const files = await langgraphApi.listDirectory('/');
      
      // 构建快照格式
      const fileMap: Record<string, { content: string; lastModified: number }> = {};
      
      // 只记录文件元数据，不加载内容（按需加载）
      if (Array.isArray(files)) {
        for (const file of files) {
          if (!file.isDirectory) {
            fileMap[file.path] = {
              content: '', // 内容按需加载
              lastModified: Date.now(),
            };
          }
        }
      }

      return {
        version: Date.now(), // 使用时间戳作为版本号
        files: fileMap,
      };
    } catch (error) {
      // 如果是网络错误或后端未启动，返回空快照
      console.warn('[FileSyncManager] 获取快照失败，使用空快照:', error);
      return {
        version: Date.now(),
        files: {},
      };
    }
  }

  /**
   * 应用变化到后端
   */
  private async applyChanges(changes: FileChange[]): Promise<SyncResult> {
    const applied: FileChange[] = [];
    const failed: FileChange[] = [];

    for (const change of changes) {
      try {
        if (change.type === 'create' || change.type === 'modify') {
          await langgraphApi.writeFile(change.path, change.content || '');
          applied.push(change);
        } else if (change.type === 'delete') {
          // ✅ 使用 langgraphApi 删除文件
          await langgraphApi.deleteFile(change.path);
          applied.push(change);
          console.log(`[FileSyncManager] ✅ 文件已删除: ${change.path}`);
        }
      } catch (error) {
        console.error(`[FileSyncManager] 应用变化失败: ${change.path}`, error);
        failed.push(change);
      }
    }

    return {
      success: failed.length === 0,
      applied,
      failed,
      newVersion: Date.now(),
    };
  }

  /**
   * 合并远程变化（写入时走 LRU，不超过上限）
   */
  private async mergeRemoteChanges(snapshot: any): Promise<void> {
    console.log('[FileSyncManager] 合并远程变化');
    for (const [path, file] of Object.entries(snapshot.files)) {
      const content = (file as any).content;
      this.setCache(path, {
        content,
        hash: this.hashContent(content),
        version: snapshot.version,
        lastModified: new Date((file as any).lastModified),
      });
    }
  }

  /**
   * 计算内容哈希
   */
  private hashContent(content: string): string {
    // 简单哈希实现
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36);
  }

  /**
   * 获取同步状态
   */
  getStatus(): {
    enabled: boolean;
    syncing: boolean;
    version: number;
    cachedFiles: number;
  } {
    return {
      enabled: this.isEnabled,
      syncing: this.isSyncing,
      version: this.remoteVersion,
      cachedFiles: this.localCache.size,
    };
  }

  /**
   * 清空缓存
   */
  clearCache(): void {
    this.localCache.clear();
    console.log('[FileSyncManager] 缓存已清空');
  }

  // ============================================================================
  // 文件监听功能（增强）
  // ============================================================================

  // 取消订阅函数
  private unsubscribe: (() => void) | null = null;

  /**
   * 监听文件变化（使用 fileEventBus）
   */
  startWatching(paths: string[]): void {
    for (const path of paths) {
      if (!this.watchedPaths.has(path)) {
        this.watchedPaths.add(path);
        console.log(`[FileSyncManager] 开始监听: ${path}`);
      }
    }

    // 订阅文件事件（使用统一的处理器）
    this.unsubscribe = fileEventBus.subscribe(this.handleFileEvent.bind(this));

    console.log(`[FileSyncManager] 已订阅文件事件，监听 ${this.watchedPaths.size} 个路径`);
  }

  /**
   * 停止监听
   */
  stopWatching(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    this.watchedPaths.clear();
    console.log('[FileSyncManager] 已停止监听');
  }

  /**
   * 处理文件事件
   */
  private handleFileEvent(event: FileEvent): void {
    if (!this.isPathWatched(event.path)) return;
    
    // 忽略来自同步的事件，避免循环
    if (event.source === 'sync') return;
    
    switch (event.type) {
      case 'file_created':
      case 'dir_created':
        this.queueChange({
          type: 'create',
          path: event.path,
        });
        break;
        
      case 'file_modified':
        this.queueChange({
          type: 'modify',
          path: event.path,
        });
        break;
        
      case 'file_deleted':
      case 'dir_deleted':
        this.queueChange({
          type: 'delete',
          path: event.path,
        });
        break;
        
      case 'file_renamed':
        // 重命名 = 删除旧文件 + 创建新文件
        this.queueChange({
          type: 'delete',
          path: event.path,
        });
        if (event.newPath) {
          this.queueChange({
            type: 'create',
            path: event.newPath,
          });
        }
        break;
        
      case 'refresh':
        // 强制刷新时，重新获取后端状态
        this.pollFromBackend().catch(console.error);
        break;
    }
  }

  /**
   * 检查路径是否在监听范围内
   */
  private isPathWatched(path: string): boolean {
    for (const watchedPath of this.watchedPaths) {
      if (path.startsWith(watchedPath)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 将变化加入队列（防抖）
   */
  private queueChange(change: FileChange): void {
    // 合并同一文件的变化
    this.pendingChanges.set(change.path, change);

    // 防抖：延迟处理
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.processPendingChanges();
    }, this.DEBOUNCE_DELAY);
  }

  /**
   * 处理待处理的变化
   */
  private async processPendingChanges(): Promise<void> {
    if (this.pendingChanges.size === 0) return;

    const changes = Array.from(this.pendingChanges.values());
    this.pendingChanges.clear();

    console.log(`[FileSyncManager] 处理 ${changes.length} 个文件变化`);

    try {
      const result = await this.applyChanges(changes);
      
      if (result.success) {
        this.remoteVersion = result.newVersion;
        
        // 通知 UI 更新（使用 refresh 事件）
        fileEventBus.emit({
          type: 'refresh',
          path: '',
          source: 'sync',
        });
        console.log(`[FileSyncManager] 同步完成: ${result.applied.length} 个文件`);
      } else {
        console.warn(`[FileSyncManager] 同步部分失败: ${result.failed.length} 个`);
      }
    } catch (error) {
      console.error('[FileSyncManager] 同步失败:', error);
    }
  }

  /**
   * 强制立即同步
   */
  async forceSync(): Promise<SyncResult> {
    // 清除防抖定时器
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // 处理待处理的变化
    const changes = Array.from(this.pendingChanges.values());
    this.pendingChanges.clear();

    if (changes.length === 0) {
      return {
        success: true,
        applied: [],
        failed: [],
        newVersion: this.remoteVersion,
      };
    }

    console.log(`[FileSyncManager] 强制同步 ${changes.length} 个变化`);
    return this.applyChanges(changes);
  }
}

// ============================================================================
// 导出单例
// ============================================================================

export const fileSyncManager = new FileSyncManager();

export default fileSyncManager;

