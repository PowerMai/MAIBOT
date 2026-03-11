# 执行过程日志分析指南

本文档说明如何通过后端日志追踪一次 run 的完整执行过程，用于分析「执行几步后中止」等问题的原因。

## 1. 关键日志标识

后端 `main_graph` 在以下时机会打出结构化日志，便于 grep 与脚本解析：

| 日志前缀 | 含义 | 典型内容 |
|---------|------|----------|
| `tool_step_done` | 单步工具执行完成 | step、tool、tool_call_id、result_len |
| `run_stop` | 本次 run 结束原因 | reason、thread_id、mode，部分带 error/detail |
| `DeepAgent 执行中断` | 人工输入/审核中断 | 与 `run_stop reason=interrupt` 成对 |
| `流结束(正常)` | 流式输出正常结束 | 随后会有 `run_stop reason=normal` 或 `done_check_failed` |
| `流结束(loop_abort)` | 循环检测触发中止 | 随后会有 `run_stop reason=loop_abort` |
| `❌ DeepAgent 执行失败` | 异常导致失败 | 随后会有 `run_stop reason=exception` |

## 2. run_stop 原因取值

- **normal**：流式输出正常结束且任务验证通过。
- **done_check_failed**：流式结束但 DoneVerifier 未通过，会向会话追加「任务验证未通过」说明。
- **loop_abort**：循环检测器触发，主动中止并写入错误说明。
- **interrupt**：等待人工输入或审核（如 ask_user、Plan 确认），需用户操作后恢复。
- **exception**：执行过程中抛出异常（超时、模型不可用、网络错误等）。

## 3. 如何用日志分析「执行几步后中止」

1. **确定 thread_id**：从请求或前端会话拿到当前会话的 `thread_id`。
2. **按 thread 与时间过滤**：  
   `grep "thread_id=YOUR_THREAD_ID" your_backend.log | grep -E "tool_step_done|run_stop|DeepAgent 执行中断|流结束|DeepAgent 执行失败"`
3. **看 tool_step_done 数量**：  
   最后一条 `tool_step_done step=N` 表示第 N 步工具执行完成；若之后没有新的 tool_step_done 且很快出现 `run_stop`，说明在该步之后未再执行工具就结束。
4. **看 run_stop reason**：  
   - `reason=exception`：查看同条或相邻日志中的 `error=` 及上文的 `DeepAgent 执行失败`、堆栈。  
   - `reason=loop_abort`：查看前一条 `流结束(loop_abort)` 的 `error_message` 与 `loop_detector_status`。  
   - `reason=interrupt`：正常等待用户输入，非异常。  
   - `reason=normal` / `reason=done_check_failed`：流式已完整结束，区别在于是否通过任务验证。

## 4. 示例命令

```bash
# 某次 run 的步骤与结束原因（替换 THREAD_ID 与日志路径）
grep -E "tool_step_done|run_stop" backend.log | grep "thread_id=THREAD_ID"

# 仅看结束原因
grep "run_stop" backend.log | tail -20
```

## 5. 相关代码位置

- 步骤与结束原因日志：`backend/engine/core/main_graph.py` 中 deepagent 节点  
  - `tool_step_done`：在收到 `msg_type == "tool"` 并写入 `tool_result` 后打出。  
  - `run_stop`：在流结束（正常/loop_abort）、done_check 后、以及异常/中断分支中打出。
