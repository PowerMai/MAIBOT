# API 回归清单（2026-02）

本清单用于验收本轮新增能力：

- 执行追踪（LangSmith 优先，local 回退）
- LangSmith 状态检查
- Skill 质量反馈统计
- 分类记忆工具封装

建议环境变量：

```bash
export BASE_URL="http://127.0.0.1:8000"
```

---

## 1) LangSmith 状态接口

### 请求（LangSmith 状态）

```bash
curl -s "$BASE_URL/observability/langsmith/status" | jq
```

### 通过标准（LangSmith 状态）

- 返回 `ok: true`
- 包含字段：`enabled / has_api_key / tracing_v2 / project / endpoint`

### 典型响应（未配置 key）

```json
{
  "ok": true,
  "enabled": false,
  "has_api_key": false,
  "tracing_v2": false,
  "project": "maibot",
  "endpoint": "https://api.smith.langchain.com",
  "message": "LangSmith tracing 未启用（需 LANGSMITH_API_KEY + LANGCHAIN_TRACING_V2=true）"
}
```

---

## 2) 统一执行追踪接口

### 请求（统一执行追踪）

```bash
curl -s "$BASE_URL/execution-trace?thread_id=smoke-thread&limit=5" | jq
```

### 通过标准（统一执行追踪）

- 返回 `ok: true`
- `preferred` 为 `langsmith` 或 `local`
- `logs` 为数组（可为空）
- `langsmith` 字段存在并可反映当前可观测性状态

### 回退策略验证

- 未配置 LangSmith 时，`preferred` 应为 `local`
- 配置 `LANGSMITH_API_KEY` + `LANGCHAIN_TRACING_V2=true` 后，应优先为 `langsmith`

---

## 3) Skill 反馈写入与统计

### 3.1 写入反馈

```bash
curl -s -X POST "$BASE_URL/learning/skill-feedback" \
  -H "Content-Type: application/json" \
  -d '{
    "skill_name":"regression-skill",
    "was_helpful": true,
    "score": 2,
    "note":"manual regression"
  }' | jq
```

通过标准：

- 返回 `ok: true`
- 返回体包含 `skill.total / skill.positive / skill.negative`

### 3.2 读取统计

```bash
curl -s "$BASE_URL/learning/skill-feedback/stats?limit=10" | jq
```

通过标准：

- 返回 `ok: true`
- `items` 为数组
- 每个 item 含 `skill_name / total / positive_rate / avg_score`

---

## 4) 分类记忆工具（运行时行为）

工具名：

- `manage_memory_with_category`
- `search_memory_by_category`

### 运行时约束

这两个工具必须在 LangGraph Agent 运行时调用（需要 runtime store）。  
如果在独立脚本里直接 `invoke`，应返回明确错误而不是抛异常：

```json
{
  "ok": false,
  "error": "manage_memory_with_category must run inside LangGraph agent runtime"
}
```

### 通过标准（分类记忆工具）

- Agent 内调用：可正常写入/检索（带 `[category:<name>]` 标签）
- Agent 外调用：返回可解释错误 JSON，不出现未处理异常

---

## 5) 前端回归点（Settings）

页面：`设置 -> 高级`

核对项：

1. **执行日志卡**：优先使用统一追踪接口，显示追踪来源（LangSmith/本地回退）
2. **LangSmith 状态卡**：可显示 enabled、API key、tracing_v2、project
3. **Skill 反馈统计卡**：可拉取并展示 top 统计列表
4. **API Key 管理**：可本地保存/清除
5. **工具启停**：开关持久化到 `maibot_tool_toggles`

---

## 6) 冒烟命令（一次性）

```bash
curl -s "$BASE_URL/observability/langsmith/status" >/dev/null && echo "langsmith status ok"
curl -s "$BASE_URL/execution-trace?thread_id=smoke-thread&limit=1" >/dev/null && echo "execution trace ok"
curl -s -X POST "$BASE_URL/learning/skill-feedback" -H "Content-Type: application/json" -d '{"skill_name":"smoke","was_helpful":true,"score":1}' >/dev/null && echo "skill feedback write ok"
curl -s "$BASE_URL/learning/skill-feedback/stats?limit=1" >/dev/null && echo "skill feedback stats ok"
```

---

## 7) 判定结论模板

可直接复用：

```text
[PASS] /observability/langsmith/status
[PASS] /execution-trace (preferred=local|langsmith)
[PASS] /learning/skill-feedback (write)
[PASS] /learning/skill-feedback/stats (read)
[PASS] Settings/高级 三张卡片可见且可刷新
[PASS] 分类记忆工具运行时约束行为符合预期
```
