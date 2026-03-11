# 🚀 快速启动指南 - 新架构

**更新日期**: 2025-12-26  
**架构**: LangGraph SDK + 正确的 Graph 设计

---

## ⚡ 5 分钟快速启动

### 1️⃣ 启动后端（2 分钟）

```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378/backend
langgraph dev
```

**预期输出**：
```
✅ 主路由 Graph 创建完成
================================================================================
架构:
  router → [deepagent | editor_tool | error] → END

节点说明:
  - router: 提取路由信息
  - deepagent: DeepAgent 完整工作流（5+ 节点）
  - editor_tool: 直接工具调用（无 LLM）
  - error: 错误处理
================================================================================

🚀 LangGraph Server running on http://127.0.0.1:2024
```

### 2️⃣ 验证后端（1 分钟）

```bash
# 测试服务器
curl http://localhost:2024/

# 测试简单请求
curl -X POST http://localhost:2024/agent/invoke \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "messages": [{
        "type": "human",
        "content": "你好",
        "additional_kwargs": {
          "source": "chatarea",
          "request_type": "agent_chat"
        }
      }]
    }
  }'
```

### 3️⃣ 更新前端 API（2 分钟）

```typescript
// frontend/lib/editorApi.ts
const LANGGRAPH_SERVER_URL = 'http://localhost:2024';

// 统一 API 端点（从 /route/invoke 改为 /agent/invoke）
const callUnifiedApi = async (request: EditorApiRequest) => {
  const response = await fetch(`${LANGGRAPH_SERVER_URL}/agent/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: {
        messages: [
          new HumanMessage({
            content: request.content,
            additional_kwargs: {
              source: request.source,
              request_type: request.request_type,
              operation: request.operation,
              file_path: request.file_path,
              file_content: request.file_content,
              selected_text: request.selected_text,
              workspace_id: request.workspace_id,
            }
          })
        ]
      },
      config: {
        configurable: {
          thread_id: request.thread_id || 'default_thread'
        }
      }
    })
  });
  
  const data = await response.json();
  return data.output.messages[data.output.messages.length - 1];
};
```

---

## 🎯 核心变化

### API 端点变化
```diff
- POST /route/invoke     ❌ 旧端点（已删除）
+ POST /agent/invoke     ✅ 新端点（唯一入口）
```

### 架构变化
```diff
- route_graph (2 个独立 Graphs: route + orchestrator)  ❌
+ router_graph (1 个 Graph，DeepAgent 作为节点嵌入)   ✅
```

### 请求格式（保持不变）
```typescript
// 前端请求格式完全不变
{
  "source": "chatarea",
  "request_type": "agent_chat",
  "content": "你好"
}
```

---

## 📋 测试检查清单

### Backend 测试

- [ ] 后端启动成功（`langgraph dev`）
- [ ] Graph 加载成功（看到 "主路由 Graph 创建完成"）
- [ ] API 可访问（`curl http://localhost:2024/`）
- [ ] 对话请求成功（chatarea → deepagent）
- [ ] 工具请求成功（editor + tool_command → editor_tool）

### Frontend 测试

- [ ] API 端点已更新（`/agent/invoke`）
- [ ] 对话框输入正常工作
- [ ] 编辑器操作正常工作
- [ ] 文件同步正常工作
- [ ] 错误处理正常显示

---

## 🔍 调试技巧

### 查看详细日志
```bash
# 启动时添加调试标志
LANGCHAIN_DEBUG=true langgraph dev
```

### 查看 Graph 结构
```bash
# 使用 LangGraph Studio
langgraph dev --studio
# 访问 https://smith.langchain.com/studio/?baseUrl=http://127.0.0.1:2024
```

### 测试不同路由

#### 测试对话框（chatarea → deepagent）
```bash
curl -X POST http://localhost:2024/agent/invoke \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "messages": [{
        "type": "human",
        "content": "帮我写一个 Python 函数",
        "additional_kwargs": {
          "source": "chatarea",
          "request_type": "agent_chat"
        }
      }]
    },
    "config": {
      "configurable": {"thread_id": "test1"}
    }
  }'
```

#### 测试工具命令（editor + tool → editor_tool）
```bash
curl -X POST http://localhost:2024/agent/invoke \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "messages": [{
        "type": "human",
        "content": "读取文件",
        "additional_kwargs": {
          "source": "editor",
          "request_type": "tool_command",
          "operation": "list_directory",
          "file_path": "."
        }
      }]
    },
    "config": {
      "configurable": {"thread_id": "test2"}
    }
  }'
```

---

## ⚠️ 常见问题

### 1. Graph 加载失败
```
错误: ImportError: cannot import name 'agent' from 'backend.engine.core.main_agent'
解决: 确保 main_agent.py 正确导出 agent 实例
```

### 2. 路由失败
```
错误: 所有请求都到 error_node
解决: 检查 additional_kwargs 中的 source 和 request_type 是否正确
```

### 3. DeepAgent 不执行
```
错误: deepagent_node 返回空结果
解决: 检查 main_agent.py:agent 是否正常工作
测试: python -c "from backend.engine.core.main_agent import agent; print(agent)"
```

---

## 📚 相关文档

- **完整实施报告**: `NEW_ARCHITECTURE_IMPLEMENTATION_REPORT.md`
- **架构设计**: `ARCHITECTURE_CORRECTION_FINAL.md`
- **API 设计**: `UNIFIED_API_DESIGN.md`
- **LangChain 消息结构**: `LANGCHAIN_MESSAGE_STRUCTURE_DESIGN.md`

---

## ✅ 成功标志

当您看到以下输出时，系统已成功运行：

```
✅ 主路由 Graph 创建完成
✅ DeepAgent 完成，输出长度: XXX 字符
✅ 工具执行完成: read_file
```

---

**祝测试顺利！** 🎉

如有问题，请查看：
- 后端日志: 终端输出
- Graph 可视化: LangGraph Studio
- API 文档: http://localhost:2024/docs


