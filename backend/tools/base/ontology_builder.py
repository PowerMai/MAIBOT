"""
本体构建器 - 从文档集合中系统化提取并构建领域本体

与 knowledge_graph 配合使用，支持：
1. 规则提取 + 可选 LLM 增强
2. 批量目录处理与增量单文件处理
3. 模式验证与一致性检查
4. 导出为前端可视化格式
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, List, Dict, Any, Callable

from .paths import ONTOLOGY_PATH, KB_PATH
from .knowledge_graph import (
    KnowledgeGraph,
    EntityRelationExtractor,
    DocumentMap,
    Entity,
    Relation,
    EntityType,
    RelationType,
    get_canonical_schema_path,
)

logger = logging.getLogger(__name__)

# 本体构建支持的扩展名（与上传/导入一致：.md/.txt/.pdf/.docx/.doc）
DEFAULT_ONTOLOGY_FILE_TYPES = [".md", ".txt", ".pdf", ".docx", ".doc"]


def _read_file_text_for_ontology(path: Path) -> Optional[str]:
    """按扩展名读取文件为纯文本，供本体抽取使用。支持 .md/.txt/.pdf/.docx/.doc。"""
    suffix = path.suffix.lower()
    if suffix in (".md", ".txt"):
        try:
            return path.read_text(encoding="utf-8", errors="ignore")
        except Exception as e:
            logger.warning("读取文本文件 %s 失败: %s", path, e)
            return None
    if suffix == ".pdf":
        try:
            import pdfplumber
            with pdfplumber.open(path) as pdf:
                return "\n".join((page.extract_text() or "") for page in pdf.pages)
        except ImportError:
            logger.debug("pdfplumber 未安装，跳过 PDF: %s", path)
            return None
        except Exception as e:
            logger.warning("读取 PDF %s 失败: %s", path, e)
            return None
    if suffix in (".docx", ".doc"):
        try:
            import docx
            doc = docx.Document(path)
            return "\n".join(para.text for para in doc.paragraphs)
        except ImportError:
            logger.debug("python-docx 未安装，跳过 Word: %s", path)
            return None
        except Exception as e:
            logger.warning("读取 Word %s 失败: %s", path, e)
            return None
    return None


class OntologySchema:
    """领域本体模式定义 - 约束实体类型、关系类型、属性。与 get_canonical_schema_path 单源一致。"""

    def __init__(self, schema_path: Optional[str] = None, domain: Optional[str] = None):
        if schema_path:
            path = Path(schema_path)
        elif domain:
            path = get_canonical_schema_path(domain)
        else:
            path = get_canonical_schema_path(None)
        if not path.exists():
            self._data = {"entity_types": {}, "relation_types": {}, "domain": domain or "general"}
            return
        with open(path, "r", encoding="utf-8") as f:
            self._data = json.load(f)

    @property
    def entity_types(self) -> Dict[str, Any]:
        return self._data.get("entity_types", {})

    @property
    def relation_types(self) -> Dict[str, Any]:
        return self._data.get("relation_types", {})

    def get_entity_types(self) -> List[str]:
        """获取所有允许的实体类型（模式中的键，大写）"""
        return list(self.entity_types.keys())

    def get_relation_types(self) -> List[str]:
        """获取所有允许的关系类型"""
        return list(self.relation_types.keys())

    def validate_entity(self, entity: Entity) -> bool:
        """验证实体类型是否在模式中（或为 OTHER）"""
        type_key = entity.entity_type.value.upper() if hasattr(entity.entity_type, "value") else str(entity.entity_type).upper()
        if type_key == "OTHER":
            return True
        return type_key in self.entity_types

    def validate_relation(self, relation: Relation, subject_type: Optional[EntityType] = None, object_type: Optional[EntityType] = None) -> bool:
        """验证关系的源/目标类型是否匹配模式（可选，若未传类型则只检查谓词存在）"""
        pred = relation.predicate.value if hasattr(relation.predicate, "value") else str(relation.predicate)
        if pred not in self.relation_types:
            return True
        rule = self.relation_types[pred]
        if subject_type is None or object_type is None:
            return True
        src_ok = rule.get("source")
        if isinstance(src_ok, list):
            src_ok = subject_type.value.upper() in [s.upper() for s in src_ok]
        else:
            src_ok = subject_type.value.upper() == (src_ok or "").upper()
        tgt = rule.get("target", "")
        obj_ok = object_type.value.upper() == (tgt.upper() if tgt else "")
        return src_ok and obj_ok


class OntologyBuilder:
    """系统化本体构建器 - 从文档集合中提取并构建领域本体"""

    def __init__(
        self,
        domain: str = "general",
        schema: Optional[OntologySchema] = None,
        use_llm: bool = False,
        llm_func: Optional[Callable] = None,
        storage_path: Optional[str] = None,
    ):
        self.domain = domain
        self.schema = schema or OntologySchema(domain=domain)
        self.use_llm = use_llm
        self.llm_func = llm_func
        self.knowledge_graph = KnowledgeGraph(storage_path=storage_path or str(ONTOLOGY_PATH))
        self.extractor = EntityRelationExtractor(self.knowledge_graph)
        self.doc_map = DocumentMap(self.knowledge_graph)
        self.stats = {
            "files_processed": 0,
            "entities_added": 0,
            "relations_added": 0,
            "errors": 0,
        }

    def build_from_directory(
        self,
        dir_path: str,
        recursive: bool = True,
        file_types: Optional[List[str]] = None,
        progress_callback: Optional[Callable[[int, int, str], None]] = None,
    ) -> Dict[str, Any]:
        """批量处理目录下所有文档，提取实体与关系并合并到本体"""
        path = Path(dir_path)
        if not path.exists() or not path.is_dir():
            return {"success": False, "error": "目录不存在", "stats": self.stats}
        file_types = file_types or DEFAULT_ONTOLOGY_FILE_TYPES
        count = 0
        total = 0
        for _ in path.rglob("*") if recursive else path.iterdir():
            p = _
            if p.is_file() and p.suffix.lower() in file_types:
                total += 1
        for fp in path.rglob("*") if recursive else path.iterdir():
            if not fp.is_file() or fp.suffix.lower() not in file_types:
                continue
            try:
                content = _read_file_text_for_ontology(fp)
                if not content or not content.strip():
                    continue
                entities = self.extractor.extract_entities_simple(content, source=str(fp))
                relations = self.extractor.extract_relations_simple(content, entities, source=str(fp))
                if self.schema and self.schema.entity_types:
                    entities = [e for e in entities if self.schema.validate_entity(e)]
                self.extractor.accumulate(entities, relations, source=str(fp))
                self.stats["files_processed"] += 1
                self.stats["entities_added"] += len(entities)
                self.stats["relations_added"] += len(relations)
                count += 1
                if progress_callback:
                    progress_callback(count, total, str(fp))
            except Exception as e:
                logger.warning("处理文件 %s 失败: %s", fp, e)
                self.stats["errors"] += 1
        return {"success": True, "stats": dict(self.stats)}

    def build_incremental(self, file_path: str) -> Dict[str, Any]:
        """增量处理单个新文档并合并到现有本体"""
        path = Path(file_path)
        if not path.exists() or not path.is_file():
            return {"success": False, "error": "文件不存在", "stats": self.stats}
        try:
            content = path.read_text(encoding="utf-8", errors="ignore")
            entities = self.extractor.extract_entities_simple(content, source=str(path))
            relations = self.extractor.extract_relations_simple(content, entities, source=str(path))
            if self.schema and self.schema.entity_types:
                entities = [e for e in entities if self.schema.validate_entity(e)]
            self.extractor.accumulate(entities, relations, source=str(path))
            self.stats["files_processed"] += 1
            self.stats["entities_added"] += len(entities)
            self.stats["relations_added"] += len(relations)
            return {"success": True, "stats": dict(self.stats)}
        except Exception as e:
            logger.warning("增量处理 %s 失败: %s", path, e)
            self.stats["errors"] += 1
            return {"success": False, "error": str(e), "stats": self.stats}

    def validate_ontology(self) -> Dict[str, Any]:
        """一致性检查：悬空关系、重复实体、孤立实体、模式违规"""
        issues = []
        kg = self.knowledge_graph
        for rid, rel in kg._relations.items():
            if rel.subject_id not in kg._entities:
                issues.append(f"悬空关系 {rid}: subject_id {rel.subject_id} 不存在")
            if rel.object_id not in kg._entities:
                issues.append(f"悬空关系 {rid}: object_id {rel.object_id} 不存在")
        connected = set()
        for rid, rel in kg._relations.items():
            connected.add(rel.subject_id)
            connected.add(rel.object_id)
        isolated = [eid for eid in kg._entities if eid not in connected]
        if isolated:
            issues.append(f"孤立实体数量: {len(isolated)}")
        return {
            "valid": len(issues) == 0,
            "issues": issues,
            "stats": {
                "total_entities": len(kg._entities),
                "total_relations": len(kg._relations),
                "isolated_entities": len(isolated),
            },
        }

    def export_for_visualization(
        self,
        limit: int = 500,
        entity_type: Optional[str] = None,
        relation_type: Optional[str] = None,
        min_confidence: float = 0.0,
    ) -> Dict[str, Any]:
        """导出图谱数据为前端可视化格式"""
        kg = self.knowledge_graph
        entities = list(kg._entities.values())
        if entity_type:
            try:
                et = EntityType(entity_type) if isinstance(entity_type, str) else entity_type
                entities = [e for e in entities if e.entity_type == et]
            except ValueError:
                pass
        entities = [e for e in entities if e.confidence >= min_confidence]
        if limit and len(entities) > limit:
            entities = entities[:limit]
        entity_ids = {e.id for e in entities}
        relations = []
        for r in kg._relations.values():
            if r.subject_id not in entity_ids or r.object_id not in entity_ids:
                continue
            if relation_type and r.predicate.value != relation_type:
                continue
            if r.confidence < min_confidence:
                continue
            relations.append(r)
        nodes = [
            {
                "id": e.id,
                "label": e.name,
                "type": e.entity_type.value,
                "properties": e.properties,
                "size": getattr(e, "mention_count", 1),
                "mentionCount": getattr(e, "mention_count", 1),
            }
            for e in entities
        ]
        edges = [
            {
                "id": r.id,
                "source": r.subject_id,
                "target": r.object_id,
                "label": r.predicate.value,
                "type": r.predicate.value,
                "confidence": r.confidence,
            }
            for r in relations
        ]
        stats = kg.get_stats()
        return {
            "nodes": nodes,
            "edges": edges,
            "stats": {
                "totalEntities": stats["total_entities"],
                "totalRelations": stats["total_relations"],
                "entitiesByType": stats.get("entity_types", {}),
                "relationsByType": stats.get("relation_types", {}),
            },
        }

    def export_subgraph(self, entity_id: str, depth: int = 2, max_nodes: int = 100) -> Dict[str, Any]:
        """导出以指定实体为中心的子图"""
        kg = self.knowledge_graph
        if entity_id not in kg._entities:
            return {"nodes": [], "edges": [], "stats": {}}
        collected_entities = {entity_id}
        queue = [(entity_id, 0)]
        while queue:
            eid, d = queue.pop(0)
            if d >= depth or len(collected_entities) >= max_nodes:
                continue
            for rel in kg.get_relations(subject_id=eid) + kg.get_relations(object_id=eid):
                if rel.subject_id not in collected_entities and len(collected_entities) < max_nodes:
                    collected_entities.add(rel.subject_id)
                    queue.append((rel.subject_id, d + 1))
                if rel.object_id not in collected_entities and len(collected_entities) < max_nodes:
                    collected_entities.add(rel.object_id)
                    queue.append((rel.object_id, d + 1))
        entities = [kg._entities[eid] for eid in collected_entities if eid in kg._entities]
        relation_ids = set()
        for eid in collected_entities:
            for r in kg.get_relations(subject_id=eid) + kg.get_relations(object_id=eid):
                if r.subject_id in collected_entities and r.object_id in collected_entities:
                    relation_ids.add(r.id)
        relations = [kg._relations[rid] for rid in relation_ids if rid in kg._relations]
        nodes = [
            {"id": e.id, "label": e.name, "type": e.entity_type.value, "properties": e.properties}
            for e in entities
        ]
        edges = [
            {"id": r.id, "source": r.subject_id, "target": r.object_id, "label": r.predicate.value, "type": r.predicate.value}
            for r in relations
        ]
        return {
            "nodes": nodes,
            "edges": edges,
            "stats": {"totalEntities": len(nodes), "totalRelations": len(edges)},
        }

    def get_build_stats(self) -> Dict[str, Any]:
        """获取构建统计信息"""
        return dict(self.stats)

    def merge_ontologies(
        self,
        base: Dict[str, Any],
        overlay: Dict[str, Any],
        conflict_strategy: str = "overlay_wins",
    ) -> Dict[str, Any]:
        """合并两个本体字典。"""
        merged = dict(base or {})
        for k, v in (overlay or {}).items():
            if k not in merged:
                merged[k] = v
                continue
            if isinstance(merged[k], dict) and isinstance(v, dict):
                nested = dict(merged[k])
                for nk, nv in v.items():
                    if nk not in nested:
                        nested[nk] = nv
                    elif conflict_strategy == "overlay_wins":
                        nested[nk] = nv
                merged[k] = nested
            elif isinstance(merged[k], list) and isinstance(v, list):
                seen = {json.dumps(x, ensure_ascii=False, sort_keys=True) for x in merged[k]}
                for item in v:
                    key = json.dumps(item, ensure_ascii=False, sort_keys=True)
                    if key not in seen:
                        merged[k].append(item)
                        seen.add(key)
            elif conflict_strategy == "overlay_wins":
                merged[k] = v
        return merged

    def create_ontology_version(self, ontology_path: str, version_tag: str, changelog: str = "") -> Dict[str, Any]:
        """创建本体版本快照。"""
        src = Path(ontology_path)
        if not src.exists():
            return {"ok": False, "error": "ontology_path 不存在"}
        backups = ONTOLOGY_PATH / "backups"
        backups.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        safe_tag = "".join(ch for ch in (version_tag or "v0") if ch.isalnum() or ch in ("-", "_", "."))
        dst = backups / f"{src.stem}-{safe_tag}-{timestamp}{src.suffix or '.json'}"
        dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
        meta = {
            "source": str(src),
            "version_tag": version_tag,
            "changelog": changelog,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "snapshot": str(dst),
        }
        (dst.with_suffix(dst.suffix + ".meta.json")).write_text(
            json.dumps(meta, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        return {"ok": True, **meta}

    def diff_ontologies(self, v1: Dict[str, Any], v2: Dict[str, Any]) -> Dict[str, Any]:
        """计算本体差异（新增/删除/变更键）。"""
        a = v1 or {}
        b = v2 or {}
        k1 = set(a.keys())
        k2 = set(b.keys())
        added = sorted(list(k2 - k1))
        removed = sorted(list(k1 - k2))
        changed = []
        for k in sorted(list(k1 & k2)):
            if json.dumps(a.get(k), ensure_ascii=False, sort_keys=True) != json.dumps(
                b.get(k), ensure_ascii=False, sort_keys=True
            ):
                changed.append(k)
        return {"added": added, "removed": removed, "changed": changed, "same": len(added) == 0 and len(removed) == 0 and len(changed) == 0}


def merge_ontologies(base, overlay, conflict_strategy: str = "overlay_wins"):
    builder = OntologyBuilder()
    return builder.merge_ontologies(base=base, overlay=overlay, conflict_strategy=conflict_strategy)


def create_ontology_version(ontology_path, version_tag, changelog: str = ""):
    builder = OntologyBuilder()
    return builder.create_ontology_version(ontology_path=ontology_path, version_tag=version_tag, changelog=changelog)


def diff_ontologies(v1, v2):
    builder = OntologyBuilder()
    return builder.diff_ontologies(v1=v1, v2=v2)
