"""Workspace-level debouncer + scheduler for continuous shadow.

Master plan §14:
  - Debounce 800ms per workspace.
  - Identify affected modules from the change set.
  - Replay regression-log tests for those modules.
  - Surface pass→fail transitions only.

Producers (collab-server WebSocket bridge, IDE save hook, …) call
`notify_change(workspace, paths)` and the watcher coalesces bursts into
a single regression replay per workspace.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional, Set

from . import preference_store
from .regression_runner import RegressionFinding, replay_for_changes

logger = logging.getLogger("shadow_continuous.watcher")

DEBOUNCE_SEC = 0.8

FindingsHandler = Callable[[str, List[RegressionFinding]], Awaitable[None]]


@dataclass
class _WatcherState:
    pending_paths: Set[str] = field(default_factory=set)
    fire_at: float = 0.0
    task: Optional[asyncio.Task] = None
    last_findings: List[RegressionFinding] = field(default_factory=list)
    last_run_at: float = 0.0


_STATES: Dict[str, _WatcherState] = {}
_HANDLER: Optional[FindingsHandler] = None
_LOCK = asyncio.Lock()


def set_findings_handler(handler: Optional[FindingsHandler]) -> None:
    """Register a coroutine that will be awaited with (workspace_id,
    findings) whenever the regression replay yields one or more
    pass→fail transitions. Producers (the chat suggestion surface) wire
    this up at app startup.
    """
    global _HANDLER
    _HANDLER = handler


def get_state(workspace_id: str) -> Dict[str, Any]:
    """Return a serializable snapshot of the watcher state for a
    workspace. Useful for the cost dashboard + debugging.
    """
    s = _STATES.get(workspace_id)
    if s is None:
        return {"watching": False, "pending": [], "last_findings": []}
    return {
        "watching": True,
        "pending": sorted(s.pending_paths),
        "fires_in_ms": max(0, int((s.fire_at - time.time()) * 1000)) if s.fire_at else 0,
        "last_findings": [f.to_dict() for f in s.last_findings],
        "last_run_at": s.last_run_at,
    }


async def notify_change(workspace_id: str, repo: Path, paths: List[str]) -> None:
    """Producer entry. Coalesces a burst of file-change events into a
    single regression replay per workspace, debounced 800ms.

    No-ops when the workspace opted out or hit the daily $0.50 cap.
    """
    if preference_store.is_workspace_opted_out(repo):
        return
    if not preference_store.can_spend(repo):
        return

    paths = [p for p in paths if p]
    if not paths:
        return

    async with _LOCK:
        s = _STATES.setdefault(workspace_id, _WatcherState())
        s.pending_paths.update(paths)
        s.fire_at = time.time() + DEBOUNCE_SEC
        if s.task is None or s.task.done():
            s.task = asyncio.create_task(_debounced_run(workspace_id, repo))


async def _debounced_run(workspace_id: str, repo: Path) -> None:
    """Sleep until fire_at; if fire_at has been pushed back during the
    sleep, sleep again. Then drain pending paths and run the regression
    replay. Repeated bursts collapse into one job.
    """
    while True:
        async with _LOCK:
            s = _STATES.get(workspace_id)
            if s is None:
                return
            now = time.time()
            wait = s.fire_at - now
        if wait > 0:
            await asyncio.sleep(wait)
            continue
        async with _LOCK:
            s = _STATES.get(workspace_id)
            if s is None:
                return
            paths = sorted(s.pending_paths)
            s.pending_paths.clear()
            s.fire_at = 0.0
        if not paths:
            return
        try:
            findings = await replay_for_changes(repo=repo, changed_paths=paths)
        except Exception:
            logger.exception("continuous regression replay failed")
            findings = []
        async with _LOCK:
            s = _STATES.get(workspace_id)
            if s is None:
                return
            s.last_findings = findings
            s.last_run_at = time.time()
            still_pending = bool(s.pending_paths)
        if findings and _HANDLER is not None:
            try:
                await _HANDLER(workspace_id, findings)
            except Exception:
                logger.exception("findings handler raised")
        if not still_pending:
            return
        # Else loop and respect the new fire_at.
