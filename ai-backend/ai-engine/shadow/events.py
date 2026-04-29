"""SSE event types streamed on /shadow/{jobId}/stream.

Per master plan §5. Producers append events to a job's queue; the SSE
endpoint drains the queue and re-encodes as text/event-stream frames.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


# ---------------------------------------------------------------------------
# Event factories
# ---------------------------------------------------------------------------

def job_started(tier: str, universes_planned: int) -> Dict[str, Any]:
    return {"type": "job_started", "tier": tier, "universes_planned": universes_planned}


def snapshot_taken(files: List[str]) -> Dict[str, Any]:
    return {"type": "snapshot_taken", "files": files}


def universe_started(uid: str, model_gen: str, model_critic: str, style: str) -> Dict[str, Any]:
    return {
        "type": "universe_started",
        "id": uid,
        "model_gen": model_gen,
        "model_critic": model_critic,
        "style": style,
    }


def universe_progress(uid: str, stage: str, detail: Optional[str] = None) -> Dict[str, Any]:
    evt = {"type": "universe_progress", "id": uid, "stage": stage}
    if detail is not None:
        evt["detail"] = detail
    return evt


def universe_done(uid: str, evidence: Dict[str, Any]) -> Dict[str, Any]:
    return {"type": "universe_done", "id": uid, **evidence}


def staleness_detected(files: List[str]) -> Dict[str, Any]:
    return {"type": "staleness_detected", "files": files}


def convergence_detected(downgrading_to: int) -> Dict[str, Any]:
    # Wave 2+ — emitted by orchestrator when running >1 universe converges.
    return {"type": "convergence_detected", "downgrading_to": downgrading_to}


def arbiter_verdict(payload: Dict[str, Any]) -> Dict[str, Any]:
    # Wave 2+
    return {"type": "arbiter_verdict", **payload}


def all_done(winner: Optional[str]) -> Dict[str, Any]:
    return {"type": "all_done", "winner": winner}


def error(stage: str, msg: str) -> Dict[str, Any]:
    return {"type": "error", "stage": stage, "msg": msg}


# ---------------------------------------------------------------------------
# Job state — in-memory registry
# ---------------------------------------------------------------------------

@dataclass
class JobState:
    job_id: str
    tier: str
    workspace_path: str
    user_id: Optional[str]
    created_at: float = field(default_factory=time.time)
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    universes: Dict[str, Dict[str, Any]] = field(default_factory=dict)  # id -> evidence bundle
    universe_patches: Dict[str, List[Dict[str, str]]] = field(default_factory=dict)  # id -> [{path, new_content}, ...]
    snapshot: Optional[Dict[str, Any]] = None  # filled by snapshot.create()
    snapshot_obj: Optional[Any] = None  # full Snapshot for /apply ladder (kept in memory for the run)
    # In-flight asyncio tasks per universe id, populated by multiverse.run_job
    # for the N>1 fan-out path. Used by /cancel and /apply to actually kill
    # pending universes mid-flight (master plan §16 mitigations #4 + #5).
    tasks: Dict[str, Any] = field(default_factory=dict)
    finished: bool = False
    cancelled: bool = False
    estimated_cost_usd: float = 0.0
    # Wave 2: { "providers": ["anthropic","openai","google"], "user_keys": {"anthropic":"...","openai":"..."} }
    models: Dict[str, Any] = field(default_factory=dict)
    # Cached evidence bundle + last verdict + universe results for the
    # [Why?] follow-up endpoint (master plan §22). Kept in-memory for the
    # lifetime of the job; cleared on `discard`.
    bundle: Optional[Dict[str, Any]] = None
    last_verdict: Optional[Dict[str, Any]] = None
    universe_results: List[Any] = field(default_factory=list)
    user_request: str = ""
    intent: str = "fix"
    arbiter_provider: Optional[str] = None
    arbiter_model: Optional[str] = None

    async def emit(self, evt: Dict[str, Any]) -> None:
        await self.queue.put(evt)

    async def emit_done(self) -> None:
        self.finished = True
        await self.queue.put({"type": "_eof"})  # sentinel for SSE drainer


_JOBS: Dict[str, JobState] = {}


def register(job: JobState) -> None:
    _JOBS[job.job_id] = job


def get(job_id: str) -> Optional[JobState]:
    return _JOBS.get(job_id)


def discard(job_id: str) -> None:
    _JOBS.pop(job_id, None)


def encode_sse(evt: Dict[str, Any]) -> bytes:
    """Encode a single event as an SSE frame."""
    return f"data: {json.dumps(evt, separators=(',', ':'))}\n\n".encode("utf-8")
