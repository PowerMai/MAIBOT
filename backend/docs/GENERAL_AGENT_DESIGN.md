# 通用 Agent 设计

本文档说明本系统「通用 Agent」的设计目标、能力边界及与场景/模式的关系，供实现与回归检查参考。

## 设计目标

- 支持**各类工作流任务**：文档编制与审核、数据分析与报告、代码开发与排查、流程设计与规划、问题诊断等，不限于「文档 + 代码」。
- 通过 **Skills 系统**动态扩展专业能力，通过 **场景（skill_profile）+ 模式（mode）** 定义角色与工具边界。
- 与 Claude/Cursor 实现方式对齐：极简工具 + 对话驱动，不新增平台级 API 工具，通过提示词与 SubAgent 扩展能力边界。

## 能力边界

能力边界由以下共同决定：

1. **身份（identity）**：agent_prompts.py 中的通用身份表述（各类工作流 + Skills 扩展）。
2. **task_context**：若调用方传入 `task_type` / `business_domain`，通过 `_format_user_context` 注入 `<task_context>` 块，供模型优先选择工具与 SubAgent；未提供时按用户请求自行判断。
3. **Skills / BUNDLE**：按 skill_profile 加载能力速查（BUNDLE）与 Skills 路径；场景身份通过 `<scene_context>` 在 deep_agent 中拼接。
4. **四模式（mode）**：Agent / Ask / Plan / Debug 提供角色块（身份 + 目标 + 约束），与 [FOUR_MODES_DESIGN.md](FOUR_MODES_DESIGN.md) 一致；模式表述覆盖资料、数据、流程、诊断等，不限于代码。

任务类型/业务领域**不新增工具**，仅通过提示词中的「任务类型说明」与可选的 `<task_context>` 影响行为；工具集仍为现有 ls/read_file/write_file/edit_file/glob/grep、python_run、shell_run、search_knowledge、task、Skills 等。

## 对话框中的两个选择：模式 / 领域（无任务类型）

**Claude / Cursor 都没有「任务类型」由用户选择。** 本系统与之一致：不在界面上提供任务类型，分析/写作/检索/诊断等由 AI 根据用户说法自动判断。

输入区底部只有**两个**与行为/能力相关的下拉：

| 选择 | 回答的问题 | 典型选项 | 作用 |
|------|------------|----------|------|
| **模式** | **这一轮 AI 怎么干活？** | Agent / Ask / Plan / Debug | 行为边界：能改文件吗、只出计划还是直接执行、只读还是可写。与 Cursor 四模式一致。 |
| **领域** | **用哪一行的专长？** | 全部能力 / 招投标 / 合同 / 办公 / 报告 / 调研 | 加载哪套 Skills 与能力速查（BUNDLE），相当于「当前领域」。 |

**逻辑关系**：模式 = 怎么干（行为）；领域 = 用哪套专长。二者正交，组合即可。例如：模式=Agent、领域=招投标 → 在招投标能力下执行（写标书、分析招标文件等都由你说的话决定，AI 自动判断是写是分析还是查资料）。

**任务类型为何不交给用户选？**

- 诊断 ≈ Debug 模式、检索 ≈ Ask 模式，和模式重复；分析、写作等本就可以由 AI 根据对话内容自动判断，不需要用户事先指定。
- 不同领域下「适用什么任务」也不一样，交给用户选反而容易混淆。因此**不提供任务类型选择**，与 Claude/Cursor 一致。后端仍支持通过 API/configurable 传入 `task_type`（高级用法），默认不传即由模型根据请求自行判断。

## 和 Claude / Cursor 一样吗？会不会太复杂？

**对比：**

| 产品 | 用户可见的选择 | 说明 |
|------|----------------|------|
| **Claude（网页/API）** | 无模式/场景下拉 | 一个对话框，模型根据你说的话自己决定读还是写、怎么执行。 |
| **Cursor** | **只有 1 个：模式**（Agent / Ask / Plan / Debug） | 没有「场景」「任务类型」。用户只选「怎么干活」，不选领域或任务类型。 |
| **本系统** | **模式 + 领域**（2 个） | 与 Cursor 对齐「模式」；多一个「领域」用于招投标/合同等专长。**不提供任务类型**（与 Claude/Cursor 一致，由 AI 自动判断）。 |

所以：**Claude / Cursor 都没有任务类型选择。** 本系统已去掉任务类型，只保留模式 + 领域，用户只需选「怎么干」和「用哪套专长」。

## 按场景与模式定义角色（实现视角）

- **角色** = 身份(identity) + 目标(goals) + 约束(constraints)。本系统通过「通用 base + mode 角色块 + scene 领域身份」组装提示词，不维护 (scene × mode) 的独立长提示词矩阵。
- **场景（scene）**：由 skill_profile 表示（如 bidding、contract、office、report、research、full）。当 skill_profile 非 general/full 时，在 deep_agent 中拼接 `<scene_context>` 一句，并加载对应 BUNDLE 与 Skills 路径。
- **模式（mode）**：Agent / Ask / Plan / Debug，严格对齐 Cursor 四模式。每个模式在 mode_config 中对应一套角色块（`<mode_identity>` / `<mode_goals>` / `<mode_constraints>`），覆盖资料、数据、流程、诊断等通用表述，不限于代码。
- **参考**：Claude/Cursor 通过「前置说明 + 工具集/权限」区分模式；本系统显式提供 mode 角色块与 scene_context，便于模型与用户理解「谁在用什么规则做事」。

## 阶段一验收要点

- 身份与 doing_tasks 中可见「各类工作流」及非代码示例。
- 当 configurable 提供 task_type/business_domain 时，系统提示词中出现 `<task_context>`。
- 每个模式（Agent/Ask/Plan/Debug）均有角色块（身份+目标+约束），且含通用表述（资料/数据/流程/诊断）。
- 当选择非 general/full 场景时，系统提示词中出现 `<scene_context>`，且与 BUNDLE 配合。
- 文档与 CLAUDE_ALIGNMENT 检查项已更新，交叉引用一致。

## 相关文档

- 与 Claude 实现对齐的检查清单：[CLAUDE_ALIGNMENT.md](CLAUDE_ALIGNMENT.md)
- 四模式业务场景与计划结构：[FOUR_MODES_DESIGN.md](FOUR_MODES_DESIGN.md)
- 提示词与 SubAgent 委派：`backend/engine/prompts/agent_prompts.py`、[SUBAGENT_OUTPUT_SPEC.md](SUBAGENT_OUTPUT_SPEC.md)
- 场景与模式配置：`backend/engine/modes/mode_config.py`、`backend/engine/agent/deep_agent.py`（scene_context、BUNDLE 组装）
