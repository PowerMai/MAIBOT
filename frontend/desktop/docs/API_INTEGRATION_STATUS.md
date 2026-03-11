# API 集成状态

## 后端接口对接情况

### 已完成对接 ✅

| 前端 API | 后端路由 | 状态 | 说明 |
|---------|---------|------|------|
| `chatAPI.chat` | `/control/chat` | ✅ | 主聊天接口 |
| `runsAPI.subscribe` | `/runs/{id}/stream` | ✅ | SSE 流式订阅 |
| `runsAPI.list` | `/runs/list` | ✅ | 运行列表 |
| `runsAPI.get` | `/runs/{id}` | ✅ | 运行详情 |
| `teachcardsAPI.list` | `/teachcards/list` | ✅ | 教卡列表 |
| `teachcardsAPI.register` | `/teachcards/register` | ✅ | 教卡注册 |
| `teachcardsAPI.run` | `/teachcards/{id}/run` | ✅ | 运行教卡 |
| `runtimeAPI.queueStats` | `/runtime/queue/stats` | ✅ | 队列统计 |
| `runtimeAPI.workers` | `/runtime/workers` | ✅ | Worker 状态 |
| `telemetryAPI.health` | `/telemetry/health` | ✅ | 系统健康 |
| `envAPI.reload` | `/env/reload` | ✅ | 环境配置 |
| `searchAPI.search` | `/control/search` | ✅ | 文档搜索 |
| `docMapAPI.ingestFiles` | `/docmap/bulk_upsert` | ✅ | 文档导入 |
| `kmAPI.importInline` | `/km/import/inline` | ✅ | 知识导入 |

### 教卡显示逻辑

**策略：只显示对外可见的注册教卡**

```typescript
// 内部教卡关键词（不对外展示）
const INTERNAL_KEYWORDS = [
  'core.', 'builtin.', 'internal.', 'base.', 
  'office', 'system.', 'debug.', '_test',
];
```

当前外部可见教卡：
- `tender-master` - 招投标大师

---

## 前端上下文传递

### HTTP Headers

| Header | 说明 | 示例 |
|--------|------|------|
| `X-Session-Id` | 会话 ID | `sess_1732739127` |
| `X-Workspace-Domain` | 工作区领域 | `tender`, `general` |
| `X-View-Type` | 当前视图 | `editor`, `dashboard` |
| `X-Document-Type` | 文档类型 | `markdown`, `pdf` |
| `X-Teachcard-Ids` | 激活教卡 | `tender-master` |
| `X-Has-Selection` | 有选中内容 | `true`, `false` |

### 请求体上下文

```json
{
  "message": "用户消息",
  "context": {
    "workspace": { "domain": "tender", "teachcardIds": ["tender-master"] },
    "document": { "type": "markdown", "name": "投标方案.md" },
    "editor": { "selection": { "text": "选中的文本" } },
    "intent": { "primary": "edit" }
  }
}
```

---

## 插件系统

### 已注册插件

| 插件 ID | 名称 | 激活条件 |
|---------|------|----------|
| `core.writing` | 智能写作 | 始终激活 |
| `core.analysis` | 文档分析 | 始终激活 |
| `domain.tender` | 招投标助手 | `domain === 'tender'` |

### 插件功能

**智能写作**
- 润色文字
- 扩写内容
- 精简内容
- 续写
- 智能纠错
- 翻译
- 生成大纲

**招投标助手**（仅招投标领域）
- 要求检查
- 风险检测
- 生成投标文件

---

## 后端待开发接口

| 功能 | 接口 | 状态 |
|------|------|------|
| 工作区领域检测 | `/workspace/detect` | 待开发 |
| 教卡能力执行 | `/teachcards/{id}/actions/{action}` | 待开发 |
| 用户偏好同步 | `/user/preferences` | 待开发 |

---

## 更新记录

- 2024-11-27: 初始版本，完成核心接口对接


