"""Orchestrator. Master plan §3 + §4.

Wave 1 decision #1: single universe, multiverse machinery designed but
not enabled. The N-universe parallel fan-out + Arbiter live behind a
Wave 2 feature flag (UNIVERSE_COUNT > 1).
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import events, snapshot
from .generator import PatchBlock
from .universe import Universe, UniverseSpec, UniverseResult
from .worktree import WorktreePool, get_pool

logger = logging.getLogger("shadow.multiverse")


# Wave 1 ships N=1. Wave 2 lifts this to 3 via tier mapping.
TIER_UNIVERSE_COUNT = {"quick": 1, "standard": 1, "deep": 1}  # Wave 2: {"quick":1,"standard":3,"deep":3}
TIER_COST_USD = {"quick": 0.001, "standard": 0.012, "deep": 0.04}


def make_job_id() -> str:
    return f"shd_{uuid.uuid4().hex[:12]}"


async def run_job(
    *,
    job: events.JobState,
    repo: Path,
    seed_patches: List[PatchBlock],
    user_request: str,
    intent: str = "fix",
) -> Optional[str]:
    """Run a complete shadow job end-to-end. Returns winning universe id."""
    tier = job.tier
    n = TIER_UNIVERSE_COUNT.get(tier, 1)

    await job.emit(events.job_started(tier=tier, universes_planned=n))

    # Snapshot
    rel_paths = [p.path for p in seed_patches]
    snap = snapshot.create(repo, rel_paths)
    job.snapshot = {"hashes": snap.hashes(), "files": rel_paths}
    await job.emit(events.snapshot_taken(rel_paths))

    pool = await get_pool(repo, size=max(2, n))

    specs = _make_specs(n, intent=intent, models=job.models or {})

    if n == 1:
        # Single-universe fast path (Wave 1 default)
        result = await _run_single(
            spec=specs[0], pool=pool, job=job,
            seed_patches=seed_patches, user_request=user_request,
        )
        winner = result.universe_id if result else None
    else:
        # Wave 2+ parallel fan-out (machinery present, gated by tier table)
        results = await asyncio.gather(*(
            _run_single(spec=s, pool=pool, job=job,
                        seed_patches=seed_patches, user_request=user_request)
            for s in specs
        ), return_exceptions=True)
        valid = [r for r in results if isinstance(r, UniverseResult)]
        winner = max(valid, key=lambda r: r.score).universe_id if valid else None

    await job.emit(events.all_done(winner=winner))
    await job.emit_done()
    return winner


async def _run_single(
    *,
    spec: UniverseSpec,
    pool: WorktreePool,
    job: events.JobState,
    seed_patches: List[PatchBlock],
    user_request: str,
) -> Optional[UniverseResult]:
    universe = Universe(spec=spec)
    started = time.time()
    try:
        async with pool.acquire() as wt:
            result = await universe.run(
                worktree=wt,
                user_request=user_request,
                seed_patches=seed_patches,
                job=job,
                dep_lock=pool.dep_lock,
            )
        result.evidence["duration_ms"] = int((time.time() - started) * 1000)
        job.universes[result.universe_id] = result.evidence
        await job.emit(events.universe_done(result.universe_id, result.evidence))
        return result
    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.exception("universe %s failed: %s", spec.universe_id, e)
        await job.emit(events.error(stage=f"universe-{spec.universe_id}", msg=str(e)))
        return None


# Provider rotation policy (master plan §6.4 Arbiter rotation).
# Wave 1 ships 1 universe so rotation is moot, but the same table is
# what Wave 2 reads to assign `(model_gen, model_critic)` per universe.
_PROVIDER_DEFAULTS = {
    "anthropic": "claude-sonnet-4-6",
    "openai":    "gpt-4o",
    "google":    "gemini-pro",
    "gemini":    "gemini-pro",
}


def _provider_chain(models: Dict[str, Any]) -> List[str]:
    """Order in which to assign generators across universes."""
    requested = (models or {}).get("providers") or []
    ordered = [p for p in requested if p in _PROVIDER_DEFAULTS]
    if not ordered:
        ordered = ["gemini"]
    return ordered


def _model_for(provider: str) -> str:
    return _PROVIDER_DEFAULTS.get(provider, "gemini-pro")


def _make_specs(n: int, *, intent: str, models: Dict[str, Any]) -> List[UniverseSpec]:
    """Wave 1 N=1 → single `safe` universe with the first available provider.

    Wave 2 N=3 → three universes spanning safe / idiomatic / minimalist
    styles, with cross-paired providers so each universe's Critic differs
    from its Generator (master plan §1).
    """
    chain = _provider_chain(models)
    user_keys = (models or {}).get("user_keys") or {}

    def _spec(uid: str, style: str, gen_idx: int) -> UniverseSpec:
        gen_provider = chain[gen_idx % len(chain)]
        crit_provider = chain[(gen_idx + 1) % len(chain)]
        return UniverseSpec(
            universe_id=uid, style=style,
            model_gen=_model_for(gen_provider),
            model_critic=_model_for(crit_provider),
            provider_gen=gen_provider,
            provider_critic=crit_provider,
            api_key_gen=user_keys.get(gen_provider),
            api_key_critic=user_keys.get(crit_provider),
            intent=intent,
        )

    pool = [
        _spec("A", "safe",       0),
        _spec("B", "idiomatic",  1),
        _spec("C", "minimalist", 2),
    ]
    return pool[:n]


# ---------------------------------------------------------------------------
# Verify-only mode (master plan §5 / Bonus §22)
# ---------------------------------------------------------------------------

async def run_verify_only(
    *,
    job: events.JobState,
    repo: Path,
    seed_patches: List[PatchBlock],
) -> None:
    """Skip Generator + Critic. Just apply the user's own edit to a worktree
    and run lint/type/tests. The patch is the user's text verbatim.
    """
    rel_paths = [p.path for p in seed_patches]
    snap = snapshot.create(repo, rel_paths)
    job.snapshot = {"hashes": snap.hashes(), "files": rel_paths}
    await job.emit(events.snapshot_taken(rel_paths))

    pool = await get_pool(repo, size=2)
    started = time.time()
    async with pool.acquire() as wt:
        for p in seed_patches:
            full = wt.path / p.path
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_text(p.new_content, encoding="utf-8")

        from .runner import detect_runner
        runner = detect_runner(wt.path, rel_paths)
        await job.emit(events.universe_progress("V", "linting"))
        run_result = await runner.run(wt.path, rel_paths)
        evidence = {
            "id": "V",
            "style": "verify-only",
            "model_pair": [None, None],
            "diagnostics": run_result.to_evidence(),
            "attacks": {"tested": 0, "survived": 0, "failed": []},
            "loc": "+0 −0",
            "score": 1.0 if run_result.diagnostics_count() == 0 else 0.0,
            "duration_ms": int((time.time() - started) * 1000),
        }
        job.universes["V"] = evidence
        await job.emit(events.universe_done("V", evidence))
    await job.emit(events.all_done(winner="V"))
    await job.emit_done()
