#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-quick}"

if [[ "$MODE" != "quick" && "$MODE" != "full" ]]; then
  echo "用法: backend/scripts/run_regression.sh [quick|full]"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PYTHON_BIN="$ROOT_DIR/backend/.venv/bin/python"
SCRIPT="$ROOT_DIR/backend/scripts/test_system_improvements.py"

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "未找到 Python 虚拟环境: $PYTHON_BIN"
  exit 1
fi

exec "$PYTHON_BIN" "$SCRIPT" --mode "$MODE"
