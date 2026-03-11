# 云端样本到本地蒸馏闭环（最小可执行）

目标：不改主推理链路，只基于现有 `distillation_middleware` 与 `model_manager` 建立可执行闭环。

## 闭环路径

1. 采集：运行时由 `DistillationMiddleware` 写入 `knowledge_base/learned/distillation_samples.jsonl`。
2. 清洗：执行 `backend/scripts/export_distillation_samples.py` 生成本地训练样本。
3. 评测：执行 `backend/scripts/evaluate_distillation_loop.py` 输出闭环健康报告。
4. 回灌：发布评审读取 `backend/data/distillation_eval_report.json` 作为模型侧证据。

## 样本规范（导出后）

- `task_input`：任务输入（来自 `compressed_input`）
- `plan_summary`：计划摘要（从模型输出提取关键片段）
- `tool_sequence`：工具调用序列（来自 metadata）
- `model_output`：教师模型输出
- `human_feedback`：人工偏好反馈（若存在）
- `meta`：时间戳、模型、层级、质量分、采集原因

## 执行命令

- 导出蒸馏样本：
  - `make export-distillation-samples`
- 评测闭环健康度：
  - `make evaluate-distillation-loop`
- 严格评测（未通过即阻断）：
  - `backend/.venv/bin/python backend/scripts/evaluate_distillation_loop.py --strict`

## 选模解释入口（可预期性）

`backend/engine/agent/model_manager.py` 新增 `explain_model_selection()`：

- 输出选中模型、来源（pinned/thread/explicit/auto）、auto 规则、fallback 候选和任务上下文。
- 用于发布复盘与“为什么这次选云/本地”解释，不影响既有选模行为。
