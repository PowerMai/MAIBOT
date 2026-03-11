# 学习产出目录

此目录存储知识学习系统的自动产出，由 `KnowledgeLearner` 生成。

## 目录结构

```
learned/
├── skills/          # 自动学习/结晶生成的 Skills（SKILL.md）
├── skill_stats/     # Skill 质量统计（JSON，含 ZERA 4 维评分）
├── insights/        # 自动洞察日志（JSONL + 每日 Markdown + Growth Radar 快照）
├── mistakes/        # 错误笔记本（JSONL，REMO 风格 + SCHEMA.md）
├── patterns/        # 可复用模式记录（Markdown + 结晶候选 JSONL）
├── docmaps/         # 文档结构映射（DocMap）
├── ontology/        # 领域本体数据
├── human_review_queue.jsonl  # 人工复核队列（质量维度 < 0.5 时触发）
├── skill_evolution_state.json # 交互计数等运行时状态
├── processed_index.json      # 已处理文档索引
├── learned_skills.json       # 学习到的技能元数据
└── domain_ontology.json      # 领域本体
```

## 使用方式

```python
# 通过 python_run 调用
from backend.tools.base.knowledge_learning import scan_and_learn
stats = scan_and_learn("/path/to/docs")

# 或学习单个文档
from backend.tools.base.knowledge_learning import learn_document
result = learn_document("/path/to/doc.pdf")
```

## 生成的 Skills

学习系统会自动为每个领域生成 Skills：
- `bidding_analysis/SKILL.md` - 招投标分析技能
- `contract_analysis/SKILL.md` - 合同分析技能
- 等等...

这些 Skills 会被 SkillsMiddleware 自动加载到系统提示词中。

## 注意事项

- 此目录的内容由系统自动生成，不建议手动修改
- 可以通过 `force=True` 参数强制重新学习
- 学习的 Skills 优先级高于通用 Skills
