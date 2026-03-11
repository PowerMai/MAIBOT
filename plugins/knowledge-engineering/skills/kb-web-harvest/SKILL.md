---
name: kb-web-harvest
description: 从可信互联网来源批量采集知识并生成可验证草稿。
---

# KB Web Harvest

## 核心规则
1. 来源优先级：官方文档 > 标准组织 > 行业权威媒体 > 其他。
2. 每条条目必须保留 `source_url` 与证据摘录，不可只保结论。
3. 采集与抽取分离：先抓正文，再结构化抽取。
4. 同主题至少保留 2 个来源用于交叉验证。
5. 入库前必须运行 `verify_knowledge_entry`。

## 推理链示范
Input: “采集招投标合规检查公开知识”
Step 1 [检索]: 用 `web_search` 生成来源候选。
Step 2 [筛选]: 按可信度和时效性筛出优先来源。
Step 3 [抓取]: 用 `web_fetch/web_crawl_batch` 拉正文。
Step 4 [抽取]: 用 `content_extract` 产出结构化草稿。
Step 5 [验证]: 对每条运行 `verify_knowledge_entry`。

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

## 端到端示例
Input:
- 目标：采集“招投标合规检查”公开知识并形成入库草稿
- 关键词：废标条款、资格审查、响应矩阵

工具调用序列:
1. `web_search` 生成来源候选并按可信度排序
2. `web_fetch`/`web_crawl_batch` 抓取正文并去重 URL
3. `content_extract` 抽取结构化知识条目
4. `verify_knowledge_entry` 校验每条记录完整性
5. `python_run` 汇总通过率并生成失败重试清单

Output（示例）:
- 来源 34 个，去重后 URL 21 个
- 有效条目 143 条，验证通过率 88.1%
- 失败条目 17 条（主因：证据摘录缺失/置信度不足）
