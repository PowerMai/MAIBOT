"""
Skills 系统验证脚本

验证所有 Skills 是否符合 Agent Skills 标准：
1. SKILL.md 存在且格式正确
2. name 字段为英文（小写字母、数字、连字符）
3. description 非空且 < 1024 字符
4. 目录名与 name 匹配（推荐）
5. skill_profiles.json 中各 profile 的 paths 是否存在且为目录（仅 warning，不阻塞）
6. Orchestrator 是否挂载 list_skills、match_skills、run_skill_script、get_skill_info（仅 warning，不阻塞）

使用方式：
    python -m backend.engine.skills.validate_skills
"""

import re
import yaml
from pathlib import Path
from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass

# 项目根目录与 Skills 根（与 skill_registry 一致：skills/ + learned/skills/）
PROJECT_ROOT = Path(__file__).resolve().parents[3]
SKILLS_ROOT = PROJECT_ROOT / "knowledge_base" / "skills"
LEARNED_SKILLS_ROOT = PROJECT_ROOT / "knowledge_base" / "learned" / "skills"

# Agent Skills 标准约束（agentskills.io/specification）
MAX_NAME_LENGTH = 64
MIN_DESCRIPTION_LENGTH = 1
MAX_DESCRIPTION_LENGTH = 1024
MAX_BODY_LINES = 500  # 建议 SKILL 正文 <500 行，详细内容放 references/
NAME_PATTERN = re.compile(r'^[a-z0-9]+(-[a-z0-9]+)*$')  # 小写字母、数字、连字符
# 启发式：description 中常见「何时使用」类表述（中英文）
WHEN_TO_USE_HINTS = ("何时", "when", "use when", "适用", "适合", "用于", "当", "若需要", "如需")


@dataclass
class ValidationResult:
    """验证结果"""
    path: str
    valid: bool
    errors: List[str]
    warnings: List[str]
    name: str = ""
    description: str = ""


def validate_skill_name(name: str, directory_name: str) -> Tuple[bool, Optional[str]]:
    """验证 Skill 名称"""
    if not name:
        return False, "name 字段为空"
    
    if len(name) > MAX_NAME_LENGTH:
        return False, f"name 超过 {MAX_NAME_LENGTH} 字符"
    
    if not NAME_PATTERN.match(name):
        return False, f"name '{name}' 格式不符合标准（应为小写字母、数字、连字符）"
    
    if name.startswith('-') or name.endswith('-'):
        return False, "name 不能以连字符开头或结尾"
    
    if '--' in name:
        return False, "name 不能包含连续的连字符"
    
    return True, None


def validate_skill_file(skill_md: Path) -> ValidationResult:
    """验证单个 SKILL.md 文件"""
    result = ValidationResult(
        path=str(skill_md.relative_to(PROJECT_ROOT)),
        valid=True,
        errors=[],
        warnings=[],
    )
    
    try:
        content = skill_md.read_text(encoding="utf-8")
    except Exception as e:
        result.valid = False
        result.errors.append(f"无法读取文件: {e}")
        return result
    
    # 解析 YAML frontmatter
    match = re.match(r'^---\s*\n(.*?)\n---', content, re.DOTALL)
    if not match:
        result.valid = False
        result.errors.append("缺少 YAML frontmatter（--- 分隔符）")
        return result
    
    try:
        metadata = yaml.safe_load(match.group(1))
    except yaml.YAMLError as e:
        result.valid = False
        result.errors.append(f"YAML 解析错误: {e}")
        return result
    
    if not isinstance(metadata, dict):
        result.valid = False
        result.errors.append("frontmatter 不是有效的 YAML 映射")
        return result
    
    # 验证必需字段：name
    name = metadata.get("name")
    if not name:
        result.valid = False
        result.errors.append("缺少必需字段: name")
    else:
        result.name = str(name)
        directory_name = skill_md.parent.name
        name_valid, name_error = validate_skill_name(str(name), directory_name)
        if not name_valid:
            result.valid = False
            result.errors.append(name_error)
        
        # 检查名称与目录名是否匹配（警告）
        if name != directory_name and name.replace('-', '_') != directory_name:
            result.warnings.append(f"name '{name}' 与目录名 '{directory_name}' 不匹配")
    
    # 验证必需字段：description（Agent Skills：1–1024 字符，建议含「做什么+何时用」）
    description = metadata.get("description")
    if not description:
        result.valid = False
        result.errors.append("缺少必需字段: description")
    else:
        desc_str = str(description).strip()
        result.description = desc_str[:100] + "..." if len(desc_str) > 100 else desc_str
        if len(desc_str) < MIN_DESCRIPTION_LENGTH:
            result.valid = False
            result.errors.append("description 不能为空")
        elif len(desc_str) > MAX_DESCRIPTION_LENGTH:
            result.warnings.append(f"description 超过 {MAX_DESCRIPTION_LENGTH} 字符，建议精简")
        # 启发式：建议含「何时使用」类表述
        if desc_str and not any(h in desc_str.lower() for h in WHEN_TO_USE_HINTS):
            result.warnings.append("description 建议包含「何时使用」类表述（如 when/use when/适用/用于）")
    
    # 可选：SKILL.md body 行数超 500 行给出 warning（建议拆到 references/）
    try:
        body_start = content.find("\n---", 3)
        if body_start >= 0:
            body = content[body_start + 4 :].lstrip()
            body_lines = len([l for l in body.splitlines() if l.strip()])
            if body_lines > MAX_BODY_LINES:
                result.warnings.append(
                    f"SKILL 正文约 {body_lines} 行，超过建议 {MAX_BODY_LINES} 行，可考虑将详细内容移至 references/"
                )
    except Exception:
        pass

    # 检查可选字段
    if metadata.get("license"):
        pass  # license 字段存在

    return result


def validate_all_skills() -> Dict[str, List[ValidationResult]]:
    """验证所有 Skills（knowledge_base/skills/ + knowledge_base/learned/skills/）"""
    results = {
        "valid": [],
        "invalid": [],
        "warnings": [],
    }
    
    def iter_skill_files():
        if SKILLS_ROOT.exists():
            for f in SKILLS_ROOT.rglob("SKILL.md"):
                try:
                    rel = f.relative_to(SKILLS_ROOT)
                    if "template" in rel.parts or "spec" in rel.parts:
                        continue
                    yield f
                except ValueError:
                    yield f
        if LEARNED_SKILLS_ROOT.exists():
            for f in LEARNED_SKILLS_ROOT.rglob("SKILL.md"):
                yield f

    skill_files = list(iter_skill_files())
    if not skill_files and not SKILLS_ROOT.exists():
        print(f"❌ Skills 目录不存在: {SKILLS_ROOT}")
        return results
    
    for skill_md in skill_files:
        # 跳过模板/规范目录（与 skill_registry 一致）
        try:
            rel = skill_md.relative_to(SKILLS_ROOT)
            parts = rel.parts
        except ValueError:
            parts = ()
        if "template" in parts or "spec" in parts:
            continue
        
        result = validate_skill_file(skill_md)
        
        if result.valid and not result.warnings:
            results["valid"].append(result)
        elif result.valid and result.warnings:
            results["warnings"].append(result)
        else:
            results["invalid"].append(result)
    
    return results


def validate_orchestrator_skill_tools() -> List[str]:
    """校验 Orchestrator 是否挂载 list_skills、match_skills、run_skill_script、get_skill_info。返回 warning 消息列表。"""
    warnings = []
    try:
        from backend.engine.agent.deep_agent import ORCHESTRATOR_SKILL_TOOL_NAMES
        from backend.tools.base.registry import get_core_tool_by_name
    except ImportError as e:
        warnings.append(f"无法导入 deep_agent/registry 以校验 Orchestrator Skills 工具: {e}")
        return warnings
    for name in ORCHESTRATOR_SKILL_TOOL_NAMES:
        try:
            get_core_tool_by_name(name)
        except Exception as e:
            warnings.append(f"Orchestrator 应挂载的 Skills 工具未在 registry 中注册: {name} ({e})")
    return warnings


def validate_profile_paths() -> List[str]:
    """校验 skill_profiles.json 中各 profile 的 paths 是否存在且为目录。返回 warning 消息列表。"""
    import json
    config_path = PROJECT_ROOT / "backend" / "config" / "skill_profiles.json"
    warnings = []
    if not config_path.exists():
        return warnings
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        warnings.append(f"无法解析 skill_profiles.json: {e}")
        return warnings
    profiles = data.get("profiles") or {}
    for profile_id, profile in profiles.items():
        paths = profile.get("paths")
        if paths is None:
            continue
        for p in paths:
            if not p or not p.strip():
                continue
            full = PROJECT_ROOT / p.strip()
            if not full.exists():
                warnings.append(f"profile '{profile_id}' 的 path 不存在: {p}")
            elif not full.is_dir():
                warnings.append(f"profile '{profile_id}' 的 path 不是目录: {p}")
    return warnings


def print_report(results: Dict[str, List[ValidationResult]]):
    """打印验证报告"""
    print("=" * 70)
    print("Skills 系统验证报告")
    print("=" * 70)
    
    total = len(results["valid"]) + len(results["invalid"]) + len(results["warnings"])
    
    print(f"\n📊 总计: {total} 个 Skills")
    print(f"   ✅ 有效: {len(results['valid'])}")
    print(f"   ⚠️  有警告: {len(results['warnings'])}")
    print(f"   ❌ 无效: {len(results['invalid'])}")
    
    if results["invalid"]:
        print("\n" + "-" * 70)
        print("❌ 无效的 Skills（需要修复）：")
        print("-" * 70)
        for r in results["invalid"]:
            print(f"\n📁 {r.path}")
            for error in r.errors:
                print(f"   ❌ {error}")
    
    if results["warnings"]:
        print("\n" + "-" * 70)
        print("⚠️  有警告的 Skills（建议修复）：")
        print("-" * 70)
        for r in results["warnings"]:
            print(f"\n📁 {r.path}")
            if r.name:
                print(f"   name: {r.name}")
            for warning in r.warnings:
                print(f"   ⚠️  {warning}")
    
    if results["valid"]:
        print("\n" + "-" * 70)
        print("✅ 有效的 Skills：")
        print("-" * 70)
        
        # 按 domain 分组
        by_domain = {}
        for r in results["valid"]:
            # 从路径提取 domain
            parts = Path(r.path).parts
            domain = parts[2] if len(parts) >= 4 else "other"
            if domain not in by_domain:
                by_domain[domain] = []
            by_domain[domain].append(r)
        
        for domain, skills in sorted(by_domain.items()):
            print(f"\n  [{domain}] ({len(skills)} 个)")
            for r in skills:
                print(f"    - {r.name}: {r.description[:50]}...")
    
    # Profile paths 校验（仅 warning）
    path_warnings = validate_profile_paths()
    if path_warnings:
        print("\n" + "-" * 70)
        print("⚠️  Profile paths 校验（skill_profiles.json）：")
        print("-" * 70)
        for w in path_warnings:
            print(f"   ⚠️  {w}")
        print("   paths 应为 knowledge_base/skills/ 或 knowledge_base/learned/skills/ 下已存在目录")

    # Orchestrator Skills 工具校验（仅 warning）
    skill_tool_warnings = validate_orchestrator_skill_tools()
    if skill_tool_warnings:
        print("\n" + "-" * 70)
        print("⚠️  Orchestrator Skills 工具校验：")
        print("-" * 70)
        for w in skill_tool_warnings:
            print(f"   ⚠️  {w}")
        print("   deep_agent 的 orchestrator_tools 应包含 list_skills、match_skills、run_skill_script、get_skill_info")
    print("\n" + "=" * 70)
    
    if results["invalid"]:
        print("⚠️  发现无效 Skills，请修复后重新验证")
        return False
    else:
        print("✅ 所有 Skills 验证通过！")
        return True


def main():
    """主函数"""
    results = validate_all_skills()
    success = print_report(results)
    return 0 if success else 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
