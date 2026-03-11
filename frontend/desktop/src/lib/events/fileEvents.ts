/**
 * 文件事件总线
 * 
 * 统一的文件变更事件系统，用于：
 * 1. AI 工具执行后通知前端刷新文件树
 * 2. 本地文件变更同步到 UI
 * 3. 知识库文件变更通知
 * 
 * 架构说明：
 * - 前端文件树 (WorkspaceFileTree) 订阅事件，收到事件后刷新显示
 * - MyRuntimeProvider 在检测到 AI 工具调用文件操作时发送事件
 * - Electron 本地文件操作也会发送事件
 */

// 文件事件类型
export type FileEventType = 
  | 'file_created'    // 文件创建
  | 'file_modified'   // 文件修改
  | 'file_deleted'    // 文件删除
  | 'dir_created'     // 目录创建
  | 'dir_deleted'     // 目录删除
  | 'file_renamed'    // 文件重命名
  | 'file_open'       // 打开文件（用于工具卡片点击）
  | 'refresh';        // 强制刷新（用于批量操作后）

// 文件事件数据
export interface FileEvent {
  type: FileEventType;
  path: string;
  newPath?: string;   // 重命名时的新路径
  size?: number;
  timestamp?: number;
  source?: 'ai' | 'local' | 'sync';  // 事件来源
  /** 打开文件时跳转到该行（1-based） */
  line?: number;
  /** 打开文件时直接提供内容（用于临时代码块等） */
  content?: string;
}

export type FileEventHandler = (event: FileEvent) => void;

/**
 * 文件事件总线 - 单例模式
 */
class FileEventBus {
  private listeners: Set<FileEventHandler> = new Set();
  private pendingEvents: FileEvent[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 100;  // 防抖时间
  
  /**
   * 订阅文件事件
   */
  subscribe(handler: FileEventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
  
  /**
   * 发送文件事件（带防抖）
   * 多个快速连续的事件会合并为一次刷新
   */
  emit(event: FileEvent): void {
    event.timestamp = event.timestamp || Date.now();
    if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
      console.log('[FileEventBus] 📁 事件:', event.type, event.path, event.source || '');
    }
    // 添加到待处理队列
    this.pendingEvents.push(event);
    
    // 防抖处理
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.flush();
    }, this.DEBOUNCE_MS);
  }
  
  /**
   * 立即发送所有待处理事件
   */
  flush(): void {
    if (this.pendingEvents.length === 0) return;
    
    // 如果有多个事件，合并为一个 refresh 事件
    const events = this.pendingEvents;
    this.pendingEvents = [];
    
    // 通知所有监听器
    this.listeners.forEach(handler => {
      try {
        if (events.length === 1) {
          handler(events[0]);
        } else {
          // 多个事件合并为 refresh
          handler({
            type: 'refresh',
            path: '',
            timestamp: Date.now(),
            source: 'sync',
          });
        }
      } catch (e) {
        console.error('[FileEventBus] Handler error:', e);
      }
    });
  }
  
  /**
   * 从 AI 工具调用中检测文件操作
   * 用于 MyRuntimeProvider 中处理流式响应
   */
  detectFromToolCall(toolName: string, args: Record<string, any>): void {
    const filePath = args.file_path || args.path || args.target_path || '';
    
    switch (toolName) {
      case 'write_file':
      case 'edit_file':
      case 'create_file':
        this.emit({ type: 'file_modified', path: filePath, source: 'ai' });
        break;
      case 'delete_file':
      case 'remove_file':
        this.emit({ type: 'file_deleted', path: filePath, source: 'ai' });
        break;
      case 'create_directory':
      case 'mkdir':
        this.emit({ type: 'dir_created', path: filePath, source: 'ai' });
        break;
      case 'rename_file':
      case 'move_file':
        this.emit({ 
          type: 'file_renamed', 
          path: args.old_path || args.source || filePath,
          newPath: args.new_path || args.destination || args.target,
          source: 'ai' 
        });
        break;
    }
  }
  
  /**
   * 从流式事件中处理文件变更（兼容旧格式）
   */
  handleStreamEvent(event: any): void {
    const fileEventTypes: FileEventType[] = [
      'file_created',
      'file_modified', 
      'file_deleted',
      'dir_created',
      'dir_deleted',
      'file_renamed',
      'refresh',
    ];
    
    if (fileEventTypes.includes(event?.type)) {
      this.emit({
        type: event.type,
        path: event.path || '',
        newPath: event.newPath,
        size: event.size,
        source: 'sync',
      });
    }
  }
  
  /**
   * 触发强制刷新
   */
  refresh(): void {
    this.emit({ type: 'refresh', path: '', source: 'sync' });
  }
  
  /**
   * 请求打开文件（用于工具卡片点击）；可选 line 则打开后跳转到该行
   * 可选 content 直接提供文件内容（用于临时代码块等，不从后端读取）
   */
  openFile(path: string, lineOrContent?: number | string): void {
    if (typeof lineOrContent === 'number') {
      this.emit({ type: 'file_open', path, line: lineOrContent, source: 'ai' });
    } else if (typeof lineOrContent === 'string') {
      this.emit({ type: 'file_open', path, content: lineOrContent, source: 'ai' });
    } else {
      this.emit({ type: 'file_open', path, source: 'ai' });
    }
  }
}

// 全局单例
export const fileEventBus = new FileEventBus();
