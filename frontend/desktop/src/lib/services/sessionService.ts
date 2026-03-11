/**
 * 会话服务 - 统一管理用户会话状态
 * 
 * 功能：
 * - 会话状态持久化和恢复
 * - 自动创建首个会话
 * - 用户状态管理
 * - 工作区状态恢复
 */

import {
  createThread,
  listThreads,
  getThreadState,
  touchThread,
  cleanupExpiredThreads,
  validServerThreadIdOrUndefined,
} from '../api/langserveChat';
import { workspaceService } from '../api/workspace';
import { getItem as getStorageItem } from '../safeStorage';
import { getCurrentWorkspacePathFromStorage } from '../sessionState';

// 会话状态接口
interface SessionState {
  // 当前活跃线程
  activeThreadId: string | null;
  // 最近使用的线程列表
  recentThreads: string[];
  // 当前工作区
  activeWorkspaceId: string | null;
  // 当前打开的文件
  openFiles: Array<{
    path: string;
    name: string;
    isActive: boolean;
  }>;
  // 左侧面板状态
  leftPanelTab: 'workspace' | 'knowledge';
  leftPanelWidth: number;
  // 右侧面板状态
  rightPanelVisible: boolean;
  rightPanelWidth: number;
  // 用户 ID
  userId: string;
  // 最后活跃时间
  lastActiveAt: number;
}

// 默认会话状态
const DEFAULT_SESSION_STATE: SessionState = {
  activeThreadId: null,
  recentThreads: [],
  activeWorkspaceId: null,
  openFiles: [],
  leftPanelTab: 'workspace',
  leftPanelWidth: 280,
  rightPanelVisible: true,
  rightPanelWidth: 400,
  userId: 'default-user',
  lastActiveAt: Date.now(),
};

// 存储键
const SESSION_STORAGE_KEY = 'maibot_session_state';
const WELCOME_SHOWN_KEY = 'maibot_welcome_shown';
const THREAD_VALIDATE_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        reject(new Error(errorMessage));
      }, timeoutMs);
    }),
  ]);
}

class SessionService {
  private state: SessionState = { ...DEFAULT_SESSION_STATE };
  private listeners: Set<(state: SessionState) => void> = new Set();
  private initialized = false;
  private initializingPromise: Promise<void> | null = null;

  /**
   * 初始化会话服务
   * 使用 Promise 锁防止重复初始化
   */
  async initialize(): Promise<void> {
    // 如果已经初始化完成，直接返回
    if (this.initialized) return;
    
    // 如果正在初始化，等待完成
    if (this.initializingPromise) {
      return this.initializingPromise;
    }

    // 开始初始化
    this.initializingPromise = this.doInitialize();
    
    try {
      await this.initializingPromise;
    } finally {
      this.initializingPromise = null;
    }
  }

  /**
   * 实际的初始化逻辑
   */
  private async doInitialize(): Promise<void> {
    try {
      // 1. 从 localStorage 恢复状态（同步操作，不会失败）
      this.loadState();

      // 2. 恢复工作区状态（本地操作，不依赖后端）
      await this.restoreWorkspaceState();

      // 3. 验证并恢复线程（可能失败，但不影响初始化）
      // 使用 try-catch 包裹，避免后端不可用时阻塞
      try {
        await this.validateAndRestoreThreads();
      } catch (error) {
        if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) console.warn('[SessionService] 验证线程失败（后端可能不可用）:', error);
        // 清除可能无效的线程 ID
        this.state.activeThreadId = null;
      }

      // 4. 不再自动创建线程，由 MyRuntimeProvider 在发送消息时创建
      // 这样避免重复创建线程

      // 5. 清理过期线程（后台执行，延迟执行避免阻塞，静默失败）
      setTimeout(() => {
        this.cleanupExpiredThreadsInBackground().catch((err) => {
          if (typeof import.meta !== "undefined" && import.meta.env?.DEV) console.warn("[SessionService] cleanupExpiredThreadsInBackground failed:", err);
        });
      }, 10000); // 延迟 10 秒执行

      this.initialized = true;
      if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) console.log('[SessionService] ✅ 初始化完成');
    } catch (error) {
      console.error('[SessionService] ❌ 初始化失败:', error);
      // 即使失败也标记为已初始化，避免无限重试
      this.initialized = true;
    }
    
    this.notifyListeners();
  }

  /**
   * 从 localStorage 加载状态
   */
  private loadState(): void {
    try {
      const saved = localStorage.getItem(SESSION_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        this.state = { ...DEFAULT_SESSION_STATE, ...parsed };
      }
    } catch (error) {
      if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) console.warn('[SessionService] 加载状态失败:', error);
    }
  }

  /**
   * 保存状态到 localStorage
   */
  private saveState(): void {
    try {
      this.state.lastActiveAt = Date.now();
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(this.state));
    } catch (error) {
      if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) console.warn('[SessionService] 保存状态失败:', error);
    }
  }

  /**
   * 验证并恢复线程
   * 
   * 注意：后端重启后，之前的线程会失效（404）
   * 这是正常行为，不是错误，静默处理即可
   */
  private async validateAndRestoreThreads(): Promise<void> {
    if (!this.state.activeThreadId) return;
    // 非服务端 UUID（如 thread-1、thread-{timestamp}）后端不认，直接清除，避免沿用无效 ID
    if (!validServerThreadIdOrUndefined(this.state.activeThreadId)) {
      if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
        console.debug("[SessionService] 当前活跃线程 ID 非服务端 UUID，清除以便下次发送时新建");
      }
      this.state.activeThreadId = null;
      this.saveState();
      return;
    }

    try {
      // 验证活跃线程是否存在
      const threadState = await withTimeout(
        getThreadState(this.state.activeThreadId),
        THREAD_VALIDATE_TIMEOUT_MS,
        `验证线程超时（>${THREAD_VALIDATE_TIMEOUT_MS}ms）`
      );
      if (!threadState) {
        // 线程不存在，静默清除（后端重启后的正常情况）
        console.debug('[SessionService] 线程已过期，将在下次发送时创建新线程');
        this.state.activeThreadId = null;
        this.saveState();
      } else {
        // 更新线程活跃时间
        await withTimeout(
          touchThread(this.state.activeThreadId),
          THREAD_VALIDATE_TIMEOUT_MS,
          `更新线程活跃时间超时（>${THREAD_VALIDATE_TIMEOUT_MS}ms）`
        );
      }
    } catch (error: any) {
      // 404 是正常情况（后端重启后线程不存在）
      // 只在非 404 错误时打印警告
      const msg = String(error?.message || '');
      if (msg.includes('404') || error?.status === 404) {
        console.debug('[SessionService] 线程已过期（后端重启），将在下次发送时创建新线程');
      } else if (msg.includes('超时') || msg.includes('timeout')) {
        if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) console.warn('[SessionService] 线程验证超时，跳过本次恢复（不阻塞启动）');
      } else {
        if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) console.warn('[SessionService] 验证线程失败:', error);
      }
      this.state.activeThreadId = null;
      this.saveState();
    }
  }

  /**
   * 恢复工作区状态
   */
  private async restoreWorkspaceState(): Promise<void> {
    if (!this.state.activeWorkspaceId) return;

    try {
      // 验证工作区是否存在
      const currentWorkspaceId = workspaceService.getActiveWorkspaceId();
      if (currentWorkspaceId !== this.state.activeWorkspaceId) {
        await workspaceService.setActiveWorkspace(this.state.activeWorkspaceId);
      }
    } catch (error) {
      if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) console.warn('[SessionService] 恢复工作区失败:', error);
    }
  }

  /**
   * 创建初始线程
   */
  private async createInitialThread(): Promise<void> {
    try {
      const workspacePath = getCurrentWorkspacePathFromStorage();
      const { thread_id } = await createThread({
        user_id: this.state.userId,
        created_at: new Date().toISOString(),
        title: '新对话',
        ...(workspacePath ? { workspace_path: workspacePath } : {}),
      });

      this.state.activeThreadId = thread_id;
      this.state.recentThreads = [thread_id, ...this.state.recentThreads.slice(0, 9)];
      this.saveState();

      if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) console.log('[SessionService] ✅ 创建初始线程:', thread_id);
    } catch (error) {
      console.error('[SessionService] ❌ 创建初始线程失败:', error);
    }
  }

  /**
   * 后台清理过期线程
   */
  private async cleanupExpiredThreadsInBackground(): Promise<void> {
    try {
      const count = await cleanupExpiredThreads(7);
      if (count > 0 && typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
        console.log(`[SessionService] 清理了 ${count} 个过期线程`);
      }
    } catch (error) {
      // 静默失败
    }
  }

  /**
   * 获取当前状态
   */
  getState(): SessionState {
    return { ...this.state };
  }

  /**
   * 设置活跃线程（仅持久化服务端 UUID，避免占位 ID 污染）
   */
  setActiveThread(threadId: string): void {
    const tid = validServerThreadIdOrUndefined(threadId);
    if (!tid) return;
    this.state.activeThreadId = tid;
    this.state.recentThreads = [
      tid,
      ...this.state.recentThreads.filter((id) => validServerThreadIdOrUndefined(id) && id !== tid).slice(0, 9),
    ];
    this.saveState();
    this.notifyListeners();
  }

  /**
   * 设置活跃工作区
   */
  setActiveWorkspace(workspaceId: string | null): void {
    this.state.activeWorkspaceId = workspaceId;
    this.saveState();
    this.notifyListeners();
  }

  /**
   * 设置打开的文件
   */
  setOpenFiles(files: SessionState['openFiles']): void {
    this.state.openFiles = files;
    this.saveState();
    this.notifyListeners();
  }

  /**
   * 设置左侧面板状态
   */
  setLeftPanelState(tab: 'workspace' | 'knowledge', width?: number): void {
    this.state.leftPanelTab = tab;
    if (width !== undefined) {
      this.state.leftPanelWidth = width;
    }
    this.saveState();
    this.notifyListeners();
  }

  /**
   * 设置右侧面板状态
   */
  setRightPanelState(visible: boolean, width?: number): void {
    this.state.rightPanelVisible = visible;
    if (width !== undefined) {
      this.state.rightPanelWidth = width;
    }
    this.saveState();
    this.notifyListeners();
  }

  /**
   * 设置用户 ID
   */
  setUserId(userId: string): void {
    this.state.userId = userId;
    this.saveState();
    this.notifyListeners();
  }

  /**
   * 检查是否已显示欢迎消息
   */
  hasShownWelcome(): boolean {
    return localStorage.getItem(WELCOME_SHOWN_KEY) === 'true';
  }

  /**
   * 标记已显示欢迎消息
   */
  markWelcomeShown(): void {
    localStorage.setItem(WELCOME_SHOWN_KEY, 'true');
  }

  /**
   * 获取欢迎消息
   */
  getWelcomeMessage(): string {
    const hour = new Date().getHours();
    let greeting = '你好';
    
    if (hour >= 5 && hour < 12) {
      greeting = '早上好';
    } else if (hour >= 12 && hour < 18) {
      greeting = '下午好';
    } else {
      greeting = '晚上好';
    }

    return `${greeting}！我是你的 AI 助手，可以帮助你完成各种任务：

- 📝 **文档处理**：分析、总结、生成各类文档
- 💻 **代码开发**：编写、审查、优化代码
- 🔍 **信息检索**：搜索知识库和网络资源
- 📊 **数据分析**：处理和可视化数据

有什么我可以帮助你的吗？`;
  }

  /**
   * 订阅状态变化
   */
  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 通知所有监听器
   */
  private notifyListeners(): void {
    const state = this.getState();
    this.listeners.forEach(listener => listener(state));
  }

  /**
   * 重置会话
   */
  reset(): void {
    this.state = { ...DEFAULT_SESSION_STATE };
    localStorage.removeItem(SESSION_STORAGE_KEY);
    localStorage.removeItem(WELCOME_SHOWN_KEY);
    this.notifyListeners();
  }
}

// 导出单例
export const sessionService = new SessionService();

// 导出类型
export type { SessionState };
