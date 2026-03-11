# 路径架构设计

**路径权威来源**：运行时以 [backend/tools/base/paths.py](../tools/base/paths.py) 为准；资源放置与能力说明见 [docs/resources-and-capabilities.md](../../../docs/resources-and-capabilities.md)。

## 核心原则

**四个独立空间，互不混淆：**

| 空间 | 位置 | 所有者 | 用途 |
|------|------|--------|------|
| **系统知识库** | `PROJECT_ROOT/knowledge_base/` | 系统 | Skills、指南、模板、参考资料 |
| **后端代码** | `backend/` | 开发 | Python 模块、API、Agent |
| **用户工作空间** | 用户指定路径 | 用户 | 上传文件、生成文档、项目文件 |
| **前端资源** | `frontend/` | 前端 | UI 组件、静态资源 |

## 一、系统知识库 (System Knowledge Base)

**位置**: `PROJECT_ROOT/knowledge_base/` (与 backend 同级)

```
knowledge_base/                  # 系统知识库根目录
├── skills/                      # 仅技能（SKILL.md + 配套文件），按领域或模式分子目录
│   ├── modes/                   # 模式专用（ask/plan/debug）
│   ├── foundation/ general/     # 基础与通用
│   ├── office/ reports/ legal/   # 领域技能
│   ├── marketing/bidding/       # 招投标等
│   └── community/               # 社区/插件 Skills
│
├── global/                      # 全局知识
│   └── domain/                  # 领域知识（指南、模板、案例），不放大段 SKILL
│       ├── bidding/
│       │   ├── 01_concepts/
│       │   └── 02_operations/
│       ├── contracts/
│       └── reports/
│
├── learned/                     # 学习产出（自动生成 + 可人工整理）
│   ├── ontology/                # 知识图谱/本体（entities.json, relations.json）
│   ├── skills/                  # 自动生成的 SKILL 草稿（可迁入 skills/ 正式使用）
│   └── ...                      # DocMap、bidding_analysis 等
│
├── teams/                       # 团队知识
│   └── {team_id}/
│
├── users/                       # 个人知识
│   └── {user_id}/
│
├── tools/                       # 工具相关说明
└── domain/                      # 【已弃用】请使用 global/domain/ 作为领域知识唯一位置
```

**注意**: `backend/knowledge_base/` 是 Python 模块（代码），不是数据目录！

## 二、用户工作空间 (User Workspace)

```
{user_workspace}/               # 用户指定的工作目录
├── uploads/                    # 用户上传的文件
│   ├── 招标文件.docx
│   └── 合同.pdf
│
├── outputs/                    # 生成的输出文件（相对工作区根，无二次 tmp）
│   ├── (根下或按任务建子目录)  # Agent 模式默认
│   ├── ask/                   # Ask 模式可保存分析文档
│   ├── plan/                  # Plan 模式可保存规划文档
│   └── debug/                 # Debug 模式可保存诊断报告
│
├── .context/                   # 项目记忆（由 deep_agent._load_memory_content 注入系统提示词）
│   ├── CONTEXT.md             # 项目级记忆、重要产出路径、用户偏好
│   └── rules/                 # 模块化规则
│       └── *.md
│
└── .memory/                    # 学习与记忆数据（随工作区切换，见 paths.py）
    ├── learning/              # 自我学习持久化（success_patterns、reasoning_paths 等）
    ├── knowledge_graph/      # 可选知识图谱实体/关系
    └── ontology/              # 可选本体
```

默认工作区根为项目根下的 `tmp/`；可通过 `config.configurable.workspace_path` 或 `set_workspace_root()` 切换。

## 三、后端运行时与持久化 (Backend Runtime & Data)

- **后端代码**（`backend/`）：`engine/`、`nodes/`、`prompts/` 等；`backend/knowledge_base/` 为 Python 模块（代码），非数据目录。
- **持久化数据**：位于**项目根** `data/`（由 paths.py 的 DATA_PATH 指定），含 `checkpoints.db`、`store.db`、`vectorstore/` 等；非 backend/data。
- **默认工作区**：用户未指定时由 `WORKSPACE_ROOT` 指定，通常为项目根下的 `tmp/`；见 paths.py 的 `set_workspace_root()`。

## 四、Backend 路由配置

```python
# deep_agent.py

def create_backend(runtime):
    # 1. 系统知识库后端 (只读) - 指向项目根目录的 knowledge_base/
    knowledge_backend = FilesystemBackend(
        root_dir=str(PROJECT_ROOT / "knowledge_base"),  # 注意：不是 backend/knowledge_base
        virtual_mode=False,
    )
    
    # 2. 用户工作空间后端 (读写)
    workspace_path = config.get('workspace_path')
    if workspace_path:
        workspace_backend = FilesystemBackend(
            root_dir=workspace_path,
            virtual_mode=False,
        )
    else:
        # 默认工作空间
        workspace_backend = FilesystemBackend(
            root_dir=str(PROJECT_ROOT / "backend" / "tmp" / "workspace"),
            virtual_mode=False,
        )
    
    # 3. CompositeBackend 路由
    return CompositeBackend(
        default=workspace_backend,  # 默认操作用户工作空间
        routes={
            "/knowledge_base/": knowledge_backend,  # 知识库 (PROJECT_ROOT/knowledge_base/)
            "/memories/": store_backend,            # 持久化记忆
        }
    )
```

## 五、Skills 路径配置

- **发现范围**：SkillRegistry 扫描 `knowledge_base/skills/` 与 `knowledge_base/learned/skills/`（见 paths.py 的 SKILLS_ROOT、LEARNED_SKILLS_ROOT）。
- **按场景加载**：实际注入的路径由 `backend/config/skill_profiles.json` 与当前 `skill_profile`、`mode` 决定（见 `backend/engine/skills/skill_profiles.get_skills_paths_for_profile()`）；Ask/Plan/Debug 模式会优先包含 `knowledge_base/skills/modes/{mode}/`。

## 六、Agent 提示词中的路径

```python
# 提示词配置
class AgentConfig:
    # 系统路径 (只读)
    knowledge_base = "/knowledge_base"
    skills_dir = "/skills"
    
    # 用户路径 (读写)
    upload_dir = "/uploads"
    output_dir = "/outputs"
    context_dir = "/.context"
```

## 七、前端传递工作空间

```typescript
// 前端调用时传递用户工作空间
const response = await langgraphApi.sendMessage(message, {
  workspace_path: '/Users/xxx/Projects/my-project',  // 用户选择的目录
});
```

## 八、路径映射示例

| Agent 看到的路径 | 实际文件系统路径 |
|-----------------|-----------------|
| `/knowledge_base/skills/bidding/SKILL.md` | `PROJECT_ROOT/knowledge_base/skills/bidding/SKILL.md` |
| `/knowledge_base/global/domain/...` | `PROJECT_ROOT/knowledge_base/global/domain/...` |
| `/uploads/招标文件.docx` | `{user_workspace}/uploads/招标文件.docx` |
| `/outputs/report.md` | `{user_workspace}/outputs/report.md` |
| `/.context/CONTEXT.md` | `{user_workspace}/.context/CONTEXT.md` |

## 九、目录结构总览

```
PROJECT_ROOT/
├── knowledge_base/              # 系统知识库 (数据)
│   ├── skills/                 # Skills（含 modes、foundation、anthropic、community、等）
│   ├── learned/                # 学习产出（ontology、skills 草稿等）
│   ├── global/                 # 全局知识（含 domain）
│   └── domain/                 # 领域知识（可选，与 global/domain 对齐）
│
├── data/                        # 持久化数据（checkpoints.db、store.db、vectorstore）
│
├── backend/                     # 后端代码
│   ├── engine/                 # Agent 引擎
│   └── knowledge_base/         # Python 模块 (代码!)，非数据目录
│
├── frontend/                    # 前端代码
│   └── desktop/
│
└── {user_workspace}/            # 用户工作空间（默认 PROJECT_ROOT/tmp）
    ├── uploads/
    ├── outputs/                 # 或 outputs/ask、outputs/plan、outputs/debug
    ├── .context/
    └── .memory/learning/        # 自我学习数据（ENABLE_SELF_LEARNING 时写入）
```
