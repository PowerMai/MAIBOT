#!/bin/bash

# FullEditorV2Enhanced 功能验证脚本

echo "========================================="
echo "  FullEditorV2Enhanced 功能验证"
echo "========================================="
echo ""

# 检查前端服务器
echo "1. 检查前端服务器..."
if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 | grep -q "200"; then
    echo "✅ 前端服务器运行正常 (http://localhost:3000)"
else
    echo "⚠️  前端服务器未运行，请先启动："
    echo "   cd frontend/desktop && npm run dev"
fi
echo ""

# 检查后端服务器
echo "2. 检查后端 LangGraph Server..."
if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:2024/ok | grep -q "200"; then
    echo "✅ 后端服务器运行正常 (http://127.0.0.1:2024)"
else
    echo "⚠️  后端服务器未运行，请先启动："
    echo "   source backend/.venv/bin/activate && cd backend && langgraph dev"
fi
echo ""

# 检查文件修改
echo "3. 检查关键文件..."

if [ -f "frontend/desktop/src/components/FullEditorV2Enhanced.tsx" ]; then
    echo "✅ FullEditorV2Enhanced.tsx 存在"
    
    # 检查是否包含 Tab 切换代码
    if grep -q "leftPanelTab" frontend/desktop/src/components/FullEditorV2Enhanced.tsx; then
        echo "✅ Tab 状态已添加 (leftPanelTab)"
    else
        echo "❌ Tab 状态未找到"
    fi
    
    # 检查是否导入了 KnowledgeBasePanel
    if grep -q "KnowledgeBasePanel" frontend/desktop/src/components/FullEditorV2Enhanced.tsx; then
        echo "✅ KnowledgeBasePanel 已导入"
    else
        echo "❌ KnowledgeBasePanel 未导入"
    fi
    
    # 检查是否导入了 Tabs 组件
    if grep -q "TabsContent" frontend/desktop/src/components/FullEditorV2Enhanced.tsx; then
        echo "✅ Tabs 组件已导入"
    else
        echo "❌ Tabs 组件未导入"
    fi
else
    echo "❌ FullEditorV2Enhanced.tsx 未找到"
fi
echo ""

# 检查 TypeScript 编译
echo "4. 检查 TypeScript 编译..."
cd frontend/desktop
if npm run type-check 2>&1 | grep -q "error"; then
    echo "❌ TypeScript 编译有错误"
    npm run type-check
else
    echo "✅ TypeScript 编译通过"
fi
cd ../..
echo ""

# 检查知识库文件
echo "5. 检查知识库结构..."
if [ -d "data/knowledge_base/global" ]; then
    echo "✅ 全局知识库目录存在"
    echo "   文件数: $(find data/knowledge_base/global -type f 2>/dev/null | wc -l)"
else
    echo "⚠️  全局知识库目录不存在"
fi

if [ -d "data/knowledge_base/users" ]; then
    echo "✅ 个人知识库目录存在"
    echo "   用户数: $(find data/knowledge_base/users -maxdepth 1 -type d 2>/dev/null | wc -l)"
else
    echo "⚠️  个人知识库目录不存在"
fi

if [ -d "data/knowledge_base/teams" ]; then
    echo "✅ 团队知识库目录存在"
    echo "   团队数: $(find data/knowledge_base/teams -maxdepth 1 -type d 2>/dev/null | wc -l)"
else
    echo "⚠️  团队知识库目录不存在"
fi
echo ""

# 测试建议
echo "========================================="
echo "  手动测试步骤"
echo "========================================="
echo ""
echo "1. 打开浏览器访问: http://localhost:3000/"
echo ""
echo "2. 测试左侧 Tab 切换："
echo "   ✓ 点击【工作区】Tab → 应显示文件树"
echo "   ✓ 点击【知识库】Tab → 应显示知识库列表"
echo "   ✓ Tab 切换应流畅无延迟"
echo ""
echo "3. 测试工作区功能："
echo "   ✓ 创建新工作区（如 test-workspace）"
echo "   ✓ 上传测试文件（test.md）"
echo "   ✓ 点击文件 → 中间编辑器打开"
echo "   ✓ 编辑内容 → 观察 Tab 显示 ● 标记"
echo "   ✓ Cmd+S 保存 → ● 消失"
echo ""
echo "4. 测试知识库功能："
echo "   ✓ 切换到【知识库】Tab"
echo "   ✓ 查看可用知识库列表"
echo "   ✓ 选择知识库并搜索内容"
echo "   ✓ 查看搜索结果"
echo ""
echo "5. 测试 AI 集成："
echo "   ✓ 在右侧聊天输入: '我的知识库中有哪些文档？'"
echo "   ✓ 观察 AI 是否自动查询知识库"
echo "   ✓ 检查返回结果是否包含来源标识"
echo ""
echo "6. 测试文件编辑："
echo "   ✓ 打开多个文件（测试多 Tab）"
echo "   ✓ 编辑文件内容"
echo "   ✓ 测试自动保存（2秒延迟）"
echo "   ✓ 测试快捷键 Cmd+S, Cmd+R, Cmd+W"
echo ""
echo "========================================="
echo "  文档查看"
echo "========================================="
echo ""
echo "详细文档:"
echo "  - FULLEDITOR_V2_INTEGRATION_COMPLETE.md (实施报告)"
echo "  - QUICK_UI_TEST_GUIDE.md (测试指南)"
echo "  - UI_INTEGRATION_COMPLETE.md (UI 集成总结)"
echo ""
echo "========================================="
echo "  验证完成"
echo "========================================="

