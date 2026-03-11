# 前端上下文协议

## 概述

前端通过统一的上下文协议，将 UI 状态信息传递给后端，使后端能够：

1. **领域感知**：根据工作区领域调整 AI 响应风格
2. **文档理解**：了解当前文档类型和结构
3. **意图推断**：理解用户操作意图
4. **个性化响应**：根据用户偏好定制输出

---

## 传输方式

### 方式一：HTTP Headers（推荐用于轻量级元数据）

每个请求自动携带以下请求头：

```http
X-Session-Id: sess_1701234567_abc123
X-Workspace-Domain: tender
X-Document-Type: markdown
X-View-Type: editor
X-Teachcard-Ids: tender-master,risk-analyzer
X-Has-Selection: true
```

**后端解析示例（Python）：**

```python
from fastapi import Request

def get_frontend_context(request: Request) -> dict:
    return {
        "session_id": request.headers.get("X-Session-Id"),
        "domain": request.headers.get("X-Workspace-Domain", "general"),
        "document_type": request.headers.get("X-Document-Type"),
        "view_type": request.headers.get("X-View-Type"),
        "teachcard_ids": request.headers.get("X-Teachcard-Ids", "").split(","),
        "has_selection": request.headers.get("X-Has-Selection") == "true",
    }
```

---

### 方式二：请求体 Context 字段（用于详细上下文）

在需要详细上下文的请求中，添加 `context` 字段：

```json
{
  "message": "请帮我润色这段文字",
  "namespace": "sess_1701234567_abc123",
  "context": {
    "version": "1.0",
    "timestamp": 1701234567890,
    "sessionId": "sess_1701234567_abc123",
    "workspace": {
      "id": "ws_001",
      "path": "/Users/xxx/招投标项目",
      "name": "招投标项目2024",
      "domain": "tender",
      "domainConfidence": 0.92,
      "teachcardIds": ["tender-master", "risk-analyzer"]
    },
    "document": {
      "id": "doc_001",
      "path": "/Users/xxx/招投标项目/投标方案.md",
      "name": "投标方案.md",
      "type": "markdown",
      "size": 15234,
      "modified": true,
      "summary": {
        "headings": ["项目概述", "技术方案", "实施计划"],
        "wordCount": 3500,
        "paragraphCount": 45
      }
    },
    "editor": {
      "mode": "edit",
      "cursorPosition": { "line": 42, "column": 15 },
      "selection": {
        "text": "本项目采用微服务架构...",
        "startLine": 40,
        "endLine": 45,
        "length": 120
      }
    },
    "view": {
      "type": "editor",
      "panels": {
        "leftVisible": true,
        "rightVisible": true,
        "chatVisible": true
      }
    },
    "intent": {
      "primary": "edit",
      "confidence": 0.85,
      "triggers": ["select_text", "click_polish"]
    },
    "recentActions": ["open_document", "select_text", "click_polish"],
    "preferences": {
      "language": "zh-CN",
      "responseStyle": "detailed"
    }
  }
}
```

---

## 上下文字段说明

### Workspace（工作区）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 工作区唯一标识 |
| path | string | 工作区本地路径 |
| name | string | 工作区名称 |
| domain | enum | 领域类型：tender/legal/report/code/academic/general |
| domainConfidence | number | 领域识别置信度 0-1 |
| teachcardIds | string[] | 启用的教卡ID列表 |

### Document（文档）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 文档唯一标识 |
| path | string | 文档路径 |
| name | string | 文档名称 |
| type | enum | 文档类型：markdown/text/json/code/pdf/docx/xlsx/unknown |
| size | number | 文档大小（字符数） |
| modified | boolean | 是否已修改 |
| summary | object | 文档摘要（可选） |

### Editor（编辑器）

| 字段 | 类型 | 说明 |
|------|------|------|
| mode | enum | 编辑模式：edit/preview/split |
| cursorPosition | object | 光标位置 {line, column} |
| selection | object | 选中内容（可选） |
| visibleRange | object | 可见行范围（可选） |

### Intent（意图）

| 字段 | 类型 | 说明 |
|------|------|------|
| primary | enum | 主要意图：write/edit/review/analyze/search/translate/chat |
| confidence | number | 置信度 0-1 |
| triggers | string[] | 触发信号 |

---

## 后端使用建议

### 1. 领域感知的 Prompt 调整

```python
def build_system_prompt(context: dict) -> str:
    domain = context.get("workspace", {}).get("domain", "general")
    
    domain_prompts = {
        "tender": "你是一位专业的招投标顾问，熟悉招投标流程和规范。",
        "legal": "你是一位专业的法律顾问，擅长合同审核和风险识别。",
        "report": "你是一位专业的报告撰写专家，擅长数据分析和可视化。",
        "code": "你是一位资深软件工程师，擅长代码审查和重构。",
        "general": "你是一位智能助手，帮助用户完成各类文档工作。",
    }
    
    return domain_prompts.get(domain, domain_prompts["general"])
```

### 2. 教卡能力加载

```python
async def load_teachcard_skills(context: dict) -> list:
    teachcard_ids = context.get("workspace", {}).get("teachcardIds", [])
    skills = []
    
    for tc_id in teachcard_ids:
        teachcard = await get_teachcard(tc_id)
        if teachcard:
            skills.extend(teachcard.get("skills", []))
    
    return skills
```

### 3. 选中内容优先处理

```python
def get_target_text(context: dict, full_content: str) -> str:
    selection = context.get("editor", {}).get("selection", {})
    
    if selection.get("text"):
        return selection["text"]
    
    return full_content
```

### 4. 意图驱动的响应策略

```python
def get_response_strategy(context: dict) -> dict:
    intent = context.get("intent", {}).get("primary", "unknown")
    
    strategies = {
        "write": {"style": "creative", "length": "long"},
        "edit": {"style": "precise", "length": "similar"},
        "review": {"style": "critical", "length": "detailed"},
        "analyze": {"style": "analytical", "length": "structured"},
        "translate": {"style": "accurate", "length": "equivalent"},
    }
    
    return strategies.get(intent, {"style": "balanced", "length": "moderate"})
```

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0 | 2024-01 | 初始版本 |

---

## 示例：完整请求流程

```typescript
// 前端代码
import { buildChatPayload, contextManager } from '@/lib/context';

// 1. 更新上下文
contextManager.setWorkspace({
  id: 'ws_001',
  path: '/Users/xxx/招投标项目',
  name: '招投标项目2024',
  domain: 'tender',
  domainConfidence: 0.92,
  teachcardIds: ['tender-master'],
});

contextManager.setDocument({
  id: 'doc_001',
  name: '投标方案.md',
  type: 'markdown',
  // ...
});

// 2. 发送请求
const payload = buildChatPayload('请帮我检查这份投标文件的风险点', {
  autoContext: true,
});

const response = await fetch('/api/control/chat', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...contextManager.getHeaders(),
  },
  body: JSON.stringify(payload),
});
```

```python
# 后端代码
@router.post("/control/chat")
async def chat(request: Request, payload: ChatPayload):
    # 1. 获取上下文
    context = payload.context or {}
    domain = context.get("workspace", {}).get("domain", "general")
    
    # 2. 构建领域化 prompt
    system_prompt = build_system_prompt(context)
    
    # 3. 加载教卡能力
    skills = await load_teachcard_skills(context)
    
    # 4. 获取处理目标
    target_text = get_target_text(context, payload.message)
    
    # 5. 调用 LLM
    response = await llm.chat(
        system=system_prompt,
        user=target_text,
        tools=skills,
    )
    
    return response
```

