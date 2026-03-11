/**
 * API 错误转用户可读中文提示
 * 用于聊天发送失败、线程操作、健康检查等场景的统一错误展示
 */

const USER_MESSAGES: Record<string, string> = {
  // 网络与连接
  'Failed to fetch': '网络错误：无法连接到后端服务，请确认服务已启动',
  'NetworkError': '网络错误：无法连接到后端服务',
  'Network request failed': '网络请求失败，请检查网络或后端地址',
  'APIConnectionError': '无法连接到模型服务。请确认：1) LangGraph 已启动（如 langgraph dev）；2) 设置中的 Base URL 正确；3) 模型 API（如 Ollama）已运行。',
  'Connection error': '无法连接到模型服务。请确认：1) LangGraph 已启动（如 langgraph dev）；2) 设置中的 Base URL 正确；3) 模型 API（如 Ollama）已运行。',
  '模型调用失败': '模型调用失败。请确认后端与模型服务已启动，并检查设置中的 Base URL。',
  'Load failed': '请求加载失败',
  'timeout': '请求超时，请稍后重试',
  'TimeoutError': '请求超时，请稍后重试',
  'AbortError': '', // 用户取消，不展示
  // 后端状态
  '503': '服务暂时不可用，请稍后重试',
  '502': '网关错误，请稍后重试',
  '500': '服务器错误，请稍后重试',
  '504': '网关超时，请稍后重试',
  '401': '未授权：请检查 LOCAL_AGENT_TOKEN 或登录状态',
  '403': '权限不足',
  '404': '资源未找到',
  '413': '内容过长，请精简后重试',
  '422': '参数校验失败，请检查输入',
  '429': '请求过于频繁，请稍后再试',
  'Service Unavailable': '服务暂时不可用，请稍后重试',
  'ECONNRESET': '连接被重置，请检查后端服务或网络后重试',
  // LangGraph / 流式
  'LangGraph': '对话服务状态异常，请刷新或新建会话后重试',
  'checkpoint': '会话检查点异常，请新建会话后重试',
  'run not found': '当前会话运行已结束或不存在，请新建会话后重试',
  'thread not found': '当前会话在后端不存在，请新建会话后重试',
  'state conflict': '会话状态冲突，请刷新页面或新建会话',
  'event-stream': '流式响应异常，请检查网络或稍后重试',
  // 业务文案
  '创建线程超时': '创建对话超时，请检查后端服务是否正常运行',
  '后端不可用': '后端不可用，请检查 LangGraph 服务是否已启动',
  '上传失败': '文件上传失败，请检查后端服务与网络',
  // 模型加载 / 资源不足（400 invalid_request_error）
  'Failed to load model': '当前模型加载失败（显存/内存不足）',
  'insufficient system resources': '系统资源不足，无法加载该模型',
  'model loading was stopped': '模型加载已中止（资源不足）',
};

/** 从错误对象或字符串中提取用户可读消息 */
export function formatApiErrorMessage(error: unknown): string {
  if (error == null) return '发生未知错误';

  const err = error instanceof Error ? error : new Error(String(error));
  const msg = (err.message || '').trim();
  const name = err.name || '';

  if (name === 'AbortError') return '';

  // 已知关键词匹配（数字状态码用词边界，避免 "port 5001" 误命中 "500"）
  for (const [key, userMsg] of Object.entries(USER_MESSAGES)) {
    if (!userMsg) continue;
    const keyMatch = /^\d+$/.test(key)
      ? new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(msg)
      : msg.includes(key);
    if (keyMatch || name === key) return userMsg;
  }

  // HTTP 状态码（message 中常带 "HTTP 503"、"429" 等）
  const statusMatch = msg.match(/\b(429|422|413|40\d|50\d)\b/);
  if (statusMatch) {
    const code = statusMatch[1];
    const mapped = USER_MESSAGES[code];
    if (mapped) return mapped;
    if (code.startsWith('5')) return '服务器错误，请稍后重试';
  }

  // 超时类
  if (/timeout|timed out|ETIMEDOUT/i.test(msg)) return USER_MESSAGES['timeout'];
  if (/ECONNRESET|connection reset/i.test(msg)) return USER_MESSAGES['ECONNRESET'];
  if (/Service Unavailable|503/i.test(msg)) return USER_MESSAGES['503'];

  // 模型加载失败 / 资源不足（400，如 qwen3.5-35b 需约 33GB）
  if (/failed to load model|insufficient system resources|model loading was stopped|invalid_request_error.*model/i.test(msg))
    return USER_MESSAGES['Failed to load model'];

  // LangGraph / 流式异常
  if (/run not found|thread not found|state conflict|event-stream/i.test(msg)) {
    const k = msg.includes('thread not found') ? 'thread not found' : msg.includes('run not found') ? 'run not found' : msg.includes('state conflict') ? 'state conflict' : 'event-stream';
    return USER_MESSAGES[k];
  }
  if (/LangGraph.*error|langgraph.*state/i.test(msg)) return USER_MESSAGES['LangGraph'];

  // 连接/网络类（含 API 模型连接；优先匹配长文案中的关键词）
  if (/模型调用失败|APIConnectionError|Connection error|connection error/i.test(msg) || /经过\s*\d+\s*次尝试.*连接错误/i.test(msg))
    return USER_MESSAGES['APIConnectionError'];
  if (/fetch|network|connection|ECONNREFUSED|ENOTFOUND/i.test(msg))
    return USER_MESSAGES['Failed to fetch'];

  // 短消息：仅保留像业务提示的原文，内部错误替换为通用提示
  if (msg.length <= 80) {
    const looksInternal = /TypeError|Cannot read|of null|undefined\s+is|Error:\s*\w|Exception\s*:|\bat\s+[\w./]+:\d+/i.test(msg);
    if (!looksInternal) return msg;
  }
  return '请求失败，请稍后重试';
}

/** 判断是否为用户取消（不需要弹 toast） */
export function isUserAbort(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  if (error && typeof (error as { name?: string }).name === 'string')
    return (error as { name: string }).name === 'AbortError';
  return false;
}
