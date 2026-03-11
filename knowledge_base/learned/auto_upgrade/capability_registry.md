# Capability Registry

- Generated At: `2026-02-26T00:40:00.595434+00:00`
- Tool Count: `14`
- Skill Count: `57`
- Resource Count: `33`

## Top Tools

- `ask_user`
- `batch_read_files`
- `create_chart`
- `critic_review`
- `extract_entities`
- `python_internal`
- `python_run`
- `query_kg`
- `search_knowledge`
- `search_learning_experience`
- `shell_run`
- `think_tool`
- `web_fetch`
- `web_search`

## Key Skills

- `contracts` (legal)
- `contracts/quant-risk-review` (contracts)
- `education/homework_check` (education)
- `education/student_learning` (education)
- `education/teacher_lesson_prep` (education)
- `format/docx` ()
- `format/pdf` ()
- `format/pptx` ()
- `format/skill-creator` ()
- `format/xlsx` ()
- `foundation/auto-discovery` (foundation)
- `foundation/code-execution` (foundation)
- `foundation/file-parsing` (foundation)
- `foundation/file_processing` (foundation)
- `foundation/growth-radar` (foundation)
- `foundation/mcp-builder` ()
- `foundation/reasoning` (foundation)
- `foundation/user-interaction` (foundation)
- `foundation/verification` (foundation)
- `foundation/visualization` (foundation)
- `foundation/web-research` (foundation)
- `general/data_analysis` (general)
- `general/decision-matrix` ()
- `general/document_generation` (general)
- `general/growth-radar` ()
- `general/project-management` (general)
- `general/project-management/business_planning` (management)
- `general/report-generation` (general)
- `general/text_analysis` (general)
- `knowledge/external-resources` (knowledge)
- ... (27 more)

## Runtime Write Policy

- `knowledge_base/learned/auto_upgrade/rollout_policy.json` -> `runtime_safe` (策略图可由系统自优化调整)
- `knowledge_base/learned/auto_upgrade/release_profile.json` -> `runtime_safe` (灰度发布状态由编排自动维护)
- `knowledge_base/learned/auto_upgrade/rollout_state.json` -> `runtime_safe` (运行时状态持久化)
- `knowledge_base/skills/**/*.md` -> `gated` (技能描述改写需质量门禁)
- `backend/engine/prompts/*.py` -> `gated` (提示词核心逻辑影响全局行为)
- `backend/config/models.json` -> `human_review` (模型路由配置需人审防止成本/质量失衡)
- `backend/**/*.py` -> `readonly` (核心执行代码默认只读，避免无门禁自改)
