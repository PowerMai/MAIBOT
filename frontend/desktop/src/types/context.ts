/**
 * 上下文附件项（与 cursor-style-composer / MyRuntimeProvider 共用）
 */
export interface ContextItem {
  id: string;
  type: "file" | "folder" | "code" | "url" | "image";
  name: string;
  path?: string;
  content?: string;
  preview?: string;
  status?: "uploading" | "success" | "error";
  progress?: number;
  size?: number;
}
