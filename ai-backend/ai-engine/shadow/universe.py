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
    # Wave 2 multi-provider plumbing — Wave 1 universes set both to "gemini".
    provider_gen: str = "gemini"
    provider_critic: str = "gemini"
    api_key_gen: Optional[str] = None
    api_key_critic: Optional[str] = None


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
        self.generator = Generator(
            model=spec.model_gen, style=spec.style,
            provider=spec.provider_gen, api_key=spec.api_key_gen,
        )
        self.critic = Critic(
            model=spec.model_critic,
            provider=spec.provider_critic, api_key=spec.api_key_critic,
        )

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

        # 1.5. Minimalist post-hoc filter (master plan §6.1 table).
        # If the style is `minimalist` or `surgical` and the patch grew
        # past the threshold, hard-reject the universe with a low score
        # so a smaller universe wins. Skipping the runner + critic saves
        # compute on a doomed candidate.
        if (rejection := _check_style_filter(self.spec.style, patches)) is not None:
            await job.emit(events.universe_progress(uid, "rejected", rejection))
            evidence = {
                "id": uid,
                "style": self.spec.style,
                "model_pair": [self.spec.model_gen, self.spec.model_critic],
                "diagnostics": {"lint": "skipped", "types": "skipped",
                                "tests": "skipped", "runtime": "skipped"},
                "attacks": {"tested": 0, "survived": 0, "failed": []},
                "loc": _loc_str(patches),
                "score": 0.0,
                "revised": False,
                "rejected": rejection,
                "duration_ms": 0,
            }
            return UniverseResult(
                universe_id=uid, score=0.0, evidence=evidence,
                patches_applied=[], revised=False,
            )

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

        # 7. Optional revise pass on blocking attacks (master plan §6.2: max 1).
        revised = False
        if critique.blocking:
            await job.emit(events.universe_progress(uid, "revising"))
            new_patches = await self.generator.revise(gen_req, [
                {"msg": a.msg, "kind": a.kind, "severity": a.severity, "reproducer": a.reproducer}
                for a in critique.blocking
            ])
            mutated = any(np.note and "[revised]" in np.note for np in new_patches)
            if mutated:
                revised = True
                patches = new_patches
                applied = await _write_patches(worktree.path, patches)
                # Re-run runner + critic on the revised patches.
                run_result = await runner.run(worktree.path, [p.path for p in patches])
                diagnostics_evidence = run_result.to_evidence()
                critique = await self.critic.critique(
                    worktree=worktree.path,
                    patched_files=[p.path for p in patches],
                    diagnostics=diagnostics_evidence,
                )
                await _run_reproducers(worktree.path, critique)

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
# Minimalist / surgical post-hoc filter (master plan §6.1 table).
# ---------------------------------------------------------------------------

def _check_style_filter(style: str, patches: List[PatchBlock]) -> Optional[str]:
    if style not in ("minimalist", "surgical"):
        return None
    threshold = 1.5 if style == "minimalist" else 1.0
    for p in patches:
        baseline = max(1, len(p.original.splitlines()))
        new = len(p.new_content.splitlines())
        if new > int(threshold * baseline):
            return (
                f"{style}-filter: {p.path} grew from {baseline}→{new} lines "
                f"(threshold {int(threshold * baseline)})"
            )
    if style == "surgical":
        # Additional rule: reject patches > 5 lines unless required.
        for p in patches:
            delta = abs(len(p.new_content.splitlines()) - len(p.original.splitlines()))
            if delta > 5:
                return f"surgical-filter: {p.path} delta {delta} > 5 lines"
    return None


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

    Reproducers come in two shapes:
      - type=test:  a runnable test snippet (pytest or vitest)
      - type=input: a structured input + a `target` of "module.func"
                    that we feed through a small synthesized harness

    Diagnostics-derived attacks already have `real=True` set upstream and
    are skipped here.
    """
    import json as _json

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
        elif rtype == "input":
            # input reproducer: { type: "input", target: "pkg.mod.func", input: ... }
            target = repro.get("target") or ""
            input_value = repro.get("input")
            if not target or "." not in target:
                a.real = False
                a.note = "input reproducer missing dotted target"
                continue
            module_part, _, func_part = target.rpartition(".")
            harness = (
                "import json, sys, traceback\n"
                f"from {module_part} import {func_part} as _target\n"
                f"_inp = json.loads({_json.dumps(_json.dumps(input_value))})\n"
                "try:\n"
                "    if isinstance(_inp, list):\n"
                "        _target(*_inp)\n"
                "    elif isinstance(_inp, dict):\n"
                "        _target(**_inp)\n"
                "    else:\n"
                "        _target(_inp)\n"
                "except Exception:\n"
                "    traceback.print_exc()\n"
                "    sys.exit(1)\n"
            )
            p = cache / f"repro_{i}_input.py"
            p.write_text(harness, encoding="utf-8")
            rc, out, err, finished = await run_cmd(
                ["python", str(p)], cwd=worktree, timeout=10,
            )
            # Attack is "real" if the input crashed the patched code.
            a.real = finished and rc != 0
            if finished and rc != 0:
                a.note = (a.note or "") + " input crashed patched module"
        else:
            a.real = False
            a.note = "unknown reproducer type"


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
