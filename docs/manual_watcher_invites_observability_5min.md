# Watcher Invites 观测巡检（5 分钟）

目标：在灰度窗口内快速确认 `task_watcher` 的 invites 读路径未退化（优先走 `search`，避免频繁回退 `list+get`）。

## 前置条件

- 前后端服务已启动，且可访问设置页“自治巡检（Task Watcher）”卡片。
- `task_watcher` 处于启用状态（`running`）。
- 当前环境可通过 API 访问：
  - `GET /autonomous/watcher/config`
  - `POST /autonomous/watcher/observability/reset`

## 步骤

1. 在设置页进入“自治巡检（Task Watcher）”卡片，点击“重置观测”。
2. 或者调用 API 手工重置：
   - `POST /autonomous/watcher/observability/reset`
3. 等待一个短观测窗口（建议 3-5 分钟），期间保持 watcher 正常运行。
4. 在设置页点击“刷新”，查看 `Invites 观测`：
   - 读路径命中：`search X 次 / list+get Y 次`
   - fallback 比例：`Y / (X + Y)`
   - 处理计数：`seen / processable / submit / fail`
5. 记录窗口结束时的指标快照（截图或文本抄录）。

### 一键执行（可选）

```bash
make check-watcher-observability
# 严格阈值判定（失败返回非零退出码）：
# make check-watcher-observability-strict
# 或自定义窗口：
# bash scripts/watcher_observability_check.sh --window-seconds 180
```

## 通过标准（建议）

- `scan_search_calls > 0`（说明主路径可用）；
- fallback 比例未异常升高（建议 `< 30%`，按环境基线可再收紧）；
- `loop_errors == 0`；
- 若有处理样本，`bid_failed` 未出现持续上升趋势。

## 失败判定

- `scan_search_calls == 0` 且 `scan_fallback_calls` 持续增加；
- fallback 比例显著高于历史窗口（例如持续 > 50%）；
- `loop_errors` 连续增长，或 `last_error` 重复出现同类异常；
- `bid_failed` 在无外部依赖异常前提下异常升高。

---

## 现场记录（直接勾选）

测试人：`______`  
测试时间：`______`  
环境：`dev / staging / production`  
前端版本/分支：`______`  
后端版本/分支：`______`

| 步骤 | 操作 | 预期 | 结果(通过/失败) | 证据/备注 |
| --- | --- | --- | --- | --- |
| 1 | 点击“重置观测”或调用 reset API | 计数重置成功 | ☐通过 ☐失败 | |
| 2 | 等待 3-5 分钟窗口 | watcher 持续 running | ☐通过 ☐失败 | |
| 3 | 刷新并查看读路径命中 | 出现 search 命中计数 | ☐通过 ☐失败 | |
| 4 | 计算 fallback 比例 | 未异常高于基线 | ☐通过 ☐失败 | |
| 5 | 检查错误计数 | `loop_errors` 不增长 | ☐通过 ☐失败 | |
| 6 | 复核处理结果计数 | `bid_failed` 无异常上升 | ☐通过 ☐失败 | |

## 快速结论

- 是否通过：`☐ 通过 / ☐ 不通过`
- 失败步骤：`______`
- 问题摘要：`______`
- 建议处理：`______`
