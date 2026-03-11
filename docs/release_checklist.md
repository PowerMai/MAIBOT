# 发布前检查清单

发布前请按本清单逐项执行，并与 [UI 发布质量门禁](UI_RELEASE_QUALITY_GATE.md) 及 [P1 可靠性改进清单](p1_reliability_improvement_backlog_2026-03-02.md) 衔接。

## 1. UI 门禁（1–5）

完整条目见 [UI_RELEASE_QUALITY_GATE.md](UI_RELEASE_QUALITY_GATE.md)，发布前需逐条勾选：

- **联动一致性**：调度触发后聊天区/任务面板/通知中心联动正确，打开任务详情与关联对话无误。
- **交互可达性**：事件行与三点菜单支持键盘，关键按钮有 aria-label，焦点样式可见。
- **视觉一致性**：时间分组、状态色与状态文案一致，主次信息分层清晰。
- **数据与可观测**：`/autonomous/schedule-state` 分页与过滤稳定，任务详情时间线正确，事件去重生效。
- **稳定性**：`npm run build` 通过，关键改动文件无新增 lint 问题，后端涉及改动文件 `py_compile` 通过，无事件风暴。

## 2. 自动化检查

| 步骤 | 命令 | 说明 |
|------|------|------|
| 轻量发布检查 | `make release-check` | check-session-state + task-status-wiring + single-source-strict + test-full + gate-release |
| 严格发布就绪 | `make release-readiness-strict` | 含后端核心测试、单 Agent 验收、看板契约、插件/技能门禁、可靠性 SLO、release signoff、gate-release |

前端构建与会话/事件契约：

```bash
pnpm --dir frontend/desktop run build
pnpm --dir frontend/desktop run check:session-state
```

## 3. P1 可靠性证据归档（三件套）

与 [P1 可靠性改进清单](p1_reliability_improvement_backlog_2026-03-02.md) 第 7 节及 P1-04 一致，每次发布宜保留：

1. **自动化证据**：`make check-reliability-slo`（或 `check-reliability-slo-strict`）输出、`release-readiness-artifacts` 等。
2. **人工签字**：使用 [docs/templates/release_signoff_template.md](templates/release_signoff_template.md) 或等效模板填报并归档。
3. **风险说明**：已知风险与回滚预案记录。

## 4. 发布记录

发布时填写 [UI_RELEASE_QUALITY_GATE.md](UI_RELEASE_QUALITY_GATE.md) 第 8 节模板：

- 版本、发布范围、门禁结果、已知风险、回滚预案。
