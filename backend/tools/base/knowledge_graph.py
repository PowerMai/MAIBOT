"""
知识图谱模块 - 推理型知识库的核心

基于 LangChain 框架，实现业界顶级的知识图谱能力：
1. 实体识别与关系抽取（规则 + LLM 混合）
2. 知识图谱存储与查询（支持多跳推理）
3. 文档结构映射（DocMap）
4. 语义推理与知识扩展

参考：
- GraphRAG (Microsoft)
- LangChain Knowledge Graph
- Neo4j + LLM 集成模式
"""

import os
import json
import re
import logging
import threading
from typing import Optional, List, Dict, Any, Set, Tuple, Callable
from pathlib import Path
from datetime import datetime
from dataclasses import dataclass, field
from enum import Enum
from collections import defaultdict
import hashlib

logger = logging.getLogger(__name__)

try:
    import yaml
except Exception:  # pragma: no cover
    yaml = None

# ============================================================
# 配置（使用统一路径模块）
# ============================================================
from .paths import KB_PATH as _KB_PATH, MEMORY_PATH as _MEMORY_PATH, ONTOLOGY_PATH as _ONTOLOGY_PATH

# 转为字符串（兼容旧代码）
KB_PATH = str(_KB_PATH)
MEMORY_PATH = str(_MEMORY_PATH)
ONTOLOGY_PATH = _ONTOLOGY_PATH


def get_canonical_schema_path(domain: Optional[str] = None) -> Path:
    """
    Schema 单源：返回唯一权威 schema 文件路径。
    顺序：ontology/domain/{domain}/schema.json（若 domain 且存在）→ ontology/schema.json。
    注入与抽取均应从该路径读取，保证一致。
    """
    base = Path(ONTOLOGY_PATH)
    if domain and (base / "domain" / domain / "schema.json").exists():
        return base / "domain" / domain / "schema.json"
    return base / "schema.json"


def load_schema(ontology_path: Optional[Path] = None, domain: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """
    加载领域 schema，用于 Schema-Driven 提取。
    优先从单源 get_canonical_schema_path(domain) 加载；若不存在再尝试旧候选路径（兼容）。
    """
    canonical = get_canonical_schema_path(domain)
    if canonical.exists():
        try:
            content = json.loads(canonical.read_text(encoding="utf-8"))
            if isinstance(content, dict):
                return content
        except Exception as e:
            logger.warning("加载 canonical schema 失败 %s: %s", canonical, e)
    base = Path(ontology_path or ONTOLOGY_PATH)
    kb_ontology = Path(KB_PATH) / "ontology"
    candidate_paths: List[Path] = []
    if domain:
        candidate_paths.extend([
            base / "domain" / domain / "schema.json",
            base / "domain" / domain / "schema.yaml",
            base / "domain" / domain / "schema.yml",
            kb_ontology / f"{domain}.json",
            kb_ontology / f"{domain}.yaml",
            kb_ontology / f"{domain}.yml",
        ])
    candidate_paths.extend([
        base / "schema.json",
        base / "schema.yaml",
        base / "schema.yml",
        kb_ontology / "core.json",
        kb_ontology / "core.yaml",
        kb_ontology / "core.yml",
    ])
    for path in candidate_paths:
        if not path.exists():
            continue
        try:
            if path.suffix.lower() in (".yaml", ".yml"):
                if yaml is None:
                    continue
                content = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
                if isinstance(content, dict):
                    return content
            else:
                content = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(content, dict):
                    return content
        except Exception as e:
            logger.warning("加载 schema 失败 %s: %s", path, e)
    return None


def get_schema_snippet_for_injection(domain: Optional[str] = None, max_chars: int = 2200) -> str:
    """
    Schema 单源：从 canonical schema（learned/ontology）加载并返回用于提示词注入的紧凑文本。
    供 OntologyContextMiddleware 使用，与抽取共用同一 schema。
    """
    schema = load_schema(domain=domain)
    if not schema:
        return ""
    parts = []
    entity_types = schema.get("entity_types") or {}
    if entity_types:
        parts.append("entity_types: " + ", ".join(f"{k}({v.get('label', '')})" for k, v in list(entity_types.items())[:20]))
    relation_types = schema.get("relation_types") or {}
    if relation_types:
        parts.append("relation_types: " + ", ".join(f"{k}({v.get('label', k)})" for k, v in list(relation_types.items())[:20]))
    if not parts:
        return ""
    text = "; ".join(parts)
    return text[:max_chars] if len(text) > max_chars else text


def get_schema_for_tools(domain: Optional[str] = None) -> Dict[str, Any]:
    """
    Schema 单源：从 canonical schema 加载并转换为 ontology_tools 期望的结构。
    返回 { "entities": { TypeName: { "fields": [...] } }, "relation_types": {...} }，与原有 YAML 结构兼容。
    """
    schema = load_schema(domain=domain)
    if not schema:
        return {"entities": {}, "relation_types": {}}
    entity_types = schema.get("entity_types") or {}
    entities = {
        k: {"fields": v.get("properties", [])}
        for k, v in entity_types.items()
    }
    return {
        "entities": entities,
        "relation_types": schema.get("relation_types") or {},
    }


# ============================================================
# 1. 实体类型定义（招投标/合同领域）
# ============================================================
class EntityType(Enum):
    """实体类型 - 招投标/合同领域专用"""
    # 组织实体
    ORGANIZATION = "organization"      # 公司、机构
    DEPARTMENT = "department"          # 部门
    PERSON = "person"                  # 人员
    
    # 业务实体
    PROJECT = "project"                # 项目
    REQUIREMENT = "requirement"        # 需求/要求
    QUALIFICATION = "qualification"    # 资质
    PRODUCT = "product"                # 产品
    SERVICE = "service"                # 服务
    
    # 文档实体
    DOCUMENT = "document"              # 文档
    SECTION = "section"                # 章节
    CLAUSE = "clause"                  # 条款
    
    # 数值实体
    MONEY = "money"                    # 金额
    DATE = "date"                      # 日期
    DURATION = "duration"              # 时长
    QUANTITY = "quantity"              # 数量
    PERCENTAGE = "percentage"          # 百分比
    
    # 评分实体
    SCORING_ITEM = "scoring_item"      # 评分项
    WEIGHT = "weight"                  # 权重
    
    # 风险实体
    RISK = "risk"                      # 风险
    DISQUALIFICATION = "disqualification"  # 废标条款

    # 未分类
    OTHER = "other"                    # 其他


class RelationType(Enum):
    """关系类型"""
    # 层级关系
    IS_A = "is_a"                      # 是一种
    PART_OF = "part_of"                # 属于
    CONTAINS = "contains"              # 包含
    
    # 需求关系
    REQUIRES = "requires"              # 要求
    PROVIDES = "provides"              # 提供
    SATISFIES = "satisfies"            # 满足
    CONFLICTS = "conflicts"            # 冲突
    
    # 时间关系
    DEADLINE_IS = "deadline_is"        # 截止时间
    VALID_UNTIL = "valid_until"        # 有效期至
    DURATION_IS = "duration_is"        # 时长为
    
    # 数值关系
    AMOUNT_IS = "amount_is"            # 金额为
    WEIGHT_IS = "weight_is"            # 权重为
    SCORE_IS = "score_is"              # 分值为
    
    # 评价关系
    LEADS_TO = "leads_to"              # 导致
    PREVENTS = "prevents"              # 阻止
    DEPENDS_ON = "depends_on"          # 依赖
    
    # 文档关系
    REFERENCES = "references"          # 引用
    DEFINED_IN = "defined_in"          # 定义于
    MENTIONED_IN = "mentioned_in"      # 提及于


# ============================================================
# 2. 实体和关系数据结构
# ============================================================
@dataclass
class Entity:
    """知识图谱实体"""
    id: str                            # 唯一标识
    name: str                          # 实体名称
    entity_type: EntityType            # 实体类型
    properties: Dict[str, Any] = field(default_factory=dict)
    confidence: float = 1.0            # 置信度
    source: str = ""                   # 来源文档
    source_location: str = ""          # 来源位置（章节/页码）
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)
    mention_count: int = 1             # 被提及次数
    
    def __hash__(self):
        return hash(self.id)
    
    def __eq__(self, other):
        return isinstance(other, Entity) and self.id == other.id
    
    def to_dict(self) -> Dict:
        return {
            "id": self.id,
            "name": self.name,
            "type": self.entity_type.value,
            "properties": self.properties,
            "confidence": self.confidence,
            "source": self.source,
            "source_location": self.source_location,
            "mention_count": self.mention_count,
        }
    
    @classmethod
    def from_dict(cls, data: Dict) -> "Entity":
        return cls(
            id=data["id"],
            name=data["name"],
            entity_type=EntityType(data["type"]),
            properties=data.get("properties", {}),
            confidence=data.get("confidence", 1.0),
            source=data.get("source", ""),
            source_location=data.get("source_location", ""),
            mention_count=data.get("mention_count", 1),
        )


@dataclass
class Relation:
    """知识图谱关系"""
    id: str                            # 唯一标识
    subject_id: str                    # 主体实体ID
    predicate: RelationType            # 关系类型
    object_id: str                     # 客体实体ID
    properties: Dict[str, Any] = field(default_factory=dict)
    confidence: float = 1.0            # 置信度
    evidence: str = ""                 # 证据（原文）
    source: str = ""                   # 来源文档
    source_location: str = ""          # 来源位置
    created_at: datetime = field(default_factory=datetime.now)
    evidence_count: int = 1            # 证据数量
    
    def __hash__(self):
        return hash(self.id)
    
    def __eq__(self, other):
        return isinstance(other, Relation) and self.id == other.id
    
    def to_dict(self) -> Dict:
        return {
            "id": self.id,
            "subject_id": self.subject_id,
            "predicate": self.predicate.value,
            "object_id": self.object_id,
            "properties": self.properties,
            "confidence": self.confidence,
            "evidence": self.evidence,
            "source": self.source,
            "source_location": self.source_location,
            "evidence_count": self.evidence_count,
        }
    
    @classmethod
    def from_dict(cls, data: Dict) -> "Relation":
        # 兼容 API 旧格式 source/target/type（与 subject_id/object_id/predicate 二选一）
        subject_id = data.get("subject_id") or data.get("source", "")
        object_id = data.get("object_id") or data.get("target", "")
        pred_raw = data.get("predicate") or data.get("type", "requires")
        rid = data.get("id")
        if not rid:
            rid = hashlib.md5(f"{subject_id}:{pred_raw}:{object_id}".encode()).hexdigest()[:12]
        try:
            predicate = RelationType(pred_raw)
        except ValueError:
            predicate = RelationType.REQUIRES
        return cls(
            id=rid,
            subject_id=subject_id,
            predicate=predicate,
            object_id=object_id,
            properties=data.get("properties", {}),
            confidence=data.get("confidence", 1.0),
            evidence=data.get("evidence", ""),
            source=data.get("source", ""),
            source_location=data.get("source_location", ""),
            evidence_count=data.get("evidence_count", 1),
        )


# ============================================================
# 3. 知识图谱核心类
# ============================================================
class KnowledgeGraph:
    """
    知识图谱 - 推理型知识库的核心
    
    特性：
    1. 实体存储与索引（按类型、名称、来源）
    2. 关系存储与查询（支持双向查询）
    3. 多跳推理（路径查找）
    4. 知识融合（实体对齐、关系合并）
    5. 持久化存储
    """
    
    def __init__(self, storage_path: Optional[str] = None):
        self.storage_path = Path(storage_path or str(ONTOLOGY_PATH))
        self.storage_path.mkdir(parents=True, exist_ok=True)
        self._io_lock = threading.Lock()
        
        # 实体存储
        self._entities: Dict[str, Entity] = {}
        
        # 关系存储
        self._relations: Dict[str, Relation] = {}
        
        # 索引
        self._entity_by_type: Dict[EntityType, Set[str]] = defaultdict(set)
        self._entity_by_name: Dict[str, Set[str]] = defaultdict(set)  # name -> entity_ids
        self._relations_by_subject: Dict[str, Set[str]] = defaultdict(set)
        self._relations_by_object: Dict[str, Set[str]] = defaultdict(set)
        self._relations_by_predicate: Dict[RelationType, Set[str]] = defaultdict(set)
        
        # 加载已有数据
        self._load()
    
    def _generate_entity_id(self, name: str, entity_type: EntityType) -> str:
        """生成实体ID"""
        content = f"{entity_type.value}:{name}"
        return hashlib.md5(content.encode()).hexdigest()[:12]
    
    def _generate_relation_id(self, subject_id: str, predicate: RelationType, object_id: str) -> str:
        """生成关系ID"""
        content = f"{subject_id}:{predicate.value}:{object_id}"
        return hashlib.md5(content.encode()).hexdigest()[:12]
    
    # ============================================================
    # 实体操作
    # ============================================================
    def add_entity(
        self,
        name: str,
        entity_type: EntityType,
        properties: Dict[str, Any] = None,
        confidence: float = 1.0,
        source: str = "",
        source_location: str = "",
    ) -> Entity:
        """
        添加实体（支持实体融合）
        
        如果同名同类型实体已存在，则合并属性并增加置信度
        """
        entity_id = self._generate_entity_id(name, entity_type)
        
        if entity_id in self._entities:
            # 实体融合
            existing = self._entities[entity_id]
            existing.mention_count += 1
            existing.confidence = min(existing.confidence + 0.05, 0.99)
            existing.updated_at = datetime.now()
            
            # 合并属性
            if properties:
                for k, v in properties.items():
                    if k not in existing.properties:
                        existing.properties[k] = v
            
            return existing
        
        # 创建新实体
        entity = Entity(
            id=entity_id,
            name=name,
            entity_type=entity_type,
            properties=properties or {},
            confidence=confidence,
            source=source,
            source_location=source_location,
        )
        
        self._entities[entity_id] = entity
        
        # 更新索引
        self._entity_by_type[entity_type].add(entity_id)
        self._entity_by_name[name.lower()].add(entity_id)
        
        return entity
    
    def get_entity(self, entity_id: str) -> Optional[Entity]:
        """获取实体"""
        return self._entities.get(entity_id)
    
    def find_entities(
        self,
        name: Optional[str] = None,
        entity_type: Optional[EntityType] = None,
        min_confidence: float = 0.0,
    ) -> List[Entity]:
        """查找实体"""
        candidates = set(self._entities.keys())
        
        if entity_type:
            candidates &= self._entity_by_type.get(entity_type, set())
        
        if name:
            name_lower = name.lower()
            name_matches = set()
            for key, ids in self._entity_by_name.items():
                if name_lower in key:
                    name_matches |= ids
            candidates &= name_matches
        
        result = []
        for eid in candidates:
            entity = self._entities[eid]
            if entity.confidence >= min_confidence:
                result.append(entity)
        
        # 按置信度和提及次数排序
        result.sort(key=lambda e: (e.confidence, e.mention_count), reverse=True)
        return result
    
    # ============================================================
    # 关系操作
    # ============================================================
    def add_relation(
        self,
        subject_id: str,
        predicate: RelationType,
        object_id: str,
        properties: Dict[str, Any] = None,
        confidence: float = 1.0,
        evidence: str = "",
        source: str = "",
        source_location: str = "",
    ) -> Optional[Relation]:
        """
        添加关系（支持关系融合）
        
        如果相同关系已存在，则增加证据计数和置信度
        """
        # 验证实体存在
        if subject_id not in self._entities or object_id not in self._entities:
            return None
        
        relation_id = self._generate_relation_id(subject_id, predicate, object_id)
        
        if relation_id in self._relations:
            # 关系融合
            existing = self._relations[relation_id]
            existing.evidence_count += 1
            existing.confidence = min(existing.confidence + 0.05, 0.99)
            
            # 追加证据
            if evidence and evidence not in existing.evidence:
                existing.evidence = f"{existing.evidence}\n---\n{evidence}" if existing.evidence else evidence
            
            return existing
        
        # 创建新关系
        relation = Relation(
            id=relation_id,
            subject_id=subject_id,
            predicate=predicate,
            object_id=object_id,
            properties=properties or {},
            confidence=confidence,
            evidence=evidence,
            source=source,
            source_location=source_location,
        )
        
        self._relations[relation_id] = relation
        
        # 更新索引
        self._relations_by_subject[subject_id].add(relation_id)
        self._relations_by_object[object_id].add(relation_id)
        self._relations_by_predicate[predicate].add(relation_id)
        
        return relation
    
    def get_relations(
        self,
        subject_id: Optional[str] = None,
        object_id: Optional[str] = None,
        predicate: Optional[RelationType] = None,
    ) -> List[Relation]:
        """获取关系"""
        candidates = set(self._relations.keys())
        
        if subject_id:
            candidates &= self._relations_by_subject.get(subject_id, set())
        if object_id:
            candidates &= self._relations_by_object.get(object_id, set())
        if predicate:
            candidates &= self._relations_by_predicate.get(predicate, set())
        
        return [self._relations[rid] for rid in candidates]
    
    # ============================================================
    # 推理能力
    # ============================================================
    def find_path(
        self,
        start_id: str,
        end_id: str,
        max_depth: int = 3,
    ) -> List[List[Tuple[Entity, Relation, Entity]]]:
        """
        多跳推理 - 查找两个实体之间的路径
        
        返回所有可能的路径（每条路径是 (实体, 关系, 实体) 三元组的列表）
        """
        if start_id not in self._entities or end_id not in self._entities:
            return []
        
        paths = []
        visited = set()
        
        def dfs(current_id: str, path: List, depth: int):
            if depth > max_depth:
                return
            if current_id == end_id:
                paths.append(path.copy())
                return
            if current_id in visited:
                return
            
            visited.add(current_id)
            
            # 遍历所有出边
            for rel_id in self._relations_by_subject.get(current_id, set()):
                rel = self._relations[rel_id]
                next_entity = self._entities.get(rel.object_id)
                if next_entity:
                    path.append((self._entities[current_id], rel, next_entity))
                    dfs(rel.object_id, path, depth + 1)
                    path.pop()
            
            visited.remove(current_id)
        
        dfs(start_id, [], 0)
        return paths
    
    def infer_relations(
        self,
        entity_id: str,
        inference_rules: Optional[Dict] = None,
    ) -> List[Dict]:
        """
        推理新关系
        
        基于已有关系推理出隐含的新关系
        """
        if entity_id not in self._entities:
            return []
        
        inferred = []
        entity = self._entities[entity_id]
        
        # 默认推理规则
        rules = inference_rules or {
            # 如果 A requires B，B requires C，则 A 间接 requires C
            "transitive_requires": {
                "pattern": [RelationType.REQUIRES, RelationType.REQUIRES],
                "infer": RelationType.DEPENDS_ON,
            },
            # 如果 A satisfies B，B is_a C，则 A 也 satisfies C
            "satisfies_inheritance": {
                "pattern": [RelationType.SATISFIES, RelationType.IS_A],
                "infer": RelationType.SATISFIES,
            },
        }
        
        # 获取所有出边关系
        outgoing = self.get_relations(subject_id=entity_id)
        
        for rel1 in outgoing:
            # 获取目标实体的出边关系
            rel2_list = self.get_relations(subject_id=rel1.object_id)
            
            for rel2 in rel2_list:
                # 检查是否匹配推理规则
                for rule_name, rule in rules.items():
                    if [rel1.predicate, rel2.predicate] == rule["pattern"]:
                        inferred.append({
                            "rule": rule_name,
                            "subject": entity.name,
                            "predicate": rule["infer"].value,
                            "object": self._entities[rel2.object_id].name,
                            "confidence": min(rel1.confidence, rel2.confidence) * 0.8,
                            "reasoning_path": [
                                f"{entity.name} --[{rel1.predicate.value}]--> {self._entities[rel1.object_id].name}",
                                f"{self._entities[rel1.object_id].name} --[{rel2.predicate.value}]--> {self._entities[rel2.object_id].name}",
                            ]
                        })
        
        return inferred
    
    def get_related_entities(
        self,
        entity_id: str,
        relation_types: Optional[List[RelationType]] = None,
        direction: str = "both",  # "outgoing", "incoming", "both"
        max_depth: int = 1,
    ) -> List[Tuple[Entity, Relation, int]]:
        """
        获取相关实体
        
        返回 (实体, 关系, 深度) 的列表
        """
        if entity_id not in self._entities:
            return []
        
        result = []
        visited = {entity_id}
        queue = [(entity_id, 0)]
        
        while queue:
            current_id, depth = queue.pop(0)
            if depth >= max_depth:
                continue
            
            # 出边
            if direction in ("outgoing", "both"):
                for rel_id in self._relations_by_subject.get(current_id, set()):
                    rel = self._relations[rel_id]
                    if relation_types and rel.predicate not in relation_types:
                        continue
                    if rel.object_id not in visited:
                        visited.add(rel.object_id)
                        entity = self._entities[rel.object_id]
                        result.append((entity, rel, depth + 1))
                        queue.append((rel.object_id, depth + 1))
            
            # 入边
            if direction in ("incoming", "both"):
                for rel_id in self._relations_by_object.get(current_id, set()):
                    rel = self._relations[rel_id]
                    if relation_types and rel.predicate not in relation_types:
                        continue
                    if rel.subject_id not in visited:
                        visited.add(rel.subject_id)
                        entity = self._entities[rel.subject_id]
                        result.append((entity, rel, depth + 1))
                        queue.append((rel.subject_id, depth + 1))
        
        return result
    
    # ============================================================
    # 查询增强
    # ============================================================
    def expand_query(self, query: str) -> Dict[str, Any]:
        """
        查询扩展 - 使用知识图谱增强查询
        
        返回：
        - expanded_terms: 扩展的查询词
        - related_entities: 相关实体
        - context: 上下文信息
        """
        # 1. 在实体名称中搜索匹配
        matched_entities = []
        query_lower = query.lower()
        query_terms = set(query_lower.split())
        
        for name, entity_ids in self._entity_by_name.items():
            # 精确匹配或部分匹配
            if any(term in name for term in query_terms) or name in query_lower:
                for eid in entity_ids:
                    matched_entities.append(self._entities[eid])
        
        # 2. 获取相关实体
        related_entities = []
        expanded_terms = set(query_terms)
        
        for entity in matched_entities[:5]:  # 限制数量
            # 添加实体名称
            expanded_terms.add(entity.name.lower())
            
            # 获取相关实体
            related = self.get_related_entities(entity.id, max_depth=1)
            for rel_entity, rel, depth in related[:3]:
                related_entities.append({
                    "name": rel_entity.name,
                    "type": rel_entity.entity_type.value,
                    "relation": rel.predicate.value,
                    "from": entity.name,
                })
                expanded_terms.add(rel_entity.name.lower())
        
        # 3. 构建上下文
        context = []
        for entity in matched_entities[:3]:
            # 获取实体的所有关系
            relations = self.get_relations(subject_id=entity.id)
            for rel in relations[:5]:
                obj = self._entities.get(rel.object_id)
                if obj:
                    context.append(f"{entity.name} {rel.predicate.value} {obj.name}")
        
        return {
            "original_query": query,
            "expanded_terms": list(expanded_terms - query_terms),
            "matched_entities": [e.to_dict() for e in matched_entities[:5]],
            "related_entities": related_entities[:10],
            "context": context[:10],
            "expanded_query": f"{query} {' '.join(expanded_terms - query_terms)}" if expanded_terms - query_terms else query,
        }
    
    # ============================================================
    # 持久化
    # ============================================================
    def _load(self):
        """加载知识图谱（持 _io_lock 防止与 save/reload 并发）"""
        with self._io_lock:
            self._load_unsafe()

    def _load_unsafe(self):
        """实际加载逻辑（调用方需已持锁）"""
        entities_file = self.storage_path / "entities.json"
        relations_file = self.storage_path / "relations.json"
        
        if entities_file.exists():
            try:
                with open(entities_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                entity_list = data.get("entities", data) if isinstance(data, dict) else data
                for entity_data in (entity_list or []):
                    entity = Entity.from_dict(entity_data)
                    self._entities[entity.id] = entity
                    self._entity_by_type[entity.entity_type].add(entity.id)
                    self._entity_by_name[entity.name.lower()].add(entity.id)
            except Exception as e:
                logger.warning("加载实体失败: %s", e)
        
        if relations_file.exists():
            try:
                with open(relations_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                rel_list = data.get("relations", data) if isinstance(data, dict) else data
                for rel_data in (rel_list or []):
                    rel = Relation.from_dict(rel_data)
                    self._relations[rel.id] = rel
                    self._relations_by_subject[rel.subject_id].add(rel.id)
                    self._relations_by_object[rel.object_id].add(rel.id)
                    self._relations_by_predicate[rel.predicate].add(rel.id)
            except Exception as e:
                logger.warning("加载关系失败: %s", e)
        
        logger.info("知识图谱已加载: %d 实体, %d 关系", len(self._entities), len(self._relations))

    def save(self):
        """保存知识图谱（与 knowledge_api 的 entities.json/relations.json 格式兼容）；保存后自动备份并写 changelog；持 _io_lock 防止与 load/reload 并发"""
        with self._io_lock:
            entities_file = self.storage_path / "entities.json"
            relations_file = self.storage_path / "relations.json"
            now = datetime.now().isoformat()
            entities_payload = {
                "_meta": {"description": "实体定义（Lattice 风格知识图谱）", "updated": now},
                "entities": [e.to_dict() for e in self._entities.values()],
            }
            relations_payload = {
                "_meta": {"description": "实体关系定义", "updated": now},
                "relations": [r.to_dict() for r in self._relations.values()],
            }
            with open(entities_file, 'w', encoding='utf-8') as f:
                json.dump(entities_payload, f, ensure_ascii=False, indent=2)
            with open(relations_file, 'w', encoding='utf-8') as f:
                json.dump(relations_payload, f, ensure_ascii=False, indent=2)
            run_ontology_backup_and_changelog(self.storage_path)
            logger.info("知识图谱已保存: %d 实体, %d 关系", len(self._entities), len(self._relations))

    def get_stats(self) -> Dict:
        """获取统计信息"""
        entity_type_counts = {}
        for etype, eids in self._entity_by_type.items():
            entity_type_counts[etype.value] = len(eids)
        
        relation_type_counts = {}
        for rtype, rids in self._relations_by_predicate.items():
            relation_type_counts[rtype.value] = len(rids)
        
        return {
            "total_entities": len(self._entities),
            "total_relations": len(self._relations),
            "entity_types": entity_type_counts,
            "relation_types": relation_type_counts,
        }

    def reload(self):
        """重新加载知识图谱（清空后从磁盘重新读取）；持 _io_lock 与 load/save 互斥"""
        with self._io_lock:
            self._entities.clear()
            self._relations.clear()
            self._entity_by_type.clear()
            self._entity_by_name.clear()
            self._relations_by_subject.clear()
            self._relations_by_object.clear()
            self._relations_by_predicate.clear()
            self._load_unsafe()


def run_ontology_backup_and_changelog(ontology_dir: Path) -> None:
    """
    对 ontology 目录下的 entities.json / relations.json 做备份并追加 changelog。
    供 KnowledgeGraph.save() 与 knowledge_api 本体 CRUD 保存后调用，保证「保存即备份」。
    备份保留最近 10 份。
    """
    entities_file = ontology_dir / "entities.json"
    relations_file = ontology_dir / "relations.json"
    now = datetime.now().isoformat()
    entity_count = 0
    relation_count = 0
    if entities_file.exists():
        try:
            data = json.loads(entities_file.read_text(encoding="utf-8"))
            entity_count = len(data.get("entities") or [])
        except Exception:
            pass
    if relations_file.exists():
        try:
            data = json.loads(relations_file.read_text(encoding="utf-8"))
            relation_count = len(data.get("relations") or [])
        except Exception:
            pass
    backups_dir = ontology_dir / "backups"
    backups_dir.mkdir(parents=True, exist_ok=True)
    ts = now.replace(":", "-").replace(".", "-")[:19]
    for name, path in [("entities", entities_file), ("relations", relations_file)]:
        if path.exists():
            backup_path = backups_dir / f"{ts}_{name}.json"
            try:
                backup_path.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
            except Exception as e:
                logger.warning("备份 %s 失败: %s", name, e)
    existing = sorted(backups_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in existing[10:]:
        try:
            old.unlink()
        except Exception as e:
            logger.warning("删除旧备份 %s 失败: %s", old.name, e)
    changelog_path = ontology_dir / "changelog.md"
    line = f"- {now[:19]} 保存 {entity_count} 实体, {relation_count} 关系\n"
    try:
        prev = changelog_path.read_text(encoding="utf-8") if changelog_path.exists() else "# 本体/知识图谱变更日志\n\n"
        if not prev.endswith("\n"):
            prev += "\n"
        changelog_path.write_text(prev + line, encoding="utf-8")
    except Exception as e:
        logger.warning("写入 changelog 失败: %s", e)


# ============================================================
# 4. 实体关系提取器
# ============================================================
class EntityRelationExtractor:
    """
    实体关系提取器 - 从文本中提取实体和关系
    
    支持：
    1. 规则提取（快速、确定性）
    2. LLM 提取（准确、语义理解）
    3. 混合模式（规则 + LLM）
    """
    
    def __init__(self, knowledge_graph: KnowledgeGraph):
        self.kg = knowledge_graph
        
        # 实体提取规则
        self._entity_patterns = self._init_entity_patterns()
        
        # 关系提取规则
        self._relation_patterns = self._init_relation_patterns()
    
    def _init_entity_patterns(self) -> Dict[EntityType, List[Tuple[str, Dict]]]:
        """初始化实体提取规则"""
        return {
            EntityType.MONEY: [
                (r'(\d+[\d,\.]*)\s*(万元|元|亿元)', {"value_group": 1, "unit_group": 2}),
                (r'预算[金额为：:]*\s*(\d+[\d,\.]*)\s*(万元|元|亿)', {"value_group": 1, "unit_group": 2}),
            ],
            EntityType.DATE: [
                (r'(\d{4}年\d{1,2}月\d{1,2}日)', {}),
                (r'(\d{4}-\d{1,2}-\d{1,2})', {}),
                (r'(\d{4}/\d{1,2}/\d{1,2})', {}),
            ],
            EntityType.PERCENTAGE: [
                (r'(\d+(?:\.\d+)?)\s*%', {"value_group": 1}),
                (r'权重[为：:]*\s*(\d+(?:\.\d+)?)\s*%', {"value_group": 1}),
            ],
            EntityType.QUALIFICATION: [
                (r'(ISO\s*\d+)', {}),
                (r'(CMMI\s*[级\d]+)', {}),
                (r'(系统集成[一二三四五]级)', {}),
                (r'(安全等保[一二三四五]级)', {}),
                (r'(高新技术企业)', {}),
                (r'(软件企业)', {}),
            ],
            EntityType.REQUIREMENT: [
                (r'[★☆\*]\s*([^。；\n]{5,50})', {}),  # 星标要求
                (r'(须|必须|应当|应具备)\s*([^。；]{5,80})[。；]', {"content_group": 2}),
            ],
            EntityType.DISQUALIFICATION: [
                (r'(废标|否决|无效|不得)[^。；]*([^。；]{5,80})[。；]', {"content_group": 2}),
            ],
            EntityType.SCORING_ITEM: [
                (r'([^。\n]{3,30})\s*[：:]\s*(\d+)\s*分', {"name_group": 1, "score_group": 2}),
            ],
            EntityType.PRODUCT: [
                (r'(服务器|存储|交换机|防火墙|路由器)', {}),
                (r'(飞腾|鲲鹏|海光|龙芯)', {}),
                (r'(麒麟|统信|中标麒麟)', {}),
            ],
            EntityType.ORGANIZATION: [
                (r'([\u4e00-\u9fa5]{2,15}(?:公司|集团|单位|机构|局|厅|委|办))', {}),
            ],
        }
    
    def _init_relation_patterns(self) -> List[Tuple[str, RelationType, Dict]]:
        """初始化关系提取规则"""
        return [
            # 要求关系
            (r'(.{2,20})\s*(?:须|必须|应当|需要)\s*(.{5,50})', RelationType.REQUIRES, {}),
            (r'(.{2,20})\s*(?:提供|具备|拥有)\s*(.{5,50})', RelationType.PROVIDES, {}),
            
            # 时间关系
            (r'(.{2,20})\s*(?:截止|期限|时间)[为是：:]\s*(.{5,30})', RelationType.DEADLINE_IS, {}),
            (r'(.{2,20})\s*(?:有效期)[至到为是：:]\s*(.{5,30})', RelationType.VALID_UNTIL, {}),
            
            # 数值关系
            (r'(.{2,20})\s*(?:金额|预算|报价)[为是：:]\s*(.{5,30})', RelationType.AMOUNT_IS, {}),
            (r'(.{2,20})\s*(?:权重|占比)[为是：:]\s*(.{5,20})', RelationType.WEIGHT_IS, {}),
            (r'(.{2,20})\s*(?:分值|得分)[为是：:]\s*(.{3,20})', RelationType.SCORE_IS, {}),
            
            # 层级关系
            (r'(.{2,20})\s*(?:属于|归属|隶属)\s*(.{2,20})', RelationType.PART_OF, {}),
            (r'(.{2,20})\s*(?:包含|包括|含有)\s*(.{5,50})', RelationType.CONTAINS, {}),
            
            # 因果关系
            (r'(.{5,30})\s*(?:导致|造成|引起)\s*(.{5,30})', RelationType.LEADS_TO, {}),
            (r'(.{5,30})\s*(?:依赖|基于|需要)\s*(.{5,30})', RelationType.DEPENDS_ON, {}),
        ]
    
    def extract_entities(
        self,
        text: str,
        source: str = "",
        source_location: str = "",
    ) -> List[Entity]:
        """从文本中提取实体"""
        entities = []
        
        for entity_type, patterns in self._entity_patterns.items():
            for pattern, config in patterns:
                for match in re.finditer(pattern, text):
                    # 提取实体名称
                    if "content_group" in config:
                        name = match.group(config["content_group"])
                    elif "name_group" in config:
                        name = match.group(config["name_group"])
                    else:
                        name = match.group(0)
                    
                    # 提取属性
                    properties = {}
                    if "value_group" in config:
                        properties["value"] = match.group(config["value_group"])
                    if "unit_group" in config:
                        properties["unit"] = match.group(config["unit_group"])
                    if "score_group" in config:
                        properties["score"] = match.group(config["score_group"])
                    
                    # 添加实体
                    entity = self.kg.add_entity(
                        name=name.strip(),
                        entity_type=entity_type,
                        properties=properties,
                        source=source,
                        source_location=source_location,
                    )
                    entities.append(entity)
        
        return entities
    
    def extract_relations(
        self,
        text: str,
        entities: List[Entity],
        source: str = "",
        source_location: str = "",
    ) -> List[Relation]:
        """从文本中提取关系"""
        relations = []
        entity_names = {e.name.lower(): e for e in entities}
        
        for pattern, rel_type, config in self._relation_patterns:
            for match in re.finditer(pattern, text):
                subject_text = match.group(1).strip()
                object_text = match.group(2).strip()
                
                # 尝试匹配已有实体
                subject_entity = None
                object_entity = None
                
                for name, entity in entity_names.items():
                    if name in subject_text.lower() or subject_text.lower() in name:
                        subject_entity = entity
                    if name in object_text.lower() or object_text.lower() in name:
                        object_entity = entity
                
                # 如果没有匹配到实体，创建新实体
                if not subject_entity:
                    subject_entity = self.kg.add_entity(
                        name=subject_text,
                        entity_type=EntityType.REQUIREMENT,
                        source=source,
                        source_location=source_location,
                    )
                
                if not object_entity:
                    object_entity = self.kg.add_entity(
                        name=object_text,
                        entity_type=EntityType.REQUIREMENT,
                        source=source,
                        source_location=source_location,
                    )
                
                # 添加关系
                relation = self.kg.add_relation(
                    subject_id=subject_entity.id,
                    predicate=rel_type,
                    object_id=object_entity.id,
                    evidence=match.group(0),
                    source=source,
                    source_location=source_location,
                )
                if relation:
                    relations.append(relation)
        
        return relations
    
    def extract_entities_simple(
        self,
        text: str,
        source: str = "",
        source_location: str = "",
    ) -> List[Entity]:
        """轻量级实体提取（纯规则，无 LLM）- 不写入图谱，供 embedding_tools 批量索引时调用"""
        entities = []
        for entity_type, patterns in self._entity_patterns.items():
            for pattern, config in patterns:
                for match in re.finditer(pattern, text):
                    if "content_group" in config:
                        name = match.group(config["content_group"])
                    elif "name_group" in config:
                        name = match.group(config["name_group"])
                    else:
                        name = match.group(0)
                    name = name.strip()
                    properties = {}
                    if "value_group" in config:
                        properties["value"] = match.group(config["value_group"])
                    if "unit_group" in config:
                        properties["unit"] = match.group(config["unit_group"])
                    if "score_group" in config:
                        properties["score"] = match.group(config["score_group"])
                    entity_id = self.kg._generate_entity_id(name, entity_type)
                    entity = Entity(
                        id=entity_id,
                        name=name,
                        entity_type=entity_type,
                        properties=properties,
                        confidence=1.0,
                        source=source,
                        source_location=source_location,
                    )
                    entities.append(entity)
        return entities
    
    def extract_relations_simple(
        self,
        text: str,
        entities: Optional[List[Entity]] = None,
        source: str = "",
        source_location: str = "",
    ) -> List[Relation]:
        """轻量级关系提取（纯规则，无 LLM）- 不写入图谱，仅当主客体均在 entities 中时产出关系"""
        if entities is None:
            entities = self.extract_entities_simple(text, source, source_location)
        relations = []
        entity_names = {e.name.lower(): e for e in entities}
        for pattern, rel_type, config in self._relation_patterns:
            for match in re.finditer(pattern, text):
                subject_text = match.group(1).strip()
                object_text = match.group(2).strip()
                subject_entity = None
                object_entity = None
                for name, entity in entity_names.items():
                    if name in subject_text.lower() or subject_text.lower() in name:
                        subject_entity = entity
                    if name in object_text.lower() or object_text.lower() in name:
                        object_entity = entity
                if subject_entity is None or object_entity is None:
                    continue
                relation_id = self.kg._generate_relation_id(
                    subject_entity.id, rel_type, object_entity.id
                )
                relation = Relation(
                    id=relation_id,
                    subject_id=subject_entity.id,
                    predicate=rel_type,
                    object_id=object_entity.id,
                    properties={},
                    confidence=1.0,
                    evidence=match.group(0),
                    source=source,
                    source_location=source_location,
                )
                relations.append(relation)
        return relations
    
    def accumulate(
        self,
        entities: List[Entity],
        relations: List[Relation],
        source: str = "",
        source_location: str = "",
    ) -> None:
        """将提取结果累积到知识图谱中（带融合去重）"""
        for entity in entities:
            self.kg.add_entity(
                name=entity.name,
                entity_type=entity.entity_type,
                properties=entity.properties,
                confidence=entity.confidence,
                source=source or entity.source,
                source_location=source_location or entity.source_location,
            )
        for relation in relations:
            self.kg.add_relation(
                subject_id=relation.subject_id,
                predicate=relation.predicate,
                object_id=relation.object_id,
                properties=relation.properties,
                confidence=relation.confidence,
                evidence=relation.evidence,
                source=source or relation.source,
                source_location=source_location or relation.source_location,
            )
        self.kg.save()
    
    def _build_schema_prompt_section(self, domain: Optional[str]) -> Tuple[str, str]:
        """根据 schema 生成实体类型与关系类型的提示片段；无 schema 时返回默认枚举说明。"""
        schema = load_schema(domain=domain)
        if schema:
            et = schema.get("entity_types") or {}
            rt = schema.get("relation_types") or {}
            entity_lines = "\n".join(
                f"- {k}: {v.get('label', v) if isinstance(v, dict) else v}"
                for k, v in et.items()
            )
            relation_lines = "\n".join(
                f"- {k}: {v.get('label', v) if isinstance(v, dict) else v}"
                for k, v in rt.items()
            )
            return entity_lines or "- organization, project, requirement, product, ...", relation_lines or "- requires, provides, contains, ..."
        return (
            "- organization: 公司、机构\n- project: 项目\n- requirement: 需求/要求\n- qualification: 资质证书\n- product: 产品\n- money: 金额\n- date: 日期\n- scoring_item: 评分项\n- disqualification: 废标条款\n- risk: 风险",
            "- requires: 要求\n- provides: 提供\n- satisfies: 满足\n- deadline_is: 截止时间\n- amount_is: 金额为\n- weight_is: 权重为\n- part_of: 属于\n- contains: 包含\n- leads_to: 导致\n- depends_on: 依赖",
        )

    def extract_with_llm(
        self,
        text: str,
        llm_func: Callable,
        source: str = "",
        domain: Optional[str] = None,
    ) -> Tuple[List[Entity], List[Relation]]:
        """
        使用 LLM 提取实体和关系（支持 Schema-Driven：domain 指定时从 ontology/domain/{domain}/schema.json 加载类型约束）
        更准确但更慢，适用于复杂文本
        """
        entity_section, relation_section = self._build_schema_prompt_section(domain)
        prompt = f"""请从以下文本中提取关键实体和关系。
{"请严格使用下方 schema 定义的实体类型与关系类型。" if domain else ""}

文本：
{text[:3000]}

请以 JSON 格式返回：
{{
  "entities": [
    {{"name": "实体名称", "type": "类型", "properties": {{}}, "importance": "high/medium/low"}}
  ],
  "relations": [
    {{"subject": "主体名称", "predicate": "关系类型", "object": "客体名称", "evidence": "原文证据"}}
  ]
}}

实体类型（选择最合适的）：
{entity_section}

关系类型（选择最合适的）：
{relation_section}
"""
        
        try:
            schema = load_schema(domain=domain)
            schema_entity_types = {k.lower().replace("-", "_") for k in ((schema or {}).get("entity_types") or {})}
            schema_relation_types = set((schema or {}).get("relation_types") or {})

            result = llm_func(prompt)
            if isinstance(result, str):
                json_match = re.search(r'\{[\s\S]*\}', result)
                if json_match:
                    data = json.loads(json_match.group())
                else:
                    return [], []
            else:
                data = result

            entities = []
            relations = []
            entity_map = {}

            for e_data in data.get("entities", []):
                try:
                    entity_type = EntityType(e_data.get("type", "requirement"))
                except ValueError:
                    entity_type = EntityType.REQUIREMENT
                raw_type = (e_data.get("type") or "").strip().lower().replace("-", "_")
                props = dict(e_data.get("properties") or {})
                if schema_entity_types and raw_type not in schema_entity_types:
                    props["pending_review"] = True

                entity = self.kg.add_entity(
                    name=e_data["name"],
                    entity_type=entity_type,
                    properties=props,
                    source=source,
                )
                entities.append(entity)
                entity_map[e_data["name"]] = entity

            for r_data in data.get("relations", []):
                subject = entity_map.get(r_data["subject"])
                obj = entity_map.get(r_data["object"])
                if not subject:
                    subject = self.kg.add_entity(
                        name=r_data["subject"],
                        entity_type=EntityType.REQUIREMENT,
                        source=source,
                    )
                    entity_map[r_data["subject"]] = subject
                if not obj:
                    obj = self.kg.add_entity(
                        name=r_data["object"],
                        entity_type=EntityType.REQUIREMENT,
                        source=source,
                    )
                    entity_map[r_data["object"]] = obj
                try:
                    predicate = RelationType(r_data.get("predicate", "requires"))
                except ValueError:
                    predicate = RelationType.REQUIRES
                raw_pred = (r_data.get("predicate") or "").strip().lower().replace(" ", "_")
                if schema_relation_types and raw_pred not in schema_relation_types:
                    pass  # 关系无 properties 时可在 evidence 中标注待审核，此处仅实体做标记

                relation = self.kg.add_relation(
                    subject_id=subject.id,
                    predicate=predicate,
                    object_id=obj.id,
                    evidence=r_data.get("evidence", ""),
                    source=source,
                )
                if relation:
                    relations.append(relation)

            return entities, relations
            
        except Exception as e:
            logger.warning("LLM 提取失败: %s", e)
            return [], []


# ============================================================
# 5. 文档结构映射 (DocMap)
# ============================================================
@dataclass
class DocumentSection:
    """文档章节"""
    id: str
    title: str
    level: int                         # 章节层级 (1=一级标题, 2=二级标题...)
    start_pos: int                     # 起始位置
    end_pos: int                       # 结束位置
    parent_id: Optional[str] = None    # 父章节ID
    children: List[str] = field(default_factory=list)  # 子章节ID列表
    summary: str = ""                  # 章节摘要
    keywords: List[str] = field(default_factory=list)  # 关键词
    entity_ids: List[str] = field(default_factory=list)  # 包含的实体ID


class DocumentMap:
    """
    文档结构映射 - 帮助 Agent 理解文档结构
    
    特性：
    1. 章节层级解析
    2. 章节摘要生成
    3. 关键词提取
    4. 实体定位
    5. 导航建议
    """
    
    def __init__(self, knowledge_graph: KnowledgeGraph):
        self.kg = knowledge_graph
        self._documents: Dict[str, Dict] = {}  # doc_id -> document info
        self._sections: Dict[str, DocumentSection] = {}  # section_id -> section
    
    def parse_document(
        self,
        content: str,
        doc_id: str,
        doc_name: str,
        extract_entities: bool = True,
    ) -> Dict:
        """
        解析文档结构
        
        返回文档映射，包含章节树、关键词、实体等
        """
        sections = []
        current_pos = 0
        
        # 解析章节（支持 Markdown 和中文章节格式）
        section_patterns = [
            (r'^(#{1,6})\s+(.+)$', "markdown"),  # Markdown 标题
            (r'^第([一二三四五六七八九十]+)章\s*(.+)$', "chinese_chapter"),
            (r'^第([一二三四五六七八九十]+)节\s*(.+)$', "chinese_section"),
            (r'^(\d+(?:\.\d+)*)\s+(.+)$', "numbered"),  # 数字编号
        ]
        
        lines = content.split('\n')
        section_stack = []  # 用于追踪父子关系
        
        for i, line in enumerate(lines):
            for pattern, pattern_type in section_patterns:
                match = re.match(pattern, line.strip())
                if match:
                    # 确定章节层级
                    if pattern_type == "markdown":
                        level = len(match.group(1))
                        title = match.group(2)
                    elif pattern_type == "chinese_chapter":
                        level = 1
                        title = match.group(2)
                    elif pattern_type == "chinese_section":
                        level = 2
                        title = match.group(2)
                    elif pattern_type == "numbered":
                        level = match.group(1).count('.') + 1
                        title = match.group(2)
                    
                    section_id = f"{doc_id}_s{len(sections)}"
                    
                    # 确定父章节
                    parent_id = None
                    while section_stack and section_stack[-1][1] >= level:
                        section_stack.pop()
                    if section_stack:
                        parent_id = section_stack[-1][0]
                        # 更新父章节的 children
                        for s in sections:
                            if s.id == parent_id:
                                s.children.append(section_id)
                    
                    section = DocumentSection(
                        id=section_id,
                        title=title,
                        level=level,
                        start_pos=current_pos,
                        end_pos=current_pos,  # 后续更新
                        parent_id=parent_id,
                    )
                    sections.append(section)
                    section_stack.append((section_id, level))
                    break
            
            current_pos += len(line) + 1
        
        # 更新章节结束位置
        for i, section in enumerate(sections):
            if i + 1 < len(sections):
                section.end_pos = sections[i + 1].start_pos - 1
            else:
                section.end_pos = len(content)
        
        # 提取每个章节的关键词和摘要
        for section in sections:
            section_content = content[section.start_pos:section.end_pos]
            section.keywords = self._extract_keywords(section_content)
            section.summary = self._generate_summary(section_content)
            
            # 提取实体
            if extract_entities:
                extractor = EntityRelationExtractor(self.kg)
                entities = extractor.extract_entities(
                    section_content,
                    source=doc_name,
                    source_location=section.title,
                )
                section.entity_ids = [e.id for e in entities]
        
        # 存储
        for section in sections:
            self._sections[section.id] = section
        
        doc_info = {
            "id": doc_id,
            "name": doc_name,
            "section_count": len(sections),
            "sections": [s.id for s in sections],
            "root_sections": [s.id for s in sections if s.parent_id is None],
        }
        self._documents[doc_id] = doc_info
        
        return doc_info
    
    def _extract_keywords(self, text: str, top_k: int = 5) -> List[str]:
        """提取关键词（简单实现）"""
        # 移除标点和数字
        clean_text = re.sub(r'[^\u4e00-\u9fa5a-zA-Z\s]', ' ', text)
        
        # 分词（简单按空格和常见词分割）
        words = clean_text.split()
        
        # 过滤停用词和短词
        stopwords = {'的', '是', '在', '和', '与', '或', '等', '及', '对', '为', '了', '有', '不', '将', '被', '由', '按', '应', '须'}
        words = [w for w in words if len(w) >= 2 and w not in stopwords]
        
        # 统计词频
        word_freq = {}
        for w in words:
            word_freq[w] = word_freq.get(w, 0) + 1
        
        # 返回高频词
        sorted_words = sorted(word_freq.items(), key=lambda x: x[1], reverse=True)
        return [w for w, _ in sorted_words[:top_k]]
    
    def _generate_summary(self, text: str, max_length: int = 100) -> str:
        """生成摘要（简单实现：取前几句）"""
        sentences = re.split(r'[。！？]', text)
        summary = ""
        for s in sentences:
            s = s.strip()
            if s and len(summary) + len(s) <= max_length:
                summary += s + "。"
            elif summary:
                break
        return summary or text[:max_length]
    
    def get_section(self, section_id: str) -> Optional[DocumentSection]:
        """获取章节"""
        return self._sections.get(section_id)
    
    def get_document_structure(self, doc_id: str) -> Dict:
        """获取文档结构（树形）"""
        doc_info = self._documents.get(doc_id)
        if not doc_info:
            return {}
        
        def build_tree(section_id: str) -> Dict:
            section = self._sections.get(section_id)
            if not section:
                return {}
            
            return {
                "id": section.id,
                "title": section.title,
                "level": section.level,
                "summary": section.summary,
                "keywords": section.keywords,
                "entity_count": len(section.entity_ids),
                "children": [build_tree(child_id) for child_id in section.children],
            }
        
        return {
            "document": doc_info["name"],
            "sections": [build_tree(sid) for sid in doc_info.get("root_sections", [])],
        }
    
    def find_sections(
        self,
        query: str,
        doc_id: Optional[str] = None,
    ) -> List[Tuple[DocumentSection, float]]:
        """
        查找相关章节
        
        返回 (章节, 相关度分数) 列表
        """
        query_terms = set(query.lower().split())
        results = []
        
        sections_to_search = self._sections.values()
        if doc_id:
            doc_info = self._documents.get(doc_id)
            if doc_info:
                sections_to_search = [self._sections[sid] for sid in doc_info["sections"] if sid in self._sections]
        
        for section in sections_to_search:
            # 计算相关度
            score = 0.0
            
            # 标题匹配
            title_lower = section.title.lower()
            for term in query_terms:
                if term in title_lower:
                    score += 2.0
            
            # 关键词匹配
            for kw in section.keywords:
                if kw.lower() in query.lower():
                    score += 1.0
            
            # 摘要匹配
            summary_lower = section.summary.lower()
            for term in query_terms:
                if term in summary_lower:
                    score += 0.5
            
            if score > 0:
                results.append((section, score))
        
        # 按分数排序
        results.sort(key=lambda x: x[1], reverse=True)
        return results
    
    def get_navigation_suggestions(
        self,
        current_section_id: str,
        query: str,
    ) -> Dict:
        """
        获取导航建议
        
        基于当前位置和查询，建议下一步应该查看的章节
        """
        current = self._sections.get(current_section_id)
        if not current:
            return {"suggestions": []}
        
        suggestions = []
        
        # 1. 子章节
        for child_id in current.children:
            child = self._sections.get(child_id)
            if child:
                suggestions.append({
                    "section_id": child.id,
                    "title": child.title,
                    "reason": "子章节",
                    "priority": 1,
                })
        
        # 2. 相关章节（基于查询）
        related = self.find_sections(query)
        for section, score in related[:5]:
            if section.id != current_section_id:
                suggestions.append({
                    "section_id": section.id,
                    "title": section.title,
                    "reason": f"与查询相关 (score: {score:.1f})",
                    "priority": 2,
                })
        
        # 3. 同级章节
        if current.parent_id:
            parent = self._sections.get(current.parent_id)
            if parent:
                for sibling_id in parent.children:
                    if sibling_id != current_section_id:
                        sibling = self._sections.get(sibling_id)
                        if sibling:
                            suggestions.append({
                                "section_id": sibling.id,
                                "title": sibling.title,
                                "reason": "同级章节",
                                "priority": 3,
                            })
        
        # 按优先级排序
        suggestions.sort(key=lambda x: x["priority"])
        
        return {
            "current": {
                "id": current.id,
                "title": current.title,
                "summary": current.summary,
            },
            "suggestions": suggestions[:10],
        }


# ============================================================
# 6. 全局实例
# ============================================================
_knowledge_graph: Optional[KnowledgeGraph] = None
_document_map: Optional[DocumentMap] = None
_extractor: Optional[EntityRelationExtractor] = None


def get_knowledge_graph() -> KnowledgeGraph:
    """获取知识图谱单例"""
    global _knowledge_graph
    if _knowledge_graph is None:
        _knowledge_graph = KnowledgeGraph()
    return _knowledge_graph


def get_document_map() -> DocumentMap:
    """获取文档映射单例"""
    global _document_map
    if _document_map is None:
        _document_map = DocumentMap(get_knowledge_graph())
    return _document_map


def get_extractor() -> EntityRelationExtractor:
    """获取提取器单例"""
    global _extractor
    if _extractor is None:
        _extractor = EntityRelationExtractor(get_knowledge_graph())
    return _extractor


# ============================================================
# 导出
# ============================================================
__all__ = [
    # 类型
    "EntityType",
    "RelationType",

    # 数据结构
    "Entity",
    "Relation",
    "DocumentSection",

    # 核心类
    "KnowledgeGraph",
    "EntityRelationExtractor",
    "DocumentMap",

    # Schema 单源
    "get_canonical_schema_path",
    "load_schema",

    # 工厂函数
    "get_knowledge_graph",
    "get_document_map",
    "get_extractor",
]
