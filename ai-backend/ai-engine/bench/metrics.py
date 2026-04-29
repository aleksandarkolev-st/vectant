"""Metrics summarizer for bench results. Master plan §15.2.

The full metric set (Critic precision/recall, Arbiter agreement, Universe
N+1 marginal value, latency p50/p95, cost) is computed here. Wave 1
ships scaffolding plus the metrics that don't depend on Arbiter (which
arrives in Wave 2).
"""

from __future__ import annotations

from dataclasses import dataclass
from statistics import mean, median
from typing import Any, Dict, List


@dataclass
class Summary:
    fixtures_total: int
    fixtures_passed: int
    apply_success_rate: float
    critic_precision: float
    critic_recall: float
    latency_p50: float
    latency_p95: float
    avg_score: float


def _percentile(xs: List[float], p: float) -> float:
    if not xs:
        return 0.0
    xs = sorted(xs)
    k = int(round((len(xs) - 1) * p))
    return xs[k]


def summarize(results: List[Any]) -> Summary:
    durations = [r.duration_s for r in results if getattr(r, "success", False)]
    fixtures_passed = sum(1 for r in results if getattr(r, "success", False))

    # Critic precision/recall. Wave 1 fixtures don't yet ship ground-truth
    # labels per attack, so we report 0 with a clear annotation. Wave 2
    # fixtures grow `golden_attacks.json` to enable real measurement.
    critic_precision = 0.0
    critic_recall = 0.0

    # Avg universe score (proxy for "did the pipeline like the patch?")
    scores: List[float] = []
    for r in results:
        for ev in getattr(r, "universes", {}).values():
            score = ev.get("score")
            if isinstance(score, (int, float)):
                scores.append(float(score))

    return Summary(
        fixtures_total=len(results),
        fixtures_passed=fixtures_passed,
        apply_success_rate=(fixtures_passed / len(results)) if results else 0.0,
        critic_precision=critic_precision,
        critic_recall=critic_recall,
        latency_p50=_percentile(durations, 0.50),
        latency_p95=_percentile(durations, 0.95),
        avg_score=(mean(scores) if scores else 0.0),
    )
