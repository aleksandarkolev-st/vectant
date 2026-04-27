"""Pass→fail regression runner for continuous shadow. Master plan §14.

Given a set of changed file paths, identify the regression-log entries
that *touch* those paths and replay their tests in a worktree from the
shadow pool. Emit a "previously passing test now failing" suggestion
only on a transition (pass→fail), never on idle pings.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from shadow import regression_log
from shadow.runner import detect_runner
from shadow.worktree import get_pool

logger = logging.getLogger("shadow_continuous.regression_runner")


@dataclass
class RegressionFinding:
    file: str
    test: str
    note: str
    universe_id: Optional[str] = None
    ts: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": "regression_finding",
            "file": self.file,
            "test": self.test,
            "note": self.note,
            "universe_id": self.universe_id,
            "ts": self.ts,
        }


async def replay_for_changes(
    *,
    repo: Path,
    changed_paths: List[str],
    n_recent: int = 16,
) -> List[RegressionFinding]:
    """Replay the most recent regression-log entries that touched any
    of `changed_paths`. Returns the list of pass→fail transitions found.

    Cheap path: zero log entries → zero work. Anything more, we acquire
    one worktree, run lint/test on the changed files only, and report
    fail-now-but-passed-then.
    """
    if not changed_paths:
        return []

    log_entries = list(regression_log.recent(repo, n=n_recent))
    if not log_entries:
        return []

    # Find log entries whose accepted patches touched any of the changed files.
    # We keep this conservative — if there's *any* path overlap, we replay.
    relevant: List[Dict[str, Any]] = []
    changed_set = set(_normalize(p) for p in changed_paths)
    for entry in log_entries:
        ent_paths = {
            _normalize(p.get("path", ""))
            for p in (entry.get("patches") or [])
            if isinstance(p, dict)
        }
        if changed_set & ent_paths:
            relevant.append(entry)

    if not relevant:
        return []

    findings: List[RegressionFinding] = []
    pool = await get_pool(repo, size=1)
    async with pool.acquire() as wt:
        # Materialize the changed files into the worktree at HEAD already
        # (acquire scrubs the worktree); user edits live in the live repo
        # so we copy them across to keep the test target current.
        for rel in changed_paths:
            src = repo / rel
            if not src.exists():
                continue
            dst = wt.path / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            try:
                dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
            except Exception:
                logger.debug("failed to mirror %s into worktree", rel, exc_info=True)

        runner = detect_runner(wt.path, list(changed_paths))
        run_result = await runner.run(wt.path, list(changed_paths))

        # Pass→fail trigger: previously the universe's tests were green
        # (regression_log entries only get recorded on a clean apply),
        # so any failing test now is the transition we want.
        tests_summary = run_result.tests[0] if run_result.tests else {}
        passed = int(tests_summary.get("passed", 0)) if isinstance(tests_summary, dict) else 0
        total = int(tests_summary.get("total", 0)) if isinstance(tests_summary, dict) else 0
        if total > 0 and passed < total:
            for rel in changed_paths:
                # Take the most recent regression-log entry that touched
                # this file as the credit-tag for the suggestion.
                tag = next(
                    (e for e in reversed(relevant)
                     if rel in {_normalize(p.get("path", ""))
                                for p in (e.get("patches") or [])}),
                    None,
                )
                findings.append(RegressionFinding(
                    file=rel,
                    test=f"{passed}/{total} passed",
                    note="previously-passing test now failing",
                    universe_id=(tag or {}).get("universe"),
                ))
    return findings


def _normalize(p: str) -> str:
    return (p or "").replace("\\", "/").lstrip("./")
