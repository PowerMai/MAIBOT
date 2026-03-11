/**
 * 统一文件管理服务
 * 提供工作区、知识库、Domain 的统一文件操作接口
 * 
 * ✅ 优化：优先使用 Electron 本地 API，降级到 HTTP API
 */

import { workspaceAPI } from '../api/workspace';
import { knowledgeAPI } from '../api/knowledge';
import { getInternalAuthHeaders } from '../api/internalAuth';
import { getApiBase, validServerThreadIdOrUndefined } from '../api/langserveChat';
import { toast } from 'sonner';
import { fileSystemService, isElectronEnv } from './electronService';
import { getCurrentThreadIdFromStorage, getCurrentWorkspacePathFromStorage } from '../sessionState';

export interface UploadResult {
  success: boolean;
  uploaded: Array<{
    filename: string;
    path: string;
    size: number;
    detected_domain?: string;
  }>;
  errors: Array<{
    filename: string;
    error: string;
  }>;
  total: number;
  success_count: number;
  error_count: number;
}

export interface ProcessedFile {
  filename: string;
  content: string;
  metadata: Record<string, any>;
}

export interface ProcessOptions {
  extractText?: boolean;
  detectDomain?: boolean;
  indexImmediately?: boolean;
}

/** 根据文件名与 MIME 做轻量领域推断，便于上传后路由与索引。 */
async function detectDomainFromFile(file: File): Promise<string> {
  const name = (file.name || '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  const mime = (file.type || '').toLowerCase();
  if (/\.(md|txt|pdf|docx?|rtf)$/i.test(name) || mime.includes('text') || mime.includes('pdf') || mime.includes('document')) return 'doc';
  if (/\.(py|ts|tsx|js|jsx|vue|mjs|mts|go|rs|java|kt|rb|php|c|cpp|h|hpp|sql|sh|yaml|yml|json|xml|html|css|scss)$/i.test(name) || mime.includes('script') || mime.includes('json') || mime.includes('xml')) return 'code';
  if (/\.(xlsx?|csv|parquet|sqlite|db)$/i.test(name) || mime.includes('sheet') || mime.includes('csv')) return 'data';
  return 'general';
}

export class UnifiedFileService {
  /**
   * 检查是否在 Electron 环境中
   */
  isElectron(): boolean {
    return isElectronEnv();
  }

  /**
   * 读取文件内容（优先使用 Electron API）
   */
  async readFile(filePath: string): Promise<string | null> {
    const result = await fileSystemService.readFile(filePath);
    if (result.success && result.data) {
      return result.data;
    }
    return null;
  }

  /**
   * 写入文件（优先使用 Electron API）
   */
  async writeFile(filePath: string, content: string): Promise<boolean> {
    const result = await fileSystemService.writeFile(filePath, content);
    return result.success;
  }

  /**
   * 检查文件是否存在（优先使用 Electron API）
   */
  async fileExists(filePath: string): Promise<boolean> {
    const result = await fileSystemService.fileExists(filePath);
    return result.success && result.data === true;
  }

  /**
   * 上传文件到工作区（后端 POST /workspace/upload 单文件，多文件循环上传）
   */
  async uploadToWorkspace(_workspaceId: string, files: File[]): Promise<UploadResult> {
    const base = getApiBase();
    const uploaded: UploadResult['uploaded'] = [];
    const errors: UploadResult['errors'] = [];
    const rawThreadId = getCurrentThreadIdFromStorage();
    const threadId = validServerThreadIdOrUndefined(rawThreadId) ?? "";
    const wp = getCurrentWorkspacePathFromStorage();

    const results = await Promise.all(
      files.map(async (file) => {
        try {
          const formData = new FormData();
          formData.append('file', file);
          if (wp) formData.append('workspace_path', wp);
          if (_workspaceId) formData.append('workspace_id', _workspaceId);
          if (threadId) formData.append('thread_id', threadId);
          const response = await fetch(`${base}/workspace/upload`, {
            method: 'POST',
            headers: getInternalAuthHeaders(),
            body: formData,
          });
          if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error((err as any).detail || `HTTP ${response.status}`);
          }
          const data = await response.json();
          return { ok: true as const, file: file.name, data };
        } catch (error) {
          return { ok: false as const, file: file.name, error: error instanceof Error ? error.message : String(error) };
        }
      })
    );
    for (const r of results) {
      if (r.ok) {
        const path = (r.data as { path?: string }).path;
        if (path) {
          uploaded.push({
            filename: (r.data as { filename?: string }).filename ?? r.file,
            path,
            size: (r.data as { size?: number }).size ?? 0,
          });
        } else {
          errors.push({ filename: r.file, error: '服务器未返回 path' });
        }
      } else {
        errors.push({ filename: r.file, error: r.error });
      }
    }

    if (errors.length > 0 && uploaded.length === 0) {
      toast.error('工作区文件上传失败', {
        description: errors[0].error,
      });
    } else if (errors.length > 0) {
      toast.warning(`部分文件上传失败: ${errors.length}/${files.length}`);
    }

    return {
      success: errors.length === 0,
      uploaded,
      errors,
      total: files.length,
      success_count: uploaded.length,
      error_count: errors.length,
    };
  }

  /**
   * 上传文件到知识库
   * 使用新 API：knowledgeAPI.uploadDocument
   */
  async uploadToKnowledgeBase(targetPath: string, files: File[]): Promise<UploadResult> {
    const uploaded: UploadResult['uploaded'] = [];
    const errors: UploadResult['errors'] = [];

    const results = await Promise.all(
      files.map(async (file) => {
        try {
          await knowledgeAPI.uploadDocument(file, targetPath);
          return { ok: true as const, file: file.name, size: file.size };
        } catch (error) {
          return { ok: false as const, file: file.name, error: error instanceof Error ? error.message : String(error) };
        }
      })
    );
    for (const r of results) {
      if (r.ok) uploaded.push({ filename: r.file, path: `${targetPath}/${r.file}`, size: r.size });
      else errors.push({ filename: r.file, error: r.error });
    }

    if (errors.length > 0 && uploaded.length === 0) {
      toast.error('知识库文件上传失败', {
        description: errors[0].error,
      });
    } else if (errors.length > 0) {
      toast.warning(`部分文件上传失败: ${errors.length}/${files.length}`);
    }

    return {
      success: errors.length === 0,
      uploaded,
      errors,
      total: files.length,
      success_count: uploaded.length,
      error_count: errors.length,
    };
  }

  /**
   * 上传文件到 Domain
   * - type 'files'：逐文件调用 POST /files/upload（后端单文件），带 workspace_path，结果聚合
   * - type 'knowledge'：单次 POST /knowledge/upload，响应格式 success/uploaded
   */
  async uploadToDomain(
    domainName: string,
    files: File[],
    type: 'knowledge' | 'files'
  ): Promise<UploadResult> {
    try {
      const base = getApiBase();
      const wp = getCurrentWorkspacePathFromStorage();

      if (type === 'files') {
        const uploaded: UploadResult['uploaded'] = [];
        const errors: UploadResult['errors'] = [];
        for (const file of files) {
          const formData = new FormData();
          formData.append('file', file);
          if (wp) formData.append('workspace_path', wp);
          const response = await fetch(`${base}/files/upload`, {
            method: 'POST',
            headers: getInternalAuthHeaders(),
            body: formData,
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            errors.push({ filename: file.name, error: (data as { detail?: string }).detail || `HTTP ${response.status}` });
            continue;
          }
          if ((data as { ok?: boolean }).ok === false) {
            errors.push({ filename: file.name, error: (data as { detail?: string; error?: string }).detail || (data as { error?: string }).error || 'Upload failed' });
            continue;
          }
          const path = (data as { path?: string }).path;
          if (path) {
            uploaded.push({
              filename: (data as { filename?: string }).filename || file.name,
              path,
              size: (data as { size?: number }).size ?? 0,
            });
          } else {
            errors.push({ filename: file.name, error: '服务器未返回 path' });
          }
        }
        return {
          success: errors.length === 0,
          uploaded,
          errors,
          total: files.length,
          success_count: uploaded.length,
          error_count: errors.length,
        };
      }

      const formData = new FormData();
      files.forEach((file) => formData.append('files', file));
      const response = await fetch(`${base}/knowledge/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errText = await response.text();
        let errMsg: string;
        try {
          const errJson = JSON.parse(errText);
          errMsg = (errJson as any).error || (errJson as any).detail || response.statusText;
        } catch {
          errMsg = errText || response.statusText;
        }
        throw new Error(errMsg);
      }
      const data = await response.json();

      if (!(data as { success?: boolean }).success) {
        throw new Error((data as { error?: string }).error || 'Upload failed');
      }
      const rawUploaded = (data as { uploaded?: Array<{ filename?: string; path?: string; size?: number }> }).uploaded || [];
      const uploaded: UploadResult['uploaded'] = rawUploaded.map((u) => ({
        filename: u.filename ?? '',
        path: u.path ?? '',
        size: u.size ?? 0,
      }));
      const rawErrors = (data as { errors?: Array<{ filename?: string; error?: string }> }).errors || [];
      const errors: UploadResult['errors'] = rawErrors.map((e) => ({
        filename: e.filename ?? '',
        error: e.error ?? 'Unknown error',
      }));
      return {
        success: !!(data as { success?: boolean }).success,
        uploaded,
        errors,
        total: (data as { total?: number }).total ?? files.length,
        success_count: (data as { success_count?: number }).success_count ?? uploaded.length,
        error_count: (data as { error_count?: number }).error_count ?? 0,
      };
    } catch (error) {
      toast.error('Domain 文件上传失败', {
        description: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * 统一文件处理（格式转换、索引等）
   */
  async processFiles(files: File[], options: ProcessOptions = {}): Promise<ProcessedFile[]> {
    const processed: ProcessedFile[] = [];

    for (const file of files) {
      try {
        let content = '';
        if (options.extractText !== false) {
          content = await file.text();
        }

        const metadata: Record<string, any> = {
          filename: file.name,
          file_type: file.type,
          file_size: file.size,
          last_modified: new Date(file.lastModified).toISOString(),
        };

        if (options.detectDomain) {
          metadata.detected_domain = await detectDomainFromFile(file);
        }

        processed.push({
          filename: file.name,
          content,
          metadata,
        });
      } catch (error) {
        console.error(`Error processing file ${file.name}:`, error);
      }
    }

    return processed;
  }

  /**
   * 智能上传（根据上下文自动选择目标）
   */
  async smartUpload(
    files: File[],
    context: {
      workspaceId?: string;
      kbId?: string;
      domainName?: string;
      domainType?: 'knowledge' | 'files';
    }
  ): Promise<UploadResult> {
    if (context.workspaceId) {
      return this.uploadToWorkspace(context.workspaceId, files);
    } else if (context.kbId) {
      return this.uploadToKnowledgeBase(context.kbId, files);
    } else if (context.domainName) {
      return this.uploadToDomain(
        context.domainName,
        files,
        context.domainType || 'files'
      );
    } else {
      throw new Error('No valid upload target specified');
    }
  }
}

// 导出单例
export const unifiedFileService = new UnifiedFileService();

