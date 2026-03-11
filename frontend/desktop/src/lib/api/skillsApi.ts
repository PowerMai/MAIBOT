/**
 * Skills 管理 API
 * 对接后端 /skills/list、/skills/profiles、/skills/by-profile、/skills/generate-draft
 */

import { getApiBase, validServerThreadIdOrUndefined } from "./langserveChat";
import { createApiRequestError, handleSkillApiError } from "./errorHandler";

async function checkOk<T>(res: Response, parse: () => Promise<T>): Promise<T> {
  let data: T;
  try {
    data = await parse();
  } catch {
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const text = await res.text();
        if (text) msg = text;
      } catch (e) {
        if (typeof import.meta !== "undefined" && import.meta.env?.DEV) console.warn("[skillsApi] res.text() failed:", e);
      }
      throw createApiRequestError(msg || "请求失败", res.status);
    }
    throw createApiRequestError("请求失败", res.status);
  }
  if (!res.ok) {
    const msg =
      (typeof (data as any)?.detail === "string"
        ? (data as any).detail
        : (data as any)?.error) || res.statusText;
    throw createApiRequestError(msg || "请求失败", res.status);
  }
  if (data && typeof data === "object" && (data as { ok?: boolean }).ok === false) {
    const msg =
      (data as { error?: string }).error ?? (data as { detail?: string }).detail ?? "请求失败";
    throw createApiRequestError(msg, res.status);
  }
  return data as T;
}

export interface SkillProfile {
  id: string;
  label: string;
  description: string;
  capabilities_summary?: string;
}

export interface SkillItem {
  name: string;
  display_name?: string;
  description: string;
  level?: string;
  domain?: string;
  /** 技能来源：anthropic=官方, custom=内置, learned=学习沉淀 */
  source?: "anthropic" | "custom" | "learned" | string;
  source_type?: "local" | "remote";
  market_id?: string | null;
  installed_version?: string | null;
  relative_path?: string;
  skill_dir?: string;
  path?: string;
  kb_relative_path?: string;
  quality_gate_tier?: "core" | "pro" | "enterprise" | "community" | string;
  quality_gate_required?: string[];
  quality_gate_missing?: string[];
  quality_gate_passed?: boolean;
  quality_gate_hint?: string;
}

export interface SkillTrialItem {
  id: string;
  name?: string;
  domain?: string;
  path?: string;
  relative_path?: string;
  market_id?: string | null;
  version?: string | null;
  created_at?: string;
  expires_at?: string;
  promoted?: boolean;
  cleaned?: boolean;
  status?: "active" | "expired" | "promoted" | "cleaned" | string;
}

export interface SkillDemoRunResult {
  title: string;
  left_title: string;
  right_title: string;
  left: string;
  right: string;
  sample_input?: string;
  metrics?: Array<{ label: string; baseline: number; skill: number }>;
}

export const skillsAPI = {
  async getProfiles(): Promise<{ ok: boolean; profiles: SkillProfile[] }> {
    const res = await fetch(`${getApiBase()}/skills/profiles`);
    return checkOk(res, () => res.json());
  },

  async getSkillsByProfile(profileId: string): Promise<{
    ok: boolean;
    skills: SkillItem[];
    total: number;
    profile_id?: string;
  }> {
    const res = await fetch(
      `${getApiBase()}/skills/by-profile?profile_id=${encodeURIComponent(profileId)}`
    );
    return checkOk(res, () => res.json());
  },

  async getAllSkills(): Promise<{ ok: boolean; skills: SkillItem[]; total: number }> {
    const res = await fetch(`${getApiBase()}/skills/list`);
    return checkOk(res, () => res.json());
  },

  async generateDraft(body: {
    name: string;
    description?: string;
    steps_summary?: string;
    thread_id?: string;
  }): Promise<{
    ok: boolean;
    path?: string;
    relative_path?: string;
    message?: string;
  }> {
    const payload = { ...body };
    const tid = validServerThreadIdOrUndefined(payload.thread_id);
    if (tid != null) payload.thread_id = tid;
    else if (payload.thread_id != null) delete payload.thread_id;
    const res = await fetch(`${getApiBase()}/skills/generate-draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return checkOk(res, () => res.json());
  },

  async createSkill(body: {
    name: string;
    domain?: string;
    description?: string;
    content?: string;
  }): Promise<{ ok: boolean; path?: string; relative_path?: string }> {
    const res = await fetch(`${getApiBase()}/skills/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return checkOk(res, () => res.json());
  },

  async updateSkill(body: { path?: string; relative_path?: string; content: string }): Promise<{ ok: boolean; path?: string }> {
    const res = await fetch(`${getApiBase()}/skills/update`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return checkOk(res, () => res.json());
  },

  async deleteSkill(params: { path?: string; relative_path?: string }): Promise<{ ok: boolean; deleted?: string }> {
    const q = new URLSearchParams();
    if (params.path) q.set("path", params.path);
    if (params.relative_path) q.set("relative_path", params.relative_path);
    const res = await fetch(`${getApiBase()}/skills/delete?${q.toString()}`, { method: "DELETE" });
    return checkOk(res, () => res.json());
  },

  async importSkill(body: { source_path?: string; domain?: string }): Promise<{ ok: boolean; path?: string; message?: string }> {
    const res = await fetch(`${getApiBase()}/skills/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return checkOk(res, () => res.json());
  },

  async importSkillZip(file: File, domain?: string): Promise<{ ok: boolean; path?: string; message?: string }> {
    const form = new FormData();
    form.append("file", file);
    if (domain) form.append("domain", domain);
    const res = await fetch(`${getApiBase()}/skills/import`, {
      method: "POST",
      body: form,
    });
    return checkOk(res, () => res.json());
  },

  /** 市场：浏览云端 Skills（按领域）。若后端未实现该接口（404）则降级返回空列表。 */
  async getMarketSkills(domain?: string): Promise<{ ok: boolean; skills: MarketSkillItem[]; total: number; source_type?: string }> {
    const q = domain ? `?domain=${encodeURIComponent(domain)}` : "";
    try {
      const res = await fetch(`${getApiBase()}/skills/market${q}`);
      if (res.status === 404) return { ok: true, skills: [], total: 0 };
      return checkOk(res, () => res.json());
    } catch {
      return { ok: true, skills: [], total: 0 };
    }
  },

  /** 市场：安装 Skill（content 或 url）；version/market_id 用于记录已装版本便于检查更新 */
  async installFromMarket(body: {
    name?: string;
    domain?: string;
    content?: string;
    url?: string;
    market_id?: string;
    version?: string;
  }): Promise<{ ok: boolean; path?: string; relative_path?: string; message?: string }> {
    try {
      const res = await fetch(`${getApiBase()}/skills/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return checkOk(res, () => res.json());
    } catch (error) {
      throw handleSkillApiError(error);
    }
  },

  /** 检查已安装 Skill 是否有市场更新；builtin_by_source 为内置技能按来源区分（官方/内置/学习）。 */
  async checkUpdates(): Promise<{
    ok: boolean;
    updates: SkillUpdateItem[];
    total: number;
    builtin_total?: number;
    builtin_by_source?: { official: number; builtin: number; learned: number };
  }> {
    const res = await fetch(`${getApiBase()}/skills/check-updates`);
    return checkOk(res, () => res.json());
  },

  /** 获取全局禁用的技能列表（domain/name）。 */
  async getDisabledSkills(): Promise<{ ok: boolean; disabled: string[] }> {
    const res = await fetch(`${getApiBase()}/skills/disabled`);
    return checkOk(res, () => res.json());
  },

  /** 设置全局禁用的技能列表（domain/name）；空数组表示全部启用。 */
  async patchDisabledSkills(disabled: string[]): Promise<{ ok: boolean; disabled: string[] }> {
    const res = await fetch(`${getApiBase()}/skills/disabled`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: disabled ?? [] }),
    });
    return checkOk(res, () => res.json());
  },

  /** 批量增量更新（按检查结果更新，limit 控制本次最大更新数） */
  async updateAll(limit: number = 20): Promise<{
    ok: boolean;
    checked_total: number;
    targeted: number;
    updated: Array<{ name?: string; domain?: string; relative_path?: string; market_version?: string }>;
    failed: Array<{ name?: string; domain?: string; url?: string; error?: string }>;
    updated_count: number;
    failed_count: number;
  }> {
    const res = await fetch(`${getApiBase()}/skills/update-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit }),
    });
    return checkOk(res, () => res.json());
  },

  async listTrials(): Promise<{
    ok: boolean;
    trials: SkillTrialItem[];
    total: number;
    limits?: {
      window_days: number;
      max_trials: number;
      used_in_window: number;
      remaining: number;
    };
  }> {
    const res = await fetch(`${getApiBase()}/skills/trial`);
    return checkOk(res, () => res.json());
  },

  async createTrial(body: {
    name?: string;
    domain?: string;
    content?: string;
    url?: string;
    market_id?: string;
    version?: string;
  }): Promise<{ ok: boolean; trial?: SkillTrialItem; limits?: Record<string, unknown> }> {
    try {
      const res = await fetch(`${getApiBase()}/skills/trial`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return checkOk(res, () => res.json());
    } catch (error) {
      throw handleSkillApiError(error);
    }
  },

  async promoteTrial(trialId: string): Promise<{ ok: boolean; trial?: SkillTrialItem }> {
    const res = await fetch(`${getApiBase()}/skills/trial/${encodeURIComponent(trialId)}/promote`, {
      method: "POST",
    });
    return checkOk(res, () => res.json());
  },

  async cleanupTrial(trialId: string): Promise<{ ok: boolean; trial?: SkillTrialItem }> {
    const res = await fetch(`${getApiBase()}/skills/trial/${encodeURIComponent(trialId)}`, {
      method: "DELETE",
    });
    return checkOk(res, () => res.json());
  },

  async demoRun(body: {
    market_id?: string;
    name?: string;
    domain?: string;
    user_query?: string;
  }): Promise<{ ok: boolean; comparison: SkillDemoRunResult }> {
    const res = await fetch(`${getApiBase()}/skills/demo-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return checkOk(res, () => res.json());
  },
};

export interface SkillUpdateItem {
  name: string;
  domain: string;
  path?: string;
  relative_path?: string;
  current_version: string | null;
  market_version: string;
  market_id: string | null;
  url: string;
}

export interface MarketSkillItem {
  id?: string;
  name: string;
  domain?: string;
  description?: string;
  preview?: string;
  preview_output?: string;
  version?: string;
  url?: string;
  source_type?: string;
  requires_tier?: "free" | "pro" | "enterprise" | "community" | string;
  quality_gate_tier?: "core" | "pro" | "enterprise" | "community" | string;
  quality_gate_required?: string[];
  quality_gate_missing?: string[];
  quality_gate_passed?: boolean;
  quality_gate_hint?: string;
}
