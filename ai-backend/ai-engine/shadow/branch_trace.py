"""BranchTrace normalization for existing shadow universe results."""

from __future__ import annotations

import hashlib
import re
from typing import Any, Dict, Iterable, List, Tuple

from .counterfactual_types import (
    BranchTrace,
    CostTrace,
    ExposureLevel,
    LatencyTrace,
    PhenotypeVector,
    RiskTrace,
)
from .detector_results import detector_results_from_evidence, has_failed_hard_gate


def normalize_universe_result(
    *,
    run_id: str,
    universe_result: Any,
    start_state_hash: str,
    end_state_hash: str = "",
) -> Tuple[BranchTrace, List[Any]]:
    evidence = universe_result.evidence or {}
    branch_id = f"br_{run_id}_{universe_result.universe_id}"
    detectors = detector_results_from_evidence(branch_id, evidence)
    failed_gates = [d.detector_kind.value for d in detectors if d.status.value == "failed"]
    loc_added, loc_removed = parse_loc(evidence.get("loc") or "+0 -0")
    phenotype = phenotype_from_universe(evidence=evidence, loc_added=loc_added, loc_removed=loc_removed)
    proof_score = float(evidence.get("score") or 0.0)
    if has_failed_hard_gate(detectors):
        proof_score = min(proof_score, 0.0)

    trace = BranchTrace(
        id=branch_id,
        counterfactual_run_id=run_id,
        universe_id=universe_result.universe_id,
        runner_id=str(evidence.get("model_pair") or "shadow"),
        runner_kind="internal",
        direction_id=str(evidence.get("style") or universe_result.universe_id),
        direction_label=str(evidence.get("style") or "shadow"),
        declared_condition=str(evidence.get("style") or "shadow universe"),
        prompt_lineage=[],
        start_state_hash=start_state_hash,
        end_state_hash=end_state_hash or _hash_dict(evidence),
        artifact_summary=_artifact_summary(evidence),
        diff_summary={
            "loc_added": loc_added,
            "loc_removed": loc_removed,
            "files_changed": len(getattr(universe_result, "patches_applied", []) or []),
        },
        tool_trace_summary={"model_pair": evidence.get("model_pair") or []},
        command_trace_summary={"diagnostics": evidence.get("diagnostics") or {}},
        detector_trace_ids=[d.id for d in detectors],
        cost_trace=CostTrace(),
        latency_trace=LatencyTrace(duration_ms=int(evidence.get("duration_ms") or 0)),
        risk_trace=RiskTrace(failed_hard_gates=failed_gates),
        phenotype_vector=phenotype,
        novelty_vector=phenotype.to_dict(),
        proof_score=proof_score,
        risk_score=min(1.0, len(failed_gates) / 4.0),
        exposure_level=ExposureLevel.DETECTOR_EVALUATED,
        ambiguity_flags=["detector_incomplete"] if any(d.status.value == "partial" for d in detectors) else [],
    )
    return trace, detectors


def parse_loc(value: str) -> tuple[int, int]:
    nums = [int(m.group(1)) for m in re.finditer(r"[+\-−]\s*(\d+)", value.replace("−", "-"))]
    if len(nums) >= 2:
        return nums[0], nums[1]
    if len(nums) == 1:
        return nums[0], 0
    return 0, 0


def phenotype_from_universe(*, evidence: Dict[str, Any], loc_added: int, loc_removed: int) -> PhenotypeVector:
    style = str(evidence.get("style") or "").lower()
    loc_total = loc_added + loc_removed
    runtime_depth = 0.7 if style in {"idiomatic", "safe"} else 0.35
    locality = max(0.0, 1.0 - min(loc_total / 200.0, 1.0))
    return PhenotypeVector(
        locality=round(locality, 3),
        abstraction_shift=0.25 if style in {"idiomatic", "safe"} else 0.1,
        runtime_depth=runtime_depth,
        ui_surface_shift=0.1,
        proof_newness=0.2,
        blast_radius=min(loc_total / 300.0, 1.0),
        reversibility=max(0.1, 1.0 - min(loc_total / 400.0, 0.9)),
        user_visible_change=min(loc_total / 100.0, 1.0),
    )


def traces_by_universe(traces: Iterable[BranchTrace]) -> Dict[str, BranchTrace]:
    return {t.universe_id: t for t in traces}


def _artifact_summary(evidence: Dict[str, Any]) -> str:
    style = evidence.get("style") or "shadow"
    loc = evidence.get("loc") or "+0 -0"
    score = evidence.get("score", 0)
    return f"{style} branch, LOC {loc}, proof score {score}"


def _hash_dict(data: Dict[str, Any]) -> str:
    return hashlib.sha1(repr(sorted(data.items())).encode("utf-8")).hexdigest()
