#!/usr/bin/env python3
"""
本体与少工具能力轻量自检

不依赖网络与完整 Agent 启动，仅做最小检查：
- paths：ONTOLOGY_PATH、ONTOLOGY_IMPORT_STAGING_PATH 可读，get_canonical_schema_path/load_schema/get_schema_for_tools 可调用且结构一致
- ontology_import 能力：list_imported_candidates() 可调用且返回 list
- knowledge_graph 能力：query_knowledge_graph(query) 可调用且返回 dict（可序列化为字符串）

运行方式：
    cd backend
    python scripts/check_ontology_capability.py
"""

import os
import sys
from pathlib import Path

backend_root = Path(__file__).resolve().parent.parent
project_root = backend_root.parent
sys.path.insert(0, str(project_root))
os.chdir(backend_root)
os.environ.setdefault("ENABLE_KNOWLEDGE_GRAPH", "true")
os.environ.setdefault("ENABLE_KNOWLEDGE_RETRIEVER", "true")


def ok(name: str, success: bool, detail: str = "") -> bool:
    status = "PASS" if success else "FAIL"
    print(f"  [{status}] {name}" + (f" — {detail}" if detail else ""))
    return success


def main() -> int:
    print("check_ontology_capability: 本体与少工具能力自检\n")
    all_ok = True

    # 1. paths
    try:
        from backend.tools.base.paths import ONTOLOGY_PATH, ONTOLOGY_IMPORT_STAGING_PATH
        all_ok &= ok("paths.ONTOLOGY_PATH", isinstance(ONTOLOGY_PATH, Path), str(ONTOLOGY_PATH))
        all_ok &= ok("paths.ONTOLOGY_IMPORT_STAGING_PATH", isinstance(ONTOLOGY_IMPORT_STAGING_PATH, Path), str(ONTOLOGY_IMPORT_STAGING_PATH))
    except Exception as e:
        all_ok &= ok("paths 读取", False, str(e))
        return 1

    # 2. schema 单源：get_canonical_schema_path / load_schema / get_schema_for_tools
    try:
        from backend.tools.base.knowledge_graph import (
            get_canonical_schema_path,
            load_schema,
            get_schema_for_tools,
        )
        p0 = get_canonical_schema_path(None)
        p1 = get_canonical_schema_path("core")
        all_ok &= ok("get_canonical_schema_path(domain)", isinstance(p0, Path) and isinstance(p1, Path), f"None->{p0}, core->{p1}")
        schema = load_schema(domain=None)
        all_ok &= ok("load_schema(domain=None)", schema is None or isinstance(schema, dict))
        for_tools = get_schema_for_tools(domain=None)
        structure_ok = isinstance(for_tools, dict) and "entities" in for_tools and "relation_types" in for_tools
        all_ok &= ok("get_schema_for_tools(domain=None) 结构", structure_ok)
    except Exception as e:
        all_ok &= ok("schema 单源", False, str(e))
        return 1

    # 3. ontology_import(action=list_candidates)：直接调底层，避免 registry 包装的 docstring 等校验
    try:
        from backend.tools.ontology.merge_imported import list_imported_candidates
        out = list_imported_candidates()
        all_ok &= ok("ontology_import(list_candidates) 底层", isinstance(out, list), f"candidates={len(out)}")
    except Exception as e:
        all_ok &= ok("ontology_import list_candidates", False, str(e))
        all_ok = False

    # 4. knowledge_graph(action=query)：直接调 query_knowledge_graph，避免 registry 包装校验
    try:
        from backend.tools.base.embedding_tools import query_knowledge_graph
        result = query_knowledge_graph("招标")
        out = result if isinstance(result, str) else __import__("json").dumps(result, ensure_ascii=False)
        all_ok &= ok("knowledge_graph(query) 底层", isinstance(out, str), f"len={len(out)}")
    except Exception as e:
        all_ok &= ok("knowledge_graph query", False, str(e))
        all_ok = False

    # 5. KG_MULTIHOP_MAX_DEPTH：若已设置则校验为整数且 >= 1
    depth_val = os.getenv("KG_MULTIHOP_MAX_DEPTH")
    if depth_val is not None and depth_val.strip() != "":
        try:
            d = int(depth_val.strip())
            all_ok &= ok("KG_MULTIHOP_MAX_DEPTH", d >= 1, f"value={d}")
        except ValueError:
            all_ok &= ok("KG_MULTIHOP_MAX_DEPTH", False, f"invalid: {depth_val!r}")
    else:
        all_ok &= ok("KG_MULTIHOP_MAX_DEPTH", True, "未设置，使用默认 2")

    print()
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
