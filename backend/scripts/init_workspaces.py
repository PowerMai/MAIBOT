#!/usr/bin/env python3
"""
初始化 LangGraph Store 工作区

功能：
1. 创建默认工作区
2. 设置工作区元信息
3. 初始化文件结构
"""

import os
import sys
from pathlib import Path
import json
from datetime import datetime

# 添加项目根目录到 Python 路径
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

# LangGraph Store Client
try:
    from langchain_langgraph import Client
    client = Client(api_url="http://localhost:2024")
except Exception as e:
    print(f"⚠️  警告：LangGraph Server 未运行")
    print(f"   错误：{e}")
    client = None


class WorkspaceInitializer:
    def __init__(self):
        self.workspaces = [
            {
                "id": "default",
                "name": "默认工作区",
                "description": "系统默认工作区",
                "type": "virtual",
                "created_at": datetime.now().isoformat(),
            },
            {
                "id": "projects",
                "name": "项目工作区",
                "description": "项目文件和代码",
                "type": "virtual",
                "created_at": datetime.now().isoformat(),
            },
            {
                "id": "documents",
                "name": "文档工作区",
                "description": "投标文档和合同",
                "type": "virtual",
                "created_at": datetime.now().isoformat(),
            },
        ]
    
    def create_workspace(self, workspace: dict):
        """创建单个工作区"""
        print(f"\n📁 创建工作区: {workspace['name']}")
        
        if not client:
            print(f"   ⚠️  跳过（Server 未运行）")
            return False
        
        try:
            # 存储工作区元信息
            namespace = ["workspaces", workspace["id"], "metadata"]
            client.store.put(namespace, workspace)
            print(f"   ✅ 已创建: {' / '.join(namespace)}")
            
            # 创建示例文件
            self._create_example_files(workspace["id"])
            return True
        except Exception as e:
            print(f"   ❌ 创建失败: {e}")
            return False
    
    def _create_example_files(self, workspace_id: str):
        """为工作区创建示例文件"""
        example_files = {
            "default": {
                "README.md": "# 默认工作区\n\n这是系统默认工作区。",
            },
            "projects": {
                "README.md": "# 项目工作区\n\n存放项目代码和文档。",
                "sample.py": "# Sample Python Script\nprint('Hello, World!')",
            },
            "documents": {
                "README.md": "# 文档工作区\n\n存放投标文档和合同。",
            },
        }
        
        files = example_files.get(workspace_id, {})
        for filename, content in files.items():
            try:
                namespace = ["workspaces", workspace_id, "files", filename]
                client.store.put(namespace, {
                    "content": content,
                    "created_at": datetime.now().isoformat(),
                })
                print(f"      📄 示例文件: {filename}")
            except Exception as e:
                print(f"      ❌ 文件创建失败: {filename} - {e}")
    
    def initialize(self):
        """执行完整初始化流程"""
        print("=" * 60)
        print("🚀 开始初始化工作区")
        print("=" * 60)
        
        success_count = 0
        for workspace in self.workspaces:
            if self.create_workspace(workspace):
                success_count += 1
        
        print("\n" + "=" * 60)
        print(f"✅ 初始化完成")
        print(f"   成功：{success_count}/{len(self.workspaces)}")
        print("=" * 60)


if __name__ == "__main__":
    initializer = WorkspaceInitializer()
    initializer.initialize()

