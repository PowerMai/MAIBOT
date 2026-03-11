---
name: mcp-builder
description: 设计与集成 MCP 工具能力，确保接口稳定、可观测、可治理。
level: general
triggers: [MCP, 服务, 工具, 连接]
---

# MCP Builder

## 目标
- 建立可复用 MCP 能力接入流程。
- 保证工具 schema、权限和错误处理一致。

## 执行步骤
1. 定义工具契约（输入、输出、错误码、权限）。
2. 实现服务端工具并补齐 descriptor。
3. 在代理侧完成注册、调用与回退策略。
4. 做端到端验证与观测埋点。

## 质量门
- 调用前必须读取 schema/descriptor。
- 失败路径必须返回结构化错误。
- 关键工具必须有最小可运行示例。

详细接入模板见：`knowledge_base/skills/integration-reference.md`
