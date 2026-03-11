/**
 * WebViewer - HTML / 网页预览
 *
 * 在沙箱 iframe 中渲染 HTML 文件或 URL，支持：
 * - 本地 HTML 文件内容（content）
 * - URL 预览（如 AI 返回的网页链接）
 */

import React, { useMemo } from 'react';

export interface WebViewerProps {
  /** HTML 字符串内容（用于本地 .html 文件） */
  content?: string;
  /** 要加载的 URL（用于网页预览） */
  url?: string;
  /** 文件名，用于标题等 */
  fileName?: string;
  /** 高度，默认 100% */
  height?: string;
  /** 嵌入编辑区时隐藏文件名栏，避免与 Tab 重复 */
  embeddedInEditor?: boolean;
}

/** 沙箱属性：不执行脚本，仅静态渲染，防止用户/LLM 提供内容的 XSS */
const IFRAME_SANDBOX = '';

export function WebViewer({
  content,
  url,
  fileName,
  height = '100%',
  embeddedInEditor,
}: WebViewerProps) {
  const srcdoc = useMemo(() => {
    if (!content || url) return undefined;
    const trimmed = content.trim();
    if (
      trimmed.startsWith('<!') ||
      trimmed.startsWith('<html') ||
      trimmed.startsWith('<HTML')
    ) {
      return trimmed;
    }
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${trimmed}</body></html>`;
  }, [content, url]);

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden bg-background" style={{ height }}>
      {fileName && !embeddedInEditor && (
        <div className="shrink-0 border-b bg-card/50 px-3 py-2 flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{fileName}</span>
        </div>
      )}
      <div className="flex-1 min-h-0 w-full">
        <iframe
          title={fileName || 'HTML 预览'}
          src={url || (srcdoc ? undefined : 'about:blank')}
          srcDoc={srcdoc}
          sandbox={IFRAME_SANDBOX}
          referrerPolicy="no-referrer"
          className="w-full h-full border-0 rounded-none bg-white dark:bg-neutral-900"
        />
      </div>
    </div>
  );
}

export default WebViewer;
