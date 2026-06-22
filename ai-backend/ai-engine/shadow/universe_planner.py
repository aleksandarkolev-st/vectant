"""Universe planning with counterfactual policy injection."""

from __future__ import annotations

from typing import Dict, Iterable, List

from .counterfactual_types import PolicyDelta
from .universe import UniverseSpec


def apply_policy_deltas(specs: List[UniverseSpec], deltas: Iterable[PolicyDelta]) -> List[UniverseSpec]:
    ordered = list(specs)
    for delta in deltas:
        after = delta.after.lower()
        if "runtime" in after:
            ordered = _promote_styles(ordered, {"idiomatic", "safe"})
        if "size" in after or "smaller" in after:
            ordered = _promote_styles(ordered, {"minimalist", "surgical"})
    return ordered


def direction_forecast(specs: List[UniverseSpec], deltas: Iterable[PolicyDelta]) -> List[Dict[str, object]]:
    delta_text = " ".join(delta.after for delta in deltas).lower()
    out: List[Dict[str, object]] = []
    for idx, spec in enumerate(specs):
        style = spec.style.lower()
        expected_runtime = 0.7 if style in {"idiomatic", "safe"} else 0.35
        out.append({
            "direction_id": spec.universe_id,
            "label": spec.style,
            "runner_candidates": [spec.provider_gen],
            "expected_phenotype_vector": {"runtime_depth": expected_runtime},
            "proof_cost_estimate": "medium" if idx == 0 else "low",
            "risk_estimate": "medium" if style == "safe" else "low",
            "novelty_estimate": "high" if "runtime" in delta_text and style in {"idiomatic", "safe"} else "low",
            "selection_fit_estimate": "high" if style in {"idiomatic", "minimalist", "surgical"} else "medium",
            "why": "policy-adjusted from counterfactual telemetry" if delta_text else "default shadow universe",
        })
    return out


def _promote_styles(specs: List[UniverseSpec], styles: set[str]) -> List[UniverseSpec]:
    return sorted(specs, key=lambda s: 0 if s.style.lower() in styles else 1)
