# 系统能力全面提升 - 端到端验收清单

基于《系统能力全面提升规划 v3》落地后的验收清单，用于确认各项能力就绪并可被使用。

## 1. 配置与能力开关

- [ ] `.env` 存在且包含 `ENABLE_KNOWLEDGE_RETRIEVER=true`、`ENABLE_KNOWLEDGE_GRAPH=true`（参见 `.env.example` 注释；未设置时后端默认 true，验收建议显式配置）
- [ ] 可选：配置 `TAVILY_API_KEY` 后，启动日志出现 `tavily_search - Tavily 高质量搜索 (TAVILY_API_KEY 已配置)`（`backend/tools/base/registry.py`）
- [ ] 可选：配置 `SKILLSMP_API_KEY` 后，知识管理师可通过 python_run 调用 SkillsMP API

## 2. 知识管理师

- [ ] 角色「知识管理师」的 `knowledge_scopes` 为 `["global","domain","learned","teams","users"]`（`knowledge_base/roles/knowledge_manager/config.json`）
- [ ] 工具列表包含 `shell_run`、`edit_file`、`web_search`、`web_fetch`、`python_run`、`list_skills`、`match_skills`、`get_skill_info`
- [ ] 能力中包含：知识库构建工作流、外部资源获取、质量报告、SkillsMP 市场集成

## 3. Skills 与 Profile

- [ ] `foundation/web-research`、`foundation/code-execution` 存在且可被加载（`knowledge_base/skills/foundation/`）
- [ ] `foundation/mcp-builder` 存在（anthropic 目录已移除，MCP 构建能力位于 `knowledge_base/skills/foundation/mcp-builder/`）
- [ ] `office/document_writing` 已合并至 `general/document_generation`（office 下为重定向说明，见 `merged_into`）
- [ ] `reports/`、`management/` 已迁移至 `general/report-generation`、`general/project-management`（旧目录下 SKILL.md 含 `moved_to`，BUNDLE 含「已迁移」说明）
- [ ] Bidding profile 的 paths 包含 `format/pptx/`、`general/project-management/`（`backend/config/skill_profiles.json` 的 `bidding.paths`）
- [ ] 知识管理师专属 Skill：`knowledge/external-resources`、`knowledge/quality-report`、`knowledge/skillsmp-integration` 存在

## 4. 外部知识工具

- [ ] 启动时注册 `web_search` 与 `web_fetch`（`backend/tools/base/registry.py`）
- [ ] 配置 TAVILY_API_KEY 后注册 `tavily_search`

## 5. 本体与知识图谱

- [ ] 保存知识图谱时，`knowledge_base/learned/ontology/backups/` 下生成带时间戳的备份（`knowledge_graph.py` 与 `knowledge_api.py` 保存时调用 `run_ontology_backup_and_changelog`）
- [ ] 备份仅保留最近 10 份
- [ ] `knowledge_base/learned/ontology/changelog.md` 在每次保存后追加一行变更记录

## 6. 代码执行

- [ ] `code_execution.py` 白名单包含：`python-pptx`、`wikibase-rest-api-client`、`mediawikiapi`、`wikipedia`、`arxiv`、`networkx`、`jinja2`、`markdown`、`pillow`（`backend/tools/base/code_execution.py` 的 `AUTO_INSTALL_WHITELIST`）
- [ ] 知识管理师可使用 `python_run` 执行上述白名单包（需先安装 optional dependency `external-knowledge` 以支持 Wikidata）

**安装外部知识依赖（Wikipedia/Wikidata）**：本项目的 Python 包在 `backend/` 下，需使用 **Python ≥3.11**，建议在项目虚拟环境中执行，并用 `python -m pip` 安装：
```bash
# 在项目根目录激活 venv 后，进入 backend 安装（用 python -m pip 避免误用系统 pip）
source .venv/bin/activate   # 或 Windows: .venv\Scripts\activate
cd backend && python -m pip install -e ".[external-knowledge]"
```
或从项目根目录指定 backend 子目录安装：
```bash
python -m pip install -e "./backend[external-knowledge]"
```
若报错「does not appear to be a Python project」，说明在根目录执行了 `pip install -e "."`，应改为上述带 `backend` 的路径。

**为什么激活了 .venv 仍显示 Python 3.9？** 常见原因：
1. **当前 .venv 是用 3.9 创建的**：激活后 `python --version` 就是 3.9。
2. **pip 未用 venv 的（最常见）**：`which python` 指向 `.venv/bin/python`，但 `which pip` 指向系统/用户的 pip（如 `/Users/xxx/Library/Python/3.9/bin/pip`），说明 PATH 里「用户 Python 3.9 的 bin」排在 .venv 前面，导致装包用的是 3.9。

**可靠做法**：用**当前解释器**的 pip，避免误用系统 pip（均在 `backend` 目录下执行）：
```bash
cd backend
# 推荐：用当前解释器的 pip
python -m pip install -e ".[external-knowledge]"
# 或显式用 venv 的 pip
.venv/bin/pip install -e ".[external-knowledge]"
```若希望修复 PATH，可在 shell 配置里把 `Library/Python/3.9/bin` 从 PATH 中移除或放到 venv 之后。

## 7. 端到端场景（建议人工验证）

- [ ] **知识构建**：选择知识管理师，上传或指定文档路径，执行「构建知识体系」类任务，确认索引/本体/可选 Skill 流程可跑通
- [ ] **质量报告**：构建完成后，让知识管理师生成质量报告，确认 `learned/reports/YYYY-MM-DD_build_report.md` 生成
- [ ] **外部资源**：让知识管理师使用 web_search（必要时配合 python_run）查询并整理结果
- [ ] **招投标场景**：选择招投标 profile，确认可用的 Skill 包含 format/pptx、general/project-management 及 document_generation

完成以上清单即视为本次系统能力全面提升的端到端验收通过。
