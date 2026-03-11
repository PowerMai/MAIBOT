# 思考过程展示与 Explore 子代理说明

## 思考过程（聊天页是否能看到）

### 当前实现

- **有思考过程**：后端在规划/推理时会调用 `think_tool`（或 `extended_thinking`），前端会对应展示。
- **展示位置**：
  - **ThinkToolUI**：对应工具名 `think_tool`，展示 `args.thinking` 的文本；支持「目标/发现/缺失/决策」等结构以及 Debug 的「假设-验证-根因」解析。
  - **ExtendedThinkingToolUI**：对应工具名 `extended_thinking`，展示问题/约束/方法/推理/结论等分步内容。
- **为何有时看不到**：
  1. 模型没有调用 `think_tool` / `extended_thinking`（取决于提示与路由）。
  2. 调用时 `thinking` 内容为空或未传入。
  3. 流式消息里该工具调用未正确下发或未解析到前端。

思考内容应是有价值的推理（例如目标、发现、决策），而不是对用户提示的简单复述；若后端只做复述，应改提示词让模型产出真实推理再传入 `think_tool`。

**让思考更常出现**：在规划/复杂任务节点或 Orchestrator 的 system prompt 中明确要求「先调用 think_tool 写出推理再执行」，并保证流式结果里包含该工具调用，前端即可稳定展示。

---

## Explore 子代理（explore-subagent）

### 在本系统中的实现

- **实现方式**：与 Claude/DeepAgent 一致，以 **SubAgent** 形式存在。
- **配置位置**：`backend/engine/agent/deep_agent.py` 中 `create_subagent_configs` 的 **explore-agent**。
- **职责**：文件搜索与信息收集（只读），工具包括 `duckduckgo_search`、`shell_run` 等（EXPLORE_TOOLS）。
- **调用方式**：由 Orchestrator 通过 **task** 工具委派，例如 `task(subagent_type="explore-agent", description="…")`；前端 **TaskToolUI** 会根据 `subagent_type` 显示「探索」等标签。
- **是否“有效执行”**：取决于主图路由与 Orchestrator 是否在合适时机选择委派给 explore-agent；若希望更多走 explore，需在 Orchestrator 的提示/路由逻辑中增加对「搜索/收集信息」任务到 explore 的派发。

DeepAgent 官方示例中也有 explore 类能力（文件搜索、信息收集），本系统按同一 SubAgent 模式实现，无需为“像 Claude”而再套一层。

---

## 可参考的外部资源

| 来源 | 用途 |
|------|------|
| **LangGraph 文档** | 图编排、子图、流式、Checkpointer/Store：https://langchain-ai.github.io/langgraph/ |
| **assistant-ui** | 前端对话/Thread/Composer 与 LangGraph 对接：https://github.com/assistant-ui/assistant-ui |
| **DeepAgent (LangChain)** | 多 Agent 协作、中间件、SubAgent 模式参考 |
| **Claude 产品/文档** | 思考过程展示、Project 与任务型对话的 UX 参考 |
| **Cursor 开源/文档** | 编辑器集成、Composer、快捷键与布局参考 |
| **GitHub topic: langgraph** | 社区示例与扩展实现 |

以上资源可用于扩展本系统的应用场景与交互方式，按需选用即可。
