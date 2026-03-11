# 学习层与工作区/租户作用域

本文档约定学习数据与工作区、多租户的绑定关系。

---

## 当前约定

- **学习数据目录**：使用 `paths.LEARNING_PATH`（随工作区切换），与「单进程单工作区」或「前端保证当前工作区唯一」一致。
- **workspace_domain**：在 `learn_from_success` / `learn_from_failure` 中用于知识分段与 KG 检索过滤，不替代物理隔离；调用方从 configurable 或任务字段传入。

---

## 多工作区/多租户扩展

若未来支持同进程多工作区或多租户，学习存储 key 须包含 `workspace_path` 或 `tenant_id`（如目录或 Store namespace）；`learn_from_success` / `learn_from_failure` 的调用处须传入该 key，并在 learning_middleware 内部使用，避免跨工作区写入。任务级学习幂等见 [learning_trigger_contract.md](learning_trigger_contract.md)。
