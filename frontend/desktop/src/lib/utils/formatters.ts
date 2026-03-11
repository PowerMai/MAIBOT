/**
 * 统一的格式化工具函数
 * 时间分组与格式对齐 UI_CURSOR_STYLE_SPEC §4：刚刚（2分钟内）、15分钟内（2–15分钟）、更早（15分钟以上）；摘要 HH:mm，详情 MM/DD HH:mm。
 */

/** 时间分组标签（单源，供聊天区/任务面板/任务详情/通知中心复用） */
export type TimeGroupLabel = "刚刚" | "15分钟内" | "更早";

export function getTimeGroupLabel(ts: Date | string | number | undefined): TimeGroupLabel {
  if (ts == null) return "更早";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "更早";
  const diffMs = Date.now() - d.getTime();
  if (diffMs <= 2 * 60 * 1000) return "刚刚";
  if (diffMs <= 15 * 60 * 1000) return "15分钟内";
  return "更早";
}

/** 摘要时间格式 HH:mm */
export function formatTimeForSummary(date: Date | string | number): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  const m = d.getMinutes();
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 详情时间格式 MM/DD HH:mm */
export function formatTimeForDetail(date: Date | string | number): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const mon = d.getMonth() + 1;
  const day = d.getDate();
  const h = d.getHours();
  const m = d.getMinutes();
  return `${String(mon).padStart(2, "0")}/${String(day).padStart(2, "0")} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * 格式化时间戳为相对时间
 */
export function formatRelativeTime(date: Date | string | number): string {
  const now = new Date();
  const target = new Date(date);
  const diffMs = now.getTime() - target.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin}分钟前`;
  if (diffHour < 24) return `${diffHour}小时前`;
  if (diffDay === 1) return "昨天";
  if (diffDay < 7) return `${diffDay}天前`;
  return target.toLocaleDateString();
}

/**
 * 格式化时间戳为完整时间
 */
export function formatFullTime(date: Date | string | number): string {
  const target = new Date(date);
  return target.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 格式化文件大小
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * 格式化持续时间
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return secs > 0 ? `${mins}分${secs}秒` : `${mins}分钟`;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return mins > 0 ? `${hours}小时${mins}分` : `${hours}小时`;
}

/**
 * 格式化数字（添加千分位）
 */
export function formatNumber(num: number): string {
  return num.toLocaleString('zh-CN');
}

/**
 * 截断文本
 */
export function truncateText(text: string, maxLength: number, suffix = '...'): string {
  if (!text || text.length <= maxLength) return text;
  return text.slice(0, maxLength - suffix.length) + suffix;
}

/**
 * 生成唯一 ID
 */
export function generateId(prefix = ''): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return prefix ? `${prefix}-${timestamp}-${random}` : `${timestamp}-${random}`;
}

/**
 * 解析 Markdown 中的代码块
 */
export function extractCodeBlocks(text: string): Array<{ language: string; code: string }> {
  const blocks: Array<{ language: string; code: string }> = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let match;
  
  while ((match = regex.exec(text)) !== null) {
    blocks.push({
      language: match[1] || 'text',
      code: match[2].trim(),
    });
  }
  
  return blocks;
}

/**
 * 移除 Markdown 格式
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '') // 代码块
    .replace(/`[^`]+`/g, '')        // 行内代码
    .replace(/\*\*([^*]+)\*\*/g, '$1') // 加粗
    .replace(/\*([^*]+)\*/g, '$1')     // 斜体
    .replace(/#+\s*/g, '')             // 标题
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // 链接
    .replace(/\n+/g, ' ')              // 多个换行
    .trim();
}

