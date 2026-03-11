#!/bin/bash
# Skills 系统校验脚本（CI 或发布前执行）
# 校验：SKILL.md 格式、profile paths 存在性、Orchestrator Skills 工具挂载

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

if [ -d "backend/.venv" ]; then
    source backend/.venv/bin/activate
fi

python -m backend.engine.skills.validate_skills
exit $?
