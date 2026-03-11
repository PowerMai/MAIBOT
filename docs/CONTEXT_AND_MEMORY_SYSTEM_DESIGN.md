# 上下文与记忆系统设计（Claude/Cursor/Cowork 范式）

本文档约定：**文件即过程与输出**、**持久化记忆让 Agent 真正了解用户**、**上下文超长的系统级解法**，使多轮工作前后衔接、记忆可查可用。

---

## 一、文件即上下文（过程文件与输出物）

### 1.1 设计原则

- **过程与输出优先落盘**：中间结论、产出路径、会话状态写入工作区文件，而非仅留在对话气泡中。
- **后续任务有据可查**：新会话或新任务通过读取 `.maibot/` 与 `outputs/` 下的文件恢复上下文，实现「上次做到哪、产出了什么」的衔接。
- **与 Cursor/Claude 对齐**：工作区根下固定目录作为「上下文目录」和「产出目录」，Agent 与用户都按同一约定读写。

### 1.2 工作区目录约定

| 路径 | 用途 | 谁写 | 谁读 |
|------|------|------|------|
| `.maibot/MAIBOT.md` | 项目级记忆、重要产出路径、错误与教训摘要 | Agent / 用户 | 每次 run 前（project_memory） |
| `.maibot/WORKING-BUFFER.md` | 当前会话/任务的中间结论、可验证事实 | Agent（上下文预算告警时优先写此处） | Agent 下一轮、用户 |
| `.maibot/SESSION-STATE.md` | 纠正/决策后的关键结论（WAL 检查点） | Agent | 新任务开始前 |
| `.maibot/plans/<thread_id>.md` | Plan 模式下的计划正文 | 后端 | Agent / 用户 |
| `.maibot/execution_summary.md` | 每次执行摘要（ENABLE_EXECUTION_DOCS=true） | 后端 | 用户 / 后续分析 |
| `.maibot/lessons.md` | 经验教训条目 | 后端 / Agent | Agent |
| `outputs/` | 按模式分子目录的报告、图表、文档 | Agent | Agent（read_file）、用户 |
| `uploads/` | 用户上传文件 | 用户 / 前端 | Agent |

### 1.3 Agent 行为约定（提示词与实现）

- **产出必落盘**：重要结果写入 `outputs/<mode>/` 或 `outputs/`，并在回复中给出相对路径；不依赖「上一条消息里的长文」作为唯一记录。
- **路径记入 MAIBOT.md**：重要产出路径、关键决策、失败根因，追加到 `.maibot/MAIBOT.md`，便于「上次」「那个文件」的引用与检索。
- **用户说「上次」「之前」**：从对话历史或 `.maibot/MAIBOT.md` 中定位具体文件/结果，再按需 `read_file`。
- **上下文预算告警**：当系统提示「请将关键中间结论写入 .maibot/WORKING-BUFFER.md」时，Agent 优先把可验证结论写文件，再继续执行，以压缩低价值历史、保留高价值上下文。

### 1.4 与现有实现的对应关系

- **project_memory**：`deep_agent._load_memory_content()` 已加载 `.maibot/MAIBOT.md` 及 `.maibot/rules/*.md`，前 200 行等策略见 deep_agent 注释。
- **context_dir**：提示词中已统一为 `.maibot`，`AgentConfig.context_dir` 与 MAIBOT_PATH 一致。
- **execution_docs**：`execution_summary.md` / `lessons.md` 由 `backend/engine/tasks/execution_docs.py` 在任务结束后写入（需 `ENABLE_EXECUTION_DOCS=true`）。

### 1.5 首轮上下文组装（Claude/Cowork 风格「首轮即知」）

在**首轮** model 调用前，由 `inject_runtime_context`（`deep_agent.py`）统一注入以下块，使 LLM 在第一次回复前即知「有哪些记忆可参考、有哪些过程文件可读」：

| 块 | 触发条件 | 格式与长度 | 说明 |
|----|----------|-------------|------|
| **recalled_memories** | `ENABLE_LANGMEM=true` 且 `ENABLE_PROACTIVE_MEMORY_INJECT=true` | `<recalled_memories>`，默认最多 5 条、约 800 字（`PROACTIVE_MEMORY_MAX_CHARS`） | 用 `get_relevant_memories_for_prompt(configurable)` 调用 langmem 检索，命名空间由 `resolve_memory_scope(configurable)` 解析；Store 不可用或检索异常时返回空，不阻塞主流程。 |
| **process_files** | 非只读模式（非 ask/review）且工作区内存在 SESSION-STATE / WORKING-BUFFER / .learnings/ERRORS | Level 1：存在性一句；Level 2：`PROCESS_FILES_SUMMARY_CHARS>0` 时读前 N 字摘要 | Level 1 仅提示「执行前请用 read_file 查看」；Level 2 将各文件前 N 字写入 `<process_files>`，详情仍由 read_file 按需拉取。 |

- **与 session_context、inject_runtime_context 的先后关系**：`session_context` 由 main_graph 在流式入口下发（threadId/mode/roleId）；首轮上下文块在**同一 run 内**由中间件 `inject_runtime_context` 追加到 system 末尾，即先完成 session_context 事件发送，再在首次 model 调用前完成 recalled_memories / process_files 注入。
- **实现位置**：`backend/engine/agent/deep_agent.py` 的 `inject_runtime_context`；`backend/tools/base/memory_tools.py` 的 `get_relevant_memories_for_prompt`。

---

## 二、记忆：让用户感觉 Agent 了解自己

### 2.1 记忆层次（简要）

| 层次 | 存储 | 内容 | 何时写入 |
|------|------|------|----------|
| 短期 | Checkpointer (SQLite) | 会话状态、消息历史、工具调用 | 每轮自动 |
| 项目 | `.maibot/MAIBOT.md` 等 | 产出路径、教训、项目级规则 | Agent 写入 / 后端 execution_docs |
| 长期（用户向） | LangGraph Store + langmem | 用户偏好、背景、事实、执行经验 | manage_memory 工具 / 执行后反思 / **对话后用户记忆抽取** |

### 2.2 当前缺口与对策

- **现象**：用户聊了很多，但「记忆中什么都没有」——长期记忆仅在被调用 `manage_memory` 或执行成功后的 **执行经验反思**（procedural）时写入，**用户偏好/背景/事实**没有自动沉淀。
- **对策**：
  1. **对话后用户记忆抽取**（新增）：在 run 结束后（成功或正常结束），异步执行「用户记忆抽取」：用当前会话最近若干轮消息，由 LLM 抽取「关于用户的事实、偏好、习惯」，并写入 Store（与 langmem 同一 namespace），供后续 `search_memory` 使用。可选开关：`ENABLE_USER_MEMORY_EXTRACTION=true`。
  2. **提示词强化**：在系统提示中明确要求 Agent 在获知用户偏好、重要背景时主动调用 `manage_memory` 保存。
  3. **执行经验反思**：保持现有 `enqueue_execution_memory_reflection`（成功任务后沉淀方法/参数），与用户记忆抽取并行、互补。

### 2.3 用户记忆抽取契约（User Memory Reflection）

- **触发时机**：run 结束后、Store 可用、会话 snapshot 条数 ≥ 2 且含至少一条 user 消息；受环境变量 `ENABLE_USER_MEMORY_EXTRACTION`（默认 false）、`USER_MEMORY_EXTRACTION_MAX_MESSAGES`（默认 12，范围 2–30）控制。实现见 main_graph 流式收尾与 `learning_middleware.enqueue_user_memory_reflection`。
- **输入**：最近 N 条消息的摘要或原文（可截断）。
- **输出**：写入 Store namespace `("memories", workspace_id, user_id)`，与现有 langmem `manage_memory` / `search_memory` 一致，便于检索。
- **与任务级学习、会话级记忆的区别**：任务级学习（learn_from_success/failure）沉淀执行模式与推理路径；用户记忆抽取沉淀「关于用户的事实与偏好」，供 search_memory 检索；会话级记忆由 Checkpointer 保存消息历史。

---

## 三、上下文超长（Context size exceeded）的系统解法

### 3.1 问题来源

- 错误由 **推理服务端**（如 LM Studio / 云端 API）在请求 token 数超过 `max_context_length` 时返回。
- 本项目在 `main_graph.deepagent_node` 中识别该类异常并设置 `error_code = "context_exceeded"`，前端可据此提示「新开会话或清除历史」。

### 3.2 分层策略（Agent 范式 + LangChain 方法）

1. **预防（优先）**
   - **SummarizationMiddleware**（DeepAgent 内置）：在上下文接近上限时用 LLM 将旧消息压缩为摘要，保留最近消息。触发阈值由模型 `profile["max_input_tokens"]` 与默认比例（如 85%）决定；本项目通过 `SUMMARIZATION_TRIGGER_RATIO`（默认 0.75）在文档中建议更早触发，若 deepagents 支持从环境注入则使用该比例。
   - **ContextGuardMiddleware**（本项目新增）：在 **before_model** 中估算当前 `request.messages` 的 token 数；若超过 `SUMMARIZATION_TRIGGER_RATIO * context_length`，则用 LangChain `trim_messages` 按「保留最近」策略裁剪到安全范围内，避免在未触发 Summarization 前就超长。`context_length` 来自 `configurable` 或模型 profile。

2. **降级（错误时）**
   - 识别到 `context_exceeded` 后，返回明确提示与 `error_code`，建议用户：新开会话、清除部分历史，或调低 `SUMMARIZATION_TRIGGER_RATIO`（如 0.6）使系统更早压缩。
   - 可选（后续）：在捕获 `context_exceeded` 后自动重试一次——先对 `state["messages"]` 做 `trim_messages` 再重新 invoke，并记录「已因超长自动裁剪并重试」以便审计。

3. **工具与提示词**
   - 大文件：用 `grep` 定位、按需 `read_file` 片段，避免整文件进上下文；产出写文件并只传路径。
   - 重要结论写 `.maibot/WORKING-BUFFER.md` 或 `MAIBOT.md`，减少对长对话历史的依赖。

### 3.3 配置与环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `SUMMARIZATION_TRIGGER_RATIO` | 0.75 | 建议的压缩触发比例（与 DeepAgent 内置 Summarization 配合或由 ContextGuard 使用） |
| `ENABLE_CONTEXT_GUARD` | true | 是否启用 ContextGuardMiddleware，在 before_model 时做预防性 trim |

---

## 四、与现有文档的对应

- **main_pipeline_and_middleware_rationality.md** §4.2：context exceeded 来源与后端处理、与 SummarizationMiddleware 的关系。
- **ERROR_CODES_AND_TROUBLESHOOTING.md**：`context_exceeded` 错误码与用户建议。
- **MEMORY_ARCHITECTURE.md** / **UNIFIED_MEMORY_ARCHITECTURE.md**：记忆层次、Store、project_memory、langmem 工具。
- **CONTEXT_WINDOW_MANAGEMENT.md** / **CONTEXT_MANAGEMENT.md**：上下文组成、read_file 与压缩策略。

本设计在以上基础上，统一「文件即上下文」「用户记忆自动沉淀」「上下文超长系统解法」的约定与实现要点，便于前后端与 Agent 行为一致、可演进。
