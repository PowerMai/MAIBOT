# 资源与能力说明

本文档说明：Skills 安装方式、联网资源、Planning/Ask 与基础能力、通过代码自我增强、知识图谱与自我学习开关，以及资源应放置的位置（便于高效获取）。

---

## 1. Skills 安装：预装为主，效率最高

- **系统不会自动从互联网安装 Skills**。当前实现为：启动时扫描 `knowledge_base/skills/` 与 `knowledge_base/learned/skills/`，发现所有 `SKILL.md` 并注册；无“从 URL 或市场自动拉取”的安装流程。
- **核心与常用 Skills 已预装**在仓库内（`knowledge_base/skills/`），包括：
  - **模式方法论**：`modes/ask/`（ask-methodology）、`modes/plan/`（plan-methodology）、`modes/debug/`（debug-methodology）
  - **基础能力**：`foundation/reasoning/`、`foundation/verification/`、`foundation/visualization/`、`foundation/file_processing/`
  - **通用能力**：`general/text_analysis/`、`general/data_analysis/`、`general/document_generation/`
  - **Anthropic 官方**：`anthropic/pdf/`、`anthropic/xlsx/`、`anthropic/docx/`、`anthropic/pptx/`、`anthropic/skill-creator/` 等
  - **领域能力**：`office/`、`reports/`、`marketing/bidding/`、`contracts/`、`legal/` 等
- **预装 + 按场景加载（skill_profile）** 的方式可以控制上下文体积，避免窗口无限扩大，同时保证常用能力立即可用，**效率最高**。
- **从互联网补充 Skills**：可从 [SkillHub](https://skillhub.ai)、[SkillsMP](https://skillsmp.com) 等下载符合 SKILL.md 规范的包，解压到 `knowledge_base/skills/community/`，重启或调用 `POST /skills/reload` 后即被扫描。无需改配置即可在各已包含 `community/` 的业务场景下使用。

---

## 2. 其他资源：联网按需获取

- **互联网资源**不预拉取，在**需要时**由 Agent 使用工具获取：
  - **web_search**：统一网页检索入口，获取时效信息、政策、文档等。
  - **web_fetch**：拉取已知 URL 的页面内容。
- 这样既避免维护大量外部缓存，又保证信息时效；引用时需注明来源（与 Claude/Cursor 一致）。

---

## 3. 资源应放在“最方便获得”的位置

为便于 Agent 和检索使用，已有资源应放在**约定位置**，避免散落和重复：

| 资源类型 | 推荐位置 | 说明 |
|----------|----------|------|
| Skills | `knowledge_base/skills/`（含 `anthropic/`、`foundation/`、`general/`、`modes/`、`community/`） | 自动扫描；按 skill_profile 加载子集 |
| 学习产出的 Skill 草稿 | `knowledge_base/learned/skills/` | 与 skills 一起被扫描；招投标等 profile 已包含 |
| 领域知识（概念、模板、案例） | `knowledge_base/global/domain/` 或 `knowledge_base/domain/` | 供 search_knowledge 与知识学习使用；具体结构见 knowledge_base 目录 |
| 用户上传与工作区文件 | 工作区根下的 `uploads/`、用户指定目录 | 路径由 configurable 传入，Agent 用 read_file 等直接访问 |
| 产出文件 | 工作区根下的 `outputs/`（或 `outputs/ask`、`outputs/plan`、`outputs/debug`） | 统一产出目录，便于查找与复用 |
| 项目记忆 | 工作区 `.context/CONTEXT.md`、`.context/rules/*.md` | 系统自动加载进提示词 |
| 自我学习数据 | 工作区 `.memory/learning/` | 成功/失败模式、推理路径；ENABLE_SELF_LEARNING=true 时写入 |

---

## 4. Planning / Ask 与基础能力 Skills（已有）

- **Planning**：已有 `modes/plan/`（name: plan-methodology），提供“需求澄清 → 方案设计 → 风险评估 → 等确认再执行”的流程，与 Plan 模式配合。
- **Ask**：已有 `modes/ask/`（name: ask-methodology），提供“理解背景 → 收集信息 → 多角度分析 → 给出建议”的 4 步咨询流程，与 Ask 模式配合。
- **基础能力**（在不无限扩大上下文的前提下增强能力）：
  - **reasoning**（`foundation/reasoning/`）：假设-验证、分解、对比等结构化推理。
  - **verification**（`foundation/verification/`）：证据验证、可重复性检查，含脚本。
  - **visualization**（`foundation/visualization/`）：图表与可视化。
  - **file_processing**（`foundation/file_processing/`）：PDF/Word/Excel 等解析指引。
- 通过 **skill_profile** 与 **mode** 控制加载子集（见 `backend/config/skill_profiles.json`、`mode_config.py`），窗口只注入当前场景所需能力，避免无限扩展。

---

## 5. 通过代码自我增强（有，与 Claude 一致）

- **本系统具备通过代码开发增强自己的能力**：
  - Agent 拥有 **write_file**、**edit_file**、**python_run** 等工具，可以在执行过程中**生成并写入**新文件（包括 SKILL.md、脚本、配置等）。
  - **anthropic/skill-creator** 已预装，提供“如何编写 SKILL.md、如何组织 scripts/references”的指导；Agent 可按该 Skill 的指引创建或更新 Skill，与 Claude 官方做法一致。
- **典型用法**：
  - 执行中发现某类任务重复且可固化 → 用 **write_file** 在 `knowledge_base/skills/` 或 `knowledge_base/learned/skills/` 下创建新目录并写入 `SKILL.md`（及可选 `scripts/`），之后即可被 list_skills/match_skills 发现。
  - 需要可复用脚本时 → 在对应 Skill 的 `scripts/` 下用 write_file 写入脚本，之后通过 **run_skill_script** 调用。
- **Claude 的实现方式**：同样通过“创建/编辑 SKILL.md + 可选脚本”扩展能力；本系统通过 skill-creator + 文件工具实现相同思路，无需额外“自我增强”开关。

---

## 6. 知识图谱与自我学习为何默认 false，开启会怎样

- **ENABLE_KNOWLEDGE_GRAPH**（默认 true）  
  - **原因**：知识图谱依赖实体/关系抽取与存储；与 search_knowledge 配合可做查询扩展与多跳推理。  
  - **开启后**：Orchestrator 挂载 **knowledge_graph**（抽取/查询合一）、**ontology**、**ontology_import** 等工具；search_knowledge 会使用 KG 扩展与多跳增强。适合需要“实体-关系”级知识的场景。

- **ENABLE_SELF_LEARNING**（默认 false）  
  - **原因**：每次任务结束都会调用 `learn_from_success` / `learn_from_failure`，将成功/失败模式与推理路径写入工作区 `.memory/learning/`；早期任务质量不稳定时容易写入噪声，且有一定 I/O 与存储。  
  - **开启后**：在 `main_graph` 的 deepagent 节点 **finally** 中，根据任务是否报错分别调用上述函数，并传入 `configurable` 中的 `skill_profile`、`workspace_domain` 等，用于按场景分段存储；便于后续检索历史经验、导出用于微调。  
  - **推荐**：在稳定使用一段时间、确认任务质量后再开启，并配合 ENABLE_KNOWLEDGE_RETRIEVER（必要时再开 ENABLE_KNOWLEDGE_GRAPH）使用。

详见 `.env.example` 中“Agent 能力开关”注释及 [operations.md](operations.md) 中“自我学习与知识”一节。

---

## 7. 知识体系与可靠性智能体

- **定位**：知识体系（schema 单源 + search_knowledge + KG + 外部导入合并）是**可靠性智能体的基石**。Agent 优先从知识库与 KG 获取可引用证据（source_id / excerpt），再结合 Skills 与工具执行业务，与 Claude/Cowork/Cursor 一致——知识即项目/上下文基础，检索需快速可引用。
- **可靠智能业务约定**：
  - **检索有降级**：KG 加载或 expand_query 失败时，search_knowledge 仍执行向量检索并返回结果，不静默失败；超时或异常时返回明确降级文案。
  - **KG 失败不阻断向量检索**：检索闭包内对 KG 获取与 expand_query 做 try/except，失败时仅跳过扩展与多跳，继续向量检索。
  - **首请求可能略慢**：KG 与向量库均为懒加载（首次 search_knowledge 时加载），后续请求复用缓存，避免启动阻塞。
- **与顶级产品对齐**：Claude/Cowork/Cursor 将知识作为上下文基础、Skills 定义流程；本系统通过 search_knowledge + knowledge_graph + ontology 提供可引用知识层，保证速度与可靠性不成为瓶颈。详见 [ontology_path_convention.md](ontology_path_convention.md)。

---

## 8. 知识库与 Skill 生效时机、许可档位

- **知识库更新后何时生效**：对 `knowledge_base/` 下文件的增删改，在**下次检索或重启后端**后生效。若使用向量索引（FAISS），需执行重建（如 `POST /vectorstore/rebuild` 或对应运维脚本）后，语义检索才会反映新内容；纯文件/关键词检索会直接读磁盘。
- **Skill 安装与 tier 的对应关系**：自定义 Skill 数量、插件数等受许可档位限制（见 `backend/engine/license/tier_service.py` 与 `data/license.json`）。free 档位下 `max_custom_skills` 等有上限；升级 tier 后可安装更多。安装/卸载会校验当前 tier，超限时 API 返回明确错误。
