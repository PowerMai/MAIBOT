# Integration Skills Reference

用于 `mcp-builder` 与 `skill-creator` 的详细规则补充。

## MCP Builder 补充
- 先定义 descriptor，再实现调用逻辑。
- 输入参数必须显式校验，避免隐式转换。
- 失败响应统一结构：`ok=false`、`error`、`action`。
- 保留最小 E2E 测试：可调用、可失败、可回退。

## Skill Creator 补充
- 优先复用现有 skill，不重复造轮子。
- `SKILL.md` 建议控制在 60 行内，仅保留入口流程。
- 长样例、异常分支、模板放入 `reference.md`。
- 变更后需验证：可匹配、可执行、可验收。
