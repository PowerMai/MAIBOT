#!/usr/bin/env python3
"""
初始化 LangGraph Store 知识库

功能：
1. 扫描 backend/knowledge/ 目录
2. 加载所有文档（.md, .txt, .pdf）
3. 对文档进行分块和向量化
4. 存储到 LangGraph Store

依赖：
- langchain
- sentence-transformers (HuggingFace Embeddings)
"""

import os
import sys
from pathlib import Path
import json
from datetime import datetime

# 添加项目根目录到 Python 路径
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain.embeddings import HuggingFaceEmbeddings
from langchain_community.document_loaders import (
    TextLoader,
    UnstructuredMarkdownLoader,
    PyPDFLoader,
)

# LangGraph Store Client（需要 Server 运行）
try:
    from langchain_langgraph import Client
    client = Client(api_url="http://localhost:2024")
except Exception as e:
    print(f"⚠️  警告：LangGraph Server 未运行，使用模拟模式")
    print(f"   错误：{e}")
    client = None


class KnowledgeBaseInitializer:
    def __init__(self, knowledge_dir: str = "backend/knowledge"):
        self.knowledge_dir = Path(knowledge_dir)
        self.embeddings = HuggingFaceEmbeddings(
            model_name="BAAI/bge-large-zh-v1.5",
            model_kwargs={'device': 'cpu'}
        )
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=500,
            chunk_overlap=50,
            separators=["\n\n", "\n", "。", "！", "？", "，", " ", ""],
        )
        
    def scan_knowledge_directory(self):
        """扫描知识库目录"""
        print(f"\n📁 扫描知识库目录: {self.knowledge_dir}")
        
        if not self.knowledge_dir.exists():
            print(f"❌ 目录不存在，创建默认目录...")
            self.knowledge_dir.mkdir(parents=True, exist_ok=True)
            self._create_default_knowledge()
            
        documents = []
        for ext in ['.md', '.txt', '.pdf']:
            files = list(self.knowledge_dir.rglob(f'*{ext}'))
            print(f"   找到 {len(files)} 个 {ext} 文件")
            documents.extend(files)
            
        return documents
    
    def _create_default_knowledge(self):
        """创建默认知识库文档"""
        default_docs = {
            "招投标/投标文件编写指南.md": """# 投标文件编写指南

## 1. 文档结构
- Executive Summary
- Company Profile
- Technical Proposal
- Commercial Proposal
- Implementation Plan

## 2. 关键要点
- 明确需求分析
- 技术方案设计
- 质量保证措施
- 风险管理计划
""",
            "招投标/评分标准.md": """# 招投标评分标准

## 技术评分（60-70%）
- 技术方案完整性
- 创新性
- 可行性

## 商务评分（20-35%）
- 价格合理性
- 支付条款
- 财务担保

## 团队能力（10-15%）
- 团队资质
- 项目经验
- 案例展示
""",
            "通用/项目管理最佳实践.md": """# 项目管理最佳实践

## 规划阶段
1. 需求分析
2. 任务分解（WBS）
3. 资源配置

## 执行阶段
1. 进度跟踪
2. 质量控制
3. 风险管理

## 收尾阶段
1. 验收测试
2. 文档交付
3. 经验总结
""",
        }
        
        for rel_path, content in default_docs.items():
            file_path = self.knowledge_dir / rel_path
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text(content, encoding='utf-8')
            print(f"   ✅ 创建默认文档: {rel_path}")
    
    def load_document(self, file_path: Path):
        """加载单个文档"""
        try:
            if file_path.suffix == '.md':
                loader = UnstructuredMarkdownLoader(str(file_path))
            elif file_path.suffix == '.txt':
                loader = TextLoader(str(file_path), encoding='utf-8')
            elif file_path.suffix == '.pdf':
                loader = PyPDFLoader(str(file_path))
            else:
                return None
                
            docs = loader.load()
            return docs[0] if docs else None
        except Exception as e:
            print(f"   ❌ 加载失败: {file_path.name} - {e}")
            return None
    
    def process_document(self, file_path: Path):
        """处理单个文档：分块 + 向量化"""
        print(f"\n📄 处理文档: {file_path.name}")
        
        # 1. 加载文档
        doc = self.load_document(file_path)
        if not doc:
            return None
            
        # 2. 提取元信息（从路径推断）
        rel_path = file_path.relative_to(self.knowledge_dir)
        parts = rel_path.parts
        
        # 路径结构：{domain}/{doc_name}.md
        domain = parts[0] if len(parts) > 1 else "通用"
        doc_name = file_path.stem
        
        # 3. 分块
        chunks = self.text_splitter.split_text(doc.page_content)
        print(f"   📊 分成 {len(chunks)} 个块")
        
        # 4. 向量化
        print(f"   🔢 向量化中...")
        embeddings = self.embeddings.embed_documents(chunks)
        
        # 5. 构建文档对象
        doc_id = f"{domain}_{doc_name}".replace(" ", "_").lower()
        document = {
            "id": doc_id,
            "title": doc_name,
            "content": doc.page_content,
            "file_path": str(rel_path),
            "chunks": [
                {
                    "text": chunk,
                    "embedding": emb,
                    "index": i
                }
                for i, (chunk, emb) in enumerate(zip(chunks, embeddings))
            ],
            "metadata": {
                "domain": domain,
                "file_type": file_path.suffix,
                "created_at": datetime.now().isoformat(),
                "word_count": len(doc.page_content),
                "chunk_count": len(chunks),
            }
        }
        
        return document
    
    def store_document(self, document: dict):
        """存储文档到 LangGraph Store"""
        if not client:
            print(f"   ⚠️  跳过存储（Server 未运行）")
            return False
            
        try:
            # 存储到 Store
            # 命名空间：["knowledge", "default", "all", domain, doc_id]
            namespace = [
                "knowledge",
                "default",      # organization
                "all",          # team
                document["metadata"]["domain"],
                document["id"]
            ]
            
            client.store.put(namespace, document)
            print(f"   ✅ 已存储: {' / '.join(namespace)}")
            return True
        except Exception as e:
            print(f"   ❌ 存储失败: {e}")
            return False
    
    def initialize(self):
        """执行完整初始化流程"""
        print("=" * 60)
        print("🚀 开始初始化知识库")
        print("=" * 60)
        
        # 1. 扫描文档
        documents = self.scan_knowledge_directory()
        print(f"\n📊 共找到 {len(documents)} 个文档")
        
        if not documents:
            print("❌ 没有找到文档，退出")
            return
        
        # 2. 处理每个文档
        success_count = 0
        for file_path in documents:
            doc_data = self.process_document(file_path)
            if doc_data:
                if self.store_document(doc_data):
                    success_count += 1
        
        # 3. 总结
        print("\n" + "=" * 60)
        print(f"✅ 初始化完成")
        print(f"   成功：{success_count}/{len(documents)}")
        print("=" * 60)


if __name__ == "__main__":
    initializer = KnowledgeBaseInitializer()
    initializer.initialize()

