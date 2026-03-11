import { getApiBase } from "./langserveChat";

export type UserProfileDto = {
  expertise_areas?: Record<string, string>;
  communication_style?: string;
  detail_level?: string;
  domain_expertise?: string;
  decision_patterns?: string[];
  unsolved_intents?: Record<string, unknown>[];
  learning_trajectory?: string[];
  custom_rules?: string[];
  ai_leverage_score?: number;
  iteration_patterns?: number[];
  tool_breadth?: number;
  last_updated?: string | null;
};

export type UserModelResponse = {
  ok: boolean;
  profile: UserProfileDto | null;
  error?: string;
};

async function checkOk<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({} as T));
  if (!res.ok || (data as { ok?: boolean })?.ok === false) {
    throw new Error(
      (data as { detail?: string; error?: string })?.detail ||
        (data as { detail?: string; error?: string })?.error ||
        res.statusText ||
        "请求失败"
    );
  }
  return data as T;
}

export const userModelApi = {
  async get(workspaceId?: string): Promise<UserModelResponse> {
    const qs = workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : "";
    const res = await fetch(`${getApiBase()}/agent/user-model${qs}`);
    return checkOk<UserModelResponse>(res);
  },

  async put(updates: Partial<UserProfileDto>, workspaceId?: string): Promise<UserModelResponse> {
    const qs = workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : "";
    const res = await fetch(`${getApiBase()}/agent/user-model${qs}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    return checkOk<UserModelResponse>(res);
  },
};
