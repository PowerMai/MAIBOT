---
name: bidding
description: 解决方案专家在招投标场景下的端到端技能：招标分析、技术方案设计、标书撰写、合规审查、评标分析。接到招标文件可交付完整投标方案。
level: domain
triggers: [招标, 投标, 标书, RFP, 评标, 废标, 评分标准, 技术方案, 商务报价, 合规审查]
tools: [read_file, search_knowledge, write_file, edit_file, python_run, run_skill_script]
---

# 招投标专项技能（bidding）

解决方案专家在招投标场景下使用的**单一端到端专项技能**，覆盖从招标分析到评标分析的全流程。

## 何时使用

- 用户上传或提供招标文件（PDF/Word/文本），要求分析、撰写投标方案或做合规/评标分析。
- 用户询问与招标、投标、标书、评分标准、废标条款、技术方案、商务报价等相关问题。
- 关键词：招标、投标、标书、RFP、评标、废标、评分标准、技术方案、商务报价、合规审查、逐项分析。

## 依赖的已有技能与知识

- **格式处理**：使用 `pdf`、`docx` 技能（或 read_file）解析招标文件与生成投标文档。
- **推理与规划**：使用 `reasoning`、`plan-methodology` 做结构化分析与步骤规划。
- **知识检索**：使用 `search_knowledge` 查询 `knowledge_base/global/domain/bidding/` 下的流程与模板（如 00_GENERATE_BIDDING_DOCUMENT、01_ANALYZE_BIDDING_DOCUMENT_V2 等）。

## 工作流程（五阶段）

### 阶段 1：招标分析

1. 使用 read_file / pdf / docx 读取招标文件，提取项目信息、资格要求、评分标准、废标条款、技术规格。
2. 输出：风险清单、评分权重表、响应缺口列表、条款与证据来源映射。
3. 可调用 search_knowledge("01_ANALYZE_BIDDING_DOCUMENT_V2") 或「招标分析」获取详细步骤。

### 阶段 2：技术方案设计

1. 根据招标要求与评分标准，设计解决方案架构、实施计划、服务承诺。
2. 输出：方案框架、章节与评分对应关系、关键差异点。
3. 可调用 search_knowledge 检索知识库中的方案模板与最佳实践。

### 阶段 3：标书撰写

1. 按大纲撰写技术方案、商务报价、投标函、资格证明、偏离表、承诺书等。
2. 使用 docx/写文件能力生成各卷文档，保证格式与招标要求一致。
3. 输出：完整投标文件集合及输出路径清单。
4. 可参考 knowledge_base/global/domain/bidding/ 下 00_GENERATE_BIDDING_DOCUMENT、06_WRITE_TECHNICAL、07_WRITE_COMMERCIAL 等文档。

### 阶段 4：合规审查

1. 对照招标文件检查条款响应完整性、格式（字体、页码、签章）、实质性响应要求。
2. 输出：合规检查结果、问题项与修订建议、高风险项标注。
3. 发现高风险项时必须给出替代路径或负责人建议。

### 阶段 5：评标分析（可选）

1. 根据评分办法与己方响应，预估得分与优劣势。
2. 输出：得分策略建议、竞争对比要点、改进优先级。

## 质量门

- 所有结论必须映射到招标文件条款与证据来源。
- 关键字段与页码可追溯；导出文档无乱码、无缺页、无占位符。
- 废标条款、资格要求、评分标准需完整提取并显式标注。
- 有不确定性时显式标注并给验证路径。

## 输出格式示例

- **分析产出**：项目信息表、评分标准表、风险清单、响应缺口列表。
- **方案产出**：技术/商务方案骨架、各卷文档路径清单、合规检查结果、go/no-go 建议。

## 可用脚本（scripts/）

本技能提供可执行脚本，建议优先使用 `run_skill_script("bidding", script_name, args=[...])` 以复现结果。

| 脚本 | 用途 | 示例 |
|------|------|------|
| parse_tender.py | 从招标文本抽取结构化信息（资格要求、评分标准、废标条款、技术规格） | `run_skill_script("bidding", "parse_tender.py", args=["path/to/tender.txt"])` 或 `--stdin` 从标准输入读入 |
| compliance_check.py | 对照招标要求与己方响应，输出合规检查结果、问题项与高风险项 | `run_skill_script("bidding", "compliance_check.py", args=["tender.json", "response.json"])` |

解析前需先用 read_file 或 pdf/docx 技能获取招标文件内容，再写入临时 .txt 或通过 stdin 传入 parse_tender.py；合规检查的输入为 parse_tender 产出 JSON 与己方响应 JSON。

## 注意事项

- 本技能为**一个**端到端专项；内部可拆分为多步执行，但对外统一以 `bidding` 名称被 list_skills/match_skills 发现。
- 若需执行插件 `plugins/sales/skills/` 下的子技能（如 bidding-overview 路由的子技能），由运行时按 skill_profile 加载插件路径后使用；本 SKILL.md 描述通用流程与知识库引用，与插件能力包互补。
