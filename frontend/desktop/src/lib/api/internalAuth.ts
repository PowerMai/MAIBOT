/**
 * 内部 API 鉴权：与后端 INTERNAL_API_TOKEN 一致。
 * 用于需要 verify_internal_token 的接口（workspace/upload、knowledge/*、files/*、models/switch 等）。
 * 未配置 token 时返回空对象，后端在 loopback 下仍可放行。
 */
export function getInternalAuthHeaders(): Record<string, string> {
  const token =
    (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_INTERNAL_API_TOKEN) ||
    (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_LOCAL_AGENT_TOKEN) ||
    "";
  if (!token) return {};
  return {
    "X-Internal-Token": token,
    Authorization: `Bearer ${token}`,
  };
}
