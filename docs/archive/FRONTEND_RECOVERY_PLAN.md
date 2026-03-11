# 前端修复方案

## 当前问题
FullEditorV2.tsx (~2193 行) 存在严重的代码结构问题:
1. 变量声明顺序混乱 (activeFile, activeChatId, handleNewFile等)
2. 函数引用在定义之前
3. React Hooks 规则违反
4. 过多冗余状态管理

## 建议方案

### 方案 A: 全面重构 FullEditorV2 (时间长)
- 重新组织所有状态声明
- 修复所有函数定义顺序
- 拆分成多个小组件
- 预计需要 2-3 小时

### 方案 B: 创建简化版 MainEditorPage (快速) ✅ 推荐
- 保留三栏布局结构
- 左边栏: WorkspaceFileTree (已有)
- 中间: 基础文本编辑器 (Textarea)
- 右边栏: ChatArea (已有，使用LangGraph SDK)
- 预计需要 30 分钟

### 方案 C: 逐步修复 Full Editor V2
- 按错误一个一个修复
- 每次修复一个变量引用问题
- 不确定总共有多少个问题
- 预计需要 1-2 小时

## 执行步骤 (方案 B)

1. 创建 `SimpleMainEditorPage.tsx`:
   - 导入 WorkspaceFileTree
   - 导入 ChatArea
   - 简单的 Textarea 作为编辑器
   - 基础文件读写功能

2. 修改 App.tsx:
   - 将 MainEditorPage 替换为 SimpleMainEditorPage

3. 测试验证:
   - 左边栏文件管理可用
   - 中间编辑器可用
   - 右边栏聊天可用

4. 后续优化:
   - 逐步添加更多编辑器功能
   - 集成语法高亮
   - 添加文件tab管理

