"""Snapshots accepted patches' tests so future runs catch regressions.

Wave 1: file-backed log under `{repo}/.shadow/regression_log/{ts}.json`.
Wave 4 builds on this for the pass→fail trigger in continuous shadow.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List

logger = logging.getLogger("shadow.regression_log")


def log_dir(repo: Path) -> Path:
    d = repo / ".shadow" / "regression_log"
    d.mkdir(parents=True, exist_ok=True)
    return d


def record(repo: Path, *, universe_id: str, patches: List[Dict[str, Any]], evidence: Dict[str, Any]) -> Path:
    entry = {
        "ts": time.time(),
        "universe": universe_id,
        "patches": patches,
        "evidence": evidence,
    }
    out = log_dir(repo) / f"{int(entry['ts'] * 1000)}_{universe_id}.json"
    out.write_text(json.dumps(entry, indent=2), encoding="utf-8")
    return out


def recent(repo: Path, n: int = 8) -> Iterable[Dict[str, Any]]:
    d = log_dir(repo)
    files = sorted(d.glob("*.json"))[-n:]
    for f in files:
        try:
            yield json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
