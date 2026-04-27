"""Shadow verification HTTP endpoints. Master plan §5.

Mounted into the main FastAPI app via `app.include_router(shadow_router)`
in main.py.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import events, multiverse, snapshot
from .generator import PatchBlock
from .snapshot import ApplyResult  # noqa: F401  (re-exported for clarity)

logger = logging.getLogger("shadow.api")

router = APIRouter(prefix="/shadow", tags=["shadow"])


# ---------------------------------------------------------------------------
# Request / response schemas (master plan §5)
# ---------------------------------------------------------------------------

class PatchSearchReplace(BaseModel):
    search: str
    replace: str


class PatchModel(BaseModel):
    path: str
    blocks: Optional[List[PatchSearchReplace]] = None
    new_content: Optional[str] = None  # alternative to blocks


class ShadowRunRequest(BaseModel):
    workspace_path: str
    conversation_id: Optional[str] = None
    intent: Literal["fix", "implement", "refactor", "explain"] = "fix"
    user_request: str = ""
    patches: List[PatchModel]
    tier: Literal["quick", "standard", "deep"] = "standard"
    user_id: Optional[str] = None
    models: Optional[Dict[str, Any]] = None  # providers + user_keys (Wave 2+)


class ShadowVerifyOnlyRequest(BaseModel):
    workspace_path: str
    patches: List[PatchModel]
    tier: Literal["quick", "standard"] = "quick"
    user_id: Optional[str] = None


class ShadowApplyRequest(BaseModel):
    universeId: str


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/run")
async def shadow_run(req: ShadowRunRequest, background: BackgroundTasks) -> Dict[str, Any]:
    repo = _resolve_repo(req.workspace_path)
    job_id = multiverse.make_job_id()
    cost_usd = multiverse.estimate_cost_for_request(req.tier, req.models)
    job = events.JobState(
        job_id=job_id,
        tier=req.tier,
        workspace_path=req.workspace_path,
        user_id=req.user_id,
        estimated_cost_usd=cost_usd,
    )
    job.models = req.models or {}  # surfaced to Universe via run_job
    events.register(job)

    seed = _resolve_patches(repo, req.patches)

    background.add_task(_run_safe, job=job, repo=repo, seed_patches=seed,
                       user_request=req.user_request, intent=req.intent)

    return {
        "jobId": job_id,
        "tier": req.tier,
        "estimated_cost_usd": job.estimated_cost_usd,
    }


@router.post("/verify-only")
async def shadow_verify_only(req: ShadowVerifyOnlyRequest, background: BackgroundTasks) -> Dict[str, Any]:
    repo = _resolve_repo(req.workspace_path)
    job_id = multiverse.make_job_id()
    job = events.JobState(
        job_id=job_id,
        tier=req.tier,
        workspace_path=req.workspace_path,
        user_id=req.user_id,
    )
    events.register(job)

    seed = _resolve_patches(repo, req.patches)
    background.add_task(_run_verify_safe, job=job, repo=repo, seed_patches=seed)
    return {"jobId": job_id, "tier": req.tier, "estimated_cost_usd": 0.0}


@router.get("/{job_id}/stream")
async def shadow_stream(job_id: str) -> StreamingResponse:
    job = events.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown job {job_id}")

    async def gen():
        # Replay summary of state already collected (so reconnects work).
        if job.snapshot:
            yield events.encode_sse({"type": "snapshot_taken", "files": job.snapshot.get("files", [])})
        for uid, ev in job.universes.items():
            yield events.encode_sse({"type": "universe_done", **ev})
        # Live drain
        while True:
            try:
                evt = await asyncio.wait_for(job.queue.get(), timeout=30.0)
            except asyncio.TimeoutError:
                yield b": keepalive\n\n"
                if job.finished:
                    break
                continue
            if evt.get("type") == "_eof":
                break
            yield events.encode_sse(evt)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/{job_id}/apply")
async def shadow_apply(job_id: str, req: ShadowApplyRequest) -> Dict[str, Any]:
    job = events.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown job {job_id}")
    evidence = job.universes.get(req.universeId)
    if not evidence:
        raise HTTPException(status_code=404, detail=f"universe {req.universeId} not done")
    patches = job.universe_patches.get(req.universeId)
    if not patches:
        raise HTTPException(status_code=409, detail=f"universe {req.universeId} has no stored patches")

    repo = _resolve_repo(job.workspace_path)
    snap = job.snapshot_obj
    if snap is None:
        # Reconstruct a snapshot if one wasn't kept in memory (e.g. server
        # restart between job_started and apply). Falls back to "everything
        # is direct" because we have no base content to feed `git merge-file`.
        from . import snapshot as _snap
        rel_paths = [p["path"] for p in patches]
        snap = _snap.create(repo, rel_paths)

    # Pick the AI-rebase provider used by the universe so the rebase model
    # matches the model that produced the patch (per master plan §8.3).
    user_keys = (job.models or {}).get("user_keys") or {}
    provider_name = "gemini"
    api_key: Optional[str] = None
    spec_pair = (job.universes.get(req.universeId, {}) or {}).get("model_pair") or [None, None]
    # Heuristic: derive provider from the gen model string.
    if isinstance(spec_pair[0], str):
        m = spec_pair[0].lower()
        if "claude" in m:
            provider_name = "anthropic"
        elif "gpt" in m or "o1" in m or "openai" in m:
            provider_name = "openai"
    api_key = user_keys.get(provider_name)

    async def _ai_rebase(*, base, ours, theirs, path):
        return await snapshot.ai_rebase_with(
            provider_name=provider_name, api_key=api_key,
            base=base, ours=ours, theirs=theirs, path=path,
        )

    results: List[snapshot.ApplyResult] = []
    for p in patches:
        rel = p["path"]
        new_content = p["new_content"]
        results.append(await snapshot.apply_one(
            repo, snap, rel, new_content, ai_rebase=_ai_rebase,
        ))

    # Decide overall merge_strategy = "worst" strategy seen across files.
    # Severity: direct < 3way < ai-rebase < conflict
    rank = {"direct": 0, "3way": 1, "ai-rebase": 2, "conflict": 3}
    overall = max((r.strategy for r in results), key=lambda s: rank.get(s, 99), default="direct")

    # Write applied files back to the repo (skip on conflict — caller can
    # inspect `files_failed` and decide whether to force-apply or re-verify).
    written: List[str] = []
    failed: List[Dict[str, str]] = []
    for r in results:
        if r.strategy == "conflict" or r.new_content is None:
            failed.append({"path": r.path, "reason": r.note or "merge conflict"})
            continue
        full = repo / r.path
        full.parent.mkdir(parents=True, exist_ok=True)
        try:
            full.write_text(r.new_content, encoding="utf-8")
        except OSError as e:
            failed.append({"path": r.path, "reason": f"write failed: {e}"})
            continue
        written.append(r.path)

    return {
        "applied": not failed,
        "files": written,
        "files_failed": failed,
        "merge_strategy": overall,
        "per_file": [
            {"path": r.path, "strategy": r.strategy, "note": r.note}
            for r in results
        ],
    }


@router.post("/{job_id}/cancel")
async def shadow_cancel(job_id: str) -> Dict[str, Any]:
    job = events.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown job {job_id}")
    job.cancelled = True
    await job.emit(events.error(stage="cancel", msg="cancelled by user"))
    await job.emit_done()
    return {"cancelled": True}


# ---------------------------------------------------------------------------
# Background runners with graceful error capture
# ---------------------------------------------------------------------------

async def _run_safe(*, job, repo, seed_patches, user_request, intent):
    try:
        await multiverse.run_job(
            job=job, repo=repo, seed_patches=seed_patches,
            user_request=user_request, intent=intent,
        )
    except Exception as e:
        logger.exception("shadow job failed: %s", e)
        await job.emit(events.error(stage="job", msg=str(e)))
        await job.emit_done()


async def _run_verify_safe(*, job, repo, seed_patches):
    try:
        await multiverse.run_verify_only(job=job, repo=repo, seed_patches=seed_patches)
    except Exception as e:
        logger.exception("verify-only job failed: %s", e)
        await job.emit(events.error(stage="verify-only", msg=str(e)))
        await job.emit_done()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _resolve_repo(workspace_path: str) -> Path:
    """Reuse code_intel's resolver so the worktree pool sits next to the same
    repos directory the rest of the system already uses."""
    try:
        from code_intel.api import resolve_workspace_path
    except Exception:
        # Defensive — if code_intel isn't loaded, fall back to literal path.
        p = Path(workspace_path)
        if not p.exists():
            raise HTTPException(status_code=400, detail=f"unresolvable workspace_path: {workspace_path}")
        return p
    resolved = resolve_workspace_path(workspace_path)
    p = Path(resolved)
    if not p.exists():
        raise HTTPException(status_code=400, detail=f"unresolvable workspace_path: {workspace_path}")
    return p


def _resolve_patches(repo: Path, patches: List[PatchModel]) -> List[PatchBlock]:
    """Convert the wire-format patches into PatchBlock(new_content) by reading
    the current file content and applying any search/replace blocks.

    Wave 1 is intentionally simple — Wave 2 will accept structured AST patches.
    """
    blocks: List[PatchBlock] = []
    for p in patches:
        full = repo / p.path
        try:
            original = full.read_text(encoding="utf-8")
        except FileNotFoundError:
            original = ""
        new_content: str
        if p.new_content is not None:
            new_content = p.new_content
        elif p.blocks:
            new_content = original
            for b in p.blocks:
                if b.search and b.search in new_content:
                    new_content = new_content.replace(b.search, b.replace, 1)
                else:
                    # Block didn't apply — surface as a no-op for now; the runner
                    # will catch any resulting mismatch.
                    logger.warning("search-block did not match in %s", p.path)
        else:
            new_content = original
        blocks.append(PatchBlock(path=p.path, original=original, new_content=new_content))
    return blocks
