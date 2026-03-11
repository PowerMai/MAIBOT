# 后端与前端约定的推理流事件格式，用于保障 qwen3.5 思考流能正确显示。
# 见：main_graph 发送 type=reasoning 的 data 形状；前端 RunTracker / thread.tsx 解析 data.phase、data.msg_id、data.content。

REASONING_EVENT_TYPE = "reasoning"

REASONING_PHASE_START = "start"
REASONING_PHASE_CONTENT = "content"
REASONING_PHASE_END = "end"


def reasoning_start_payload(msg_id=None):
    """后端发送的 reasoning 开始事件。前端据此显示「思考中」并匹配 msg_id。"""
    data = {"phase": REASONING_PHASE_START}
    if msg_id is not None:
        data["msg_id"] = msg_id
    return {"type": REASONING_EVENT_TYPE, "data": data}


def reasoning_content_payload(msg_id: str, content: str):
    """后端发送的推理内容片段。前端据此追加到对应 messageId 的思考块。"""
    return {
        "type": REASONING_EVENT_TYPE,
        "data": {
            "phase": REASONING_PHASE_CONTENT,
            "msg_id": msg_id,
            "content": content,
        },
    }


def reasoning_end_payload(msg_id=None):
    """后端发送的 reasoning 结束事件。前端据此结束「思考中」状态。"""
    data = {"phase": REASONING_PHASE_END}
    if msg_id is not None:
        data["msg_id"] = msg_id
    return {"type": REASONING_EVENT_TYPE, "data": data}


def test_reasoning_start_shape():
    """前端 RunTracker.resolveRunPhaseLabel / thread useAgentPhase 依赖 type=reasoning 且 data.phase=start；后端可带 msg_id 便于关联消息。"""
    payload = reasoning_start_payload()
    assert payload["type"] == "reasoning"
    assert payload["data"]["phase"] == "start"
    payload_with_id = reasoning_start_payload(msg_id="ai_123")
    assert payload_with_id["data"].get("msg_id") == "ai_123"


def test_reasoning_content_shape():
    """前端 useNativeReasoningBlocks 依赖 type=reasoning、data.phase=content、data.msg_id、data.content。"""
    payload = reasoning_content_payload("ai_123", "思考片段")
    assert payload["type"] == "reasoning"
    assert payload["data"]["phase"] == "content"
    assert payload["data"]["msg_id"] == "ai_123"
    assert payload["data"]["content"] == "思考片段"


def test_reasoning_end_shape():
    """前端 thread useAgentPhase 在 phase=end 时清空思考状态；后端可带 msg_id。"""
    payload = reasoning_end_payload()
    assert payload["type"] == "reasoning"
    assert payload["data"]["phase"] == "end"
    payload_with_id = reasoning_end_payload(msg_id="ai_123")
    assert payload_with_id["data"].get("msg_id") == "ai_123"


def test_frontend_content_phase_parsing():
    """模拟前端从 event 读取 phase/content/msg_id 的方式（thread.tsx useNativeReasoningBlocks）。"""
    event = {"type": "reasoning", "data": {"phase": "content", "msg_id": "ai_456", "content": "abc"}}
    phase = event.get("data", {}).get("phase") or event.get("phase")
    content = (event.get("data") or {}).get("content") or event.get("content")
    msg_id = (event.get("data") or {}).get("msg_id") or event.get("msg_id")
    assert phase == "content"
    assert content == "abc"
    assert msg_id == "ai_456"
