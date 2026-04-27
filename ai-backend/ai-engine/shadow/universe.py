"""One universe = (Generator + Critic + Runner) producing one patch and
its evidence bundle. Master plan §6 + §3.

A universe owns a single worktree for the duration of its run. After
finishing, it pushes a `universe_done` event with the compressed evidence
bundle (which the Arbiter, Wave 2+, consumes).
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import events
from .critic import Critic, CritiqueResult
from .generator import Generator, GeneratorRequest, PatchBlock
from .runner import RunResult, detect_runner
from .runner.base import run_cmd
from .scoring import ScoreInput, compute as compute_score
from .worktree import Worktree, patch_changes_dependencies

logger = logging.getLogger("shadow.universe")


@dataclass
class UniverseSpec:
    universe_id: str
    style: str
    model_gen: str
    model_critic: str
    intent: str = "fix"


@dataclass
class UniverseResult:
    universe_id: str
    score: float
    evidence: Dict[str, Any]
    patches_applied: List[PatchBlock] = field(default_factory=list)
    revised: bool = False


class Universe:
    def __init__(self, spec: UniverseSpec):
        self.spec = spec
        self.generator = Generator(model=spec.model_gen, style=spec.style)
        self.critic = Critic(model=spec.model_critic)

    async def run(
        self,
        *,
        worktree: Worktree,
        user_request: str,
        seed_patches: List[PatchBlock],
        job: events.JobState,
        dep_lock,
    ) -> UniverseResult:
        uid = self.spec.universe_id
        await job.emit(events.universe_started(
            uid=uid, model_gen=self.spec.model_gen,
            model_critic=self.spec.model_critic, style=self.spec.style,
        ))

        # 1. Generator
        gen_req = GeneratorRequest(
            user_request=user_request,
            style=self.spec.style,
            model=self.spec.model_gen,
            patches=seed_patches,
            intent=self.spec.intent,
        )
        patches = await self.generator.generate(gen_req)

        # 2. Apply patches to worktree
        await job.emit(events.universe_progress(uid, "applying"))
        applied = await _write_patches(worktree.path, patches)

        # 3. Dep install (if needed) — serialized across pool.
        changed_paths = [p.path for p in patches]
        if patch_changes_dependencies(changed_paths):
            async with dep_lock():
                await job.emit(events.universe_progress(uid, "installing", "deps changed"))
                await _try_dep_install(worktree.path)

        # 4. Runner
        runner = detect_runner(worktree.path, changed_paths)
        await job.emit(events.universe_progress(uid, "linting"))
        run_result = await runner.run(worktree.path, changed_paths)

        # 5. Critic
        await job.emit(events.universe_progress(uid, "critiquing"))
        diagnostics_evidence = run_result.to_evidence()
        critique = await self.critic.critique(
            worktree=worktree.path,
            patched_files=changed_paths,
            diagnostics=diagnostics_evidence,
        )

        # 6. Run executable reproducers (only for kinds that benefit)
        await _run_reproducers(worktree.path, critique)

        # 7. Optional revise pass on blocking attacks (max 1)
        revised = False
        if critique.blocking:
            await job.emit(events.universe_progress(uid, "revising"))
            patches = await self.generator.revise(gen_req, [
                {"msg": a.msg, "kind": a.kind, "reproducer": a.reproducer}
                for a in critique.blocking
            ])
            revised = True
            # Re-apply + re-run only if generator actually changed something.
            # Wave 1 generator skips revision (see generator.py); we still
            # short-circuit cleanly.

        # 8. Score + evidence
        score = compute_score(ScoreInput(
            attacks_total=len(critique.attacks),
            attacks_real=len(critique.real_attacks),
            attacks_survived=critique.survived,
            diagnostics_count=run_result.diagnostics_count(),
            diagnostics_max=20,
            tests_passed=run_result.tests[0].get("passed", 0),
            tests_total=run_result.tests[0].get("total", 0),
            runtime_clean=bool(run_result.runtime[0].get("clean", True)),
            style_match=0.5,  # placeholder until preference learning lands (Wave 4)
            loc_delta=_loc_delta(patches),
            loc_baseline=_loc_baseline(patches),
            style=self.spec.style,
        ))

        evidence = {
            "id": uid,
            "style": self.spec.style,
            "model_pair": [self.spec.model_gen, self.spec.model_critic],
            "diagnostics": diagnostics_evidence,
            "attacks": _attacks_evidence(critique),
            "loc": _loc_str(patches),
            "score": round(score, 3),
            "revised": revised,
            "duration_ms": 0,  # filled by orchestrator
        }

        return UniverseResult(
            universe_id=uid,
            score=score,
            evidence=evidence,
            patches_applied=applied,
            revised=revised,
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _write_patches(worktree: Path, patches: List[PatchBlock]) -> List[PatchBlock]:
    applied: List[PatchBlock] = []
    for p in patches:
        full = worktree / p.path
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(p.new_content, encoding="utf-8")
        applied.append(p)
    return applied


async def _try_dep_install(worktree: Path) -> None:
    if (worktree / "package.json").exists():
        await run_cmd(["npm", "ci", "--prefer-offline", "--no-audit", "--silent"],
                      cwd=worktree, timeout=60)
    elif (worktree / "requirements.txt").exists():
        await run_cmd(["python", "-m", "pip", "install", "-r", "requirements.txt", "--quiet"],
                      cwd=worktree, timeout=60)


async def _run_reproducers(worktree: Path, crit: CritiqueResult) -> None:
    """Execute attacks whose kind benefits from running (edge|logic).

    For Wave 1 we re-run pytest/vitest with the inline reproducer test
    snippet written into a scratch file under `.shadow-cache/repro_*`.
    Diagnostics-derived attacks already have `real=True` set upstream and
    are skipped here.
    """
    cache = worktree / ".shadow-cache"
    cache.mkdir(parents=True, exist_ok=True)
    for i, a in enumerate(crit.attacks):
        if a.real is not None:
            continue
        if a.kind not in ("edge", "logic"):
            a.note = "non-executable kind; left to Critic-Critic (Wave 2)"
            continue
        if not a.is_executable():
            continue
        repro = a.reproducer or {}
        rtype = repro.get("type")
        code = repro.get("code") or ""
        if rtype == "test":
            # Heuristic: write a python test if it looks like pytest, otherwise JS.
            if "def test_" in code or "import pytest" in code:
                p = cache / f"repro_{i}_test.py"
                p.write_text(code, encoding="utf-8")
                rc, out, err, finished = await run_cmd(
                    ["pytest", "-x", "--timeout=10", "-q", str(p)],
                    cwd=worktree, timeout=12,
                )
                a.real = finished and rc != 0
            else:
                p = cache / f"repro_{i}.test.js"
                p.write_text(code, encoding="utf-8")
                rc, out, err, finished = await run_cmd(
                    ["npx", "--no-install", "vitest", "run", str(p)],
                    cwd=worktree, timeout=12,
                )
                a.real = finished and rc != 0
        else:
            # Pure input reproducers don't fail-fast on their own — leave for Wave 2.
            a.real = False
            a.note = "input reproducer not executed in Wave 1"


def _attacks_evidence(crit: CritiqueResult) -> Dict[str, Any]:
    failed = [
        {
            "msg": a.msg,
            "severity": a.severity,
            "kind": a.kind,
            "reproducer_kind": (a.reproducer or {}).get("type"),
        }
        for a in crit.real_attacks if a.severity in ("blocking", "high")
    ]
    return {
        "tested": len(crit.attacks),
        "survived": crit.survived,
        "failed": failed,
    }


def _loc_delta(patches: List[PatchBlock]) -> int:
    total = 0
    for p in patches:
        total += abs(len(p.new_content.splitlines()) - len(p.original.splitlines()))
    return total


def _loc_baseline(patches: List[PatchBlock]) -> int:
    return sum(len(p.original.splitlines()) for p in patches)


def _loc_str(patches: List[PatchBlock]) -> str:
    plus = minus = 0
    for p in patches:
        a = p.original.splitlines()
        b = p.new_content.splitlines()
        plus += max(0, len(b) - len(a))
        minus += max(0, len(a) - len(b))
    return f"+{plus} −{minus}"
