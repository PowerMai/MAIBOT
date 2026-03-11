# 聊天流式回复业务流程（简化）

## 1. 端到端链路

```
用户输入 → 前端发消息(config.model=选中模型) → 后端 deepagent_node
  → get_agent(config) 内 model_manager.get_model_for_thread(config) 得到实际模型
  → create_llm → agent.astream() → LLM 流式输出
  → TokenStreamHandler.on_llm_new_token → _flush_run → writer(messages_partial + reasoning)
  → SSE 推给前端 → 前端 yield messages/partial、reasoning → SDK 累积 → 界面展示
```

## 2. 关键点

- **模型**：请求里的 `config.model` / `config.model_id` 在后端 `get_model_for_thread()` 中优先使用，选哪个就走哪个。
- **首包**：后端在「首 token」时 force flush；首包慢多为 get_agent() 准备耗时或云端 API 首 token 延迟。
- **前端**：云端模型首次需用户确认一次，确认结果存本地，同一条流重试不再弹窗。

## 3. 排查「无回复/慢」时看什么

- 后端日志：`LLM 首 token 回调已触发` → 说明 LLM 已开始流式输出。
- 后端日志：`DeepAgent 引擎已就绪` 与首 token 之间的间隔 → 多为 get_agent 或首 token 延迟。
- 前端：若出现「用户取消云端模型调用」且未点取消 → 多为 HMR 或确认弹窗被关导致 resolve(false)。
