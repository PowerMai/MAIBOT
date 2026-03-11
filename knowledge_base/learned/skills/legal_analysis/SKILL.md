---
name: legal_analysis
description: 自动学习的legal领域分析技能，基于 32 个文档
level: learned
domain: legal
source: learned
triggers: ["接口", "用户手册", "提示", "选择", "选项", "设备配置", "密码", "所示", "注意", "固件"]
tools: ["search_knowledge", "python_run", "read_file"]
confidence: 0.9
auto_generated: true
---

# legal_analysis

自动学习的legal领域分析技能，基于 32 个文档

## 触发条件

当用户请求涉及以下关键词时使用此技能：
- 接口
- 用户手册
- 提示
- 选择
- 选项
- 设备配置
- 密码
- 所示
- 注意
- 固件

## 工作流程

1. 1. 识别legal领域的关键要素
2. 2. 使用 search_knowledge 检索相关知识
3. 3. 使用 python_run 进行数据分析
4. 4. 生成分析报告

## 来源文档

- /Users/workspace/DevelopProjects/ccb-v0.378/knowledge_base/global/domain/contracts/06_rules/legal_requirements.md
- /Users/workspace/DevelopProjects/ccb-v0.378/knowledge_base/global/domain/bidding/基础资料/产品资料/终端部材料/03-专用服务器/0303-服务器方案/长城国密堡垒机  擎天ZH720/长城堡垒机_产品介绍2c-V1.2.pdf
- /Users/workspace/DevelopProjects/ccb-v0.378/knowledge_base/global/domain/bidding/基础资料/产品资料/终端部材料/03-专用服务器/0302-软防护服务器/擎天DF729（ZH720） 所有资料/擎天DF7系列服务器_用户手册 _V1.7.pdf
- /Users/workspace/DevelopProjects/ccb-v0.378/knowledge_base/global/domain/bidding/基础资料/产品资料/终端部材料/03-专用服务器/0302-软防护服务器/擎天ZH720 所有资料/擎天ZH720_用户手册 _V1.0.pdf
- /Users/workspace/DevelopProjects/ccb-v0.378/knowledge_base/global/domain/bidding/基础资料/产品资料/终端部材料/02-终端整机资料/0202-兆芯终端/长城TN140C2 所有资料/长城TN140C2_用户手册_V1.1.pdf
