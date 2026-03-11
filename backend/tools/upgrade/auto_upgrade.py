#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.append(str(Path(__file__).resolve().parent))
from _legacy_bridge import run_legacy


if __name__ == "__main__":
    raise SystemExit(run_legacy("auto_upgrade.py", sys.argv[1:]))
