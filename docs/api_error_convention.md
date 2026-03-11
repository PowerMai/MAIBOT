# API 错误响应约定

与 [p2_observability_and_traceability_contract.md](p2_observability_and_traceability_contract.md) 第 4 节一致，本文档明确何时使用 HTTP 状态码 4xx/5xx 与何时使用 200 + 业务错误体，以及统一 body 形状，便于前端与调用方统一处理。

## 1. 两种错误形态

| 形态 | 适用场景 | 前端处理 |
|------|----------|----------|
| **4xx/5xx + body** | 请求非法、鉴权失败、服务端异常等「硬错误」 | 看 `response.ok` 为 false，body 通常为 `{"detail": "...", "request_id": "..."}` |
| **200 + ok: false** | 业务逻辑失败但 HTTP 语义成功（如列表查询时 Store 不可用、部分子接口失败） | 先看 `body.ok`，为 false 时按错误处理，body 含 `error` 或 `detail` |

新接口**优先使用 4xx/5xx** 表示错误，便于监控与网关统一处理；仅在「需与成功响应同结构、仅用 ok 区分」时使用 200+ok:false。

## 2. 统一 body 形状

### 2.1 4xx/5xx 响应（由 FastAPI 全局或 HTTPException 返回）

- **状态码**：400/403/404/422/500/503 等。
- **body**：`{"detail": "<message>", "request_id": "<uuid>"}`（非开发环境 detail 可能收敛为「内部服务器错误」）。
- **请求体验证 422**：FastAPI 默认形状为 `{"detail": [{"loc": [...], "msg": "...", "type": "..."}]}`；若需与前端约定统一结构，可注册自定义 `RequestValidationError` 处理器。

### 2.2 200 + 业务错误

- **body**：至少包含 `"ok": false` 与 `"error": "<message>"`（或部分接口用 `"detail"`）；成功时可选 `"ok": true` 或省略。
- **示例**：`GET /system/info` 在依赖不可用时返回 `{"ok": false, "error": "psutil not installed", ...}`；列表类接口在异常时若保留 200，应返回 `{"ok": false, "tasks": [], "next_cursor": null, "error": "..."}`。当前 Board 列表已改为异常时抛 5xx，与多数端点一致。

## 3. 前端消费约定

- 先根据 `response.ok` 判断是否为 HTTP 错误；再若 `response.ok` 为 true，解析 JSON 后检查 `data?.ok === false`，避免将业务错误当成功处理。
- 错误信息展示优先取 `body.detail` 或 `body.error`，`request_id` 可用于日志与排查。

## 4. 200+ok:false 迁移清单（联调阶段）

以下接口在异常时仍返回 HTTP 200 + body 含 `ok: false` 或 `success: false`，计划分批迁移为 4xx/5xx，便于监控与前端统一处理。

| 接口 | 当前异常形态 | 迁移计划 |
|------|--------------|----------|
| GET /workspace/list | 200 + `{"ok": false, "items": [], "error": "..."}` | 已迁移：异常时改为 500 + detail |
| GET /suggestions/work | 200 + `{"success": false, "error": "...", "suggestions": []}` | 已迁移：异常时改为 500 + detail |
| GET /system/info | 200 + `{"ok": false, "error": "psutil not installed", ...}` | 待迁移：可选改为 503 |
| GET/POST 技能/角色/档案/看板等 | 多处 200 + `{"ok": false, "error": "..."}` | 后续迭代按流量与前端消费顺序迁移 |

**新接口**：一律使用 4xx/5xx 表示错误，body 形状见 §2.1。前端消费时先根据 `response.ok` 判断，再解析 body.detail 或 body.error。

## 5. 参考

- [p2_observability_and_traceability_contract.md](p2_observability_and_traceability_contract.md) 第 4 节
- 后端 `_safe_error_detail`（非开发环境收敛 detail，避免泄露内部异常）
