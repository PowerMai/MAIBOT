# Memory 系统 - 完全使用 LangChain/LangGraph 官方 API

本模块**完全基于 LangChain/LangGraph 官方 API**，不重复实现。

---

## ✅ 使用的官方组件

### 1. LangGraph Checkpointer（短期记忆）

**已在 `main_agent.py` 中使用** ✅

```python
from langgraph.checkpoint.memory import MemorySaver
checkpointer = MemorySaver()  # 自动管理对话历史
```

**功能**：
- ✅ 自动管理对话历史（Checkpointer）
- ✅ 会话状态持久化
- ✅ 多轮对话支持

---

### 2. LangGraph Store（长期记忆）

**已在 `main_agent.py` 中初始化** ✅

```python
from langgraph.store.memory import InMemoryStore
store = InMemoryStore()

# 直接使用 Store API（不封装）
store.put(key="rule:1", value={...}, metadata={...})
entry = store.get(key="rule:1")
keys = store.list(prefix="rule:")
```

**功能**：
- ✅ 跨会话知识存储
- ✅ Rules、决策、偏好存储
- ✅ 支持持久化（PostgresStore 等）

**使用方式**：
```python
from backend.memory.store_utils import save_rule_to_store, get_rules_from_store

# 直接使用 Store API（工具函数不封装，只是便捷接口）
save_rule_to_store(store, rule_dict)
rules = get_rules_from_store(store, project_id="project1")
```

---

### 3. 过程文档管理

**使用 DeepAgent 的官方工具** ✅

DeepAgent 已经提供了 `write_todos` 和 `write_file` 工具来管理过程文档：

```python
# Orchestrator 提示词中已经定义：
# 1. write_todos([step1, step2, ...]) - 创建任务列表
# 2. write_file("/document_request.md", user_request) - 保存请求
# 3. write_file("/final_report.md", report) - 保存报告
```

**不需要重复实现 ProcessDocument** ✅

---

### 4. Rules 管理

**LangChain 官方方法**：通过系统提示词（System Prompt）定义和应用 Rules

**存储**：使用 LangGraph Store 存储长期 Rules

**使用**：通过提示词注入的方式应用 Rules

```python
# 1. 存储 Rules（使用 Store）
from backend.memory.store_utils import save_rule_to_store, get_rules_from_store

rule = {
    "name": "文档分析流程",
    "pattern": "分析招标文件时",
    "description": "先使用 deep_analyze_documents，再提取关键信息",
    "project_id": "project1",
}
save_rule_to_store(store, rule)

# 2. 获取 Rules（用于提示词注入）
rules = get_rules_from_store(store, project_id="project1")

# 3. 在系统提示词中应用 Rules（在 main_agent.py 中）
rules_text = "\n".join([f"- {r['name']}: {r['description']}" for r in rules])
enhanced_system_prompt = f"{base_prompt}\n\n【项目规则】\n{rules_text}"
```

**不要实现 Rules 引擎** ✅ - 使用提示词注入即可

---

## 📋 使用示例

### 完整流程（使用官方 API）

```python
from langgraph.checkpoint.memory import MemorySaver
from langgraph.store.memory import InMemoryStore
from backend.memory.store_utils import save_rule_to_store, get_rules_from_store

# 1. 初始化官方组件（已在 main_agent.py 中完成）
checkpointer = MemorySaver()  # 短期记忆
store = InMemoryStore()  # 长期记忆

# 2. 存储 Rules（使用 Store API）
rule = {
    "id": "rule_1",
    "name": "文档分析流程",
    "pattern": "分析招标文件",
    "description": "先使用 deep_analyze_documents，再提取关键信息",
    "project_id": "project1",
}
save_rule_to_store(store, rule)

# 3. 获取 Rules（用于提示词注入）
rules = get_rules_from_store(store, project_id="project1")

# 4. 在系统提示词中应用 Rules
rules_prompt = "\n".join([
    f"- **{r['name']}** ({r['pattern']}): {r['description']}"
    for r in rules
])

enhanced_system_prompt = f"""{base_system_prompt}

【项目规则】
{rules_prompt}
"""

# 5. 过程文档（使用 DeepAgent 工具）
# 在 Orchestrator 提示词中已经定义：
# - write_todos() - 创建任务列表
# - write_file() - 保存文档
```

---

## ✅ 检查清单

- [x] **使用 LangGraph MemorySaver** - 短期记忆 ✅
- [x] **使用 LangGraph Store** - 长期记忆 ✅
- [x] **直接使用 Store API** - 不简单封装 ✅
- [x] **Rules 通过提示词应用** - 不使用 Rules 引擎 ✅
- [x] **过程文档使用 DeepAgent 工具** - 不重复实现 ✅
- [x] **遵循 LangChain 官方方法** ✅

---

## 🔗 参考

- [LangGraph Checkpointer](https://langchain-ai.github.io/langgraph/how-tos/persistence/)
- [LangGraph Store](https://langchain-ai.github.io/langgraph/how-tos/store/)
- [LangChain Memory](https://python.langchain.com/docs/modules/memory/)
- [DeepAgent write_todos/write_file](https://github.com/langchain-ai/deepagents)

---

## ⚠️ 重要说明

1. **过程文档**：使用 DeepAgent 的 `write_todos` 和 `write_file`，不要重复实现
2. **Rules**：通过系统提示词应用，存储在 Store 中，不使用单独的 Rules 引擎
3. **Memory**：使用 LangGraph Checkpointer 和 Store，不使用自定义 Memory 类
