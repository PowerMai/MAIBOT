/**
 * Excel 预览组件 - 懒加载以减小首包（xlsx 仅在打开 Excel 时加载）
 */
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Button } from '../ui/button';
import { Download, ExternalLink, FileSpreadsheet, RefreshCw, Save } from 'lucide-react';
import { useVirtualList } from '../../lib/utils/virtualList';
import { t } from '../../lib/i18n';
import { Skeleton } from '../ui/skeleton';

const EXCEL_WORKER_TIMEOUT_MS = 60000;
const excelParseCache = new Map<string, { sheetNames: string[]; sheetsData: string[][][] }>();
const EXCEL_CACHE_MAX = 8;
const EXCEL_ROW_HEIGHT = 30;

export interface ExcelViewerProps {
  content: string;
  fileName: string;
  base64Data?: string;
  onDownload?: () => void;
  onOpenExternal?: () => void;
  /** 保存编辑到工作区（传入 base64，由父组件写回文件） */
  onSaveEdits?: (base64: string) => Promise<void>;
  embeddedInEditor?: boolean;
}

export const ExcelViewer = React.memo(function ExcelViewer({
  content,
  fileName,
  base64Data,
  onDownload,
  onOpenExternal,
  onSaveEdits,
  embeddedInEditor = false,
}: ExcelViewerProps) {
  const [sheetsData, setSheetsData] = useState<string[][][]>([]);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number } | null>(null);
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
  const [localEdits, setLocalEdits] = useState<Record<string, string>>({});
  const editInputRef = useRef<HTMLInputElement>(null);
  const data = sheetsData[activeSheet] ?? [];
  const { virtualState, handleScroll, containerRef: tableScrollRef } = useVirtualList({
    itemCount: data.length,
    itemHeight: EXCEL_ROW_HEIGHT,
    overscan: 8,
  });

  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    setSelectedCell(null);
    setEditingCell(null);
  }, [activeSheet]);

  const dataKey = fileName + '|' + (base64Data?.length ?? 0) + '|' + (content?.length ?? 0) + '|' + retryCount;
  const lastParseKeyRef = useRef<string>('');

  const handleRetry = useCallback(() => {
    setError(null);
    setLoading(true);
    setRetryCount((c) => c + 1);
  }, []);
  const MAX_ROWS_PER_SHEET = 2000;

  useEffect(() => {
    if (!base64Data && !content) {
      setLoading(false);
      setError('没有可用的文件数据');
      return;
    }
    const cached = excelParseCache.get(dataKey);
    if (cached) {
      setSheetNames(cached.sheetNames);
      setSheetsData(cached.sheetsData);
      setError(null);
      setLoading(false);
      lastParseKeyRef.current = dataKey;
      return;
    }
    if (dataKey === lastParseKeyRef.current) {
      setLoading(false);
      return;
    }
    lastParseKeyRef.current = dataKey;
    setLoading(true);
    setError(null);
    let cancelled = false;

    const applyResult = (payload: { ok: true; sheetNames: string[]; sheetsData: string[][][] } | { ok: false; error: string }) => {
      if (cancelled) return;
      if (payload.ok) {
        if (excelParseCache.size >= EXCEL_CACHE_MAX) {
          const firstKey = excelParseCache.keys().next().value;
          if (firstKey != null) excelParseCache.delete(firstKey);
        }
        excelParseCache.set(dataKey, { sheetNames: payload.sheetNames, sheetsData: payload.sheetsData });
        setSheetNames(payload.sheetNames);
        setSheetsData(payload.sheetsData);
      } else {
        setError(payload.error);
      }
      setLoading(false);
    };

    const runMainThreadParse = () => {
      import('xlsx').then((XLSX) => {
        if (cancelled) return;
        try {
          let workbook: import('xlsx').WorkBook;
          if (base64Data) {
            workbook = XLSX.read(base64Data, { type: 'base64' });
          } else if (content && fileName.toLowerCase().endsWith('.csv')) {
            workbook = XLSX.read(content, { type: 'string' });
          } else {
            applyResult({ ok: false, error: '需要 Base64 数据来解析 Excel 文件' });
            return;
          }
          const names = workbook.SheetNames;
          const data = names.map((name) => {
            const ws = workbook.Sheets[name];
            const full = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][];
            return full.slice(0, MAX_ROWS_PER_SHEET);
          });
          applyResult({ ok: true, sheetNames: names, sheetsData: data });
        } catch (err) {
          applyResult({ ok: false, error: err instanceof Error ? err.message : '解析失败' });
        }
      }).catch(() => applyResult({ ok: false, error: '加载 xlsx 库失败' }));
    };

    try {
      const workerUrl = new URL('./excel.worker.ts', import.meta.url);
      const worker = new Worker(workerUrl, { type: 'module' });
      let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        timeoutId = null;
        if (cancelled) return;
        worker.terminate();
        if (import.meta.env?.DEV) console.warn('[ExcelViewer] Worker 超时，回退主线程');
        setTimeout(runMainThreadParse, 0);
      }, EXCEL_WORKER_TIMEOUT_MS);

      const onMessage = (e: MessageEvent<{ ok: true; sheetNames: string[]; sheetsData: string[][][] } | { ok: false; error: string }>) => {
        if (timeoutId != null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        worker.terminate();
        applyResult(e.data);
      };
      const onError = () => {
        if (timeoutId != null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        worker.terminate();
        setTimeout(runMainThreadParse, 0);
      };

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({ base64Data, content, fileName, maxRowsPerSheet: MAX_ROWS_PER_SHEET });
      return () => {
        cancelled = true;
        if (timeoutId != null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        worker.terminate();
      };
    } catch {
      setTimeout(runMainThreadParse, 0);
      return () => { cancelled = true; };
    }
  }, [dataKey]);

  const getCellValue = useCallback((sheetIndex: number, rowIndex: number, cellIndex: number) => {
    const key = `${sheetIndex},${rowIndex},${cellIndex}`;
    if (localEdits[key] !== undefined) return localEdits[key];
    const sheet = sheetsData[sheetIndex] ?? [];
    const row = sheet[rowIndex];
    const val = row?.[cellIndex];
    return val !== undefined && val !== null ? String(val) : '';
  }, [sheetsData, localEdits]);

  const setCellValue = useCallback((sheetIndex: number, rowIndex: number, cellIndex: number, value: string) => {
    setLocalEdits((prev) => ({ ...prev, [`${sheetIndex},${rowIndex},${cellIndex}`]: value }));
  }, []);

  const handleCellClick = useCallback((rowIndex: number, cellIndex: number) => {
    setSelectedCell({ row: rowIndex, col: cellIndex });
    setEditingCell(null);
    tableScrollRef.current?.focus({ preventScroll: true });
  }, []);

  const handleCellDoubleClick = useCallback((rowIndex: number, cellIndex: number) => {
    setSelectedCell({ row: rowIndex, col: cellIndex });
    setEditingCell({ row: rowIndex, col: cellIndex });
    setTimeout(() => editInputRef.current?.focus(), 0);
  }, []);

  const handleEditCommit = useCallback((rowIndex: number, cellIndex: number, value: string) => {
    setCellValue(activeSheet, rowIndex, cellIndex, value);
    setEditingCell(null);
  }, [setCellValue, activeSheet]);

  const buildWorkbookBase64 = useCallback(async (): Promise<string> => {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    sheetNames.forEach((name, sheetIndex) => {
      const raw = sheetsData[sheetIndex] ?? [];
      const rows = raw.map((row, rowIndex) =>
        (row ?? []).map((cell, colIndex) => {
          const key = `${sheetIndex},${rowIndex},${colIndex}`;
          if (localEdits[key] !== undefined) return localEdits[key];
          const v = cell;
          return v !== undefined && v !== null ? String(v) : '';
        })
      );
      const ws = XLSX.utils.aoa_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, name);
    });
    return XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
  }, [sheetNames, sheetsData, localEdits]);

  const exportWithEdits = useCallback(async () => {
    const base64 = await buildWorkbookBase64();
    const XLSX = await import('xlsx');
    const wb = XLSX.read(base64, { type: 'base64' });
    const base = fileName.replace(/\.(csv|xlsx?)$/i, '');
    const outName = (base || 'export') + '_edited.xlsx';
    XLSX.writeFile(wb, outName);
  }, [buildWorkbookBase64, fileName]);

  const [saving, setSaving] = useState(false);
  const handleSaveEdits = useCallback(async () => {
    if (!onSaveEdits) return;
    setSaving(true);
    try {
      const base64 = await buildWorkbookBase64();
      await onSaveEdits(base64);
    } finally {
      setSaving(false);
    }
  }, [onSaveEdits, buildWorkbookBase64]);

  if (loading) {
    return (
      <div className="h-full flex flex-col p-4" role="status" aria-label={t('viewer.excelLoading')}>
        <div className="flex gap-2 mb-3">
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
        <div className="border border-border rounded-md overflow-hidden">
          <div className="flex border-b border-border bg-muted/50">
            <Skeleton className="h-8 w-12 shrink-0 rounded-none" />
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-8 flex-1 min-w-[100px] rounded-none" />
            ))}
          </div>
          {[1, 2, 3, 4, 5].map((row) => (
            <div key={row} className="flex border-b border-border/50 last:border-0">
              <Skeleton className="h-8 w-12 shrink-0 rounded-none" />
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-8 flex-1 min-w-[100px] rounded-none" />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center" role="alert">
        <div className="text-center max-w-md">
          <FileSpreadsheet className="h-16 w-16 mx-auto mb-4 text-green-500/50" aria-hidden />
          <h3 className="text-lg font-medium mb-2">{t('viewer.excelPreview')}</h3>
          <p className="text-sm text-muted-foreground mb-4">{error}</p>
          <div className="flex items-center justify-center gap-2 mb-4 flex-wrap">
            <Button variant="outline" size="sm" className="gap-2" onClick={handleRetry} aria-label={t('viewer.retry')}>
              <RefreshCw className="h-4 w-4" /> {t('viewer.retry')}
            </Button>
            {onDownload && (
              <Button variant="outline" size="sm" className="gap-2" onClick={onDownload} aria-label={t('viewer.download')}>
                <Download className="h-4 w-4" /> {t('viewer.download')}
              </Button>
            )}
            {onOpenExternal && (
              <Button variant="outline" size="sm" className="gap-2" onClick={onOpenExternal} aria-label={t('viewer.openExternal')}>
                <ExternalLink className="h-4 w-4" /> {t('viewer.openExternal')}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t('viewer.excelInstallHint')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 border-b bg-muted/30 px-2 py-1.5 flex items-center justify-between gap-2">
        {sheetNames.length > 1 ? (
          <div className="flex items-center gap-2 overflow-x-auto min-w-0">
            {sheetNames.map((name, index) => (
              <button
                key={name}
                onClick={() => setActiveSheet(index)}
                className={`px-3 py-1 text-sm rounded-md transition-colors shrink-0 ${
                  activeSheet === index ? 'bg-green-500 text-white' : 'hover:bg-muted text-muted-foreground'
                }`}
              >
                {name}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground truncate">{sheetNames[0] || ''}</span>
        )}
        {onSaveEdits && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5 h-7 text-xs"
            onClick={handleSaveEdits}
            disabled={saving}
            aria-label={t('viewer.saveToWorkspace')}
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? t('viewer.saving') : t('viewer.save')}
          </Button>
        )}
      </div>
      <div
        ref={tableScrollRef}
        className="flex-1 overflow-auto outline-none focus:ring-inset focus:ring-1 focus:ring-primary/30"
        tabIndex={0}
        onScroll={handleScroll}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && selectedCell != null && editingCell == null && (e.target as HTMLElement).closest('input') == null) {
            e.preventDefault();
            handleCellDoubleClick(selectedCell.row, selectedCell.col);
          }
        }}
      >
        <div style={{ height: virtualState.totalHeight }}>
          <div style={{ height: virtualState.paddingTop }} aria-hidden />
          <table className="w-full border-collapse text-sm">
            <tbody>
              {virtualState.visibleIndexes.map((rowIndex) => {
                const row = data[rowIndex];
                return (
                  <tr
                    key={rowIndex}
                    style={{ height: EXCEL_ROW_HEIGHT }}
                    className={rowIndex === 0 ? 'sticky top-0 z-10 bg-muted font-medium shadow-[0_1px_0_0_var(--border)]' : 'hover:bg-muted/30'}
                  >
                    <td className="border border-border px-2 py-1.5 text-center text-xs text-muted-foreground bg-muted w-12 sticky left-0 z-10">
                      {rowIndex + 1}
                    </td>
                    {(row ?? []).map((_cell, cellIndex) => {
                      const isSelected = selectedCell?.row === rowIndex && selectedCell?.col === cellIndex;
                      const isEditing = editingCell?.row === rowIndex && editingCell?.col === cellIndex;
                      const value = getCellValue(activeSheet, rowIndex, cellIndex);
                      return (
                        <td
                          key={cellIndex}
                          onClick={() => handleCellClick(rowIndex, cellIndex)}
                          onDoubleClick={() => handleCellDoubleClick(rowIndex, cellIndex)}
                          className={`border border-border px-3 py-1 min-w-[100px] max-w-[300px] align-middle ${
                            rowIndex === 0 ? 'bg-muted' : ''
                          } ${isSelected ? 'ring-2 ring-primary ring-inset bg-primary/10' : ''} ${
                            isEditing ? 'p-0' : 'truncate'
                          }`}
                          title={value || '双击编辑'}
                        >
                          {isEditing ? (
                            <input
                              ref={editInputRef}
                              type="text"
                              className="w-full min-w-0 px-2 py-1 text-sm border-0 rounded-none focus:outline-none focus:ring-1 focus:ring-primary bg-background"
                              defaultValue={value}
                              onClick={(e) => e.stopPropagation()}
                              onBlur={(e) => handleEditCommit(rowIndex, cellIndex, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  handleEditCommit(rowIndex, cellIndex, (e.target as HTMLInputElement).value);
                                }
                                if (e.key === 'Escape') {
                                  setEditingCell(null);
                                  (e.target as HTMLInputElement).value = value;
                                }
                              }}
                            />
                          ) : (
                            <span className="block truncate">{value}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ height: virtualState.paddingBottom }} aria-hidden />
        </div>
      </div>
    </div>
  );
});
