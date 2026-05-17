"""Workspace-level continuous-shadow settings + spend tracking.

Master plan §14 + §17:
  - Hard daily cap $0.50/workspace.
  - Opt-out per workspace.
  - Cheapest models only when surfacing fix offers.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from datetime import date
from pathlib import Path
from typing import Any, Dict, Optional

DAILY_SPEND_CAP_USD = 0.50


def _root(repo: Path) -> Path:
    in_repo = repo / ".shadow" / "continuous"
    try:
        in_repo.mkdir(parents=True, exist_ok=True)
        return in_repo
    except OSError:
        base = os.environ.get("SHADOW_STATE_DIR") or os.path.join(tempfile.gettempdir(), "synthi-shadow")
        key = hashlib.sha1(str(repo).encode("utf-8")).hexdigest()[:16]
        d = Path(base) / key / "continuous"
        d.mkdir(parents=True, exist_ok=True)
        return d


def _settings_file(repo: Path) -> Path:
    return _root(repo) / "settings.json"


def _spend_file(repo: Path) -> Path:
    return _root(repo) / "spend.json"


def _read_json(p: Path, default: Any) -> Any:
    if not p.exists():
        return default
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(p: Path, data: Any) -> None:
    p.write_text(json.dumps(data, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# Opt-out
# ---------------------------------------------------------------------------

def is_workspace_opted_out(repo: Path) -> bool:
    s = _read_json(_settings_file(repo), {})
    return bool(s.get("opted_out", False))


def set_workspace_opt_out(repo: Path, value: bool) -> None:
    s = _read_json(_settings_file(repo), {})
    s["opted_out"] = bool(value)
    s["updated_at"] = time.time()
    _write_json(_settings_file(repo), s)


# ---------------------------------------------------------------------------
# Daily spend ledger
# ---------------------------------------------------------------------------

def _today_key() -> str:
    return date.today().isoformat()


def daily_spend(repo: Path) -> Dict[str, float]:
    return _read_json(_spend_file(repo), {})


def spent_today(repo: Path) -> float:
    return float(daily_spend(repo).get(_today_key(), 0.0))


def add_spend(repo: Path, usd: float) -> float:
    """Add a delta to today's bucket and return the new total. Old days
    are pruned lazily (nothing to clean — file just keeps growing in
    practice, but stays tiny since each entry is a single float)."""
    if usd <= 0:
        return spent_today(repo)
    ledger = daily_spend(repo)
    key = _today_key()
    ledger[key] = float(ledger.get(key, 0.0)) + float(usd)
    _write_json(_spend_file(repo), ledger)
    return ledger[key]


def can_spend(repo: Path, *, est_usd: float = 0.0) -> bool:
    if is_workspace_opted_out(repo):
        return False
    return spent_today(repo) + max(0.0, est_usd) <= DAILY_SPEND_CAP_USD
