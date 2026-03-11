"""
全局禁用 Skills 列表（P3 细粒度启用/禁用）

- 存储：data/skills_disabled.json，JSON 数组，每项为 "domain/name"（与 skill_registry 的 key 一致）。
- 会话级禁用：已支持，由 config.configurable.disabled_skills 注入，与全局列表合并（list_skills/match_skills 在 skills_tool 中合并过滤）。
"""

import json
import logging
from pathlib import Path
from typing import List

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parents[3]


def _disabled_path() -> Path:
    try:
        from backend.tools.base.paths import DATA_PATH
        DATA_PATH.mkdir(parents=True, exist_ok=True)
        return DATA_PATH / "skills_disabled.json"
    except ImportError:
        p = _PROJECT_ROOT / "data"
        p.mkdir(parents=True, exist_ok=True)
        return p / "skills_disabled.json"


def load_disabled_skills() -> List[str]:
    """加载全局禁用列表，返回 'domain/name' 字符串列表。"""
    path = _disabled_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return [str(x).strip() for x in data if str(x).strip()]
        return []
    except Exception as e:
        logger.debug("load_disabled_skills: %s", e)
        return []


def save_disabled_skills(keys: List[str]) -> None:
    """写入全局禁用列表；keys 为 'domain/name' 列表。"""
    path = _disabled_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    normalized = [str(k).strip() for k in (keys or []) if str(k).strip()]
    path.write_text(json.dumps(normalized, ensure_ascii=False, indent=2), encoding="utf-8")


def skill_key(domain: str, name: str) -> str:
    """与 skill_registry 一致的 skill 标识。"""
    return f"{(domain or 'general').strip()}/{(name or '').strip()}"
