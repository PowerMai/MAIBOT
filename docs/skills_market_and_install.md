# Skills 市场与安装说明

本文档说明市场数据源、`url` 字段与远程清单（remote_url）的用法，便于从市场或上游（如 Anthropic skills）增强本系统能力。

## 一、市场配置

- **backend/config/skills_market.json**：本地市场列表。
  - **source_type**：`"local"` 表示仅使用本文件；`"remote"` 表示优先从 **remote_url** 拉取 JSON，失败时回退本地。
  - **remote_url**：可选，指向返回与本地 `skills` 数组同结构的 JSON（含 `skills` 数组）。可用于托管外部市场或与 anthropics/skills 对齐的清单。
  - **skills**：数组，每项建议含 `id`、`name`、`domain`、`description`、`version`、`requires_tier`、**url**（可选）。

## 二、条目中的 url 与一键安装

- 市场条目可增加 **url** 字段，指向**单文件 SKILL.md 的纯文本地址**（如 GitHub raw、自建 CDN）。
- 前端「从市场安装」时：若该条目有 `url`，可调用 **POST /skills/install**，body 传 `url`、`name`、`domain`、`version`（及可选 `market_id`）；后端会 `GET url` 取文本并写入 `knowledge_base/skills/{domain}/{name}/SKILL.md`。
- 无 `url` 的条目：仅展示说明，不提供一键安装（或提示「联系管理员配置 url」）。
- **单文件安装**：POST /skills/install 仅支持单文件 SKILL.md 文本（content 或 url）。带 scripts/ 的完整包可使用 **POST /skills/install-zip**（multipart：file=zip，domain，name），解压到 `knowledge_base/skills/{domain}/{name}/`，含 SKILL.md 与 scripts/ 等；也可人工拷贝脚本目录。

## 三、remote_url 清单结构

远程 JSON 建议与本地一致，例如：

```json
{
  "source_type": "remote",
  "skills": [
    {
      "id": "skill-xxx",
      "name": "技能显示名",
      "domain": "general",
      "description": "描述",
      "version": "1.0.0",
      "requires_tier": "free",
      "url": "https://example.com/path/to/SKILL.md"
    }
  ]
}
```

清单中可包含指向 [anthropics/skills](https://github.com/anthropics/skills) 某文件 raw 的 URL；单文件安装不包含 scripts/，可改用 install-zip 上传完整 zip 或安装后人工拷贝 scripts/。

## 四、检查更新

- **GET /skills/check-updates**：对比本地已安装版本（由安装时写入的 version/market_id）与当前市场（本地或 remote_url 拉取）的 version，返回可更新列表及 **builtin_total**。
- 市场条目与 remote 清单中应保持 **version** 字段，以便检查更新生效。

与 [技能体系规划.md](技能体系规划.md)、[skills_claude_alignment.md](skills_claude_alignment.md) 配套使用。
