/**
 * API 错误类型定义
 * 
 * 补充中文说明（详细说明，保留原注释）：
 * - 目的：为前端提供统一的 API 错误类型定义，包括未授权、权限不足、资源未找到和网络错误等常见错误类型。
 * - 架构设计：
 *   - 本模块定义自定义错误类，继承自 `Error`，提供统一的错误处理接口。
 *   - 每个错误类包含状态码和友好的中文错误消息。
 *   - 错误类用于在 API 客户端中统一错误处理和转换。
 * - 核心错误类型：
 *   - `UnauthorizedError`：未授权错误（401），默认消息为"未授权：请设置 LOCAL_AGENT_TOKEN"。
 *   - `ForbiddenError`：权限不足错误（403），默认消息为"权限不足：需要管理员密钥"。
 *   - `NotFoundError`：资源未找到错误（404），默认消息为"资源未找到"。
 *   - `NetworkError`：网络错误，默认消息为"网络错误：无法连接到后端服务"。
 * - 使用场景：
 *   - 在 API 客户端中，根据 HTTP 状态码转换为对应的错误类型。
 *   - 在错误处理中，使用错误类型进行统一的错误处理和提示。
 * - 设计原则：
 *   - 统一接口：提供统一的错误类型接口，便于错误处理。
 *   - 友好消息：提供友好的中文错误消息，提升用户体验。
 *   - 状态码：包含 HTTP 状态码，便于错误分类和处理。
 * 
 * 该补充注释用于增强文档，不改变模块的导出或行为。
 */

export class UnauthorizedError extends Error {
  status: number = 401;
  constructor(message: string = '未授权：请设置 LOCAL_AGENT_TOKEN') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  status: number = 403;
  constructor(message: string = '权限不足：需要管理员密钥') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends Error {
  status: number = 404;
  constructor(message: string = '资源未找到') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class NetworkError extends Error {
  constructor(message: string = '网络错误：无法连接到后端服务') {
    super(message);
    this.name = 'NetworkError';
  }
}

export class ServiceUnavailableError extends Error {
  status: number = 503;
  service?: string;
  code?: string;
  traceId?: string;
  
  constructor(
    message: string = '服务暂时不可用，请稍后重试',
    service?: string,
    code?: string,
    traceId?: string
  ) {
    super(message);
    this.name = 'ServiceUnavailableError';
    this.service = service;
    this.code = code;
    this.traceId = traceId;
  }
}

