"""
测试多租户知识库

测试 KnowledgeBaseManager 的多租户功能
"""


def test_basic_retrieval():
    """测试基本检索"""
    print("\n" + "="*60)
    print("测试 1: 基本向量检索")
    print("="*60)
    
    from backend.knowledge_base.manager import KnowledgeBaseManager
    
    kb = KnowledgeBaseManager()
    results = kb.retrieve_vector("招投标流程", k=2)
    
    if results:
        for i, doc in enumerate(results, 1):
            print(f"\n【{i}】{doc.metadata.get('source', '未知')}")
            print(f"   内容: {doc.page_content[:200]}...")
    else:
        print("❌ 未找到结果（可能索引未创建）")


def test_hybrid_retrieval():
    """测试混合检索"""
    print("\n" + "="*60)
    print("测试 2: 混合检索")
    print("="*60)
    
    from backend.knowledge_base.manager import KnowledgeBaseManager
    
    kb = KnowledgeBaseManager()
    results = kb.retrieve_hybrid("投标文件编制", k=2)
    
    if results:
        for i, doc in enumerate(results, 1):
            print(f"\n【{i}】{doc.metadata.get('source', '未知')}")
            print(f"   内容: {doc.page_content[:200]}...")
    else:
        print("❌ 未找到结果")


def test_multi_source_retrieval():
    """测试多源检索"""
    print("\n" + "="*60)
    print("测试 3: 多源检索")
    print("="*60)
    
    from backend.knowledge_base.manager import KnowledgeBaseManager
    
    kb = KnowledgeBaseManager(user_id="demo-user", team_id="demo-team")
    results = kb.retrieve_multi_source("招投标流程", k=3)
    
    if results:
        for i, doc in enumerate(results, 1):
            source_type = doc.metadata.get('source_type', 'unknown')
            source = doc.metadata.get('source', '未知')
            print(f"\n【{i}】[{source_type}] {source}")
            print(f"   内容: {doc.page_content[:200]}...")
    else:
        print("❌ 未找到结果")


def test_search_knowledge_tool():
    """测试统一的 search_knowledge 工具"""
    print("\n" + "="*60)
    print("测试 4: search_knowledge 工具")
    print("="*60)
    
    from backend.tools.base.embedding_tools import get_knowledge_retriever_tool
    
    search_tool = get_knowledge_retriever_tool()
    if not search_tool:
        print("❌ search_knowledge 工具不可用")
        return
    
    result = search_tool.invoke("招投标流程")
    print(f"\n结果:\n{result[:500]}...")


def main():
    """主函数"""
    print("="*60)
    print("多租户知识库测试")
    print("="*60)
    
    test_basic_retrieval()
    test_hybrid_retrieval()
    test_multi_source_retrieval()
    test_search_knowledge_tool()
    
    print("\n" + "="*60)
    print("测试完成")
    print("="*60)


if __name__ == "__main__":
    main()
