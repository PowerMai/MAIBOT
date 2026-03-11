# SubAgent 结构化输出约定

本文档约定各 SubAgent 的**推荐**输出结构，便于 Orchestrator 解析与手递手传递，以及后续若要做结构化解析时有一致约定。不强制工具层解析 JSON，仅作为提示词与人工审查的规范。

**默认 SubAgent 定位（与 Cursor 对齐）**：默认仅启用「上下文隔离型」子代理——explore-agent、bash-agent、browser-agent（+ 内置 general-purpose）。规划与执行由主 Agent 的 Plan 模式（规划阶段 → 用户确认 → 执行阶段）承担，不默认使用 planning/executor/knowledge 子代理；后者可通过 .maibot/agents/*.yaml 按需扩展（高级/实验）。

## explore-agent

| 字段 | 说明 |
|------|------|
| found_files | 文件路径列表（绝对路径）+ 每个文件的相关原因 |
| summary | 关键发现的结构化摘要 |
| search_notes | 搜索过程中的重要观察（可选） |

## 规划型子代理（planning 模板，可选 YAML 扩展）

注：默认不启用。主 Agent Plan 模式已承担规划职责；仅在显式启用 .maibot/agents/*.yaml 时可用。

| 字段 | 说明 |
|------|------|
| goal | 任务目标（一句话） |
| key_info | 提取的关键信息（JSON 或结构化键值） |
| steps | 执行步骤，每步含：id、action、input_ref、output_path、verification |
| deliverables | 交付物列表，每项为 path + 格式/类型 + 简要验收；与 steps 的 output_path 对应 |
| risks | 风险点和规避措施 |
| critical_files | 最关键的 3-5 个文件（绝对路径 + 原因） |
| verification | 整体验证方式 |

输出时建议使用明确标题如 `## goal`、`## key_info`、`## steps`、`## deliverables`、`## risks`，便于执行子代理与 Orchestrator 解析。

## 执行型子代理（executor 模板，可选 YAML 扩展）

注：默认不启用。执行阶段由主 Agent 按 plan_file_path 与 \<plan_execution\> 约束直接执行；仅在显式启用 YAML 时可用。

| 字段 | 说明 |
|------|------|
| steps_done | 每步 id + 是否完成 + 实际产出路径（若与计划不同需说明） |
| deliverables_created | 实际生成的文件路径列表，与 deliverables 清单对应 |
| verification_result | 整体验证是否通过（是/否 + 简要说明） |
| 执行结果摘要、相关文件名和关键代码/内容片段 | 保留自然语言摘要 |

## 知识检索型子代理（knowledge 模板，可选 YAML 扩展）

注：默认不启用。主 Agent 可直接调用 search_knowledge；仅在显式启用 YAML 时可用。

| 字段 | 说明 |
|------|------|
| summary | 一句话核心回答 |
| sources | 来源文件路径（绝对路径） |
| content | 检索到的关键内容 |
| gaps | 信息缺口（如有） |

## 与提示词的关系

- 各 SubAgent 的提示词（`agent_prompts.py` 中 `get_explore_prompt`、`get_planning_prompt`、`get_executor_prompt`、`get_knowledge_prompt`）已要求「最终响应必须包含」上述字段。
- Orchestrator 在调用可用规划子代理时应在 description 中写明需返回 goal、key_info、steps、deliverables；调用可用执行子代理时传入 steps 与 deliverables，并要求返回 steps_done、deliverables_created、verification_result。
