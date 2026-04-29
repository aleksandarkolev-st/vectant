"""Grid-search the §10 scoring weights against the bench corpus.

Master plan §15.4: "Scoring weights in §10 are re-tuned by a small grid
search against the corpus before Wave 2 GA."

The tuner reads the evidence dump produced by `harness.py --results-json`
and re-scores each universe under different weight tuples. The
optimization signal is *top-1 agreement with an ideal universe*, where
"ideal" = lint clean + types clean + tests passed + runtime clean. A
fixture with no ideal universe is skipped (it doesn't tell us anything
about ranking).

Run:
    python -m bench.tune_weights \\
        --results bench/results.json \\
        --steps 5 --span 0.10
        [--write-back]   # patch shadow/scoring.py with the winner
"""

from __future__ import annotations

import argparse
import itertools
import json
import logging
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Allow running via `python -m bench.tune_weights` from the ai-engine dir.
_AI_ENGINE = Path(__file__).resolve().parent.parent
if str(_AI_ENGINE) not in sys.path:
    sys.path.insert(0, str(_AI_ENGINE))

from shadow.scoring import WEIGHTS, ScoreInput, compute as compute_score  # noqa: E402

logger = logging.getLogger("bench.tune_weights")


@dataclass
class FixtureSnapshot:
    fixture_id: str
    universes: List[Dict[str, Any]]  # each: {id, scoring: {...}, ideal: bool}


def _is_ideal(evidence: Dict[str, Any]) -> bool:
    """An "ideal" universe has: lint clean, types clean, tests all passed,
    runtime clean. This proxies for "the patch actually works" in the
    absence of golden-patch ground truth.
    """
    diag = evidence.get("diagnostics") or {}
    if diag.get("lint") not in (None, "clean", "skipped"):
        return False
    if diag.get("types") not in (None, "clean", "skipped"):
        return False
    tests = diag.get("tests")
    if isinstance(tests, str) and tests not in ("clean", "skipped"):
        # parse "X/Y passed"
        if " passed" in tests:
            try:
                pp, tt = tests.split(" passed")[0].split("/")
                if int(pp) < int(tt):
                    return False
            except ValueError:
                return False
    if diag.get("runtime") == "dirty":
        return False
    return True


def load_snapshots(results_json: Path) -> List[FixtureSnapshot]:
    raw = json.loads(results_json.read_text(encoding="utf-8"))
    snaps: List[FixtureSnapshot] = []
    for entry in raw:
        if not entry.get("success"):
            continue
        universes = []
        for uid, ev in (entry.get("universes") or {}).items():
            scoring = ev.get("scoring")
            if not scoring:
                continue
            universes.append({
                "id": uid,
                "scoring": scoring,
                "ideal": _is_ideal(ev),
            })
        if not universes:
            continue
        snaps.append(FixtureSnapshot(
            fixture_id=entry.get("fixture_id", "?"),
            universes=universes,
        ))
    return snaps


def evaluate(weights: Dict[str, float], snaps: List[FixtureSnapshot]) -> Dict[str, float]:
    """Run all snapshots under `weights`. Return aggregate metrics."""
    fixtures_with_ideal = 0
    top1_matches = 0
    rank_sum = 0.0
    rank_count = 0
    for snap in snaps:
        any_ideal = any(u["ideal"] for u in snap.universes)
        if not any_ideal:
            continue
        fixtures_with_ideal += 1
        scored = []
        for u in snap.universes:
            s = compute_score(_score_input_from(u["scoring"]), weights=weights)
            scored.append((s, u))
        scored.sort(key=lambda t: -t[0])
        if scored[0][1]["ideal"]:
            top1_matches += 1
        # Mean reciprocal rank of an ideal universe.
        for idx, (_, u) in enumerate(scored, start=1):
            if u["ideal"]:
                rank_sum += 1.0 / idx
                rank_count += 1
                break
    if fixtures_with_ideal == 0:
        return {"top1_agreement": 0.0, "mrr_ideal": 0.0, "fixtures": 0}
    return {
        "top1_agreement": top1_matches / fixtures_with_ideal,
        "mrr_ideal": rank_sum / fixtures_with_ideal,
        "fixtures": fixtures_with_ideal,
    }


def _score_input_from(d: Dict[str, Any]) -> ScoreInput:
    return ScoreInput(
        attacks_total=int(d.get("attacks_total", 0)),
        attacks_real=int(d.get("attacks_real", 0)),
        attacks_survived=int(d.get("attacks_survived", 0)),
        diagnostics_count=int(d.get("diagnostics_count", 0)),
        diagnostics_max=int(d.get("diagnostics_max", 20)),
        tests_passed=int(d.get("tests_passed", 0)),
        tests_total=int(d.get("tests_total", 0)),
        runtime_clean=bool(d.get("runtime_clean", True)),
        style_match=float(d.get("style_match", 0.5)),
        loc_delta=int(d.get("loc_delta", 0)),
        loc_baseline=int(d.get("loc_baseline", 0)),
        style=str(d.get("style", "safe")),
    )


def grid_around(base: Dict[str, float], steps: int, span: float) -> List[Dict[str, float]]:
    """Generate weight tuples by perturbing each base weight by ±span in
    `steps` increments, then re-normalizing so the sum stays at 1.0.
    """
    keys = list(base.keys())
    deltas = [-span + (2 * span) * (i / max(1, steps - 1)) for i in range(steps)]
    # Cartesian product over per-key deltas. Steps^k explodes; for k=6 + steps=3
    # we get 729 tuples — fast enough for offline tuning.
    grid: List[Dict[str, float]] = []
    for combo in itertools.product(deltas, repeat=len(keys)):
        candidate = {k: max(0.0, base[k] + d) for k, d in zip(keys, combo)}
        total = sum(candidate.values())
        if total <= 0:
            continue
        candidate = {k: v / total for k, v in candidate.items()}
        grid.append(candidate)
    return grid


def fmt_weights(w: Dict[str, float]) -> str:
    return "{ " + ", ".join(f"{k}={v:.3f}" for k, v in w.items()) + " }"


def write_back_weights(scoring_path: Path, best: Dict[str, float]) -> None:
    """Patch shadow/scoring.py's WEIGHTS dict in place. Conservative —
    only rewrites the WEIGHTS literal block; everything else is left
    alone."""
    src = scoring_path.read_text(encoding="utf-8")
    start = src.find("WEIGHTS = {")
    if start < 0:
        raise RuntimeError("could not locate WEIGHTS in scoring.py")
    end = src.find("}", start)
    if end < 0:
        raise RuntimeError("WEIGHTS literal not closed")
    block = "WEIGHTS = {\n"
    for k, v in best.items():
        block += f"    \"{k}\": {v:.4f},\n"
    block += "}"
    new_src = src[:start] + block + src[end + 1:]
    scoring_path.write_text(new_src, encoding="utf-8")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results", default="bench/results.json",
                        help="evidence dump from harness.py --results-json")
    parser.add_argument("--steps", type=int, default=3,
                        help="grid steps per dimension (3 → ~729 tuples for 6 weights)")
    parser.add_argument("--span", type=float, default=0.10,
                        help="±perturbation around each baseline weight")
    parser.add_argument("--write-back", action="store_true",
                        help="patch shadow/scoring.py WEIGHTS with the winning tuple")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    results_path = Path(args.results)
    if not results_path.exists():
        logger.error("missing %s — run `python -m bench.harness --results-json %s` first",
                     results_path, results_path)
        return 2

    snaps = load_snapshots(results_path)
    logger.info("loaded %d fixtures with scored universes", len(snaps))
    if not snaps:
        return 1

    base_metrics = evaluate(WEIGHTS, snaps)
    logger.info("baseline weights: %s", fmt_weights(WEIGHTS))
    logger.info("baseline metrics: %s", base_metrics)

    grid = grid_around(WEIGHTS, args.steps, args.span)
    logger.info("evaluating %d candidate weight tuples", len(grid))

    best = WEIGHTS
    best_metrics = base_metrics
    for cand in grid:
        m = evaluate(cand, snaps)
        # Lex-order: top1 first, then MRR.
        if (m["top1_agreement"], m["mrr_ideal"]) > (
            best_metrics["top1_agreement"], best_metrics["mrr_ideal"]
        ):
            best = cand
            best_metrics = m

    logger.info("best weights:    %s", fmt_weights(best))
    logger.info("best metrics:    %s", best_metrics)
    delta = (
        best_metrics["top1_agreement"] - base_metrics["top1_agreement"],
        best_metrics["mrr_ideal"] - base_metrics["mrr_ideal"],
    )
    logger.info("delta (top1, mrr): %+.3f / %+.3f", *delta)

    if args.write_back and best != WEIGHTS:
        scoring_path = _AI_ENGINE / "shadow" / "scoring.py"
        write_back_weights(scoring_path, best)
        logger.info("wrote new weights to %s", scoring_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
