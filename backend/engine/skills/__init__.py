"""
Skills 系统 - 专业能力扩展

遵循 Agent Skills 标准 (https://agentskills.io/specification)

模块结构：
- skill_registry.py: Skill 注册表（发现、管理、查询）
- validate_skills.py: Skills 验证脚本

使用方式：

1. 获取注册表并发现 Skills:
    from backend.engine.skills import get_skill_registry
    
    registry = get_skill_registry()
    skills = registry.get_all_skills()

2. 按条件查询:
    registry.get_skills_by_domain("anthropic")
    registry.get_skills_for_mode("plan")
    registry.match_skills_by_query("创建 Excel 报表")

3. 验证 Skills:
    python -m backend.engine.skills.validate_skills

目录结构：
    knowledge_base/skills/
    ├── anthropic/         # Anthropic 官方 Skills
    ├── foundation/        # 基础能力
    ├── general/           # 通用能力
    ├── modes/             # 模式专用
    └── {domain}/          # 领域技能
"""

from .skill_registry import (
    SkillRegistry,
    SkillInfo,
    get_skill_registry,
    reload_skills,
)

__all__ = [
    "SkillRegistry",
    "SkillInfo",
    "get_skill_registry",
    "reload_skills",
]
