#!/usr/bin/env python3
"""
Helpers for release drill steps parsing.
"""

from __future__ import annotations

from typing import Any, Dict, List


def collect_required_step_failures(drill_steps: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = drill_steps.get("steps") if isinstance(drill_steps.get("steps"), list) else []
    failures: List[Dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        if not bool(row.get("required")):
            continue
        status = str(row.get("status") or "unknown").strip().lower()
        if status == "pass":
            continue
        failures.append(
            {
                "name": str(row.get("name") or "unknown"),
                "status": status or "unknown",
                "rc": row.get("rc", "n/a"),
            }
        )
    return failures

