# task_watcher 兼容层说明

## 背景

`backend/engine/tasks/task_watcher.py` 的调度主流程已经基于 `TriggerManager.due_tasks()` 运行，但仓库内仍存在历史测试与调用方依赖旧接口。

为避免测试收集阶段失败（ImportError）和潜在运行时兼容问题，当前保留以下兼容函数：

- `_parse_schedule(schedule: str) -> Dict[str, Any]`
- `_is_due(parsed: Dict[str, Any], now: datetime) -> bool`

## 设计边界

- 这两个函数属于 **兼容层**，不参与新调度主路径的核心逻辑。
- 新增调度能力优先在 `TriggerManager` 与对应触发配置上实现，不应继续向兼容函数扩展功能。
- 兼容层目标是“保持历史行为可用”，不是承载新需求。

## 维护规则

1. **不要直接删除兼容函数**，除非先完成调用方迁移与测试替换。
2. 若修改兼容函数行为，必须同步更新对应测试：
   - `backend/tests/test_task_watcher_schedule.py`
3. 若未来决定清理兼容层，建议顺序：
   - 先替换历史调用方到 `TriggerManager` 语义
   - 再调整/删除相关测试
   - 最后删除兼容函数与文档说明

## 验证建议

执行以下命令确认兼容性未破坏：

`./backend/.venv/bin/python -m pytest backend/tests/test_task_watcher_schedule.py -q`
