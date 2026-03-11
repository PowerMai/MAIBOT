#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$PROJECT_ROOT/logs/perf-baseline"
TS="$(date +%Y%m%d_%H%M%S)"
OUT_FILE="$OUT_DIR/baseline_${TS}.md"
BACKEND_URL="${BACKEND_URL:-${LANGGRAPH_API_URL:-http://localhost:2024}}"

mkdir -p "$OUT_DIR"

{
  echo "# Performance Baseline"
  echo ""
  echo "- timestamp: $TS"
  echo "- project_root: $PROJECT_ROOT"
  echo "- backend_url: $BACKEND_URL"
  echo ""
  echo "## Service Health"
  echo ""
  echo "### /health"
  curl -sS "$BACKEND_URL/health" || echo "unavailable"
  echo ""
  echo ""
  echo "### /memory/health"
  curl -sS "$BACKEND_URL/memory/health" || echo "unavailable"
  echo ""
  echo ""
  echo "### /memory/stats"
  curl -sS "$BACKEND_URL/memory/stats" || echo "unavailable"
  echo ""
  echo ""
  echo "## Context Stats"
  echo ""
  curl -sS "$BACKEND_URL/context/stats" || echo "unavailable"
  echo ""
  echo ""
  echo "## Disk Usage"
  echo ""
  du -sh "$PROJECT_ROOT/logs" "$PROJECT_ROOT/data" "$PROJECT_ROOT/backend/.venv" "$PROJECT_ROOT/frontend/desktop/node_modules" 2>/dev/null || true
  echo ""
  df -h "$PROJECT_ROOT" | tail -1
  echo ""
  echo "## Top Snapshot"
  echo ""
  top -l 1 -n 0 | sed -n '1,18p'
} > "$OUT_FILE"

echo "baseline written: $OUT_FILE"
