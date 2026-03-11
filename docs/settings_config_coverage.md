# 系统配置需求与设置页功能对照

本文档对照 **Agent/后端业务所需配置** 与 **当前设置页面（SettingsView）** 的覆盖情况，用于判断是否满足 Agent 业务需要。

---

## 一、后端/Agent 配置来源概览

| 来源 | 说明 |
|------|------|
| **环境变量 / .env** | `deep_agent.Config`、`app.py` 等读取，重启生效 |
| **agent_profile.json** | 后端 `config/agent_profile.json`，可通过 PATCH /agent/profile 更新 |
| **前端 API** | 模型列表、工作区切换、云端端点、许可证等，设置页调用 |
| **.maibot 可编辑配置** | 工作区 `.maibot/` 下 MAIBOT.md、persona.json、settings.json 等，设置页「高级 → 项目配置」可读写 |

---

## 二、当前设置页结构（按导航分组）

### 2.1 通用（groupGeneral）

| Section | 当前功能 | 对应后端/业务 |
|---------|----------|----------------|
| **general** | 入门示例任务、AI 规则入口、自动保存、通知开关、恢复默认；**对话与 Agent 行为**（自动滚动、新建时显示历史、默认联网搜索、**默认不附带上下文**、对话渐隐动画、聊天区窄滚动条、默认对话模式）；**隐私与数据**（数据保留说明、不参与匿名改进） | 规则跳转至 advanced；no context by default 影响 MyRuntimeProvider 的 open_files/recent/editor；窄滚动条与渐隐由 ChatArea data 属性 + globals.css 生效 |
| **appearance** | 语言、跟随系统外观、深色模式、字号、Tab/换行、左右侧栏默认开关、**编辑器小地图**、强调色 | 前端展示与本地存储 |
| **models** | 默认模型、云端端点（Base URL + API Key/环境变量）、添加/编辑/删除模型、刷新云端模型 | 后端 GET/POST /models/*、cloud_endpoints、models.json |
| **rules** | 规则说明、**规则层级说明**（项目 .maibot > 用户规则；新建对话继承默认模式与角色）、跳转到「高级 → 项目配置」 | .maibot/MAIBOT.md 等 |
| **extensions** | 插件列表、安装/卸载、配额、筛选、冲突说明 | 后端 listPlugins、getLicenseStatus、安装限制 |
| **shortcuts** | 快捷键说明（只读） | 无后端 |

### 2.2 数据（groupData）

| Section | 当前功能 | 对应后端/业务 |
|---------|----------|----------------|
| **agent_profile** | 助理名称/描述、Persona（名称/关系/语气/沟通风格）、用户偏好（沟通风格/详细程度/专业度/领域/自定义规则）、当前角色、许可证、进化流水线、**已装备 Skills**、domains/modes/max_parallel_tasks、OpenClaw、保存档案 | GET/PATCH /agent/profile，GET/PUT /agent/user-model，personaApi，rolesApi，skillsAPI，getEvolutionStatus，许可证 |
| **threads** | 对话列表、删除、运行历史、清理过期对话 | listThreads、deleteThread、getRunHistory、cleanupExpiredThreads |
| **workspaces** | 当前工作区、清空、最近工作区列表、切换/清空最近/清理无效 | workspace/switch、workspaceService、workspaceAPI |
| **memories** | 用户记忆列表、删除 | getUserMemories、记忆 API |

### 2.3 系统（groupSystem）

| Section | 当前功能 | 对应后端/业务 |
|---------|----------|----------------|
| **connection** | LangGraph Server 健康、项目文件夹（只读） | checkHealth、工作区路径展示 |
| **network** | 注册节点列表（只读） | GET /network/nodes |
| **advanced** | 连接（用户/角色提示）、**API 基础 URL**、调试（ExecutionLogs、LangSmith、敏感文件、Vision、Evals）、策略（升级控制、自治 Watcher、自治等级、组织策略）、学习（技能反馈统计、每日洞察）、**项目配置**（API Key 本地存储、**.maibot 可编辑配置文件列表**：MAIBOT.md、SOUL.md、TOOLS.md、AGENTS.md、SESSION-STATE.md、WORKING-BUFFER.md、EVOLUTION-SCORES.md、persona.json、prompt_assembly.json、prompt_calibration.json、settings.json） | getApiBase、configApi.list/read/write、secureStore |
| **about** | 版本、许可等 | 前端 |

---

## 三、后端/Agent 关键配置项与设置页覆盖情况

### 3.1 模型与连接（Agent 必须）

| 配置项 | 来源 | 设置页是否可配 | 说明 |
|--------|------|----------------|------|
| 默认模型 / 可用模型列表 | 前端存储 + 后端 models.json、cloud_endpoints | ✅ 是 | 设置 → 模型：选择默认、添加/编辑/删除、云端端点 |
| 模型 API URL / 端点 | 后端 Config.MODEL_URL、云端端点 | ✅ 是 | 本地模型在「添加/编辑模型」；云端在「云端端点」 |
| API Key（云端/OpenAI） | 环境变量或 models.json api_key_env、前端 secureStore | ✅ 是 | 云端端点点内填 Key/环境变量；高级 → API Key 本地存储 |

### 3.2 Agent 档案与行为（agent_profile.json）

| 配置项 | 设置页是否可配 | 说明 |
|--------|----------------|------|
| name / description | ✅ 是 | Agent 档案 → 助理名称、描述 |
| capabilities（skills/domains/modes/max_parallel_tasks） | ✅ 是 | 已装备 Skills、domains、modes、并行任务数 |
| resources（compute_tier、max_context_tokens 等） | ⚠️ 只读 | 仅展示，未提供编辑表单 |
| network（openclaw_enabled、channels） | ✅ 是 | OpenClaw 开关、渠道展示 |
| pricing / features | ❌ 否 | 无 UI |

### 3.3 Persona 与用户画像（.maibot/persona.json + user-model）

| 配置项 | 设置页是否可配 | 说明 |
|--------|----------------|------|
| Persona（name/relationship/tone/communication_style） | ✅ 是 | Agent 档案 → 助手 Persona |
| 用户偏好（沟通风格/详细程度/专业度/领域/自定义规则） | ✅ 是 | Agent 档案 → 用户偏好 |
| 用户画像持久化 | ✅ 是 | 通过 PUT /agent/user-model |

### 3.4 工作区与路径

| 配置项 | 设置页是否可配 | 说明 |
|--------|----------------|------|
| 当前工作区路径 | ✅ 是 | 设置 → 工作区：切换、清空、最近列表 |
| 工作区切换后端一致性 | ✅ 是 | POST /workspace/switch 后写前端并派发事件 |

### 3.5 后端仅环境变量（无设置页入口）

以下由 `deep_agent.Config` 或 `app.py` 从环境变量读取，**当前设置页无对应 UI**，需在服务器 .env 或环境中配置：

| 类别 | 配置项示例 | 说明 |
|------|------------|------|
| LLM 行为 | LM_STUDIO_URL, LM_STUDIO_MODEL, LLM_TEMPERATURE, LLM_MAX_TOKENS, LLM_TIMEOUT | 后端默认值；实际模型以前端选择为准 |
| 部署 | DEPLOYMENT_MODE, MCP_SERVER_URL | 本地/云端、MCP 地址 |
| 并发与限制 | MAX_PARALLEL_LLM, MAX_PARALLEL_TOOLS, MAX_PARALLEL_AGENTS, SUBAGENT_MAX_DEPTH, ENABLE_YAML_SUBAGENTS | SubAgent 与工具并发 |
| 存储与清理 | CHECKPOINT_TTL_DAYS, STORE_TTL_DAYS, CLEANUP_ON_STARTUP, CLEANUP_INTERVAL_SECONDS, TASK_EXECUTION_RELIABILITY_V2 | 检查点、Store、清理策略 |
| 能力开关 | ENABLE_KNOWLEDGE_RETRIEVER, ENABLE_KNOWLEDGE_GRAPH, ENABLE_SELF_LEARNING, ENABLE_LANGMEM | 知识检索/图谱/自我学习/记忆 |
| 性能与调试 | PERFORMANCE_MODE, LOW_MEMORY_MODE, DEBUG, ENABLE_AGENT_DEBUG_LOG | 性能模式、低内存、调试 |
| 其他 | SUMMARIZATION_TRIGGER_RATIO, MODEL_CALL_LIMIT, TOOL_CALL_LIMIT, HTTP_* 超时, SQLite/Embedding 等 | 压缩、限流、超时、缓存 |

**结论**：上述为运维/调优项，通常由部署人员在服务器侧配置，不强制要求在设置页暴露；若未来需要「高级运行时参数」可考虑只读展示 GET /system/config 或少量常用项（如 ENABLE_KNOWLEDGE_RETRIEVER）的开关。

### 3.6 .maibot 可编辑配置（规则与 Prompt）

| 文件 | 设置页是否可配 | 说明 |
|------|----------------|------|
| MAIBOT.md, SOUL.md, TOOLS.md, AGENTS.md, SESSION-STATE.md, WORKING-BUFFER.md, EVOLUTION-SCORES.md | ✅ 是 | 高级 → 项目配置：列表、打开编辑（configApi.read/write） |
| persona.json, prompt_assembly.json, prompt_calibration.json, settings.json | ✅ 是 | 同上 |

规则入口：常规 →「AI 规则」、规则页「打开配置」均跳转至高级 → 项目配置。

### 3.7 会话、记忆与扩展

| 能力 | 设置页是否可配 | 说明 |
|------|----------------|------|
| 对话列表与清理 | ✅ 是 | 设置 → 对话 |
| 用户记忆 | ✅ 是 | 设置 → 记忆 |
| 插件安装与配额 | ✅ 是 | 设置 → 扩展 |
| 角色切换与激活 | ✅ 是 | Agent 档案 → 当前角色 |

### 3.8 连接与系统状态

| 能力 | 设置页是否可配 | 说明 |
|------|----------------|------|
| 后端健康状态 | ✅ 是 | 设置 → 连接与系统 |
| API 基础 URL（前端请求后端用） | ✅ 是 | 高级 → API 基础 URL |
| 网络节点列表 | ✅ 只读 | 设置 → 网络 |

---

## 四、Agent 业务需求满足情况总结

### 已满足

- **模型与连接**：默认模型、本地/云端端点、API Key（含环境变量名）均在设置页可配。
- **Agent 档案**：名称、描述、已装备 Skills、domains、modes、并行数、OpenClaw 可编辑并保存到 agent_profile。
- **Persona 与用户画像**：Persona 与用户偏好完整可配并持久化。
- **工作区**：当前工作区切换、清空、最近列表、与后端 /workspace/switch 一致。
- **规则与 Prompt**：.maibot 下所有可编辑配置文件可在「高级 → 项目配置」中查看与编辑。
- **会话/记忆/扩展/角色**：对话、记忆、插件、角色均有对应入口与操作。
- **连接与基础 URL**：后端健康、前端 API 基础 URL 可查看/修改。

### 可选增强（非必须）

1. **Agent 档案 resources**：当前仅展示（compute_tier、max_context_tokens 等），若业务需要用户在 UI 调整「资源档位」或「最大上下文」，可增加表单并调用 PATCH /agent/profile 的 `resources`。
2. **系统配置只读展示**：在高级中增加「当前运行时配置」卡片，调用 GET /system/config 展示 model、parallel、storage、cleanup 等，便于诊断，不要求可编辑。
3. **部分能力开关**：若希望用户在不改 .env 的情况下开关「知识检索/图谱/自我学习」，需后端提供相应 API（读/写配置或环境），再在设置页加开关。

### 未覆盖但属运维侧

- 所有仅通过环境变量生效的项（并发数、TTL、ENABLE_* 等）：由部署/运维在服务器配置，不要求设置页必选支持。

---

## 五、结论

- **当前设置页已覆盖 Agent 业务所需的核心配置**：模型与连接、Agent 档案（名称/描述/Skills/domains/modes/并行/OpenClaw）、Persona、用户画像、工作区、.maibot 规则与 Prompt 文件、会话/记忆/扩展/角色、连接与 API 基础 URL。
- **与 agent_profile.json 及 Agent 运行直接相关的「人可配置」部分**已在设置页有对应入口；仅依赖环境变量的运维/调优项保留在 .env 是合理分工。
- 若产品上希望「普通用户也能改资源档位或看运行时配置」，可在现有「高级」或「Agent 档案」中做小幅扩展（见可选增强）。
