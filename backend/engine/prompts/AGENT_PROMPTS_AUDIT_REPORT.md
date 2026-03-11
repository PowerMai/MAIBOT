# agent_prompts.py 审计报告

**审计日期**: 2025-02-13  
**文件**: `/Users/workspace/DevelopProjects/ccb-v0.378/backend/engine/prompts/agent_prompts.py`

---

## 1. 冗余 (Redundancy)

### 1.1 SubAgent 结果整合（3 处重复）

| 位置 | 内容摘要 |
|------|----------|
| **354** (system_communication) | "SubAgent 返回的结果对用户不可见。你必须整合 SubAgent 结果后向用户呈现，注明来源。" |
| **450** (collaboration_protocol) | "SubAgent 返回对用户不可见——你必须整合结果后向用户呈现，包含产出文件路径与关键结论。" |
| **601** (output_format) | "若本轮调用了 SubAgent：回复中必须整合并呈现其结论，列出产出文件路径（绝对路径）与关键发现；SubAgent 的中间过程对用户不可见，由你汇总后输出。" |

**建议**: 保留 `output_format` 中的表述（最具体、含交付要求），删除或大幅精简 `system_communication` 和 `collaboration_protocol` 中的重复。在 `system_communication` 中可改为一句："SubAgent 结果对用户不可见，须由你整合后呈现。"

---

### 1.2 附件必须 read_file 读取（4 处重复）

| 位置 | 内容摘要 |
|------|----------|
| **355** (system_communication) | "用户通过附件上传的文件路径在 <user_attachments> 中列出，必须先 read_file 逐个读取再处理。" |
| **362** (request_routing) | "附件处理：用户是否提供了附件？是 → 必须先 read_file 读取所有附件" |
| **416** (resource_awareness) | "用户附件（user_attachments）— 最高优先级，必须先 read_file 逐个读取再处理，禁止跳过" |
| **714** (_build_user_context_parts) | "用户附件（必须先用 read_file 读取所有附件，再按用户请求分析/处理）" |

**建议**: 在 `resource_awareness` 中保留完整说明（含优先级和禁止跳过），`request_routing` 中保留决策点引用即可。`system_communication` 可精简为："附件路径在 <user_attachments> 中，须先 read_file 再处理。" 第 714 行属于 user context 的说明，可保留但可改为引用："见 resource_awareness。"

---

### 1.3 文件操作用 read_file/write_file/edit_file，不用 shell_run（3 处）

| 位置 | 内容摘要 |
|------|----------|
| **378** (tool_calling) | "文件操作用 read_file/write_file/edit_file，不用 shell_run 执行 cat/sed/awk。" |
| **299-301** (tool_strategy_lines) | "文件操作用 read_file/write_file/edit_file，不用 cat/sed/awk/echo 重定向。" |
| **322** (shell_run 策略) | "shell_run：仅用于系统命令，不用于文件内容读写。" |

**建议**: `tool_calling` 保留原则性表述；`tool_strategy_lines` 可改为引用："见 tool_calling 规则。" 或合并为一条通用规则，避免三处独立表述。

---

### 1.4 结论须注明依据（4 处）

| 位置 | 内容摘要 |
|------|----------|
| **382** (tone_and_style) | "分析结论必须注明依据（条款位置、数据来源）。无依据不输出。缺失或歧义标注「待澄清」。" |
| **434-436** (drive_and_responsibility) | "每个结论必须有依据...无依据的推测标注「待澄清」或「文档未提及」。" |
| **437** (drive_and_responsibility) | "数据分析必须有图表支撑，图表必须有标题和标注。" |
| **479-481** (drive_and_responsibility 回复前自检) | "若有结论或建议，是否都注明了依据...？无依据的已标「待澄清」。" |

**建议**: 合并为一条核心规则，放在 `tone_and_style` 或 `drive_and_responsibility` 中，另一处仅引用。`drive_and_responsibility` 内 434-436 与 479-481 也可合并。

---

### 1.5 先本地后联网（2 处）

| 位置 | 内容摘要 |
|------|----------|
| **419** (resource_awareness) | "先本地后联网。本地有的不联网搜索。" |
| **334** (duckduckgo_search 策略) | "先本地后联网。本地知识库有的不联网搜索。" |

**建议**: 在 `resource_awareness` 中保留原则，`tool_usage` 中的 duckduckgo_search 策略改为："遵循 resource_awareness 中的先本地后联网原则。"

---

### 1.6 大文件先 grep 再 read_file(offset/limit)（3 处）

| 位置 | 内容摘要 |
|------|----------|
| **420** (resource_awareness) | "先摘要后全文。大文件先 grep 定位再 read_file(offset/limit)。" |
| **300** (tool_strategy_lines) | "read_file 支持 offset/limit 参数读取大文件的指定区间。" |
| **629** (tool_usage) | "大文件先 grep 定位再 read_file(offset/limit)。" |

**建议**: 保留 `resource_awareness` 中的原则，`tool_usage` 中删除重复，或改为引用。

---

### 1.7 重要产出路径记录到 CONTEXT.md（2 处）

| 位置 | 内容摘要 |
|------|----------|
| **434** (drive_and_responsibility) | "重要产出路径记录到 CONTEXT.md，便于后续回顾。" |
| **541** (version_awareness) | "重要产出路径记录到 {context_dir}/CONTEXT.md，便于后续回顾。" |

**建议**: 保留 `version_awareness` 中的表述（含路径变量），`drive_and_responsibility` 中删除或改为引用。

---

### 1.8 优先 edit_file 而非 write_file 覆盖（2 处）

| 位置 | 内容摘要 |
|------|----------|
| **386** (tone_and_style) | "优先编辑现有文件，非必要不创建新文件（含 *.md）。" |
| **300-301** (tool_strategy_lines) | "edit_file 做精确替换（类似 Claude StrReplace），优先于 write_file 覆盖整个文件。" |
| **569** (making_changes) | "优先用 edit_file 精确修改，避免 write_file 覆盖整个文件（除非创建新文件）。" |

**建议**: `tone_and_style` 保留高层原则；`making_changes` 保留操作规范；`tool_strategy_lines` 可精简为："edit_file 优先于 write_file。"

---

### 1.9 长输出写入 output_dir（3 处）

| 位置 | 内容摘要 |
|------|----------|
| **541** (workspace_layout) | "长输出：>500 字的输出写入 {output_dir}/，只向用户返回路径和摘要。" |
| **576** (making_changes) | "长内容（>500 字）写入 output_dir，回复只给路径和摘要。" |
| **600** (output_format) | "长报告或大段输出：正文只给路径与摘要，全文写入 {output_dir}/" |

**建议**: 在 `workspace_layout` 中保留一次完整说明，`making_changes` 和 `output_format` 改为引用。

---

### 1.10 不主动创建 *.md（2 处）

| 位置 | 内容摘要 |
|------|----------|
| **386** (tone_and_style) | "优先编辑现有文件，非必要不创建新文件（含 *.md）。" |
| **575** (making_changes) | "不主动创建文档文件（*.md）或 README，除非用户明确要求。" |

**建议**: 合并到 `tone_and_style` 或 `making_changes` 一处即可。

---

### 1.11 工具优先级 Skills > python_run > ...（2 处）

| 位置 | 内容摘要 |
|------|----------|
| **365** (request_routing) | "工具优先级：Skills > python_run > 专用工具 > 文件工具。" |
| **471** (tool_usage) | "选择优先级：Skills > python_run > 专用工具（search_knowledge / task()）> 文件工具。" |

**建议**: 保留 `tool_usage` 中的完整表述，`request_routing` 中改为引用："见 tool_usage 中的选择优先级。"

---

### 1.12 1-2 步能完成则直接执行（2 处）

| 位置 | 内容摘要 |
|------|----------|
| **365** (request_routing) | "1–2 步能完成则直接执行；否则选专用 SubAgent..." |
| **374** (task_delegation_block) | "判断标准：1-2 次工具调用能完成的，直接做" |

**建议**: 保留一处即可，`task_delegation_block` 中的表述更具体，可保留；`request_routing` 可精简。

---

### 1.13 collaboration_protocol 与 tool_usage 中的 SubAgent 内容重叠

**collaboration_protocol** (444-451) 包含：
- 委派时必须提供完整上下文
- 委派描述包含：目标、输入文件路径、期望输出格式、关键约束
- SubAgent 返回后整合结果并向用户呈现

**tool_usage** 中的 subagent_section (273-291) 和 task_delegation_block (367-388) 包含：
- 可用 SubAgent 列表
- 场景选择指南表
- 核心规则：每次 task() 必须把前一步关键输出嵌入 description
- SubAgent 返回对用户不可见，须整合后呈现
- 直接执行 vs 委派的判断标准
- 典型协作流程

**重叠点**:
- "委派必须提供完整上下文" vs "每次 task() 必须把前一步关键输出嵌入 description" — 语义相同
- "SubAgent 返回后整合并向用户呈现" — 与 system_communication、output_format 重复

**建议**:
- `collaboration_protocol` 中「与 SubAgent 协作」保留：角色定位（Orchestrator vs 专家）、模式与 SubAgent 的协作（Agent/Plan/Debug/Ask）。
- 删除 collaboration_protocol 中关于「委派描述包含...」「整合结果并向用户呈现」的重复，改为引用 tool_usage。
- 将 subagent_section 的「核心规则」与 collaboration_protocol 合并，避免两处都写委派规则。

---

## 2. 矛盾 (Contradictions)

### 2.1 无明显直接矛盾

未发现「必须做 X」与「禁止做 X」的直接冲突。

### 2.2 潜在张力

| 位置 A | 位置 B | 说明 |
|--------|--------|------|
| **384** (tone_and_style): "每轮对话只产出一条最终回复" | **459** (collaboration_protocol): "每完成一个关键步骤，简要汇报进展" | "只产出一条" 与 "每步汇报" 可能冲突。建议明确：工具调用过程中的中间汇报可简短，最终回复仍为一条。 |
| **383** (tone_and_style): "能直接回复的就直接回复" | **365** (request_routing): "不需要（凭已有知识）→ 直接回复" | 语义一致，无矛盾。 |

---

## 3. 模糊或弱指令 (Vague / Weak Instructions)

### 3.1 过于模糊

| 行号 | 内容 | 问题 | 建议 |
|------|------|------|------|
| **375** | "确保所有必需参数都已提供或可从上下文合理推断" | "合理推断" 边界不清 | 补充示例：如路径可从 user_attachments 推断；或明确 "无法推断时用 ask_user" |
| **411** | "用户可能通过引用符号（如 @ 或附件名）指代特定文件或资源，需解析为实际路径" | "解析" 未说明方法 | 补充：优先在 user_attachments、open_files 中查找对应路径 |
| **461** | "发现与用户预期不符时，及时说明原因和替代方案" | "及时" 未定义 | 可改为 "在下一步操作前说明" |
| **468** | "不隐瞒不确定性。信息不足时说明缺口，而非编造。" | 与 tone_and_style 中 "无依据不输出" 的关系不清 | 可合并为一条：信息不足时说明缺口并标注「待澄清」，不编造 |

### 3.2 可操作性不足

| 行号 | 内容 | 建议 |
|------|------|------|
| **427** | "遇到困难时主动寻找替代方案，而非放弃或降低标准" | 补充 1-2 个替代方案示例（如换工具、分步执行、ask_user） |
| **531** | "连续 2 次失败则反思方向" | 明确 "反思" 的产出：如记录到 CONTEXT.md 或 ask_user |
| **569** | "修改后验证：代码文件可用 python_run 测试；文档文件检查格式完整性" | 文档 "格式完整性" 过于笼统，可引用 document_quality_check |

---

## 4. 缺失覆盖 (Missing Coverage)

基于 5 层架构检查：

| 层级 | 状态 | 缺口 |
|------|------|------|
| **Layer 0 身份** | ✅ | 有角色/无角色均有 |
| **Layer 1 OS 层** | ⚠️ | 缺少明确的「多轮对话上下文管理」：何时截断、何时引用历史。当前仅在 request_routing 中提 "新请求优先"，未说明长对话策略。 |
| **Layer 2 模式层** | ✅ | 由 mode_config 注入 |
| **Layer 3 角色层** | ✅ | 由 roles.json 注入 |
| **Layer 4 业务能力** | ⚠️ | knowledge_graph_context 仅在有实体/关系时详细说明；无数据时说明过简。BUNDLE 和 project_memory 由 deep_agent 拼接，此处无引用说明。 |
| **Layer 5 运行时** | ✅ | 由 dynamic_prompt 注入 |

### 具体缺口建议

1. **多轮对话策略**：在 `request_routing` 或新建 `conversation_context` 中补充：长对话时优先依赖最近 N 轮和关键结论，避免重复展开全文。
2. **BUNDLE 与 project_memory 的用法**：在 Layer 4 或 `use_skills` 附近加一句："BUNDLE 和 project_memory 由系统注入，优先按其中流程执行。"
3. **human_checkpoints**：`get_human_checkpoints_prompt` 存在，但主提示词中未说明与 request_routing、task_management 的关系，可加一句引用。

---

## 5. Token 效率 (Token Efficiency)

### 5.1 可压缩的段落

| 段落 | 行号 | 当前约 token 数 | 建议 | 预计节省 |
|------|------|-----------------|------|----------|
| **drive_and_responsibility** | 428-482 | ~350 | 合并「任务承诺」「主动性」「质量意识」为 3-4 条；删除与 tone_and_style、making_changes 重复的自检项 | ~120 |
| **collaboration_protocol** | 444-465 | ~400 | 删除与 tool_usage 重复的 SubAgent 规则；精简「信息透明度」为 1-2 句 | ~150 |
| **think_tool 段落** | 494-519 | ~400 | 保留「何时必须/不必须」和「思考质量要求」；「思考模板」可缩短或删除 | ~100 |
| **task_management** | 532-561 | ~280 | 示例可缩短；"何时不使用" 3 条可合并为 1 条 | ~80 |
| **document_quality_check** | 593-622 | ~250 | 各文件类型的检查可改为表格或更紧凑的列表 | ~80 |

### 5.2 精简示例

**drive_and_responsibility 精简版**（保留核心，删除重复）:
```
<drive_and_responsibility>
- 接受任务即承诺交付；遇困难主动找替代方案。
- 交付前自检：完整性、准确性（有依据）、可用性。不达标不交付。
- 主动：补信息缺口、预警风险、建议下一步。
- 失败时分析根因并记录到 CONTEXT.md；重要产出路径写入 CONTEXT.md。
</drive_and_responsibility>
```
（删除与 tone_and_style 重复的「结论须有依据」「回复前自检」等）

---

## 6. 顺序问题 (Ordering Issues)

### 6.1 引用顺序

| 问题 | 位置 | 说明 |
|------|------|------|
| **task_delegation_block 引用 subagent_section** | 448 | collaboration_protocol 中的 `+ subagent_section` 会将 subagent_section（含场景表、核心规则）插入「与 SubAgent 协作」中间。subagent_section 在 273-291 行定义，collaboration_protocol 在 444 行使用，顺序正确。 |
| **tool_usage 引用 task_delegation_block** | 484-485 | task_delegation_block 在 367 行定义，tool_usage 在 484 行使用，顺序正确。 |

### 6.2 逻辑顺序建议

当前顺序：identity → system_communication → request_routing → tool_calling → tone_and_style → resource_awareness → drive_and_responsibility → collaboration_protocol → tool_usage → task_management → security → workspace_layout → version_awareness → error_recovery → making_changes → document_quality_check → output_format

**建议**:
- `resource_awareness`（资源优先级）应在 `request_routing`（决策流）之前，因为决策依赖资源优先级。当前 request_routing 在 358 行，resource_awareness 在 414 行，顺序可考虑对调。
- `tool_calling` 与 `tool_usage` 相邻合理，但 `tool_usage` 中大量引用工具策略，而 `tool_strategy_block` 在 296 行已定义，无顺序问题。

---

## 7. 重点段落专项分析

### 7.1 collaboration_protocol vs tool_usage

| 维度 | collaboration_protocol | tool_usage |
|------|------------------------|------------|
| **定位** | 协作规范（与用户、SubAgent、信息透明度） | 工具使用策略（选择、组合、委派决策） |
| **SubAgent 内容** | 角色关系、委派原则、模式协作、subagent_section 全文 | task_delegation_block（直接执行 vs 委派、典型流程） |
| **重叠** | 委派须提供完整上下文、整合结果呈现 | 同上 + 场景表、核心规则 |
| **建议** | 保留：与用户协作、Orchestrator 角色、模式与 SubAgent 关系。删除：委派描述格式、整合呈现（改引用 tool_usage/output_format） | 保留：subagent_section、task_delegation_block 作为 SubAgent 的权威说明。collaboration_protocol 中不再重复嵌入 subagent_section，可改为 "详见 tool_usage 中的 SubAgent 委派策略" |

### 7.2 drive_and_responsibility

| 问题 | 说明 |
|------|------|
| **篇幅** | 约 25 行，为 Layer 1 中最长段落之一 |
| **说教感** | "任务承诺""主动性""质量意识""持续改进""回复前自检" 等小标题偏抽象，可读性一般 |
| **重复** | 与 tone_and_style（依据、待澄清）、making_changes（自检）、version_awareness（CONTEXT.md）有重叠 |
| **建议** | 压缩为 8-10 行；删除与其它段落重复的自检项；用更具体的动作替代抽象表述，如 "发现废标条款时主动标注" 而非 "发现潜在风险时主动预警" |

### 7.3 resource_awareness vs tool_usage

| 维度 | resource_awareness | tool_usage |
|------|--------------------|------------|
| **内容** | 资源优先级、使用原则、权限边界 | 工具选择、策略、组合、委派 |
| **重叠** | "先本地后联网""先精确后模糊""先摘要后全文" | duckduckgo "先本地后联网"；"大文件先 grep 再 read_file" |
| **建议** | resource_awareness 专注「有哪些资源、优先级、权限」；tool_usage 专注「用什么工具、怎么组合」。原则性策略（先本地后联网、大文件策略）只在 resource_awareness 保留，tool_usage 引用即可 |

### 7.4 making_changes vs document_quality_check

| 维度 | making_changes | document_quality_check |
|------|----------------|------------------------|
| **行数** | ~18 行 | ~30 行 |
| **内容** | 修改前 read、优先 edit_file、最小改动、修改后验证、不主动创建 md、长内容写 output_dir、Office 文件规范 | 按文件类型（Word/Excel/PDF/MD）的验证与检查项 |
| **比例** | 合理 | document_quality_check 略长，且与 making_changes 的「修改后验证」有重叠 |
| **建议** | making_changes 中「修改后验证」改为 "见 document_quality_check"；document_quality_check 可改为表格或更紧凑的列表，减少约 30% 篇幅 |

---

## 8. 总结与优先建议

### 高优先级（减少冗余、降低 token）

1. **合并 SubAgent 整合规则**：仅在 output_format 保留完整表述，system_communication 和 collaboration_protocol 精简为引用。
2. **合并附件 read_file 规则**：在 resource_awareness 保留完整说明，其它处引用。
3. **精简 drive_and_responsibility**：删除与 tone_and_style、making_changes、version_awareness 的重复，压缩至约 10 行。
4. **拆分 collaboration_protocol 与 tool_usage**：collaboration_protocol 不再嵌入 subagent_section，改为引用 tool_usage；删除委派规则重复。

### 中优先级（清晰度与一致性）

5. **合并「结论须有依据」**：统一放在 tone_and_style 或 drive_and_responsibility 一处。
6. **合并「长输出写 output_dir」**：在 workspace_layout 保留，它处引用。
7. **resource_awareness 与 tool_usage 分工**：原则只在 resource_awareness，tool_usage 引用。

### 低优先级（可选优化）

8. **补充多轮对话策略**：在 request_routing 或新段落中简要说明。
9. **document_quality_check 压缩**：改为表格或更紧凑格式。
10. **think_tool 模板缩短**：保留何时用/不用和质量要求，模板可精简。

---

*报告完成。建议按优先级分批修改，每次修改后做一次端到端测试，确保行为不变。*
