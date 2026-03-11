# 本体与知识体系一致性审计报告（2026-03-02）

适用范围：本轮仅审计（不改业务逻辑代码），面向以下四个优先方向：
- 本体/知识模型与 Cursor/Cowork 一致性
- 用户资料导入后构建本体/知识库链路
- 工作区/文件夹使用方式一致性
- 向量化、文件上传与响应性能

## 一、审计总览

- 总体结论：系统已达到“可运行的等效实现”，但尚未达到“强一致”。
- 当前状态：
  - 人工构建：可用，但弱闭环
  - Agent 自动构建：存在关键断点，尚非稳定闭环
  - 用户资料入库：可上传/导入，但默认不会自动完成“向量+本体”全链路构建
  - 工作区与路径：具备基础隔离，但存在真源分裂与路径协议混用
  - 性能与观测：链路可跑，关键问题在刷新语义、缓存键粒度、上传内存峰值、有效样本不足

## 二、四维一致性评分卡

| 维度 | 结论 | 风险级别 | 关键证据 |
| --- | --- | --- | --- |
| 本体/知识模型一致性 | 等效实现 | 高 | `roles/skill_profile` 映射回退、schema 双源、docmap 声明与实现不一致 |
| 用户资料→构建链路 | 部分兼容 | 高 | 上传与构建触发分离，格式覆盖不一致 |
| 工作区/文件夹使用 | 等效实现（中） | 中高 | workspace 切换双轨、状态键分裂、路径协议混用 |
| 向量化与响应性能 | 等效实现（中） | 高 | refresh/rebuild 语义分离、缓存键过粗、上传整包读内存 |

## 三、审计发现与证据

### 1) 本体与知识模型

- `roles` 别名大量归一到 `default`，专业角色可达性被压缩。  
  证据：`backend/config/roles.json`
- `skill_profiles` 当前仅见 `general`，与角色画像存在明显不对称。  
  证据：`backend/config/skill_profiles.json`
- 资源配置仍有历史语义与疑似失效路径。  
  证据：`knowledge_base/resources.json`（`bidding/contracts/reports`、`skills/marketing`、`skills/legal`）

### 2) 知识工程师与 Agent 自动构建能力

- 手工链路可跑：`upload/import-folder/build-task/ontology build` 已具备。  
  证据：`backend/api/knowledge_api.py`
- 自动构建链路不稳定：watcher 配置与启动条件存在冲突点。  
  证据：`backend/api/app.py`（配置项 `task_watcher_enabled`） + `backend/engine/tasks/task_watcher.py`（`TASK_WATCHER_ENABLED` 环境变量硬门）
- `build-task` 中 `index` 步骤与统一向量重建入口语义不一致。  
  证据：`backend/api/knowledge_api.py` vs `backend/api/app.py` (`/vectorstore/rebuild`)

### 3) 用户资料输入是否可用于构建

- 资料可上传/导入：支持 `.md/.txt/.pdf/.docx/.doc`。  
  证据：`backend/api/knowledge_api.py` 的 `/upload` 与 `/import-folder`
- 但“上传即自动构建本体+向量”并非默认行为，仍依赖后续触发。  
  证据：`/knowledge/refresh` 与 `/vectorstore/rebuild` 分离
- 本体构建格式覆盖低于上传格式（构建常用 `.md/.txt`）。  
  证据：`backend/api/knowledge_api.py` (`build_from_directory(..., [".md", ".txt"])`)

### 4) 工作区/文件夹是否按 Cursor/Cowork 风格

- 设置页路径链路：会写 `maibot_workspace_path` 并广播 `WORKSPACE_CONTEXT_CHANGED`。  
  证据：`frontend/desktop/src/components/SettingsView.tsx`
- 文件树路径链路：主要维护 `localWorkspacePath/workspaces/activeWorkspaceId`，与上述链路并行。  
  证据：`frontend/desktop/src/components/WorkspaceFileTree.tsx`
- 用户上下文事件存在“发送无统一消费”风险。  
  证据：`frontend/desktop/src/lib/hooks/useUserContext.ts`（dispatch `user-context-changed`）

### 5) 向量化、上传、响应性能

- 上传接口存在整文件读入内存路径（高并发下放大内存峰值）。  
  证据：`backend/api/app.py` 的 `/files/upload`、`/workspace/upload` (`await file.read()`)
- 查询缓存键粒度不足（仅按 query 哈希），存在串结果风险。  
  证据：`backend/tools/base/storage_manager.py`
- 统一观测快照存在样本空窗：`watcher.search_calls=0`、`ui_stream.sample_count=0`。  
  证据：`backend/data/unified_observability_snapshot.json`

## 四、可量化指标基线（建议纳入后续门禁）

### 本体侧
- role-profile 有效率：`有效 profile 角色数 / 角色总数`
- schema 单源一致率：`注入与抽取共用 schema 的占比`
- docmap 可达率：`resources.json 中 docmap 路径存在比例`

### 资料入库侧
- 上传可检索覆盖率：`上传后可被 search 命中的比例`
- 构建触发成功率：`upload/import 后触发构建成功比例`
- 格式构建覆盖率：`可上传格式中可进入本体构建格式的占比`

### 工作区侧
- workspace 切换原子一致率：`UI/存储/后端 root 同步成功率`
- thread 隔离一致率：`跨 workspace thread 不串扰比例`
- 路径协议一致率：`KB-root-relative 使用占比`

### 性能侧
- `knowledge_search_p95_ms`
- `cache_hit_rate`
- `fallback_ratio`
- `upload_p95_ms`（10MB / 50MB）
- `refresh_duration_ms` 与 `rebuild_duration_ms`

## 五、风险分级

### P0（先治理）
- 刷新语义统一（`refresh` 与 `rebuild`）
- 查询缓存键细化（引入 scope/top_k/model/index_version）
- workspace 真源统一（切换原子化）
- 上传流式化（避免整包内存读）

### P1（再收敛）
- schema 单源治理（注入/抽取共源）
- 角色画像映射收敛（减少 default 回退）
- 路径协议统一（传输层仅 KB-root-relative）

### P2（持续优化）
- 观测样本质量治理（消除空窗通过）
- 一致性审计周报与趋势看板
- 审计项并入发布 checklist 常规门禁

## 六、优化路线图（不改代码版）

### 阶段 A（1 周）
- 固化四维评分卡与基线指标
- 明确 P0 目标语义与验收阈值
- 交付审计台账（证据路径、风险等级、建议动作）

### 阶段 B（1-2 周）
- 输出接口语义统一方案（refresh/rebuild、workspace/path）
- 输出缓存与上传策略方案（键策略、TTL、流式上传）
- 输出“用户资料上传→构建”的策略矩阵（cache-only/incremental/full）

### 阶段 C（持续）
- 观测并轨到日巡检与 release 门禁
- 周期性复审评分卡，跟踪 P0/P1 收敛趋势

## 七、可执行验收标准（后续实施阶段适用）

- 一致性：四维评分卡无“高风险未收敛”项
- 可用性：用户资料上传后，按策略可稳定进入检索/本体构建
- 隔离性：workspace/thread 切换无串扰
- 性能：search/upload/refresh/rebuild 指标达到目标阈值

