"""Proof Arbiter: hard-gate correctness before selection fit or novelty."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Iterable, List

from .counterfactual_types import BranchTrace, DetectorResult, DetectorStatus


@dataclass
class ProofVerdict:
    eligible_universe_ids: List[str]
    blocked_universe_ids: List[str]
    reasons: Dict[str, List[str]] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, object]:
        return {
            "eligible_universe_ids": self.eligible_universe_ids,
            "blocked_universe_ids": self.blocked_universe_ids,
            "reasons": self.reasons,
        }


HARD_GATE_STATUSES = {DetectorStatus.FAILED}


def adjudicate_proof(traces: Iterable[BranchTrace], detectors: Iterable[DetectorResult]) -> ProofVerdict:
    detectors_by_branch: Dict[str, List[DetectorResult]] = {}
    for result in detectors:
        detectors_by_branch.setdefault(result.branch_trace_id, []).append(result)

    eligible: List[str] = []
    blocked: List[str] = []
    reasons: Dict[str, List[str]] = {}
    for trace in traces:
        branch_detectors = detectors_by_branch.get(trace.id, [])
        # A branch with no detector evidence is not proof-valid.  Treating a
        # missing detector as an implicit pass would let the public telemetry
        # API manufacture a selection lesson that bypasses Vectant's proof
        # gate entirely.
        if not branch_detectors:
            blocked.append(trace.universe_id)
            reasons[trace.universe_id] = ["detector evidence is missing"]
            continue
        failed = [
            f"{d.detector_kind.value}: {d.evidence_summary}"
            for d in branch_detectors
            if d.status in HARD_GATE_STATUSES
        ]
        if failed:
            blocked.append(trace.universe_id)
            reasons[trace.universe_id] = failed
            continue
        eligible.append(trace.universe_id)
    return ProofVerdict(eligible_universe_ids=eligible, blocked_universe_ids=blocked, reasons=reasons)
