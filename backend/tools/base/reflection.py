"""
思考和交互工具

基于 Claude 官方 think_tool 实现：
https://www.anthropic.com/engineering/claude-think-tool
"""

from langchain_core.tools import tool


@tool
def think_tool(thinking: str) -> str:
    """结构化思考工具——将推理过程记录到对话历史中，帮助做出更好的决策。

    触发/路由：编排器在非推理型模型下使用本工具；推理型模型可能使用 extended_thinking 代替，二者择一（见 agent_prompts 中 tool_usage 说明）。

    Use when:
    - 任务包含多步依赖、冲突信息或高影响决策，需要显式推理链。
    - 需要把假设、证据、反例和风险评估结构化呈现给后续步骤。

    Avoid when:
    - 只是简单问候、单步执行或已知答案的直接操作。
    - 需要获取新信息或修改文件（本工具不会执行外部操作）。

    Strategy:
    - 先按 L1/L2/L3 选择推理深度，再执行科学方法触发器。
    - 数值结论统一交给 python_run 计算，并在思考中附可复现痕迹。

    本工具不获取新信息也不做修改。仅记录你的推理过程。

    思考协议（强制顺序）：
    1) 问题定性：先判断是定量问题还是定性问题；
    2) 涉及数量/比例/趋势/对比：必须使用 python_run 计算，禁止口算；
    3) 涉及多方案选择：必须定义评价维度+权重，并用 python_run 输出评分矩阵；
    4) 涉及风险/不确定性：必须估计概率与影响，可用 python_run 生成风险矩阵；
    5) 所有数值结论：必须附计算代码与输出痕迹，缺失则标注「待验证」。

    三级元认知协议（MGV + VIGIL）：

    L1 快速判断（<10 秒）：
      - 适用：信息明确、操作直接、单一步骤
      - 格式：一句话结论 + 行动
      - 升级信号：矛盾信息 / 多步依赖 / 目标不清 / 用户明确要求深入分析

    L2 结构化分析（MONITOR → GENERATE → VERIFY）：
      - MONITOR：列出已知事实、未知项、隐含假设
      - GENERATE：至少 2 个候选方案（含"不作为"选项）
      - VERIFY：为每个方案提供支持证据与反例，标注 source_id
      - 全面性检查：利益相关者、约束条件、时间维度、可逆性
      - 升级信号：高影响决策 / 涉及计算 / 需跨领域判断

    L3 深度推理（科学方法 + 完整性审查）：
      - Monitor：先做难度评估、信心水平、是否已过早锁定方向
      - 反锁定：若已锁定方向，强制加入至少 1 个对立假设
      - Generate：拆解子问题，逐个求解后综合
      - Verify：结论-证据一致性、反例检查、数值计算验证
      - 科学方法：
        · 数量关系/预算/占比 → python_run + numpy（不口算）
        · 趋势/预测/相关性 → python_run + scipy.stats（统计检验）
        · 多方案比较 → 加权评分矩阵（明确权重来源）
        · 风险 → 概率×影响矩阵 + 高风险标注
      - 可逆性检查：该决策可否回退？代价多大？
      - 二阶效应：此行动的连锁反应是什么？

    分析完整性检查清单（VIGIL）：
      V - Viewpoints: 利益相关者是否都考虑到？
      I - Information: 是否有关键信息缺失？
      G - Gaps: 推理链中是否有跳跃或假设？
      I - Impact: 时间维度、约束条件、不确定性？
      L - Limits: 我的能力边界在哪里？需要什么外部输入？
      R - Reliability: 证据来源可靠性等级是否满足结论要求？关键结论需 L4/L5 证据。

    何时不使用：
    - 简单问候或单次工具调用
    - 信息明确、操作直接的任务

    Args:
        thinking: 你的推理和分析内容

    Returns:
        你的思考内容（记录在对话历史中）
    """
    return thinking


@tool
def ask_user(question: str) -> str:
    """Ask the user a question and wait for their response.

    Use when:
    - 存在关键缺失信息，且缺失会显著影响结果正确性。
    - 需要用户在多个方案之间做偏好或风险取舍。

    Avoid when:
    - 可以通过 read_file/search_knowledge/web_search 自行补齐信息。
    - 只是低影响细节，不会影响当前步骤的执行正确性。

    Strategy:
    - 一次只问最关键的 1-2 个问题，给出可选项并说明影响。
    - 提问前简要说明“为何需要该信息”，降低用户决策成本。

    Args:
        question: The question to ask the user

    Returns:
        The user's response
    """
    from langgraph.types import interrupt
    return interrupt(question)


__all__ = ["think_tool", "ask_user"]
