# CHAPTER_SCORING_MAPPING

## Keywords
chapter generation, scoring mapping, content structure, 章节映射, 评分对应, 内容生成

---

## Quick Reference

| Total Chapters | Scoring Coverage | Generation Time | Quality Target |
|----------------|------------------|-----------------|----------------|
| 10-15 | 100% | 2-4 hours | >85 points |

---

## Standard Chapter-Scoring Mapping Matrix

| Chapter # | Chapter Name | Scoring Items | Total Points | Must-Have Evidence | Page Range |
|-----------|--------------|---------------|--------------|-------------------|------------|
| 1 | 项目概述 | 需求理解(5) | 5 | 需求对照表 | 2-3 |
| 2 | 公司介绍 | 公司实力(8), 资质(7) | 15 | 营业执照,资质证书 | 4-6 |
| 3 | 技术方案 | 方案完整性(15), 先进性(20), 可行性(15), 创新性(10) | 60 | 架构图,流程图,对比分析 | 20-30 |
| 4 | 实施方案 | 进度合理性(10), 资源配置(8) | 18 | 甘特图,资源表 | 8-12 |
| 5 | 质量保证 | 质量体系(5), 测试方案(5) | 10 | ISO证书,测试用例 | 4-6 |
| 6 | 项目团队 | 团队实力(10), PM经验(5) | 15 | 简历,证书 | 4-6 |
| 7 | 案例介绍 | 类似项目(10), 客户评价(5) | 15 | 合同,验收报告 | 6-10 |
| 8 | 风险管理 | 风险识别(5), 应对措施(5) | 10 | 风险矩阵 | 3-5 |
| 9 | 商务方案 | 价格合理性(30), 付款条款(5) | 35 | 价格清单,成本分解 | 6-8 |
| 10 | 服务承诺 | 售后服务(8), 培训方案(4), 维护方案(5) | 17 | 服务协议,培训计划 | 5-7 |

**Total**: 200 points across 10 chapters

---

## Scoring Item Detailed Mapping

### Technical Proposal (60 points)

| Scoring Item | Points | Chapter Location | Section | Content Requirements | Evidence | Length |
|--------------|--------|------------------|---------|---------------------|----------|--------|
| 方案完整性 | 15 | Ch.3 技术方案 | 3.1-3.3 | 需求100%覆盖,架构设计,功能设计 | 需求对照表,架构图 | 5-8页 |
| 技术先进性 | 20 | Ch.3 技术方案 | 3.4-3.5 | 前沿技术应用,对比分析,技术优势 | 技术白皮书,对比表 | 6-10页 |
| 实施可行性 | 15 | Ch.3 技术方案 | 3.6 + Ch.4 | 技术路线,实施步骤,资源保障 | 实施路线图,资源表 | 4-6页 |
| 创新性 | 10 | Ch.3 技术方案 | 3.7 | 创新点描述,价值分析 | 专利/论文/案例 | 2-3页 |

### Commercial Proposal (35 points)

| Scoring Item | Points | Chapter Location | Section | Content Requirements | Evidence | Length |
|--------------|--------|------------------|---------|---------------------|----------|--------|
| 价格合理性 | 30 | Ch.9 商务方案 | 9.1-9.2 | 总价,明细价格,成本构成,对比 | 价格清单,成本分解表 | 4-5页 |
| 付款条款 | 5 | Ch.9 商务方案 | 9.3 | 付款比例,付款节点,灵活性 | 付款计划表 | 1页 |

---

## Content Generation Template by Chapter

### Chapter 3: Technical Proposal (技术方案)

```python
def generate_technical_proposal(requirements, scoring_criteria, company_resources):
    """Generate technical proposal chapter"""
    
    chapter = {
        "title": "技术方案",
        "sections": []
    }
    
    # Section 3.1: Requirements Analysis (需求分析) - 方案完整性 Part 1
    section_3_1 = {
        "title": "3.1 需求分析",
        "scoring_item": "方案完整性(5分)",
        "content": generate_requirements_analysis(requirements),
        "must_include": [
            "需求对照表(100%覆盖)",
            "需求分类(功能性/非功能性)",
            "优先级分析"
        ]
    }
    
    # Section 3.2: Architecture Design (架构设计) - 方案完整性 Part 2
    section_3_2 = {
        "title": "3.2 架构设计",
        "scoring_item": "方案完整性(10分)",
        "content": generate_architecture_design(requirements),
        "must_include": [
            "总体架构图",
            "技术架构图",
            "网络拓扑图",
            "架构说明(每个组件的作用)"
        ],
        "diagrams": ["总体架构", "技术架构", "网络拓扑"]
    }
    
    # Section 3.3: Function Design (功能设计) - 方案完整性 Part 3
    section_3_3 = {
        "title": "3.3 功能设计",
        "scoring_item": "方案完整性(剩余分)",
        "content": generate_function_design(requirements),
        "must_include": [
            "功能模块列表",
            "每个模块的详细说明",
            "流程图",
            "界面原型(如需要)"
        ]
    }
    
    # Section 3.4: Technology Selection (技术选型) - 技术先进性 Part 1
    section_3_4 = {
        "title": "3.4 技术选型",
        "scoring_item": "技术先进性(10分)",
        "content": generate_technology_selection(requirements, company_resources),
        "must_include": [
            "技术选型表(技术栈清单)",
            "每项技术的选型理由",
            "技术对比分析(与传统方案对比)",
            "技术成熟度评估"
        ]
    }
    
    # Section 3.5: Technical Advantages (技术优势) - 技术先进性 Part 2
    section_3_5 = {
        "title": "3.5 技术优势",
        "scoring_item": "技术先进性(10分)",
        "content": generate_technical_advantages(company_resources),
        "must_include": [
            "3-5个核心技术优势",
            "每个优势的详细说明",
            "与竞品的对比",
            "创新点提炼",
            "支撑材料(专利/论文/案例)"
        ]
    }
    
    # Section 3.6: Implementation Roadmap (实施路线) - 实施可行性
    section_3_6 = {
        "title": "3.6 实施路线",
        "scoring_item": "实施可行性(15分)",
        "content": generate_implementation_roadmap(requirements),
        "must_include": [
            "实施步骤(Phase 1-N)",
            "每个阶段的里程碑",
            "技术路线图",
            "风险点和应对",
            "资源保障措施"
        ]
    }
    
    # Section 3.7: Innovation Points (创新点) - 创新性
    section_3_7 = {
        "title": "3.7 创新点",
        "scoring_item": "创新性(10分)",
        "content": generate_innovation_points(company_resources),
        "must_include": [
            "3-5个创新点",
            "每个创新点的详细描述",
            "创新带来的价值",
            "创新的可行性论证",
            "支撑材料(专利/获奖/论文)"
        ]
    }
    
    chapter["sections"] = [
        section_3_1, section_3_2, section_3_3,
        section_3_4, section_3_5, section_3_6, section_3_7
    ]
    
    return chapter
```

---

## Requirements-to-Content Mapping Flow

```python
def map_requirements_to_content(bidding_doc, scoring_criteria):
    """Map requirements to specific content in each chapter"""
    
    mapping = {
        "requirements": extract_requirements(bidding_doc),
        "scoring_tree": parse_scoring_criteria(scoring_criteria),
        "chapter_mapping": {}
    }
    
    # For each scoring item, determine where to address it
    for category in mapping['scoring_tree']['categories']:
        for item in category['items']:
            chapter_id = determine_chapter_from_item(item)
            section_id = determine_section_from_criteria(item['criteria'])
            
            if chapter_id not in mapping['chapter_mapping']:
                mapping['chapter_mapping'][chapter_id] = {
                    "title": get_chapter_title(chapter_id),
                    "sections": {},
                    "total_points": 0
                }
            
            mapping['chapter_mapping'][chapter_id]['sections'][section_id] = {
                "scoring_item": item['name'],
                "points": item['points'],
                "criteria": item['criteria'],
                "requirements": find_related_requirements(
                    item['criteria'], 
                    mapping['requirements']
                ),
                "content_guide": generate_content_guide(item),
                "evidence_needed": determine_evidence(item),
                "length_pages": estimate_length(item['points'])
            }
            
            mapping['chapter_mapping'][chapter_id]['total_points'] += item['points']
    
    return mapping

def determine_chapter_from_item(item_name):
    """Determine which chapter based on scoring item name"""
    keywords_mapping = {
        "方案完整性|架构|功能|技术": 3,  # Ch.3 Technical Proposal
        "进度|实施|资源配置": 4,         # Ch.4 Implementation Plan
        "质量|测试": 5,                  # Ch.5 Quality Assurance
        "团队|人员|PM": 6,               # Ch.6 Project Team
        "案例|项目|业绩": 7,             # Ch.7 Case Studies
        "价格|成本|报价": 9,             # Ch.9 Commercial Proposal
        "服务|培训|维护": 10             # Ch.10 Service Commitment
    }
    
    for pattern, chapter_id in keywords_mapping.items():
        if re.search(pattern, item_name):
            return chapter_id
    
    return 1  # Default to Ch.1 if unclear
```

---

## Content Quality Checklist per Scoring Item

### For "方案完整性(15分)"

| Check Item | Pass Criteria | Verification Method |
|------------|---------------|---------------------|
| 需求覆盖率 | 100% | 需求对照表,逐项检查 |
| 架构完整性 | 包含总体/技术/网络三层架构 | 架构图审查 |
| 功能完整性 | 每个功能模块都有说明 | 功能清单检查 |
| 图表质量 | 清晰/专业/标注完整 | 图表审查 |
| 逻辑连贯性 | 章节之间相互呼应 | 交叉引用检查 |

### For "技术先进性(20分)"

| Check Item | Pass Criteria | Verification Method |
|------------|---------------|---------------------|
| 技术栈先进性 | 使用业界前沿技术 | 技术调研对比 |
| 对比分析 | 与传统方案对比,优势明显 | 对比表审查 |
| 创新点 | 至少3个创新点,有支撑材料 | 创新点清单 |
| 技术深度 | 技术细节充分,不是泛泛而谈 | 专业性审查 |
| 可信度 | 有案例/专利/论文等支撑 | 证据材料审查 |

---

## Auto-Generation Code Template

```python
def auto_generate_chapter(chapter_id, mapping_info, company_resources):
    """Auto-generate chapter content based on mapping"""
    
    chapter = {
        "id": chapter_id,
        "title": mapping_info['title'],
        "sections": []
    }
    
    for section_id, section_info in mapping_info['sections'].items():
        section = {
            "id": section_id,
            "title": f"{chapter_id}.{section_id} {section_info['title']}",
            "scoring_item": section_info['scoring_item'],
            "content": ""
        }
        
        # Generate content based on type
        if section_info['type'] == "requirements_analysis":
            section['content'] = generate_requirements_table(
                section_info['requirements']
            )
        elif section_info['type'] == "architecture":
            section['content'] = generate_architecture_description(
                company_resources['architecture_templates']
            )
            section['diagrams'] = generate_architecture_diagrams()
        elif section_info['type'] == "technology_selection":
            section['content'] = generate_tech_selection_table(
                section_info['requirements'],
                company_resources['tech_stack']
            )
        elif section_info['type'] == "case_studies":
            section['content'] = generate_case_studies(
                company_resources['cases'],
                section_info['requirements']
            )
        # ... more types
        
        # Add evidence
        section['evidence'] = find_evidence_materials(
            section_info['evidence_needed'],
            company_resources
        )
        
        chapter['sections'].append(section)
    
    return chapter
```

---

## Scoring Coverage Validation

```python
def validate_scoring_coverage(generated_proposal, scoring_criteria):
    """Validate that all scoring points are covered"""
    
    validation_report = {
        "total_points": scoring_criteria['total'],
        "covered_points": 0,
        "coverage_details": [],
        "missing_items": [],
        "weak_coverage": []
    }
    
    for category in scoring_criteria['categories']:
        for item in category['items']:
            # Find where this scoring item is addressed
            coverage = find_in_proposal(generated_proposal, item)
            
            validation_report['coverage_details'].append({
                "item": item['name'],
                "points": item['points'],
                "found_in": coverage['locations'],
                "coverage_strength": coverage['strength'],  # 0-1
                "has_evidence": coverage['has_evidence']
            })
            
            if not coverage['found']:
                validation_report['missing_items'].append(item)
            elif coverage['strength'] < 0.7:
                validation_report['weak_coverage'].append({
                    "item": item,
                    "current_strength": coverage['strength'],
                    "suggestions": coverage['improvement_suggestions']
                })
            else:
                validation_report['covered_points'] += item['points']
    
    validation_report['coverage_rate'] = (
        validation_report['covered_points'] / 
        validation_report['total_points']
    )
    
    validation_report['pass'] = (
        validation_report['coverage_rate'] >= 0.95 and
        len(validation_report['missing_items']) == 0
    )
    
    return validation_report
```

---

## Output Example: Mapping JSON

```json
{
  "chapter_3_technical_proposal": {
    "title": "技术方案",
    "total_points": 60,
    "page_range": "20-30",
    "sections": {
      "3.1": {
        "title": "需求分析",
        "scoring_item": "方案完整性",
        "points": 5,
        "requirements": [
          "REQ-001: 用户管理功能",
          "REQ-002: 权限控制",
          "..."
        ],
        "must_include": [
          "需求对照表",
          "需求分类",
          "优先级"
        ],
        "evidence": ["需求对照表.xlsx"],
        "length": "2-3页"
      },
      "3.2": {
        "title": "架构设计",
        "scoring_item": "方案完整性",
        "points": 10,
        "must_include": [
          "总体架构图",
          "技术架构图",
          "网络拓扑图"
        ],
        "diagrams": ["architecture_v1.png", "tech_stack.png"],
        "length": "4-5页"
      }
    }
  }
}
```

---

## Next Steps

| Task | File | Query Keywords |
|------|------|----------------|
| Generate specific chapter | `templates/chapters/` | "generate chapter template" |
| Evaluate chapter quality | `evaluation/evaluate_chapter_quality.md` | "evaluate chapter quality" |
| Find evidence materials | `resources/company/` | "find evidence materials" |

