# MAIBOT

> 此文件在会话启动时自动加载，记录项目级长期记忆与约定。

## 关键文件与目录

| 路径 | 用途 |
|------|------|
| `.maibot/MAIBOT.md` | 项目记忆主文件（本文件） |
| `.maibot/rules/` | 模块化规则与洞察（按需加载） |
| `tmp/uploads/` | 用户上传文件 |
| `tmp/outputs/` | Agent 产出文件 |
| `knowledge_base/` | 领域知识、Skills、学习产出 |

## 偏好

- 语言：简体中文
- 输出风格：先结论后过程
- 证据要求：标注来源和位置

## 经验

- 后端：LangGraph + DeepAgent（Python）
- 前端：React + assistant-ui（TypeScript）
- 模式：Agent / Ask / Plan / Debug

## 规则

- 优先最小必要改动，避免无关改写
- 复杂任务优先采用 `explore + knowledge -> planning -> executor` 协作链
- 涉及事实、计算、结论时优先补充可验证证据

