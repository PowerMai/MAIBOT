# Claude/Cowork 综合对齐评分（2026-03-02）

评分说明：`0-5` 分，`5` 为高度一致；维度覆盖功能、流程、体验。

## 评分总览

| 维度 | 分数 | 结论 |
|---|---:|---|
| 架构哲学对齐（Claude-style） | 5 | 顶层规则明确采用“极简工具 + 对话驱动” |
| Session/Thread 领域模型一致性 | 4 | 规则完整，但实现存在多点写入带来的竞争窗口 |
| 会话事件协议落地率 | 4 | 事件常量统一，历史兼容与多入口写入仍有复杂度 |
| Cursor-style Composer 会话隔离 | 4 | thread-scoped 键已落地，存在跨组件同步时序风险 |
| 运行时线程生命周期完整性 | 4 | 创建/切换/恢复链路完整，异常回退仍有边界场景 |
| 角色-线程绑定正确性 | 4 | 角色别名与 thread-scoped 映射已清理，稳定性提升 |
| 后端 Prompt/Mode 协议对齐 | 5 | DeepAgent 提示词与模式分层对齐度高 |
| 插件/MCP 生态兼容性 | 5 | 插件 registry + 命令发现 + slash fallback 已形成闭环 |
| Cowork 协作体验闭环 | 5 | Dashboard / Composer / Slash / 插件命令链路已通过实测 |

## 证据文件

- 规则与架构：
  - `.cursor/rules/agent-architecture.mdc`
  - `.cursor/rules/domain-model.mdc`
- 后端执行与提示词：
  - `backend/engine/agent/deep_agent.py`
  - `backend/engine/prompts/agent_prompts.py`
  - `backend/api/app.py`
- 前端会话/模式/协作：
  - `frontend/desktop/src/lib/constants.ts`
  - `frontend/desktop/src/lib/roleIdentity.ts`
  - `frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx`
  - `frontend/desktop/src/components/ChatComponents/cursor-style-composer.tsx`
  - `frontend/desktop/src/components/WorkspaceDashboard.tsx`
- 插件兼容约定：
  - `knowledge_base/plugins/README.md`

## 主要偏差点（待优化）

- 角色激活后的 profile 一致性曾出现缓存时序问题（已进入修复与回归阶段）。
- 任务可见性在高线程量场景受 `/threads` 列表截断影响，需要更稳健的查询策略。
- 前端工作区切换存在“后端切换失败但本地已写入”的分叉风险，需要先确认后写入。

## 本轮已完成优化（深度清理 + 能力闭合）

- 清理过时结构与断链：
  - 删除 `plugins/bidding/`、`plugins/bid_agent/` 残留目录。
  - 修正 `agent_profile.json`、`autonomous_tasks.json`、`.module-boundary.json`、`skills_market.json` 的旧角色/旧域名引用。
  - 修正 `knowledge_base/learned/*` 中旧 `marketing/bidding` 路径到 `plugins/sales/skills/*`。
- 前端一致性修复：
  - `roleIdentity.ts` 将 `knowledge_manager/workflow_designer` 统一映射到 `default`。
  - 收敛 `SkillProfileId` 与 `VALID_SKILL_PROFILES`，移除 `bidding/contract/knowledge/knowledge_engineering` 等废弃值。
  - 移除 `DEBUG_PRIMARY_ROLE_IDS` 旧角色分支，模式排序逻辑统一。
  - `WorkspaceDashboard` 去除硬编码 `招标分析/合同审查` 用例，改为通用示例与插件驱动任务。
- 插件命令闭环：
  - 新增 `GET /plugins/commands`。
  - `POST /slash/execute` 增加插件命令 fallback（读取 `commands/*.md` 并转写为执行提示）。
  - 前端 Composer slash 建议动态并入插件命令；运行时支持未知 slash 走后端执行。
- Registry 路径修复：
  - `plugin_registry.py` 修复缓存 spec `source_path` 解析，确保 `resolved_commands()` 可定位真实插件目录。

## 验收结果（2026-03-02 实测）

- 接口回归（FastAPI TestClient）：
  - `GET /plugins/list`：通过
  - `GET /plugins/commands`：通过
  - `POST /slash/execute /plan`：通过
  - `POST /slash/execute /plugins`：通过
  - `POST /slash/execute /install sales`：通过
  - `POST /slash/execute /bid-review`：通过（`rewrite_prompt + source=plugin_command`）
  - `POST /slash/execute /unknown-cmd`：按预期 `404`
- UI 端到端（browser automation）：
  - Slash 建议可见内置命令：通过
  - Slash 建议可见插件命令 `/bid-review`：通过
  - Dashboard `快捷任务` 已无“合同审查/招标*”残留：通过
  - Dashboard 任务填充到输入框：通过

## 当前剩余风险（下一阶段）

- `/suggestions/work`：已增强为「已安装插件 + 用户画像 + 工作区 + 静态技能」动态生成；支持 `mode` 参数，Ask 模式下优先展示只读/分析类建议；前端传入 threadId 与 mode。
- 模式系统与 Claude “命令即模式”的完全等价仍有实现差异（目前是兼容并存策略）。
- 插件命令冲突：已落实。前端 Slash 下拉展示冲突标签、加载时 Toast 提示；执行以首命中为准；命名规范见 knowledge_base/plugins/README.md。
