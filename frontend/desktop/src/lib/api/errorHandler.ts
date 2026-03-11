import { toast } from "sonner";

export type ApiRequestError = Error & {
  status?: number;
  handledByApi?: boolean;
};

export function createApiRequestError(message: string, status?: number): ApiRequestError {
  const err = new Error(message || "请求失败") as ApiRequestError;
  if (typeof status === "number") err.status = status;
  return err;
}

export function handleSkillApiError(error: unknown): ApiRequestError {
  const err = (error instanceof Error ? error : new Error(String(error || "请求失败"))) as ApiRequestError;
  const status = Number((err as { status?: unknown }).status);
  if (status === 402) {
    toast.error("当前版本不可用该技能", { description: err.message || "升级到更高版本后可使用" });
    err.handledByApi = true;
    return err;
  }
  if (status === 429) {
    toast.error("试用已达上限", { description: err.message || "请稍后再试或升级版本" });
    err.handledByApi = true;
    return err;
  }
  return err;
}

export function isHandledApiError(error: unknown): boolean {
  return Boolean((error as { handledByApi?: boolean } | null | undefined)?.handledByApi);
}
