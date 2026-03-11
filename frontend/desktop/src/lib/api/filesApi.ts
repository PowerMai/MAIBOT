import { apiClient } from "./client";
import { getCurrentWorkspacePathFromStorage } from "../sessionState";

export interface UploadedFileResult {
  path: string;
  name?: string;
  size?: number;
  mime_type?: string;
}

export const filesApi = {
  async uploadFile(file: File): Promise<{ ok: boolean; data?: UploadedFileResult; error?: string }> {
    try {
      const formData = new FormData();
      formData.append("file", file);
      const wp = getCurrentWorkspacePathFromStorage();
      if (wp && wp.trim()) formData.append("workspace_path", wp.trim());
      const raw = await apiClient.postForm<Record<string, unknown>>("/files/upload", formData);
      if (raw && (raw as { ok?: boolean }).ok === false) {
        const msg = (raw as { detail?: string; error?: string }).detail ?? (raw as { error?: string }).error ?? "上传失败";
        return { ok: false, error: String(msg) };
      }
      const path = (raw?.path ?? (raw as { data?: { path?: string } })?.data?.path) as string | undefined;
      const name = (raw?.filename ?? raw?.name ?? (raw as { data?: { name?: string } })?.data?.name) as string | undefined;
      const size = (raw?.size ?? (raw as { data?: { size?: number } })?.data?.size) as number | undefined;
      if (!path) return { ok: false, error: "服务器未返回文件路径" };
      return { ok: true, data: { path, name, size } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
};

