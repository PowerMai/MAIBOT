# SubAgent 使用规则

## 标准流程（复杂任务）

```text
1. explore + knowledge（并行）→ 收集文件和知识
2. planning（串行）→ 分析并制定计划
3. executor（串行）→ 执行计划生成产出
```

## 路由决策

| 需求 | SubAgent | 输入 | 输出 |
|------|----------|------|------|
| 定位文件 | explore | 搜索目标 | 文件路径、内容摘要 |
| 领域知识 | knowledge | 查询 | 知识、案例、规则 |
| 任务规划 | planning | 目标 + 文件 | key_info + steps |
| 执行任务 | executor | 计划 | 文件路径、结果 |

## 何时直接执行（不委派）

- 已知路径的文件读取 → `read_file`
- 1-3 个文件的搜索 → `grep`
- 简单数据处理 → `python_run`
