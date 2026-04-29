"""Composite scoring per master plan §10.

Weights are starting values. The Wave 1 evaluation harness (bench/) is
expected to re-tune them empirically before Wave 2 ships — see §15.4.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional


# Starting weights — re-tuned by bench/ before Wave 2 GA.
WEIGHTS = {
    "critic_survival": 0.30,
    "diagnostics":     0.25,
    "tests":           0.20,
    "runtime":         0.10,
    "style":           0.10,
    "loc":             0.05,
}


@dataclass
class ScoreInput:
    attacks_total: int
    attacks_real: int                 # post-reproducer-run
    attacks_survived: int             # of the real ones
    diagnostics_count: int            # lint+type errors
    diagnostics_max: int              # cap for normalization
    tests_passed: int
    tests_total: int
    runtime_clean: bool
    style_match: float                # 0..1 (0.5 default until preference learning lands in W4)
    loc_delta: int
    loc_baseline: int                 # for minimalist threshold checks
    style: str = "safe"               # safe|idiomatic|minimalist|surgical


def compute(s: ScoreInput, *, weights: Optional[Dict[str, float]] = None) -> float:
    """Compute the composite score for a universe.

    `weights` overrides the module-level WEIGHTS — used by the
    bench/tune_weights grid-search to evaluate alternative tuples
    without mutating the global. Production callers omit it.
    """
    w = weights or WEIGHTS
    survival = 1.0 if s.attacks_real == 0 else s.attacks_survived / s.attacks_real

    diag_norm = 0.0 if s.diagnostics_max == 0 else min(1.0, s.diagnostics_count / s.diagnostics_max)
    diag_score = 1.0 - diag_norm

    test_rate = 1.0 if s.tests_total == 0 else s.tests_passed / s.tests_total
    runtime = 1.0 if s.runtime_clean else 0.0

    # LOC quality: mild reward for smaller patches; penalty for minimalist style
    # universes that exceed 1.5× baseline (master plan §6.1 table).
    loc_score = 1.0
    if s.style == "minimalist" and s.loc_baseline > 0 and s.loc_delta > int(1.5 * s.loc_baseline):
        loc_score = 0.0
    elif s.loc_delta < 50:
        loc_score = 1.0
    elif s.loc_delta < 200:
        loc_score = 0.7
    else:
        loc_score = 0.4

    return (
        w["critic_survival"] * survival
        + w["diagnostics"] * diag_score
        + w["tests"] * test_rate
        + w["runtime"] * runtime
        + w["style"] * s.style_match
        + w["loc"] * loc_score
    )
