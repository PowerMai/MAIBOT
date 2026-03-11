# 工具清单与描述规范

本文档提供本系统工具清单、与 Claude/Cursor 的对比结论，以及「工具描述与用法」的审查要点，确保 LLM 能正确选用与调用工具。

---

## 一、工具集对比（摘要）

详见 [TOOLS_COMPARISON.md](backend/docs/TOOLS_COMPARISON.md)。

- **Cursor 约 13 个核心**：read_file、write_file/edit_file、list_directory、file_search、grep/codebase_search、find_definition、find_references、run_terminal_cmd、web_search、todo_write、update_memory、可选 browser、screenshot。
- **本系统 16+**：覆盖上述，并多出 copy_file、move_file、delete_file、python_run、search_knowledge（知识库）、think_tool、plan_next_moves 等。
- **比 Claude 多的原因**：知识库与业务需求（search_knowledge）；代码执行拆分为 python_run + shell_run；显式思考/规划工具；更多文件操作以支持工作区与自动化。

---

## 二、工具描述规范（审查要点）

为确保 LLM 正确使用工具，建议对每项工具做以下审查：

| 检查项 | 说明 |
|--------|------|
| **description** | 是否清晰说明「何时用、做什么、典型场景」；是否注明副作用（如写盘、发请求） |
| **参数** | 参数名与类型是否完整；是否注明必填/可选、单位、格式（如 path 为工作区相对或绝对） |
| **适用模式** | 与 mode_config 一致（如 Ask 模式仅只读工具）；SubAgent 工具子集是否与编排一致 |
| **示例** | 若注入到提示词，是否有简短用法示例或约束说明（Layer 1 tool_usage / tool_calling） |

工具 schema 来源：LangChain `BaseTool` 在 [backend/tools/base/registry.py](backend/tools/base/registry.py) 等处注册；DeepAgent 将 schema 注入提示词；`_tool_schema_deferred` 与扩展工具按需激活以控制 token。

### 2.1 工具与权限/可见性一览

- **来源**：DeepAgent 内置（ls, read_file, write_file, edit_file, glob, grep）、自研（python_run, shell_run, search_knowledge, task 等）；与 [INTEGRATION_CONTRACTS.md](INTEGRATION_CONTRACTS.md) §5.1 中间件分工一致。
- **模式可见性**：由 [mode_config](backend/engine/modes/mode_config.py) 与 `is_tool_allowed(mode, tool_name)` 决定；Ask 仅只读，Agent/Plan/Debug/Review 按配置开放。
- **tier/许可**：由 [license_gate](backend/engine/middleware/license_gate_middleware.py) 与 `backend/config/license_tiers.json`、`data/license.json` 决定；插件工具由 PluginLoader 与 tier 映射控制。
- 维护建议：新增工具时在 registry 注册、同步更新 mode_config 的允许列表（若需按模式限制），并在 license_tiers 中标注 tier（若为高级能力）；与 §二审查要点一致。

---

## 三、MCP 工具

- **实现**：[mcp_tools.py](backend/tools/mcp/mcp_tools.py)、[mcp_middleware.py](backend/engine/middleware/mcp_middleware.py)；通过 **langchain-mcp-adapters** 连接 MCP 服务器，支持 stdio/HTTP；动态加载并参与模型调用。
- **描述与可用性**：MCP 工具描述来自 MCP 服务器提供的 schema；需保证服务器可用、超时与错误不拖垮主链；本系统已有 MCP 错误处理与 reload 逻辑。
- **与 Claude/Cursor**：协议与适配器层面一致；差异在已配置的 MCP 服务器列表与策略，可按需扩展。

---

## 四、审查与迭代

- 建议定期（如每季度或大版本前）对 [registry](backend/tools/base/registry.py) 及各工具模块做一轮「描述与用法」审查，并更新本清单。
- 新增工具时：同步更新 TOOLS_COMPARISON.md 与本文档，并确保 description/参数符合上表规范。

---

## 五、与 Claude/Cowork 工具描述对齐检查结果

- **描述**：registry 及 Layer1 tool_usage 中核心工具（read_file、write_file、edit_file、grep、glob、search_knowledge、web_search、python_run、shell_run、task、list_skills、match_skills）已具备 When to use / Avoid when / Parameters / Returns 或等价说明，与 [product_parity_claude_cursor_cowork.md](product_parity_claude_cursor_cowork.md)、[skills_claude_alignment.md](skills_claude_alignment.md) 对标一致。
- **错误与策略**：tool-fallback 的 `parseErrorOrPolicyResult` 已覆盖 permission_denied、policy_layer、reason_code、**tool_disabled**（后端降级占位工具返回的 JSON）；`failureClassifier` 已覆盖 cancelled、network、policy、permission、argument、generic 及 **tool_disabled**（展示策略类提示与 reason/action 文案）。
- **避免报错**：deep_agent 工具绑定与 middleware 校验处异常已通过 ToolMessage 或流事件返回前端；工具禁用时返回统一 JSON 结构，前端可解析并展示「未启用」原因。

---

## 六、审查记录

| 日期 | 范围 | 结论 | 备注 |
|------|------|------|------|
| 2025-03 | registry.py 全量 | 多数工具已具备 When to use / Parameters / Returns；3 处补强 | web_crawl_batch、content_extract、template_render 原描述过简，已补全 |
| 2025-03 | 核心执行类 | 通过 | shell_run、python_run、web_fetch、web_search 描述与参数完整 |
| 2025-03 | 知识/记忆类 | 通过 | search_knowledge、manage_memory、search_memory 符合规范 |
| 2025-03 | 模式/审查类 | 通过 | enter_plan_mode、exit_plan_mode、critic_review 用法清晰 |
| 2025-03 | Claude 对齐 | 完成 | Layer1 写入权限与路径说明；shell_run/python_run 补全 Avoid when；search_knowledge 补全 When to use/Avoid when/Examples；tool_usage 增加 search_knowledge 用法示例 |
| 2026-03 | 工具描述规范复核（Claude/Cowork 对齐） | 通过 | registry、核心执行/知识/Skills 工具及 Layer1 tool_usage 符合规范；skills_catalog 已增加 [有脚本] 标注（见 deep_agent._build_skills_catalog_from_index） |
| 2026-03 | 思考流断点与工具补全 | 补全 | parseErrorOrPolicyResult 与 failureClassifier 增加 tool_disabled 分支；§五增加与 Claude/Cowork 工具描述对齐检查结果 |
