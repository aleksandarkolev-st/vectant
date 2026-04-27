"""Closure-aware fragment crossover. Master plan §18 + §22 (Wave 5).

WAVE 5 IS RESEARCH-ONLY AND DISABLED BY DEFAULT. Enable with the
`SHADOW_CLOSURE_CROSSOVER_ENABLED=1` env var. The plan flags this work
because fragment-level stitching can produce subtle breakage when
closures capture variables defined elsewhere — we keep it behind a
flag so live users can't be exposed to the worst tail of failure modes
until the harness backs the gate empirically.

This module provides function/method-level swaps for Python (via stdlib
`ast`) and a string-pattern fallback for JS/TS. Each child is still
compile-gated by detect_runner the same way Wave 3 change-level
crossover gates whole-file swaps.
"""

from __future__ import annotations

import ast
import asyncio
import logging
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .crossover import COMPILE_GATE_BUDGET_SEC, _compile_clean, _loc_str
from .generator import PatchBlock
from .runner import detect_runner
from .scoring import ScoreInput, compute as compute_score
from .universe import UniverseResult
from .worktree import WorktreePool

logger = logging.getLogger("shadow.closure_crossover")

CHILD_CAP = 1  # one experimental child per run; flag-gated.


def is_enabled() -> bool:
    return os.environ.get("SHADOW_CLOSURE_CROSSOVER_ENABLED", "0").lower() in ("1", "true", "yes")


# ---------------------------------------------------------------------------
# Fragment extraction
# ---------------------------------------------------------------------------

def extract_python_closures(src: str) -> Dict[str, str]:
    """Map top-level + class-method qualified names → source text.

    Closures inside other functions are intentionally not split — they
    capture variables from the enclosing scope and stitching them in
    isolation breaks more often than it helps (the §18 risk we're
    flagging).
    """
    out: Dict[str, str] = {}
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return out
    lines = src.splitlines(keepends=True)
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out[node.name] = _slice(lines, node)
        elif isinstance(node, ast.ClassDef):
            for sub in node.body:
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    out[f"{node.name}.{sub.name}"] = _slice(lines, sub)
    return out


def _slice(lines: List[str], node: ast.AST) -> str:
    start = max(0, getattr(node, "lineno", 1) - 1)
    end = getattr(node, "end_lineno", None) or len(lines)
    return "".join(lines[start:end])


_JS_FN = re.compile(
    r"^(?:export\s+)?(?:async\s+)?function\s+(?P<name>[A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{",
    re.MULTILINE,
)


def extract_js_closures(src: str) -> Dict[str, str]:
    """Best-effort regex extraction for JS/TS top-level `function name`.

    Arrow functions assigned to const/let are deliberately skipped —
    they're often anonymous or destructured and the substitution rules
    are too brittle for this research-only path.
    """
    out: Dict[str, str] = {}
    for m in _JS_FN.finditer(src):
        name = m.group("name")
        body = _slice_balanced_braces(src, m.end() - 1)
        if body is not None:
            out[name] = src[m.start():m.start() + (m.end() - m.start()) + len(body) - 1]
    return out


def _slice_balanced_braces(text: str, open_idx: int) -> Optional[str]:
    depth = 0
    i = open_idx
    while i < len(text):
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[open_idx + 1:i]
        i += 1
    return None


# ---------------------------------------------------------------------------
# Child planning + execution
# ---------------------------------------------------------------------------

def plan_fragment_children(
    universes: List[UniverseResult],
) -> List[Dict[str, Any]]:
    """Pair the top-2 scoring universes and propose one child where each
    closure picks the parent whose `score` is higher. Ties prefer the
    earlier universe (deterministic).
    """
    if len(universes) < 2 or not is_enabled():
        return []

    a, b = sorted(universes, key=lambda u: -u.score)[:2]
    child_id = f"{a.universe_id}*{b.universe_id}"  # `*` distinguishes fragment from `+` whole-file children
    plan = {
        "id": child_id,
        "parents": (a.universe_id, b.universe_id),
        "fragment_owners": {},  # path → { fragment_name: parent_id }
        "source": "closure-aware",
    }

    for path in _common_paths(a, b):
        owner_map = _plan_path_fragments(a, b, path)
        if owner_map:
            plan["fragment_owners"][path] = owner_map

    if not plan["fragment_owners"]:
        return []
    return [plan]


def _common_paths(a: UniverseResult, b: UniverseResult) -> List[str]:
    pa = {p.path for p in a.patches_applied}
    pb = {p.path for p in b.patches_applied}
    return sorted(pa & pb)


def _plan_path_fragments(a: UniverseResult, b: UniverseResult, path: str) -> Dict[str, str]:
    """Pick which parent provides each fragment: the parent with the
    higher score wins ties; a parent that defines a fragment the other
    deleted always wins on that fragment.
    """
    pa = next((p for p in a.patches_applied if p.path == path), None)
    pb = next((p for p in b.patches_applied if p.path == path), None)
    if pa is None or pb is None:
        return {}
    extractor = _extractor_for(path)
    if extractor is None:
        return {}
    frags_a = extractor(pa.new_content)
    frags_b = extractor(pb.new_content)
    keys = set(frags_a) | set(frags_b)
    if not keys:
        return {}
    plan: Dict[str, str] = {}
    for k in keys:
        if k in frags_a and k in frags_b:
            # Score ranking: a is the higher-scoring parent (precondition).
            plan[k] = a.universe_id
        elif k in frags_a:
            plan[k] = a.universe_id
        else:
            plan[k] = b.universe_id
    return plan


def _extractor_for(path: str):
    if path.endswith(".py"):
        return extract_python_closures
    if path.endswith((".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx")):
        return extract_js_closures
    return None


async def run_fragment_children(
    *,
    universes: List[UniverseResult],
    pool: WorktreePool,
) -> List[UniverseResult]:
    plans = plan_fragment_children(universes)[:CHILD_CAP]
    if not plans:
        return []
    by_id = {u.universe_id: u for u in universes}
    children: List[UniverseResult] = []
    for plan in plans:
        child = await _materialize_child(plan, by_id, pool)
        if child is not None:
            children.append(child)
    return children


async def _materialize_child(
    plan: Dict[str, Any],
    by_id: Dict[str, UniverseResult],
    pool: WorktreePool,
) -> Optional[UniverseResult]:
    started = time.time()
    new_files: Dict[str, PatchBlock] = {}

    for path, owners in plan["fragment_owners"].items():
        extractor = _extractor_for(path)
        if extractor is None:
            continue
        # Use the higher-scoring parent's body as the scaffold; replace
        # each fragment whose owner is the *other* parent. This keeps
        # imports / module-level constants / unmapped helpers from the
        # winner — the riskier surface is just the swapped function body.
        primary_id = plan["parents"][0]
        secondary_id = plan["parents"][1]
        primary = by_id[primary_id]
        secondary = by_id[secondary_id]
        primary_pb = next((p for p in primary.patches_applied if p.path == path), None)
        secondary_pb = next((p for p in secondary.patches_applied if p.path == path), None)
        if primary_pb is None:
            continue
        scaffold = primary_pb.new_content

        sec_frags = extractor(secondary_pb.new_content) if secondary_pb else {}
        pri_frags = extractor(scaffold)

        # Substitute the secondary's fragments into the scaffold for any
        # fragment owned by `secondary_id` in the plan.
        new_body = scaffold
        for frag_name, owner in owners.items():
            if owner != secondary_id:
                continue
            sec_text = sec_frags.get(frag_name)
            pri_text = pri_frags.get(frag_name)
            if not sec_text:
                continue
            if pri_text and pri_text in new_body:
                new_body = new_body.replace(pri_text, sec_text, 1)
            else:
                # Add new fragments at the end of the body — safer than
                # guessing where in the file they belong.
                new_body = new_body.rstrip() + "\n\n" + sec_text + "\n"

        new_files[path] = PatchBlock(
            path=path,
            original=primary_pb.original,
            new_content=new_body,
        )

    if not new_files:
        return None

    try:
        async with pool.acquire() as wt:
            for pb in new_files.values():
                full = wt.path / pb.path
                full.parent.mkdir(parents=True, exist_ok=True)
                full.write_text(pb.new_content, encoding="utf-8")
            changed_paths = list(new_files.keys())
            runner = detect_runner(wt.path, changed_paths)
            try:
                run_result = await asyncio.wait_for(
                    runner.run(wt.path, changed_paths),
                    timeout=COMPILE_GATE_BUDGET_SEC,
                )
            except asyncio.TimeoutError:
                logger.info("closure-crossover child %s exceeded compile gate", plan["id"])
                return None
            if not _compile_clean(run_result):
                return None

            patches_list = list(new_files.values())
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
                style="closure-crossover",
            ))

            evidence = {
                "id": plan["id"],
                "style": "crossover/closure-aware",
                "model_pair": [None, None],
                "diagnostics": run_result.to_evidence(),
                "attacks": {"tested": 0, "survived": 0, "failed": []},
                "loc": _loc_str(patches_list),
                "score": round(score, 3),
                "revised": False,
                "parents": list(plan["parents"]),
                "experimental": True,
                "duration_ms": int((time.time() - started) * 1000),
            }
            return UniverseResult(
                universe_id=plan["id"], score=score,
                evidence=evidence, patches_applied=patches_list,
                revised=False,
            )
    except Exception as e:
        logger.debug("closure-crossover child %s failed: %s", plan["id"], e)
        return None
