"""Orchestrator. Master plan §3 + §4.

Wave 1 ran a single universe. Wave 2 lifts the count, fans out in
parallel, watches for convergence after each universe finishes, and
calls the Arbiter once the cohort is settled (or skipped on consensus).
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import events, snapshot
from .arbiter import (
    Verdict,
    adjudicate,
    build_evidence_bundle,
    model_for_arbiter,
    select_arbiter_provider,
)
from .convergence import detect_convergence
from .generator import PatchBlock
from .project_signals import ProjectSignals, detect as detect_signals
from .universe import Universe, UniverseSpec, UniverseResult
from .worktree import WorktreePool, get_pool

logger = logging.getLogger("shadow.multiverse")


# Wave 2 tier mapping. `quick` stays at N=1 — we want sub-4s latency for
# small fixes. `standard` and `deep` fan out to 3 universes so the
# cross-paired specs in `_make_specs` actually get exercised.
TIER_UNIVERSE_COUNT = {"quick": 1, "standard": 3, "deep": 3}

# Per-provider rate card — rough $-per-call estimates (Apr 2026). Used
# to compute `estimated_cost_usd` from the actual (gen, critic) tuples
# in the run, instead of the flat-tier fallback below.
#
# Numbers are conservative output-side averages — input tokens vary too
# much across patches to bake in. The harness's cost-tracking metric
# refines these from real billing data; until then they're starting
# values and the per-tier envelopes act as a ceiling.
_PROVIDER_RATE_USD = {
    # provider → { gen_call, critic_call, arbiter_call, critic_critic_call, revise_call }
    "anthropic": {"gen": 0.018, "critic": 0.012, "arbiter": 0.020,
                  "critic_critic": 0.0008, "revise": 0.012},
    "openai":    {"gen": 0.015, "critic": 0.010, "arbiter": 0.018,
                  "critic_critic": 0.0006, "revise": 0.010},
    "gemini":    {"gen": 0.0035, "critic": 0.0025, "arbiter": 0.0040,
                  "critic_critic": 0.0002, "revise": 0.0025},
}

# Per-tier ceiling — master plan §1 contract. estimated_cost_usd is the
# *minimum* of (rate-card estimate, tier envelope) so the user-visible
# number never blows past the contracted budget.
TIER_COST_USD = {"quick": 0.001, "standard": 0.012, "deep": 0.04}


def make_job_id() -> str:
    return f"shd_{uuid.uuid4().hex[:12]}"


def estimate_cost_for_request(tier: str, models: Optional[Dict[str, Any]] = None) -> float:
    """Public wrapper used by the /shadow/run handler to populate the
    response's `estimated_cost_usd` before the job actually runs.
    """
    n = TIER_UNIVERSE_COUNT.get(tier, 1)
    specs = _make_specs(n, intent="fix", models=models or {})
    return estimate_cost(specs, tier)


def estimate_cost(specs: List[UniverseSpec], tier: str) -> float:
    """Sum the rate-card cost across all universes + Arbiter, then floor
    against the tier ceiling. Per master plan §10 the ceiling wins so
    we never advertise a higher number than the contracted envelope.

    Each universe pays for: 1 gen call + 1 critic call + (~5 small
    critic-critic calls — folded into a flat 1× rate) + a possible
    revise pass (priced at 50% probability). The Arbiter is paid once
    per job at its provider's rate.
    """
    total = 0.0
    for spec in specs:
        gen_card = _PROVIDER_RATE_USD.get(spec.provider_gen, _PROVIDER_RATE_USD["gemini"])
        crit_card = _PROVIDER_RATE_USD.get(spec.provider_critic, _PROVIDER_RATE_USD["gemini"])
        total += gen_card["gen"]
        total += crit_card["critic"]
        total += crit_card["critic_critic"]
        total += 0.5 * gen_card["revise"]
    # Arbiter call — only for N>1 runs.
    if len(specs) > 1:
        arb = select_arbiter_provider(specs)
        total += _PROVIDER_RATE_USD.get(arb, _PROVIDER_RATE_USD["gemini"])["arbiter"]
    ceiling = TIER_COST_USD.get(tier, TIER_COST_USD["standard"])
    return round(min(total, ceiling), 4)


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
    job.snapshot_obj = snap
    await job.emit(events.snapshot_taken(rel_paths))

    pool = await get_pool(repo, size=max(2, n))

    specs = _make_specs(n, intent=intent, models=job.models or {})
    job.estimated_cost_usd = estimate_cost(specs, tier)

    # Detect project signals once on the seed worktree. Cheap (best-effort
    # walk capped at 4k files); shared across all universes for
    # critic-critic and arbiter calibration.
    signals = await asyncio.to_thread(detect_signals, repo)

    if n == 1:
        # Single-universe fast path (quick tier).
        result = await _run_single(
            spec=specs[0], pool=pool, job=job,
            seed_patches=seed_patches, user_request=user_request,
            signals=signals,
        )
        winner = result.universe_id if result else None
        await job.emit(events.all_done(winner=winner))
        await job.emit_done()
        return winner

    # Wave 2 parallel fan-out with convergence-based early termination.
    completed, cancelled_ids = await _run_with_convergence(
        specs=specs, pool=pool, job=job,
        seed_patches=seed_patches, user_request=user_request,
        signals=signals,
    )

    valid = [r for r in completed if isinstance(r, UniverseResult)]
    if not valid:
        await job.emit(events.all_done(winner=None))
        await job.emit_done()
        return None

    # Convergence pass on completed-and-not-cancelled cohort.
    convergence = detect_convergence(valid)
    if convergence is not None:
        await job.emit(events.convergence_detected(downgrading_to=1))
        winner = convergence.consensus_universe_id
        # Skip Arbiter — consensus is its own answer.
        await job.emit(events.all_done(winner=winner))
        await job.emit_done()
        return winner

    # Arbiter pass — provider rotation, compressed bundle, strict schema.
    arb_provider = select_arbiter_provider(specs)
    arb_model = model_for_arbiter(arb_provider)
    user_keys = (job.models or {}).get("user_keys") or {}
    arb_key = user_keys.get(arb_provider)
    bundle = build_evidence_bundle(
        user_request=user_request, intent=intent,
        signals=signals, universes=valid,
    )
    verdict = await adjudicate(
        bundle=bundle, universes=valid,
        provider=arb_provider, api_key=arb_key, model=arb_model,
    )
    await job.emit(events.arbiter_verdict(verdict.to_dict()))
    winner = verdict.winner

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
    signals: Optional[ProjectSignals] = None,
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
                signals=signals,
            )
        result.evidence["duration_ms"] = int((time.time() - started) * 1000)
        job.universes[result.universe_id] = result.evidence
        job.universe_patches[result.universe_id] = [
            {"path": p.path, "new_content": p.new_content}
            for p in result.patches_applied
        ]
        await job.emit(events.universe_done(result.universe_id, result.evidence))
        return result
    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.exception("universe %s failed: %s", spec.universe_id, e)
        await job.emit(events.error(stage=f"universe-{spec.universe_id}", msg=str(e)))
        return None


async def _run_with_convergence(
    *,
    specs: List[UniverseSpec],
    pool: WorktreePool,
    job: events.JobState,
    seed_patches: List[PatchBlock],
    user_request: str,
    signals: Optional[ProjectSignals],
) -> Tuple[List[UniverseResult], List[str]]:
    """Fan out N universes in parallel. After each finishes, check
    convergence on the completed cohort; if 2+ universes already
    converged, cancel everything still pending and return.
    """
    tasks: Dict[asyncio.Task, str] = {}
    for spec in specs:
        task = asyncio.create_task(_run_single(
            spec=spec, pool=pool, job=job,
            seed_patches=seed_patches, user_request=user_request,
            signals=signals,
        ))
        tasks[task] = spec.universe_id

    completed: List[UniverseResult] = []
    cancelled_ids: List[str] = []

    # Iterate as universes finish. We can't trivially refresh as_completed's
    # set after scheduling, but it's stable across the lifetime of `tasks`,
    # which is what we need.
    for fut in asyncio.as_completed(list(tasks.keys())):
        try:
            res = await fut
        except asyncio.CancelledError:
            continue
        if isinstance(res, UniverseResult):
            completed.append(res)

        # Convergence: at least 2 finished + identical → cancel pending.
        if len(completed) >= 2 and detect_convergence(completed) is not None:
            for t, uid in list(tasks.items()):
                if not t.done():
                    t.cancel()
                    cancelled_ids.append(uid)
            break

    # Drain any stragglers we cancelled, swallowing exceptions.
    for t in tasks.keys():
        if t.done():
            continue
        try:
            await t
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.debug("cancelled universe raised during teardown", exc_info=True)

    return completed, cancelled_ids


# Provider rotation policy (master plan §6.4 Arbiter rotation).
# Wave 2 N=3 reads this table to assign `(model_gen, model_critic)`
# per universe and to pick the Arbiter (least-used provider).
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
