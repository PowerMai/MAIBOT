/**
 * PDF 预览组件 - 使用 react-pdf 实现内嵌预览
 * 支持：文本层、注释层、文本搜索、缩略图侧栏
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { FileText, RefreshCw, Search, ChevronUp, ChevronDown, X, LayoutList, Download, Printer } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { t } from '../lib/i18n';

// Worker：生产构建用 CDN 避免 Rollup 处理 ?url 报错；开发时用项目内 ?url
const workerReady =
  import.meta.env.PROD
    ? Promise.resolve().then(() => {
        if (typeof pdfjs.GlobalWorkerOptions !== 'undefined') {
          pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version || '5.4.296'}/build/pdf.worker.min.mjs`;
        }
      })
    : import('pdfjs-dist/build/pdf.worker.min.mjs?url')
        .then((m) => {
          const url = (m && typeof (m as { default?: string }).default === 'string')
            ? (m as { default: string }).default
            : (m as unknown as string);
          if (url && typeof pdfjs.GlobalWorkerOptions !== 'undefined') {
            pdfjs.GlobalWorkerOptions.workerSrc = url;
          }
        })
        .catch(() => {
          const v = pdfjs.version || '5.4.296';
          if (typeof pdfjs.GlobalWorkerOptions !== 'undefined') {
            pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${v}/build/pdf.worker.min.mjs`;
          }
        });

interface PdfPreviewProps {
  base64: string;
  fileName: string;
  filePath?: string;
  /** 嵌入编辑区时 Tab 已有文件名，工具栏不重复显示文件名 */
  embeddedInEditor?: boolean;
}

const THUMB_SCALE = 0.18;
/** PDF 加载超时（毫秒），避免损坏或过大文件无限等待 */
const PDF_LOAD_TIMEOUT_MS = 30000;

export function PdfPreview({ base64, fileName, filePath, embeddedInEditor = false }: PdfPreviewProps) {
  const [workerLoaded, setWorkerLoaded] = useState(false);
  const [numPages, setNumPages] = useState<number>(0);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResultPages, setSearchResultPages] = useState<number[]>([]);
  const [searchResultIndex, setSearchResultIndex] = useState(0);
  const [searchOverlayOpen, setSearchOverlayOpen] = useState(false);
  const [showThumbnails, setShowThumbnails] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadTimedOutRef = useRef(false);

  useEffect(() => {
    workerReady.then(() => setWorkerLoaded(true));
  }, []);

  // 加载超时：大文件或损坏 PDF 可能长时间无响应，超时后提示并可重试
  useEffect(() => {
    loadTimedOutRef.current = false;
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      loadTimedOutRef.current = true;
      setError(t('viewer.pdfLoadTimeout'));
      setLoading(false);
    }, PDF_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [base64]);

  // 将 base64 转换为 data URL（必须在所有 hook 之前计算，供 useCallback 依赖）
  const pdfDataUrl = `data:application/pdf;base64,${base64}`;

  const handleDownload = useCallback(() => {
    try {
      const binary = Uint8Array.from(atob(base64.replace(/\s/g, '')), (c) => c.charCodeAt(0));
      const blob = new Blob([binary], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName || 'document.pdf';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('PDF download failed:', e);
    }
  }, [base64, fileName]);

  const handlePrint = useCallback(() => {
    try {
      const w = window.open('', '_blank');
      if (!w) return;
      w.document.write(`
        <!DOCTYPE html><html><head><title>${fileName || 'PDF'}</title></head>
        <body style="margin:0;">
          <iframe src="${pdfDataUrl}" style="width:100%;height:100vh;border:0;" title="PDF"></iframe>
        </body></html>
      `);
      w.document.close();
      w.focus();
      setTimeout(() => {
        w.print();
        w.close();
      }, 500);
    } catch (e) {
      console.error('PDF print failed:', e);
    }
  }, [pdfDataUrl, fileName]);

  /** 在 PDF 内搜索文本，收集所有匹配页，跳转到第一处 */
  const handleSearch = useCallback(async () => {
    const q = searchQuery.trim();
    if (!q || !pdfDataUrl) return;
    setSearching(true);
    setSearchResultPages([]);
    try {
      const pdf = await pdfjs.getDocument(pdfDataUrl).promise;
      const matches: number[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const text = content.items.map((item: any) => ('str' in item ? item.str : '')).join('');
        if (text.toLowerCase().includes(q.toLowerCase())) matches.push(i);
      }
      setSearchResultPages(matches);
      setSearchResultIndex(0);
      if (matches.length > 0) {
        setPageNumber(matches[0]);
      }
    } catch (e) {
      console.error('PDF 搜索失败:', e);
    }
    setSearching(false);
  }, [searchQuery, pdfDataUrl]);

  const goToSearchResult = useCallback((direction: 1 | -1) => {
    setSearchResultIndex((i) => {
      const pages = searchResultPages;
      if (pages.length === 0) return 0;
      const next = i + direction;
      const idx = next < 0 ? pages.length - 1 : next >= pages.length ? 0 : next;
      setPageNumber(pages[idx]);
      return idx;
    });
  }, [searchResultPages]);

  // 页码变化时同步搜索结果索引（便于 n/N 与当前页一致）
  useEffect(() => {
    if (searchResultPages.length === 0) return;
    const idx = searchResultPages.indexOf(pageNumber);
    if (idx >= 0 && idx !== searchResultIndex) setSearchResultIndex(idx);
  }, [pageNumber, searchResultPages, searchResultIndex]);

  const onDocumentLoadSuccess = useCallback(({ numPages: n }: { numPages: number }) => {
    if (loadTimedOutRef.current) return;
    setNumPages(n);
    setLoading(false);
    setError(null);
    setSearchResultPages([]);
  }, []);

  const onDocumentLoadError = useCallback((err: Error) => {
    if (loadTimedOutRef.current) return;
    console.error('PDF 加载失败:', err);
    setError('PDF 文件加载失败');
    setLoading(false);
  }, []);

  const handleRetry = useCallback(() => {
    loadTimedOutRef.current = false;
    setError(null);
    setLoading(true);
    setRetryKey((k) => k + 1);
  }, []);

  if (!workerLoaded) {
    return (
      <div className="flex items-center justify-center min-h-[200px] bg-background text-muted-foreground" role="status" aria-label={t('viewer.pdfEngineLoading')}>
        {t('viewer.pdfEngineLoading')}
      </div>
    );
  }

  const goToPrevPage = () => {
    setPageNumber((prev) => Math.max(prev - 1, 1));
  };

  const goToNextPage = () => {
    setPageNumber((prev) => Math.min(prev + 1, numPages));
  };

  const zoomIn = () => {
    setScale((prev) => Math.min(prev + 0.2, 3.0));
  };

  const zoomOut = () => {
    setScale((prev) => Math.max(prev - 0.2, 0.5));
  };

  const resetZoom = () => {
    setScale(1.0);
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setSearchOverlayOpen((open) => {
          if (!open) {
            if (searchFocusTimerRef.current) clearTimeout(searchFocusTimerRef.current);
            searchFocusTimerRef.current = setTimeout(() => {
              searchFocusTimerRef.current = null;
              searchInputRef.current?.focus();
            }, 50);
          }
          return !open;
        });
        return;
      }
      if (e.key === 'Escape') {
        setSearchOverlayOpen(false);
        return;
      }
      if (searchOverlayOpen) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setPageNumber((p) => Math.max(p - 1, 1));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setPageNumber((p) => Math.min(p + 1, numPages || 1));
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        setScale((s) => Math.min(s + 0.2, 3.0));
      } else if (e.key === '-') {
        e.preventDefault();
        setScale((s) => Math.max(s - 0.2, 0.5));
      }
    };
    el.setAttribute('tabIndex', '0');
    el.addEventListener('keydown', onKeyDown);
    return () => {
      el.removeEventListener('keydown', onKeyDown);
      if (searchFocusTimerRef.current) {
        clearTimeout(searchFocusTimerRef.current);
        searchFocusTimerRef.current = null;
      }
    };
  }, [numPages, searchOverlayOpen]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setScale((s) => (e.deltaY < 0 ? Math.min(s + 0.15, 3.0) : Math.max(s - 0.15, 0.5)));
    }
  }, []);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 bg-background" role="alert">
        <FileText className="h-16 w-16 text-muted-foreground mb-4" />
        <h3 className="text-lg font-medium text-foreground mb-2">{t('viewer.pdfLoadFailed')}</h3>
        <p className="text-sm text-muted-foreground text-center mb-4">{error}</p>
        <p className="text-xs text-muted-foreground mb-4">{t('viewer.fileLabel')}{fileName}</p>
        <Button variant="outline" size="sm" className="gap-2" onClick={handleRetry} aria-label={t('viewer.retry')}>
          <RefreshCw className="h-4 w-4" /> {t('viewer.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background relative">
      {/* 浮动搜索框：Ctrl/Cmd+F 打开 */}
      {searchOverlayOpen && numPages > 0 && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-3 py-2 rounded-lg border bg-popover shadow-lg">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <Input
            ref={searchInputRef}
            type="text"
            placeholder={t('viewer.pdfSearchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSearch();
              if (e.key === 'Escape') setSearchOverlayOpen(false);
            }}
            className="h-8 w-40 text-sm"
          />
          <Button variant="ghost" size="sm" className="h-8" onClick={() => handleSearch()} disabled={searching || !searchQuery.trim()}>
            {searching ? '…' : t('viewer.pdfSearchFind')}
          </Button>
          {searchResultPages.length > 0 && (
            <span className="text-xs text-muted-foreground whitespace-nowrap flex items-center gap-1">
              {searchResultIndex + 1} / {searchResultPages.length}
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => goToSearchResult(-1)} title="上一处">
                <ChevronUp className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => goToSearchResult(1)} title="下一处">
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </span>
          )}
          {searchQuery.trim() && !searching && searchResultPages.length === 0 && (
            <span className="text-xs text-muted-foreground">{t('viewer.pdfSearchNoResult')}</span>
          )}
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => setSearchOverlayOpen(false)} aria-label={t('viewer.close')}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
      {/* 无固定工具栏：Ctrl+滚轮缩放，Ctrl+F 搜索，左右键翻页，页码见底部 */}
      <div
        ref={containerRef}
        className="flex-1 flex min-h-0 overflow-hidden bg-muted/40 relative outline-none"
        onWheel={handleWheel}
      >
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-10">
            <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
          </div>
        )}
        <Document
          key={retryKey}
          file={pdfDataUrl}
          onLoadSuccess={onDocumentLoadSuccess}
          onLoadError={onDocumentLoadError}
          loading={null}
          className="flex-1 flex min-h-0"
        >
          <div className="flex-1 flex min-h-0 min-w-0">
            {showThumbnails && numPages > 0 && (
              <aside className="w-[72px] shrink-0 border-r border-border/50 bg-muted/20 overflow-y-auto py-2 flex flex-col items-center gap-2">
                {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setPageNumber(n)}
                    className={`shrink-0 w-12 overflow-hidden rounded border-2 transition-colors ${
                      pageNumber === n ? 'border-primary shadow' : 'border-transparent hover:border-muted-foreground/30'
                    }`}
                    title={`第 ${n} 页`}
                  >
                    <Page pageNumber={n} scale={THUMB_SCALE} renderTextLayer={false} renderAnnotationLayer={false} className="doc-viewer-paper" />
                  </button>
                ))}
              </aside>
            )}
            <div className="flex-1 overflow-auto p-4 flex justify-center min-w-0">
              <Page
                pageNumber={pageNumber}
                scale={scale}
                renderTextLayer={true}
                renderAnnotationLayer={true}
                className="doc-viewer-paper shadow-lg"
              />
            </div>
          </div>
        </Document>
      </div>
      
      {/* 底部栏：页码、缩略图/打印/下载、缩放 */}
      {numPages > 0 && (
        <div className="shrink-0 px-3 py-1.5 border-t border-border/30 bg-muted/20 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>第 {pageNumber} / {numPages} 页</span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleDownload} title={t('viewer.download')} aria-label={t('viewer.download')}>
              <Download className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handlePrint} title={t('viewer.print')} aria-label={t('viewer.print')}>
              <Printer className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setShowThumbnails((v) => !v)}
              title={showThumbnails ? '关闭缩略图' : '显示缩略图'}
              aria-label={showThumbnails ? '关闭缩略图' : '显示缩略图'}
            >
              <LayoutList className="h-3.5 w-3.5" />
            </Button>
            <button
              type="button"
              className="px-1.5 py-0.5 rounded hover:bg-muted/50 min-w-[2.5rem]"
              onClick={() => setScale(1)}
              title="点击重置为 100%"
            >
              {Math.round(scale * 100)}%
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 检测内容是否为 PDF 预览数据
 */
export function isPdfContent(content: string): boolean {
  return content.trim().startsWith('__PDF_PREVIEW__');
}

/**
 * 解析 PDF 预览数据
 */
export function parsePdfContent(content: string): { fileName: string; filePath: string; base64: string; size: number } | null {
  if (!isPdfContent(content)) return null;
  
  try {
    const match = content.match(/__PDF_PREVIEW__\s*([\s\S]*?)\s*__PDF_PREVIEW_END__/);
    if (match) {
      return JSON.parse(match[1]);
    }
  } catch (e) {
    console.error('解析 PDF 数据失败:', e);
  }
  return null;
}

export default PdfPreview;
