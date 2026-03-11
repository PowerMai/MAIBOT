# Skills 与 Claude/Cowork 对齐说明

本文档说明本系统 Skills 的设计与 Claude/Cowork 的对应关系，以及管理/使用/扩展/升级/进化的现状与建议。

---

## 与 Agent Skills 规范对齐

本系统 SKILL.md 的格式与 [Agent Skills 开放规范](https://agentskills.io/specification)（agentskills.io）对齐：

- **name**：必填，≤64 字符，小写字母/数字/连字符；规范要求与父目录名一致，本系统对方法论类技能（ask/plan/review/debug）保留 name 如 `ask-methodology`、目录为 `ask/` 的例外约定，见 [INDEX.md](knowledge_base/skills/INDEX.md)。
- **description**：必填，1–1024 字符，建议同时说明「做什么」与「何时使用」；校验脚本会做长度与启发式检查。
- **compatibility**：可选，≤500 字符，表示环境要求（目标产品、系统依赖、网络等）。
- **allowed-tools**：可选（实验性），空格分隔的预批准工具列表；本系统在 frontmatter 中解析并可由 get_skill_info 返回。
- **渐进式披露**：启动时仅加载元数据（BUNDLE 内联 name + description）；完整说明在 Agent 决定使用该技能时通过 `read_file(SKILL.md)` 按需加载，与规范一致。
- **references/、assets/**：规范推荐的相对路径约定；本系统支持从技能根目录的相对路径引用（如 `references/REFERENCE.md`），建议引用深度一层，避免长链。

参考： [agentskills.io](https://agentskills.io)、 [anthropics/skills](https://github.com/anthropics/skills)。

---

## Skills 与 MCP 分工

与 Claude 设计一致：**Skills = 流程与标准，MCP = 连接与工具**。Skill 负责「何时用、怎么做、输出长什么样」；MCP 负责「连到哪里、调什么接口」。

- **Skills**：定义何时使用、步骤顺序、输出标准、推荐或允许使用的工具（含 MCP 工具名）；通过 BUNDLE 内联 name+description，通过 `read_file(SKILL.md)` 加载完整说明；frontmatter 的 `tools` / `allowed-tools` 可列出推荐或允许的工具（含 MCP 暴露的工具）。
- **MCP**：提供工具与数据连接；本系统通过现有 MCP 中间件挂载，Agent 在会话中可调用已连接 MCP 的工具。
- **组合使用**：某角色下由 skill_profile 决定技能子集，由连接状态决定可用 MCP；Agent 按技能说明中的流程与推荐工具（含 MCP 工具）执行任务。技能描述中可写明「先调用某 MCP 工具再…」，实现 Skill 编排 MCP。

详见 Claude 博客 [Extending Claude's capabilities with skills and MCP](https://www.claude.com/blog/extending-claude-capabilities-with-skills-mcp-servers)。

---

## 一、发现与描述（已对齐）

- **本系统**：[skill_registry.py](backend/engine/skills/skill_registry.py) 扫描 `knowledge_base/skills/` 与 `knowledge_base/learned/skills/` 下所有 `SKILL.md`，解析 YAML frontmatter（name、description、level、domain、tools、modes 等），符合 [Agent Skills 规范](https://agentskills.io/specification)。
- **运行时**：[deep_agent.py](backend/engine/agent/deep_agent.py) 通过 **skills_catalog 内联**（按 skill_profile 注入 **name + 短 description + 何时使用** triggers）减少无效 list_skills 调用；**list_skills / match_skills / get_skill_info** 工具做能力发现；详细内容通过 `read_file("...SKILL.md")` 按需加载。
- **Claude/Cowork**：类似「描述 + 按需加载」；API 化能力目录。本系统在「发现、描述、按需加载、catalog 内联」上已与 Claude 设计对齐，可支撑通用 Agent 业务能力。

---

## 二、管理 / 扩展 / 升级

| 维度 | 本系统 | Claude/Cowork | 建议 |
|------|--------|----------------|------|
| 安装/市场 | `skill_profiles.json`、`GET /skills/market`、`POST /skills/install`（从 URL）；插件目录可带 `skills/` | 应用内市场 + 版本管理 | 补充「检查更新」与版本号展示（见 [规划落地清单](knowledge_base/docs/规划落地清单与后续接续.md)） |
| 启用/禁用 | skill_profile 与路径子集；**全局禁用**：`GET/PATCH /skills/disabled`（data/skills_disabled.json），list_skills/match_skills 自动排除；**会话级禁用**：已支持，由 config.configurable.disabled_skills 注入与全局列表合并 | 按 Skill 单独开关 | 已对齐 |
| 升级 | 已提供：市场 version 字段、后端 GET /skills/check-updates、POST /skills/update-all；前端技能市场「检查更新」「全部更新」 | 版本更新、依赖管理 | 会话级可选更新策略可后续扩展 |

- **match_skills 可解释性**：match_skills 返回每条推荐技能时附带 **匹配原因**（如「触发词：招标」「关键词：投标」「语义相似」），便于前端展示「推荐：bidding（与「招标文件」匹配）」及可观测性。
- **前端技能可见性**：对话中 list_skills、match_skills、get_skill_info、run_skill_script 展示为「列出能力」「匹配能力」「查看技能详情」「执行技能脚本」；调用 get_skill_info(skill_name) 或 run_skill_script 时显示「正在使用技能：xxx」，与 Claude 思考链中可见技能使用一致，提升数字员工获得感。

**来源标识与专业感**：catalog 与 list_skills/match_skills 中每条技能带来源标签——**官方**（source=anthropic）、**内置**（custom）、**学习**（learned）。系统提示词要求优先选用标注为【官方】或来自市场的技能，多技能可选时优先选有 scripts/ 的技能（可复现、更可靠）。交付前**必须**满足 SKILL 内「质量门」与「输出必含项」，不满足不得交付。前端技能列表与市场卡片展示「官方」「已校验」等标签，便于用户感知已验证能力。

---

## 三、进化（自动沉淀）

- **本系统**：[skill_evolution_middleware.py](backend/engine/middleware/skill_evolution_middleware.py) 做结晶与 SKILL.md 草稿生成；[self_improvement_middleware_v10.py](backend/engine/middleware/self_improvement_middleware_v10.py) 等参与自我改进。
- **Claude/Cowork**：Skills 多为人工维护与发布。
- **建议**：保持现有自动沉淀能力，并增加人工审核与合并流程，避免自动生成的 SKILL 直接进入生产路径。

---

## 四、斜杠命令与 Skills 扩展机制（评估）

- **现状**：Cursor/本系统通过斜杠命令**操作** Skills——如 `/skills` 唤起 list_skills/match_skills，`/plan`、`/ask` 切换模式，插件命令（如 `/bid-review`）挂到具体技能场景；后端 [POST /slash/execute](backend/api/app.py) 返回 `rewrite_prompt` 或 `switch_mode`，由前端改写输入或切换模式后发送。
- **用于「扩展」的两层含义**：
  - **扩展使用面**（更多入口、更好发现）：斜杠是**好机制**——用户可快速发现与唤起技能，无需记路径；与「命令即模式」兼容；插件命令可挂接新技能场景，利于生态。
  - **扩展技能数量**（新增 SKILL.md、上架）：斜杠是**入口与发现**，真正扩展靠市场安装（`/skills/install`、市场 UI）、本地开发（SKILL.md 编写）与版本更新；斜杠别名（如 `/skill-xxx` 指向某技能）可作可选增强。
- **结论**：以斜杠命令作为**操作/唤起** Skills 的入口是合适机制，有利于技能被使用与发现；扩展技能生态仍以市场 + 版本 + 安装为主，斜杠作为发现与快捷入口与之互补。详见 [mode_vs_command_parity.md](mode_vs_command_parity.md)。

---

## 五、招投标与分层/市场/版本

- **招投标**：对外统一为**一个**专项 skill **bidding**（[knowledge_base/skills/bidding/SKILL.md](knowledge_base/skills/bidding/SKILL.md)）；关键词映射与角色 capabilities 只引用 `bidding`，不再引用 bidding-document-analysis、proposal-writing 等多名。插件 `plugins/sales/skills/` 可作为招投标能力包实现细节，由 skill_profile 注入路径后与内置 bidding 互补。
- **分层**：技能按 L1–L5 体系化归类（人的基本 → 工程师/办公文员基本 → 角色专长 → 专项），详见 [数字员工技能体系.md](数字员工技能体系.md)、[技能体系规划.md](技能体系规划.md)。
- **市场**：以 `skills_market.json` 的 12 条为精选；支持 `source_type: "remote"` + `remote_url` 拉取远程市场；安装时校验 `requires_tier`，与专业使用/一般使用（free/pro/enterprise）一致。
- **版本**：市场条目含 version；后端提供「检查更新」接口（如 `GET /skills/check-updates`）；自动生成的 LearnedSkill 在 to_skill_md 中输出 level/domain/source 便于 registry 过滤。

---

## 六、API 与 Claude beta 对齐

本系统 REST API 与 [Claude API Skills beta](https://platform.claude.com/docs/en/api/beta/skills) 在字段与语义上对齐，便于前端统一展示与后续对接。

### 列表/单条返回字段对应

| Claude API | 本系统 | 说明 |
|------------|--------|------|
| `id` | `id` | 稳定标识，格式为 `domain/name`（如 `domain/bidding`） |
| `display_title` | `display_title` | 人类可读标题（不注入 prompt）；与 `display_name` 同源 |
| `type` | `type` | 固定为 `"skill"` |
| `source` | `source` | `custom` / `anthropic` / `learned`（本系统扩展 learned） |
| `latest_version` | `version` | 当前版本号 |
| `created_at` / `updated_at` | `created_at` / `updated_at` | 时间戳；`created_at` 可选，后续可从文件 mtime 填充 |

以上字段由 [SkillInfo.to_dict](backend/engine/skills/skill_registry.py) 统一产出，GET /skills/list、/skills/by-profile、/skills/runtime-index、GET /skills/{skill_id} 均返回相同结构。

### List 过滤与分页

- **GET /skills/list** 支持与 Claude List 对齐的查询参数：
  - `source`：可选，`custom` | `anthropic` | `learned`，仅返回该来源的技能。
  - `limit`：可选，默认 100，最大 100。
  - `offset`：可选，默认 0；与 Claude 的 `page`（token）语义等价为「跳过条数」。
- 返回中增加 `total`（过滤后总数）、`limit`、`offset`，便于前端分页。

### 单条查询（Retrieve）

- **GET /skills/{skill_id}** 与 Claude **GET /v1/skills/{skill_id}** 对应。
- `skill_id` 支持两种形式：**name**（如 `bidding`）或 **domain/name**（如 `domain/bidding`），与列表项中的 `id` 一致。
- 返回 `{ "ok": true, "skill": { ... } }`，结构同列表单条；未找到返回 404。

### check-updates 响应

- **GET /skills/check-updates** 返回 `updates`（有市场更新的项）、`total`、以及 **builtin_total**：当前本地/内置技能总数（便于前端展示「N 个内置技能已为最新」）。

---

## 七、权威来源

- 技能目录与 frontmatter 规范： [skill_registry.py](backend/engine/skills/skill_registry.py)、[knowledge_base/skills/](knowledge_base/skills/)。
- 技能市场配置：`backend/config/skills_market.json`、`GET /skills/market`。
- 体系化与规划：[数字员工技能体系.md](数字员工技能体系.md)、[技能体系规划.md](技能体系规划.md)、[knowledge_base/skills/INDEX.md](knowledge_base/skills/INDEX.md)。
- 规划与接续： [规划落地清单与后续接续](knowledge_base/docs/规划落地清单与后续接续.md)。

## 八、设置/能力入口与外部资源

- **能力入口**：当前 skill_profile、tier 下可见技能数由 list_skills / GET /skills/by-profile 等反映；知识库面板「技能市场」提供检查更新、一键更新（GET /skills/check-updates、POST /skills/update-all），与「设置 → 能力」的版本管理理念一致。
- **外部资源**：Agent Skills 开放标准 [agentskills.io](https://agentskills.io)、[anthropics/skills](https://github.com/anthropics/skills) 官方库；本系统 `skills_market.json` 与 `remote_url` 可对接同类目录或自建市场，安装与更新走 POST /skills/install、check-updates/update-all。
