"""Per-workspace spend ledger for shadow verify jobs. Master plan §17.

Tracks `estimated_cost_usd` debits as jobs start so the chat-side cost
dashboard has authoritative numbers without needing a separate billing
pipe. The cap is advisory — runs that would exceed it still execute,
but the dashboard surfaces a warning the user can act on.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("shadow.cost_ledger")

# Default daily cap per workspace, in USD. Surfaced to the dashboard;
# the user can override per workspace via /shadow/cost/cap.
DEFAULT_DAILY_CAP_USD = 5.0
LEDGER_HISTORY_DAYS = 30


def _root(repo: Path) -> Path:
    d = repo / ".shadow" / "cost"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _ledger_file(repo: Path) -> Path:
    return _root(repo) / "ledger.json"


def _settings_file(repo: Path) -> Path:
    return _root(repo) / "settings.json"


def _read_json(p: Path, default: Any) -> Any:
    if not p.exists():
        return default
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(p: Path, data: Any) -> None:
    p.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _today() -> str:
    return date.today().isoformat()


def _prune_old(ledger: Dict[str, Any]) -> Dict[str, Any]:
    cutoff = (date.today() - timedelta(days=LEDGER_HISTORY_DAYS)).isoformat()
    return {k: v for k, v in ledger.items() if k >= cutoff}


# ---------------------------------------------------------------------------
# Cap settings
# ---------------------------------------------------------------------------

def get_daily_cap(repo: Path) -> float:
    s = _read_json(_settings_file(repo), {})
    try:
        return float(s.get("daily_cap_usd", DEFAULT_DAILY_CAP_USD))
    except (TypeError, ValueError):
        return DEFAULT_DAILY_CAP_USD


def set_daily_cap(repo: Path, usd: float) -> float:
    s = _read_json(_settings_file(repo), {})
    s["daily_cap_usd"] = max(0.0, float(usd))
    s["updated_at"] = time.time()
    _write_json(_settings_file(repo), s)
    return s["daily_cap_usd"]


# ---------------------------------------------------------------------------
# Ledger writes
# ---------------------------------------------------------------------------

def record_estimate(
    *,
    repo: Path,
    job_id: str,
    tier: str,
    user_id: Optional[str],
    estimated_usd: float,
) -> Dict[str, Any]:
    """Debit the day's bucket by `estimated_usd` when a job starts."""
    ledger = _read_json(_ledger_file(repo), {})
    ledger = _prune_old(ledger)
    today = _today()
    bucket = ledger.setdefault(today, {"total_usd": 0.0, "jobs": []})
    bucket["total_usd"] = round(float(bucket.get("total_usd", 0.0)) + float(estimated_usd), 4)
    bucket["jobs"].append({
        "job_id": job_id,
        "tier": tier,
        "user_id": user_id,
        "estimated_usd": round(float(estimated_usd), 4),
        "ts": time.time(),
        "outcome": "running",
    })
    _write_json(_ledger_file(repo), ledger)
    return bucket


def record_outcome(
    *,
    repo: Path,
    job_id: str,
    outcome: str,
    universes_cancelled: int = 0,
    refund_usd: float = 0.0,
) -> None:
    """Annotate a job's outcome and credit back any saved-by-cancel cost.

    Apply-and-cancel saves 30-60 % of compute on average (master plan
    §17 mitigation). When the orchestrator cancels pending universes,
    we estimate the compute that wasn't run and credit the bucket so
    the daily total reflects actual spend.
    """
    ledger = _read_json(_ledger_file(repo), {})
    today = _today()
    bucket = ledger.get(today)
    if not bucket:
        return
    refund = max(0.0, float(refund_usd))
    if refund:
        bucket["total_usd"] = max(0.0, round(float(bucket.get("total_usd", 0.0)) - refund, 4))
    for j in bucket.get("jobs", []):
        if j.get("job_id") == job_id:
            j["outcome"] = outcome
            j["universes_cancelled"] = int(universes_cancelled)
            if refund:
                j["refund_usd"] = round(refund, 4)
            break
    _write_json(_ledger_file(repo), ledger)


# ---------------------------------------------------------------------------
# Read API
# ---------------------------------------------------------------------------

def state(repo: Path) -> Dict[str, Any]:
    ledger = _read_json(_ledger_file(repo), {})
    today_bucket = ledger.get(_today(), {"total_usd": 0.0, "jobs": []})
    return {
        "daily_cap_usd": get_daily_cap(repo),
        "spent_today_usd": round(float(today_bucket.get("total_usd", 0.0)), 4),
        "remaining_usd": max(0.0, round(get_daily_cap(repo) - float(today_bucket.get("total_usd", 0.0)), 4)),
        "today_jobs": list(today_bucket.get("jobs", [])),
        "history": [
            {"date": k, "total_usd": round(float(v.get("total_usd", 0.0)), 4)}
            for k, v in sorted(ledger.items())
        ],
    }
