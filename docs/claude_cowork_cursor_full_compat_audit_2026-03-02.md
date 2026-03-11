# Claude/Cowork/Cursor 全面兼容审计（2026-03-02）

## 0. 结论摘要

- 系统当前状态：**业务可跑通、核心能力高一致、生态能力部分兼容**。
- 与 Claude/Cowork/Cursor 的关系：**不是逐项“同方式”完全复刻，而是“核心强一致 + 功能等效实现 + 若干关键差距”**。
- 插件与 skills：**核心链路兼容，但未达“全面兼容”**（manifest 强校验、远端安装升级闭环、agents/hooks/mcp 实执行仍待补齐）。
- Claude/Cowork 本体知识：**无法直接获得闭源本体**；可通过公开源与企业私有源的合规路径构建可追溯知识体系。

## 1. 检查范围与口径

- 高层检查：架构、模式系统、任务流、会话流、协作流、插件生态、知识来源。
- 逐项检查：按“功能是否存在、行为是否一致、实现方式是否一致”三维度评估。
- 一致性定义：
  - `强一致`：功能与行为高度一致，关键语义基本相同。
  - `等效实现`：功能达成，但实现机制不同。
  - `部分兼容`：功能存在明显缺口或边界不一致。

## 2. 高层一致性检查结果

| 维度 | 结论 | 说明 |
| --- | --- | --- |
| 后端执行语义（模式/工具/编排） | 强一致 | Plan/Ask/Debug/Review 模式、图级门禁、工具治理较完整。 |
| 任务与看板链路 | 等效实现 | 具备可跑通闭环，但存在 Task=Thread 与 Board 双轨同步复杂度。 |
| 前端会话与交互 | 等效实现（高） | 会话/模式/slash/上下文注入能力齐备，机制偏事件总线+状态收敛。 |
| 协作与子线程（Cowork） | 部分强一致 | 有任务协作与子线程能力，但统一协作主线仍可继续增强。 |
| 插件与 skills 生态 | 部分兼容 | 支持 Claude 风格目录与命令闭环，但生态闭环不完整。 |
| 知识来源可获得性 | 合规可行 | 可走公开源+私有源接入；不可直取闭源本体。 |

## 3. 逐项功能对照（是否“同样方式实现”）

| 功能项 | 当前实现状态 | 与 Claude/Cowork/Cursor 对齐判断 | 备注 |
| --- | --- | --- | --- |
| 会话切换（Thread/Session） | 已实现 | 接近同方式 | 已完成线程状态写入收敛与守卫检查。 |
| 模式切换（Agent/Plan/Ask/Debug/Review） | 已实现 | 等效实现 | 显式模式与线程级持久化较重。 |
| Slash 命令系统 | 已实现 | 等效实现 | 前端改写 + 后端 `/slash/execute` fallback。 |
| 上下文注入（文件/选区/工作区） | 已实现 | 等效实现 | 能力齐备，缺统一 @mention 入口层。 |
| 错误恢复与回退 | 已实现 | 接近同方式 | 重试/取消/线程丢失回退可用。 |
| 可观测性（trace/metrics） | 已实现 | 等效实现 | 指标散布，统一观测面板待增强。 |
| 任务状态机 | 已实现 | 强一致 | watcher + 状态迁移规则较完整。 |
| 人类检查点（HITL） | 已实现 | 强一致 | waiting_human/审核恢复链路存在。 |
| 多代理协作（Cowork） | 已实现 | 部分一致 | 具备基础闭环，复杂协作语义仍可加强。 |
| 插件目录兼容 | 已实现 | 强一致 | `.claude-plugin/plugin.json` 约定可用。 |
| 插件命令发现与执行 | 已实现 | 强一致 | `/plugins/commands` + `/slash/execute` 可用。 |
| 插件远端安装升级 | 部分实现 | 部分兼容 | 当前更偏“启用本地发现插件”。 |
| plugin agents/hooks/mcp 执行面 | 部分实现 | 部分兼容 | 可解析但执行闭环不完整。 |
| skills 统一治理与可见性 | 部分实现 | 部分兼容 | 注入可用与统一索引可见性仍有差距。 |

## 4. 插件与 skills 全面兼容性结论

当前不建议宣称“全面兼容”，建议表述为：

- **“兼容 Claude 风格插件目录与命令协议，支持核心 skills 注入；高级生态能力（远端安装升级、agents/hooks/mcp 执行、强版本治理）持续完善中。”**

## 5. Claude/Cowork 本体知识可获得性结论

- 不能直接获取闭源“本体知识”。
- 可行且合规的获取路径：
  - 官方公开文档与协议源（Claude 文档、MCP 官方生态、LangChain/LangGraph）。
  - 官方公开插件清单 + 本地插件镜像。
  - 企业私有知识经 MCP 最小权限接入。
  - 在系统内沉淀带 `source_url/evidence/confidence` 的可追溯知识资产。

## 6. 当前最大差距（Top 6）

1. 任务真源仍为双轨（Thread metadata + Board）导致一致性复杂。
2. 插件安装升级闭环不完整（下载/校验/回滚能力不足）。
3. plugin agents/hooks/.mcp.json 的运行时执行面尚未打通。
4. skills 注入与统一索引可见性存在偏差。
5. 可观测性能力分散，缺少统一排障视图。
6. 协作主线虽可用，但在复杂多代理场景下语义一致性仍可增强。

## 7. 建议对外口径（避免过度承诺）

- 推荐：
  - “核心功能已与 Claude/Cowork/Cursor 工作流高度一致，业务链路可稳定跑通。”
  - “插件与 skills 已具备核心兼容能力，生态高级能力正在补齐。”
- 不推荐：
  - “已全面兼容 Claude/Cowork 全量生态”
  - “可直接获得 Claude/Cowork 本体知识”

## 8. 当日回归证据补充（2026-03-02 晚间）

- 自动化脚本通过：
  - `pnpm --dir frontend/desktop check:session-state` -> PASS
  - `pnpm --dir frontend/desktop check:single-agent` -> PASS
  - `pnpm --dir frontend/desktop check:role-mode-contract` -> PASS
  - `pnpm --dir frontend/desktop check:session-flow` -> PASS
  - `backend/scripts/test_single_agent_api_acceptance.py` -> PASS
- 接口链路通过：
  - `/plugins/list`、`/plugins/commands`、`/slash/execute`（内置 + `/bid-review` 插件命令）均通过
- UI 关键路径通过：
  - slash 建议、插件命令建议、Dashboard 快捷任务清理、输入框填充动作均通过
- 待人工签字项：
  - 会话级插件跨线程隔离（自动化因线程切换可见性限制，保留人工补测）
