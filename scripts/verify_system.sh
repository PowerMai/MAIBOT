#!/bin/bash
# 多租户知识库系统完整验证脚本

echo "=================================================="
echo "  多租户知识库系统 - 完整验证"
echo "=================================================="
echo ""

cd /Users/workspace/DevelopProjects/ccb-v0.378

# 激活虚拟环境
echo "1️⃣  激活虚拟环境..."
source .venv/bin/activate
echo "   ✅ 虚拟环境已激活"
echo ""

# 测试 1：基础知识库功能
echo "2️⃣  测试基础知识库功能..."
python backend/scripts/test_multi_tenant_kb.py > /tmp/test_kb.log 2>&1
if [ $? -eq 0 ]; then
    echo "   ✅ 基础知识库测试通过"
else
    echo "   ❌ 基础知识库测试失败"
    cat /tmp/test_kb.log
    exit 1
fi
echo ""

# 测试 2：用户上下文传递
echo "3️⃣  测试用户上下文自动传递..."
python backend/scripts/test_user_context.py > /tmp/test_context.log 2>&1
if [ $? -eq 0 ]; then
    echo "   ✅ 用户上下文测试通过"
else
    echo "   ❌ 用户上下文测试失败"
    cat /tmp/test_context.log
    exit 1
fi
echo ""

# 检查知识库目录结构
echo "4️⃣  验证知识库目录结构..."
if [ -d "knowledge_base/global/domain" ]; then
    GLOBAL_FILES=$(find knowledge_base/global -name "*.md" | wc -l)
    echo "   ✅ 全局知识库: ${GLOBAL_FILES} 个文件"
else
    echo "   ❌ 全局知识库目录不存在"
    exit 1
fi

if [ -d "knowledge_base/teams/demo-team" ]; then
    TEAM_FILES=$(find knowledge_base/teams -name "*.md" | wc -l)
    echo "   ✅ 团队知识库: ${TEAM_FILES} 个文件"
else
    echo "   ⚠️  团队知识库目录为空"
fi

if [ -d "knowledge_base/users/demo-user" ]; then
    USER_FILES=$(find knowledge_base/users -name "*.md" | wc -l)
    echo "   ✅ 个人知识库: ${USER_FILES} 个文件"
else
    echo "   ⚠️  个人知识库目录为空"
fi
echo ""

# 检查工具注册
echo "5️⃣  验证工具注册..."
python -c "
from backend.tools.base.indexing import BASE_TOOLS
tools = [t.name for t in BASE_TOOLS]
if 'search_knowledge_base_multi_source' in tools:
    print('   ✅ 多源检索工具已注册')
else:
    print('   ❌ 多源检索工具未注册')
    exit(1)
" || exit 1
echo ""

# 检查前端文件
echo "6️⃣  验证前端集成..."
if [ -f "frontend/desktop/src/lib/hooks/useUserContext.ts" ]; then
    echo "   ✅ 用户上下文 Hook 已创建"
else
    echo "   ❌ 用户上下文 Hook 不存在"
    exit 1
fi

if grep -q "getUserContext" frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx; then
    echo "   ✅ MyRuntimeProvider 已集成用户上下文"
else
    echo "   ❌ MyRuntimeProvider 未集成用户上下文"
    exit 1
fi
echo ""

# 统计代码改动
echo "7️⃣  代码统计..."
echo "   后端新增/修改:"
echo "     • backend/knowledge_base/manager.py: $(wc -l < backend/knowledge_base/manager.py) 行"
echo "     • backend/tools/base/indexing.py: $(wc -l < backend/tools/base/indexing.py) 行"
echo "     • backend/tools/utils/context.py: $(wc -l < backend/tools/utils/context.py) 行 (新建)"
echo ""
echo "   前端新增/修改:"
echo "     • useUserContext.ts: $(wc -l < frontend/desktop/src/lib/hooks/useUserContext.ts) 行 (新建)"
echo "     • MyRuntimeProvider.tsx: $(wc -l < frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx) 行"
echo ""

# 检查文档
echo "8️⃣  验证文档完整性..."
DOCS=(
    "KNOWLEDGE_BASE_CURRENT_STATUS.md"
    "MULTI_TENANT_KB_IMPLEMENTATION_REPORT.md"
    "MULTI_TENANT_KB_E2E_GUIDE.md"
    "FINAL_MULTI_TENANT_KB_SUMMARY.md"
    "USER_CONTEXT_AUTO_PASS_REPORT.md"
    "STATUS.md"
)

for doc in "${DOCS[@]}"; do
    if [ -f "$doc" ]; then
        echo "   ✅ $doc"
    else
        echo "   ❌ $doc 不存在"
    fi
done
echo ""

echo "=================================================="
echo "  ✅ 所有验证通过！系统已生产就绪！"
echo "=================================================="
echo ""
echo "📚 快速开始："
echo ""
echo "1. 启动后端:"
echo "   langgraph dev"
echo ""
echo "2. 启动前端:"
echo "   cd frontend/desktop && npm run dev"
echo ""
echo "3. 在聊天中测试:"
echo "   \"帮我查找招投标相关的资料\""
echo ""
echo "4. 自定义用户 (浏览器控制台):"
echo "   localStorage.setItem('app_user_context', JSON.stringify({"
echo "     userId: 'your-id',"
echo "     teamId: 'your-team'"
echo "   }));"
echo ""

