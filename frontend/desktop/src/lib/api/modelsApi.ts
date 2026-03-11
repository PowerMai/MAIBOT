import { getApiBase } from "./langserveChat";
import { getInternalAuthHeaders } from "./internalAuth";

function internalAuthHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", ...getInternalAuthHeaders() };
}

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
        if (typeof import.meta !== "undefined" && import.meta.env?.DEV) console.warn("[modelsApi] res.text() failed:", e);
      }
      throw new Error(msg || "请求失败");
    }
    throw new Error("请求失败");
  }
  if (!res.ok) {
    const msg =
      (typeof (data as any)?.detail === "string"
        ? (data as any).detail
        : (data as any)?.error) || res.statusText;
    throw new Error(msg || "请求失败");
  }
  if (data && typeof data === "object" && (data as { ok?: boolean }).ok === false) {
    const msg =
      (data as { error?: string }).error ?? (data as { detail?: string }).detail ?? "请求失败";
    throw new Error(msg);
  }
  return data as T;
}

export interface ModelListItem {
  id: string;
  name: string;
  description?: string;
  url?: string;
  provider?: string;
  enabled?: boolean;
  available?: boolean;
  is_default?: boolean;
  is_current?: boolean;
  tier?: string;
  context_length?: number;
  config?: Record<string, unknown>;
  api_key_env?: string;
  has_api_key?: boolean;
  capability?: Record<string, unknown>;
  role_affinity?: Record<string, number>;
  cost_level?: string;
  is_reasoning_model?: boolean;
  /** 来源：config=配置，discovered=云端发现（用于设置页展示） */
  source?: "config" | "discovered";
}

export interface CapabilityModelStatus {
  id?: string | null;
  enabled?: boolean;
  available?: boolean;
  provider_ready?: boolean;
  base_url?: string | null;
}

export interface ModelAddBody {
  id: string;
  name: string;
  provider?: string;
  url?: string;
  description?: string;
  enabled?: boolean;
  priority?: number;
  context_length?: number;
  config?: Record<string, unknown>;
  api_key?: string;
  api_key_env?: string;
  tier?: string;
  cost_level?: string;
  is_reasoning_model?: boolean;
  capability?: Record<string, unknown>;
  role_affinity?: Record<string, number>;
}

export interface ModelUpdateBody {
  name?: string;
  provider?: string;
  url?: string;
  description?: string;
  enabled?: boolean;
  priority?: number;
  context_length?: number;
  config?: Record<string, unknown>;
  api_key?: string;
  api_key_env?: string;
  tier?: string;
  cost_level?: string;
  is_reasoning_model?: boolean;
  capability?: Record<string, unknown>;
  role_affinity?: Record<string, number>;
}

/** 与后端 /models/list 返回结构一致 */
export interface ModelsListResponse {
  ok: boolean;
  models: ModelListItem[];
  default_model?: string;
  current_model?: string;
  capability_models?: {
    embedding?: CapabilityModelStatus;
    rerank?: CapabilityModelStatus;
    [k: string]: CapabilityModelStatus | undefined;
  };
  subagent_model?: string;
  subagent_model_mapping?: Record<string, string>;
}

export const modelsApi = {
  async list(): Promise<ModelsListResponse> {
    const res = await fetch(`${getApiBase()}/models/list`);
    return checkOk(res, () => res.json());
  },

  async status(): Promise<{ ok: boolean; current_model?: string; status?: Record<string, unknown> }> {
    const res = await fetch(`${getApiBase()}/models/status`);
    return checkOk(res, () => res.json());
  },

  async refresh(): Promise<{
    ok: boolean;
    models: ModelListItem[];
    message?: string;
    capability_models?: {
      embedding?: CapabilityModelStatus;
      rerank?: CapabilityModelStatus;
    };
  }> {
    const res = await fetch(`${getApiBase()}/models/refresh`, { method: "POST" });
    return checkOk(res, () => res.json());
  },

  async switch(model_id: string): Promise<{ ok: boolean; current_model?: string; model?: ModelListItem }> {
    const res = await fetch(`${getApiBase()}/models/switch`, {
      method: "POST",
      headers: internalAuthHeaders(),
      body: JSON.stringify({ model_id }),
    });
    return checkOk(res, () => res.json());
  },

  /** 设置默认模型并持久化到后端 models.json，重启后仍生效 */
  async setDefaultModel(default_model: string): Promise<{ ok: boolean; default_model?: string; error?: string }> {
    const res = await fetch(`${getApiBase()}/models/default`, {
      method: "PUT",
      headers: internalAuthHeaders(),
      body: JSON.stringify({ default_model }),
    });
    return checkOk(res, () => res.json());
  },

  async configs(): Promise<{ ok: boolean; configs: Record<string, unknown> }> {
    const res = await fetch(`${getApiBase()}/models/configs`);
    return checkOk(res, () => res.json());
  },

  async recommend(roleId: string): Promise<{ ok: boolean; role_id: string; recommendations: ModelListItem[] }> {
    const res = await fetch(`${getApiBase()}/models/recommend?role_id=${encodeURIComponent(roleId)}`);
    return checkOk(res, () => res.json());
  },

  async add(body: ModelAddBody): Promise<{ ok: boolean; model?: { id: string; name: string } }> {
    const res = await fetch(`${getApiBase()}/models/add`, {
      method: "POST",
      headers: internalAuthHeaders(),
      body: JSON.stringify(body),
    });
    return checkOk(res, () => res.json());
  },

  async update(modelId: string, body: ModelUpdateBody): Promise<{ ok: boolean; model?: { id: string; name: string } }> {
    const res = await fetch(`${getApiBase()}/models/${encodeURIComponent(modelId)}`, {
      method: "PUT",
      headers: internalAuthHeaders(),
      body: JSON.stringify(body),
    });
    return checkOk(res, () => res.json());
  },

  async remove(modelId: string): Promise<{ ok: boolean; message?: string }> {
    const res = await fetch(`${getApiBase()}/models/${encodeURIComponent(modelId)}`, {
      method: "DELETE",
      headers: internalAuthHeaders(),
    });
    return checkOk(res, () => res.json());
  },

  /** 云端端点：配置后自动 GET /v1/models 发现模型并加入可用列表；endpoints_with_models 含每端点下的模型 id 与 Key 是否可用 */
  async getCloudEndpoints(): Promise<{
    ok: boolean;
    cloud_endpoints: Array<{ base_url: string; api_key_env: string }>;
    endpoints_with_models?: Array<{ base_url: string; api_key_env: string; has_key: boolean; model_ids: string[] }>;
  }> {
    const res = await fetch(`${getApiBase()}/models/cloud-endpoints`, { headers: internalAuthHeaders() });
    return checkOk(res, () => res.json());
  },

  async updateCloudEndpoints(cloud_endpoints: Array<{ base_url: string; api_key_env: string }>): Promise<{ ok: boolean; discovered: number }> {
    const res = await fetch(`${getApiBase()}/models/cloud-endpoints`, {
      method: "PUT",
      headers: internalAuthHeaders(),
      body: JSON.stringify({ cloud_endpoints }),
    });
    return checkOk(res, () => res.json());
  },

  async refreshCloud(): Promise<{ ok: boolean; discovered: number }> {
    const res = await fetch(`${getApiBase()}/models/refresh-cloud`, {
      method: "POST",
      headers: internalAuthHeaders(),
    });
    return checkOk(res, () => res.json());
  },
};

