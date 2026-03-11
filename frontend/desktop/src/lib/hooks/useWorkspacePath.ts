import { useCallback, useRef } from "react";
import { getApiBase } from "../api/langserveChat";
import { setItem as setStorageItem } from "../safeStorage";
import { getCurrentWorkspacePathFromStorage } from "../sessionState";
import { t } from "../i18n";
import { toast } from "sonner";

let workspaceRootErrorToastShown = false;

function readLocalWorkspacePath(): string {
  return getCurrentWorkspacePathFromStorage();
}

export function useWorkspacePath() {
  const cachedBackendWorkspaceRef = useRef<string>("");
  const pendingFetchRef = useRef<Promise<string> | null>(null);

  const fetchBackendWorkspaceRoot = useCallback(async (): Promise<string> => {
    if (cachedBackendWorkspaceRef.current) return cachedBackendWorkspaceRef.current;
    if (pendingFetchRef.current) return pendingFetchRef.current;
    pendingFetchRef.current = (async () => {
      try {
        const res = await fetch(`${getApiBase()}/config/list`);
        if (!res.ok) {
          if (!workspaceRootErrorToastShown) {
            workspaceRootErrorToastShown = true;
            toast.error(t("settings.workspaceRootLoadError"));
          }
          return "";
        }
        const data = await res.json().catch(() => ({ __parseError: true } as const));
        if ((data as { __parseError?: boolean })?.__parseError) {
          if (!workspaceRootErrorToastShown) {
            workspaceRootErrorToastShown = true;
            toast.error(t("composer.responseParseFailed"));
          }
          return "";
        }
        const root = String((data?.workspace_root ?? data?.config?.workspace_root) || "").trim();
        if (root) {
          cachedBackendWorkspaceRef.current = root;
          setStorageItem("maibot_workspace_path", root);
        }
        return root;
      } catch {
        if (!workspaceRootErrorToastShown) {
          workspaceRootErrorToastShown = true;
          toast.error(t("settings.workspaceRootLoadError"));
        }
        return "";
      } finally {
        pendingFetchRef.current = null;
      }
    })();
    return pendingFetchRef.current;
  }, []);

  const resolveWorkspacePath = useCallback(
    async (editorWorkspacePath?: string): Promise<string> => {
      const fromEditor = String(editorWorkspacePath || "").trim();
      if (fromEditor) return fromEditor;

      const fromLocal = readLocalWorkspacePath();
      if (fromLocal) return fromLocal;

      const fromBackend = await fetchBackendWorkspaceRoot();
      return fromBackend;
    },
    [fetchBackendWorkspaceRoot]
  );

  return {
    resolveWorkspacePath,
  };
}

