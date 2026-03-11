# 自主生存型智能体系统架构设计文档 v2.0

> 文档编号：ARCH-2026-002
> 创建日期：2026-02-28
> 状态：已批准
> 作者：系统架构设计（人机协同）
> 关联文档：[产品设计文档](../knowledge_base/docs/产品设计文档.md)、[LangChain 生态集成指南](LANGCHAIN_ECOSYSTEM_INTEGRATION_GUIDE.md)

---

## 1. 第一性原理：为什么构建这个系统

### 1.1 人类的根本需求

从哲学角度，人类的一切行为归结为两个驱动力：**生存**与**繁衍**。

在现代社会，这两个驱动力被转化为：获取资源 → 参与竞争 → 积累优势 → 扩展影响力。每个人都在用自己的时间、知识、技能参与这场竞争，但人的时间是有限的，注意力是稀缺的，知识存在边界。

### 1.2 智能体的定位

本系统不是一个"聊天机器人"或"效率工具"，而是用户在数字世界中的**竞争力放大器**。

```
用户的竞争力 = 自身能力 × 数字员工数量 × 数字员工质量 × 协作效率
```

智能体帮助用户的方式不是"等用户吩咐"，而是：
- 主动探索世界、积累知识和经验
- 空闲时自我改进、提升能力
- 发现机会、评估价值、建议行动
- 扩展为多个专长不同的数字员工，覆盖更多竞争维度
- 通过蒸馏将云端大模型的能力沉淀到本地小模型，降低长期成本

### 1.3 价值循环

```
用户提供资源（算力/电力/网络） → 智能体提升能力 → 帮用户创造更多价值
      ↑                                                    ↓
      ←────── 用户获得更多资源，继续投入 ──────────────────←
```

智能体越强大 → 为用户创造的价值越多 → 用户愿意投入更多资源 → 智能体更强大。这是一个正向飞轮。

---

## 2. 技术生态选型：站在巨人肩上

### 2.1 核心原则

**不重复造轮子。** LangChain/LangGraph 生态已经提供了 Agent 开发所需的 90% 基础设施。本系统的价值在于**架构设计**和**业务逻辑**，而非底层框架。

### 2.2 LangChain/LangGraph 生态对齐

| 本系统需求 | LangChain/LangGraph 方案 | 版本 |
|---|---|---|
| Agent 编排 | LangGraph StateGraph + create_agent | 1.0+ |
| 会话持久化 | LangGraph Checkpointer (SQLite) | 1.0 |
| 长期记忆 | LangGraph Store + langmem | 1.0 |
| 流式输出 | LangGraph stream_mode + SSE | 1.0 |
| 子代理 | SubAgent 中间件（上下文隔离） | 内置 |
| 人类确认 | interrupt_on + HumanInTheLoop 中间件 | 1.0 |
| 模型抽象 | ChatModel 统一接口（OpenAI/Anthropic/本地） | 1.0 |
| 工具集成 | MCP (Model Context Protocol) | 生态 |
| 定时任务 | LangGraph Platform Cron Jobs | Platform |
| 后台执行 | LangGraph Background Runs | Platform |
| 多智能体 | A2A Protocol + Agent Card | 标准 |
| 监控调试 | LangSmith | 云服务 |

### 2.3 与 LangChain 版本同步策略

本系统核心依赖随 LangChain/LangGraph 升级而升级：

- **锁定 langgraph >= 1.0**：利用 v1.0 稳定性承诺（无破坏性变更直到 v2.0）
- **追踪 langchain-community**：新的 MCP 工具、模型提供者、集成组件
- **关注 LangGraph Platform 特性**：Cron、Background Run、A2A endpoint 等平台能力在本地复刻或直接使用
- **参与社区**：MCP 服务器注册表、LangChain Hub 的 Prompt/Chain/Agent 模板

### 2.4 Claude Agent SDK 对齐

| Claude 设计模式 | 本系统实现 |
|---|---|
| Gather-Act-Verify 循环 | 提示词 Layer 1 显式建模 |
| 极简工具 + 组合万能 | MCP 工具分层（查询/操作/视觉） |
| Screenshot-Action Loop | Computer Use 工具组 |
| 渐进式权限 (auto-approve) | L0-L3 自主级别 |
| Background Agents | 空闲自主循环引擎 |
| MCP 动态发现 | MCP Gateway + 语义搜索匹配 |

---

## 3. 系统演进路线

### 3.1 三阶段演进

```
Phase 1：单体强化           Phase 2：组织化              Phase 3：生态化
┌───────────────┐     ┌───────────────────┐     ┌───────────────────┐
│ 一个Agent      │ →   │ 多个Agent协作       │ →   │ Agent经济体        │
│                │     │                   │     │                   │
│ · 强环境操控    │     │ · 共享知识/记忆/资源 │     │ · 对外提供服务      │
│ · 空闲自我进化  │     │ · 任务分工+集体学习  │     │ · 自主获取资源      │
│ · 目标驱动     │     │ · 自主繁殖新Agent   │     │ · 参与市场竞争      │
│ · 多窗口/角色   │     │ · Agent内部通信→A2A │     │ · 钱包+交易+定价    │
│ · 自发现工具    │     │ · 组织级资源池      │     │ · 跨用户知识市场     │
│ · 知识蒸馏     │     │ · 组织级成本账本     │     │ · 自主申请云算力     │
└───────────────┘     └───────────────────┘     └───────────────────┘
```

### 3.2 各阶段的本质区别

**Phase 1（单体）** 的核心能力：
- 已有多窗口/多角色（`window-create-worker` IPC），这是"单体内的多工"
- 多个会话（Thread）之间共享 Store，这是同一个 Agent 的"多线程"
- 自发现和安装新 MCP 工具（通过 MCP Gateway 语义搜索）
- 自我代码修改（propose-review-test-commit）
- 空闲时自主探索世界、积累知识、改进自身

**Phase 2（组织化）** 的核心变化：
- 不是"新功能"，而是**通信范围扩大**：同一台机器内的多会话通信 → 跨进程/跨机器的 A2A 通信
- Agent Protocol 让每个实例自描述、可发现、可评估
- 共享层让知识和经验能跨 Agent 传播
- 繁殖是"创建新的专长 Agent 并注册到 A2A 网络"

**Phase 3（生态化）** 的核心变化：
- 不是"更多 Agent"，而是**价值交换机制**：钱包、定价、交易、服务市场
- 数字员工可以"出租"给其他用户
- 知识和 Skills 可以交易
- Agent 可以自主申请和管理云计算资源

### 3.3 与产品设计文档的对应

| 架构阶段 | 产品阶段 | 对应关系 |
|---|---|---|
| Phase 1 单体强化 | Phase 1 数字员工工作台 | 一致：单机版，强能力 |
| Phase 2 组织化 | Phase 2 数字员工增强站 | 一致：联网，云端增强 |
| Phase 3 生态化 | Phase 3-4 数字劳务市场+生态 | 一致：交易，市场，生态 |

---

## 4. Phase 1 架构：单体强化

### 4.1 双循环引擎

系统运行两个并行循环：

**循环一：任务循环（Gather-Act-Verify）** — 用户/触发器驱动
```
收集信息 → 采取行动 → 验证结果 → 循环直到完成
```

**循环二：进化循环（Explore-Learn-Improve）** — 空闲时自驱动
```
读取目标 → 选择目标 → 执行 → 记日志 → 反思 → 自我修改 → 循环
```

两个循环共享工具层和知识库，但有独立的 Thread（会话上下文）。

```
┌─────────────────────────────────────────────────┐
│                  Agent 实例                       │
│                                                  │
│  ┌──────────────┐      ┌──────────────────┐     │
│  │  任务循环     │      │   进化循环         │     │
│  │  (GAV)       │      │   (ELI)           │     │
│  │              │      │                   │     │
│  │ 用户对话     │      │ 空闲检测触发       │     │
│  │ 触发器事件   │      │ 目标栈驱动         │     │
│  │ 斜杠命令     │      │ 默认=自我改进      │     │
│  └──────┬───────┘      └────────┬──────────┘     │
│         │                       │                │
│         └───────┬───────────────┘                │
│                 ↓                                 │
│  ┌──────────────────────────────────────┐        │
│  │         工具能力层 (MCP)              │        │
│  │  macOS操控 · Computer Use · 网络      │        │
│  │  文件操作 · 代码修改 · A2A通信        │        │
│  └──────────────────────────────────────┘        │
│                 ↓                                 │
│  ┌──────────────────────────────────────┐        │
│  │         知识与记忆                     │        │
│  │  技能库 · 本体 · 经验模式 · 日志       │        │
│  │  世界知识 · 成本账本 · 蒸馏样本        │        │
│  └──────────────────────────────────────┘        │
└─────────────────────────────────────────────────┘
```

### 4.2 渐进式自主级别

| 级别 | 名称 | 工具权限 | 进化循环 | 代码修改 |
|---|---|---|---|---|
| L0 | 手动 | 全部需确认 | 关闭 | 禁止 |
| L1 | 辅助 | 只读自动，写需确认 | 仅学习 | 禁止 |
| L2 | 半自主 | 低风险自动 | 探索+学习+提案 | 仅生成提案 |
| L3 | 完全自主 | 全部自动（危险除外） | 全部 | propose-review-test-commit |

权限矩阵 = f(自主级别, 操作类型, 操作风险)

配置位置：设置 → 高级 → 自主级别

### 4.3 工具能力层

#### 4.3.1 macOS 查询工具（只读，L1+ 自动）

| 工具 | 功能 | 实现方式 |
|---|---|---|
| `get_active_app` | 当前前台应用+窗口标题 | AppleScript |
| `get_clipboard` | 剪贴板内容 | 已有 |
| `get_system_info` | CPU/内存/磁盘/电池/网络 | system_profiler + top |
| `get_process_list` | 进程列表 | ps aux |
| `get_calendar_events` | 日历事件 | Shortcuts CLI |
| `get_screen_text` | 屏幕 OCR | screencapture + tesseract |
| `get_open_files` | 应用打开的文件 | lsof + AppleScript |
| `get_recent_files` | 最近使用的文件 | mdfind -onlyin |
| `search_spotlight` | Spotlight 搜索 | mdfind |
| `get_wifi_info` | WiFi 信息 | networksetup + airport |

#### 4.3.2 macOS 操作工具（按自主级别控制）

| 工具 | 功能 | 风险级别 |
|---|---|---|
| `set_clipboard` | 设置剪贴板 | 低（L2+） |
| `run_applescript` | 执行 AppleScript | 中（L2+） |
| `run_shortcut` | 执行快捷指令 | 中（L2+） |
| `manage_window` | 窗口管理 | 低（L2+） |
| `launch_app` / `quit_app` | 应用启停 | 中（L3） |
| `send_keystroke` | 模拟键盘 | 高（L3） |
| `send_notification` | 系统通知 | 低（L1+） |
| `open_url` | 打开 URL | 低（L1+） |

#### 4.3.3 Computer Use（Screenshot-Action Loop）

| 工具 | 功能 | 实现 |
|---|---|---|
| `screenshot` | 截屏（已有，增加 region） | screencapture |
| `computer_use_click` | 鼠标点击 | cliclick |
| `computer_use_type` | 键盘输入 | cliclick |
| `computer_use_scroll` | 滚动 | cliclick |
| `computer_use_drag` | 拖拽 | cliclick |

每步操作后自动截屏反馈（base64 图片），形成 Claude 标准 Screenshot-Action Loop。

#### 4.3.4 MCP 动态工具发现

参照 Claude Tool Search 和 MCP Gateway Registry：
- 语义搜索匹配：Agent 描述需求 → FAISS 索引匹配可用 MCP 工具
- 运行时安装：发现合适的 MCP Server → 下载 → 注册 → 使用
- 工具索引更新：定期同步 MCP 社区注册表

### 4.4 空闲自主循环引擎

#### 4.4.1 空闲检测

Electron 层通过 `powerMonitor.getSystemIdleTime()` 检测空闲：
- 用户无交互 > N 分钟（可配置，默认 5 分钟）→ 发送 `idle-state-changed` IPC
- 全屏应用/演示模式 → 暂停
- 系统负载过高 → 暂停

#### 4.4.2 目标栈

文件：`goals/active.md`

```markdown
## 战略目标
- 提升代码编写能力到独立完成中等项目
- 积累 10 个行业领域的专业知识

## 当前目标
- [ ] 探索本机开发工具，建立能力地图
- [ ] 分析最近 7 天任务日志，找出效率瓶颈

## 默认目标（无其他目标时）
- 审查自身代码质量
- 搜索并学习热门技术趋势
- 运行 benchmark 测试自身能力
```

目标来源：LLM 自主生成 / 用户 `/goals add` / 触发器事件转化

#### 4.4.3 进化循环流程

```
1. 读取目标 → goals/active.md
2. 选择目标 → LLM 评估优先级和可行性
3. 规划 → 分解为步骤
4. 执行 → Gather-Act-Verify
5. 记日志 → journal/YYYY-MM-DD.md
6. 反思 → 提取经验模式
7. 自我修改 → 受自主级别控制
8. 循环
```

### 4.5 自我进化

#### 4.5.1 代码修改流程（L3）

```
Propose → Review → Test → Commit
  │          │        │       │
  LLM生成    第二模型   运行测试  git commit
  修改提案    交叉审查   必须通过  便于回滚
```

#### 4.5.2 知识蒸馏

利用已有的 `DistillationMiddleware`：
- 云端强模型处理任务时，自动捕获高质量（输入，输出）对
- 用户纠正时提取偏好对（chosen, rejected）
- 积累到 `distillation_samples.jsonl`
- 定期导出用于本地模型微调

参照 AgentArk 的分层蒸馏策略：
- 推理增强微调（reasoning-enhanced fine-tuning）
- 轨迹增强（trajectory-based augmentation）
- 过程感知蒸馏（process-aware distillation）

#### 4.5.3 日志与成本核算

**日志**：`journal/YYYY-MM-DD.md`
- 任务执行记录（数量/成功率/耗时）
- 空闲探索记录
- 自我改进记录
- 反思和计划

**成本账本**：`data/cost_ledger.jsonl`
```json
{"task_id":"...","tokens_in":1200,"tokens_out":800,"model_cost_usd":0.003,"duration_sec":45,"outcome":"success"}
```

### 4.6 交互设计（Cursor 风格）

#### 4.6.1 斜杠命令

现有 6 个命令 + 新增 7 个：

| 命令 | 功能 | 示例 |
|---|---|---|
| `/status` | 系统状态巡检 | 已有 |
| `/compact` | 上下文压缩 | 已有 |
| `/memory` | 记忆检索 | 已有 |
| `/skills` | 技能检索 | 已有 |
| `/learn` | 学习点记录 | 已有 |
| `/persona` | 人格配置 | 已有 |
| `/trigger` | 触发器管理 | `/trigger add cron "0 9 * * *" "晨报"` |
| `/scan` | 环境扫描 | `/scan network` `/scan screen` |
| `/goals` | 目标管理 | `/goals add "学习 React"` |
| `/approve` | 自主级别 | `/approve L2` |
| `/evolve` | 进化循环 | `/evolve now` `/evolve status` |
| `/journal` | 查看日志 | `/journal today` |
| `/cost` | 成本统计 | `/cost today` |

#### 4.6.2 UI 变更（最小化）

- 设置 → 系统 → 新增"触发器"面板
- 设置 → 高级 → 新增"自主级别"面板
- 输入框输入 `/` → 命令提示菜单
- 通知中心 → 新增 `trigger` 和 `evolution` 通知类型
- Electron → Tray 常驻 + 全局快捷键 + 空闲检测

---

## 5. Phase 2 架构：组织化

### 5.1 从单体到组织的关键：Agent Protocol

每个 Agent 实例遵循统一协议：

```python
@dataclass
class AgentIdentity:
    agent_id: str
    name: str
    capabilities: list[str]
    goals: list[str]
    autonomy_level: int       # L0-L3
    status: str               # idle / working / evolving
    cost_budget: float
    knowledge_domains: list
    performance_stats: dict   # success_rate, avg_duration, roi
```

注册到已有的 A2A `network/registry.py`（扩展 `NodeEntry.metadata`）。

LangGraph 已原生支持 A2A endpoint（`/a2a/{assistant_id}`），自动生成 Agent Card。

### 5.2 共享知识层

LangGraph Store 分层命名空间：

```
("agent", "{agent_id}", "private")  → 私有记忆/日志
("agent", "{agent_id}", "goals")    → 目标栈
("shared", "knowledge")             → 共享经验、模式、技能
("shared", "failures")              → 共享失败教训
("shared", "discoveries")           → 共享发现
("org", "resources")                → 组织资源池
("org", "ledger")                   → 组织级成本账本
("board", ...)                      → 任务看板（已有）
("network", "nodes")                → A2A 节点注册（已有）
```

选择性共享逻辑：任务完成后 LLM 判断经验是否值得共享 → 写入对应命名空间。

### 5.3 Agent 繁殖

L3 自主级别下：
1. 识别需求 → 某类任务反复出现但效率低
2. 创建实例 → `window-create-worker` IPC（已有）
3. 配置专长 → Skills + 知识 + 角色提示词
4. 注册 A2A → 新 Agent 加入协作网络
5. 任务分流 → 通过竞标机制（已有 `task_bidding.py`）自动分配

### 5.4 集体学习

```
Agent-A 成功 → 提取模式 → ("shared", "knowledge")
Agent-B 类似任务 → search_memory 检索 → 应用经验
Agent-C 失败 → ("shared", "failures") → 全体避免重复
```

基于已有 `SelfImprovementMiddleware` 模式检测 + `langmem` 工具，扩展命名空间范围。

---

## 6. Phase 3 架构：生态化（远景规划）

### 6.1 价值交换机制

- 钱包系统：加密货币/稳定币微支付（参照 x402 协议）
- 服务市场：数字员工"出租"给其他用户
- 知识交易：Skills 和经验模式的定价与销售
- 算力市场：自主申请和释放云计算资源

### 6.2 跨用户协作

- 组织级任务看板：`("board", "public")` 命名空间已预留
- 信誉系统：基于 Agent 历史绩效的评分
- 标准化 API：遵循 A2A 协议规范，任何兼容 Agent 均可接入

---

## 7. 已有基础设施盘点

本系统已具备大量可直接利用的基础设施：

### 7.1 已有且直接可用

| 组件 | 位置 | 能力 |
|---|---|---|
| A2A 节点注册 | `engine/network/registry.py` | 注册/发现/心跳/广播 |
| 任务竞标 | `engine/tasks/task_bidding.py` | 发布/评估/竞标/决策 |
| 任务看板 | `engine/tasks/task_watcher.py` | 后台巡检/自主调度/超时回收 |
| 自主定时任务 | `config/autonomous_tasks.json` | 11 个定时任务已配置 |
| LangGraph Store | `data/store.db` | SQLite 持久化多命名空间 |
| langmem 记忆 | `tools/base/memory_tools.py` | 语义搜索/分类管理 |
| 多窗口 | `window-create-worker` IPC | 创建独立 Agent 窗口 |
| 自我改进 | `middleware/self_improvement_middleware_v10.py` | 6 种反馈检测+模式提升 |
| 技能进化 | `middleware/skill_evolution_middleware.py` | 统计+自动结晶+Growth Radar |
| 知识学习 | `tools/base/knowledge_learning.py` | 文档扫描+DocMap+本体+技能 |
| 蒸馏 | `middleware/distillation_middleware.py` | 样本捕获+质量门禁+偏好对 |
| 反思 | `middleware/reflection_middleware.py` | 检查点+错误收敛+需求覆盖 |
| 写入策略 | `runtime_write_policy.json` | 4 级写入权限控制 |
| MCP 集成 | `tools/mcp/mcp_tools.py` | 连接池+命名空间+自动重连 |
| macOS 基础 | `plugins/mcp-macos/index.js` | AppleScript+截屏+OCR+剪贴板 |

补充说明（兼容性约束）：
- `task_watcher.py` 中保留 `_parse_schedule()` 与 `_is_due()`，用于兼容既有测试与历史调用方。
- 调度主路径已迁移到 `TriggerManager.due_tasks()`，上述两个函数属于兼容层，不参与新调度主流程。
- 后续如做调度重构，需先替换对应测试与调用方，再移除兼容层，避免出现测试收集期导入失败。
- 详细维护规范见：`docs/task_watcher_compat.md`。

### 7.2 需新建

| 模块 | 文件 | 职责 |
|---|---|---|
| 空闲循环引擎 | `engine/idle/idle_loop.py` | 检测空闲 → 执行进化循环 |
| 目标管理 | `engine/idle/goal_manager.py` | goals/active.md 读写 + 优先级排序 |
| 自我进化 | `engine/idle/self_evolution.py` | propose-review-test-commit |
| 日志系统 | `engine/idle/journal.py` | journal/YYYY-MM-DD.md |
| 成本核算 | `engine/idle/cost_tracker.py` | cost_ledger.jsonl |
| 触发器管理 | `engine/triggers/trigger_manager.py` | Cron + 日历 + 文件监视 |

### 7.3 需扩展

| 文件 | 变更 |
|---|---|
| `plugins/mcp-macos/index.js` | +23 个新工具（查询+操作+ComputerUse） |
| `electron/main.js` | Tray + 全局快捷键 + 空闲检测 |
| `SettingsView.tsx` | 触发器面板 + 自主级别面板 |
| `cursor-style-composer.tsx` | 命令提示菜单 |
| `MyRuntimeProvider.tsx` | 7 个新斜杠命令 |
| `NotificationCenter.tsx` | trigger + evolution 通知类型 |
| `agent_prompts.py` | GAV + ELI 循环提示词 |
| `main_graph.py` | pre_analysis recommended_mode |
| `runtime_write_policy.json` | 按自主级别动态控制 |

---

## 8. 与 LangChain 发展里程碑对齐

### 8.1 紧跟 LangChain 升级的策略

| LangChain 能力 | 本系统利用方式 |
|---|---|
| create_agent 标准化 | 统一 Agent 创建入口 |
| Middleware hooks | 自定义中间件链（已有 15+ 中间件） |
| Node Caching | 加速重复任务 |
| Deferred Nodes | map-reduce 并行子任务 |
| A2A endpoint | Phase 2 多 Agent 通信 |
| Cron Jobs | 替换自研 autonomous_tasks 调度 |
| Background Runs | 空闲循环引擎的执行方式 |
| Tool Search | 大规模工具集的动态加载 |

### 8.2 社区资源利用

- **MCP 服务器注册表**：新工具自动发现和安装
- **LangChain Hub**：Prompt 模板、Chain 模板、Agent 模板
- **LangSmith**：监控、评估、调试
- **langchain-community**：新集成（模型提供者、工具、向量库）

---

## 9. 实施优先级

### 9.1 Phase 1 实施顺序

```
P0 底座（先做）:
  1. macOS 全部工具（一切能力的基础）
  2. 自主级别 L0-L3（一切行为的控制）

P1 引擎（核心价值）:
  3. 空闲自主循环（被动→主动的转折点）
  4. 目标管理系统
  5. 自我进化能力

P2 基础设施:
  6. 日志系统 + 成本核算

P3 交互:
  7. 触发器 + Tray + 快捷键
  8. 斜杠命令 + 命令菜单

P4 提示词:
  9. GAV + ELI 循环 + 模式自主切换
```

### 9.2 Phase 2 启动条件

Phase 1 完成后，当满足以下条件时启动 Phase 2：
- 单体 Agent 稳定运行 > 30 天
- 空闲循环产生可量化的知识积累
- 用户开始使用多窗口/多角色功能
- 蒸馏样本积累到足以微调本地模型

---

## 10. 度量指标

### 10.1 智能体能力评估

| 维度 | 指标 | 目标 |
|---|---|---|
| 任务能力 | 任务成功率 | > 85% |
| 响应速度 | 平均首 token 时间 | < 2s |
| 自主性 | 空闲循环有效动作比 | > 60% |
| 进化速度 | 每周自动结晶的技能数 | > 2 |
| 知识积累 | 每周新增知识条目 | > 50 |
| 成本效率 | 每美元产出的有效动作数 | 持续上升 |
| 蒸馏效率 | 本地模型任务成功率提升 | 每月 > 2% |

### 10.2 用户价值评估

| 维度 | 指标 |
|---|---|
| 效率提升 | 用户任务完成时间对比（有/无智能体） |
| 知识发现 | 智能体主动发现的有价值信息数 |
| 决策质量 | 智能体建议被用户采纳的比例 |
| 竞争力 | 用户在其领域的产出效率排名变化 |

---

## 附录 A：术语表

| 术语 | 定义 |
|---|---|
| GAV | Gather-Act-Verify，任务执行循环 |
| ELI | Explore-Learn-Improve，进化循环 |
| A2A | Agent-to-Agent，智能体间通信协议 |
| MCP | Model Context Protocol，工具集成标准 |
| Agent Card | 智能体自描述文件，包含能力和接口信息 |
| Agent Protocol | 智能体标准化身份协议 |
| Store | LangGraph 持久化存储（SQLite） |
| langmem | LangChain 长期记忆工具 |
| Thread | 会话上下文，绑定到 Checkpointer |
| Skill | 结构化的方法论文件（SKILL.md） |

## 附录 B：文件结构规划

```
ccb-v0.378/
├── backend/
│   ├── engine/
│   │   ├── idle/                    # Phase 1 新增
│   │   │   ├── idle_loop.py         # 空闲循环引擎
│   │   │   ├── goal_manager.py      # 目标栈管理
│   │   │   ├── self_evolution.py    # 自我进化
│   │   │   ├── journal.py           # 日志系统
│   │   │   └── cost_tracker.py      # 成本核算
│   │   ├── triggers/                # Phase 1 新增
│   │   │   └── trigger_manager.py   # 触发器管理
│   │   ├── organization/            # Phase 2 预留
│   │   │   ├── resource_pool.py     # 组织资源池
│   │   │   ├── collective_learning.py
│   │   │   └── agent_spawner.py     # Agent 繁殖
│   │   └── ...（已有模块）
│   └── ...
├── plugins/
│   └── mcp-macos/index.js           # 扩展 23+ 工具
├── goals/
│   └── active.md                    # 目标栈
├── journal/
│   └── YYYY-MM-DD.md               # 每日日志
├── proposals/
│   └── YYYY-MM-DD-<title>.md        # 代码修改提案
├── data/
│   ├── store.db                     # LangGraph Store（已有）
│   ├── checkpoints.db               # Checkpointer（已有）
│   └── cost_ledger.jsonl            # 成本账本
└── docs/
    └── ARCHITECTURE_V2_AUTONOMOUS_AGENT.md  # 本文档
```

---

## 11. 生态融合：与 Claude / LangChain / OpenClaw 对齐

### 11.1 当前系统与标准实现的差异诊断

经过代码深度分析，本系统存在以下与生态标准的偏差：

| 维度 | 当前实现 | 标准做法 | 差距 | 优先级 |
|---|---|---|---|---|
| Agent 创建 | `create_deep_agent`（deepagents 库） | LangGraph `create_agent` | 合理扩展，非偏差 | - |
| 流式输出 | 手动 `get_stream_writer()` 转发 | LangGraph 子图自动流式 | 存在 workaround | 中 |
| A2A Agent Card | `/.well-known/agent-card.json` | Google A2A: `/.well-known/agent.json` | 路径+结构不符 | 高 |
| 定时任务 | 自研 `autonomous_tasks.json` + 轮询 | LangGraph Platform Cron Jobs | 重复造轮子 | 中 |
| 后台执行 | 无 | LangGraph Background Runs | 缺失 | 中 |
| 经济协议 | 无 | OpenClaw ACP (Agent Commerce Protocol) | 缺失(Phase 3) | 低 |
| 中间件 | 15+ 自定义中间件 | LangGraph Middleware + deepagent | 合理扩展 | - |
| 记忆 | langmem 标准用法 + 分类封装 | langmem 标准 | 符合标准 | - |
| 持久化 | SqliteSaver + SqliteStore | LangGraph 标准 | 符合标准 | - |

### 11.2 三大协议栈对齐策略

2026 年 Agent 生态有三大协议，本系统需要全部对齐：

```
MCP（工具协议）     A2A（通信协议）     ACP（商业协议）
Anthropic 主导      Google 主导         OpenClaw 主导
Agent ↔ 工具        Agent ↔ Agent       Agent ↔ 市场
已集成 ✅           部分实现 ⚠️          未集成 ❌

本系统定位：
MCP 客户端（使用工具）+ A2A 节点（参与协作）+ ACP 代理（参与经济）
```

**MCP（已集成）**：通过 `langchain-mcp-adapters` 连接 MCP 服务器。需增强：
- MCP 动态发现（MCP Gateway + 语义搜索）
- MCP 服务器自动安装

**A2A（需修复）**：
- Agent Card 路径修正为 `/.well-known/agent.json`
- Agent Card 结构对齐 Google A2A 规范（identity, service_endpoint, a2a_capabilities, skills）
- LangGraph 已原生支持 `/a2a/{assistant_id}` endpoint，应直接启用而非自研

**ACP（Phase 3 集成）**：
- OpenClaw 的 Agent Commerce Protocol 提供钱包、服务市场、任务交易
- 本系统无需自研交易体系，直接接入 ACP 生态
- 实现路径：`pip install openclaw-acp` → 注册为 ACP 节点 → 发布服务 → 接受支付

### 11.3 应该用标准实现替换的部分

**立即替换**：

1. **A2A 实现** → 使用 LangGraph 原生 A2A endpoint
   - LangGraph 自动暴露 `/a2a/{assistant_id}`，自动生成 Agent Card
   - 删除自研的 Agent Card 路径，改用标准 `/.well-known/agent.json`

2. **定时任务** → 使用 LangGraph Cron Jobs
   - 当前 `autonomous_tasks.json` + 60 秒轮询 → 替换为 LangGraph Platform cron
   - 触发器管理器的 cron 部分也应使用此能力

**评估后替换**：

3. **流式输出** → 评估 LangGraph 子图自动流式
   - 当前 deepagent_node 手动处理 chunk 并通过 writer 转发
   - 如果 LangGraph 的 `configurable_fields` 能实现动态模型切换，则可简化

### 11.4 应该保留的自研扩展

以下部分是在标准能力之上的合理增强，**不应替换**：

- 15+ 业务中间件（反思/自我改进/技能进化/蒸馏/本体等）
- 模式系统（agent/ask/plan/debug）
- 预分析节点（pre_analysis_node）
- 动态工具过滤
- 角色系统
- 空闲循环引擎（标准生态无此概念）
- 目标栈系统（标准生态无此概念）
- 自我进化（标准生态无此概念）

### 11.5 本地 LLM 与云端 LLM 的策略差异

你问得对："本地 LLM 能力差一些，其他思路应该一样的。"

**应该一样的部分**：
- 工具调用方式（MCP 协议一样）
- 通信协议（A2A 一样）
- 商业协议（ACP 一样）
- Gather-Act-Verify 循环（一样）
- 记忆和持久化（一样）

**因本地 LLM 能力差需要额外做的**：
- 蒸馏（云端强模型 → 本地弱模型的知识迁移）
- 更强的提示词工程（补偿模型能力不足）
- 更多的中间件护栏（反思、循环检测、需求覆盖检查）
- 模型升级策略（任务太难时自动切换到云端模型）

这些正是本系统中间件链的价值所在——**不是重复造轮子，而是补偿本地模型的能力差距**。

### 11.6 与 OpenClaw 的融合路径

OpenClaw 不是竞争对手，而是**生态伙伴**：

```
本系统（Agent 核心）                    OpenClaw（生态平台）
┌──────────────────┐                ┌──────────────────┐
│ · LangGraph 编排  │                │ · Antfarm 编排    │
│ · 空闲自我进化    │   ACP 对接      │ · ClawHub 技能市场 │
│ · 本地 LLM 蒸馏  │ ←──────────→   │ · 钱包+支付       │
│ · macOS 深度控制  │                │ · 服务发布/发现   │
│ · 知识积累       │                │ · 信誉系统        │
└──────────────────┘                └──────────────────┘
```

融合方式：
- Phase 1：本系统专注单体强化（能力建设）
- Phase 2：通过 A2A 协议与其他 Agent 协作（组织化）
- Phase 3：通过 ACP 接入 OpenClaw 经济体（生态化）
  - 注册为 ACP 节点
  - 发布服务到 ClawHub
  - 接受 USDC 支付
  - 购买其他 Agent 的服务/技能

---

## 12. Skills 与知识本体的自我进化体系

### 12.1 为什么需要"指导自己工作"的 Skills

当前系统有招标分析、项目管理等业务 Skills，但缺少**元 Skills（Meta-Skills）**——指导智能体如何自我改进的方法论。

需要新增的元 Skills：

| Skill | 职责 | 位置 |
|---|---|---|
| self-evolution | 自我代码修改的方法论 | `skills/foundation/self-evolution/` |
| world-exploration | 环境探索和知识积累方法 | `skills/foundation/world-exploration/` |
| cost-optimization | 成本优化和 ROI 最大化 | `skills/foundation/cost-optimization/` |
| capability-assessment | 自我能力评估和提升规划 | `skills/foundation/capability-assessment/` |
| ecosystem-integration | 生态融合（MCP/A2A/ACP） | `skills/foundation/ecosystem-integration/` |

这些 Skills 是**通用智能体能力**，所有角色/数字员工都应继承。

### 12.2 知识本体的分层

```
通用智能体知识（所有 Agent 共享）
├── 自我进化方法论（Meta-Skills）
├── 工具使用知识（MCP 工具百科）
├── 协议知识（A2A/ACP 交互规范）
└── 成本和资源管理知识

领域知识（按数字员工角色分化）
├── 招投标领域
├── 代码开发领域
├── 数据分析领域
└── ...更多角色

环境知识（由探索积累）
├── 本机环境（应用/文件/配置）
├── 网络环境（位置/服务/资源）
└── 互联网知识（技术趋势/市场信息）
```

### 12.3 升级路径

```
代码升级（系统能力）        Skills升级（方法论）        知识本体升级（认知）
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ idle_loop.py     │     │ self-evolution   │     │ 领域术语         │
│ goal_manager.py  │     │ SKILL.md         │     │ 实体关系         │
│ mcp-macos 工具   │     │ 探索方法论       │     │ 行业知识         │
│ trigger_manager  │     │ 成本优化策略     │     │ 环境认知         │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        ↑                       ↑                       ↑
        │                       │                       │
        └───── 三者同步迭代，每次版本升级都包含这三个维度 ──┘
```

---

## 13. 升级计划修订：代码 + Skills + 知识

基于以上分析，Phase 1 的实施应包含三个维度的同步升级：

### 13.1 代码升级（系统能力）

按原计划 P0-P4 顺序实施，增加以下修正：
- 修复 A2A Agent Card 路径和结构（对齐 Google A2A 规范）
- 评估用 LangGraph Cron Jobs 替换 autonomous_tasks.json 轮询
- 在触发器管理器中直接使用 LangGraph Background Runs

### 13.2 Skills 升级（元能力）

创建 5 个 foundation 级别的 Meta-Skills：
- `self-evolution/SKILL.md` — 自我进化方法论
- `world-exploration/SKILL.md` — 环境探索方法
- `cost-optimization/SKILL.md` — 成本优化策略
- `capability-assessment/SKILL.md` — 能力评估框架
- `ecosystem-integration/SKILL.md` — 生态融合指南

### 13.3 知识本体升级

- 将本架构文档注册到知识库，作为自我迭代的参考
- 建立通用智能体本体（工具分类、协议知识、资源类型）
- 环境知识存储结构（`knowledge_base/learned/world/`）

---

> 本文档是系统最重要的架构参考。所有后续实现应以此为蓝图，确保方向一致性。
> 随着系统进化，本文档由智能体自身维护和更新。
