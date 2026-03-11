"""
Rules Extractor - 从对话历史中提取 Rules

使用 LangChain Chain 实现，遵循官方方法
"""

from typing import List, Dict, Any
import json
import logging

from langchain_core.prompts import PromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_core.runnables import RunnableSequence

logger = logging.getLogger(__name__)


def create_rules_extraction_chain(llm):
    """
    创建 Rules 提取 Chain
    
    使用 LangChain Chain（PromptTemplate | LLM | StrOutputParser）
    遵循官方方法，不重复实现
    """
    
    prompt_template = PromptTemplate.from_template(
        """Extract reusable rules from conversation history.

┌──────────┬─────────────────────────────────────┐
│ Focus    │ Patterns, strategies, failures      │
│ Format   │ JSON array                          │
│ Fields   │ name, pattern, description, project_id│
└──────────┴─────────────────────────────────────┘

History:
{conversation_history}

Output JSON:
```json
[{{"name": "KB first", "pattern": "doc analysis", "description": "Always search_knowledge_base() before analysis", "project_id": "{project_id}"}}]
```
"""
    )
    
    # 使用 LangChain Chain 标准模式
    chain = prompt_template | llm | StrOutputParser()
    
    return chain


def extract_rules_from_conversation(
    conversation_history: str,
    project_id: str,
    llm
) -> List[Dict[str, Any]]:
    """
    从对话历史中提取 Rules
    
    Args:
        conversation_history: 对话历史文本
        project_id: 项目 ID
        llm: LLM 实例
        
    Returns:
        提取出的规则列表
    """
    try:
        logger.info("🚀 正在从对话历史中提取 Rules...")
        
        # 创建提取 Chain
        extraction_chain = create_rules_extraction_chain(llm)
        
        # 执行提取
        raw_output = extraction_chain.invoke({
            "conversation_history": conversation_history,
            "project_id": project_id,
        })
        
        # 解析 JSON
        try:
            # 查找 JSON 块
            json_start = raw_output.find('```json')
            json_end = raw_output.rfind('```')
            if json_start != -1 and json_end != -1 and json_end > json_start:
                json_str = raw_output[json_start + len('```json'):json_end].strip()
                rules = json.loads(json_str)
            else:
                # 尝试直接解析
                rules = json.loads(raw_output)
            
            logger.info(f"✅ 提取出 {len(rules)} 条规则")
            return rules
            
        except json.JSONDecodeError as e:
            logger.error(f"❌ Rules JSON 解析失败: {e}\n原始输出: {raw_output[:500]}...")
            return []
            
    except Exception as e:
        logger.error(f"❌ Rules 提取失败: {e}")
        return []


def format_rules_for_prompt(rules: List[Dict[str, Any]]) -> str:
    """
    格式化 Rules 用于系统提示词注入
    
    Args:
        rules: 规则列表
        
    Returns:
        格式化后的规则文本
    """
    if not rules:
        return ""
    
    formatted_rules = []
    for i, rule in enumerate(rules, 1):
        formatted_rules.append(
            f"{i}. **{rule.get('name', '未知规则')}** ({rule.get('pattern', '通用')}): "
            f"{rule.get('description', '无描述')}"
        )
    
    return "\n".join(formatted_rules)

