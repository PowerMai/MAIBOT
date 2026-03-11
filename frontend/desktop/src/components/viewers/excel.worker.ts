/**
 * Web Worker：在后台线程解析 xlsx，避免主线程卡死
 * 使用动态 import，并限制每表行数，避免 postMessage 回传时主线程卡死
 */
export interface ExcelWorkerInput {
  base64Data?: string;
  content?: string;
  fileName: string;
  /** 每张表最多返回行数，默认 2000，避免超大表阻塞 */
  maxRowsPerSheet?: number;
}

export interface ExcelWorkerSuccess {
  ok: true;
  sheetNames: string[];
  sheetsData: string[][][];
}

export interface ExcelWorkerError {
  ok: false;
  error: string;
}

const DEFAULT_MAX_ROWS = 2000;

self.onmessage = async (e: MessageEvent<ExcelWorkerInput>) => {
  const { base64Data, content, fileName, maxRowsPerSheet = DEFAULT_MAX_ROWS } = e.data;
  try {
    const XLSX = await import('xlsx');
    let workbook: import('xlsx').WorkBook;
    if (base64Data) {
      workbook = XLSX.read(base64Data, { type: 'base64' });
    } else if (content) {
      if (fileName.toLowerCase().endsWith('.csv')) {
        workbook = XLSX.read(content, { type: 'string' });
      } else {
        throw new Error('需要 Base64 数据来解析 Excel 文件');
      }
    } else {
      throw new Error('没有可用的文件数据');
    }
    const sheetNames = workbook.SheetNames;
    const sheetsData = sheetNames.map((name) => {
      const ws = workbook.Sheets[name];
      const full = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][];
      return full.slice(0, maxRowsPerSheet);
    });
    const result: ExcelWorkerSuccess = { ok: true, sheetNames, sheetsData };
    self.postMessage(result);
  } catch (err) {
    const result: ExcelWorkerError = {
      ok: false,
      error: err instanceof Error ? err.message : '解析失败',
    };
    self.postMessage(result);
  }
};
