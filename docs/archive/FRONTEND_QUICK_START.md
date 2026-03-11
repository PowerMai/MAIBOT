# 🚀 前端快速启动指南

**最后更新**: 2025-12-26  
**状态**: ✅ 生产就绪

---

## 📋 前置要求

### 1. 后端已启动

```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378/backend
langgraph dev
```

✅ 验证后端：访问 http://localhost:2024/health

### 2. 环境变量

在 `frontend/.env` 或 `frontend/desktop/.env` 中设置：

```bash
REACT_APP_LANGGRAPH_API_URL=http://localhost:2024
```

---

## 🏃 快速启动

### 1. 安装依赖（首次）

```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378/frontend/desktop
npm install
```

### 2. 启动开发服务器

```bash
npm run dev
```

### 3. 打开浏览器

访问: http://localhost:3001

---

## 🎯 使用流程

### Step 1: 打开工作区

1. 点击左侧面板的 **"打开工作区"** 按钮
2. 选择项目文件夹
3. 文件树自动加载

### Step 2: 打开文件

1. 在左侧文件树中找到文件
2. 双击文件名
3. 文件内容显示在中间编辑器
4. 右侧 ChatArea 自动更新上下文信息

### Step 3: 编辑文件

1. 在编辑器中输入内容
2. 文件 Tab 会显示黄色圆点（表示已修改）
3. 等待 2 秒自动保存，或按 `Cmd+S` 手动保存
4. 保存成功后黄色圆点消失

### Step 4: 使用 AI 助手

#### 方式 1: 快捷操作
1. 在编辑器中选中一段代码
2. 底部出现 AI 快捷操作栏
3. 点击"扩写"、"重写"、"修复"或"解释"
4. AI 响应显示在右侧对话框

#### 方式 2: 对话输入
1. 在右侧对话框输入问题
2. 例如："帮我重构这个函数"
3. 按 `Enter` 发送（`Shift+Enter` 换行）
4. AI 会自动感知当前文件和选中文本

---

## ⌨️ 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Cmd+S` | 保存当前文件 |
| `Cmd+Shift+S` | 保存所有文件 |
| `Cmd+W` | 关闭当前文件 |
| `Cmd+R` | 刷新当前文件 |
| `Enter` | 发送消息（在对话框中） |
| `Shift+Enter` | 换行（在对话框中） |

---

## 🔍 功能概览

### 左栏 - 文件管理
- ✅ 工作区管理
- ✅ 文件树浏览
- ✅ 文件操作（创建、删除、重命名）
- ✅ 文件搜索
- ✅ 实时同步

### 中栏 - 代码编辑器
- ✅ 多文件 Tab
- ✅ 代码编辑
- ✅ 修改检测
- ✅ 自动保存
- ✅ 手动保存
- ✅ 文件刷新
- ✅ 版本历史
- ✅ AI 快捷操作

### 右栏 - AI 对话
- ✅ AI 助手对话
- ✅ 上下文感知
- ✅ 快捷操作（扩写、解释）
- ✅ 生成式 UI
- ✅ 实时连接状态

---

## 🐛 常见问题

### Q1: 右侧显示"AI 后端未连接"

**解决方案**:
1. 检查后端是否启动: `langgraph dev`
2. 检查后端地址: http://localhost:2024/health
3. 检查环境变量: `REACT_APP_LANGGRAPH_API_URL`

### Q2: 文件保存失败

**解决方案**:
1. 检查后端日志中的错误信息
2. 确认文件路径正确
3. 检查文件权限

### Q3: 文件树不显示

**解决方案**:
1. 确认已选择工作区
2. 检查浏览器控制台错误
3. 尝试刷新页面

### Q4: AI 响应缓慢

**可能原因**:
- LLM 模型正在推理（正常）
- 后端负载高
- 网络延迟

**解决方案**:
- 等待响应完成
- 查看后端日志
- 检查 LM Studio 状态

---

## 📁 核心文件

### 新增文件

```
frontend/
├── lib/
│   └── langgraphApi.ts              # LangGraph API 客户端
│
└── desktop/src/components/
    ├── FullEditorV2Enhanced.tsx     # 增强版编辑器
    └── ChatAreaEnhanced.tsx         # 增强版对话区
```

### 修改文件

```
frontend/desktop/src/components/
└── WorkspaceFileTree.tsx            # 添加 LangGraph API 集成
```

---

## 🔧 开发调试

### 1. 查看浏览器控制台

按 `F12` 或 `Cmd+Option+I` 打开开发者工具

查看控制台输出：
```
[LangGraph API] 发送请求: ...
[LangGraph API] 收到响应: ...
[FullEditorV2] 文件已打开: ...
[ChatArea] LangGraph 后端已连接
```

### 2. 查看网络请求

在开发者工具的 "Network" 标签中：
- 查看到 `http://localhost:2024/agent/invoke` 的请求
- 检查请求体和响应体
- 查看响应时间

### 3. 查看后端日志

在后端终端中查看：
```
→ DeepAgent 节点：开始执行 orchestrator Agent
✅ DeepAgent 完成，输出长度: XXX 字符
```

---

## 📊 性能指标

| 操作 | 预期时间 |
|------|----------|
| 打开文件 | < 500ms |
| 保存文件 | < 1s |
| AI 简单对话 | 2-5s |
| AI 复杂操作 | 5-15s |
| 文件树加载 | < 1s |

---

## ✅ 功能验证清单

### 基础功能
- [ ] 可以打开工作区
- [ ] 文件树正常显示
- [ ] 可以打开文件
- [ ] 可以编辑文件
- [ ] 可以保存文件
- [ ] Tab 切换正常

### AI 功能
- [ ] 右侧显示"已连接"
- [ ] 可以发送消息
- [ ] AI 可以正常响应
- [ ] 选中文本后显示快捷操作
- [ ] 扩写功能正常
- [ ] 解释功能正常

### 上下文传递
- [ ] 上下文信息栏显示当前文件
- [ ] 上下文信息栏显示选中文本
- [ ] AI 响应考虑了当前文件
- [ ] AI 响应考虑了选中文本

---

## 🎓 下一步学习

### 1. 了解 LangGraph API

查看文件: `frontend/lib/langgraphApi.ts`

核心函数：
```typescript
sendChatMessage(message, context)
sendEditorComplexOperation(message, operation, context)
readFile(filePath)
writeFile(filePath, content)
```

### 2. 了解组件通信

```
WorkspaceFileTree → FullEditorV2Enhanced
  通过 onFileOpen() 传递文件

FullEditorV2Enhanced → ChatArea
  通过 props 传递上下文:
  - editorContent
  - editorPath
  - selectedText
  - workspaceId
```

### 3. 了解后端集成

所有后端调用都通过 LangGraph API：
```typescript
import langgraphApi from '../../../lib/langgraphApi';

// 读取文件
const response = await langgraphApi.readFile(filePath);

// 保存文件
const response = await langgraphApi.writeFile(filePath, content);

// AI 对话
const response = await langgraphApi.sendChatMessage(message, context);
```

---

## 🆘 获取帮助

### 1. 查看文档

- `FRONTEND_IMPLEMENTATION_COMPLETE_REPORT.md` - 完整实现报告
- `FRONTEND_BACKEND_LANGCHAIN_DESIGN.md` - 架构设计
- `ARCHITECTURE_DESIGN_ANALYSIS.md` - 深度分析

### 2. 查看代码注释

所有核心文件都有详细的注释：
- 文件头部说明
- 函数功能说明
- 复杂逻辑注释

### 3. 调试技巧

在代码中添加 `console.log`:
```typescript
console.log('[调试] 当前状态:', state);
```

---

## 🎉 总结

您现在拥有一个完整的、生产级的三栏编辑器：

- ✅ 文件管理
- ✅ 代码编辑
- ✅ AI 助手
- ✅ 完整上下文
- ✅ 自动保存
- ✅ 版本管理

**开始使用吧！** 🚀

---

**如有问题，请查看浏览器控制台和后端日志。**

