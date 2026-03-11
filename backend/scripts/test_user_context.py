"""
测试用户上下文传递

测试 search_knowledge 工具是否能正确获取用户上下文
"""

import asyncio


async def test_with_config():
    """测试带 config 的调用"""
    print("\n" + "="*60)
    print("测试 1: 带 config 的调用")
    print("="*60)
    
    from backend.tools.base.embedding_tools import get_knowledge_retriever_tool
    
    search_tool = get_knowledge_retriever_tool()
    if not search_tool:
        print("❌ search_knowledge 工具不可用")
        return
    
    # 调用工具
    result = search_tool.invoke("招投标流程")
    
    print(f"\n结果:\n{result[:500]}...")


async def test_without_config():
    """测试不带 config 的调用"""
    print("\n" + "="*60)
    print("测试 2: 不带 config 的调用")
    print("="*60)
    
    from backend.tools.base.embedding_tools import get_knowledge_retriever_tool
    
    search_tool = get_knowledge_retriever_tool()
    if not search_tool:
        print("❌ search_knowledge 工具不可用")
        return
    
    result = search_tool.invoke("招投标")
    
    print(f"\n结果:\n{result[:500]}...")


async def main():
    """主函数"""
    print("="*60)
    print("用户上下文传递测试")
    print("="*60)
    
    await test_with_config()
    await test_without_config()
    
    print("\n" + "="*60)
    print("测试完成")
    print("="*60)


if __name__ == "__main__":
    asyncio.run(main())
