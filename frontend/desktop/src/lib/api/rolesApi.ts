/**
 * 角色 API - 能力配置（Claude/Cursor 风格）
 * 对接后端 /roles/list、/roles/:id、/roles/:id/activate
 */

import { getApiBase, validServerThreadIdOrUndefined } from "./langserveChat";
import type { AgentProfile } from "./boardApi";

function parseErrorFromBody(data: unknown): string {
  if (data && typeof data === "object") {
    const d = data as { detail?: string; error?: string };
    if (typeof d.detail === "string") return d.detail;
    if (typeof d.error === "string") return d.error;
  }
  return "";
}

export interface RoleCapability {
  id: string;
  label: string;
  skill: string | null;
}

export interface RoleDefinition {
  id: string;
  label: string;
  icon: string;
  description: string;
  skill_profile: string;
  knowledge_scopes: string[];
  tools: string[];
  modes: string[];
  prompt_overlay: string | Record<string, unknown> | null;
  capabilities: RoleCapability[];
  suggested_questions: string[];
  is_custom?: boolean;
}

export const rolesApi = {
  async listRoles(): Promise<{ ok: boolean; roles: RoleDefinition[]; error?: string }> {
    try {
      const res = await fetch(`${getApiBase()}/roles/list`);
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) {
        return { ok: false, roles: [], error: "响应解析失败" };
      }
      const ok = (data as { ok?: boolean }).ok ?? (data as { success?: boolean }).success ?? res.ok;
      const rawRoles = (data as { roles?: unknown }).roles ?? (data as { data?: { roles?: unknown } }).data?.roles;
      const roles = Array.isArray(rawRoles)
        ? rawRoles
        : rawRoles && typeof rawRoles === "object" && !Array.isArray(rawRoles)
          ? Object.entries(rawRoles).map(([id, r]) => ({ id, ...(r as object) } as RoleDefinition))
          : [];
      const errMsg = parseErrorFromBody(data) || (data as { error?: string }).error || res.statusText;
      if (!res.ok || !ok) return { ok: false, roles, error: errMsg };
      return { ok: true, roles };
    } catch (e) {
      return { ok: false, roles: [], error: String(e) };
    }
  },

  async getRole(roleId: string): Promise<{ ok: boolean; role: RoleDefinition | null; error?: string }> {
    try {
      const res = await fetch(`${getApiBase()}/roles/${encodeURIComponent(roleId)}`);
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) {
        return { ok: false, role: null, error: "响应解析失败" };
      }
      if (!res.ok) {
        return { ok: false, role: null, error: parseErrorFromBody(data) || res.statusText };
      }
      const ok = (data as { ok?: boolean }).ok ?? (data as { success?: boolean }).success ?? true;
      if (!ok) return { ok: false, role: null, error: parseErrorFromBody(data) || (data as { error?: string }).error };
      return { ok: true, role: (data as { role?: RoleDefinition }).role ?? null };
    } catch (e) {
      return { ok: false, role: null, error: String(e) };
    }
  },

  async activateRole(
    roleId: string,
    options?: { threadId?: string }
  ): Promise<{ ok: boolean; profile: AgentProfile | null; error?: string }> {
    try {
      const threadId = validServerThreadIdOrUndefined(options?.threadId);
      const res = await fetch(`${getApiBase()}/roles/${encodeURIComponent(roleId)}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(threadId ? { thread_id: threadId } : {}),
      });
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) {
        return { ok: false, profile: null, error: "响应解析失败" };
      }
      if (!res.ok) {
        return { ok: false, profile: null, error: parseErrorFromBody(data) || res.statusText };
      }
      const ok = (data as { ok?: boolean }).ok ?? (data as { success?: boolean }).success ?? true;
      if (!ok) return { ok: false, profile: null, error: parseErrorFromBody(data) || (data as { error?: string }).error };
      return { ok: true, profile: (data as { profile?: AgentProfile }).profile ?? null };
    } catch (e) {
      return { ok: false, profile: null, error: String(e) };
    }
  },

  async reloadRoles(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${getApiBase()}/roles/reload`, { method: "POST" });
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if ((data as { __parseError?: boolean })?.__parseError) {
        return { ok: false, error: "响应解析失败" };
      }
      if (!res.ok) return { ok: false, error: parseErrorFromBody(data) || res.statusText };
      const ok = (data as { ok?: boolean }).ok ?? (data as { success?: boolean }).success ?? true;
      if (!ok) return { ok: false, error: parseErrorFromBody(data) || (data as { error?: string }).error };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
};
