---
name: kb-web-harvest
description: 从可信互联网来源批量采集知识并生成可验证草稿。
level: general
triggers: [互联网采集, 网页抓取, 知识扩充, 批量来源]
tools: [web_search, web_fetch, web_crawl_batch, content_extract, verify_knowledge_entry, python_run]
---

# KB Web Harvest

## 核心规则
1. 来源优先级：官方文档 > 标准组织 > 行业权威媒体 > 其他。
2. 每条条目必须保留 `source_url` 与证据摘录，不可只保结论。
3. 采集与抽取分离：先抓正文，再结构化抽取。
4. 同主题至少保留 2 个来源用于交叉验证。
5. 入库前必须运行 `verify_knowledge_entry`。

## 执行步骤
- 建立采集主题和关键词列表。
- 批量抓取并去重 URL。
- 结构化抽取为标准知识条目。
- 验证通过后写入待入库目录。
- 产出失败清单与重试建议。

## 交付模板
- 采集主题
- 来源列表（含优先级）
- 有效条目数/失败条目数
- 失败原因分布
- 下一轮补采建议

## 验证
- 必检字段：`source_url`、`evidence`、`confidence`
- 必给统计：来源数量、去重后 URL 数、验证通过率

详细推理链、端到端示例见：`knowledge_base/skills/knowledge_engineering/reference.md`
