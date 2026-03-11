"""
RAG 检索链路最小回归基准（50+ 查询）。

对比两种模式：
1) baseline: 强制禁用 rerank（RERANK_FORCE_DISABLE=true）
2) enhanced: 启用 rerank（若模型可用）
"""

from __future__ import annotations

import os
import re
import time
import json
import random
import sys
from pathlib import Path
from statistics import mean
from typing import List, Dict, Any


PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
KB_ROOT = PROJECT_ROOT / "knowledge_base" / "global" / "domain"
REPORT_PATH = PROJECT_ROOT / "outputs" / "reports" / "rag-benchmark-report.md"


def _collect_queries(limit: int = 50) -> List[str]:
    candidates: List[str] = []
    files = list(KB_ROOT.rglob("*.md")) + list(KB_ROOT.rglob("*.txt"))
    for fp in files:
        try:
            text = fp.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        # 标题优先
        for m in re.findall(r"^#{1,6}\s+(.+)$", text, flags=re.MULTILINE):
            s = re.sub(r"\s+", " ", m).strip()
            if 2 <= len(s) <= 50:
                candidates.append(s)
        # 关键词补充（中英文）
        candidates.extend(re.findall(r"[\u4e00-\u9fff]{2,8}", text))
        candidates.extend(re.findall(r"[A-Za-z][A-Za-z0-9_-]{3,24}", text))

    uniq: List[str] = []
    seen = set()
    for c in candidates:
        c = c.strip()
        if not c or c in seen:
            continue
        seen.add(c)
        uniq.append(c)
    random.seed(42)
    random.shuffle(uniq)
    return uniq[: max(50, limit)]


def _run_once(queries: List[str], force_disable: bool) -> Dict[str, Any]:
    from backend.tools.base.embedding_tools import get_knowledge_retriever_tool

    os.environ["RERANK_FORCE_DISABLE"] = "true" if force_disable else "false"
    tool = get_knowledge_retriever_tool()
    if tool is None:
        return {
            "ok": False,
            "error": "search_knowledge tool unavailable",
            "total": len(queries),
        }

    latencies: List[float] = []
    hit = 0
    citations = 0
    rerank_enabled = 0
    rerank_degraded = 0
    error_count = 0
    samples: List[Dict[str, str]] = []

    for idx, q in enumerate(queries):
        t0 = time.perf_counter()
        try:
            out = str(tool.invoke(q))
        except Exception as e:
            error_count += 1
            out = f"ERROR: {type(e).__name__}: {e}"
        dt = time.perf_counter() - t0
        latencies.append(dt)
        if (
            not out.startswith("ERROR:")
            and ("未找到相关内容" not in out)
            and ("向量存储不可用" not in out)
        ):
            hit += 1
        citations += out.count("来源: vector_search")
        if "重排: 已启用(" in out:
            rerank_enabled += 1
        elif "重排: 已降级(" in out:
            rerank_degraded += 1
        if idx < 3:
            samples.append({"query": q, "preview": out[:280].replace("\n", " ")})

    return {
        "ok": True,
        "total": len(queries),
        "hit_rate": round(hit / max(1, len(queries)), 4),
        "avg_latency_s": round(mean(latencies) if latencies else 0.0, 4),
        "avg_citations": round(citations / max(1, len(queries)), 4),
        "rerank_enabled_count": rerank_enabled,
        "rerank_degraded_count": rerank_degraded,
        "error_count": error_count,
        "samples": samples,
    }


def main() -> int:
    queries = _collect_queries(limit=50)
    baseline = _run_once(queries, force_disable=True)
    enhanced = _run_once(queries, force_disable=False)

    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {"query_count": len(queries), "baseline": baseline, "enhanced": enhanced}

    verdict = "PASS"
    if baseline.get("ok") and enhanced.get("ok"):
        # 最小门槛：命中率不下降且平均引用数不下降
        if (
            baseline.get("error_count", 0) > 0
            or enhanced.get("error_count", 0) > 0
            or enhanced["hit_rate"] < baseline["hit_rate"]
            or enhanced["avg_citations"] < baseline["avg_citations"]
        ):
            verdict = "WARN"
    else:
        verdict = "WARN"

    md = [
        "# RAG 检索回归对比报告",
        "",
        f"- 查询集规模: `{len(queries)}`",
        f"- 验收结论: `{verdict}`",
        "",
        "## Baseline（禁用 rerank）",
        f"- hit_rate: `{baseline.get('hit_rate')}`",
        f"- avg_latency_s: `{baseline.get('avg_latency_s')}`",
        f"- avg_citations: `{baseline.get('avg_citations')}`",
        "",
        "## Enhanced（启用 rerank）",
        f"- hit_rate: `{enhanced.get('hit_rate')}`",
        f"- avg_latency_s: `{enhanced.get('avg_latency_s')}`",
        f"- avg_citations: `{enhanced.get('avg_citations')}`",
        f"- rerank_enabled_count: `{enhanced.get('rerank_enabled_count')}`",
        f"- rerank_degraded_count: `{enhanced.get('rerank_degraded_count')}`",
        "",
        "## 样例预览（Enhanced）",
    ]
    for s in enhanced.get("samples", []):
        md.append(f"- `{s['query']}`: {s['preview']}")
    md.append("")
    md.append("## 原始 JSON")
    md.append("```json")
    md.append(json.dumps(payload, ensure_ascii=False, indent=2))
    md.append("```")
    REPORT_PATH.write_text("\n".join(md), encoding="utf-8")
    print(f"report_written={REPORT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

