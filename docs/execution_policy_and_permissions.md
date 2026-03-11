# 执行策略与权限说明

本文档说明 Agent 工具执行的策略配置与权限边界，为 **Python/Shell 行为与文件访问权限的唯一配置与说明来源**。

**本文档涵盖**：`execution_policy` 字段（结构、python/shell/file_write）、**文件工作区边界**（请求级 workspace_path、Backend root_dir）、**Python/Shell 执行策略**（超时、blocked_patterns、allow_commands、工作目录约束）、**自治等级与策略的叠加关系**（L0–L3 与 execution_policy 的配合）。上述四类配置与说明以本文档为准，实现见各节引用。

## 1. 配置源：`.maibot/settings.json`

执行策略从工作区下的 `.maibot/settings.json` 读取，键为 `execution_policy`。实现见 `backend/tools/base/code_execution.py` 的 `load_execution_policy()`（按文件 mtime 缓存，避免每次读盘）。

### 1.1 结构约定

```json
{
  "execution_policy": {
    "python": { ... },
    "shell": { ... },
    "file_write": { ... }
  }
}
```

未配置或缺失时，使用代码中的 `DEFAULT_EXECUTION_POLICY` 默认值。

---

## 2. Python 执行策略（`execution_policy.python`）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `max_timeout` | int | 120 | 单次执行最大秒数 |
| `blocked_patterns` | string[] | 见下 | 代码中出现即拒绝执行（子串匹配） |

默认 `blocked_patterns` 包含：`os.system(`, `subprocess.Popen(`, `subprocess.run(`, `pty.spawn(`, `exec(`, `eval(`, `compile(` 等。

**路径约束**：`python_run` 执行前会对 `open(..., write-mode)` 做校验，仅允许**工作区内字面量路径**；动态写路径（如变量拼接）直接拒绝。工作区根由当前请求的 `configurable.workspace_path` 或全局 fallback 决定。

---

## 3. Shell 执行策略（`execution_policy.shell`）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `max_timeout` | int | 60 | 单次命令最大秒数 |
| `allow_outside_workspace` | bool | false | 为 true 时允许 `working_directory` 指向工作区外 |
| `blocked_patterns` | string[] | 见下 | 命令命中即拒绝 |
| `allow_commands` | string[] | [] | 非空时仅允许以此列表项为前缀的命令（白名单） |

默认 `blocked_patterns` 包含：`rm -rf /`, `mkfs`, `shutdown`, `reboot`, `curl \| sh`, `wget \| sh`, 以及 fork 炸弹等。

**工作目录**：`resolve_shell_working_directory()` 默认只允许在工作区根或其子目录下执行；`allow_outside_workspace === true` 时可指定工作区外路径。

**安全检测**：除策略外，还会做 `detect_shell_bypass_risk`（如 `$()`、反引号、base64\|sh 等）检测，命中即拒绝。

---

## 4. 自治等级与工具审批（L0–L3）

自治等级（L0–L3）由 `.maibot/settings.json` 的 `autonomous.level` 及 License 上限共同决定，见 `backend/engine/autonomy/levels.py`。`autonomous.auto_accept_tools` 为字符串数组，列出「默认接受」的工具，这些工具执行前不中断。

- **L0/L1**：写/执行类工具在聊天区展示 diff 或预览，用户点击接受/拒绝后再执行；若工具在 `auto_accept_tools` 中则直接执行。
- **L2/L3**：文件类（write_file、edit_file、delete_file、python_run）默认不中断；仅 shell_run（及可选 python_run）仍可配置为需确认。对 `shell_run` 仍执行：`is_shell_command_blocked()`、绕过风险检测（bypass）、破坏性模式检测（`DESTRUCTIVE_SHELL_PATTERNS`）。

即：**Python/Shell 的行为与权限由 `execution_policy` 唯一决定**；自治等级只影响“是否需审批”以及 L2/L3 下对 Shell 的额外安全校验，不改变策略字段含义。

---

## 5. 文件类工具与工作区边界

### 5.1 权限边界

- **可访问范围**：仅限**当前请求的工作区**（`configurable.workspace_path` 解析出的根目录）。工作区外的路径不可访问。
- **实现**：Backend 在创建时使用请求级 `workspace_path` 作为 `root_dir`（方案 A），不再依赖全局 `set_workspace_root`，避免并发请求下文件工具用错工作区。详见 `backend/engine/agent/deep_agent.py` 的 `create_backend(runtime)`。
- **上传目录**：当前请求工作区下的 `uploads/` 目录，与 default Backend 使用同一工作区根。

### 5.2 与 API 层的区别

- **Agent 文件工具**：通过 DeepAgent 的 FilesystemBackend，root 为请求级工作区根。
- **API 层读写**：如 `backend/api/common.py` 的 `resolve_read_path` / `resolve_write_path`，限制在 PROJECT_ROOT / WORKSPACE_DIR 内，并含敏感路径与文件名规则过滤。

---

## 6. 工具审批与 Diff（Cursor 一致）

需权限/变更的工具（write_file、edit_file、delete_file、shell_run、python_run）**不采用系统原生弹窗或单独权限对话框**，而是在**聊天区**对应工具执行处展示执行详情（文件类为 diff，命令/代码类为预览），并提供**接受/拒绝**按钮。执行失败时在工具卡结果区展示错误并可重试，不弹出系统对话框。配置项 `autonomous.auto_accept_tools` 可指定默认接受的工具，勾选后该工具不再中断；`autonomous.level`（L0–L3）与 `require_tool_approval` 控制是否中断。详见 `backend/engine/middleware/diff_approval_middleware.py`、前端 `InterruptDialog`（`tool_diff_approval` 类型）、设置页「自治等级」与「默认接受以下工具」。

**同一会话内连续**：确认或拒绝后 run 在同一会话内继续（不中断会话）；接受则执行该操作并继续后续步骤，拒绝则跳过该操作、会话继续。前端 `onResolved({ run_id })` 可接流续显。部分场景可扩展为「先执行再确认」：执行后在工具卡展示 diff，用户通过接受/拒绝决定保留编辑或回退（回退需后端支持写入原内容）。

---

## 7. 单轮搜索次数软性提示（可选）

当上一轮 assistant 消息中 `search_knowledge` / `web_search` 调用次数超过 3 次时，本轮 system 会注入简短提醒：“上一轮已进行多次知识/联网检索，本轮请优先基于已有结果作答”。实现位置：

- 编排层统计：`backend/engine/core/main_graph.py` 的 `_prepare_agent_config` 中根据 `messages` 统计上一轮搜索工具调用数，写入 `configurable["_search_call_count_last_round"]`。
- 提示注入：`backend/engine/prompts/agent_prompts.py` 的 `get_orchestrator_prompt` 中若该值 > 3 则追加 `<search_restraint_hint>` 段落。

不硬性拦截工具调用，仅做软性引导。

---

## 8. 编辑区与工作区操作（与 Cursor 一致）

- **工作区真源**：前端以 `maibot_workspace_path` 为单一真源；发送消息时 config 传入 `workspace_path`，后端 create_backend 与 prompt_cfg 均使用该请求级路径，所有编辑区与工作区文件操作均以**当前工作区为根**，与 Cursor 一致。
- **工作区切换**：用户切换工作区后前端派发 `EVENTS.WORKSPACE_CONTEXT_CHANGED`；MyRuntimeProvider 监听后清空上下文并派发 `NEW_THREAD_REQUEST`，toast 建议新建对话线程，避免跨工作区上下文污染（见 domain-model.mdc §2.1）。
- **文件树与后端**：WorkspaceFileTree 切换目录后写入 `maibot_workspace_path` 并通知后端；文件树创建/重命名/删除等操作若走后端 API，均以当前前端的 `maibot_workspace_path` 为 scope；Electron 本地先改再同步时，与后端 refresh/sync 约定一致。
- **线程列表过滤**：thread-list 按 `metadata.workspace_path` 过滤，仅展示当前工作区下的会话。

---

## 9. 模式与工具权限、编辑区 diff 与聊天区 Apply

- **模式工具权限**：五种模式（Agent/Ask/Plan/Debug/Review）的工具允许范围由 `backend/engine/modes/mode_config.py` 定义（allowed_tools/denied_tools）；`get_mode_tools` 在 create_orchestrator_agent 中用于过滤工具列表，Ask 仅只读、Debug/Review 部分写。契约见 mode_config.py 与 cursor_alignment_checklist.md §2.9。
- **编辑区 diff 与聊天区 Apply**：聊天区「应用」代码到文件时，统一派发 `EVENTS.OPEN_FILE_IN_EDITOR`，携带 `path`、`showDiff: true`、`diffOriginal`（Apply 前 readFile 所得），编辑区监听后打开文件并展示 diff。markdown 代码块与 generative-ui CodeUI 的 Apply 行为一致；EditFile 工具卡「在编辑器中打开 (diff)」有 old/new 时同样派发该事件并传 diffOriginal/diffContent。见 cursor_alignment_checklist.md §2.9、FullEditorV2Enhanced 对 OPEN_FILE_IN_EDITOR 的处理。

---

## 10. 参考

- 策略加载与默认值：`backend/tools/base/code_execution.py`（`load_execution_policy`, `DEFAULT_EXECUTION_POLICY`）
- Shell 策略与工作目录：`is_shell_command_blocked`, `resolve_shell_working_directory`, `detect_shell_bypass_risk`
- 自治等级与 Shell：`backend/engine/autonomy/levels.py`（`explain_tool_policy_by_level`, `get_autonomy_settings`, `DESTRUCTIVE_SHELL_PATTERNS`）
- 工具审批与 Diff：`backend/engine/middleware/diff_approval_middleware.py`（DiffAwareHumanInTheLoopMiddleware，为 write_file/edit_file/delete_file/shell_run/python_run 注入 diff/preview）
- Backend 请求级工作区：`backend/engine/agent/deep_agent.py`（`create_backend`）
- 模式对工具的允许/禁止：`backend/engine/modes/mode_config.py`、`backend/engine/middleware/mode_permission_middleware.py`
- 搜索节制与单轮提示：`backend/engine/prompts/agent_prompts.py`（resource_awareness、search_restraint_hint）
- 工作区与会话模型：`.cursor/rules/domain-model.mdc`；前端 WORKSPACE_CONTEXT_CHANGED：`MyRuntimeProvider.tsx`、`WorkspaceFileTree.tsx`
- 五模式与 Diff 对齐：`docs/cursor_alignment_checklist.md` §2.9
