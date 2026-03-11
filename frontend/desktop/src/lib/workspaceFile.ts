/**
 * .ccb-workspace 工作区文件格式（兼容 VSCode 风格）
 * 支持多文件夹工作区
 */

export const WORKSPACE_FILE_EXT = '.ccb-workspace';

export interface CCBWorkspaceFolder {
  path: string;
  name?: string;
}

export interface CCBWorkspace {
  folders: CCBWorkspaceFolder[];
  settings?: Record<string, unknown>;
}

const DEFAULT_WORKSPACE: CCBWorkspace = {
  folders: [],
  settings: {},
};

/**
 * 解析工作区文件内容
 */
export function parseWorkspaceFile(content: string): CCBWorkspace {
  const trimmed = content.trim();
  if (!trimmed) return { ...DEFAULT_WORKSPACE };
  try {
    const raw = JSON.parse(trimmed) as unknown;
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_WORKSPACE };
    const obj = raw as Record<string, unknown>;
    const folders = Array.isArray(obj.folders)
      ? (obj.folders as unknown[]).filter(
          (f): f is CCBWorkspaceFolder =>
            f != null &&
            typeof f === 'object' &&
            'path' in f &&
            typeof (f as CCBWorkspaceFolder).path === 'string'
        )
      : [];
    const settings =
      obj.settings != null && typeof obj.settings === 'object' && !Array.isArray(obj.settings)
        ? (obj.settings as Record<string, unknown>)
        : {};
    return { folders, settings };
  } catch {
    return { ...DEFAULT_WORKSPACE };
  }
}

/**
 * 序列化为工作区文件内容
 */
export function serializeWorkspaceFile(workspace: CCBWorkspace): string {
  const normalized: CCBWorkspace = {
    folders: workspace.folders.map((f) => ({ path: f.path, ...(f.name ? { name: f.name } : {}) })),
    settings: workspace.settings ?? {},
  };
  return JSON.stringify(normalized, null, 2);
}

/**
 * 校验是否为合法工作区结构
 */
export function validateWorkspaceFile(workspace: unknown): workspace is CCBWorkspace {
  if (!workspace || typeof workspace !== 'object') return false;
  const w = workspace as Record<string, unknown>;
  if (!Array.isArray(w.folders)) return false;
  return w.folders.every(
    (f) =>
      f != null &&
      typeof f === 'object' &&
      'path' in f &&
      typeof (f as CCBWorkspaceFolder).path === 'string'
  );
}
