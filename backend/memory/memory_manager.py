"""
Memory Manager - DeepAgent 原生记忆机制的 API 包装器

此模块不重复实现记忆功能，而是提供对 DeepAgent 原生机制的统一访问接口。

DeepAgent 原生记忆机制（由框架自动处理）：
┌─────────────────────────────────────────────────────────────┐
│ 1. Checkpointer - 会话状态、消息历史（短期记忆）              │
│    配置: langgraph.json → checkpointer                      │
│    存储: ./data/checkpoints.db                              │
├─────────────────────────────────────────────────────────────┤
│ 2. Store - 跨会话持久化（长期记忆）                          │
│    配置: langgraph.json → store                             │
│    存储: ./data/store.db                                    │
├─────────────────────────────────────────────────────────────┤
│ 3. project_memory - 项目记忆（拼入系统提示词）                │
│    实现: deep_agent._load_memory_content()                  │
│    文件: .maibot/MAIBOT.md, .maibot/rules/*.md             │
├─────────────────────────────────────────────────────────────┤
│ 4. Skills 工具 - 技能知识（自定义工具 + BUNDLE.md 内联）      │
│    注册: registry.py → list_skills/match_skills/get_skill_info│
│    文件: knowledge_base/skills/*/SKILL.md                   │
└─────────────────────────────────────────────────────────────┘

本模块职责（仅 API 访问，不重复实现）：
- 提供 Store 的便捷访问方法
- 规则和决策的 CRUD 操作
- 记忆摘要生成
"""

from typing import List, Dict, Any, Optional
from datetime import datetime
import logging

logger = logging.getLogger(__name__)


class MemoryManager:
    """
    记忆管理器 - DeepAgent 原生机制的 API 包装器
    
    注意：这不是独立的记忆系统，而是对 LangGraph Store 的便捷访问接口。
    实际的记忆管理由 DeepAgent 框架自动处理。
    """
    
    def __init__(self, store=None, project_id: str = "default"):
        """
        Args:
            store: LangGraph Store 实例（可选，用于跨会话持久化）
            project_id: 项目 ID（用于命名空间隔离）
        """
        self.store = store
        self.project_id = project_id

    def _ensure_store(self, op: str) -> bool:
        if self.store is not None:
            return True
        logger.error("MemoryManager[%s] store_unavailable project_id=%s", op, self.project_id)
        return False
    
    # ============================================================
    # Store 操作（长期记忆）
    # ============================================================
    
    def save_rule(self, rule: Dict[str, Any]) -> bool:
        """保存规则到 Store"""
        if not self._ensure_store("save_rule"):
            return False
        
        try:
            namespace = ("rules", self.project_id)
            key = rule.get("id", f"rule_{datetime.now().timestamp()}")
            self.store.put(namespace, key, {
                **rule,
                "created_at": datetime.now().isoformat(),
            })
            logger.info(f"规则已保存: {key}")
            return True
        except Exception as e:
            logger.error(f"保存规则失败: {e}")
            return False
    
    def get_rules(self) -> List[Dict[str, Any]]:
        """从 Store 获取规则"""
        if not self._ensure_store("get_rules"):
            return []
        
        try:
            namespace = ("rules", self.project_id)
            items = self.store.search(namespace)
            return [item.value for item in items]
        except Exception as e:
            logger.error(f"获取规则失败: {e}")
            return []
    
    def save_decision(self, decision: Dict[str, Any]) -> bool:
        """保存决策到 Store"""
        if not self._ensure_store("save_decision"):
            return False
        
        try:
            namespace = ("decisions", self.project_id)
            key = decision.get("id", f"decision_{datetime.now().timestamp()}")
            self.store.put(namespace, key, {
                **decision,
                "created_at": datetime.now().isoformat(),
            })
            logger.info(f"决策已保存: {key}")
            return True
        except Exception as e:
            logger.error(f"保存决策失败: {e}")
            return False
    
    def get_decisions(self) -> List[Dict[str, Any]]:
        """从 Store 获取决策"""
        if not self._ensure_store("get_decisions"):
            return []
        
        try:
            namespace = ("decisions", self.project_id)
            items = self.store.search(namespace)
            return [item.value for item in items]
        except Exception as e:
            logger.error(f"获取决策失败: {e}")
            return []
    
    def save_context(self, key: str, value: Dict[str, Any]) -> bool:
        """保存上下文到 Store"""
        if not self._ensure_store("save_context"):
            return False
        
        try:
            namespace = ("context", self.project_id)
            self.store.put(namespace, key, {
                "value": value,
                "updated_at": datetime.now().isoformat(),
            })
            return True
        except Exception as e:
            logger.error(f"保存上下文失败: {e}")
            return False
    
    def get_context(self, key: str) -> Optional[Dict[str, Any]]:
        """获取上下文"""
        if not self._ensure_store("get_context"):
            return None
        
        try:
            namespace = ("context", self.project_id)
            item = self.store.get(namespace, key)
            if item:
                return item.value.get("value")
            return None
        except Exception as e:
            logger.error(f"获取上下文失败: {e}")
            return None
    
    # ============================================================
    # 记忆摘要
    # ============================================================
    
    def get_memory_summary(self) -> Dict[str, Any]:
        """获取记忆摘要（用于调试）"""
        return {
            "project_id": self.project_id,
            "store_available": self.store is not None,
            "rules_count": len(self.get_rules()),
            "decisions_count": len(self.get_decisions()),
        }


# ============================================================
# 便捷函数
# ============================================================

def get_memory_manager(store=None, project_id: str = "default") -> MemoryManager:
    """获取记忆管理器实例"""
    return MemoryManager(store=store, project_id=project_id)
