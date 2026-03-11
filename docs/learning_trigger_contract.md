# 任务级学习触发契约

本文档约定「任务级学习」（learn_from_success / learn_from_failure）的触发源与幂等规则，避免双路径重复学习与语义冲突。

---

## 一、触发路径

任务级学习当前有两条可能触发路径：

| 路径 | 位置 | 条件 |
|------|------|------|
| **A. LangGraph run 结束** | `backend/engine/core/main_graph.py` | `ENABLE_SELF_LEARNING=true` 且 run 正常结束或失败，在节点内调用 `learn_from_success` / `learn_from_failure` |
| **B. 看板任务状态变更** | `backend/api/routers/board_api.py` | PATCH 将任务置为 `completed` 或 `failed` 时调用 `learn_from_success` / `learn_from_failure` |

同一任务若既走 LangGraph 执行又在看板上有状态更新，可能被两条路径各触发一次。

---

## 二、单源约定（推荐）

- **任务级学习的权威触发源**：以 **LangGraph run 结束** 为准。即「任务是否成功/失败」由图的执行结果与 DoneVerifier 等判定，学习调用在图节点内完成。
- **看板路径**：看板 PATCH 将任务置为 completed/failed 时，仍可调用 `learn_from_document`（若需看板侧文档沉淀）；是否保留对 `learn_from_success` / `learn_from_failure` 的调用由实现决定。若保留，则必须依赖**幂等**（见下）避免与图路径重复写入。

---

## 三、幂等规则（双路径并存时）

当两条路径并存时，`learning_middleware` 对同一任务只学习一次：

- **幂等键**：`task_id`。任意一条路径先对某 `task_id` 调用 `learn_from_success` 或 `learn_from_failure` 并写入后，后续对同一 `task_id` 的调用应跳过写入（可返回 `{"skipped": true, "reason": "idempotent"}`）。
- **实现**：在 `learn_from_success` / `learn_from_failure` 写入前，检查该 `task_id` 是否已存在于「已学习任务」集合（如文件或内存缓存）；若已存在则直接返回，否则执行学习并登记 `task_id`。
- **source 参数**：调用方可传入 `source="graph"` 或 `source="board"` 便于日志与统计，幂等判定仅以 `task_id` 为准。

---

## 四、与其它学习/记忆的区别

| 机制 | 触发时机 | 内容 |
|------|----------|------|
| **任务级学习**（本契约） | run 结束或看板状态变更 | 成功/失败模式、推理路径、失败教训等，用于 retrieve_context 与 KG |
| **用户记忆抽取** | run 结束后，见 CONTEXT_AND_MEMORY_SYSTEM_DESIGN | 从对话中抽取用户事实与偏好，写入 Store 供 search_memory |
| **执行经验反思** | 任务成功后 | 沉淀方法/参数等 procedural memory |

---

## 五、实现位置

- 幂等登记与检查：`backend/tools/base/learning_middleware.py`（LearningManager 或 learn_from_success/learn_from_failure 入口）。
- 图路径调用：`backend/engine/core/main_graph.py` 约 3176–3239 行。
- 看板路径调用：`backend/api/routers/board_api.py` 约 1233–1282 行。
