#!/usr/bin/env python3
"""
测试 LangGraph Server 的流式输出
验证后端是否正确支持流式传输
"""

import asyncio
import sys
from pathlib import Path

# 添加项目根目录到路径
project_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(project_root))

from langchain_core.messages import HumanMessage
from langgraph_sdk import get_client


async def test_streaming():
    """测试流式输出"""
    print("=" * 80)
    print("🧪 测试 LangGraph Server 流式输出")
    print("=" * 80)
    
    # 创建客户端
    client = get_client(url="http://localhost:2024")
    
    # 创建线程
    print("\n1️⃣ 创建线程...")
    thread = await client.threads.create()
    thread_id = thread["thread_id"]
    print(f"✅ 线程创建成功: {thread_id}")
    
    # 准备输入
    input_data = {
        "messages": [
            {
                "type": "human",
                "content": "请用50个字介绍一下 Python 编程语言",
            }
        ]
    }
    
    print("\n2️⃣ 测试 streamMode='messages' (流式消息内容)...")
    print("-" * 80)
    
    try:
        stream = client.runs.stream(
            thread_id,
            "agent",
            input=input_data,
            stream_mode="messages",  # ✅ 流式消息模式
        )
        
        message_count = 0
        chunk_count = 0
        accumulated_content = ""
        
        async for event in stream:
            chunk_count += 1
            
            # StreamPart 对象有 event 和 data 属性
            event_type = getattr(event, "event", "unknown")
            event_data = getattr(event, "data", None)
            
            # 打印事件类型
            if chunk_count <= 5 or chunk_count % 10 == 0:
                print(f"📥 事件 #{chunk_count}: type={event_type}, data_type={type(event_data).__name__}")
            
            # 处理消息事件
            if event_type == "messages/partial":
                # 增量消息内容
                if isinstance(event_data, list) and len(event_data) > 0:
                    msg = event_data[0]
                    content = getattr(msg, "content", "") if hasattr(msg, "content") else msg.get("content", "")
                    if content:
                        accumulated_content += content
                        # 打印增量内容（模拟流式显示）
                        print(content, end="", flush=True)
                        message_count += 1
            
            elif event_type == "messages/complete":
                # 完整消息
                if isinstance(event_data, list) and len(event_data) > 0:
                    msg = event_data[0]
                    content = getattr(msg, "content", "") if hasattr(msg, "content") else msg.get("content", "")
                    if content and content != accumulated_content:
                        print(content, end="", flush=True)
                        accumulated_content = content
        
        print("\n" + "-" * 80)
        print(f"✅ 流式测试完成")
        print(f"   - 总事件数: {chunk_count}")
        print(f"   - 消息片段数: {message_count}")
        print(f"   - 累积内容长度: {len(accumulated_content)} 字符")
        
        if message_count > 0:
            print(f"\n✅ 流式输出正常！收到 {message_count} 个消息片段")
        else:
            print(f"\n⚠️  未收到消息片段，可能不是真正的流式输出")
        
    except Exception as e:
        print(f"\n❌ 流式测试失败: {e}")
        import traceback
        traceback.print_exc()
    
    print("\n3️⃣ 测试 streamMode='updates' (节点更新)...")
    print("-" * 80)
    
    try:
        # 创建新线程
        thread2 = await client.threads.create()
        thread_id2 = thread2["thread_id"]
        
        stream = client.runs.stream(
            thread_id2,
            "agent",
            input=input_data,
            stream_mode="updates",  # ❌ 节点更新模式（不适合聊天UI）
        )
        
        update_count = 0
        async for event in stream:
            update_count += 1
            event_type = getattr(event, "event", "unknown")
            event_data = getattr(event, "data", None)
            
            if update_count <= 5:
                print(f"📥 更新 #{update_count}: type={event_type}")
                if isinstance(event_data, dict):
                    print(f"   节点: {list(event_data.keys())}")
        
        print("-" * 80)
        print(f"✅ 节点更新测试完成")
        print(f"   - 总更新数: {update_count}")
        print(f"\n⚠️  updates 模式返回完整的节点状态，不是逐字符流式")
        
    except Exception as e:
        print(f"\n❌ 节点更新测试失败: {e}")
    
    print("\n4️⃣ 测试 streamMode='values' (完整状态)...")
    print("-" * 80)
    
    try:
        # 创建新线程
        thread3 = await client.threads.create()
        thread_id3 = thread3["thread_id"]
        
        stream = client.runs.stream(
            thread_id3,
            "agent",
            input=input_data,
            stream_mode="values",  # 完整状态模式
        )
        
        value_count = 0
        async for event in stream:
            value_count += 1
            event_type = getattr(event, "event", "unknown")
            
            if value_count <= 5:
                print(f"📥 状态 #{value_count}: type={event_type}")
        
        print("-" * 80)
        print(f"✅ 完整状态测试完成")
        print(f"   - 总状态数: {value_count}")
        print(f"\n⚠️  values 模式返回完整的 graph 状态，不是逐字符流式")
        
    except Exception as e:
        print(f"\n❌ 完整状态测试失败: {e}")
    
    print("\n" + "=" * 80)
    print("📊 测试总结")
    print("=" * 80)
    print("\n✅ 推荐配置（聊天 UI）:")
    print("   streamMode: 'messages'  # 逐字符/逐token流式输出")
    print("\n❌ 不推荐配置（聊天 UI）:")
    print("   streamMode: 'updates'   # 节点级别完整更新")
    print("   streamMode: 'values'    # Graph 完整状态")
    print("\n" + "=" * 80)


if __name__ == "__main__":
    asyncio.run(test_streaming())

