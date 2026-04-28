"""Change-level crossover. Master plan §3 + §18 + §22 (Wave 3).

Wave 3 cap (locked by master plan §18 + risk table):
  - Change-level only (whole-file swaps), no AST/closure-aware fragment splicing.
  - Single generation — no chained crossover trees.
  - Hard compile-gate on every child (lint + types quick pass via the
    detected runner). Children that don't compile are dropped.
  - Arbiter synthesis instructions (§6.4 `synthesis.recommended=true`)
    are honored when present — falls back to deterministic file pairing
    otherwise.

The output is a list of `UniverseResult`s that the orchestrator can fold
back into the evidence bundle alongside the original universes. Crossover
children wear an `id` like `A+B` so the Arbiter can tell parents apart.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any, Dict, Iterable, List, Optional

from .generator import PatchBlock
from .runner import detect_runner
from .scoring import ScoreInput, compute as compute_score
from .universe import UniverseResult
from .worktree import WorktreePool

logger = logging.getLogger("shadow.crossover")

MAX_CHILDREN = 2  # cap across the whole crossover pass (cost control)
COMPILE_GATE_BUDGET_SEC = 8.0


def plan_children(
    universes: List[UniverseResult],
    *,
    synthesis: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """Return crossover plans without running them. Each plan is:
        { "id": "A+B", "parents": ("A","B"), "files": {path: parent_id} }

    `synthesis` is the Arbiter's optional `synthesis` block. When
    `synthesis.recommended is True` and `synthesis.instruction` references
    parent ids per file (e.g. "use A's src/auth.ts and B's tests"), we
    extract that mapping. Otherwise we fall back to a deterministic
    pairwise file-level swap.
    """
    if len(universes) < 2:
        return []

    by_id = {u.universe_id: u for u in universes}
    universes_sorted = sorted(universes, key=lambda u: -u.score)

    plans: List[Dict[str, Any]] = []

    # 1) Arbiter-driven synthesis path.
    if synthesis and synthesis.get("recommended"):
        synth_files = _parse_synthesis_instruction(
            synthesis.get("instruction") or synthesis.get("explanation") or "",
            by_id,
        )
        if synth_files:
            parents = tuple(sorted({pid for pid in synth_files.values()}))
            child_id = "+".join(parents)
            plans.append({
                "id": child_id,
                "parents": parents,
                "files": synth_files,
                "source": "synthesis",
            })

    # 2) Deterministic top-2 pairing — alternate file ownership between
    #    the two highest-scoring universes. One child per ordering keeps
    #    the cost cap tight while still exposing the most likely benefit:
    #    the safe universe's source + the idiomatic universe's tests.
    if len(universes_sorted) >= 2 and len(plans) < MAX_CHILDREN:
        a, b = universes_sorted[0], universes_sorted[1]
        all_paths = _ordered_unique([
            *( [pp.path for pp in a.patches_applied] ),
            *( [pp.path for pp in b.patches_applied] ),
        ])
        if all_paths:
            mix = {p: (a.universe_id if i % 2 == 0 else b.universe_id) for i, p in enumerate(all_paths)}
            plans.append({
                "id": f"{a.universe_id}+{b.universe_id}",
                "parents": (a.universe_id, b.universe_id),
                "files": mix,
                "source": "deterministic",
            })

    return plans[:MAX_CHILDREN]


_INSTRUCTION_HINT = re.compile(
    r"\b(?P<id>[A-Z](?:-[a-z]+)?)\s*['']?s?\s+(?:`|'|\")?(?P<path>[\w./\-]+\.\w+)",
    re.IGNORECASE,
)


def _parse_synthesis_instruction(text: str, by_id: Dict[str, UniverseResult]) -> Dict[str, str]:
    """Pull "use A's src/auth.ts" hints out of the Arbiter's prose. Best-effort
    regex; on miss we let the deterministic plan take over.
    """
    out: Dict[str, str] = {}
    if not text:
        return out
    for m in _INSTRUCTION_HINT.finditer(text):
        uid = m.group("id").upper().split("-")[0]
        path = m.group("path")
        if uid in by_id:
            out[path] = uid
    return out


def _ordered_unique(items: Iterable[str]) -> List[str]:
    seen: set = set()
    out: List[str] = []
    for x in items:
        if x not in seen:
            out.append(x)
            seen.add(x)
    return out


async def run_children(
    *,
    universes: List[UniverseResult],
    pool: WorktreePool,
    synthesis: Optional[Dict[str, Any]] = None,
) -> List[UniverseResult]:
    """Materialize crossover plans into compile-gated UniverseResults.

    Each child gets its own worktree from the pool; we write the
    parent-mapped patches, run the detected runner with a tight wall-clock
    budget, score the result, and return children that survived the
    compile gate (lint + type clean).
    """
    plans = plan_children(universes, synthesis=synthesis)
    if not plans:
        return []

    by_id = {u.universe_id: u for u in universes}
    children: List[UniverseResult] = []

    for plan in plans:
        child = await _run_one_child(plan=plan, by_id=by_id, pool=pool)
        if child is not None:
            children.append(child)

    return children


async def _run_one_child(
    *,
    plan: Dict[str, Any],
    by_id: Dict[str, UniverseResult],
    pool: WorktreePool,
) -> Optional[UniverseResult]:
    started = time.time()
    file_owners: Dict[str, str] = plan["files"]
    file_patches: Dict[str, PatchBlock] = {}
    for path, parent_id in file_owners.items():
        parent = by_id.get(parent_id)
        if parent is None:
            continue
        for pb in parent.patches_applied:
            if pb.path == path:
                file_patches[path] = pb
                break
    if not file_patches:
        return None

    try:
        async with pool.acquire() as wt:
            for pb in file_patches.values():
                full = wt.path / pb.path
                full.parent.mkdir(parents=True, exist_ok=True)
                full.write_text(pb.new_content, encoding="utf-8")

            changed_paths = list(file_patches.keys())
            runner = detect_runner(wt.path, changed_paths)
            try:
                run_result = await asyncio.wait_for(
                    runner.run(wt.path, changed_paths),
                    timeout=COMPILE_GATE_BUDGET_SEC,
                )
            except asyncio.TimeoutError:
                logger.info("crossover child %s exceeded compile-gate budget", plan["id"])
                return None

            # Hard compile-gate: lint + types must be either clean or
            # skipped. Any error rejects the child.
            if not _compile_clean(run_result):
                return None

            patches_list = list(file_patches.values())
            score = compute_score(ScoreInput(
                attacks_total=0, attacks_real=0, attacks_survived=0,
                diagnostics_count=run_result.diagnostics_count(),
                diagnostics_max=20,
                tests_passed=run_result.tests[0].get("passed", 0),
                tests_total=run_result.tests[0].get("total", 0),
                runtime_clean=bool(run_result.runtime[0].get("clean", True)),
                style_match=0.5,
                loc_delta=sum(abs(len(p.new_content.splitlines()) - len(p.original.splitlines())) for p in patches_list),
                loc_baseline=sum(len(p.original.splitlines()) for p in patches_list),
                style="crossover",
            ))

            evidence = {
                "id": plan["id"],
                "style": f"crossover/{plan.get('source', 'deterministic')}",
                "model_pair": [None, None],  # synthetic — no LLM in the loop
                "diagnostics": run_result.to_evidence(),
                "attacks": {"tested": 0, "survived": 0, "failed": []},
                "loc": _loc_str(patches_list),
                "score": round(score, 3),
                "revised": False,
                "parents": list(plan["parents"]),
                "duration_ms": int((time.time() - started) * 1000),
            }
            return UniverseResult(
                universe_id=plan["id"], score=score,
                evidence=evidence, patches_applied=patches_list, revised=False,
            )
    except Exception as e:
        logger.debug("crossover child %s failed: %s", plan["id"], e)
        return None


def _compile_clean(run_result) -> bool:
    """Lint + types must be clean or skipped. Tests/runtime can be dirty
    — those are scored, not gated, since the parent universes already
    had to pass them.
    """
    for diags, ran in (run_result.lint, run_result.types):
        if not ran:
            continue
        if any(getattr(d, "severity", "error") == "error" for d in diags):
            return False
    return True


def _loc_str(patches: List[PatchBlock]) -> str:
    plus = minus = 0
    for p in patches:
        a = p.original.splitlines()
        b = p.new_content.splitlines()
        plus += max(0, len(b) - len(a))
        minus += max(0, len(a) - len(b))
    return f"+{plus} −{minus}"
