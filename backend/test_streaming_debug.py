"""
流式输出调试测试脚本

用于测试 DeepAgent 和 Graph 的流式输出功能
启用 LangChain 详细调试信息
"""

import os
import sys
import asyncio
from pathlib import Path

# 添加项目根目录到路径
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

# ✅ 启用 LangChain 详细调试信息
os.environ["LANGCHAIN_TRACING_V2"] = "true"
os.environ["LANGCHAIN_VERBOSE"] = "true"
os.environ["LANGCHAIN_DEBUG"] = "true"
os.environ["LANGCHAIN_LOG"] = "all"

# 设置日志级别
import logging
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s [%(levelname)s] [%(name)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

from langchain_core.messages import HumanMessage
from backend.engine.core.main_graph import graph

async def test_streaming():
    """测试流式输出"""
    print("=" * 80)
    print("🚀 开始测试流式输出")
    print("=" * 80)
    
    # 创建测试消息
    messages = [
        HumanMessage(content="你好，请简单介绍一下你自己")
    ]
    
    state = {
        "messages": messages,
        "source": "chatarea",
        "request_type": "agent_chat",
    }
    
    print(f"\n📤 发送消息: {messages[0].content}")
    print(f"📊 状态: {state}")
    print("\n" + "=" * 80)
    print("📥 开始接收流式输出:")
    print("=" * 80 + "\n")
    
    # 使用 astream 获取流式输出
    update_count = 0
    message_count = 0
    
    try:
        async for event in graph.astream(state):
            update_count += 1
            print(f"\n[更新 #{update_count}]")
            print(f"事件类型: {type(event)}")
            print(f"事件内容: {event}")
            
            # 检查是否有消息
            if isinstance(event, dict):
                for node_name, node_data in event.items():
                    print(f"\n  节点: {node_name}")
                    if isinstance(node_data, dict) and 'messages' in node_data:
                        messages_in_node = node_data['messages']
                        if messages_in_node:
                            message_count += len(messages_in_node)
                            print(f"  ✅ 发现 {len(messages_in_node)} 条消息")
                            for i, msg in enumerate(messages_in_node):
                                msg_type = getattr(msg, 'type', type(msg).__name__)
                                content_preview = str(getattr(msg, 'content', ''))[:100]
                                print(f"    消息 {i+1}: {msg_type} - {content_preview}...")
                    else:
                        print(f"  ⚠️  节点数据格式: {type(node_data)}")
            
            print("-" * 80)
            
    except Exception as e:
        print(f"\n❌ 错误: {e}")
        import traceback
        traceback.print_exc()
    
    print("\n" + "=" * 80)
    print(f"✅ 测试完成")
    print(f"   总更新数: {update_count}")
    print(f"   总消息数: {message_count}")
    print("=" * 80)

if __name__ == "__main__":
    asyncio.run(test_streaming())

