"""
模式配置系统 - 定义五种模式的完整配置

设计原则（参考 Cursor/Claude 官方定义）：
1. 每种模式有不同的任务目标和交互方式
2. 每种模式有专用 Skill 和工作流程
3. 模式切换基于任务性质，而非读写权限

模式定位（Cursor 官方定义 + 本项目扩展）：
- Agent: 默认实现模式 - 自主完成任务，输出可交付物
- Ask: 问答探索模式 - 探索代码，回答问题，提供建议
- Plan: 规划协作模式 - 设计实现方案，等待用户确认后再执行
- Debug: 故障排查模式 - 调查 bug 和异常行为，假设驱动定位根因
- Review: 评审模式（本项目扩展）- 清单驱动审查文档/方案/数据并输出结构化评审报告
"""

from dataclasses import dataclass, field
from typing import List, Dict, Optional, Set, Tuple
from enum import Enum
from backend.engine.architecture.tool_policy_contract import (
    POLICY_LAYER_MODE,
    ToolPolicyDecision,
    build_policy_decision,
)


class ChatMode(str, Enum):
    """聊天模式"""
    AGENT = "agent"
    ASK = "ask"
    PLAN = "plan"
    DEBUG = "debug"
    REVIEW = "review"



@dataclass
class ModeConfig:
    """模式配置"""
    mode: ChatMode
    
    # 基本信息
    label: str
    description: str
    
    # LLM 参数
    temperature: float = 0.3
    max_tokens: int = 32768
    
    # 工具配置
    allowed_tools: Set[str] = field(default_factory=set)  # 空集合表示全部允许
    denied_tools: Set[str] = field(default_factory=set)   # 明确禁止的工具
    
    # 上下文配置
    include_execution_logs: bool = False  # 是否包含执行日志（Debug 需要）
    include_conversation_history: bool = True  # 是否包含对话历史
    max_history_messages: int = 20  # 最大历史消息数
    
    # 行为配置
    auto_execute: bool = True  # 是否自动执行（Agent 是，Ask/Plan 否）
    save_outputs: bool = True  # 是否保存输出到文件
    record_process: bool = False  # 是否记录详细过程（供 Debug 使用）
    
    # 输出配置
    output_format: str = "default"  # default, conversation, structured, diagnostic
    output_dir: str = "outputs"  # 模式专用输出目录（相对工作区根）
    
    # Skill 配置
    skill_path: str = ""  # 模式专用 Skill 路径


# ============================================================
# 五种模式的具体配置
# ============================================================

AGENT_MODE = ModeConfig(
    mode=ChatMode.AGENT,
    label="Agent",
    description="自动执行者：完成任务，输出可交付物",
    
    temperature=0.3,
    max_tokens=32768,
    
    # 全部工具可用
    allowed_tools=set(),
    denied_tools=set(),
    
    # 上下文：聚焦任务
    include_execution_logs=False,
    include_conversation_history=True,
    max_history_messages=10,
    
    # 行为：自主执行
    auto_execute=True,
    save_outputs=True,
    record_process=True,
    
    output_format="default",
    output_dir="outputs",
    skill_path="",  # Agent 使用所有 Skills
)

ASK_MODE = ModeConfig(
    mode=ChatMode.ASK,
    label="Ask",
    description="深度讨论模式：深入分析问题，探索方案，提供专业建议",
    
    temperature=0.7,
    max_tokens=32768,
    
    # Ask 模式工具：严格只读探索/分析（不允许写入）；含跨会话记忆与历史经验检索
    allowed_tools={
        "read_file", "batch_read_files", "glob", "grep",
        "search_knowledge", "web_search", "web_fetch",
        "think_tool", "ls", "task",
        "list_skills", "match_skills", "get_skill_info",
        "search_memory", "search_memory_by_category",
        "search_learning_experience",
    },
    denied_tools=set(),  # 主要通过提示词引导，而非强制限制
    
    # 上下文：对话为主
    include_execution_logs=False,
    include_conversation_history=True,
    max_history_messages=30,
    
    # 行为：深入讨论，可生成文档
    auto_execute=False,
    save_outputs=True,  # 可以保存分析结果
    record_process=False,
    
    output_format="conversation",
    output_dir="outputs/ask",
    skill_path="knowledge_base/skills/ask/",
)

PLAN_MODE = ModeConfig(
    mode=ChatMode.PLAN,
    label="Plan",
    description="深度规划模式：深入分析需求，设计完整方案，可转化为执行",
    
    temperature=0.5,
    max_tokens=65536,
    
    # Plan 模式参照 Cursor：全部工具可用，靠流程约束而非工具限制
    allowed_tools=set(),
    denied_tools=set(),  # 主要通过提示词引导
    
    # 上下文：目标和约束
    include_execution_logs=False,
    include_conversation_history=True,
    max_history_messages=20,
    
    # 行为：深度规划，可生成文档，可转化为 Agent 执行
    auto_execute=False,
    save_outputs=True,  # 可以保存规划文档
    record_process=True,
    
    output_format="structured",
    output_dir="outputs/plan",
    skill_path="knowledge_base/skills/plan/",
)

DEBUG_MODE = ModeConfig(
    mode=ChatMode.DEBUG,
    label="Debug",
    description="故障排查模式：调查 bug 和异常行为，假设驱动定位根因",
    
    temperature=0.2,
    max_tokens=65536,
    
    # Debug 模式工具：诊断和收集证据 + 历史经验检索 + 用户确认后可修复
    allowed_tools={
        "read_file", "batch_read_files", "glob", "grep",
        "search_knowledge",
        "search_memory", "search_memory_by_category", "search_learning_experience",
        "think_tool",
        "python_run",
        "shell_run",
        "ls",
        "task",
        "list_skills", "match_skills", "run_skill_script", "get_skill_info",
        "write_file", "edit_file",
    },
    denied_tools=set(),  # 主要通过提示词引导
    
    # 上下文：日志和过程
    include_execution_logs=True,
    include_conversation_history=True,
    max_history_messages=50,
    
    # 行为：诊断分析
    auto_execute=False,
    save_outputs=True,
    record_process=True,

    output_format="diagnostic",
    output_dir="outputs/debug",  # 诊断报告目录
    skill_path="knowledge_base/skills/debug/",
)

REVIEW_MODE = ModeConfig(
    mode=ChatMode.REVIEW,
    label="Review",
    description="评审模式：对文档、方案、合同、数据进行系统化评审",

    temperature=0.3,
    max_tokens=65536,

    # Review 模式：只读分析 + 数据验证 + 评审报告输出
    allowed_tools={
        "read_file", "batch_read_files", "glob", "grep",
        "search_knowledge", "web_search", "web_fetch",
        "search_memory", "search_memory_by_category", "search_learning_experience",
        "think_tool",
        "ls",
        "task",
        "python_run",
        "write_file",
        "list_skills", "match_skills", "get_skill_info",
    },
    denied_tools=set(),

    include_execution_logs=False,
    include_conversation_history=True,
    max_history_messages=30,

    auto_execute=False,
    save_outputs=True,
    record_process=True,

    output_format="structured",
    output_dir="outputs/review",
    skill_path="knowledge_base/skills/review/",
)

# 模式配置映射
MODE_CONFIGS: Dict[ChatMode, ModeConfig] = {
    ChatMode.AGENT: AGENT_MODE,
    ChatMode.ASK: ASK_MODE,
    ChatMode.PLAN: PLAN_MODE,
    ChatMode.DEBUG: DEBUG_MODE,
    ChatMode.REVIEW: REVIEW_MODE,
}

# ============================================================
# 工具列表（从 ModeConfig.allowed_tools 动态生成，避免重复维护）
# ============================================================
MODE_TOOLS: Dict[ChatMode, List[str]] = {
    cm: ["*"] if not cfg.allowed_tools else sorted(cfg.allowed_tools)
    for cm, cfg in MODE_CONFIGS.items()
}

# 模式专用输出目录（相对工作区根，避免与工作区根 tmp/ 重复导致 tmp/tmp/outputs）
MODE_OUTPUT_DIRS: Dict[ChatMode, str] = {
    ChatMode.AGENT: "outputs",
    ChatMode.ASK: "outputs/ask",
    ChatMode.PLAN: "outputs/plan",
    ChatMode.DEBUG: "outputs/debug",
    ChatMode.REVIEW: "outputs/review",
}

# 完成校验用最小关键词集（与 get_mode_prompt 中 <mode_completion_criteria> 对齐，DoneVerifier 单源引用）
MODE_COMPLETION_MARKERS: Dict[ChatMode, Tuple[str, ...]] = {
    ChatMode.PLAN: ("步骤", "step", "deliverable", "交付", "风险", "dependencies"),
    ChatMode.DEBUG: ("根因", "原因", "cause", "because", "traceback", "堆栈", "复现"),
    ChatMode.REVIEW: ("评审", "review", "结论", "建议", "风险", "severity", "严重", "通过", "不通过", "问题"),
}
MODE_COMPLETION_FAIL_SUGGESTION: Dict[ChatMode, str] = {
    ChatMode.PLAN: "补充 steps、deliverables、dependencies 或风险说明。",
    ChatMode.DEBUG: "补充复现线索、根因判断与修复建议。",
    ChatMode.REVIEW: "补充评审发现、严重程度判定与改进建议。",
}


_mode_config_cache: dict[str, ModeConfig] = {}


def _copy_mode_config(raw: ModeConfig) -> ModeConfig:
    """返回 ModeConfig 的独立副本，避免调用方修改共享的 allowed_tools/denied_tools。"""
    return ModeConfig(
        mode=raw.mode,
        label=raw.label,
        description=raw.description,
        temperature=raw.temperature,
        max_tokens=raw.max_tokens,
        allowed_tools=set(raw.allowed_tools),
        denied_tools=set(raw.denied_tools),
        include_execution_logs=raw.include_execution_logs,
        include_conversation_history=raw.include_conversation_history,
        max_history_messages=raw.max_history_messages,
        auto_execute=raw.auto_execute,
        save_outputs=raw.save_outputs,
        record_process=raw.record_process,
        output_format=raw.output_format,
        output_dir=raw.output_dir,
        skill_path=raw.skill_path,
    )


def get_mode_config(mode: str) -> ModeConfig:
    """获取模式配置（返回独立副本，调用方修改不影响其他调用者）。"""
    key = mode.lower()
    cached = _mode_config_cache.get(key)
    if cached is not None:
        return _copy_mode_config(cached)
    try:
        chat_mode = ChatMode(key)
        raw = MODE_CONFIGS[chat_mode]
        result = _copy_mode_config(raw)
    except (ValueError, KeyError):
        raise ValueError(f"未知聊天模式: {mode!r}")
    _mode_config_cache[key] = result
    return _copy_mode_config(result)


def get_mode_tools(mode: str, all_tools: List[str]) -> List[str]:
    """根据模式过滤工具列表
    
    Args:
        mode: 模式名称 (agent/ask/plan/debug/review)
        all_tools: 所有可用工具名称列表
    
    Returns:
        该模式允许使用的工具列表
    """
    if not all_tools:
        return []
    config = get_mode_config(mode)
    
    if not config.allowed_tools:
        allowed = set(all_tools)
    else:
        allowed = config.allowed_tools
    
    return [t for t in all_tools if t in allowed and t not in config.denied_tools]


def get_mode_output_dir(mode: str) -> str:
    """获取模式专用输出目录"""
    try:
        chat_mode = ChatMode(mode.lower())
        return MODE_OUTPUT_DIRS.get(chat_mode, "outputs")
    except ValueError:
        return "outputs"


def is_tool_allowed(mode: str, tool_name: str) -> bool:
    """检查工具是否在该模式下被允许"""
    if not tool_name:
        return False
    config = get_mode_config(mode)
    
    if tool_name in config.denied_tools:
        return False
    
    if not config.allowed_tools:
        return True
    
    return tool_name in config.allowed_tools


def explain_tool_policy(mode: str, tool_name: str) -> tuple[bool, str]:
    """统一模式工具判定（单一事实源）。

    返回:
        (allowed, reason)
    """
    decision = explain_tool_policy_decision(mode, tool_name)
    return bool(decision.get("allowed")), str(decision.get("reason_text") or "")


def explain_tool_policy_decision(mode: str, tool_name: str) -> ToolPolicyDecision:
    """统一模式工具判定（结构化输出）。"""
    name = str(tool_name or "").strip()
    if not name:
        return build_policy_decision(
            allowed=False,
            policy_layer=POLICY_LAYER_MODE,
            reason_code="mode_invalid_tool_name",
            reason_text="tool_name 为空",
        )
    config = get_mode_config(mode)
    if name in config.denied_tools:
        return build_policy_decision(
            allowed=False,
            policy_layer=POLICY_LAYER_MODE,
            reason_code="mode_denied_tools_block",
            reason_text=f"工具 `{name}` 在 `{config.mode.value}` 模式下被 denied_tools 禁止",
        )
    if not config.allowed_tools:
        return build_policy_decision(
            allowed=True,
            policy_layer=POLICY_LAYER_MODE,
            reason_code="mode_allow_all",
            reason_text=f"`{config.mode.value}` 模式允许全部工具（受 denied_tools 约束）",
        )
    if name not in config.allowed_tools:
        return build_policy_decision(
            allowed=False,
            policy_layer=POLICY_LAYER_MODE,
            reason_code="mode_allowlist_miss",
            reason_text=f"工具 `{name}` 不在 `{config.mode.value}` 模式 allowlist 中",
        )
    return build_policy_decision(
        allowed=True,
        policy_layer=POLICY_LAYER_MODE,
        reason_code="mode_allowlist_hit",
        reason_text=f"工具 `{name}` 通过 `{config.mode.value}` 模式 allowlist 校验",
    )


# ============================================================
# 模式行为块（5 层架构 Layer 2：硬约束，supersede 其他指令）
# 每个模式包含：permissions / cognitive_framework / output_expectations / completion_criteria
# 从原 doing_tasks / executing_with_care / making_changes / completion_and_stopping 拆分而来
# ============================================================

MODE_PROMPTS: Dict[ChatMode, str] = {
    ChatMode.AGENT: """当前模式：Agent（自主执行者）。
以下模式约束 supersedes（覆盖）其他所有指令。当模式约束与角色层、业务层或其他指令冲突时，以模式约束为准。

<mode_permissions>
可读写文件、可运行命令（python_run / shell_run）、可委派 SubAgent。
本地可逆操作（编辑文件、运行分析）自由执行。但破坏性或难以撤销的操作执行前必须先确认：
- 破坏性：删除文件/目录/分支、drop 数据库表、rm -rf、覆盖未提交的更改
- 难以撤销：force push、git reset --hard、amend 已发布的提交、降级依赖
- 影响他人：推送代码、创建/关闭 PR 或 Issue、修改共享基础设施
每次破坏性操作独立确认。用户一次批准不代表永远批准。
</mode_permissions>

<mode_cognitive_framework>
本模式侧重执行与交付。具体决策流见 request_routing；交付物规划用 write_todos；每步自检是否在推进主目标；清单每项产出后做完成前检查。不做用户没要求的功能/重构；不重复已完成操作。
当出现知识缺口时允许主动研究：优先 search_knowledge/search_memory，再用 web_search 补充外部信息；若仍缺关键约束，再 ask_user 询问最关键 1-2 个问题。
</mode_cognitive_framework>

<mode_output_expectations>
用户期望得到：可直接使用的交付物（文档、报表、代码、分析结果等）+ 执行摘要。
多轮执行：「改一下/优化」只改要求的部分；「继续」从断点继续；重要产出路径记录到 CONTEXT.md。
当用户给出复合需求（多条指令）时，建议在回复末尾附简短「需求覆盖清单」（已完成/待澄清），确保无遗漏。
</mode_output_expectations>

<mode_completion_criteria>
任务完成条件（满足任一即停止）：用户请求已满足；所有 TODO 标记 completed；已生成输出文件。
若承诺过交付物清单，则清单中每项均已产出且通过自检/验证；与 BUNDLE 一致时按「质量门」「输出必含项」做完成前检查。
完成前自检清单（必须逐项通过再结束回合）：
1. 回溯用户原始请求，逐项确认是否已满足；若有 deliverables 或步骤清单，每项均有对应产出路径且可验证。
2. 交付物：每个承诺产出需满足「路径存在 + 格式/类型正确 + 简要验收通过」；与 SUBAGENT_OUTPUT_SPEC 的 deliverables/deliverables_created 对齐。
3. 输出文件可正常打开和使用；多步任务确认上一步输出是下一步有效输入。
4. 若有关联看板任务，完成时调用 report_artifacts 记录 deliverables、changed_files、rollback_hint。
何时不停止：任务未全部完成时不结束回合。回顾用户原始请求中的每个要点。
何时停止：完成后直接回复用户，不继续调工具；避免无限循环（连续 3 次无进展时停止并汇报）。
任务结束前可简要给出：① 执行情况；② 建议下一步。
</mode_completion_criteria>""",

    ChatMode.ASK: """当前模式：Ask（只读顾问/分析者）。
以下模式约束 supersedes（覆盖）其他所有指令。当模式约束与角色层、业务层或其他指令冲突时，以模式约束为准。

<mode_permissions>
允许：read_file, grep, glob, search_knowledge, web_search, web_fetch, think_tool, list_skills, match_skills, get_skill_info；task 可用于只读子代理收集（优先 explore-agent 做代码/文件探索，general-purpose 做复杂只读分析）。
禁止：write_file / edit_file / python_run / shell_run 及任何会修改状态的工具
如需执行修改操作，建议用户切换到 Agent 模式。
</mode_permissions>

<mode_cognitive_framework>
Ask 模式的价值是「零副作用 + 高信息密度 + 可追溯结论」。
面对用户输入时：
1. 意图识别：事实查询 / 分析请求 / 方案咨询 / 对比评估
2. 证据收集：并行搜索相关文件与知识，不做无证据推断
3. 多源验证：同一结论至少给出 2 个独立证据来源；来源冲突时明确分歧点
4. 结论分级：每个结论标注「确定 / 推断 / 待验证」及来源
5. 行动建议：若需要执行，给出可直接操作的下一步（做什么 + 切到哪个模式 + 预期结果）
信息密度要求：先给结论再给证据，避免空泛铺垫。
</mode_cognitive_framework>

<mode_output_expectations>
用户期望得到：分析、建议、解释、对比——而非执行结果。
回答必须有依据，无依据的结论标注「待澄清」。基于事实回答，标注信息来源。
仅输出对话内分析结论，不写入文件。
输出格式（Ask 模式专用）：结论先行；再分点「依据」或「来源」；可分段、列表，保持对话式；避免大段代码块除非用户明确要求。
</mode_output_expectations>

<mode_completion_criteria>
任务完成条件：用户的问题已被完整回答；所有结论都有证据支撑。
如需执行操作，已建议切换模式。连续 3 次搜索无新信息时停止并基于已有信息回答。
</mode_completion_criteria>""",

    ChatMode.PLAN: """当前模式：Plan（规划者）。
以下模式约束 supersedes（覆盖）其他所有指令。当模式约束与角色层、业务层或其他指令冲突时，以模式约束为准。

<mode_permissions>
Plan 模式参照 Cursor：所有工具可用（与 Agent 相同）。
核心约束在流程：研究 → 澄清 → 规划 → 用户确认 → 执行。
这不是“不能执行”，而是“先规划后执行”：用户确认前优先产出计划与澄清；确认后进入执行阶段并落地交付。
</mode_permissions>

<mode_cognitive_framework>
强制工作流（按顺序执行）：
1. 研究（Research）：用搜索工具、SubAgent 与分析工具建立完整上下文
2. 澄清（Clarify）：提出 1-3 个关键澄清问题；若多方案并存，给出对比表
3. 规划（Plan）：输出结构化计划（目标、交付物、步骤、风险、决策点）
4. 确认（Confirm）：明确请求用户确认；未确认前不进入执行阶段
5. 执行（Execute）：仅在用户确认后按计划执行，并在里程碑处汇报进展
即使需求看似清晰，也要先陈述你的理解并让用户确认。
若用户仅回复“继续/可以”，必须先判断是否构成明确执行确认；不明确时继续停留在规划阶段并追问一句确认语。
</mode_cognitive_framework>

<mode_output_expectations>
用户选 Plan 而非 Agent 的原因是先做决策再执行。
计划必须包含：目标（一句话）、交付物列表（路径+类型+验收）、步骤（做什么/输入/输出/验证）、风险与假设、需用户确认的决策点。
输出须可直接作为执行输入，且可验证、可修改。
输出格式（Plan 模式专用）：先用「## 计划」+ 目标；再「### 交付物」列表；再「### 步骤」编号列表；最后「### 待确认」或「### 风险与假设」。
</mode_output_expectations>

<mode_completion_criteria>
规划阶段完成条件：已产出结构化计划且覆盖需求点，并明确待确认事项。
计划必须显式包含（与 SUBAGENT_OUTPUT_SPEC 对齐）：goal、key_info、steps（每步含 id/action/input_ref/output_path/verification）、deliverables（path+格式/类型+简要验收，与 steps 对应）、risks。
执行阶段完成条件：仅在用户确认后，按 steps 与 deliverables 逐项执行；完成前自检：每步 verification 通过、deliverables_created 与计划 deliverables 一一对应、verification_result 明确。
若缺少明确确认信号，输出应停留在计划更新与澄清，不进入执行结果交付。
连续 3 次无进展时停止并汇报当前状态。
</mode_completion_criteria>""",

    ChatMode.DEBUG: """当前模式：Debug（问题诊断者）。
以下模式约束 supersedes（覆盖）其他所有指令。当模式约束与角色层、业务层或其他指令冲突时，以模式约束为准。

<mode_permissions>
允许：read_file, grep, glob, search_knowledge, think_tool, list_skills, match_skills, get_skill_info, python_run（诊断脚本）, shell_run（诊断命令）, task（委派可用子代理收集日志）
禁止：不主动修改代码或配置，除非用户明确要求修复。
修复操作需用户确认后执行。
</mode_permissions>

<mode_cognitive_framework>
面对用户输入时的思考步骤：
1. 现象理解：复现步骤是什么？期望行为 vs 实际行为？
2. 假设形成：基于现象提出 2-3 个可能的根因假设
3. 证据收集：针对每个假设收集证据（日志、状态、数据、配置）
4. 假设验证：逐个验证或排除假设，缩小范围
5. 根因定位：给出根因 + 证据链 + 修复建议
结论须有证据支撑。不猜测，不在无证据时下结论。
</mode_cognitive_framework>

<mode_output_expectations>
用户期望得到：根因分析 + 证据链 + 修复建议。
先提出假设 → 收集证据 → 验证或排除 → 再给出根因与修复建议。
输出格式（Debug 模式专用）：先「## 现象」；再「## 假设与验证」列表；最后「## 根因与建议」。
</mode_output_expectations>

<mode_completion_criteria>
任务完成条件：已定位根因且有证据支撑；已给出修复建议。
如需执行修复，需用户确认或建议切换到 Agent 模式。
避免无限循环：连续 3 次无进展时停止并汇报当前排查进展。
</mode_completion_criteria>""",

    ChatMode.REVIEW: """当前模式：Review（评审者）。
以下模式约束 supersedes（覆盖）其他所有指令。当模式约束与角色层、业务层或其他指令冲突时，以模式约束为准。

<mode_permissions>
允许：只读工具 + python_run（数据验证/格式检查）+ write_file（评审报告）
禁止：edit_file（不修改原文件）、shell_run（避免执行副作用命令）
评审发现问题后给出建议，不直接修改原始文件。
</mode_permissions>

<mode_cognitive_framework>
评审五步法（清单驱动）：
1. 范围界定：确认评审对象类型（文档/方案/合同/数据）和评审维度
2. 清单生成：根据对象生成检查清单（完整性、准确性、一致性、风险）
3. 逐项审查：每个发现必须给出位置、严重程度、问题描述、证据依据、修改建议
4. 交叉验证：关键发现用知识库/外部标准交叉验证；必要时用 python_run 做数据验证
5. 报告输出：生成结构化评审报告（摘要、发现清单、改进建议、风险评估）
</mode_cognitive_framework>

<mode_output_expectations>
用户选 Review 而非 Ask，是为了系统化审查而非一般咨询。
输出必须具备可追溯性：有清单、有定位、有严重度、有依据。
输出格式（Review 模式专用）：先用「## 评审报告」；再「### 检查项」表格或列表（项 | 结果 | 说明）；再「### 发现与建议」逐条（位置、严重度、建议）。
</mode_output_expectations>

<mode_completion_criteria>
完成条件：评审清单项已覆盖；发现已分级；评审报告已产出。
若需实际修改，建议切换到 Agent 并引用评审报告执行。
</mode_completion_criteria>""",
}

# 各模式推荐 Skills（供提示词内联：何时用、优先 match_skills → get_skill_info）
MODE_RECOMMENDED_SKILLS: Dict[ChatMode, str] = {
    ChatMode.AGENT: "推荐 Skills：reasoning（多步推理）、verification（验证结论）；复杂任务先 match_skills → get_skill_info 再执行。",
    ChatMode.ASK: "推荐 Skills：reasoning（对比法）、ask-methodology（4 步咨询流程）；先 match_skills 再 get_skill_info，只读不执行。",
    ChatMode.PLAN: "推荐 Skills：reasoning（分解法）、plan-methodology（需求澄清→方案设计→任务分解）；先 match_skills → get_skill_info，输出可作 executor 输入。",
    ChatMode.DEBUG: "推荐 Skills：reasoning（假设-验证法）、verification、debug-methodology；先 match_skills → get_skill_info，证据驱动定位根因。",
    ChatMode.REVIEW: "推荐 Skills：reasoning（清单审查法）、verification、review-methodology；先 match_skills → get_skill_info，输出结构化评审报告。",
}

# 面向用户的模式说明（供前端展示：何时选用、获得什么价值）
MODE_USER_DESCRIPTIONS: Dict[ChatMode, Dict[str, str]] = {
    ChatMode.AGENT: {
        "when": "已明确要做什么，需要直接产出文件或执行操作",
        "value": "自动执行并交付成果，可读写文件、运行命令",
    },
    ChatMode.ASK: {
        "when": "想先讨论、分析或评估，暂不修改任何东西",
        "value": "只读分析、文件检索与联网检索，回答疑问并给出建议，不修改文件",
    },
    ChatMode.PLAN: {
        "when": "任务较复杂，希望先看到完整方案再决定是否执行",
        "value": "先产出可执行计划（目标、步骤、交付物、风险），确认后可在 Plan 执行阶段直接落地",
    },
    ChatMode.DEBUG: {
        "when": "出现报错、结果不对或异常，需要定位原因",
        "value": "假设驱动排查、收集证据、给出根因与修复建议",
    },
    ChatMode.REVIEW: {
        "when": "需要系统化审查文档/方案/合同/数据质量，而非直接执行修改",
        "value": "清单驱动评审，输出分级问题与改进建议报告",
    },
}


def get_mode_prompt(mode: str) -> str:
    """获取模式特定的提示词片段（含推荐 Skills）"""
    try:
        chat_mode = ChatMode(mode.lower())
        base = MODE_PROMPTS.get(chat_mode, MODE_PROMPTS[ChatMode.AGENT])
        skills_line = MODE_RECOMMENDED_SKILLS.get(chat_mode, "")
        return f"{base}\n<mode_skills>{skills_line}</mode_skills>" if skills_line else base
    except ValueError:
        return MODE_PROMPTS[ChatMode.AGENT]


def get_mode_recommended_skills(mode: str) -> str:
    """获取该模式推荐 Skills 文案，供提示词或前端使用"""
    try:
        chat_mode = ChatMode(mode.lower())
        return MODE_RECOMMENDED_SKILLS.get(chat_mode, "")
    except ValueError:
        return ""


# ============================================================
# 导出
# ============================================================

def get_mode_user_description(mode: str) -> Dict[str, str]:
    """获取模式面向用户的说明（何时选用、获得什么），供前端展示。"""
    try:
        chat_mode = ChatMode(mode.lower())
        return MODE_USER_DESCRIPTIONS.get(chat_mode, MODE_USER_DESCRIPTIONS[ChatMode.AGENT])
    except ValueError:
        return MODE_USER_DESCRIPTIONS[ChatMode.AGENT]


__all__ = [
    "ChatMode",
    "ModeConfig",
    "MODE_CONFIGS",
    "MODE_TOOLS",
    "MODE_OUTPUT_DIRS",
    "MODE_PROMPTS",
    "MODE_RECOMMENDED_SKILLS",
    "MODE_USER_DESCRIPTIONS",
    "get_mode_config",
    "get_mode_tools",
    "get_mode_output_dir",
    "is_tool_allowed",
    "explain_tool_policy",
    "explain_tool_policy_decision",
    "get_mode_prompt",
    "get_mode_recommended_skills",
    "get_mode_user_description",
    "AGENT_MODE",
    "ASK_MODE",
    "PLAN_MODE",
    "DEBUG_MODE",
    "REVIEW_MODE",
]
