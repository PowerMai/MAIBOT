# Mistake Notebook JSONL Schema

每行一个 JSON 对象，建议字段如下（前 6 项为核心字段）：

```json
{
  "timestamp": "2026-02-13T10:30:00",
  "skill_name": "bidding-analysis",
  "error_type": "wrong_extraction",
  "user_correction": "评分标准不在第3章而在附件",
  "root_cause": "ontology_query 未覆盖附件结构",
  "suggested_fix": "Schema 增加 Attachment 类型",
  "citation": {
    "file": "path/to/source.md",
    "line_start": 10,
    "line_end": 15
  },
  "context_snapshot": "可选，失败现场摘要",
  "severity": "medium",
  "resolved": false
}
```

## 字段约束

- `error_type` 枚举：`wrong_extraction | missing_info | logic_error | tool_failure`
- `severity` 枚举：`low | medium | high`
- `timestamp` 使用 ISO-8601（UTC 或本地时间都可，但需一致）
- 当存在用户纠正时，`user_correction` 应尽量保留原句
- `citation`（可选）：用于 JIT 验证的精确引用。当错误与具体文件/位置相关时必填，格式为 `{ "file": str, "line_start": int, "line_end": int }`。

## 可选字段

SkillEvolutionMiddleware 额外写入以下字段，供分析脚本使用：

- `citation`: 来源引用（file + line_start + line_end），供 JIT 验证与自愈记忆使用
- `preventive_rule`: 预防性规则建议（自动生成）
- `context_snapshot`: 失败现场的最近消息摘要

## python_run 分析脚本模板

```python
import json
from pathlib import Path
from collections import Counter, defaultdict

mistakes_dir = Path("knowledge_base/learned/mistakes")
rows = []

for f in mistakes_dir.glob("*.jsonl"):
    for ln in f.read_text(encoding="utf-8").splitlines():
        ln = ln.strip()
        if not ln:
            continue
        try:
            obj = json.loads(ln)
            obj["_file"] = f.name
            rows.append(obj)
        except json.JSONDecodeError:
            pass

error_counter = Counter(r.get("error_type", "unknown") for r in rows)
skill_counter = Counter(r.get("skill_name", "unknown") for r in rows)
root_cause_counter = Counter(r.get("root_cause", "unknown") for r in rows if r.get("root_cause"))

print("=== Top error_type ===")
for k, v in error_counter.most_common(10):
    print(f"{k}: {v}")

print("\n=== Top weak skills ===")
for k, v in skill_counter.most_common(10):
    print(f"{k}: {v}")

print("\n=== Top root causes ===")
for k, v in root_cause_counter.most_common(10):
    print(f"{k}: {v}")

# 聚合改进建议（用于 growth-radar / skill-creator）
fix_by_error = defaultdict(Counter)
for r in rows:
    et = r.get("error_type", "unknown")
    fix = r.get("suggested_fix", "").strip()
    if fix:
        fix_by_error[et][fix] += 1

print("\n=== Suggested fixes by error_type ===")
for et, fixes in fix_by_error.items():
    best = fixes.most_common(3)
    print(f"[{et}]")
    for fix, cnt in best:
        print(f"  - {fix} ({cnt})")
```
