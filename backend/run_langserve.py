#!/usr/bin/env python3
"""
LangServe 启动脚本

使用 LangGraph 的 LangServe 自动 API 生成功能，
暴露 Agent 为 REST 服务
"""

import sys
from pathlib import Path

# 修复导入路径
project_root = Path(__file__).parent.parent
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from langserve import add_routes

# 导入 Agent
from backend.engine.agent.deep_agent import agent

# 创建 FastAPI 应用
app = FastAPI(
    title="Document Processing Agent",
    description="基于 DeepAgent 的文档处理 API",
    version="1.0.0",
)


# 根路径重定向到 docs
@app.get("/")
async def redirect_to_docs():
    return RedirectResponse(url="/docs")


# 添加 Agent 路由
# LangServe 会自动生成以下端点：
# - POST /orchestrator/invoke - 同步调用
# - POST /orchestrator/stream - 流式调用
# - POST /orchestrator/batch - 批量调用
# - GET /orchestrator/openapi.json - OpenAPI Schema
add_routes(app, agent, path="/orchestrator")


if __name__ == "__main__":
    import uvicorn
    
    print("\n" + "=" * 80)
    print("🚀 启动 LangServe API Server")
    print("=" * 80)
    print("\n📝 可用端点：")
    print("  - POST /orchestrator/invoke - 同步调用 Agent")
    print("  - POST /orchestrator/stream - 流式调用 Agent")
    print("  - POST /orchestrator/batch - 批量调用 Agent")
    print("  - GET /orchestrator/openapi.json - OpenAPI Schema")
    print("\n📖 API 文档：")
    print("  - Swagger UI: http://localhost:8001/docs")
    print("  - ReDoc: http://localhost:8001/redoc")
    print("\n" + "=" * 80 + "\n")
    
    # 启动服务器
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8001,
        log_level="info",
    )

