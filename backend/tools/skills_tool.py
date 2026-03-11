"""
Skills 辅助工具 - 发现、匹配、执行能力（不写死具体业务）

设计原则（Claude/DeepAgent 极简风格）：
- 业务场景由前端选择，后端按 skill_profile 加载能力子集（BUNDLE.md 内联 + 自定义工具注册）
- 本模块提供发现与执行辅助，具体业务流程在各自 SKILL.md 中描述

工具：
1. list_skills: 列出已安装能力（优先选用系统提示词中出现的，即当前场景已加载）
2. match_skills: 根据任务描述匹配相关能力（关键词由 skill_registry 扩展数据提供）
3. run_skill_script: 执行能力内脚本

降级：ls("knowledge_base/skills/")、read_file(SKILL.md)、shell_run/python_run
"""

import os
import subprocess
import json
from pathlib import Path
from typing import Optional, List, Dict, Any
from langchain_core.tools import tool

from backend.tools.base.paths import get_project_root

# 招投标专项能力名称（单一 skill，用于 list_skills/match_skills 提示）
BIDDING_SKILL_NAMES = frozenset({"bidding"})


def _source_label(source: str) -> str:
    """技能来源标签，与 catalog 一致。"""
    s = (source or "").strip()
    if s == "anthropic":
        return "【官方】"
    if s == "learned":
        return "【学习】"
    return "【内置】"


@tool
def list_skills(
    domain: Optional[str] = None,
    level: Optional[str] = None,
    profile: Optional[str] = None,
    mode: Optional[str] = None,
) -> str:
    """列出已安装的 Skills（能力）。当前会话已按业务场景加载了能力子集，系统提示词中仅包含该子集的 name+description；本工具列出全部已安装能力，优先选用系统提示词中出现的。传入 profile/mode 时仅返回当前运行时可用子集（与 BUNDLE 一致）。

    Use when:
    - 任务开始阶段需要快速盘点可用能力，决定技能路线。
    - 需要按 domain/level 过滤，缩小候选技能范围。

    Avoid when:
    - 已经明确目标 Skill 路径（直接 get_skill_info/read_file 更高效）。
    - 只想执行单个已知脚本（直接 run_skill_script）。

    Strategy:
    - 先 list_skills 粗筛，再 match_skills 精排，再 read_file(SKILL.md)执行。
    - 优先选用当前提示词已加载的能力，减少偏航。传入 profile 可与运行时可用集合一致。

    Skills 是模块化的专业能力（工作流程、脚本、最佳实践）。使用 read_file(路径) 读取 SKILL.md 获取详细指导。

    Args:
        domain: 筛选领域（如 format, foundation, general, domain, knowledge）
        level: 筛选层级（如 foundation, general, domain）
        profile: 可选，当前业务场景（如 full, bidding）；传入则仅返回该场景下运行时可用 Skills
        mode: 可选，当前模式（如 agent, plan）；与 profile 一起用于裁剪运行时可用集

    Returns:
        可用 Skills 列表，包含名称、描述和路径

    Example:
        list_skills()  # 列出所有已安装
        list_skills(domain="format")  # 按领域筛选
        list_skills(profile="full", mode="agent")  # 仅当前运行时可用
    """
    from backend.engine.skills.skill_registry import get_skill_registry
    from backend.engine.skills.skills_disabled import load_disabled_skills, skill_key

    registry = get_skill_registry()
    registry.discover_skills()

    # 获取 Skills
    if domain:
        skills = registry.get_skills_by_domain(domain)
    elif level:
        skills = registry.get_skills_by_level(level)
    else:
        skills = registry.get_all_skills()

    # P1-4 统一索引：按 profile/mode 裁剪为运行时可用集；按 tier（allow_skills）过滤
    tier_profile = None
    try:
        from backend.tools.utils.context import get_run_configurable
        tier_profile = get_run_configurable()
    except Exception:
        pass
    if profile or mode or tier_profile is not None:
        idx = registry.build_runtime_index(
            profile=profile or None,
            mode=mode or "agent",
            tier_profile=tier_profile,
        )
        enabled_names = {s.get("name") for s in (idx.get("skills") or []) if s.get("runtime_enabled")}
        if enabled_names:
            skills = [s for s in skills if s.name in enabled_names]

    # P3 全局禁用 + 会话级禁用：合并 configurable.disabled_skills 与全局列表
    disabled = set(load_disabled_skills())
    if tier_profile and isinstance(tier_profile, dict):
        extra = tier_profile.get("disabled_skills")
        if isinstance(extra, list):
            for k in extra:
                if isinstance(k, str) and k.strip():
                    disabled.add(k.strip())
    if disabled:
        skills = [s for s in skills if skill_key(getattr(s, "domain", "general"), getattr(s, "name", "")) not in disabled]

    if not skills:
        return "未找到符合条件的 Skills。"
    
    # 按领域分组
    by_domain: Dict[str, List] = {}
    for skill in skills:
        d = skill.domain
        if d not in by_domain:
            by_domain[d] = []
        by_domain[d].append(skill)
    
    # 格式化输出
    lines = [f"找到 {len(skills)} 个 Skills：\n"]
    
    for domain_name, domain_skills in sorted(by_domain.items()):
        lines.append(f"\n## {domain_name}/")
        for skill in domain_skills:
            lines.append(f"- **{skill.name}** {_source_label(getattr(skill, 'source', 'custom'))}: {skill.description[:100]}...")
            lines.append(f"  路径: `{skill.relative_path}`")
            if skill.has_scripts:
                lines.append(f"  脚本: {', '.join(skill.scripts[:3])}")
    
    _has_bidding = any(s.name in BIDDING_SKILL_NAMES for s in skills)
    lines.append("\n使用 `read_file(路径)` 读取 SKILL.md 获取详细指导。")
    if _has_bidding:
        lines.append("招投标：若提示词已含「招投标能力速查」，直接按速查执行，无需 read_file；第一步必须并行 read_file 与 search_knowledge。")
    return "\n".join(lines)


@tool
def match_skills(
    query: str,
    profile: Optional[str] = None,
    mode: Optional[str] = None,
) -> str:
    """根据任务描述匹配相关能力（Skills）。推荐在任务开始时调用，从已安装能力中找出与本任务最相关的，再按需 read_file(SKILL.md)。传入 profile/mode 时仅在当前运行时可用子集中匹配（与 list_skills 一致）。

    Use when:
    - 用户需求较长或模糊，需要自动选出最相关技能。
    - 需要快速定位“可复用流程”而不是临时生成方案。

    Avoid when:
    - query 极短且含歧义（先 ask_user 或补充上下文）。
    - 任务明显属于单一已知 skill（直接 get_skill_info）。

    Strategy:
    - query 写成“目标 + 产出 + 约束”三要素，匹配质量更高。
    - 取前 1-3 个技能交叉验证，避免单技能误匹配。传入 profile 可与运行时可用集合一致。

    Args:
        query: 任务描述（如 "分析招标文件" 或 "创建 Excel 报表"）
        profile: 可选，当前业务场景；传入则仅在运行时可用 Skills 中匹配
        mode: 可选，当前模式；与 profile 一起用于裁剪

    Returns:
        推荐的 Skills 列表，按相关度排序；优先选用系统提示词中已出现的（当前场景已加载）。

    Example:
        match_skills("分析这份招标文件")
        match_skills("创建 Excel 报表并画图", profile="full", mode="agent")
    """
    from backend.engine.skills.skill_registry import get_skill_registry
    from backend.engine.skills.skills_disabled import load_disabled_skills, skill_key

    registry = get_skill_registry()
    registry.discover_skills()

    matched_with_reasons = registry.match_skills_by_query_with_reasons(query, mode=mode or None)
    matched = [s for s, _ in matched_with_reasons]
    reason_by_name = {s.name: r for s, r in matched_with_reasons}

    # P1-4 统一索引：仅保留运行时可用；按 tier（allow_skills）过滤
    tier_profile = None
    try:
        from backend.tools.utils.context import get_run_configurable
        tier_profile = get_run_configurable()
    except Exception:
        pass
    if profile or mode or tier_profile is not None:
        idx = registry.build_runtime_index(
            profile=profile or None,
            mode=mode or "agent",
            tier_profile=tier_profile,
        )
        enabled_names = {s.get("name") for s in (idx.get("skills") or []) if s.get("runtime_enabled")}
        if enabled_names:
            matched = [s for s in matched if s.name in enabled_names]
            reason_by_name = {s.name: reason_by_name.get(s.name, "相关") for s in matched}

    # P3 全局禁用 + 会话级禁用：合并 configurable.disabled_skills 与全局列表
    disabled = set(load_disabled_skills())
    if tier_profile and isinstance(tier_profile, dict):
        extra = tier_profile.get("disabled_skills")
        if isinstance(extra, list):
            for k in extra:
                if isinstance(k, str) and k.strip():
                    disabled.add(k.strip())
    if disabled:
        matched = [s for s in matched if skill_key(getattr(s, "domain", "general"), getattr(s, "name", "")) not in disabled]
        reason_by_name = {s.name: reason_by_name.get(s.name, "相关") for s in matched}

    if not matched:
        # 推荐通用 Skills
        return (
            f"未找到精确匹配的 Skills。\n\n"
            f"建议：\n"
            f"1. 使用 `list_skills()` 查看所有可用 Skills\n"
            f"2. 使用 `list_skills(domain='anthropic')` 查看 Anthropic 官方 Skills\n"
            f"3. 使用 `search_knowledge('{query}')` 搜索知识库"
        )
    
    lines = [f"找到 {len(matched)} 个相关 Skills：\n"]
    _all_bidding = len(matched) <= 5 and all(skill.name in BIDDING_SKILL_NAMES for skill in matched[:5])

    for i, skill in enumerate(matched[:5], 1):  # 最多显示 5 个
        match_reason = reason_by_name.get(skill.name, "相关")
        lines.append(f"{i}. **{skill.name}** {_source_label(getattr(skill, 'source', 'custom'))} ({skill.domain}) — 匹配原因：{match_reason}")
        lines.append(f"   {skill.description}")
        lines.append(f"   → `read_file(\"{skill.relative_path}\")`")
        if skill.has_scripts:
            lines.append(f"   脚本: {', '.join(skill.scripts[:3])}")
        lines.append("")

    if _all_bidding:
        lines.append("提示：招投标任务直接按速查执行，无需 read_file；第一步必须并行（read_file 与 search_knowledge 同时发起）。")
    else:
        lines.append("提示：使用 `read_file` 读取 SKILL.md 获取详细工作流程。")
    return "\n".join(lines)


@tool
def run_skill_script(
    skill_name: str,
    script_name: str,
    args: Optional[List[str]] = None,
    working_dir: Optional[str] = None,
) -> str:
    """执行 Skill 中的脚本。

    Use when:
    - Skill 已提供确定性脚本，优先于临时代码生成。
    - 需要可复现、可审计的执行结果（固定入参和输出）。

    Avoid when:
    - Skill 没有 scripts/ 或脚本参数未知。
    - 任务需要强交互或长时守护进程（请改用专门流程）。

    Strategy:
    - 先 get_skill_info 确认脚本名与参数，再 run_skill_script 执行。
    - 执行失败时优先检查 cwd、入参和依赖，再回退 python_run。

    Skills 可能包含 scripts/ 目录，存放可执行的 Python/Shell 脚本。
    这些脚本提供确定性的操作，比生成代码更可靠。

    Args:
        skill_name: Skill 名称（如 "pdf", "xlsx"）
        script_name: 脚本名称（如 "rotate_pdf.py", "recalc.py"）
        args: 传递给脚本的参数列表
        working_dir: 工作目录（默认为项目根目录）

    Returns:
        脚本执行结果

    Example:
        run_skill_script("xlsx", "recalc.py", args=["output.xlsx"])
        run_skill_script("pdf", "fill_form.py", args=["form.pdf", "--output", "filled.pdf"])
    """
    from backend.engine.skills.skill_registry import get_skill_registry
    
    registry = get_skill_registry()
    registry.discover_skills()
    
    skill = registry.get_skill(skill_name)
    if not skill:
        # 尝试部分匹配
        all_skills = registry.get_all_skills()
        for s in all_skills:
            if skill_name.lower() in s.name.lower():
                skill = s
                break
    
    if not skill:
        return f"未找到 Skill: {skill_name}。使用 list_skills() 查看可用 Skills。"
    
    if not skill.has_scripts:
        return f"Skill '{skill_name}' 没有可执行脚本。"
    
    # 查找脚本
    script_path = skill.get_script_path(script_name)
    if not script_path:
        return (
            f"在 Skill '{skill_name}' 中未找到脚本 '{script_name}'。\n"
            f"可用脚本: {', '.join(skill.scripts)}"
        )
    
    # 确定工作目录（使用统一路径模块）
    cwd = working_dir or str(get_project_root())
    
    # 构建命令
    if script_path.endswith('.py'):
        cmd = ["python", script_path]
    elif script_path.endswith('.sh'):
        cmd = ["bash", script_path]
    elif script_path.endswith('.js'):
        cmd = ["node", script_path]
    else:
        cmd = [script_path]
    
    if args:
        cmd.extend(args)
    
    # 执行脚本
    try:
        result = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=60,  # 60 秒超时
        )
        
        output_parts = []
        if result.stdout:
            output_parts.append(f"输出:\n{result.stdout}")
        if result.stderr:
            output_parts.append(f"错误:\n{result.stderr}")
        if result.returncode != 0:
            output_parts.append(f"退出码: {result.returncode}")
        
        return "\n".join(output_parts) if output_parts else "脚本执行完成（无输出）"
        
    except subprocess.TimeoutExpired:
        return "脚本执行超时（60秒）"
    except Exception as e:
        return f"脚本执行失败: {e}"


@tool
def get_skill_info(skill_name: str) -> str:
    """获取 Skill 的详细信息。

    Use when:
    - 已确定候选 Skill，需要查看其触发词、脚本、依赖与资源。
    - 需要为后续执行准备准确的 read_file/run_skill_script 路径。

    Avoid when:
    - 只是想做全量浏览（用 list_skills）。
    - 任务描述尚不明确、还未匹配技能（先 match_skills）。

    Strategy:
    - 先看 tools/dependencies 判断可行性，再决定是否进入 SKILL.md。
    - 对关键任务优先检查 scripts 列表，尽量走确定性执行路径。

    返回 Skill 的元数据、可用脚本和依赖关系。

    Args:
        skill_name: Skill 名称

    Returns:
        Skill 详细信息

    Example:
        get_skill_info("pdf")
        get_skill_info("doc-coauthoring")
    """
    from backend.engine.skills.skill_registry import get_skill_registry
    
    registry = get_skill_registry()
    registry.discover_skills()
    
    skill = registry.get_skill(skill_name)
    if not skill:
        # 尝试部分匹配
        all_skills = registry.get_all_skills()
        for s in all_skills:
            if skill_name.lower() in s.name.lower():
                skill = s
                break
    
    if not skill:
        return f"未找到 Skill: {skill_name}。使用 list_skills() 查看可用 Skills。"
    
    source = getattr(skill, "source", "custom") or "custom"
    lines = [
        f"# {skill.display_name or skill.name}",
        "",
        f"**名称**: {skill.name}",
        f"**来源**: {_source_label(source).strip('【】')}（{source}）",
        f"**描述**: {skill.description}",
        f"**领域**: {skill.domain}",
        f"**层级**: {skill.level}",
        "",
        f"**SKILL.md 路径**: `{skill.relative_path}`",
        f"**目录**: `{skill.skill_dir}`",
    ]
    if skill.has_scripts:
        lines.append("**脚本**: 含可执行脚本，建议优先使用 run_skill_script(skill, script_name, args) 执行（可复现、更可靠）。")
        lines.append("")
    if skill.triggers:
        lines.append(f"**触发词**: {', '.join(skill.triggers[:10])}")
    
    if skill.tools:
        lines.append(f"**使用的工具**: {', '.join(skill.tools)}")
    
    if skill.dependencies:
        lines.append(f"**依赖 Skills**: {', '.join(skill.dependencies)}")
    
    if skill.has_scripts:
        lines.append(f"\n**可用脚本** (scripts/)：")
        for script in skill.scripts:
            lines.append(f"  - {script}")
    
    # 检查其他资源
    skill_dir = Path(skill.skill_dir)
    references_dir = skill_dir / "references"
    assets_dir = skill_dir / "assets"
    
    if references_dir.exists():
        refs = [f.name for f in references_dir.iterdir() if f.is_file()][:5]
        if refs:
            lines.append(f"\n**参考文档** (references/):")
            for ref in refs:
                lines.append(f"  - {ref}")
    
    if assets_dir.exists():
        assets = [f.name for f in assets_dir.iterdir()][:5]
        if assets:
            lines.append(f"\n**资源文件** (assets/):")
            for asset in assets:
                lines.append(f"  - {asset}")
    
    lines.append(f"\n使用 `read_file(\"{skill.relative_path}\")` 获取完整指导。")
    
    return "\n".join(lines)


# ============================================================
# 导出工具（与 agent_prompts use_skills 辅助工具一致）
# ============================================================
SKILLS_TOOLS = [
    list_skills,          # 列出可用 Skills（Agent 主动发现）
    match_skills,         # 中文关键词匹配（推荐任务开始时调用）
    run_skill_script,     # 脚本路径查找 + 执行（脚本优先）
    get_skill_info,       # 获取能力详情（元数据、脚本、依赖）
]

# 保留所有函数供内部使用
__all__ = ["SKILLS_TOOLS", "list_skills", "match_skills", "run_skill_script", "get_skill_info"]
