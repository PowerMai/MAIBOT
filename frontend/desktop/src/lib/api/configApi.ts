import { getApiBase } from "./langserveChat";

type ConfigListItem = {
  key: string;
  path: string;
  exists: boolean;
  size?: number;
  updated_at?: string | null;
};

async function checkOk<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({} as T));
  if (!res.ok || (data as any)?.ok === false) {
    throw new Error((data as any)?.detail || (data as any)?.error || res.statusText || "请求失败");
  }
  return data as T;
}

export const configApi = {
  async list(): Promise<{ ok: boolean; workspace_root?: string; maibot_dir?: string; files: ConfigListItem[] }> {
    const res = await fetch(`${getApiBase()}/config/list`);
    return checkOk(res);
  },

  async read(key: string): Promise<{ ok: boolean; key: string; path: string; exists: boolean; content: string }> {
    const res = await fetch(`${getApiBase()}/config/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    return checkOk(res);
  },

  async write(key: string, content: string): Promise<{ ok: boolean; key: string; path: string; size?: number; updated_at?: string }> {
    const res = await fetch(`${getApiBase()}/config/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, content }),
    });
    return checkOk(res);
  },
};

