# 数字员工个体能力体系架构

本文档描述本系统中「数字员工」个体层的能力档案、任务流程、人类检查点与联网预留接口。

## 一、定位与设计对比

### 个体层定位

- **目标**：将单个 Agent 做成具备能力档案、可接任务、可请求人类审核的「数字员工」。
- **模式**：Phase 1 为被动模式——人设定能力、人分配任务；评估结果仅用于展示，不用于自动决策。
- **协作层**：预留接口，未来可接入 OpenClaw Gateway；Agent 能力档案可转为 Node capabilities，看板任务可映射为 Gateway 任务。

### 与 Claude / OpenClaw 的对应关系

| 特性       | Claude           | OpenClaw       | 本系统个体层           |
| ---------- | ---------------- | -------------- | ---------------------- |
| 能力声明   | Skills metadata  | caps/commands  | AgentProfile 能力档案  |
| 任务接收   | 对话             | Gateway 推送   | 看板 + 对话            |
| 内部执行   | Orchestrator+SubAgent | Node 自定 | 保持现有 DeepAgent     |
| 人类节点   | ask_user         | 无原生支持     | human_checkpoint 工具  |
| 进度汇报   | 无               | result 推回    | report_progress        |

## 二、能力档案（AgentProfile）

### 存储与结构

- **路径**：`backend/config/agent_profile.json`
- **加载/保存**：`backend/engine/skills/skill_profiles.py` 中的 `load_agent_profile()`、`save_agent_profile()`

### 字段说明

```json
{
  "agent_id": "agent-001",
  "name": "AI 工作助手",
  "description": "通用办公与专业领域的数字员工",
  "capabilities": {
    "skills": ["bidding-document-analysis", "contract-review", ...],
    "domains": ["marketing", "legal", "office", "reports"],
    "modes": ["agent", "ask", "plan", "debug", "review"],
    "max_parallel_tasks": 2,
    "supported_input_types": ["text", "document", "data", "image"],
    "supported_output_types": ["document", "report", "analysis", "code"]
  },
  "resources": {
    "compute_tier": "medium",
    "available_models": ["auto", "seed-oss-36b", "qwen3-coder-30b"],
    "max_context_tokens": 128000,
    "storage_available_mb": 1024
  },
  "pricing": { "currency": "credit", "base_rate_per_task": 0, "token_cost_per_1k": 0 },
  "network": {
    "openclaw_enabled": false,
    "openclaw_gateway": null,
    "openclaw_node_id": null,
    "channels": ["local"]
  }
}
```

- **人设定能力**：通过设置页「Agent 档案」Tab 编辑（名称、描述、Skills 多选、资源、联网为预留灰色）。
- **联网预留**：`network` 为 OpenClaw 接入预留；启用后可将 `capabilities` 转为 OpenClaw `caps/commands` 注册到 Gateway。

## 三、能力评估

- **模块**：`backend/engine/agent/self_assessment.py`
- **接口**：`SelfAssessment.assess(task, profile)`  
  - 入参：看板任务（含 `required_skills` 等）、AgentProfile  
  - 返回：`can_do`、`skill_match`（0–1）、`matched_skills`、`estimated_cost`、`estimated_time_minutes`、`capacity`（可拆分时）
- **API**：`POST /agent/assess-task`，请求体 `{ "task": <BoardTask> }`
- **用途**：Phase 1 仅在任务面板等处展示匹配度与预估时间，不参与自动接单或路由。

## 四、任务看板增强

### BoardTask 扩展字段

在原有看板任务基础上增加（见 `backend/tools/base/task_board_tools.py` 与 API 模型）：

- **可拆分**：`splittable`、`total_units`、`claimed_units`、`unit_label`
- **层级**：`parent_task_id`、`subtask_ids`
- **技能**：`required_skills`
- **人类检查点**：`human_checkpoints`（`[{ after_step, action, description }]`）
- **进度**：`progress`（0–100）、`progress_message`
- **阻塞治理**：`blocked_reason`、`missing_information`
- **交付审计**：`deliverables`、`changed_files`、`rollback_hint`
- **预留**：`external_task_id`、`pricing`

### 看板工具

- `report_progress(task_id, progress, message)`：上报任务进度（0–100 + 说明）
- `report_blocked(task_id, reason, missing_info)`：上报阻塞原因与缺失信息
- `report_artifacts(task_id, deliverables, changed_files, rollback_hint)`：上报成果物与可回滚信息
- `publish_subtask(parent_task_id, subject, ...)`：将子任务发回看板并关联父任务

### 相关 API

- `POST /board/tasks/{id}/progress`：报告进度  
- `POST /board/tasks/{id}/blocked`：报告阻塞  
- `POST /board/tasks/{id}/artifacts`：报告成果物  
- `GET /board/tasks/{id}/subtasks`：获取子任务列表  
- `POST /board/tasks/{id}/human-review`：提交人类审核结果（记录到任务）
- `GET /board/metrics/reliability`：获取单体阶段可靠性指标快照

## 五、人类检查点机制

### 工作原理

- 利用 LangGraph `interrupt()`，将 `ask_user` 扩展为结构化的 **request_human_review**。
- 工具定义在 `backend/tools/base/human_checkpoint.py`，由 Orchestrator 注册并在到达检查点时由 Agent 调用。

### 工具签名

```python
request_human_review(
    checkpoint_id: str,
    summary: str,
    options: list[str] = ["approve", "reject", "revise"],
    context: str = "",
) -> str
```

- 调用后任务暂停，`interrupt` 的 value 为 `{ type: "human_checkpoint", checkpoint_id, summary, options, context }`。
- 前端 `InterruptDialog` 识别该类型，展示摘要、上下文与操作按钮（批准/拒绝/请求修改）；用户选择后通过 `resume` 将决策字符串回传，Agent 继续执行。

### 提示词注入

- 当任务带有 `human_checkpoints` 时（由 `config.configurable.board_task` 或 `human_checkpoints` 传入），在系统提示词中注入 `<human_checkpoints>` 块（见 `backend/engine/prompts/agent_prompts.py` 的 `get_human_checkpoints_prompt()`）。
- 内容说明在哪些「步骤完成后」必须调用 `request_human_review`，以及如何整理 summary/context 并等待人类决策。

### 前端

- `InterruptDialog` 识别 `type: "human_checkpoint"`，展示结构化审核 UI（摘要、上下文、批准/拒绝/请求修改）。
- 审核结果可通过 `POST /board/tasks/{id}/human-review` 写入任务记录，便于审计与后续流程。

## 六、API 与前端一览

### Agent 档案与评估

- `GET /agent/profile`：获取 Agent 能力档案  
- `PATCH /agent/profile`：更新能力档案（人设定能力）  
- `POST /agent/assess-task`：评估任务与当前 Agent 的匹配度  

### 看板任务

- `POST /board/tasks/{id}/progress`：报告进度  
- `GET /board/tasks/{id}/subtasks`：获取子任务  
- `POST /board/tasks/{id}/human-review`：提交人类审核结果  

### 前端

- **AgentCapabilities**：数据源改为 `GET /agent/profile`，展示名称、已装备 Skills、模式、资源、联网状态（如「本地」）。
- **TaskPanel**：任务卡片展示所需 Skills、进度条、可拆分标识；创建任务时可填所需 Skills、人类检查点、可拆分；支持子任务展开；人类审核入口与匹配度展示。
- **SettingsView**：「Agent 档案」Tab 展示/编辑 AgentProfile，Skills 列表来自 `GET /skills/list`（或等价 Skills API）。

## 七、联网预留（OpenClaw）

- `agent_profile.json` 中的 `network` 字段用于预留 OpenClaw 接入。
- 当 `openclaw_enabled` 为 true 时（未来实现）：
  - 可将 `capabilities` 转为 OpenClaw Node 的 `caps/commands` 注册到 Gateway。
  - 看板任务可映射为 Gateway 任务格式，实现多 Agent 协作与任务市场。

当前 Phase 1 仅使用 `channels: ["local"]`，UI 上以「本地」展示，不发起任何联网注册或任务推送。

---

## 八、实现说明（Claude 风格）

- **看板 list**：`list_board_tasks` 返回的文本摘要中包含进度、所需技能（若有），便于 Agent 决策。
- **能力评估**：`SelfAssessment` 对 `required_skills` 做规范化与去重后计算匹配度；无要求时 `skill_match=1`、`can_do=True`。
- **人类检查点**：`request_human_review` 的 resume 返回值统一规整为字符串（支持 `decision`/`feedback` 或 `response`/`comment`）；前端 `options` 缺失时默认展示批准/拒绝/请求修改。
- **前端**：AgentCapabilities 支持加载中/失败重试；Settings 首次保存可基于空档案写入默认；TaskPanel 匹配度在请求中显示「计算中…」、无结果显示「—」。

---

## 九、常见问题

- **看板「待处理」与 Agent 列出一致吗？**  
  创建任务时状态为 `available`，前端筛选「待处理」使用 `available`。Agent 调用 `list_board_tasks(status="pending")` 时，后端会同时返回 `status` 为 `pending` 与 `available` 的任务，二者均视为待处理。

- **人类检查点 resume 传什么格式？**  
  前端可传字符串（如 `approve`、`reject`、`revise: 修改意见`）或由后端解析的 JSON 字符串；工具会将 `decision`/`feedback` 或 `response`/`comment` 规整为一行字符串返回给模型。

- **Agent 档案加载失败怎么办？**  
  能力名片会显示「加载失败，请稍后重试」与「重试」按钮；设置页 Agent 档案可先填名称与描述并保存，技能列表若暂无也可先保存。

- **任务进度不更新怎么办？**  
  Agent 需在运行中调用 `report_progress` 工具（或前端/API 调用 `POST /board/tasks/{id}/progress`）。进度为 0–100 整数，后端与前端均会做钳位；任务详情面板会展示进度条与进度说明（若有 `progress_message`）。
