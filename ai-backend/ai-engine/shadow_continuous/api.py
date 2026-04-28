"""FastAPI router for continuous shadow. Master plan §14.

Mounted alongside the shadow router in main.py.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import preference_store, watcher

logger = logging.getLogger("shadow_continuous.api")

router = APIRouter(prefix="/shadow_continuous", tags=["shadow_continuous"])


class NotifyRequest(BaseModel):
    workspace_path: str
    paths: List[str]


class OptOutRequest(BaseModel):
    workspace_path: str
    opted_out: bool


def _resolve_repo(workspace_path: str) -> Path:
    try:
        from code_intel.api import resolve_workspace_path
    except Exception:
        p = Path(workspace_path)
        if not p.exists():
            raise HTTPException(status_code=400, detail=f"unresolvable workspace_path: {workspace_path}")
        return p
    p = Path(resolve_workspace_path(workspace_path))
    if not p.exists():
        raise HTTPException(status_code=400, detail=f"unresolvable workspace_path: {workspace_path}")
    return p


@router.post("/notify")
async def notify(req: NotifyRequest) -> Dict[str, Any]:
    """File-save hook. The collab-server bridge POSTs here on each
    debounced batch of file events; the watcher's own debounce coalesces
    further before the regression replay actually runs.
    """
    repo = _resolve_repo(req.workspace_path)
    await watcher.notify_change(req.workspace_path, repo, req.paths)
    return {
        "accepted": True,
        "watching": True,
        "spent_today_usd": preference_store.spent_today(repo),
        "cap_usd": preference_store.DAILY_SPEND_CAP_USD,
    }


@router.get("/{workspace_path:path}/state")
async def state(workspace_path: str) -> Dict[str, Any]:
    repo = _resolve_repo(workspace_path)
    return {
        "workspace": workspace_path,
        "opted_out": preference_store.is_workspace_opted_out(repo),
        "spent_today_usd": preference_store.spent_today(repo),
        "cap_usd": preference_store.DAILY_SPEND_CAP_USD,
        "watcher": watcher.get_state(workspace_path),
    }


@router.post("/opt_out")
async def opt_out(req: OptOutRequest) -> Dict[str, Any]:
    repo = _resolve_repo(req.workspace_path)
    preference_store.set_workspace_opt_out(repo, bool(req.opted_out))
    return {"opted_out": preference_store.is_workspace_opted_out(repo)}
